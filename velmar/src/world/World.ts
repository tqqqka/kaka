/**
 * Мир: собирает раскладку города, рельеф, воду, дороги, стриминг чанков с LOD,
 * ночные огни (фонари, неон, авиационные маяки), светофоры и статические коллайдеры.
 */
import * as THREE from 'three';
import {
  CityLayout, CITY_RECT, GRID, PIERS, SIDEWALK_H, WATER_Y, hwX, hwZ, lanesX, lanesZ, lineX, lineZ,
  isHighwayX, isHighwayZ, inRect, type Rect,
} from './CityLayout';
import { RoadGraph } from './RoadGraph';
import { Terrain, createWater } from './Terrain';
import { GeomBuilder } from './GeomBuilder';
import { ChunkBuilder, CHUNK, CHUNKS, chunkOrigin, type BoxCollider, type ChunkDef, type SignalHead } from './ChunkBuilder';
import { MaterialLib, SharedUniforms } from '../render/Materials';
import { neonAtlas, poolTexture } from '../render/NeonAtlas';
import type { QualityPreset } from '../core/Quality';

interface Chunk {
  def: ChunkDef;
  lod1: THREE.Mesh | null;
  lod0: THREE.Group | null;
  colliders: BoxCollider[];
  signals: SignalHead[];
  dist: number;
}

export interface StaticCollider { kind: 'box' | 'cyl'; x: number; y: number; z: number; hx: number; hy: number; hz: number; rot: number; r?: number }

export class World {
  readonly layout = new CityLayout();
  readonly graph = new RoadGraph();
  readonly terrain = new Terrain();
  readonly group = new THREE.Group();
  private builder: ChunkBuilder;
  private chunks: Chunk[] = [];
  private detailDistance = 360;
  private propShadows = false;
  private shadowFar = 180;
  private lowDetail = false;

  readonly facadeMat: THREE.MeshStandardMaterial;
  readonly foliageMat: THREE.MeshStandardMaterial;
  readonly roadMat: THREE.MeshStandardMaterial;
  readonly lightsMat: THREE.MeshBasicMaterial;
  readonly poolsMat: THREE.MeshBasicMaterial;
  readonly neonMat: THREE.MeshBasicMaterial;
  private beacons: THREE.Points;
  private signalMesh: THREE.InstancedMesh;
  private signalCap = 900;
  readonly water: THREE.Mesh;

  /** Колбэки для физики: пропсы чанка добавились/удалились. */
  onPropColliders: ((add: BoxCollider[] | null, remove: BoxCollider[] | null) => void) | null = null;
  /** Счётчики для HUD/бенчмарка. */
  stats = { loadedChunks: 0, lod1Chunks: 0 };

  constructor(private scene: THREE.Scene) {
    this.builder = new ChunkBuilder(this.layout, this.graph, this.terrain);
    this.facadeMat = MaterialLib.std({ color: 0xffffff, vertexColors: true, roughness: 0.82, metalness: 0 }, 'facade');
    this.foliageMat = MaterialLib.std({ color: 0xffffff, vertexColors: true, roughness: 0.85, metalness: 0 }, 'foliage');
    this.roadMat = MaterialLib.std({ color: 0xffffff, roughness: 0.9, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }, 'road');
    this.lightsMat = MaterialLib.unlit({ color: 0xffffff, vertexColors: true });
    this.poolsMat = MaterialLib.unlit({
      color: 0xffffff, vertexColors: true, map: poolTexture(), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.neonMat = MaterialLib.unlit({ color: 0xffffff, vertexColors: true, map: neonAtlas(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });

    this.group.add(this.terrain.group);
    this.water = createWater();
    this.group.add(this.water);
    this.buildGround();
    this.prepareChunks();
    this.beacons = this.buildBeacons();
    this.group.add(this.beacons);

    // Лампы светофоров: один инстанс-меш на весь город, заполняется для загруженных чанков.
    const lampGeo = new THREE.CircleGeometry(0.17, 12);
    const lampMat = MaterialLib.unlit({ color: 0xffffff });
    this.signalMesh = new THREE.InstancedMesh(lampGeo, lampMat, this.signalCap);
    this.signalMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.signalCap * 3), 3);
    this.signalMesh.count = 0;
    this.signalMesh.frustumCulled = false;
    this.group.add(this.signalMesh);

    scene.add(this.group);
  }

  applyPreset(p: QualityPreset) {
    this.detailDistance = p.detailDistance;
    this.propShadows = p.propShadows;
    this.shadowFar = p.shadowFar;
    this.lowDetail = p.name === 'low';
    this.builder.lowDetail = this.lowDetail;
    for (const c of this.chunks) if (c.lod0) this.setChunkShadows(c);
  }

  // ======================================================================
  // Дороги, тротуары, кварталы (регионы 800×800 м)
  // ======================================================================
  private buildGround() {
    const regions = new Map<string, GeomBuilder>();
    const reg = (x: number, z: number) => {
      const key = `${Math.floor((x + 1600) / 800)}_${Math.floor((z + 1600) / 800)}`;
      let g = regions.get(key);
      if (!g) { g = new GeomBuilder('aRoad', 4); regions.set(key, g); }
      return g;
    };
    const Y = 0.02;
    // Перекрёстки.
    for (const n of this.graph.nodes) {
      if (n.i < 0) continue;
      const g = reg(n.x, n.z);
      g.setAttr(1, n.light ? 1 : 0, n.ex, n.ez);
      g.hRect(n.x - n.ex, n.z - n.ez, n.x + n.ex, n.z + n.ez, Y, 1, [-n.ex, -n.ez, n.ex, n.ez]);
    }
    // Улицы вдоль Z.
    for (let i = 0; i <= GRID.nx; i++) for (let j = 0; j < GRID.nz; j++) {
      const x = lineX(i), hw = hwX(i);
      const z0 = lineZ(j) + hwZ(j), z1 = lineZ(j + 1) - hwZ(j + 1);
      const g = reg(x, (z0 + z1) / 2);
      g.setAttr(isHighwayX(i) ? 3 : 0, lanesX(i), hw, 0);
      g.hRect(x - hw, z0, x + hw, z1, Y, 1, [-hw, z0, hw, z1]);
    }
    // Улицы вдоль X (uv: u поперёк = z, v вдоль = x).
    for (let j = 0; j <= GRID.nz; j++) for (let i = 0; i < GRID.nx; i++) {
      const z = lineZ(j), hw = hwZ(j);
      const x0 = lineX(i) + hwX(i), x1 = lineX(i + 1) - hwX(i + 1);
      const g = reg((x0 + x1) / 2, z);
      g.setAttr(isHighwayZ(j) ? 3 : 0, lanesZ(j), hw, 0);
      const k = g.vertex(x0, Y, z + hw, 0, 1, 0, hw, x0);
      g.vertex(x1, Y, z + hw, 0, 1, 0, hw, x1);
      g.vertex(x1, Y, z - hw, 0, 1, 0, -hw, x1);
      g.vertex(x0, Y, z - hw, 0, 1, 0, -hw, x0);
      g.idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
    }
    // Кварталы: тротуарное кольцо, бордюры и внутренний участок.
    for (const b of this.layout.blocks) {
      const g = reg((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2);
      const I = b.inner, H = SIDEWALK_H;
      g.setAttr(2, 0, 0, 0);
      g.hRect(b.x0, b.z0, b.x1, I.z0, H);
      g.hRect(b.x0, I.z1, b.x1, b.z1, H);
      g.hRect(b.x0, I.z0, I.x0, I.z1, H);
      g.hRect(I.x1, I.z0, b.x1, I.z1, H);
      // Бордюры (вертикальные грани).
      g.quad(b.x0, 0, b.z1, b.x1, 0, b.z1, b.x1, H, b.z1, b.x0, H, b.z1, 0, 0, 1, b.x0, 0, b.x1, H);
      g.quad(b.x1, 0, b.z0, b.x0, 0, b.z0, b.x0, H, b.z0, b.x1, H, b.z0, 0, 0, -1, b.x1, 0, b.x0, H);
      g.quad(b.x1, 0, b.z1, b.x1, 0, b.z0, b.x1, H, b.z0, b.x1, H, b.z1, 1, 0, 0, b.z1, 0, b.z0, H);
      g.quad(b.x0, 0, b.z0, b.x0, 0, b.z1, b.x0, H, b.z1, b.x0, H, b.z0, -1, 0, 0, b.z0, 0, b.z1, H);
      g.setAttr(b.groundType, 0, 0, 0);
      g.hRect(I.x0, I.z0, I.x1, I.z1, H + 0.005);
      if (b.district === 'park') {
        // Дорожки крест-накрест.
        g.setAttr(5, 0, 0, 0);
        const cx = (I.x0 + I.x1) / 2, cz = (I.z0 + I.z1) / 2;
        g.hRect(cx - 3, I.z0, cx + 3, I.z1, H + 0.01);
        g.hRect(I.x0, cz - 3, I.x1, cz + 3, H + 0.01);
      }
    }
    // Причалы.
    for (const p of PIERS) {
      const g = reg((p.x0 + p.x1) / 2, (p.z0 + p.z1) / 2);
      g.setAttr(6, 0, 0, 0);
      g.hRect(p.x0, p.z0, p.x1, p.z1, Y);
    }
    for (const g of regions.values()) {
      const mesh = new THREE.Mesh(g.build(), this.roadMat);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.name = 'ground';
      this.group.add(mesh);
    }
  }

  // ======================================================================
  // Чанки
  // ======================================================================
  private prepareChunks() {
    for (let cj = 0; cj < CHUNKS; cj++) for (let ci = 0; ci < CHUNKS; ci++) {
      const rect: Rect = { x0: chunkOrigin(ci), z0: chunkOrigin(cj), x1: chunkOrigin(ci) + CHUNK, z1: chunkOrigin(cj) + CHUNK };
      const inside = (x: number, z: number) => x >= rect.x0 && x < rect.x1 && z >= rect.z0 && z < rect.z1;
      const def: ChunkDef = {
        ci, cj, rect,
        buildings: this.layout.buildings.filter((b) => inside((b.bounds.x0 + b.bounds.x1) / 2, (b.bounds.z0 + b.bounds.z1) / 2)),
        blocks: this.layout.blocks.filter((b) => inside((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2)),
        trees: this.terrain.trees.filter((t) => inside(t.x, t.z)),
        hasContent: false,
      };
      const touchesCity = !(rect.x1 < CITY_RECT.x0 - 30 || rect.x0 > CITY_RECT.x1 + 260 || rect.z1 < CITY_RECT.z0 - 30 || rect.z0 > CITY_RECT.z1 + 120);
      def.hasContent = def.buildings.length > 0 || def.blocks.length > 0 || def.trees.length > 0 || touchesCity;
      if (!def.hasContent) continue;
      const c: Chunk = { def, lod1: null, lod0: null, colliders: [], signals: [], dist: Infinity };
      if (def.buildings.length) {
        const g = this.builder.buildLOD1(def);
        if (!g.isEmpty()) {
          c.lod1 = new THREE.Mesh(g.build(), this.facadeMat);
          c.lod1.matrixAutoUpdate = false;
          c.lod1.receiveShadow = true;
          c.lod1.name = `lod1_${ci}_${cj}`;
          this.group.add(c.lod1);
        }
      }
      this.chunks.push(c);
    }
  }

  private loadChunk(c: Chunk) {
    const data = this.builder.buildLOD0(c.def);
    const grp = new THREE.Group();
    grp.name = `lod0_${c.def.ci}_${c.def.cj}`;
    const add = (gb: GeomBuilder, mat: THREE.Material, shadow: boolean, name: string) => {
      if (gb.isEmpty()) return;
      const m = new THREE.Mesh(gb.build(), mat);
      m.castShadow = shadow;
      m.receiveShadow = mat !== this.lightsMat && mat !== this.neonMat && mat !== this.poolsMat;
      m.matrixAutoUpdate = false;
      m.name = name;
      grp.add(m);
    };
    add(data.facade, this.facadeMat, true, 'facade');
    add(data.foliage, this.foliageMat, this.propShadows, 'foliage');
    add(data.lights, this.lightsMat, false, 'lights');
    add(data.pools, this.poolsMat, false, 'pools');
    add(data.neon, this.neonMat, false, 'neon');
    grp.updateMatrixWorld(true);
    this.group.add(grp);
    c.lod0 = grp;
    c.colliders = data.colliders;
    c.signals = data.signals;
    if (c.lod1) c.lod1.visible = false;
    this.setChunkShadows(c);
    this.onPropColliders?.(c.colliders, null);
  }

  private setChunkShadows(c: Chunk) {
    c.lod0?.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.name === 'foliage') o.castShadow = this.propShadows;
    });
  }

  private unloadChunk(c: Chunk) {
    if (!c.lod0) return;
    c.lod0.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose(); });
    this.group.remove(c.lod0);
    c.lod0 = null;
    this.onPropColliders?.(null, c.colliders);
    c.colliders = [];
    c.signals = [];
    if (c.lod1) c.lod1.visible = true;
  }

  /** Принудительно загрузить все чанки вокруг точки (при старте/телепорте). */
  preload(x: number, z: number) {
    for (const c of this.chunks) {
      const r = c.def.rect;
      const dx = Math.max(r.x0 - x, 0, x - r.x1), dz = Math.max(r.z0 - z, 0, z - r.z1);
      if (Math.hypot(dx, dz) < Math.min(this.detailDistance, 260) && !c.lod0) this.loadChunk(c);
    }
  }

  /** Стриминг: загружает ближние чанки (не более 1 за кадр), выгружает дальние. */
  update(camPos: THREE.Vector3, time: number) {
    let best: Chunk | null = null;
    let loaded = 0, lod1 = 0;
    const camH = Math.max(0, camPos.y - 40);
    for (const c of this.chunks) {
      const r = c.def.rect;
      const dx = Math.max(r.x0 - camPos.x, 0, camPos.x - r.x1), dz = Math.max(r.z0 - camPos.z, 0, camPos.z - r.z1);
      c.dist = Math.hypot(dx, dz, camH * 0.5);
      if (c.lod0) {
        if (c.dist > this.detailDistance + 90) this.unloadChunk(c);
        else {
          loaded++;
          // В карты теней рисуем только ближние чанки.
          const castFar = c.dist < this.shadowFar + 60;
          for (const m of c.lod0.children) if (m.name === 'facade') (m as THREE.Mesh).castShadow = castFar;
        }
      } else if (c.dist < this.detailDistance && (!best || c.dist < best.dist)) best = c;
      if (c.lod1 && c.lod1.visible) lod1++;
    }
    if (best) this.loadChunk(best);
    this.stats.loadedChunks = loaded;
    this.stats.lod1Chunks = lod1;

    // Яркость ночных огней.
    const night = SharedUniforms.uNight.value;
    this.lightsMat.color.setScalar(0.25 + night * 3.0);
    this.poolsMat.opacity = night * 0.22;
    this.poolsMat.visible = night > 0.02;
    this.neonMat.color.setScalar(0.5 + night * 2.2);
    (this.beacons.material as THREE.ShaderMaterial).uniforms.uTime.value = time;
    (this.beacons.material as THREE.ShaderMaterial).uniforms.uNight.value = night;
    this.updateSignals(camPos, time);
  }

  private _lm = new THREE.Matrix4();
  private _lq = new THREE.Quaternion();
  private _lc = new THREE.Color();
  /** Обновляет лампы светофоров в загруженных чанках. */
  private updateSignals(cam: THREE.Vector3, time: number) {
    let n = 0;
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    for (const c of this.chunks) {
      if (!c.lod0 || c.dist > 320) continue;
      for (const s of c.signals) {
        if (n + 3 > this.signalCap) break;
        const st = this.graph.lightState(this.graph.nodes[s.node], s.axis, time);
        this._lq.setFromAxisAngle(up, s.ry);
        const fx = Math.sin(s.ry), fz = Math.cos(s.ry);
        for (let k = 0; k < 3; k++) {
          const y = s.y + 0.42 - k * 0.42;
          this._lm.compose(new THREE.Vector3(s.x + fx * 0.01, y, s.z + fz * 0.01), this._lq, one);
          this.signalMesh.setMatrixAt(n, this._lm);
          const on = (k === 0 && st === 'r') || (k === 1 && st === 'y') || (k === 2 && st === 'g');
          if (k === 0) this._lc.setRGB(1, 0.05, 0.03);
          else if (k === 1) this._lc.setRGB(1, 0.55, 0.02);
          else this._lc.setRGB(0.1, 1, 0.35);
          this._lc.multiplyScalar(on ? 6 : 0.06);
          this.signalMesh.setColorAt(n, this._lc);
          n++;
        }
      }
    }
    this.signalMesh.count = n;
    this.signalMesh.instanceMatrix.needsUpdate = true;
    if (this.signalMesh.instanceColor) this.signalMesh.instanceColor.needsUpdate = true;
    void cam;
  }

  // ======================================================================
  // Авиационные огни (видны издалека, мигают)
  // ======================================================================
  private buildBeacons(): THREE.Points {
    const pts: number[] = [];
    for (const p of this.layout.buildings) {
      if (p.height > 70) {
        const top = p.tiers.reduce((a, t) => (t.y0 + t.h > a.y0 + a.h ? t : a), p.tiers[0]);
        const ext = top.kind === 'box' ? Math.min(top.w, top.d) * 0.45 : top.r * 0.8;
        pts.push(top.cx + ext, top.y0 + top.h + 1.5, top.cz + ext, top.cx - ext, top.y0 + top.h + 1.5, top.cz - ext);
      }
      for (const r of p.roof) if (r.kind === 'antenna') pts.push(r.x, r.y + r.h, r.z);
    }
    for (const pier of PIERS) {
      const cz = (pier.z0 + pier.z1) / 2, kx = pier.x1 - 40;
      pts.push(kx + 48, 35.5, cz, kx - 20, 35.5, cz);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const phase = new Float32Array(pts.length / 3).map((_, i) => (i * 0.37) % 1);
    g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uNight: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float aPhase; uniform float uTime; varying float vOn;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vOn = step(0.55, fract(uTime * 0.6 + aPhase));
          gl_PointSize = clamp(900.0 / -mv.z, 2.0, 14.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uNight; varying float vOn;
        void main() {
          vec2 c = gl_PointCoord - 0.5; float d = length(c);
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vec3(1.0, 0.08, 0.05) * (0.6 + uNight * 6.0) * vOn * a, a * vOn);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const p = new THREE.Points(g, mat);
    p.frustumCulled = false;
    return p;
  }

  // ======================================================================
  // Запросы к миру
  // ======================================================================
  /** Высота поверхности (дорога/тротуар/рельеф/причал). */
  surfaceHeight(x: number, z: number): number {
    const c = this.layout.citySurface(x, z);
    if (c !== null) return c;
    return this.terrain.groundHeight(x, z);
  }

  isWater(x: number, z: number): boolean {
    return this.surfaceHeight(x, z) < WATER_Y - 0.2;
  }

  /** Все статические коллайдеры (здания, кварталы, причалы) — создаются один раз. */
  staticColliders(): StaticCollider[] {
    const out: StaticCollider[] = [];
    for (const p of this.layout.buildings) {
      for (const t of p.tiers) {
        if (t.kind === 'box') out.push({ kind: 'box', x: t.cx, y: t.y0 + t.h / 2, z: t.cz, hx: t.w / 2, hy: t.h / 2, hz: t.d / 2, rot: t.rot });
        else {
          const r = t.r * Math.cos(Math.PI / t.sides) * (1 - t.taper * 0.5);
          out.push({ kind: 'cyl', x: t.cx, y: t.y0 + t.h / 2, z: t.cz, hx: r, hy: t.h / 2, hz: r, rot: 0, r });
        }
      }
      for (const r of p.roof) {
        if (r.kind === 'gable' || r.kind === 'pyramid') out.push({ kind: 'box', x: r.x, y: r.y + r.h / 3, z: r.z, hx: r.w / 2 * 0.8, hy: r.h / 3, hz: r.d / 2 * 0.8, rot: r.rot });
        if (r.kind === 'helipad') out.push({ kind: 'cyl', x: r.x, y: r.y + r.h / 2, z: r.z, hx: r.w / 2, hy: r.h / 2, hz: r.w / 2, rot: 0, r: r.w / 2 });
        if (r.kind === 'parapet') {
          const c = Math.cos(r.rot), s = Math.sin(r.rot);
          const at = (lx: number, lz: number) => [r.x + lx * c + lz * s, r.z - lx * s + lz * c];
          for (const [lx, lz, hx, hz] of [[0, r.d / 2, r.w / 2, 0.2], [0, -r.d / 2, r.w / 2, 0.2], [r.w / 2, 0, 0.2, r.d / 2], [-r.w / 2, 0, 0.2, r.d / 2]]) {
            const q = at(lx, lz);
            out.push({ kind: 'box', x: q[0], y: r.y + r.h / 2, z: q[1], hx, hy: r.h / 2, hz, rot: r.rot });
          }
        }
        if (r.kind === 'ac' || r.kind === 'tank') out.push({ kind: 'box', x: r.x, y: r.y + (r.h + (r.kind === 'tank' ? 2 : 0)) / 2, z: r.z, hx: r.w / 2, hy: (r.h + (r.kind === 'tank' ? 2 : 0)) / 2, hz: r.d / 2, rot: r.rot });
      }
    }
    // Тротуары кварталов (бордюр 15 см).
    for (const b of this.layout.blocks) out.push({ kind: 'box', x: (b.x0 + b.x1) / 2, y: SIDEWALK_H / 2 - 0.5, z: (b.z0 + b.z1) / 2, hx: (b.x1 - b.x0) / 2, hy: SIDEWALK_H / 2 + 0.5, hz: (b.z1 - b.z0) / 2, rot: 0 });
    // Причалы.
    for (const p of PIERS) out.push({ kind: 'box', x: (p.x0 + p.x1) / 2, y: -4.5, z: (p.z0 + p.z1) / 2, hx: (p.x1 - p.x0) / 2, hy: 4.5, hz: (p.z1 - p.z0) / 2, rot: 0 });
    // Земля города.
    const C = CITY_RECT;
    out.push({ kind: 'box', x: (C.x0 + C.x1) / 2, y: -1, z: (C.z0 + C.z1) / 2, hx: (C.x1 - C.x0) / 2, hy: 1, hz: (C.z1 - C.z0) / 2, rot: 0 });
    // Стенка набережной.
    out.push({ kind: 'box', x: C.x1 + 0.5, y: -4.5, z: (C.z0 + C.z1) / 2, hx: 0.5, hy: 4.5, hz: (C.z1 - C.z0) / 2, rot: 0 });
    return out;
  }

  isInCity(x: number, z: number) {
    return inRect(CITY_RECT, x, z);
  }

  /** Отладка/HUD: название района. */
  districtName(x: number, z: number): string {
    const b = this.layout.blockAt(x, z);
    if (b) return b.district;
    if (z < CITY_RECT.z0) return 'hills';
    if (z > CITY_RECT.z1) return 'beach';
    if (x > CITY_RECT.x1) return 'port';
    return 'road';
  }
}
