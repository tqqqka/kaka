/**
 * Персонаж мира (игрок, пешеход, полицейский, бандит): позиция, здоровье, оружие,
 * попадания по капсуле. Поведение задаёт внешний контроллер (Player или ИИ).
 */
import * as THREE from 'three';
import { CharacterModel, type Outfit } from './CharacterModel';
import { WEAPONS, weaponMesh, type WeaponId } from './Weapons';
import type { Vehicle } from './Vehicle';

export type Team = 'player' | 'civ' | 'cop' | 'enemy' | 'ally';

let nextId = 1;
const _v = new THREE.Vector3();

export class Character {
  readonly id = nextId++;
  readonly model: CharacterModel;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0;
  health = 100;
  maxHealth = 100;
  armor = 0;
  alive = true;
  deadTime = 0;
  weapon: WeaponId = 'fist';
  /** Патроны: в магазине и в запасе. */
  ammo: Partial<Record<WeaponId, { mag: number; reserve: number }>> = {};
  vehicle: Vehicle | null = null;
  radius = 0.33;
  height = 1.78;
  lastHitBy: Character | null = null;
  lastDamageTime = -99;
  /** Произвольные данные контроллера (ИИ). */
  brain: unknown = null;
  visible = true;
  private gun: THREE.Mesh | null = null;
  /** Колбэк смерти. */
  onDeath: ((c: Character, killer: Character | null) => void) | null = null;

  constructor(outfit: Outfit, public team: Team) {
    this.model = new CharacterModel(outfit);
    this.height = 1.78 * outfit.height;
  }

  get object() {
    return this.model.root;
  }

  setWeapon(id: WeaponId) {
    this.weapon = id;
    if (this.gun) { this.model.weaponSlot.remove(this.gun); this.gun = null; }
    const m = weaponMesh(id);
    if (m) { this.gun = m; this.model.weaponSlot.add(m); }
    this.model.anim.twoHanded = WEAPONS[id].twoHanded;
    if (id !== 'fist' && !this.ammo[id]) this.ammo[id] = { mag: WEAPONS[id].mag, reserve: WEAPONS[id].mag * 3 };
  }

  /** Синхронизация визуальной модели с позицией. */
  sync(dt: number) {
    const r = this.model.root;
    r.position.copy(this.pos);
    r.rotation.y = this.yaw;
    r.visible = this.visible;
    if (this.visible) this.model.update(dt);
  }

  /** Пересечение луча с капсулой персонажа. Возвращает расстояние или null. */
  rayHit(o: THREE.Vector3, d: THREE.Vector3, maxT: number): number | null {
    if (!this.alive && this.deadTime > 3) return null;
    const lying = !this.alive;
    const a = this.pos;
    const top = lying ? 0.4 : this.height - 0.15;
    const r = lying ? 0.45 : this.radius;
    // Ближайшая точка луча к оси капсулы (вертикальный отрезок).
    const steps = 6;
    let best: number | null = null;
    // Аналитически: расстояние от луча до вертикальной оси.
    const ox = o.x - a.x, oz = o.z - a.z;
    const A = d.x * d.x + d.z * d.z;
    if (A < 1e-6) return null;
    const Bq = 2 * (ox * d.x + oz * d.z);
    const C = ox * ox + oz * oz - r * r;
    const disc = Bq * Bq - 4 * A * C;
    if (disc < 0) return null;
    const t = (-Bq - Math.sqrt(disc)) / (2 * A);
    if (t > 0 && t < maxT) {
      const y = o.y + d.y * t - a.y;
      if (y > 0.05 && y < top) best = t;
    }
    void steps;
    return best;
  }

  /** Урон. Возвращает true, если персонаж погиб. */
  damage(amount: number, from: Character | null, time: number): boolean {
    if (!this.alive) return false;
    this.lastHitBy = from;
    this.lastDamageTime = time;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, amount * 0.7);
      this.armor -= absorbed;
      amount -= absorbed;
    }
    this.health -= amount;
    if (this.health <= 0) {
      this.health = 0;
      this.kill(from);
      return true;
    }
    return false;
  }

  kill(from: Character | null = null) {
    if (!this.alive) return;
    this.alive = false;
    this.deadTime = 0;
    this.model.anim.dead = true;
    this.model.anim.aiming = false;
    this.onDeath?.(this, from);
  }

  revive(hp = 100) {
    this.alive = true;
    this.health = hp;
    this.model.anim.dead = false;
    this.deadTime = 0;
  }

  /** Точка груди (для прицеливания ИИ и автонаведения). */
  chest(out = _v): THREE.Vector3 {
    return out.set(this.pos.x, this.pos.y + (this.alive ? this.height * 0.75 : 0.3), this.pos.z);
  }

  forward(out = new THREE.Vector3()) {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }
}
