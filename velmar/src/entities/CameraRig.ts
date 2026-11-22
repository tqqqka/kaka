/**
 * Камера от третьего лица: пешком (плечо, прицел), в транспорте (следует за курсом),
 * вертолёт, катсцены (кадры с плавными переходами), тряска от взрывов.
 * Не проходит сквозь стены — луч от опоры к камере.
 */
import * as THREE from 'three';
import { G_STATIC } from '../core/Physics';
import { clamp, damp, dampAngle } from '../core/MathUtil';
import type { Game } from '../game/Game';

export interface Shot {
  from: THREE.Vector3;
  to: THREE.Vector3;
  lookFrom: THREE.Vector3;
  lookTo: THREE.Vector3;
  dur: number;
  fov?: number;
}

const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _des = new THREE.Vector3();

export class CameraRig {
  yaw = Math.PI;
  pitch = 0.22;
  private dist = 4.4;
  private shoulder = 0.45;
  private pos = new THREE.Vector3(0, 5, 0);
  private look = new THREE.Vector3();
  private shakeAmt = 0;
  private manualT = 9;
  private fov = 62;
  /** Активный кадр катсцены. */
  shot: Shot | null = null;
  private shotT = 0;
  readonly aimDir = new THREE.Vector3(0, 0, 1);

  constructor(private game: Game) {}

  shake(k: number) {
    this.shakeAmt = Math.min(1.5, this.shakeAmt + k);
  }

  playShot(s: Shot) {
    this.shot = s;
    this.shotT = 0;
  }

  endShot() {
    this.shot = null;
  }

  /** Мгновенно поставить камеру за игроком (после телепорта/катсцены). */
  snapBehind(yaw: number) {
    this.yaw = yaw;
    this.pitch = 0.2;
    this.computeDesired(_des, _pivot);
    this.pos.copy(_des);
  }

  forwardDir(out: THREE.Vector3) {
    return out.set(Math.sin(this.yaw) * Math.cos(this.pitch), -Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
  }

  private computeDesired(out: THREE.Vector3, pivot: THREE.Vector3) {
    const g = this.game;
    const pl = g.player;
    const v = pl.vehicle;
    if (v) {
      const s = v.spec;
      pivot.copy(v.position()).y += s.camHeight * 0.55 + s.colliderY * 0.5;
      this.dist = s.camDist + Math.min(4, Math.abs(v.speed) * 0.05);
      this.shoulder = 0;
    } else {
      const aiming = pl.char.model.anim.aiming;
      const crouch = pl.char.model.anim.crouch;
      pivot.copy(pl.char.pos).y += 1.6 - crouch * 0.55;
      this.dist = aiming ? 2.3 : pl.char.model.anim.swim ? 5 : 4.3;
      this.shoulder = aiming ? 0.6 : 0.42;
    }
    this.forwardDir(_dir);
    _right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    out.copy(pivot).addScaledVector(_dir, -this.dist).addScaledVector(_right, this.shoulder);
    return out;
  }

  update(dt: number) {
    const g = this.game;
    const cam = g.engine.camera;
    const inp = g.input;
    // --- Катсцена ---
    if (this.shot) {
      const s = this.shot;
      this.shotT = Math.min(1, this.shotT + dt / s.dur);
      const e = this.shotT * this.shotT * (3 - 2 * this.shotT);
      cam.position.lerpVectors(s.from, s.to, e);
      this.look.lerpVectors(s.lookFrom, s.lookTo, e);
      cam.lookAt(this.look);
      g.engine.setFov(s.fov ?? 50);
      this.pos.copy(cam.position);
      return;
    }
    const pl = g.player;
    const v = pl.vehicle;
    // --- Ввод взгляда ---
    const lx = inp.lookX, ly = inp.lookY;
    if (Math.abs(lx) + Math.abs(ly) > 0.01) this.manualT = 0;
    else this.manualT += dt;
    const heli = v?.spec.type === 'heli';
    if (!heli) this.yaw -= lx * 0.0055;
    this.pitch = clamp(this.pitch + ly * 0.0045, -0.9, 1.25);
    if (v) {
      // Камера сама разворачивается за машиной, если игрок не крутит её.
      const vel = v.linvel();
      const sp = Math.hypot(vel.x, vel.z);
      const headingYaw = sp > 3 && v.speed > 0 ? Math.atan2(vel.x, vel.z) : v.yaw;
      if (heli || this.manualT > 1.2) {
        this.yaw = dampAngle(this.yaw, headingYaw, heli ? 3 : 2.5, dt);
        this.pitch = damp(this.pitch, heli ? 0.32 : 0.17, 1.5, dt);
      }
      if (v.speed < -2 && !heli && this.manualT > 1.2) this.yaw = dampAngle(this.yaw, v.yaw, 2, dt);
    }
    this.computeDesired(_des, _pivot);
    // --- Столкновение с геометрией ---
    const toCam = _des.clone().sub(_pivot);
    const len = toCam.length();
    toCam.divideScalar(len || 1);
    const hit = g.physics.raycast(_pivot, toCam, len + 0.3, G_STATIC);
    if (hit) _des.copy(_pivot).addScaledVector(toCam, Math.max(0.6, hit.dist - 0.35));
    // Не уходить под землю.
    const ground = g.world.surfaceHeight(_des.x, _des.z) + 0.35;
    if (_des.y < ground) _des.y = ground;
    const follow = v ? 9 : 18;
    this.pos.x = damp(this.pos.x, _des.x, follow, dt);
    this.pos.y = damp(this.pos.y, _des.y, follow, dt);
    this.pos.z = damp(this.pos.z, _des.z, follow, dt);
    if (this.pos.distanceTo(_des) > 25) this.pos.copy(_des);
    cam.position.copy(this.pos);
    // Тряска.
    if (this.shakeAmt > 0.001) {
      cam.position.x += (Math.random() - 0.5) * this.shakeAmt * 0.4;
      cam.position.y += (Math.random() - 0.5) * this.shakeAmt * 0.4;
      this.shakeAmt = damp(this.shakeAmt, 0, 4, dt);
    }
    this.forwardDir(_dir);
    this.look.copy(cam.position).addScaledVector(_dir, 30);
    cam.lookAt(this.look);
    this.aimDir.copy(_dir);
    // FOV: прицел ближе, скорость — шире.
    let fov = 62;
    if (!v && pl.char.model.anim.aiming) fov = 50;
    if (v) fov = 64 + clamp(Math.abs(v.speed) - 10, 0, 40) * 0.3;
    if (!v && pl.sprinting) fov = 66;
    this.fov = damp(this.fov, fov, 5, dt);
    g.engine.setFov(this.fov);
  }
}
