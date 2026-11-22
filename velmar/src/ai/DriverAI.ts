/**
 * ИИ водителя для физических машин (полиция в погоне, беглецы в миссиях, соперники в гонках):
 * рулит к цели, обходит стены по трём лучам, сдаёт назад, если застрял.
 */
import * as THREE from 'three';
import { G_STATIC, G_VEHICLE } from '../core/Physics';
import { clamp } from '../core/MathUtil';
import type { Vehicle } from '../entities/Vehicle';
import type { Game } from '../game/Game';

const _l = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class DriverAI {
  stuckT = 0;
  reverseT = 0;
  /** Множитель «агрессивности» (скорость в поворотах). */
  skill = 1;

  constructor(private game: Game, readonly v: Vehicle) {}

  /** Вести машину к точке с желаемой скоростью. */
  driveTo(target: THREE.Vector3, desired: number, dt: number) {
    const v = this.v;
    const c = v.ctl;
    if (v.destroyed) { c.throttle = 0; c.brake = 1; return; }
    const pos = v.position();
    _l.copy(target).sub(pos).applyQuaternion(v.quaternion(_q).invert());
    const dist = Math.hypot(_l.x, _l.z);
    let ang = Math.atan2(_l.x, _l.z); // + — цель слева
    // Обход препятствий.
    const f = v.forward();
    const look = clamp(Math.abs(v.speed) * 0.9, 8, 26);
    const o = pos.clone().setY(pos.y + 0.8);
    const ray = (a: number) => {
      const d = f.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
      const h = this.game.physics.raycast(o, d, look, G_STATIC | G_VEHICLE, v.body);
      return h ? h.dist : look;
    };
    const dl = ray(0.42), dr = ray(-0.42), dc = ray(0);
    if (dc < look * 0.7 || dl < look * 0.5 || dr < look * 0.5) ang += (dl - dr) / look * 0.9;
    // Задний ход при застревании.
    if (this.reverseT > 0) {
      this.reverseT -= dt;
      c.throttle = -1;
      c.brake = 0;
      c.steer = -Math.sign(ang) || 1;
      c.handbrake = false;
      return;
    }
    if (Math.abs(v.speed) < 1.2 && c.throttle > 0.5) this.stuckT += dt;
    else this.stuckT = Math.max(0, this.stuckT - dt * 2);
    if (this.stuckT > 1.4) { this.stuckT = 0; this.reverseT = 1.3; }
    c.steer = clamp(ang * 1.8, -1, 1);
    // Цель сзади — разворот.
    const behind = Math.abs(ang) > 2.2 && dist < 30;
    let want = desired;
    if (Math.abs(ang) > 0.6) want = Math.min(want, 13 * this.skill);
    if (dc < 10 && Math.abs(v.speed) > 8) want = Math.min(want, 6);
    if (behind) want = 7;
    if (v.speed < want - 1) { c.throttle = 1; c.brake = 0; }
    else if (v.speed > want + 3) { c.throttle = 0; c.brake = clamp((v.speed - want) / 10, 0.2, 1); }
    else { c.throttle = 0.35; c.brake = 0; }
    c.handbrake = Math.abs(ang) > 1.2 && v.speed > 12;
  }

  private path: number[] = [];
  private pathIdx = 0;
  private pathT = 0;
  private pathTarget = new THREE.Vector3();

  /**
   * Умное вождение: вблизи и при прямой видимости — напрямую, иначе — по графу дорог (A*).
   */
  driveSmart(target: THREE.Vector3, desired: number, dt: number) {
    const v = this.v;
    const g = this.game;
    const pos = v.position();
    const d = pos.distanceTo(target);
    this.pathT -= dt;
    const los = d < 55 && g.physics.lineOfSight(pos.clone().setY(pos.y + 1), target.clone().setY(target.y + 1));
    if (los) { this.path = []; this.driveTo(target, desired, dt); return; }
    const graph = g.world.graph;
    if (this.pathT <= 0 || this.path.length === 0 || this.pathTarget.distanceTo(target) > 40) {
      this.pathT = 2.5;
      this.pathTarget.copy(target);
      const a = graph.nearestNode(pos.x, pos.z), b = graph.nearestNode(target.x, target.z);
      this.path = graph.findPath(a.id, b.id);
      this.pathIdx = 0;
      // Пропускаем узел, если он позади.
      if (this.path.length > 1) {
        const n0 = graph.nodes[this.path[0]], n1 = graph.nodes[this.path[1]];
        const f = v.forward();
        if ((n0.x - pos.x) * f.x + (n0.z - pos.z) * f.z < 0 && Math.hypot(n1.x - pos.x, n1.z - pos.z) < Math.hypot(n1.x - n0.x, n1.z - n0.z) + 10) this.pathIdx = 1;
      }
    }
    if (this.pathIdx >= this.path.length) { this.driveTo(target, desired, dt); return; }
    const n = graph.nodes[this.path[this.pathIdx]];
    // Цель — центр перекрёстка со смещением в правый ряд по направлению движения.
    const next = this.pathIdx + 1 < this.path.length ? graph.nodes[this.path[this.pathIdx + 1]] : null;
    const wp = new THREE.Vector3(n.x, pos.y, n.z);
    if (next) {
      const dx = next.x - n.x, dz = next.z - n.z, L = Math.hypot(dx, dz) || 1;
      wp.x += (-dz / L) * 3.2; wp.z += (dx / L) * 3.2;
    }
    if (Math.hypot(wp.x - pos.x, wp.z - pos.z) < 11) this.pathIdx++;
    const turnSoon = next ? 18 : desired;
    const dn = Math.hypot(wp.x - pos.x, wp.z - pos.z);
    this.driveTo(wp, dn < 35 ? Math.min(desired, turnSoon) : desired, dt);
  }

  stop() {
    const c = this.v.ctl;
    c.throttle = 0;
    c.brake = 1;
    c.steer = 0;
    c.handbrake = true;
  }
}
