/**
 * Граф дорог: перекрёстки (узлы) и участки дорог (направленные рёбра с полосами).
 * Используется ИИ-трафиком (движение по полосам, светофоры) и GPS (поиск пути A*).
 * Движение правостороннее.
 */
import {
  GRID, HILL_ROAD, HILL_ROAD_HW, hillRoadPath, LANE_W, hwX, hwZ, lanesX, lanesZ, lineX, lineZ, isHighwayX, isHighwayZ,
} from './CityLayout';

export interface RNode {
  id: number;
  x: number; z: number;
  /** Полуразмеры перекрёстка по X и Z. */
  ex: number; ez: number;
  i: number; j: number;
  out: number[];
  light: boolean;
  phase: number;
}

export interface REdge {
  id: number;
  a: number; b: number;
  /** Осевая линия от a к b (x,z попарно). */
  pts: Float32Array;
  /** Накопленная длина по точкам. */
  cum: Float32Array;
  len: number;
  lanes: number;
  /** Смещение первой полосы от оси (у шоссе есть разделитель). */
  median: number;
  axis: 'x' | 'z' | 'c';
  speed: number;
  highway: boolean;
  /** Отступ от начала/конца (размер перекрёстка) — стоп-линии. */
  trimA: number; trimB: number;
  reverse: number;
}

export type LightColor = 'g' | 'y' | 'r';
export const LIGHT_CYCLE = 30;

export class RoadGraph {
  nodes: RNode[] = [];
  edges: REdge[] = [];
  private gridNode: number[][] = [];

  constructor() {
    // Узлы на всех пересечениях сетки.
    for (let i = 0; i <= GRID.nx; i++) {
      this.gridNode[i] = [];
      for (let j = 0; j <= GRID.nz; j++) {
        const n: RNode = { id: this.nodes.length, x: lineX(i), z: lineZ(j), ex: hwX(i), ez: hwZ(j), i, j, out: [], light: false, phase: ((i * 7 + j * 11) % 10) * 3 };
        this.nodes.push(n);
        this.gridNode[i][j] = n.id;
      }
    }
    // Рёбра сетки.
    for (let i = 0; i <= GRID.nx; i++) for (let j = 0; j < GRID.nz; j++) {
      const a = this.gridNode[i][j], b = this.gridNode[i][j + 1];
      this.addRoad(a, b, [lineX(i), lineZ(j), lineX(i), lineZ(j + 1)], lanesX(i), isHighwayX(i) ? 0.6 : 0, 'z', isHighwayX(i) ? 26 : 15, isHighwayX(i));
    }
    for (let j = 0; j <= GRID.nz; j++) for (let i = 0; i < GRID.nx; i++) {
      const a = this.gridNode[i][j], b = this.gridNode[i + 1][j];
      this.addRoad(a, b, [lineX(i), lineZ(j), lineX(i + 1), lineZ(j)], lanesZ(j), isHighwayZ(j) ? 0.6 : 0, 'x', isHighwayZ(j) ? 26 : 15, isHighwayZ(j));
    }
    // Серпантин на холмы (тупиковое ребро).
    const start = this.gridNode[7][0];
    const end: RNode = { id: this.nodes.length, x: HILL_ROAD[HILL_ROAD.length - 1][0], z: HILL_ROAD[HILL_ROAD.length - 1][1], ex: 8, ez: 8, i: -1, j: -1, out: [], light: false, phase: 0 };
    this.nodes.push(end);
    const pts: number[] = [];
    for (const [x, z] of hillRoadPath()) pts.push(x, z);
    this.addRoad(start, end.id, pts, 1, 0, 'c', 12, false);
    // Светофоры на перекрёстках с тремя и более дорогами (кроме чисто шоссейных узлов).
    for (const n of this.nodes) {
      const hw = (n.i === 0 || n.j === 0 || n.j === GRID.nz);
      n.light = n.out.length >= 3 && !(hw && n.out.length < 4 && (n.i === 0 || n.i === GRID.nx));
      if (n.i === GRID.nx) n.light = n.out.length >= 3;
    }
  }

  private addRoad(a: number, b: number, pts: number[], lanes: number, median: number, axis: 'x' | 'z' | 'c', speed: number, highway: boolean) {
    const mk = (from: number, to: number, p: number[]): REdge => {
      const arr = new Float32Array(p);
      const cum = new Float32Array(p.length / 2);
      for (let k = 1; k < cum.length; k++) cum[k] = cum[k - 1] + Math.hypot(arr[k * 2] - arr[k * 2 - 2], arr[k * 2 + 1] - arr[k * 2 - 1]);
      const na = this.nodes[from], nb = this.nodes[to];
      const trim = (n: RNode) => (axis === 'z' ? n.ez : axis === 'x' ? n.ex : Math.max(n.ex, n.ez)) + 1.5;
      return { id: this.edges.length, a: from, b: to, pts: arr, cum, len: cum[cum.length - 1], lanes, median, axis, speed, highway, trimA: trim(na), trimB: axis === 'c' && to === this.nodes.length - 1 ? 2 : trim(nb), reverse: -1 };
    };
    const e1 = mk(a, b, pts);
    this.edges.push(e1);
    const rev: number[] = [];
    for (let k = pts.length - 2; k >= 0; k -= 2) rev.push(pts[k], pts[k + 1]);
    const e2 = mk(b, a, rev);
    this.edges.push(e2);
    e1.reverse = e2.id;
    e2.reverse = e1.id;
    this.nodes[a].out.push(e1.id);
    this.nodes[b].out.push(e2.id);
  }

  /** Состояние светофора для движения вдоль оси axis в момент t (с). */
  lightState(node: RNode, axis: 'x' | 'z' | 'c', t: number): LightColor {
    if (!node.light || axis === 'c') return 'g';
    const ph = (t + node.phase) % LIGHT_CYCLE;
    // 0–12 зелёный по Z, 12–14 жёлтый, 14–15 все красные, 15–27 зелёный по X, 27–29 жёлтый, 29–30 красный.
    if (axis === 'z') return ph < 12 ? 'g' : ph < 14 ? 'y' : 'r';
    if (ph >= 15 && ph < 27) return 'g';
    if (ph >= 27 && ph < 29) return 'y';
    return 'r';
  }

  /**
   * Точка на полосе ребра: s — расстояние вдоль оси от начала, lane — индекс полосы
   * (0 — ближняя к осевой). Возвращает [x, z, dirX, dirZ].
   */
  lanePoint(e: REdge, s: number, lane: number, out: number[] = [0, 0, 0, 0]): number[] {
    const p = e.pts, c = e.cum;
    s = Math.max(0, Math.min(e.len, s));
    let k = 1;
    while (k < c.length - 1 && c[k] < s) k++;
    const t = (s - c[k - 1]) / Math.max(1e-6, c[k] - c[k - 1]);
    const x0 = p[k * 2 - 2], z0 = p[k * 2 - 1], x1 = p[k * 2], z1 = p[k * 2 + 1];
    let dx = x1 - x0, dz = z1 - z0;
    const L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    const off = e.median + (lane + 0.5) * LANE_W;
    // Правая сторона относительно направления движения: (-dz, dx).
    out[0] = x0 + (x1 - x0) * t + -dz * off;
    out[1] = z0 + (z1 - z0) * t + dx * off;
    out[2] = dx;
    out[3] = dz;
    return out;
  }

  /** Ближайший узел к точке (для GPS и спавна). */
  nearestNode(x: number, z: number): RNode {
    const i = Math.max(0, Math.min(GRID.nx, Math.round((x - GRID.x0) / GRID.S)));
    const j = Math.max(0, Math.min(GRID.nz, Math.round((z - GRID.z0) / GRID.S)));
    let best = this.nodes[this.gridNode[i][j]];
    let bd = Math.hypot(best.x - x, best.z - z);
    const hill = this.nodes[this.nodes.length - 1];
    const dh = Math.hypot(hill.x - x, hill.z - z);
    if (dh < bd) { best = hill; bd = dh; }
    return best;
  }

  /** Ближайшая точка на любом ребре (для трассировки GPS от точки, не лежащей на узле). */
  nearestEdge(x: number, z: number): { edge: REdge; s: number; d: number } {
    let best: { edge: REdge; s: number; d: number } = { edge: this.edges[0], s: 0, d: Infinity };
    for (const e of this.edges) {
      if (e.id % 2) continue; // каждое ребро парное — смотрим одно направление
      const p = e.pts;
      for (let k = 1; k < e.cum.length; k++) {
        const ax = p[k * 2 - 2], az = p[k * 2 - 1], bx = p[k * 2], bz = p[k * 2 + 1];
        const vx = bx - ax, vz = bz - az;
        const L2 = vx * vx + vz * vz || 1;
        let t = ((x - ax) * vx + (z - az) * vz) / L2;
        t = Math.max(0, Math.min(1, t));
        const px = ax + vx * t, pz = az + vz * t;
        const d = Math.hypot(px - x, pz - z);
        if (d < best.d) best = { edge: e, s: e.cum[k - 1] + Math.sqrt(L2) * t, d };
      }
    }
    return best;
  }

  /** A* между узлами. Возвращает список id узлов. */
  findPath(from: number, to: number): number[] {
    if (from === to) return [from];
    const N = this.nodes.length;
    const g = new Float64Array(N).fill(Infinity);
    const f = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const open: number[] = [from];
    const tgt = this.nodes[to];
    const h = (n: number) => Math.hypot(this.nodes[n].x - tgt.x, this.nodes[n].z - tgt.z);
    g[from] = 0;
    f[from] = h(from);
    while (open.length) {
      let bi = 0;
      for (let k = 1; k < open.length; k++) if (f[open[k]] < f[open[bi]]) bi = k;
      const cur = open[bi];
      open[bi] = open[open.length - 1];
      open.pop();
      if (cur === to) break;
      closed[cur] = 1;
      for (const eid of this.nodes[cur].out) {
        const e = this.edges[eid];
        if (closed[e.b]) continue;
        // Шоссе «дешевле» — GPS предпочитает быстрые дороги.
        const cost = g[cur] + e.len * (e.highway ? 0.7 : 1);
        if (cost < g[e.b]) {
          if (g[e.b] === Infinity) open.push(e.b);
          g[e.b] = cost;
          f[e.b] = cost + h(e.b);
          prev[e.b] = cur;
        }
      }
    }
    if (prev[to] === -1) return [];
    const path: number[] = [];
    for (let c = to; c !== -1; c = prev[c]) path.push(c);
    return path.reverse();
  }

  /** Полилиния маршрута по списку узлов (с изгибами серпантина). */
  pathPolyline(path: number[]): number[] {
    const out: number[] = [];
    for (let k = 0; k < path.length - 1; k++) {
      const e = this.edgeBetween(path[k], path[k + 1]);
      if (!e) continue;
      for (let q = k === 0 ? 0 : 2; q < e.pts.length; q++) out.push(e.pts[q]);
    }
    if (path.length === 1) out.push(this.nodes[path[0]].x, this.nodes[path[0]].z);
    return out;
  }

  edgeBetween(a: number, b: number): REdge | null {
    for (const eid of this.nodes[a].out) if (this.edges[eid].b === b) return this.edges[eid];
    return null;
  }

  edgeAxis(e: REdge) {
    return e.axis;
  }

  /** Дорога заблокирована для поворота? (полос нет / тупик). */
  isDeadEnd(n: RNode) {
    return n.out.length <= 1;
  }

  static get halfWidths() {
    return { hwX, hwZ };
  }

  /** Направление прибытия на узел: ось ребра у его конца. */
  arrivalAxis(e: REdge): 'x' | 'z' | 'c' {
    if (e.axis !== 'c') return e.axis;
    return 'c';
  }

  get hillRoadHalfWidth() {
    return HILL_ROAD_HW;
  }
}
