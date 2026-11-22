/**
 * Рельеф вне городской сетки: холмы на севере, поля на западе, пляж и морское дно.
 * Сетка высот 16 м; вдоль серпантина грунт выравнивается под дорогу.
 * Визуальный меш и физический trimesh строятся из одних и тех же треугольников,
 * а groundHeight() интерполирует ровно по ним — колёса не «висят» над асфальтом.
 */
import * as THREE from 'three';
import {
  CITY_RECT, HILL_ROAD_HW, WATER_Y, WORLD_HALF, hillRoadPath, inRect, rawHeight,
} from './CityLayout';
import { MaterialLib } from '../render/Materials';
import { GeomBuilder } from './GeomBuilder';
import { RNG, clamp, fbm2, smoothstep, lerp } from '../core/MathUtil';

export const CELL = 16;
const N = Math.round((WORLD_HALF * 2) / CELL); // ячеек по стороне
const V = N + 1; // вершин по стороне
const TILE = 25; // ячеек в тайле

export interface TreeInst { x: number; y: number; z: number; s: number; rot: number; kind: 'pine' | 'oak' | 'palm' }

export class Terrain {
  readonly heights = new Float32Array(V * V);
  readonly group = new THREE.Group();
  /** Вершины/индексы для физического trimesh. */
  physVerts: Float32Array = new Float32Array(0);
  physIdx: Uint32Array = new Uint32Array(0);
  readonly trees: TreeInst[] = [];
  /** Профиль высоты серпантина (по длине пути, шаг ~6 м). */
  readonly roadPath = hillRoadPath();
  private roadH: number[] = [];
  private roadCum: number[] = [];
  readonly material: THREE.MeshStandardMaterial;

  constructor() {
    this.material = MaterialLib.std({ color: 0xffffff, vertexColors: true, roughness: 0.95, metalness: 0 }, 'terrain');
    this.computeRoadProfile();
    this.computeHeights();
    this.buildMeshes();
    this.buildHillRoad();
    this.scatterTrees();
  }

  // ------------------------------------------------------------------ высоты
  private computeRoadProfile() {
    const P = this.roadPath;
    let cum = 0;
    const raw: number[] = [];
    for (let k = 0; k < P.length; k++) {
      if (k > 0) cum += Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]);
      this.roadCum.push(cum);
      raw.push(Math.max(0, rawHeight(P[k][0], P[k][1])));
    }
    // Сглаживание профиля (скользящее среднее), начало — на уровне шоссе.
    let h = raw.slice();
    for (let pass = 0; pass < 6; pass++) {
      const n = h.slice();
      for (let k = 1; k < h.length - 1; k++) {
        let s = 0, c = 0;
        for (let q = -4; q <= 4; q++) { const i = clamp(k + q, 0, h.length - 1); s += h[i]; c++; }
        n[k] = s / c;
      }
      n[0] = 0;
      h = n;
    }
    // Плавный старт от шоссе.
    for (let k = 0; k < h.length; k++) h[k] *= smoothstep(0, 60, this.roadCum[k]);
    this.roadH = h;
  }

  /** Ближайшая точка серпантина: расстояние и высота дороги. */
  nearestRoad(x: number, z: number): { d: number; h: number; s: number; k: number } {
    const P = this.roadPath;
    let bd = Infinity, bh = 0, bs = 0, bk = 0;
    for (let k = 0; k < P.length - 1; k++) {
      const ax = P[k][0], az = P[k][1], vx = P[k + 1][0] - ax, vz = P[k + 1][1] - az;
      const L2 = vx * vx + vz * vz || 1;
      const t = clamp(((x - ax) * vx + (z - az) * vz) / L2, 0, 1);
      const d = Math.hypot(ax + vx * t - x, az + vz * t - z);
      if (d < bd) { bd = d; bh = lerp(this.roadH[k], this.roadH[k + 1], t); bs = lerp(this.roadCum[k], this.roadCum[k + 1], t); bk = k; }
    }
    return { d: bd, h: bh, s: bs, k: bk };
  }

  private computeHeights() {
    const R = CITY_RECT;
    for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) {
      const x = -WORLD_HALF + i * CELL, z = -WORLD_HALF + j * CELL;
      let h: number;
      if (inRect(R, x, z, 0.01)) h = -0.05; // под городом (скрыт асфальтом)
      else {
        h = rawHeight(x, z);
        if (z < R.z0 - 2) {
          const rd = this.nearestRoad(x, z);
          const w = 1 - smoothstep(HILL_ROAD_HW + 4, HILL_ROAD_HW + 30, rd.d);
          if (w > 0) h = lerp(h, rd.h, w);
        }
      }
      this.heights[j * V + i] = h;
    }
  }

  /** Высота грунта в точке — интерполяция по тем же треугольникам, что и меш. */
  groundHeight(x: number, z: number): number {
    const fx = (x + WORLD_HALF) / CELL, fz = (z + WORLD_HALF) / CELL;
    const i = clamp(Math.floor(fx), 0, N - 1), j = clamp(Math.floor(fz), 0, N - 1);
    const u = clamp(fx - i, 0, 1), v = clamp(fz - j, 0, 1);
    const H = this.heights;
    const h00 = H[j * V + i], h10 = H[j * V + i + 1], h01 = H[(j + 1) * V + i], h11 = H[(j + 1) * V + i + 1];
    if (u >= v) return h00 + u * (h10 - h00) + v * (h11 - h10);
    return h00 + v * (h01 - h00) + u * (h11 - h01);
  }

  // ------------------------------------------------------------------ меши
  private colorAt(x: number, y: number, z: number, ny: number, out: THREE.Color) {
    const n = fbm2(x * 0.01, z * 0.01, 3, 21);
    const grass = out.setRGB(lerp(0.16, 0.26, n), lerp(0.24, 0.3, n), lerp(0.08, 0.1, n));
    // Сухая трава выше по склонам.
    const dry = smoothstep(40, 120, y) * 0.7;
    grass.lerp(new THREE.Color(0.36, 0.33, 0.2), dry);
    // Скалы на крутых склонах.
    const rock = smoothstep(0.88, 0.72, ny);
    grass.lerp(new THREE.Color(0.34, 0.32, 0.3).multiplyScalar(0.8 + 0.4 * n), rock);
    // Песок у воды и на пляже.
    const nearSea = z > CITY_RECT.z1 || x > CITY_RECT.x1 || Math.max(Math.abs(x), Math.abs(z)) > WORLD_HALF - 300;
    if (nearSea) grass.lerp(new THREE.Color(0.52, 0.45, 0.33), smoothstep(3.5, 0.5, y));
    if (y < WATER_Y - 0.3) grass.lerp(new THREE.Color(0.32, 0.3, 0.24), smoothstep(WATER_Y - 0.3, WATER_Y - 3, y));
    // Обочины серпантина.
    if (z < CITY_RECT.z0 - 2 && z > -1500) {
      const rd = this.nearestRoad(x, z);
      grass.lerp(new THREE.Color(0.33, 0.29, 0.22), 1 - smoothstep(HILL_ROAD_HW + 1, HILL_ROAD_HW + 9, rd.d));
    }
    return grass;
  }

  private buildMeshes() {
    const H = this.heights;
    const R = CITY_RECT;
    const pv: number[] = [];
    const pi: number[] = [];
    const c = new THREE.Color();
    const nrm = new THREE.Vector3();
    const normalAt = (i: number, j: number) => {
      const hl = H[j * V + Math.max(0, i - 1)], hr = H[j * V + Math.min(V - 1, i + 1)];
      const hd = H[Math.max(0, j - 1) * V + i], hu = H[Math.min(V - 1, j + 1) * V + i];
      return nrm.set(hl - hr, 2 * CELL, hd - hu).normalize();
    };
    const tiles = Math.ceil(N / TILE);
    for (let tj = 0; tj < tiles; tj++) for (let ti = 0; ti < tiles; ti++) {
      const gb = new GeomBuilder(null);
      const vmap = new Map<number, number>();
      const vid = (i: number, j: number) => {
        const key = j * V + i;
        let id = vmap.get(key);
        if (id !== undefined) return id;
        const x = -WORLD_HALF + i * CELL, z = -WORLD_HALF + j * CELL, y = H[key];
        const n = normalAt(i, j);
        gb.setColor(this.colorAt(x, y, z, n.y, c));
        // uv.y = 0: деревья используют uv для покачивания, рельефу не важно.
        id = gb.vertex(x, y, z, n.x, n.y, n.z, x * 0.05, z * 0.05);
        vmap.set(key, id);
        return id;
      };
      for (let j = tj * TILE; j < Math.min(N, (tj + 1) * TILE); j++) for (let i = ti * TILE; i < Math.min(N, (ti + 1) * TILE); i++) {
        const x0 = -WORLD_HALF + i * CELL, z0 = -WORLD_HALF + j * CELL;
        // Ячейки целиком под городом не нужны: их закрывают дороги и кварталы.
        if (x0 >= R.x0 && x0 + CELL <= R.x1 && z0 >= R.z0 && z0 + CELL <= R.z1) continue;
        const a = vid(i, j), b = vid(i + 1, j), cc = vid(i + 1, j + 1), d = vid(i, j + 1);
        gb.idx.push(a, d, cc, a, cc, b);
        // Физика: те же треугольники.
        const base = pv.length / 3;
        for (const [ii, jj] of [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]]) pv.push(-WORLD_HALF + ii * CELL, H[jj * V + ii], -WORLD_HALF + jj * CELL);
        pi.push(base, base + 3, base + 2, base, base + 2, base + 1);
      }
      if (gb.isEmpty()) continue;
      const mesh = new THREE.Mesh(gb.build(), this.material);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.name = `terrain_${ti}_${tj}`;
      this.group.add(mesh);
    }
    this.physVerts = new Float32Array(pv);
    this.physIdx = new Uint32Array(pi);
  }

  /** Лента асфальта серпантина, повторяющая рельеф. */
  private buildHillRoad() {
    const P = this.roadPath;
    const gb = new GeomBuilder('aRoad', 4);
    gb.setAttr(0, 1, HILL_ROAD_HW, 0);
    let cum = 0;
    let prevL: number[] | null = null, prevR: number[] | null = null;
    // Подразбиваем путь до ~3 м для точного следования треугольникам рельефа.
    const pts: [number, number][] = [];
    for (let k = 0; k < P.length - 1; k++) {
      const n = Math.max(1, Math.ceil(Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]) / 3));
      for (let q = 0; q < n; q++) pts.push([lerp(P[k][0], P[k + 1][0], q / n), lerp(P[k][1], P[k + 1][1], q / n)]);
    }
    pts.push(P[P.length - 1]);
    for (let k = 0; k < pts.length; k++) {
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
      let tx = b[0] - a[0], tz = b[1] - a[1];
      const L = Math.hypot(tx, tz) || 1;
      tx /= L; tz /= L;
      const rx = -tz, rz = tx;
      if (k > 0) cum += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      const lx = pts[k][0] - rx * HILL_ROAD_HW, lz = pts[k][1] - rz * HILL_ROAD_HW;
      const rrx = pts[k][0] + rx * HILL_ROAD_HW, rrz = pts[k][1] + rz * HILL_ROAD_HW;
      const L3 = [lx, this.groundHeight(lx, lz) + 0.1, lz, -HILL_ROAD_HW, cum];
      const R3 = [rrx, this.groundHeight(rrx, rrz) + 0.1, rrz, HILL_ROAD_HW, cum];
      if (prevL && prevR) {
        const i0 = gb.vertex(prevL[0], prevL[1], prevL[2], 0, 1, 0, prevL[3], prevL[4]);
        gb.vertex(prevR[0], prevR[1], prevR[2], 0, 1, 0, prevR[3], prevR[4]);
        gb.vertex(R3[0], R3[1], R3[2], 0, 1, 0, R3[3], R3[4]);
        gb.vertex(L3[0], L3[1], L3[2], 0, 1, 0, L3[3], L3[4]);
        // Ориентация треугольников вверх.
        const ux = prevR[0] - prevL[0], uz = prevR[2] - prevL[2];
        const vx = L3[0] - prevL[0], vz = L3[2] - prevL[2];
        const cy = uz * vx - ux * vz;
        if (cy > 0) gb.idx.push(i0, i0 + 3, i0 + 2, i0, i0 + 2, i0 + 1);
        else gb.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
      }
      prevL = L3; prevR = R3;
    }
    const geo = gb.build();
    geo.computeVertexNormals();
    const mat = MaterialLib.std({ color: 0xffffff, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }, 'road');
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'hill_road';
    this.group.add(mesh);
  }

  // ------------------------------------------------------------------ деревья
  private scatterTrees() {
    const rng = new RNG(4242);
    const R = CITY_RECT;
    for (let z = -WORLD_HALF + 20; z < WORLD_HALF - 20; z += 19) for (let x = -WORLD_HALF + 20; x < WORLD_HALF - 20; x += 19) {
      const px = x + rng.range(-8, 8), pz = z + rng.range(-8, 8);
      if (inRect(R, px, pz, 18)) continue;
      const h = this.groundHeight(px, pz);
      if (h < 1.2) {
        // Пальмы на пляже.
        if (pz > R.z1 + 4 && pz < R.z1 + 60 && h > -0.4 && rng.chance(0.18)) this.trees.push({ x: px, y: h, z: pz, s: rng.range(0.9, 1.3), rot: rng.range(0, 6.28), kind: 'palm' });
        continue;
      }
      const dens = fbm2(px * 0.004, pz * 0.004, 3, 99);
      if (dens < 0.45 || !rng.chance(0.55)) continue;
      if (pz < R.z0 && this.nearestRoad(px, pz).d < HILL_ROAD_HW + 8) continue;
      // Крутые склоны пропускаем.
      const sl = Math.abs(this.groundHeight(px + 2, pz) - h) + Math.abs(this.groundHeight(px, pz + 2) - h);
      if (sl > 2.2) continue;
      this.trees.push({ x: px, y: h, z: pz, s: rng.range(0.8, 1.5), rot: rng.range(0, 6.28), kind: h > 25 || rng.chance(0.6) ? 'pine' : 'oak' });
    }
  }
}

/** Водная гладь вокруг острова. */
export function createWater(): THREE.Mesh {
  const mat = MaterialLib.std({ color: 0x0a2c36, roughness: 0.08, metalness: 0.0 }, 'water');
  const geo = new THREE.PlaneGeometry(WORLD_HALF * 6, WORLD_HALF * 6, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geo, mat);
  m.position.y = WATER_Y;
  m.receiveShadow = true;
  m.name = 'water';
  return m;
}
