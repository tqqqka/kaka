/**
 * Городской трафик: машины едут по полосам графа дорог (кинематика, дёшево),
 * поворачивают на перекрёстках по кривым Безье, соблюдают светофоры и дистанцию,
 * тормозят перед пешеходами и игроком, сигналят. При ДТП с игроком машина
 * переходит в полноценную физику Rapier.
 */
import * as THREE from 'three';
import type { Game, GameModule } from '../game/Game';
import type { REdge } from '../world/RoadGraph';
import type { Vehicle } from '../entities/Vehicle';
import type { VehicleKind } from '../render/VehicleModels';
import { clamp, dampAngle } from '../core/MathUtil';
import { CITY_RECT } from '../world/CityLayout';

export interface TrafficAI {
  kind: 'traffic';
  edge: REdge;
  lane: number;
  s: number;
  turn: { pts: number[]; cum: number[]; len: number; s: number; next: REdge; nextLane: number } | null;
  speed: number;
  maxSpeed: number;
  hasDriver: boolean;
  crashed: boolean;
  waitT: number;
  hornCd: number;
  yaw: number;
  panic: number;
}

const KINDS: [VehicleKind, number][] = [['sedan', 36], ['taxi', 12], ['suv', 16], ['van', 10], ['sport', 7], ['muscle', 8], ['police', 3], ['moto', 5]];
const _p = [0, 0, 0, 0];
const _v = new THREE.Vector3();

export class Traffic implements GameModule {
  cars: Vehicle[] = [];
  max = 16;
  private spawnCd = 0;

  constructor(private game: Game) {
    game.engine.presetListeners.push((p) => (this.max = p.trafficCount));
    this.max = game.engine.preset.trafficCount;
  }

  private pickKind(): VehicleKind {
    const total = KINDS.reduce((a, k) => a + k[1], 0);
    let r = Math.random() * total;
    for (const [k, w] of KINDS) { r -= w; if (r <= 0) return k; }
    return 'sedan';
  }

  update(dt: number) {
    const g = this.game;
    const pp = g.player.vehicle ? g.player.vehicle.position() : g.player.char.pos;
    // Чистка.
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const v = this.cars[i];
      const d = v.position(_v).distanceTo(pp);
      const removed = !g.vehicles.list.includes(v);
      if (removed || v.playerDriving || (d > 320 && !v.persistent)) {
        this.cars.splice(i, 1);
        if (!removed && !v.playerDriving) g.vehicles.remove(v);
        else if (v.ai && (v.ai as TrafficAI).kind === 'traffic' && v.playerDriving) v.ai = null;
      }
    }
    // Спавн.
    this.spawnCd -= dt;
    if (this.cars.length < this.max && this.spawnCd <= 0 && g.state === 'playing') {
      this.spawnCd = 0.25;
      this.trySpawn(pp);
    }
    for (const v of this.cars) this.drive(v, dt, pp);
  }

  private trySpawn(center: THREE.Vector3) {
    const g = this.game;
    const graph = g.world.graph;
    const cam = g.engine.camera;
    const camDir = g.cameraRig.aimDir;
    for (let attempt = 0; attempt < 6; attempt++) {
      const e = graph.edges[Math.floor(Math.random() * graph.edges.length)];
      const na = graph.nodes[e.a];
      const d = Math.hypot(na.x - center.x, na.z - center.z);
      if (d > 260 || d < 70) continue;
      const lane = Math.floor(Math.random() * e.lanes);
      const s = e.trimA + Math.random() * Math.max(1, e.len - e.trimA - e.trimB);
      graph.lanePoint(e, s, lane, _p);
      // Не спавнить в поле зрения рядом.
      const to = _v.set(_p[0] - cam.position.x, 0, _p[1] - cam.position.z);
      const dist = to.length();
      if (dist < 140 && to.normalize().dot(_v.set(camDir.x, 0, camDir.z).normalize()) > 0.4) continue;
      // Свободно ли место.
      let free = true;
      for (const o of g.vehicles.list) {
        const op = o.position();
        if (Math.hypot(op.x - _p[0], op.z - _p[1]) < 14) { free = false; break; }
      }
      if (!free) continue;
      const y = this.roadY(e, _p[0], _p[1]);
      const kind = this.pickKind();
      const yaw = Math.atan2(_p[2], _p[3]);
      const v = g.vehicles.spawn(kind, new THREE.Vector3(_p[0], y, _p[1]), yaw, { kinematic: true });
      const ai: TrafficAI = { kind: 'traffic', edge: e, lane, s, turn: null, speed: 6, maxSpeed: e.speed * (0.8 + Math.random() * 0.3), hasDriver: true, crashed: false, waitT: 0, hornCd: 0, yaw, panic: 0 };
      v.ai = ai;
      v.engineOn = true;
      if (kind === 'police') v.tag = 'patrol';
      this.cars.push(v);
      return;
    }
  }

  private roadY(e: REdge, x: number, z: number) {
    if (e.axis === 'c') return this.game.world.terrain.groundHeight(x, z) + 0.12;
    return 0.02;
  }

  /** Расстояние до препятствия впереди по полосе. */
  private gapAhead(v: Vehicle, ai: TrafficAI, px: number, pz: number, dx: number, dz: number): number {
    const g = this.game;
    let gap = 60;
    const half = v.spec.half[2];
    for (const o of g.vehicles.list) {
      if (o === v) continue;
      const op = o.position(_v);
      const rx = op.x - px, rz = op.z - pz;
      const along = rx * dx + rz * dz;
      if (along < 0 || along > 60) continue;
      const lat = Math.abs(rx * dz - rz * dx);
      if (lat > 2.3) continue;
      gap = Math.min(gap, along - half - o.spec.half[2]);
    }
    for (const c of g.characters) {
      if (c.vehicle || !c.visible) continue;
      const rx = c.pos.x - px, rz = c.pos.z - pz;
      const along = rx * dx + rz * dz;
      if (along < 0 || along > 30) continue;
      const lat = Math.abs(rx * dz - rz * dx);
      if (lat > 1.8) continue;
      gap = Math.min(gap, along - half - 1.5);
      if (c === g.player.char && along < 14 && ai.hornCd <= 0 && ai.speed < 1) {
        ai.hornCd = 3 + Math.random() * 3;
        g.audio.horn(v.position());
      }
    }
    return gap;
  }

  private drive(v: Vehicle, dt: number, center: THREE.Vector3) {
    const ai = v.ai as TrafficAI | null;
    if (!ai || ai.kind !== 'traffic') return;
    const g = this.game;
    const graph = g.world.graph;
    ai.hornCd -= dt;
    // Переход в физику: близкий контакт с машиной игрока или повреждение.
    if (v.kinematic) {
      const pv = g.player.vehicle;
      if (pv && !pv.kinematic) {
        const a = v.position(), b = pv.position();
        const reach = v.spec.half[2] + pv.spec.half[2] + 1.2;
        if (a.distanceTo(b) < reach) {
          const rel = pv.linvel().sub(v.forward().multiplyScalar(ai.speed)).length();
          if (rel > 2.5) { v.setKinematic(false); ai.crashed = true; }
        }
      }
      if (v.health < v.maxHealth * 0.97 && !ai.crashed) {
        // Обстрел: водитель в панике жмёт газ.
        ai.panic = 8;
      }
      // Взрыв/огонь — машина становится физической.
      if (v.destroyed || v.burnT >= 0) { v.setKinematic(false); ai.crashed = true; }
    }
    if (!v.kinematic) {
      if (!ai.crashed) ai.crashed = true;
      v.ctl.throttle = 0; v.ctl.brake = 1;
      return;
    }
    ai.panic = Math.max(0, ai.panic - dt);
    // --- Текущая точка и направление ---
    let px: number, pz: number, dx: number, dz: number;
    if (ai.turn) {
      const t = ai.turn;
      const k = this.sampleTurn(t, t.s);
      px = k[0]; pz = k[1]; dx = k[2]; dz = k[3];
    } else {
      graph.lanePoint(ai.edge, ai.s, ai.lane, _p);
      px = _p[0]; pz = _p[1]; dx = _p[2]; dz = _p[3];
    }
    // --- Желаемая скорость ---
    let target = ai.maxSpeed * (ai.panic > 0 ? 1.4 : 1);
    if (ai.turn) target = Math.min(target, 7.5);
    const gap = this.gapAhead(v, ai, px, pz, dx, dz);
    target = Math.min(target, Math.sqrt(Math.max(0, 2 * 6 * (gap - 3))));
    // Светофор.
    if (!ai.turn && ai.panic <= 0) {
      const e = ai.edge;
      const stopS = e.len - e.trimB - 1;
      const toStop = stopS - ai.s;
      if (toStop > -0.5 && toStop < 45) {
        const node = graph.nodes[e.b];
        const st = graph.lightState(node, e.axis, g.time);
        if (st === 'r' || (st === 'y' && toStop > 8)) target = Math.min(target, Math.sqrt(Math.max(0, 2 * 5 * Math.max(0, toStop))));
      }
    }
    // Плавный разгон/торможение.
    const acc = target > ai.speed ? 3.2 : -9;
    ai.speed = clamp(ai.speed + acc * dt, 0, Math.max(target, 0));
    if (target < ai.speed) ai.speed = Math.max(target, ai.speed - 9 * dt);
    ai.waitT = ai.speed < 0.3 ? ai.waitT + dt : 0;
    // --- Продвижение ---
    let adv = ai.speed * dt;
    if (ai.turn) {
      ai.turn.s += adv;
      if (ai.turn.s >= ai.turn.len) {
        adv = ai.turn.s - ai.turn.len;
        ai.edge = ai.turn.next;
        ai.lane = ai.turn.nextLane;
        ai.s = ai.edge.trimA + adv;
        ai.turn = null;
      }
    } else {
      ai.s += adv;
      if (ai.s >= ai.edge.len - ai.edge.trimB) this.startTurn(ai);
    }
    // Позиция и курс.
    if (ai.turn) {
      const k = this.sampleTurn(ai.turn, ai.turn.s);
      px = k[0]; pz = k[1]; dx = k[2]; dz = k[3];
    } else {
      graph.lanePoint(ai.edge, ai.s, ai.lane, _p);
      px = _p[0]; pz = _p[1]; dx = _p[2]; dz = _p[3];
    }
    ai.yaw = dampAngle(ai.yaw, Math.atan2(dx, dz), 10, dt);
    const y = ai.turn ? this.roadY(ai.turn.next, px, pz) : this.roadY(ai.edge, px, pz);
    v.moveKinematic(px, y, pz, ai.yaw, ai.speed, dt);
    v.ctl.brake = target < ai.speed - 0.5 || ai.speed < 0.5 ? 1 : 0;
    // Застрял надолго (пробка/игрок мешает) — объезжает перестроением.
    if (ai.waitT > 6 && ai.edge.lanes > 1 && !ai.turn) {
      ai.lane = (ai.lane + 1) % ai.edge.lanes;
      ai.waitT = 0;
    }
    void center;
  }

  /** Выбор следующего ребра и кривая поворота. */
  private startTurn(ai: TrafficAI) {
    const graph = this.game.world.graph;
    const e = ai.edge;
    const node = graph.nodes[e.b];
    let options = node.out.filter((id) => id !== e.reverse).map((id) => graph.edges[id]);
    // Не уезжать из города по тупиковому серпантину слишком часто.
    if (options.length === 0) options = [graph.edges[e.reverse]];
    // Прямо — чаще.
    const weights = options.map((o) => {
      const cross = e.axis === o.axis ? 3 : 1;
      return cross * (o.axis === 'c' ? 0.3 : 1);
    });
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    let next = options[0];
    for (let i = 0; i < options.length; i++) { r -= weights[i]; if (r <= 0) { next = options[i]; break; } }
    const nextLane = Math.min(ai.lane, next.lanes - 1);
    const a = graph.lanePoint(e, e.len - e.trimB, ai.lane, [0, 0, 0, 0]);
    const b = graph.lanePoint(next, next.trimA, nextLane, [0, 0, 0, 0]);
    // Контрольная точка — пересечение направлений (или середина при развороте).
    let cx = (a[0] + b[0]) / 2, cz = (a[1] + b[1]) / 2;
    const den = a[2] * b[3] - a[3] * b[2];
    if (Math.abs(den) > 0.1) {
      const t = ((b[0] - a[0]) * b[3] - (b[1] - a[1]) * b[2]) / den;
      cx = a[0] + a[2] * t; cz = a[1] + a[3] * t;
    } else if (a[2] * b[2] + a[3] * b[3] < 0) {
      // Разворот: выносим контрольную точку вперёд.
      cx += a[2] * 8; cz += a[3] * 8;
    }
    const pts: number[] = [];
    const cum: number[] = [0];
    const N = 10;
    for (let i = 0; i <= N; i++) {
      const t = i / N, u = 1 - t;
      pts.push(u * u * a[0] + 2 * u * t * cx + t * t * b[0], u * u * a[1] + 2 * u * t * cz + t * t * b[1]);
      if (i > 0) cum.push(cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]));
    }
    ai.turn = { pts, cum, len: cum[N], s: 0, next, nextLane };
  }

  private _k = [0, 0, 0, 0];
  private sampleTurn(t: NonNullable<TrafficAI['turn']>, s: number): number[] {
    const { pts, cum } = t;
    s = clamp(s, 0, t.len);
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const f = (s - cum[i - 1]) / Math.max(1e-5, cum[i] - cum[i - 1]);
    const x0 = pts[i * 2 - 2], z0 = pts[i * 2 - 1], x1 = pts[i * 2], z1 = pts[i * 2 + 1];
    let dx = x1 - x0, dz = z1 - z0;
    const L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    this._k[0] = x0 + (x1 - x0) * f; this._k[1] = z0 + (z1 - z0) * f; this._k[2] = dx; this._k[3] = dz;
    return this._k;
  }

  /** Убрать весь трафик (новая игра/телепорт). */
  clearAll() {
    for (const v of this.cars) this.game.vehicles.remove(v);
    this.cars.length = 0;
  }

  static inCity(x: number, z: number) {
    return x > CITY_RECT.x0 && x < CITY_RECT.x1 && z > CITY_RECT.z0 && z < CITY_RECT.z1;
  }
}
