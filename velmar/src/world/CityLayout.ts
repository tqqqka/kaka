/**
 * Раскладка города Порт-Вельмар: сетка улиц, районы, кварталы, участки,
 * планы зданий (ярусы, силуэты, крыши), ключевые места и граф дорог для ИИ.
 *
 * Мир (метры): X — восток, Z — юг, Y — вверх.
 *   Сетка улиц: x ∈ [-1000, 1000], z ∈ [-800, 800], шаг 100 м.
 *   Север (z < -811) — холмы с серпантином; юг (z > 811) — пляж и море;
 *   восток (x > 1007) — море и причалы порта; запад (x < -1011) — пригородные поля.
 */
import { RNG, hash2, clamp, fbm2, smoothstep } from '../core/MathUtil';

export const GRID = { x0: -1000, z0: -800, nx: 20, nz: 16, S: 100 } as const;
export const WATER_Y = -1.0;
export const SIDEWALK_H = 0.15;
export const SIDEWALK_W = 4.5;
export const LANE_W = 3.5;
export const WORLD_HALF = 1600;

export type District =
  | 'downtown' | 'residential' | 'suburb' | 'industrial' | 'port'
  | 'park' | 'beach' | 'construction' | 'plaza';

export interface Rect { x0: number; z0: number; x1: number; z1: number }

/** Ярус здания: ящик или призма. Стиль фасада: 0 стекло, 1 офис, 2 жилой, 3 промышленный, 4 глухой, 5 дом. */
export interface Tier {
  kind: 'box' | 'prism';
  cx: number; cz: number;
  w: number; d: number; // для box
  r: number; sides: number; taper: number; // для prism
  rot: number;
  y0: number; h: number;
  style: number;
  color: number;
  cellW: number; cellH: number;
}

export type RoofKind = 'antenna' | 'helipad' | 'ac' | 'tank' | 'crown' | 'spire' | 'billboard' | 'gable' | 'pyramid' | 'parapet' | 'chimney';
export interface RoofFeature { kind: RoofKind; x: number; y: number; z: number; w: number; d: number; h: number; rot: number }

export interface BuildingPlan {
  id: number;
  seed: number;
  district: District;
  tiers: Tier[];
  roof: RoofFeature[];
  /** Точки крепления неоновых вывесок (на уровне улицы). */
  signs: { x: number; y: number; z: number; nx: number; nz: number; w: number }[];
  height: number;
  bounds: Rect;
  landmark?: string;
  /** Светящиеся рёбра небоскрёба ночью. */
  edgeLights: boolean;
}

export interface Block extends Rect {
  bx: number; bz: number; id: number;
  district: District;
  inner: Rect;
  /** Тип покрытия внутреннего участка для дорожного шейдера: 4 газон, 5 площадь, 6 бетон, 7 грунт. */
  groundType: number;
  buildings: BuildingPlan[];
  /** Деревья во дворе/парке. */
  trees: { x: number; z: number; s: number }[];
  special?: string;
}

/** Ключевые места: магазины, убежище, больница, точки миссий. */
export interface Place { id: string; name: string; x: number; z: number; icon: string; color: string }

// ---------------------------------------------------------------------------
// Геометрия сетки
// ---------------------------------------------------------------------------
export const lineX = (i: number) => GRID.x0 + i * GRID.S;
export const lineZ = (j: number) => GRID.z0 + j * GRID.S;
/** Полуширина вертикальной (вдоль Z) улицы на линии i. Западная — шоссе. */
export const hwX = (i: number) => (i === 0 ? 11 : 7);
/** Полуширина горизонтальной (вдоль X) улицы на линии j. Северная и южная — шоссе. */
export const hwZ = (j: number) => (j === 0 || j === GRID.nz ? 11 : 7);
export const lanesX = (i: number) => (i === 0 ? 3 : 2);
export const lanesZ = (j: number) => (j === 0 || j === GRID.nz ? 3 : 2);
export const isHighwayX = (i: number) => i === 0;
export const isHighwayZ = (j: number) => j === 0 || j === GRID.nz;

export const CITY_RECT: Rect = { x0: lineX(0) - hwX(0), z0: lineZ(0) - hwZ(0), x1: lineX(GRID.nx) + hwX(GRID.nx), z1: lineZ(GRID.nz) + hwZ(GRID.nz) };

/** Причалы порта (бетонные платформы над водой). */
export const PIERS: Rect[] = [-450, -150, 150, 450].map((z) => ({ x0: CITY_RECT.x1 - 1, z0: z - 30, x1: 1240, z1: z + 30 }));

export function inRect(r: Rect, x: number, z: number, pad = 0) {
  return x >= r.x0 - pad && x <= r.x1 + pad && z >= r.z0 - pad && z <= r.z1 + pad;
}

// ---------------------------------------------------------------------------
// Районы
// ---------------------------------------------------------------------------
const SPECIAL_BLOCKS: Record<string, [number, number]> = {
  spire: [10, 6],
  garage: [6, 10],
  gunshop: [8, 11],
  paint1: [5, 5],
  paint2: [15, 9],
  hospital: [12, 3],
  police: [8, 4],
  bus: [4, 13],
  warehouse: [18, 7],
  construction: [13, 4],
  park1: [11, 10],
  park2: [12, 10],
  plaza: [9, 7],
  park3: [6, 3],
};

export function districtOf(bx: number, bz: number): District {
  for (const [key, [sx, sz]] of Object.entries(SPECIAL_BLOCKS)) {
    if (sx === bx && sz === bz) {
      if (key.startsWith('park')) return 'park';
      if (key === 'construction') return 'construction';
      if (key === 'plaza') return 'plaza';
    }
  }
  const cx = lineX(bx) + GRID.S / 2, cz = lineZ(bz) + GRID.S / 2;
  if (bx >= 17) return 'port';
  if (bx >= 15) return 'industrial';
  if (bx <= 3) return 'suburb';
  if (bz === GRID.nz - 1) return 'beach';
  if (Math.abs(cx - 20) < 330 && cz > -390 && cz < 250) return 'downtown';
  return 'residential';
}

export const DISTRICT_NAMES: Record<District, string> = {
  downtown: 'Стеклянный Шпиль',
  residential: 'Кирпичный квартал',
  suburb: 'Сосновая Гряда',
  industrial: 'Ржавый Пояс',
  port: 'Доки Вельмара',
  park: 'Центральный парк',
  beach: 'Солнечный Берег',
  construction: 'Стройка «Горизонт»',
  plaza: 'Площадь Основателей',
};

const PALETTES: Record<string, number[]> = {
  downtown: [0x8d8f93, 0xa7a49c, 0x6f747a, 0xbab3a6, 0x5d6168, 0x9aa0a8, 0xc9c2b4, 0x4e5257],
  residential: [0x9a5a44, 0xb07a5a, 0xc9b28c, 0xd8c7a6, 0x8c4c3c, 0xa69886, 0xc4a07a, 0x7b6a5c, 0xd9a77a],
  suburb: [0xe6dcc6, 0xc7d6dc, 0xe8cfc0, 0xd6dfc6, 0xf0e6d0, 0xbfc9d6, 0xe3c9a8],
  industrial: [0x7b7f80, 0x6c7a86, 0x8a6e5a, 0x9b9a92, 0x5f6b6b],
  port: [0x6d7780, 0x8a5a45, 0x5c6a7d, 0x9a9488],
  beach: [0xf1e6d2, 0xe8d0b0, 0xd5e6e6, 0xf3d7c4, 0xe0e8d8],
};

// ---------------------------------------------------------------------------
// Рельеф за пределами сетки (детерминированная функция высоты)
// ---------------------------------------------------------------------------
/** Опорные точки серпантина на холмы (от северного шоссе к вершине). */
export const HILL_ROAD: [number, number][] = [
  [-300, -811], [-300, -870], [-330, -940], [-270, -1010], [-140, -1040], [-20, -1070],
  [60, -1130], [20, -1190], [-90, -1230], [-150, -1290], [-90, -1350], [20, -1380], [110, -1360],
];
export const HILL_ROAD_HW = 6;

let _hillPath: [number, number][] | null = null;
/** Сглаженный (Catmull-Rom) путь серпантина с шагом ~step м. */
export function hillRoadPath(step = 6): [number, number][] {
  if (_hillPath) return _hillPath;
  const P = HILL_ROAD;
  const out: [number, number][] = [];
  for (let k = 0; k < P.length - 1; k++) {
    const p0 = P[Math.max(0, k - 1)], p1 = P[k], p2 = P[k + 1], p3 = P[Math.min(P.length - 1, k + 2)];
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const n = Math.max(2, Math.ceil(segLen / step));
    for (let q = 0; q < n; q++) {
      const t = q / n, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(P[P.length - 1]);
  _hillPath = out;
  return out;
}

/** «Сырая» высота рельефа без учёта дороги. */
export function rawHeight(x: number, z: number): number {
  const C = CITY_RECT;
  const dxW = C.x0 - x; // >0 западнее города
  const dxE = x - C.x1; // >0 восточнее
  const dzN = C.z0 - z; // >0 севернее
  const dzS = z - C.z1; // >0 южнее
  let h = 0;
  // Холмы на севере.
  if (dzN > 0) {
    const ridge = 0.6 + 0.4 * fbm2(x * 0.0016 + 3.1, z * 0.0016, 4, 7);
    const rise = smoothstep(0, 520, dzN);
    h += rise * (40 + 150 * ridge) * smoothstep(0, 60, dzN);
    h += (fbm2(x * 0.01, z * 0.01, 3, 11) - 0.5) * 8 * smoothstep(0, 80, dzN);
  }
  // Пологие холмы на западе.
  if (dxW > 0) {
    h = Math.max(h, smoothstep(0, 260, dxW) * (8 + 28 * fbm2(x * 0.003, z * 0.003, 3, 5)) * smoothstep(0, 40, dxW));
  }
  // Пляж и море на юге.
  if (dzS > 0) {
    let b: number;
    if (dzS < 20) b = 0;
    else if (dzS < 75) b = -(dzS - 20) * 0.018;
    else b = -1 - (dzS - 75) * 0.07;
    b = Math.max(b, -9);
    h = Math.min(h, b);
    if (dxW > 0 || dzS > 0) h = Math.min(h, b + (h > 0 ? 0 : 0));
  }
  // Море на востоке: набережная обрывается сразу.
  if (dxE > 0) {
    const sea = -9;
    h = Math.min(h, h + (sea - h) * smoothstep(0, 14, dxE));
    if (dzN > 0) h = Math.max(sea, h);
  }
  // Край мира уходит под воду (остров), кроме холмов.
  const edge = Math.max(Math.abs(x), Math.abs(z));
  if (edge > WORLD_HALF - 250 && dzN <= 300) h = Math.min(h, h + (-9 - h) * smoothstep(WORLD_HALF - 250, WORLD_HALF - 60, edge));
  return h;
}

// ---------------------------------------------------------------------------
// Генерация города
// ---------------------------------------------------------------------------
export class CityLayout {
  readonly blocks: Block[] = [];
  readonly buildings: BuildingPlan[] = [];
  readonly places: Place[] = [];
  private blockGrid: (Block | null)[][] = [];
  private nextId = 1;

  constructor(readonly seed = 1337) {
    for (let bx = 0; bx < GRID.nx; bx++) {
      this.blockGrid[bx] = [];
      for (let bz = 0; bz < GRID.nz; bz++) {
        const b = this.makeBlock(bx, bz);
        this.blocks.push(b);
        this.blockGrid[bx][bz] = b;
      }
    }
    this.makePlaces();
  }

  blockAt(x: number, z: number): Block | null {
    const bx = Math.floor((x - GRID.x0) / GRID.S);
    const bz = Math.floor((z - GRID.z0) / GRID.S);
    if (bx < 0 || bz < 0 || bx >= GRID.nx || bz >= GRID.nz) return null;
    const b = this.blockGrid[bx][bz];
    return b && inRect(b, x, z) ? b : null;
  }

  blockByIndex(bx: number, bz: number) {
    return this.blockGrid[bx]?.[bz] ?? null;
  }

  specialBlock(key: string): Block {
    const [bx, bz] = SPECIAL_BLOCKS[key];
    return this.blockGrid[bx][bz]!;
  }

  private makeBlock(bx: number, bz: number): Block {
    const x0 = lineX(bx) + hwX(bx), x1 = lineX(bx + 1) - hwX(bx + 1);
    const z0 = lineZ(bz) + hwZ(bz), z1 = lineZ(bz + 1) - hwZ(bz + 1);
    const district = districtOf(bx, bz);
    const inner = { x0: x0 + SIDEWALK_W, z0: z0 + SIDEWALK_W, x1: x1 - SIDEWALK_W, z1: z1 - SIDEWALK_W };
    const groundType = district === 'park' || district === 'suburb' ? 4
      : district === 'construction' ? 7
      : district === 'port' || district === 'industrial' ? 6
      : district === 'plaza' || district === 'downtown' ? 5 : 4;
    const block: Block = { x0, z0, x1, z1, bx, bz, id: bx * 100 + bz, district, inner, groundType, buildings: [], trees: [] };
    for (const [key, [sx, sz]] of Object.entries(SPECIAL_BLOCKS)) if (sx === bx && sz === bz) block.special = key;
    const rng = new RNG(this.seed * 7919 + bx * 131 + bz * 977);
    this.fillBlock(block, rng);
    return block;
  }

  // --- Заполнение квартала по району ---------------------------------------
  private fillBlock(b: Block, rng: RNG) {
    const I = b.inner;
    switch (b.district) {
      case 'downtown': {
        if (b.special === 'spire') { this.spire(b, rng); break; }
        const lots = this.subdivide(I, rng, 34, rng.int(1, 3));
        for (const lot of lots) this.tower(b, lot, rng);
        break;
      }
      case 'residential':
      case 'beach': {
        if (b.special === 'garage') this.garage(b, rng);
        const lots = this.subdivide(I, rng, 24, rng.int(2, 4));
        for (const lot of lots) {
          if (b.special === 'garage' && lot.x0 < I.x0 + 40 && lot.z1 > I.z1 - 40) continue;
          if (rng.chance(0.12) && b.district === 'residential') { this.yardTrees(b, lot, rng); continue; }
          this.midrise(b, lot, rng);
        }
        break;
      }
      case 'suburb': {
        // Сетка домиков с двориками.
        const nx = 4, nz = 3;
        const lw = (I.x1 - I.x0) / nx, ld = (I.z1 - I.z0) / nz;
        for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
          if (j === 1 && i > 0 && i < nx - 1) continue; // общий двор
          const lot = { x0: I.x0 + i * lw, z0: I.z0 + j * ld, x1: I.x0 + (i + 1) * lw, z1: I.z0 + (j + 1) * ld };
          this.house(b, lot, rng, j === 0 ? -1 : 1);
        }
        for (let k = 0; k < 10; k++) b.trees.push({ x: rng.range(I.x0 + 3, I.x1 - 3), z: rng.range(I.z0 + ld + 3, I.z1 - ld - 3), s: rng.range(0.8, 1.3) });
        break;
      }
      case 'industrial': {
        const lots = this.subdivide(I, rng, 30, 2);
        for (const lot of lots) this.warehouse(b, lot, rng, rng.chance(0.4));
        break;
      }
      case 'port': {
        if (b.special === 'warehouse') {
          this.warehouse(b, { x0: I.x0 + 6, z0: I.z0 + 10, x1: I.x1 - 6, z1: I.z1 - 30 }, rng, false, 'warehouse');
          break;
        }
        const lots = this.subdivide(I, rng, 34, 1);
        for (const lot of lots) if (rng.chance(0.6)) this.warehouse(b, lot, rng, false);
        break;
      }
      case 'park': {
        for (let k = 0; k < 40; k++) {
          const x = rng.range(I.x0 + 3, I.x1 - 3), z = rng.range(I.z0 + 3, I.z1 - 3);
          // Аллея крест-накрест остаётся свободной.
          if (Math.abs(x - (I.x0 + I.x1) / 2) < 5 || Math.abs(z - (I.z0 + I.z1) / 2) < 5) continue;
          b.trees.push({ x, z, s: rng.range(0.9, 1.6) });
        }
        break;
      }
      case 'plaza': {
        // Площадь с монументом в центре.
        const cx = (I.x0 + I.x1) / 2, cz = (I.z0 + I.z1) / 2;
        const p = this.newPlan(b, 'plaza', rng);
        p.tiers.push(this.boxTier(cx, cz, 10, 10, 0, SIDEWALK_H, 2.5, 4, 0x8d8a84));
        p.tiers.push(this.prismTier(cx, cz, 2.2, 8, SIDEWALK_H + 2.5, 22, 4, 0xa49e90, 0.5));
        p.landmark = 'monument';
        this.finishPlan(b, p);
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2;
          b.trees.push({ x: cx + Math.cos(a) * 30, z: cz + Math.sin(a) * 30, s: 1.1 });
        }
        break;
      }
      case 'construction': {
        const cx = (I.x0 + I.x1) / 2, cz = (I.z0 + I.z1) / 2;
        const p = this.newPlan(b, 'construction', rng);
        // Недостроенный каркас: ядро и перекрытия.
        p.tiers.push(this.boxTier(cx, cz, 14, 14, 0, SIDEWALK_H, 64, 4, 0x8f8b84));
        for (let f = 0; f < 8; f++) p.tiers.push(this.boxTier(cx, cz, 40, 32, 0, SIDEWALK_H + 4 + f * 7.5, 0.6, 4, 0x9b968c));
        for (const [ox, oz] of [[-19, -15], [19, -15], [-19, 15], [19, 15], [0, -15], [0, 15]]) {
          p.tiers.push(this.boxTier(cx + ox, cz + oz, 1.2, 1.2, 0, SIDEWALK_H, 4 + 7 * 7.5 + 0.6, 4, 0x8a857c));
        }
        p.roof.push({ kind: 'spire', x: cx + 26, y: SIDEWALK_H, z: cz - 26, w: 2.4, d: 2.4, h: 80, rot: 0 }); // башенный кран (стрела строится в генераторе)
        p.landmark = 'construction';
        this.finishPlan(b, p);
        break;
      }
    }
  }

  /** Рекурсивное деление участка на лоты. */
  private subdivide(r: Rect, rng: RNG, minSize: number, depth: number): Rect[] {
    const w = r.x1 - r.x0, d = r.z1 - r.z0;
    if (depth <= 0 || (w < minSize * 2 && d < minSize * 2)) return [r];
    const alongX = w >= d ? w >= minSize * 2 : d < minSize * 2;
    const t = rng.range(0.38, 0.62);
    if (alongX) {
      const m = r.x0 + w * t;
      return [...this.subdivide({ ...r, x1: m }, rng, minSize, depth - 1), ...this.subdivide({ ...r, x0: m }, rng, minSize, depth - 1)];
    }
    const m = r.z0 + d * t;
    return [...this.subdivide({ ...r, z1: m }, rng, minSize, depth - 1), ...this.subdivide({ ...r, z0: m }, rng, minSize, depth - 1)];
  }

  private newPlan(b: Block, district: District, rng: RNG): BuildingPlan {
    return {
      id: this.nextId++, seed: rng.int(1, 9999), district, tiers: [], roof: [], signs: [], height: 0,
      bounds: { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity }, edgeLights: false,
    };
  }

  private finishPlan(b: Block, p: BuildingPlan) {
    for (const t of p.tiers) {
      const ext = t.kind === 'box' ? Math.hypot(t.w, t.d) / 2 : t.r;
      p.bounds.x0 = Math.min(p.bounds.x0, t.cx - ext);
      p.bounds.x1 = Math.max(p.bounds.x1, t.cx + ext);
      p.bounds.z0 = Math.min(p.bounds.z0, t.cz - ext);
      p.bounds.z1 = Math.max(p.bounds.z1, t.cz + ext);
      p.height = Math.max(p.height, t.y0 + t.h);
    }
    b.buildings.push(p);
    this.buildings.push(p);
  }

  private boxTier(cx: number, cz: number, w: number, d: number, rot: number, y0: number, h: number, style: number, color: number, cellW = 3.2, cellH = 3.6): Tier {
    return { kind: 'box', cx, cz, w, d, r: 0, sides: 4, taper: 0, rot, y0, h, style, color, cellW, cellH };
  }

  private prismTier(cx: number, cz: number, r: number, sides: number, y0: number, h: number, style: number, color: number, taper = 0, cellW = 3.0, cellH = 3.6): Tier {
    return { kind: 'prism', cx, cz, w: r * 2, d: r * 2, r, sides, taper, rot: 0, y0, h, style, color, cellW, cellH };
  }

  /** Добавляет точки для вывесок на фасадах, обращённых к улице. */
  private addSigns(b: Block, p: BuildingPlan, x0: number, z0: number, x1: number, z1: number, rng: RNG, y = 4.6) {
    const I = b.inner;
    const sides: [number, number, number, number, number][] = [];
    if (z1 > I.z1 - 3) sides.push([(x0 + x1) / 2, z1 + 0.25, 0, 1, x1 - x0]);
    if (z0 < I.z0 + 3) sides.push([(x0 + x1) / 2, z0 - 0.25, 0, -1, x1 - x0]);
    if (x1 > I.x1 - 3) sides.push([x1 + 0.25, (z0 + z1) / 2, 1, 0, z1 - z0]);
    if (x0 < I.x0 + 3) sides.push([x0 - 0.25, (z0 + z1) / 2, -1, 0, z1 - z0]);
    for (const [x, z, nx, nz, len] of sides) {
      if (!rng.chance(0.55) || len < 8) continue;
      const off = rng.range(-len * 0.3, len * 0.3);
      p.signs.push({ x: x + (nz !== 0 ? off : 0), y, z: z + (nx !== 0 ? off : 0), nx, nz, w: Math.min(len * 0.5, rng.range(4, 8)) });
    }
  }

  // --- Типы зданий ----------------------------------------------------------
  /** Небоскрёб делового центра: случайный силуэт. */
  private tower(b: Block, lot: Rect, rng: RNG) {
    const p = this.newPlan(b, 'downtown', rng);
    const pad = rng.range(1.0, 3.5);
    const x0 = lot.x0 + pad, x1 = lot.x1 - pad, z0 = lot.z0 + pad, z1 = lot.z1 - pad;
    const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const dist = Math.hypot(cx - 30, cz + 80);
    const H = clamp(50 + 210 * Math.exp(-dist / 230) * rng.range(0.55, 1.15) + rng.range(-10, 25), 35, 260);
    const color = rng.pick(PALETTES.downtown);
    const style = rng.chance(0.55) ? 0 : 1;
    const cw = style === 0 ? rng.range(1.6, 2.6) : rng.range(2.8, 3.8);
    const ch = rng.range(3.4, 4.1);
    const y = SIDEWALK_H;
    const type = rng.int(0, 5);
    const minWD = Math.min(w, d);
    if (type === 0) {
      // Уступы (setback).
      let tw = w, td = d, ty = y, remaining = H;
      const n = rng.int(2, 4);
      for (let k = 0; k < n; k++) {
        const th = k === n - 1 ? remaining : remaining * rng.range(0.35, 0.55);
        p.tiers.push(this.boxTier(cx, cz, tw, td, 0, ty, th, style, color, cw, ch));
        ty += th; remaining -= th;
        tw *= rng.range(0.7, 0.85); td *= rng.range(0.7, 0.85);
      }
    } else if (type === 1) {
      // Подиум + башня.
      const ph = rng.range(10, 18);
      p.tiers.push(this.boxTier(cx, cz, w, d, 0, y, ph, 1, rng.pick(PALETTES.downtown), 3.6, ch));
      const tw = w * rng.range(0.5, 0.7), td = d * rng.range(0.5, 0.7);
      p.tiers.push(this.boxTier(cx + rng.range(-1, 1) * (w - tw) / 2, cz + rng.range(-1, 1) * (d - td) / 2, tw, td, 0, y + ph, H - ph, style, color, cw, ch));
    } else if (type === 2) {
      // Цилиндрическая башня с короной.
      const r = minWD / 2;
      const sides = rng.pick([12, 16, 20]);
      p.tiers.push(this.prismTier(cx, cz, r, sides, y, H * 0.82, style, color, 0, cw, ch));
      p.tiers.push(this.prismTier(cx, cz, r * 0.8, sides, y + H * 0.82, H * 0.18, style, color, 0.1, cw, ch));
    } else if (type === 3) {
      // Восьмигранник с сужением.
      p.tiers.push(this.prismTier(cx, cz, minWD / 2 * 1.05, 8, y, H, style, color, rng.range(0.15, 0.35), cw, ch));
      p.tiers[0].rot = Math.PI / 8;
    } else if (type === 4) {
      // Закрученная башня: ярусы с поворотом.
      const n = rng.int(5, 9);
      const s = minWD / (Math.SQRT2 * 1.02);
      let rot = 0;
      for (let k = 0; k < n; k++) {
        p.tiers.push(this.boxTier(cx, cz, s, s, rot, y + (H / n) * k, H / n, style, color, cw, ch));
        rot += rng.range(0.08, 0.16);
      }
    } else {
      // Башни-близнецы со скайбриджем.
      const along = w > d;
      const tw = along ? w * 0.4 : w, td = along ? d : d * 0.4;
      const o = along ? w * 0.3 : d * 0.3;
      const h2 = H * rng.range(0.8, 1.0);
      p.tiers.push(this.boxTier(along ? cx - o : cx, along ? cz : cz - o, tw, td, 0, y, H, style, color, cw, ch));
      p.tiers.push(this.boxTier(along ? cx + o : cx, along ? cz : cz + o, tw, td, 0, y, h2, style, color, cw, ch));
      p.tiers.push(this.boxTier(cx, cz, along ? w * 0.3 : td * 0.6, along ? td * 0.6 : d * 0.3, 0, y + h2 * 0.6, 8, 0, 0x5a6470, 2, 4));
    }
    // Крыша.
    const top = p.tiers.reduce((a, t) => (t.y0 + t.h > a.y0 + a.h ? t : a), p.tiers[0]);
    const ty = top.y0 + top.h;
    const tw = top.kind === 'box' ? top.w : top.r * 1.2;
    const roofRoll = rng.next();
    if (top.kind === 'box') p.roof.push({ kind: 'parapet', x: top.cx, y: ty, z: top.cz, w: top.w, d: top.d, h: 1.2, rot: top.rot });
    if (roofRoll < 0.25) p.roof.push({ kind: 'antenna', x: top.cx, y: ty, z: top.cz, w: 0.8, d: 0.8, h: rng.range(15, 40), rot: 0 });
    else if (roofRoll < 0.4 && top.kind === 'box') p.roof.push({ kind: 'pyramid', x: top.cx, y: ty, z: top.cz, w: top.w * 0.9, d: top.d * 0.9, h: tw * 0.5, rot: top.rot });
    else if (roofRoll < 0.55) p.roof.push({ kind: 'crown', x: top.cx, y: ty, z: top.cz, w: tw * 0.9, d: tw * 0.9, h: rng.range(4, 9), rot: top.rot });
    else if (roofRoll < 0.7 && H < 140) p.roof.push({ kind: 'billboard', x: top.cx, y: ty, z: top.cz, w: Math.min(tw * 0.8, 18), d: 0.6, h: 6, rot: rng.chance(0.5) ? 0 : Math.PI / 2 });
    for (let k = 0; k < rng.int(1, 4); k++) {
      p.roof.push({ kind: rng.chance(0.7) ? 'ac' : 'tank', x: top.cx + rng.range(-0.3, 0.3) * tw, y: ty, z: top.cz + rng.range(-0.3, 0.3) * tw, w: rng.range(2, 4), d: rng.range(2, 4), h: rng.range(1.5, 3), rot: top.rot });
    }
    p.edgeLights = H > 90 && rng.chance(0.5);
    this.addSigns(b, p, x0, z0, x1, z1, rng, rng.range(5, 7));
    this.finishPlan(b, p);
  }

  /** Шпиль Сабурова — самый высокий небоскрёб с вертолётной площадкой (финал). */
  private spire(b: Block, rng: RNG) {
    const I = b.inner;
    const cx = (I.x0 + I.x1) / 2, cz = (I.z0 + I.z1) / 2;
    const p = this.newPlan(b, 'downtown', rng);
    const y = SIDEWALK_H;
    p.tiers.push(this.boxTier(cx, cz, 70, 70, 0, y, 16, 1, 0x6b7077, 4, 4));
    p.tiers.push(this.prismTier(cx, cz, 26, 8, y + 16, 150, 0, 0x3e4650, 0.12, 2, 3.8));
    p.tiers[1].rot = Math.PI / 8;
    p.tiers.push(this.prismTier(cx, cz, 21, 8, y + 166, 90, 0, 0x3e4650, 0.18, 2, 3.8));
    p.tiers[2].rot = Math.PI / 8;
    p.tiers.push(this.prismTier(cx, cz, 16.5, 8, y + 256, 34, 0, 0x2f363e, 0.05, 2, 3.8));
    p.tiers[3].rot = Math.PI / 8;
    p.roof.push({ kind: 'helipad', x: cx, y: y + 290, z: cz, w: 26, d: 26, h: 0.8, rot: 0 });
    p.roof.push({ kind: 'antenna', x: cx + 12, y: y + 290, z: cz + 12, w: 1.2, d: 1.2, h: 30, rot: 0 });
    p.landmark = 'spire';
    p.edgeLights = true;
    this.finishPlan(b, p);
  }

  /** Жилой дом средней этажности. */
  private midrise(b: Block, lot: Rect, rng: RNG) {
    const p = this.newPlan(b, b.district, rng);
    const pad = rng.range(0.5, 3);
    const x0 = lot.x0 + pad, x1 = lot.x1 - pad, z0 = lot.z0 + pad, z1 = lot.z1 - pad;
    const w = x1 - x0, d = z1 - z0;
    if (w < 8 || d < 8) return;
    const floors = b.district === 'beach' ? rng.int(3, 9) : rng.int(3, 11);
    const fh = rng.range(3.0, 3.4);
    const H = floors * fh;
    const pal = b.district === 'beach' ? PALETTES.beach : PALETTES.residential;
    const color = rng.pick(pal);
    const style = rng.chance(0.75) ? 2 : 1;
    p.tiers.push(this.boxTier((x0 + x1) / 2, (z0 + z1) / 2, w, d, 0, SIDEWALK_H, H, style, color, rng.range(2.6, 3.4), fh));
    if (rng.chance(0.35) && floors > 5) {
      p.tiers.push(this.boxTier((x0 + x1) / 2, (z0 + z1) / 2, w * 0.6, d * 0.6, 0, SIDEWALK_H + H, fh * 2, style, color, 3, fh));
    }
    const top = p.tiers[p.tiers.length - 1];
    p.roof.push({ kind: 'parapet', x: top.cx, y: top.y0 + top.h, z: top.cz, w: top.w, d: top.d, h: 0.9, rot: 0 });
    if (rng.chance(0.5)) p.roof.push({ kind: 'tank', x: top.cx + rng.range(-0.25, 0.25) * top.w, y: top.y0 + top.h, z: top.cz + rng.range(-0.25, 0.25) * top.d, w: 2.5, d: 2.5, h: 3.5, rot: 0 });
    if (rng.chance(0.6)) p.roof.push({ kind: 'ac', x: top.cx, y: top.y0 + top.h, z: top.cz, w: 2.5, d: 1.8, h: 1.4, rot: 0 });
    this.addSigns(b, p, x0, z0, x1, z1, rng);
    this.finishPlan(b, p);
  }

  /** Частный дом с двускатной крышей. side — с какой стороны улица (-1 север, 1 юг). */
  private house(b: Block, lot: Rect, rng: RNG, side: number) {
    const p = this.newPlan(b, 'suburb', rng);
    const cx = (lot.x0 + lot.x1) / 2 + rng.range(-2, 2);
    const cz = (lot.z0 + lot.z1) / 2 + side * 2;
    const w = rng.range(10, 14), d = rng.range(8, 11);
    const floors = rng.chance(0.4) ? 2 : 1;
    const H = floors * 3.0;
    const color = rng.pick(PALETTES.suburb);
    p.tiers.push(this.boxTier(cx, cz, w, d, 0, SIDEWALK_H, H, 5, color, 3.2, 3.0));
    p.roof.push({ kind: 'gable', x: cx, y: SIDEWALK_H + H, z: cz, w, d, h: rng.range(2.2, 3.4), rot: 0 });
    if (rng.chance(0.5)) p.roof.push({ kind: 'chimney', x: cx + w * 0.25, y: SIDEWALK_H + H, z: cz - d * 0.15, w: 0.9, d: 0.9, h: 3.8, rot: 0 });
    // Гараж-пристройка.
    if (rng.chance(0.5)) p.tiers.push(this.boxTier(cx + w / 2 + 3, cz, 6, 7, 0, SIDEWALK_H, 2.8, 4, 0xd8d2c4, 3, 3));
    this.finishPlan(b, p);
    b.trees.push({ x: lot.x0 + 3, z: (lot.z0 + lot.z1) / 2 - side * 6, s: rng.range(0.8, 1.2) });
  }

  /** Склад/цех. */
  private warehouse(b: Block, lot: Rect, rng: RNG, chimney: boolean, landmark?: string) {
    const p = this.newPlan(b, b.district, rng);
    const pad = rng.range(2, 5);
    const x0 = lot.x0 + pad, x1 = lot.x1 - pad, z0 = lot.z0 + pad, z1 = lot.z1 - pad;
    const w = x1 - x0, d = z1 - z0;
    if (w < 10 || d < 10) return;
    const H = rng.range(8, 15);
    const color = rng.pick(b.district === 'port' ? PALETTES.port : PALETTES.industrial);
    p.tiers.push(this.boxTier((x0 + x1) / 2, (z0 + z1) / 2, w, d, 0, SIDEWALK_H, H, 3, color, rng.range(3.5, 5), 4.5));
    p.roof.push({ kind: 'parapet', x: (x0 + x1) / 2, y: SIDEWALK_H + H, z: (z0 + z1) / 2, w, d, h: 0.6, rot: 0 });
    for (let k = 0; k < 3; k++) p.roof.push({ kind: 'ac', x: x0 + w * rng.range(0.2, 0.8), y: SIDEWALK_H + H, z: z0 + d * rng.range(0.2, 0.8), w: 3, d: 3, h: 1.6, rot: 0 });
    if (chimney) p.tiers.push(this.prismTier(x0 + 4, z0 + 4, 1.8, 10, SIDEWALK_H, H + rng.range(15, 30), 4, 0x7a5a4a, 0.25));
    if (rng.chance(0.4)) p.tiers.push(this.prismTier(x1 - 5, z1 - 5, 4, 14, SIDEWALK_H, rng.range(10, 16), 4, 0xa8aeb0, 0));
    if (landmark) p.landmark = landmark;
    this.finishPlan(b, p);
  }

  /** Мастерская Нины: убежище игрока (сохранение, ремонт, апгрейды). */
  private garage(b: Block, rng: RNG) {
    const I = b.inner;
    const p = this.newPlan(b, 'residential', rng);
    const x0 = I.x0 + 2, z1 = I.z1 - 2;
    p.tiers.push(this.boxTier(x0 + 16, z1 - 13, 32, 26, 0, SIDEWALK_H, 7.5, 3, 0x6b5848, 4.5, 3.6));
    p.roof.push({ kind: 'billboard', x: x0 + 16, y: SIDEWALK_H + 7.5, z: z1 - 4, w: 14, d: 0.5, h: 3, rot: 0 });
    p.landmark = 'garage';
    this.finishPlan(b, p);
  }

  private yardTrees(b: Block, lot: Rect, rng: RNG) {
    for (let k = 0; k < 4; k++) b.trees.push({ x: rng.range(lot.x0 + 3, lot.x1 - 3), z: rng.range(lot.z0 + 3, lot.z1 - 3), s: rng.range(0.9, 1.4) });
  }

  // --- Ключевые места ----------------------------------------------------------
  private makePlaces() {
    const front = (key: string, dx = 0.5, side: 'n' | 's' | 'e' | 'w' = 's'): [number, number] => {
      const b = this.specialBlock(key);
      if (side === 's') return [b.x0 + (b.x1 - b.x0) * dx, b.z1 + 2];
      if (side === 'n') return [b.x0 + (b.x1 - b.x0) * dx, b.z0 - 2];
      if (side === 'e') return [b.x1 + 2, b.z0 + (b.z1 - b.z0) * dx];
      return [b.x0 - 2, b.z0 + (b.z1 - b.z0) * dx];
    };
    const add = (id: string, name: string, p: [number, number], icon: string, color: string) => this.places.push({ id, name, x: p[0], z: p[1], icon, color });
    const gb = this.specialBlock('garage');
    add('garage', 'Мастерская Нины', [gb.inner.x0 + 18, gb.z1 + 2], 'G', '#57e38a');
    add('gunshop', 'Оружейная «Калибр»', front('gunshop', 0.5, 's'), '⌖', '#ff6b4a');
    add('paint1', 'Покраска «Хамелеон»', front('paint1', 0.5, 'e'), 'P', '#c07bff');
    add('paint2', 'Покраска «Хамелеон-2»', front('paint2', 0.5, 'n'), 'P', '#c07bff');
    add('hospital', 'Больница Св. Марка', front('hospital', 0.5, 's'), '+', '#ff4d6a');
    add('police', 'Полицейский участок', front('police', 0.5, 's'), '★', '#4d8bff');
    add('bus', 'Автовокзал', front('bus', 0.5, 'n'), 'B', '#cfcfcf');
    add('warehouse', 'Склад №7', front('warehouse', 0.5, 'w'), 'W', '#ffd24a');
    add('spire', 'Шпиль Сабурова', front('spire', 0.5, 's'), 'S', '#ffd24a');
    add('construction', 'Стройка «Горизонт»', front('construction', 0.5, 'w'), 'C', '#ffd24a');
    add('villa', 'Вилла Барона', [60, -1365], 'V', '#ffd24a');
    add('marina', 'Причал', [1120, 185], '⚓', '#3be0ff');
    add('helipad', 'Вертолётная площадка', [1180, -150], 'H', '#3be0ff');
  }

  place(id: string): Place {
    const p = this.places.find((q) => q.id === id);
    if (!p) throw new Error('нет места ' + id);
    return p;
  }

  /** Является ли точка проезжей частью (дорогой/перекрёстком) внутри сетки. */
  isRoad(x: number, z: number): boolean {
    if (!inRect(CITY_RECT, x, z)) return false;
    return this.blockAt(x, z) === null;
  }

  /** Высота поверхности тротуара/дороги внутри города (без учёта рельефа). */
  citySurface(x: number, z: number): number | null {
    if (!inRect(CITY_RECT, x, z)) {
      for (const p of PIERS) if (inRect(p, x, z)) return 0;
      return null;
    }
    return this.blockAt(x, z) ? SIDEWALK_H : 0;
  }

  /** Стабильная псевдослучайная величина для позиции (для пропсов). */
  static jitter(x: number, z: number, s = 0) {
    return hash2(Math.floor(x), Math.floor(z), s);
  }
}
