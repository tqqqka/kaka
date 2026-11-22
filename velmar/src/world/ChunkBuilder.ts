/**
 * Генерация геометрии чанка (200×200 м): детальные здания (LOD0), упрощённые (LOD1),
 * пропсы (фонари, светофоры, деревья, контейнеры, краны, заборы), неоновые вывески,
 * светящиеся рёбра небоскрёбов, авиационные огни. Всё сливается в несколько мешей
 * на чанк — по одному draw call на материал.
 */
import * as THREE from 'three';
import { GeomBuilder } from './GeomBuilder';
import {
  GRID, SIDEWALK_H, PIERS, CITY_RECT, hwX, hwZ, lineX, lineZ, lanesX, lanesZ, inRect,
  type Block, type BuildingPlan, type CityLayout, type Tier, type Rect,
} from './CityLayout';
import type { RoadGraph } from './RoadGraph';
import type { Terrain, TreeInst } from './Terrain';
import { NEON_COLORS, SPECIAL_SIGN, neonUV } from '../render/NeonAtlas';
import { RNG, hash2 } from '../core/MathUtil';

export const CHUNK = 200;
export const CHUNKS = 16; // 16×16 чанков на мир 3200 м
export const chunkOrigin = (c: number) => -1600 + c * CHUNK;

export interface BoxCollider { x: number; y: number; z: number; hx: number; hy: number; hz: number; rot: number }
export interface SignalHead { node: number; axis: 'x' | 'z'; x: number; y: number; z: number; ry: number }

export interface ChunkDef {
  ci: number; cj: number;
  rect: Rect;
  buildings: BuildingPlan[];
  blocks: Block[];
  trees: TreeInst[];
  hasContent: boolean;
}

export interface ChunkData {
  facade: GeomBuilder;
  foliage: GeomBuilder;
  lights: GeomBuilder;
  pools: GeomBuilder;
  neon: GeomBuilder;
  beacons: number[];
  colliders: BoxCollider[];
  signals: SignalHead[];
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _e = new THREE.Euler();

/** Шаблоны крон (создаются один раз). */
const TEMPLATES = (() => {
  const blob = new THREE.IcosahedronGeometry(1, 0);
  const pos = blob.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = 0.82 + 0.3 * hash2(Math.round(x * 50), Math.round(y * 50 + z * 30), 3);
    pos.setXYZ(i, x * n, y * n * 0.85, z * n);
  }
  blob.computeVertexNormals();
  const cone = new THREE.ConeGeometry(1, 1, 6, 1, true);
  const frond = new THREE.BoxGeometry(0.5, 0.06, 3.2);
  frond.translate(0, 0, 1.6);
  return { blob: blob.toNonIndexed(), cone, frond };
})();

export class ChunkBuilder {
  /** Упрощённая генерация для слабых устройств (меньше деревьев и деталей). */
  lowDetail = false;
  constructor(private layout: CityLayout, private graph: RoadGraph, private terrain: Terrain) {}

  // =========================================================================
  // LOD1: только ярусы-коробки, без деталей. Дёшево для дальних планов.
  // =========================================================================
  buildLOD1(def: ChunkDef): GeomBuilder {
    const gb = new GeomBuilder('aFacade', 4);
    for (const p of def.buildings) {
      p.tiers.forEach((t, ti) => {
        gb.setColor(t.color);
        gb.setAttr(t.style, t.cellW, t.cellH, p.seed + ti * 7);
        if (t.kind === 'box') gb.box(t.cx, t.y0, t.cz, t.w, t.h, t.d, t.rot);
        else gb.prism(t.cx, t.y0, t.cz, t.r, Math.min(t.sides, 8), t.h, t.rot, true, t.taper);
      });
      for (const r of p.roof) {
        if (r.kind === 'pyramid') { gb.setAttr(4, 3, 3, p.seed); gb.pyramid(r.x, r.y, r.z, r.w, r.d, r.h, r.rot); }
        if (r.kind === 'gable') { gb.setColor(0x5a3a30); gb.setAttr(4, 3, 3, p.seed); gb.gable(r.x, r.y, r.z, r.w, r.d, r.h, r.rot); }
      }
    }
    return gb;
  }

  // =========================================================================
  // LOD0
  // =========================================================================
  buildLOD0(def: ChunkDef): ChunkData {
    const data: ChunkData = {
      facade: new GeomBuilder('aFacade', 4),
      foliage: new GeomBuilder(null),
      lights: new GeomBuilder(null),
      pools: new GeomBuilder(null),
      neon: new GeomBuilder(null),
      beacons: [],
      colliders: [],
      signals: [],
    };
    const rng = new RNG(def.ci * 1009 + def.cj * 31 + 7);
    for (const p of def.buildings) this.building(p, data, rng);
    this.streetProps(def, data, rng);
    for (const b of def.blocks) this.blockProps(b, data, rng);
    this.portProps(def, data, rng);
    for (const [i, t] of def.trees.entries()) if (!this.lowDetail || i % 2 === 0) this.tree(data, t.x, t.y, t.z, t.s, t.kind, t.rot);
    this.placeSigns(def, data);
    return data;
  }

  // --- Здания ---------------------------------------------------------------
  private building(p: BuildingPlan, d: ChunkData, rng: RNG) {
    const gb = d.facade;
    p.tiers.forEach((t, ti) => {
      gb.setColor(t.color);
      gb.setAttr(t.style, t.cellW, t.cellH, p.seed + ti * 7);
      if (t.kind === 'box') {
        gb.box(t.cx, t.y0, t.cz, t.w, t.h, t.d, t.rot);
        if (!this.lowDetail) this.ledges(gb, t, p, rng);
      } else {
        gb.prism(t.cx, t.y0, t.cz, t.r, t.sides, t.h, t.rot, true, t.taper);
        if (t.h > 30 && t.style !== 4) {
          // Кольцевые пояса на круглых башнях.
          gb.setColor(new THREE.Color(t.color).multiplyScalar(0.7));
          gb.setAttr(4, 3, 3, p.seed);
          for (let y = t.y0 + t.cellH * 6; y < t.y0 + t.h - 2; y += t.cellH * 6) {
            const k = (y - t.y0) / t.h;
            gb.prism(t.cx, y, t.cz, t.r * (1 - t.taper * k) + 0.35, t.sides, 0.4, t.rot, true, 0);
          }
        }
      }
      if (p.edgeLights) this.edgeLights(d, t, p);
    });
    for (const r of p.roof) this.roofFeature(d, p, r, rng);
    // Авиационные огни на высотках.
    if (p.height > 70) {
      const top = p.tiers.reduce((a, t) => (t.y0 + t.h > a.y0 + a.h ? t : a), p.tiers[0]);
      const ext = top.kind === 'box' ? Math.min(top.w, top.d) * 0.45 : top.r * 0.8;
      d.beacons.push(top.cx + ext, top.y0 + top.h + 1.5, top.cz + ext, top.cx - ext, top.y0 + top.h + 1.5, top.cz - ext);
    }
    if (p.landmark === 'construction') this.towerCrane(d, p);
  }

  /** Межэтажные карнизы и цоколь. */
  private ledges(gb: GeomBuilder, t: Tier, p: BuildingPlan, rng: RNG) {
    const base = new THREE.Color(t.color);
    if (t.y0 <= SIDEWALK_H + 0.01 && t.style !== 5 && t.style !== 4) {
      gb.setColor(base.clone().multiplyScalar(0.55));
      gb.setAttr(4, 3, 3, p.seed);
      gb.box(t.cx, t.y0, t.cz, t.w + 0.3, 0.9, t.d + 0.3, t.rot, true);
    }
    if ((t.style === 1 || t.style === 2) && t.h > 10) {
      const every = t.style === 2 ? (rng.chance(0.5) ? 1 : 3) : 4;
      gb.setColor(base.clone().multiplyScalar(0.8));
      gb.setAttr(4, 3, 3, p.seed);
      let n = 0;
      for (let y = t.y0 + t.cellH * every; y < t.y0 + t.h - 1 && n < 12; y += t.cellH * every, n++) {
        gb.box(t.cx, y - 0.15, t.cz, t.w + 0.5, 0.28, t.d + 0.5, t.rot, true, true);
      }
    }
    if (t.style === 0 && t.h > 20) {
      // Вертикальные пилоны у стеклянных фасадов.
      gb.setColor(base.clone().multiplyScalar(0.6));
      gb.setAttr(4, 3, 3, p.seed);
      const c = Math.cos(t.rot), s = Math.sin(t.rot);
      for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const ox = lx * t.w / 2, oz = lz * t.d / 2;
        gb.box(t.cx + ox * c + oz * s, t.y0, t.cz - ox * s + oz * c, 0.9, t.h + 0.6, 0.9, t.rot, true);
      }
    }
  }

  /** Светящиеся вертикальные рёбра небоскрёба (ночной силуэт). */
  private edgeLights(d: ChunkData, t: Tier, p: BuildingPlan) {
    const col = new THREE.Color(NEON_COLORS[p.seed % NEON_COLORS.length]).lerp(new THREE.Color(1, 1, 1), 0.35);
    d.lights.setColor(col);
    const pts: [number, number, number][] = []; // x, z, угол наружу
    if (t.kind === 'box') {
      const c = Math.cos(t.rot), s = Math.sin(t.rot);
      for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const ox = lx * (t.w / 2 + 0.5), oz = lz * (t.d / 2 + 0.5);
        const x = t.cx + ox * c + oz * s, z = t.cz - ox * s + oz * c;
        pts.push([x, z, Math.atan2(z - t.cz, x - t.cx)]);
      }
    } else {
      const step = Math.max(1, Math.round(t.sides / 8));
      for (let k = 0; k < t.sides; k += step) {
        const a = t.rot - k * (2 * Math.PI / t.sides);
        pts.push([t.cx + Math.cos(a) * (t.r + 0.2), t.cz + Math.sin(a) * (t.r + 0.2), a]);
      }
    }
    const y0 = t.y0 + 2, y1 = t.y0 + t.h;
    const shrink = t.kind === 'prism' ? t.taper : 0;
    for (const [x, z, a] of pts) {
      const ex = x + (t.cx - x) * shrink, ez = z + (t.cz - z) * shrink;
      for (const off of [0, Math.PI / 2]) {
        const ux = Math.cos(a + off + Math.PI / 4) * 0.22, uz = Math.sin(a + off + Math.PI / 4) * 0.22;
        const nx = Math.cos(a), nz = Math.sin(a);
        d.lights.quad(x - ux, y0, z - uz, x + ux, y0, z + uz, ex + ux, y1, ez + uz, ex - ux, y1, ez - uz, nx, 0, nz, 0, 0, 1, 1);
      }
    }
    // Кольцо света по верху яруса.
    if (t.kind === 'box') {
      const c = Math.cos(t.rot), s = Math.sin(t.rot);
      const hw = t.w / 2 + 0.45, hd = t.d / 2 + 0.45;
      const cs: [number, number][] = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
      for (let k = 0; k < 4; k++) {
        const [ax, az] = cs[k], [bx, bz] = cs[(k + 1) % 4];
        const A = [t.cx + ax * c + az * s, t.cz - ax * s + az * c], B = [t.cx + bx * c + bz * s, t.cz - bx * s + bz * c];
        d.lights.quad(A[0], y1 - 0.5, A[1], B[0], y1 - 0.5, B[1], B[0], y1, B[1], A[0], y1, A[1], 0, 0, 1, 0, 0, 1, 1);
      }
    }
  }

  private roofFeature(d: ChunkData, p: BuildingPlan, r: BuildingPlan['roof'][number], rng: RNG) {
    const gb = d.facade;
    const c = Math.cos(r.rot), s = Math.sin(r.rot);
    const at = (lx: number, lz: number): [number, number] => [r.x + lx * c + lz * s, r.z - lx * s + lz * c];
    switch (r.kind) {
      case 'parapet': {
        gb.setColor(0x6d6a66);
        gb.setAttr(4, 3, 3, p.seed);
        const t = 0.35;
        let q = at(0, r.d / 2 - t / 2); gb.box(q[0], r.y, q[1], r.w, r.h, t, r.rot);
        q = at(0, -r.d / 2 + t / 2); gb.box(q[0], r.y, q[1], r.w, r.h, t, r.rot);
        q = at(r.w / 2 - t / 2, 0); gb.box(q[0], r.y, q[1], t, r.h, r.d - 2 * t, r.rot);
        q = at(-r.w / 2 + t / 2, 0); gb.box(q[0], r.y, q[1], t, r.h, r.d - 2 * t, r.rot);
        break;
      }
      case 'ac':
        gb.setColor(0xb9bcbf); gb.setAttr(4, 3, 3, p.seed);
        gb.box(r.x, r.y, r.z, r.w, r.h, r.d, r.rot);
        gb.setColor(0x555a5e);
        gb.prism(r.x, r.y + r.h, r.z, Math.min(r.w, r.d) * 0.3, 10, 0.3, 0);
        break;
      case 'tank':
        gb.setColor(0x7a6a58); gb.setAttr(4, 3, 3, p.seed);
        for (const [lx, lz] of [[-0.6, -0.6], [0.6, -0.6], [0.6, 0.6], [-0.6, 0.6]]) gb.box(r.x + lx, r.y, r.z + lz, 0.2, 2, 0.2, 0);
        gb.prism(r.x, r.y + 2, r.z, r.w / 2, 10, r.h, 0);
        gb.prism(r.x, r.y + 2 + r.h, r.z, r.w / 2, 10, 1, 0, true, 0.9);
        break;
      case 'antenna':
        gb.setColor(0x8a8e92); gb.setAttr(4, 3, 3, p.seed);
        gb.prism(r.x, r.y, r.z, r.w, 6, r.h * 0.4, 0, true, 0.3);
        gb.prism(r.x, r.y + r.h * 0.4, r.z, r.w * 0.35, 5, r.h * 0.6, 0, true, 0.6);
        d.beacons.push(r.x, r.y + r.h, r.z);
        break;
      case 'helipad': {
        gb.setColor(0x3a3d42); gb.setAttr(4, 3, 3, p.seed);
        gb.prism(r.x, r.y, r.z, r.w / 2, 16, r.h, 0);
        // Разметка «H» и кольцо огней.
        gb.setColor(0xe8e2d0);
        gb.box(r.x - 3, r.y + r.h, r.z, 1.2, 0.05, 8, 0);
        gb.box(r.x + 3, r.y + r.h, r.z, 1.2, 0.05, 8, 0);
        gb.box(r.x, r.y + r.h, r.z, 6, 0.05, 1.2, 0);
        d.lights.setColor(new THREE.Color(0.3, 1.0, 0.4));
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          const x = r.x + Math.cos(a) * (r.w / 2 - 0.6), z = r.z + Math.sin(a) * (r.w / 2 - 0.6);
          d.lights.box(x, r.y + r.h, z, 0.4, 0.25, 0.4, 0);
        }
        break;
      }
      case 'crown': {
        gb.setColor(0x9aa0a6); gb.setAttr(4, 3, 3, p.seed);
        const n = 12;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2 + r.rot;
          gb.box(r.x + Math.cos(a) * r.w / 2, r.y, r.z + Math.sin(a) * r.w / 2, 0.6, r.h * (0.7 + 0.3 * ((k % 2))), 1.6, -a);
        }
        d.lights.setColor(new THREE.Color(NEON_COLORS[p.seed % NEON_COLORS.length]));
        d.lights.prism(r.x, r.y + r.h * 0.6, r.z, r.w / 2 + 0.2, 16, 0.5, 0, false);
        break;
      }
      case 'pyramid':
        gb.setColor(0x4c5157); gb.setAttr(4, 3, 3, p.seed);
        gb.pyramid(r.x, r.y, r.z, r.w, r.d, r.h, r.rot);
        d.beacons.push(r.x, r.y + r.h + 0.5, r.z);
        break;
      case 'gable':
        gb.setColor(rng.pick([0x6b3a2e, 0x4a4a4e, 0x7a4b32, 0x3e4a5a, 0x5c3b2a]));
        gb.setAttr(4, 3, 3, p.seed);
        gb.gable(r.x, r.y, r.z, r.w, r.d, r.h, r.rot);
        break;
      case 'chimney':
        gb.setColor(0x7c4a3a); gb.setAttr(4, 3, 3, p.seed);
        gb.box(r.x, r.y, r.z, r.w, r.h, r.d, 0);
        break;
      case 'billboard': {
        gb.setColor(0x2a2c30); gb.setAttr(4, 3, 3, p.seed);
        for (const lx of [-r.w * 0.35, r.w * 0.35]) { const q = at(lx, 0); gb.box(q[0], r.y, q[1], 0.3, 2.5, 0.3, r.rot); }
        const q = at(0, 0);
        gb.box(q[0], r.y + 2.5, q[1], r.w, r.h, r.d, r.rot);
        const word = p.landmark === 'garage' ? SPECIAL_SIGN.garage : 20 + (p.seed % 12);
        const col = new THREE.Color(NEON_COLORS[(p.seed >> 2) % NEON_COLORS.length]);
        for (const side of [1, -1]) {
          const nq = at(0, side * (r.d / 2 + 0.05));
          this.signQuad(d.neon, nq[0], r.y + 2.5 + r.h / 2, nq[1], -s * side, c * side, r.w * 0.95, r.h * 0.9, word, col);
        }
        break;
      }
      case 'spire':
        break;
    }
  }

  /** Башенный кран над стройкой. */
  private towerCrane(d: ChunkData, p: BuildingPlan) {
    const r = p.roof.find((q) => q.kind === 'spire');
    if (!r) return;
    const gb = d.facade;
    gb.setColor(0xd9a21b); gb.setAttr(3, 1.2, 1.2, p.seed);
    gb.box(r.x, r.y, r.z, r.w, r.h, r.d, 0);
    gb.box(r.x - 20, r.y + r.h, r.z, 58, 1.6, 1.6, 0);
    gb.setAttr(4, 3, 3, p.seed);
    gb.box(r.x + 13, r.y + r.h - 2.2, r.z, 6, 2.2, 3, 0); // противовес
    gb.box(r.x + 2, r.y + r.h - 3, r.z + 1.6, 2.5, 2.5, 2.5, 0); // кабина
    gb.prism(r.x, r.y + r.h, r.z, 1, 4, 8, Math.PI / 4, true, 0.9);
    gb.setColor(0x333333);
    gb.box(r.x - 38, r.y + r.h - 26, r.z, 0.1, 26, 0.1, 0); // трос
    gb.setColor(0xb04a20);
    gb.box(r.x - 38, r.y + r.h - 28, r.z, 2.5, 2, 2.5, 0);
    d.beacons.push(r.x, r.y + r.h + 8.5, r.z, r.x - 48, r.y + r.h + 1.8, r.z);
    d.colliders.push({ x: r.x, y: r.y + r.h / 2, z: r.z, hx: r.w / 2, hy: r.h / 2, hz: r.d / 2, rot: 0 });
  }

  // --- Вывески ----------------------------------------------------------------
  private signQuad(gb: GeomBuilder, x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, word: number, col: THREE.Color) {
    const [u0, v0, u1, v1] = neonUV(word);
    // Касательная вдоль стены: (nz, -nx) — текст читается снаружи.
    const tx = -nz, tz = nx;
    gb.setColor(col);
    gb.quad(
      x - tx * w / 2, y - h / 2, z - tz * w / 2,
      x + tx * w / 2, y - h / 2, z + tz * w / 2,
      x + tx * w / 2, y + h / 2, z + tz * w / 2,
      x - tx * w / 2, y + h / 2, z - tz * w / 2,
      nx, 0, nz, u0, v0, u1, v1,
    );
  }

  private placeSigns(def: ChunkDef, d: ChunkData) {
    for (const p of def.buildings) {
      for (const sg of p.signs) {
        const word = Math.floor(hash2(Math.round(sg.x), Math.round(sg.z), 5) * 32);
        const col = new THREE.Color(NEON_COLORS[Math.floor(hash2(Math.round(sg.z), Math.round(sg.x), 9) * NEON_COLORS.length)]);
        // Подложка-короб вывески.
        d.facade.setColor(0x1c1d20); d.facade.setAttr(4, 3, 3, 1);
        const tx = -sg.nz, tz = sg.nx;
        d.facade.box(sg.x - sg.nx * 0.12, sg.y - sg.w / 8 - 0.1, sg.z - sg.nz * 0.12, Math.abs(tx) * sg.w + Math.abs(sg.nx) * 0.2 + 0.1, sg.w / 4 + 0.2, Math.abs(tz) * sg.w + Math.abs(sg.nz) * 0.2 + 0.1, 0);
        this.signQuad(d.neon, sg.x + sg.nx * 0.02, sg.y, sg.z + sg.nz * 0.02, sg.nx, sg.nz, sg.w, sg.w / 4, word, col);
      }
    }
    // Пилоны с вывесками у ключевых мест.
    for (const pl of this.layout.places) {
      if (!inRect(def.rect, pl.x, pl.z) || SPECIAL_SIGN[pl.id] === undefined) continue;
      const b = this.layout.blockAt(pl.x, pl.z + 3) ?? this.layout.blockAt(pl.x, pl.z - 3) ?? this.layout.blockAt(pl.x + 3, pl.z) ?? this.layout.blockAt(pl.x - 3, pl.z);
      // Пилон ставим на тротуаре со стороны квартала, вывеска смотрит на улицу.
      let nx = 0, nz = 1;
      let px = pl.x, pz = pl.z;
      if (b) {
        if (pl.z > b.z1) { nz = 1; pz = b.z1 - 1.2; }
        else if (pl.z < b.z0) { nz = -1; pz = b.z0 + 1.2; }
        else if (pl.x > b.x1) { nx = 1; nz = 0; px = b.x1 - 1.2; }
        else { nx = -1; nz = 0; px = b.x0 + 1.2; }
      }
      d.facade.setColor(0x24262a); d.facade.setAttr(4, 3, 3, 2);
      d.facade.box(px, SIDEWALK_H, pz, 0.35, 5, 0.35, 0);
      const tx = -nz, tz = nx;
      d.facade.box(px, SIDEWALK_H + 5, pz, Math.abs(tx) * 6.4 + 0.4, 1.8, Math.abs(tz) * 6.4 + 0.4, 0);
      const col = new THREE.Color(pl.color);
      for (const sd of [1, -1]) this.signQuad(d.neon, px + nx * sd * 0.22, SIDEWALK_H + 5.9, pz + nz * sd * 0.22, nx * sd, nz * sd, 6.2, 1.55, SPECIAL_SIGN[pl.id], col);
      d.colliders.push({ x: px, y: 2.5, z: pz, hx: 0.25, hy: 2.5, hz: 0.25, rot: 0 });
    }
  }

  // --- Уличные пропсы ---------------------------------------------------------
  private streetProps(def: ChunkDef, d: ChunkData, rng: RNG) {
    const R = def.rect;
    const lampCol = new THREE.Color(1.0, 0.74, 0.45);
    const poolCol = new THREE.Color(1.0, 0.62, 0.32);
    // Вертикальные улицы (вдоль Z).
    for (let i = 0; i <= GRID.nx; i++) {
      const x = lineX(i);
      if (x < R.x0 || x >= R.x1) continue;
      for (let j = 0; j < GRID.nz; j++) {
        const zA = lineZ(j) + hwZ(j) + 6, zB = lineZ(j + 1) - hwZ(j + 1) - 6;
        for (const side of [-1, 1]) {
          if (i === 0 && side < 0) continue;
          if (i === GRID.nx && side > 0) continue;
          const px = x + side * (hwX(i) + 0.9);
          for (let z = zA + (side > 0 ? 0 : 16); z <= zB; z += 33) this.lamp(d, px, z, -side, 0, lampCol, poolCol);
        }
      }
    }
    // Горизонтальные улицы (вдоль X).
    for (let j = 0; j <= GRID.nz; j++) {
      const z = lineZ(j);
      if (z < R.z0 || z >= R.z1) continue;
      for (let i = 0; i < GRID.nx; i++) {
        const xA = lineX(i) + hwX(i) + 6, xB = lineX(i + 1) - hwX(i + 1) - 6;
        for (const side of [-1, 1]) {
          if (j === 0 && side < 0) continue;
          if (j === GRID.nz && side > 0) continue;
          const pz = z + side * (hwZ(j) + 0.9);
          for (let x = xA + (side > 0 ? 16 : 0); x <= xB; x += 33) this.lamp(d, x, pz, 0, -side, lampCol, poolCol);
        }
      }
    }
    // Светофоры.
    for (const n of this.graph.nodes) {
      if (!n.light || !inRect(R, n.x, n.z) || n.x < R.x0 || n.x >= R.x1 || n.z < R.z0 || n.z >= R.z1) continue;
      const hasFrom = (dx: number, dz: number) => n.out.some((eid) => {
        const e = this.graph.edges[eid];
        const nb = this.graph.nodes[e.b];
        return Math.sign(nb.x - n.x) === dx && Math.sign(nb.z - n.z) === dz;
      });
      // [угол X, угол Z, рука X, рука Z, ось, откуда едут]
      const cfg: [number, number, number, number, 'x' | 'z', number, number][] = [
        [1, 1, -1, 0, 'z', 0, 1],   // едут на север (с юга)
        [-1, -1, 1, 0, 'z', 0, -1], // едут на юг (с севера)
        [1, -1, 0, 1, 'x', 1, 0],   // едут на запад (с востока)
        [-1, 1, 0, -1, 'x', -1, 0], // едут на восток (с запада)
      ];
      for (const [sx, sz, ax, az, axis, fx, fz] of cfg) {
        if (!hasFrom(fx, fz)) continue;
        const px = n.x + sx * (n.ex + 1.0), pz = n.z + sz * (n.ez + 1.0);
        const lanes = axis === 'z' ? lanesX(n.i) : lanesZ(n.j);
        const arm = lanes * 3.5 + 1;
        d.facade.setColor(0x2b2e31); d.facade.setAttr(4, 3, 3, 3);
        d.facade.prism(px, SIDEWALK_H, pz, 0.16, 8, 6.2, 0);
        d.facade.box(px + ax * arm / 2, SIDEWALK_H + 6.0, pz + az * arm / 2, Math.abs(ax) * arm + 0.18, 0.18, Math.abs(az) * arm + 0.18, 0);
        const hx = px + ax * (arm - 0.8), hz = pz + az * (arm - 0.8);
        d.facade.setColor(0x16181a);
        d.facade.box(hx, SIDEWALK_H + 4.6, hz, 0.5, 1.4, 0.5, 0);
        const ry = Math.atan2(fx, fz); // фронт сигнала смотрит на приезжающих
        d.signals.push({ node: n.id, axis, x: hx + fx * 0.27, y: SIDEWALK_H + 5.3, z: hz + fz * 0.27, ry });
      }
    }
  }

  private lamp(d: ChunkData, x: number, z: number, ax: number, az: number, lampCol: THREE.Color, poolCol: THREE.Color) {
    if (this.layout.blockAt(x, z) === null && !inRect(CITY_RECT, x, z)) return;
    const gb = d.facade;
    gb.setColor(0x34383c); gb.setAttr(4, 3, 3, 4);
    gb.prism(x, SIDEWALK_H, z, 0.13, 6, 8.2, 0, true, 0.3);
    gb.box(x + ax * 1.1, SIDEWALK_H + 8.0, z + az * 1.1, Math.abs(ax) * 2.2 + 0.14, 0.14, Math.abs(az) * 2.2 + 0.14, 0);
    gb.setColor(0x202224);
    gb.box(x + ax * 2.1, SIDEWALK_H + 7.85, z + az * 2.1, 0.9, 0.25, 0.9, 0);
    d.lights.setColor(lampCol);
    d.lights.box(x + ax * 2.1, SIDEWALK_H + 7.78, z + az * 2.1, 0.7, 0.08, 0.7, 0, false, true);
    // Световое пятно на асфальте.
    const cx = x + ax * 2.6, cz = z + az * 2.6, r = 8.5;
    d.pools.setColor(poolCol);
    d.pools.hRect(cx - r, cz - r, cx + r, cz + r, 0.05, 1, [0, 0, 1, 1]);
  }

  // --- Пропсы кварталов -------------------------------------------------------
  private blockProps(b: Block, d: ChunkData, rng: RNG) {
    // Деревья вдоль тротуаров.
    const along = !this.lowDetail && (b.district === 'residential' || b.district === 'downtown' || b.district === 'beach' || b.district === 'plaza' || b.district === 'park');
    if (along) {
      const kind = b.district === 'beach' ? 'palm' : 'oak';
      const inset = 1.6;
      const step = b.district === 'downtown' ? 30 : 22;
      for (let x = b.x0 + 12; x < b.x1 - 10; x += step) {
        if (rng.chance(0.85)) this.tree(d, x, SIDEWALK_H, b.z0 + inset, rng.range(0.7, 1.0), kind, rng.range(0, 6));
        if (rng.chance(0.85)) this.tree(d, x + 8, SIDEWALK_H, b.z1 - inset, rng.range(0.7, 1.0), kind, rng.range(0, 6));
      }
      for (let z = b.z0 + 12; z < b.z1 - 10; z += step) {
        if (rng.chance(0.85)) this.tree(d, b.x0 + inset, SIDEWALK_H, z, rng.range(0.7, 1.0), kind, rng.range(0, 6));
        if (rng.chance(0.85)) this.tree(d, b.x1 - inset, SIDEWALK_H, z + 8, rng.range(0.7, 1.0), kind, rng.range(0, 6));
      }
    }
    for (const t of b.trees) this.tree(d, t.x, SIDEWALK_H, t.z, t.s, b.district === 'beach' ? 'palm' : b.district === 'suburb' && rng.chance(0.3) ? 'pine' : 'oak', rng.range(0, 6));
    // Скамейки в парке.
    if (b.district === 'park' || b.district === 'plaza') {
      const cx = (b.inner.x0 + b.inner.x1) / 2, cz = (b.inner.z0 + b.inner.z1) / 2;
      d.facade.setColor(0x5b3a24); d.facade.setAttr(4, 3, 3, 5);
      for (let k = -2; k <= 2; k++) {
        if (k === 0) continue;
        d.facade.box(cx + k * 9, SIDEWALK_H, cz + 6.5, 2.2, 0.5, 0.6, 0);
        d.facade.box(cx + k * 9, SIDEWALK_H, cz - 6.5, 2.2, 0.5, 0.6, 0);
      }
      if (b.district === 'park') {
        // Фонтан.
        d.facade.setColor(0x8c8a84);
        d.facade.prism(cx, SIDEWALK_H, cz, 6, 16, 0.7, 0);
        d.facade.prism(cx, SIDEWALK_H + 0.7, cz, 1.2, 10, 1.6, 0);
        d.colliders.push({ x: cx, y: 0.5, z: cz, hx: 4.5, hy: 0.6, hz: 4.5, rot: 0 });
      }
    }
    // Забор вокруг стройки (с воротами на запад).
    if (b.district === 'construction') {
      const I = b.inner;
      d.facade.setColor(0x6a6e5a); d.facade.setAttr(3, 2.5, 1, 6);
      const cx = (I.x0 + I.x1) / 2, cz = (I.z0 + I.z1) / 2;
      const segs: [number, number, number, number][] = [
        [cx, I.z0, I.x1 - I.x0, 0.2], [cx, I.z1, I.x1 - I.x0, 0.2], [I.x1, cz, 0.2, I.z1 - I.z0],
        [I.x0, I.z0 + (cz - 8 - I.z0) / 2, 0.2, cz - 8 - I.z0], [I.x0, I.z1 - (I.z1 - cz - 8) / 2, 0.2, I.z1 - cz - 8],
      ];
      for (const [x, z, w, dd] of segs) {
        d.facade.box(x, SIDEWALK_H, z, w, 2.4, dd, 0);
        d.colliders.push({ x, y: 1.3, z, hx: w / 2, hy: 1.2, hz: dd / 2, rot: 0 });
      }
    }
    // Контейнеры в порту.
    if (b.district === 'port' && b.special !== 'warehouse') this.containerYard(d, b.inner, b.buildings.map((p) => p.bounds), rng);
  }

  /** Штабеля контейнеров на свободной площади. */
  private containerYard(d: ChunkData, area: Rect, avoid: Rect[], rng: RNG) {
    const cols = [0xb8442c, 0x2c6cb8, 0x2f8f4e, 0xd09a2a, 0x8a8f94, 0x6b2e86, 0xc7c2b6, 0x1f5f6b];
    const L = 12.2, W = 2.5, H = 2.6;
    for (let z = area.z0 + 3; z + W * 3 < area.z1 - 3; z += W * 3 + 5) {
      for (let x = area.x0 + 3; x + L < area.x1 - 3; x += L + 1.5) {
        const r: Rect = { x0: x - 1, z0: z - 1, x1: x + L + 1, z1: z + W * 3 + 1 };
        if (avoid.some((a) => !(r.x1 < a.x0 || r.x0 > a.x1 || r.z1 < a.z0 || r.z0 > a.z1))) continue;
        if (!rng.chance(0.75)) continue;
        for (let row = 0; row < 3; row++) {
          const stack = rng.int(1, 4);
          for (let k = 0; k < stack; k++) {
            d.facade.setColor(rng.pick(cols));
            d.facade.setAttr(3, 0.35, 8, 7);
            d.facade.box(x + L / 2, SIDEWALK_H + k * H, z + W / 2 + row * W, L, H - 0.02, W - 0.05, 0);
          }
          d.colliders.push({ x: x + L / 2, y: SIDEWALK_H + (stack * H) / 2, z: z + W / 2 + row * W, hx: L / 2, hy: (stack * H) / 2, hz: W / 2 - 0.03, rot: 0 });
        }
      }
    }
  }

  /** Причалы: портальные краны, кнехты, контейнеры. */
  private portProps(def: ChunkDef, d: ChunkData, rng: RNG) {
    for (const pier of PIERS) {
      const cx = (pier.x0 + pier.x1) / 2, cz = (pier.z0 + pier.z1) / 2;
      if (!inRect(def.rect, cx, cz)) continue;
      // Портальный кран у торца причала.
      const kx = pier.x1 - 40;
      d.facade.setColor(rng.pick([0xd86a1f, 0x2a6fb5, 0xc9a21e]));
      d.facade.setAttr(4, 3, 3, 8);
      for (const oz of [-12, 12]) for (const ox of [-8, 8]) {
        d.facade.box(kx + ox, 0, cz + oz, 1.6, 32, 1.6, 0);
        d.colliders.push({ x: kx + ox, y: 16, z: cz + oz, hx: 0.8, hy: 16, hz: 0.8, rot: 0 });
      }
      d.facade.box(kx + 14, 32, cz, 70, 3, 26, 0);
      d.facade.box(kx, 24, cz - 12, 18, 1.2, 1.2, 0);
      d.facade.box(kx, 24, cz + 12, 18, 1.2, 1.2, 0);
      d.facade.setColor(0x30343a);
      d.facade.box(kx + 30, 29, cz, 5, 3, 4, 0);
      d.beacons.push(kx + 48, 35.5, cz, kx - 20, 35.5, cz);
      // Кнехты по краю.
      d.facade.setColor(0x26282a);
      for (let x = pier.x0 + 10; x < pier.x1; x += 14) {
        d.facade.prism(x, 0, pier.z0 + 0.8, 0.35, 8, 0.8, 0);
        d.facade.prism(x, 0, pier.z1 - 0.8, 0.35, 8, 0.8, 0);
      }
      this.containerYard(d, { x0: pier.x0 + 15, z0: pier.z0 + 6, x1: kx - 15, z1: pier.z1 - 6 }, [], rng);
      // Бетонные борта причала до воды.
      d.facade.setColor(0x55575a); d.facade.setAttr(4, 3, 3, 9);
      d.facade.box(cx, -9, cz, pier.x1 - pier.x0, 9, pier.z1 - pier.z0, 0, false);
    }
    // Набережная: стенка вдоль восточного края.
    if (inRect(def.rect, CITY_RECT.x1, (def.rect.z0 + def.rect.z1) / 2)) {
      const z0 = Math.max(def.rect.z0, CITY_RECT.z0), z1 = Math.min(def.rect.z1, CITY_RECT.z1);
      if (z1 > z0) {
        d.facade.setColor(0x55575a); d.facade.setAttr(4, 3, 3, 9);
        d.facade.box(CITY_RECT.x1 + 0.5, -9, (z0 + z1) / 2, 1, 9, z1 - z0, 0, false);
        d.facade.setColor(0x26282a);
        for (let z = z0 + 5; z < z1; z += 16) d.facade.prism(CITY_RECT.x1 - 0.6, 0, z, 0.3, 8, 0.8, 0);
      }
    }
    // Пляж: зонтики и вышки спасателей.
    if (def.rect.z1 > CITY_RECT.z1 && def.rect.z0 < CITY_RECT.z1 + 100) {
      for (let x = Math.max(def.rect.x0, CITY_RECT.x0) + 10; x < Math.min(def.rect.x1, CITY_RECT.x1); x += 26) {
        const z = CITY_RECT.z1 + 30 + rng.range(-6, 10);
        const y = this.terrain.groundHeight(x, z);
        if (y < -0.5) continue;
        if (rng.chance(0.08)) {
          d.facade.setColor(0xd9d2c0); d.facade.setAttr(4, 3, 3, 10);
          for (const [ox, oz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) d.facade.box(x + ox, y, z + oz, 0.2, 3, 0.2, 0);
          d.facade.setColor(0xc23a2a);
          d.facade.box(x, y + 3, z, 3, 2.2, 3, 0);
          d.facade.gable(x, y + 5.2, z, 3, 3, 1, 0);
          continue;
        }
        d.facade.setColor(0xe8e2d4); d.facade.setAttr(4, 3, 3, 10);
        d.facade.prism(x, y, z, 0.05, 5, 2.3, 0);
        d.facade.setColor(rng.pick([0xd8443a, 0x2f86c9, 0xf0c23a, 0x46b06a]));
        d.facade.prism(x, y + 2.0, z, 1.6, 8, 0.6, 0, false, 0.92);
      }
    }
  }

  // --- Деревья ----------------------------------------------------------------
  tree(d: ChunkData, x: number, y: number, z: number, s: number, kind: 'pine' | 'oak' | 'palm', rot: number) {
    const gb = d.facade;
    gb.setAttr(4, 3, 3, 11);
    const fb = d.foliage;
    const base = fb.vertexCount;
    if (kind === 'oak') {
      gb.setColor(0x4a3626);
      gb.prism(x, y, z, 0.17 * s, 6, 3.2 * s, rot, false, 0.3);
      const g = new THREE.Color().setHSL(0.22 + hash2(Math.round(x), Math.round(z), 1) * 0.08, 0.45, 0.2 + hash2(Math.round(z), Math.round(x), 2) * 0.08);
      fb.setColor(g);
      for (const [ox, oy, oz, sc] of [[0, 4.4, 0, 2.4], [0.6, 5.5, 0.3, 1.8]] as const) {
        _m.compose(_p.set(x + ox * s, y + oy * s, z + oz * s), _q.setFromEuler(_e.set(0, rot, 0)), _s.setScalar(sc * s));
        fb.addGeometry(TEMPLATES.blob, _m);
      }
    } else if (kind === 'pine') {
      gb.setColor(0x3e2c20);
      gb.prism(x, y, z, 0.22 * s, 6, 3 * s, rot, false, 0.3);
      fb.setColor(new THREE.Color(0.08, 0.17, 0.08).multiplyScalar(0.8 + 0.4 * hash2(Math.round(x), Math.round(z), 4)));
      for (const [oy, r, h] of [[2.2, 2.6, 4.2], [4.6, 2.0, 3.6], [6.7, 1.3, 3.0]] as const) {
        _m.compose(_p.set(x, y + (oy + h / 2) * s, z), _q.setFromEuler(_e.set(0, rot, 0)), _s.set(r * s, h * s, r * s));
        fb.addGeometry(TEMPLATES.cone, _m);
      }
    } else {
      // Пальма: изогнутый ствол из сегментов и поникшие листья.
      gb.setColor(0x7a6248);
      const lean = 0.18;
      let px = x, pz = z, py = y;
      const dx = Math.cos(rot), dz = Math.sin(rot);
      for (let k = 0; k < 5; k++) {
        const h = 1.6 * s;
        gb.prism(px, py, pz, (0.22 - k * 0.02) * s, 6, h, 0, false, 0.05);
        px += dx * lean * k * 0.5; pz += dz * lean * k * 0.5; py += h;
      }
      fb.setColor(new THREE.Color(0.14, 0.3, 0.1));
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + rot;
        _m.compose(_p.set(px, py, pz), _q.setFromEuler(_e.set(0.45, a, 0, 'YXZ')), _s.set(s, s, s * 1.1));
        fb.addGeometry(TEMPLATES.frond, _m);
      }
    }
    // uv.y = высота над основанием (для покачивания в шейдере листвы).
    for (let v = base; v < fb.vertexCount; v++) fb.uv[v * 2 + 1] = fb.pos[v * 3 + 1] - y;
  }
}
