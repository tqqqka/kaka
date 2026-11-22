/**
 * Боевая система: выстрелы (hitscan по миру, персонажам и транспорту), ближний бой,
 * взрывы с уроном и импульсом, автонаведение для сенсорного управления.
 */
import * as THREE from 'three';
import { G_STATIC, G_VEHICLE } from '../core/Physics';
import { WEAPONS, type WeaponDef } from '../entities/Weapons';
import { Vehicle } from '../entities/Vehicle';
import type { Character } from '../entities/Character';
import type { Game } from './Game';

const _d = new THREE.Vector3();
const _p = new THREE.Vector3();

export class Combat {
  constructor(private game: Game) {}

  /**
   * Выстрел из оружия. origin — дуло, dir — направление (нормализованное).
   * Возвращает true, если в кого-то попали.
   */
  fire(shooter: Character, w: WeaponDef, origin: THREE.Vector3, dir: THREE.Vector3, accuracy = 1): boolean {
    const g = this.game;
    let anyHit = false;
    for (let k = 0; k < w.pellets; k++) {
      _d.copy(dir);
      const spread = w.spread / accuracy;
      _d.x += (Math.random() - 0.5) * 2 * spread;
      _d.y += (Math.random() - 0.5) * 2 * spread;
      _d.z += (Math.random() - 0.5) * 2 * spread;
      _d.normalize();
      // Мир и транспорт (кроме машины самого стрелка).
      const exclude = shooter.vehicle?.body;
      const wh = g.physics.raycast(origin, _d, w.range, G_STATIC | G_VEHICLE, exclude);
      let maxT = wh ? wh.dist : w.range;
      // Персонажи.
      let victim: Character | null = null;
      for (const c of g.characters) {
        if (c === shooter || !c.visible || c.vehicle) continue;
        if (c.team === shooter.team && c.team !== 'civ') continue;
        const t = c.rayHit(origin, _d, maxT);
        if (t !== null && t < maxT) { maxT = t; victim = c; }
      }
      const end = _p.copy(origin).addScaledVector(_d, maxT);
      if (victim) {
        // Попадание в голову — двойной урон.
        const head = end.y - victim.pos.y > victim.height * 0.85;
        const dmg = w.damage * (head ? 2.2 : 1) * (victim.team === 'player' ? g.difficulty : 1);
        victim.damage(dmg, shooter, g.time);
        g.particles.blood(end, _d);
        g.onCharacterHit(victim, shooter, dmg);
        anyHit = true;
      } else if (wh) {
        g.particles.sparks(wh.point, wh.normal, 5);
        if (wh.owner instanceof Vehicle) {
          const v = wh.owner;
          v.damage(w.damage * 0.9, shooter);
          // Пуля в водителя через стекло.
          if (v.driver && Math.random() < 0.12) v.driver.damage(w.damage, shooter, g.time);
          anyHit = true;
        } else g.decals?.bulletHole(wh.point, wh.normal);
      }
      if (k === 0 || w.pellets > 1) g.particles.tracer(origin, end);
    }
    g.particles.muzzle(origin, dir);
    g.audio.gunshot(w.id, origin);
    g.events.emit('gunshot', { pos: origin.clone(), shooter });
    return anyHit;
  }

  /** Удар рукой/ногой: ближайший персонаж в конусе перед атакующим. */
  melee(attacker: Character, damage = WEAPONS.fist.damage): Character | null {
    const g = this.game;
    const f = attacker.forward();
    let best: Character | null = null;
    let bd = 1.9;
    for (const c of g.characters) {
      if (c === attacker || !c.alive || c.vehicle) continue;
      const dx = c.pos.x - attacker.pos.x, dz = c.pos.z - attacker.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > bd || Math.abs(c.pos.y - attacker.pos.y) > 1.2) continue;
      if ((dx * f.x + dz * f.z) / (d || 1) < 0.45) continue;
      bd = d;
      best = c;
    }
    if (best) {
      best.damage(damage, attacker, g.time);
      // Отталкивание.
      best.vel.x += f.x * 3;
      best.vel.z += f.z * 3;
      g.audio.punch(best.pos);
      g.onCharacterHit(best, attacker, damage);
      g.events.emit('gunshot', { pos: attacker.pos.clone(), shooter: attacker });
    } else g.audio.whoosh(attacker.pos);
    return best;
  }

  /** Взрыв: урон по радиусу, импульс транспорту, эффекты. */
  explosion(pos: THREE.Vector3, radius: number, damage: number, source: Character | null) {
    const g = this.game;
    g.particles.explosion(pos, radius / 8);
    g.audio.explosion(pos);
    g.cameraRig.shake(Math.max(0, 1.2 - pos.distanceTo(g.engine.camera.position) / 80));
    g.flash(pos, 1);
    for (const c of g.characters) {
      if (!c.alive || c.vehicle) continue;
      const d = c.pos.distanceTo(pos);
      if (d > radius) continue;
      const k = 1 - d / radius;
      c.damage(damage * k, source, g.time);
      _d.subVectors(c.pos, pos).setY(0.5).normalize();
      c.vel.addScaledVector(_d, 10 * k);
      g.onCharacterHit(c, source, damage * k);
    }
    for (const v of g.vehicles.list) {
      const vp = v.position();
      const d = vp.distanceTo(pos);
      if (d > radius * 1.5 || d < 0.5) continue;
      const k = 1 - d / (radius * 1.5);
      if (!v.destroyed) v.damage(damage * 6 * k, source);
      if (v.kinematic) v.setKinematic(false);
      _d.subVectors(vp, pos).normalize();
      v.body.applyImpulse({ x: _d.x * v.spec.mass * 6 * k, y: v.spec.mass * 5 * k, z: _d.z * v.spec.mass * 6 * k }, true);
    }
    g.events.emit('explosion', { pos: pos.clone(), radius, source });
  }

  /** Цель для автонаведения: ближайший враг в конусе взгляда. */
  autoAimTarget(from: THREE.Vector3, dir: THREE.Vector3, shooter: Character, maxAngle = 0.22, maxDist = 60): Character | null {
    let best: Character | null = null;
    let bs = Infinity;
    for (const c of this.game.characters) {
      if (c === shooter || !c.alive || c.vehicle || !c.visible) continue;
      if (c.team === 'civ' && !this.game.isHostile(c)) continue;
      if (c.team === 'ally') continue;
      const to = c.chest(_p).sub(from);
      const d = to.length();
      if (d > maxDist) continue;
      const ang = Math.acos(THREE.MathUtils.clamp(to.dot(dir) / d, -1, 1));
      if (ang > maxAngle) continue;
      const score = ang * 30 + d * 0.05;
      if (score < bs && this.game.physics.lineOfSight(from, c.chest(new THREE.Vector3()))) { bs = score; best = c; }
    }
    return best;
  }
}
