/**
 * ИИ вооружённого NPC (полиция пешком, бандиты, охрана): патруль, конус зрения и
 * подозрительность (для стелс-миссий), атака с удержанием дистанции и стрейфом,
 * задержание игрока, отступление. Движение — прямое рулевое управление с обходом
 * препятствий по лучам.
 */
import * as THREE from 'three';
import { G_STATIC, G_VEHICLE } from '../core/Physics';
import { WEAPONS, type WeaponId } from '../entities/Weapons';
import { clamp, dampAngle } from '../core/MathUtil';
import type { Character } from '../entities/Character';
import type { Game } from '../game/Game';

export type ShooterMode = 'idle' | 'patrol' | 'attack' | 'arrest' | 'follow' | 'flee' | 'hold';

export interface ShooterAI {
  kind: 'shooter';
  mode: ShooterMode;
  target: Character | null;
  fireCd: number;
  accuracy: number;
  holdDist: number;
  patrol: THREE.Vector3[];
  patrolIdx: number;
  waitT: number;
  /** Для стелса: дальность и полуугол обзора, подозрительность 0..1. */
  vision: number;
  fov: number;
  suspicion: number;
  strafe: number;
  strafeT: number;
  bustT: number;
  losT: number;
  hasLos: boolean;
  /** Колбэк обнаружения игрока (стелс-провал). */
  onDetect: (() => void) | null;
  home: THREE.Vector3;
  leash: number;
}

export function makeShooter(c: Character, weapon: WeaponId, opts: Partial<ShooterAI> = {}): ShooterAI {
  c.setWeapon(weapon);
  const ai: ShooterAI = {
    kind: 'shooter', mode: 'idle', target: null, fireCd: 1 + Math.random(), accuracy: 0.55, holdDist: 12,
    patrol: [], patrolIdx: 0, waitT: 0, vision: 22, fov: 0.85, suspicion: 0, strafe: 1, strafeT: 0, bustT: 0,
    losT: 0, hasLos: false, onDetect: null, home: c.pos.clone(), leash: 200, ...opts,
  };
  c.brain = ai;
  return ai;
}

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();

export class ShooterSystem {
  constructor(private game: Game) {}

  update(c: Character, dt: number) {
    const ai = c.brain as ShooterAI;
    if (!c.alive || !ai || ai.kind !== 'shooter' || c.vehicle) return;
    const g = this.game;
    const anim = c.model.anim;
    ai.fireCd -= dt;
    ai.losT -= dt;
    anim.punchT += dt;
    anim.recoilT += dt;
    const t = ai.target;
    // Проверка видимости раз в 0.3 с.
    if (t && ai.losT <= 0) {
      ai.losT = 0.3;
      ai.hasLos = t.alive && g.physics.lineOfSight(_v.copy(c.pos).setY(c.pos.y + 1.6), t.chest(_d));
    }
    let moveX = 0, moveZ = 0, speed = 0, face: number | null = null;
    switch (ai.mode) {
      case 'patrol': {
        if (ai.patrol.length) {
          const p = ai.patrol[ai.patrolIdx];
          const dx = p.x - c.pos.x, dz = p.z - c.pos.z;
          const d = Math.hypot(dx, dz);
          if (ai.waitT > 0) { ai.waitT -= dt; break; }
          if (d < 0.6) { ai.patrolIdx = (ai.patrolIdx + 1) % ai.patrol.length; ai.waitT = 1.5 + Math.random() * 2; }
          else { moveX = dx / d; moveZ = dz / d; speed = 1.3; }
        }
        this.watch(c, ai, dt);
        break;
      }
      case 'idle':
        this.watch(c, ai, dt);
        break;
      case 'hold':
        if (t && ai.hasLos) { face = Math.atan2(t.pos.x - c.pos.x, t.pos.z - c.pos.z); this.shoot(c, ai, t); }
        break;
      case 'attack': {
        if (!t || !t.alive) { ai.mode = 'idle'; break; }
        const dx = t.pos.x - c.pos.x, dz = t.pos.z - c.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        face = Math.atan2(dx, dz);
        if (!ai.hasLos || d > ai.holdDist + 6) { moveX = dx / d; moveZ = dz / d; speed = d > 25 ? 5.5 : 3.8; }
        else if (d < 4) { moveX = -dx / d; moveZ = -dz / d; speed = 2.5; }
        else {
          // Стрейф вбок.
          ai.strafeT -= dt;
          if (ai.strafeT <= 0) { ai.strafeT = 1 + Math.random() * 2; ai.strafe = Math.random() < 0.5 ? -1 : Math.random() < 0.6 ? 1 : 0; }
          moveX = (-dz / d) * ai.strafe; moveZ = (dx / d) * ai.strafe; speed = 1.8 * Math.abs(ai.strafe);
        }
        if (ai.hasLos && d < WEAPONS[c.weapon].range) this.shoot(c, ai, t);
        break;
      }
      case 'arrest': {
        if (!t || !t.alive) { ai.mode = 'idle'; break; }
        const dx = t.pos.x - c.pos.x, dz = t.pos.z - c.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        face = Math.atan2(dx, dz);
        anim.aiming = true;
        if (d > 1.6) { moveX = dx / d; moveZ = dz / d; speed = d > 6 ? 5.5 : 3; ai.bustT = 0; }
        else if (t === g.player.char && !g.player.vehicle) {
          ai.bustT += dt;
          if (ai.bustT > 1.4) g.bust();
        }
        break;
      }
      case 'follow': {
        if (!t) break;
        const dx = t.pos.x - c.pos.x, dz = t.pos.z - c.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        if (d > 3) { moveX = dx / d; moveZ = dz / d; speed = d > 8 ? 5.5 : 2.2; }
        break;
      }
      case 'flee': {
        const from = t ? t.pos : ai.home;
        const dx = c.pos.x - from.x, dz = c.pos.z - from.z;
        const d = Math.hypot(dx, dz) || 1;
        moveX = dx / d; moveZ = dz / d; speed = 6;
        break;
      }
    }
    anim.aiming = (ai.mode === 'attack' || ai.mode === 'hold' || ai.mode === 'arrest') && c.weapon !== 'fist';
    if (t && anim.aiming) anim.aimPitch = clamp(Math.atan2(t.pos.y - c.pos.y, Math.hypot(t.pos.x - c.pos.x, t.pos.z - c.pos.z)), -0.6, 0.6);
    this.move(c, moveX, moveZ, speed, dt, face);
  }

  /** Конус зрения: растущая подозрительность → атака. */
  private watch(c: Character, ai: ShooterAI, dt: number) {
    const g = this.game;
    const p = g.player.char;
    if (!p.alive) return;
    const dx = p.pos.x - c.pos.x, dz = p.pos.z - c.pos.z;
    const d = Math.hypot(dx, dz);
    let seen = false;
    if (d < ai.vision) {
      const ang = Math.abs(Math.atan2(Math.sin(Math.atan2(dx, dz) - c.yaw), Math.cos(Math.atan2(dx, dz) - c.yaw)));
      if (ang < ai.fov || d < 2.5) {
        ai.target = p;
        if (ai.losT <= 0) { ai.losT = 0.25; ai.hasLos = g.physics.lineOfSight(_v.copy(c.pos).setY(c.pos.y + 1.6), p.chest(_d)); }
        seen = ai.hasLos;
      }
    }
    if (seen) {
      // Ночью и в приседе заметить сложнее.
      const crouch = p.model.anim.crouch > 0.5 ? 0.45 : 1;
      const dark = 1 - g.night * 0.45;
      const run = g.player.sprinting ? 1.6 : 1;
      ai.suspicion += dt * (1.6 - d / ai.vision) * crouch * dark * run * 0.9;
      c.yaw = dampAngle(c.yaw, Math.atan2(dx, dz), 2, dt);
    } else ai.suspicion = Math.max(0, ai.suspicion - dt * 0.25);
    if (ai.suspicion >= 1) {
      ai.mode = 'attack';
      ai.target = p;
      ai.onDetect?.();
    }
  }

  private shoot(c: Character, ai: ShooterAI, t: Character) {
    if (ai.fireCd > 0) return;
    const g = this.game;
    const w = WEAPONS[c.weapon];
    if (c.weapon === 'fist') {
      if (c.pos.distanceTo(t.pos) < 1.7) { ai.fireCd = 1; c.model.anim.punchT = 0; g.combat.melee(c, 8); }
      return;
    }
    // Очереди для автоматов.
    ai.fireCd = w.auto ? (Math.random() < 0.25 ? 0.9 + Math.random() : 1 / w.rate) : 0.6 + Math.random() * 0.9;
    const muzzle = c.model.weaponSlot.getWorldPosition(new THREE.Vector3());
    const aim = t.chest(new THREE.Vector3());
    // Промахи: чем дальше и быстрее цель, тем ниже точность.
    const dist = muzzle.distanceTo(aim);
    const tv = t.vehicle ? t.vehicle.linvel().length() : Math.hypot(t.vel.x, t.vel.z);
    const acc = ai.accuracy / (1 + dist * 0.025 + tv * 0.06) * g.difficulty;
    const miss = (1 - clamp(acc, 0.05, 0.95)) * 1.6;
    aim.x += (Math.random() - 0.5) * miss * 2;
    aim.y += (Math.random() - 0.5) * miss;
    aim.z += (Math.random() - 0.5) * miss * 2;
    const dir = aim.sub(muzzle).normalize();
    c.model.anim.recoilT = 0;
    g.combat.fire(c, w, muzzle, dir, 1);
    // По машине игрока стреляют тоже.
    if (t.vehicle && Math.random() < acc * 0.6) t.vehicle.damage(w.damage * 0.7, c);
  }

  /** Перемещение с обходом препятствий и прилипанием к земле. */
  move(c: Character, mx: number, mz: number, speed: number, dt: number, face: number | null) {
    const g = this.game;
    if (speed > 0 && (mx || mz)) {
      // Луч вперёд: если стена — поворачиваем.
      _d.set(mx, 0, mz).normalize();
      const o = _v.copy(c.pos).setY(c.pos.y + 0.7);
      for (let k = 0; k < 3; k++) {
        const hit = g.physics.raycast(o, _d, 1.2, G_STATIC | G_VEHICLE);
        if (!hit) break;
        const a = (k === 0 ? 0.8 : -1.6) * (c.id % 2 ? 1 : -1);
        _d.applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
      }
      c.pos.x += _d.x * speed * dt;
      c.pos.z += _d.z * speed * dt;
      if (face === null) c.yaw = dampAngle(c.yaw, Math.atan2(_d.x, _d.z), 8, dt);
    }
    if (face !== null) c.yaw = dampAngle(c.yaw, face, 10, dt);
    c.pos.x += c.vel.x * dt;
    c.pos.z += c.vel.z * dt;
    c.vel.multiplyScalar(Math.exp(-6 * dt));
    const ground = g.world.surfaceHeight(c.pos.x, c.pos.z);
    // На крышах (финал): держим высоту, если под ногами крыша — луч вниз.
    const down = g.physics.raycast(_v.copy(c.pos).setY(c.pos.y + 1.2), new THREE.Vector3(0, -1, 0), 4, G_STATIC);
    c.pos.y = down ? down.point.y : ground;
    c.model.anim.speed = speed;
    c.model.anim.grounded = true;
  }
}
