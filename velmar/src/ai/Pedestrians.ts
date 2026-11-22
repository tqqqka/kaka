/**
 * Пешеходы: гуляют по кольцам тротуаров вокруг кварталов, переходят улицы по зебрам,
 * останавливаются поболтать, разбегаются от выстрелов и взрывов, прячутся,
 * уворачиваются от машин, иногда дают сдачи. Погибшие роняют деньги.
 * Плотность зависит от района и времени суток.
 */
import * as THREE from 'three';
import type { Game, GameModule } from '../game/Game';
import { Character } from '../entities/Character';
import { randomOutfit } from '../entities/CharacterModel';
import { SIDEWALK_W, type Block } from '../world/CityLayout';
import { dampAngle, RNG } from '../core/MathUtil';
import type { Vehicle } from '../entities/Vehicle';
import type { TrafficAI } from './Traffic';

export interface PedAI {
  kind: 'ped';
  state: 'walk' | 'idle' | 'flee' | 'cower' | 'fight' | 'scripted';
  block: Block;
  corner: number;
  dir: 1 | -1;
  target: THREE.Vector3;
  speed: number;
  t: number;
  from: THREE.Vector3;
  crossing: boolean;
  /** Не удалять (миссия). */
  keep: boolean;
}

const INSET = 2.2;
const _v = new THREE.Vector3();

export class Pedestrians implements GameModule {
  peds: Character[] = [];
  max = 20;
  private rng = new RNG(99);
  private spawnCd = 0;
  /** Деньги на земле: позиция и сумма. */
  readonly pickups: { pos: THREE.Vector3; amount: number; mesh: THREE.Mesh; t: number }[] = [];
  private cashGeo = new THREE.BoxGeometry(0.35, 0.08, 0.2);
  private cashMat = new THREE.MeshBasicMaterial({ color: 0x5cff7a });

  constructor(private game: Game) {
    this.max = game.engine.preset.pedCount;
    game.engine.presetListeners.push((p) => (this.max = p.pedCount));
    game.events.on('gunshot', (e) => this.panic(e.pos, e.shooter === game.player.char ? 45 : 30));
    game.events.on('explosion', (e) => this.panic(e.pos, 70));
    game.events.on('death', (e) => { if (e.victim.brain && (e.victim.brain as PedAI).kind === 'ped') this.dropCash(e.victim); });
  }

  private corners(b: Block): [number, number][] {
    return [[b.x0 + INSET, b.z0 + INSET], [b.x1 - INSET, b.z0 + INSET], [b.x1 - INSET, b.z1 - INSET], [b.x0 + INSET, b.z1 - INSET]];
  }

  private density(b: Block): number {
    const d = b.district;
    const base = d === 'downtown' || d === 'plaza' ? 1 : d === 'beach' || d === 'park' ? 0.8 : d === 'residential' ? 0.6 : d === 'suburb' ? 0.3 : 0.2;
    const h = this.game.hours;
    const night = h < 6 || h > 23 ? 0.35 : h < 8 || h > 21 ? 0.7 : 1;
    return base * night;
  }

  update(dt: number) {
    const g = this.game;
    const pp = g.player.char.pos;
    // Удаление дальних.
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const c = this.peds[i];
      const ai = c.brain as PedAI;
      const d = c.pos.distanceTo(pp);
      if ((d > 130 && !ai.keep) || (!c.alive && c.deadTime > 25)) {
        this.peds.splice(i, 1);
        g.removeCharacter(c);
      }
    }
    // Спавн.
    this.spawnCd -= dt;
    if (this.spawnCd <= 0 && g.state === 'playing') {
      this.spawnCd = 0.3;
      const cap = Math.round(this.max * (g.player.vehicle ? 0.8 : 1));
      if (this.peds.length < cap) this.trySpawn(pp);
    }
    for (const c of this.peds) this.think(c, dt);
    this.updatePickups(dt);
  }

  private trySpawn(center: THREE.Vector3) {
    const g = this.game;
    const L = g.world.layout;
    for (let attempt = 0; attempt < 4; attempt++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = 45 + Math.random() * 60;
      const x = center.x + Math.cos(ang) * dist, z = center.z + Math.sin(ang) * dist;
      const bx = Math.floor((x + 1000) / 100), bz = Math.floor((z + 800) / 100);
      const b = L.blockByIndex(bx, bz);
      if (!b || Math.random() > this.density(b)) continue;
      const cs = this.corners(b);
      const k = Math.floor(Math.random() * 4);
      const a = cs[k], bb = cs[(k + 1) % 4];
      const t = Math.random();
      const pos = new THREE.Vector3(a[0] + (bb[0] - a[0]) * t, 0.15, a[1] + (bb[1] - a[1]) * t);
      // Не в кадре рядом с игроком.
      const cam = g.engine.camera.position;
      const to = _v.copy(pos).sub(cam);
      if (to.length() < 70 && to.normalize().dot(g.cameraRig.aimDir) > 0.5) continue;
      const c = g.spawnCharacter(randomOutfit(Math.random), 'civ', pos);
      c.maxHealth = c.health = 40 + Math.random() * 40;
      const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
      const ai: PedAI = { kind: 'ped', state: 'walk', block: b, corner: dir > 0 ? (k + 1) % 4 : k, dir, target: new THREE.Vector3(), speed: 1.2 + Math.random() * 0.5, t: 0, from: new THREE.Vector3(), crossing: false, keep: false };
      const tc = cs[ai.corner];
      ai.target.set(tc[0], 0.15, tc[1]);
      c.brain = ai;
      this.peds.push(c);
      return;
    }
  }

  private nextTarget(c: Character, ai: PedAI) {
    const L = this.game.world.layout;
    // На углу: перейти улицу (30%) или идти дальше вокруг квартала.
    if (!ai.crossing && Math.random() < 0.3) {
      const corner = ai.corner;
      // Соседний квартал через улицу по одной из двух осей.
      const horiz = Math.random() < 0.5;
      const dbx = horiz ? (corner === 1 || corner === 2 ? 1 : -1) : 0;
      const dbz = horiz ? 0 : (corner === 2 || corner === 3 ? 1 : -1);
      const nb = L.blockByIndex(ai.block.bx + dbx, ai.block.bz + dbz);
      if (nb && nb.district !== 'port') {
        const map: Record<string, number> = horiz
          ? { 1: 0, 2: 3, 0: 1, 3: 2 }
          : { 3: 0, 2: 1, 0: 3, 1: 2 };
        const nc = map[corner];
        const cs = this.corners(nb);
        ai.block = nb;
        ai.corner = nc;
        ai.target.set(cs[nc][0], 0.15, cs[nc][1]);
        ai.crossing = true;
        return;
      }
    }
    ai.crossing = false;
    ai.corner = (ai.corner + ai.dir + 4) % 4;
    const cs = this.corners(ai.block);
    ai.target.set(cs[ai.corner][0], 0.15, cs[ai.corner][1]);
    if (Math.random() < 0.15) { ai.state = 'idle'; ai.t = 2 + Math.random() * 5; }
    void c;
  }

  private think(c: Character, dt: number) {
    const g = this.game;
    const ai = c.brain as PedAI;
    const anim = c.model.anim;
    if (!c.alive) {
      // Отлёт тела после удара машиной.
      c.pos.addScaledVector(c.vel, dt);
      c.vel.multiplyScalar(Math.exp(-4 * dt));
      c.pos.y = g.world.surfaceHeight(c.pos.x, c.pos.z);
      return;
    }
    if (ai.state === 'scripted') return;
    anim.cower = false;
    let speed = 0;
    let tx = ai.target.x, tz = ai.target.z;
    ai.t -= dt;
    switch (ai.state) {
      case 'walk': {
        speed = ai.speed;
        if (Math.hypot(tx - c.pos.x, tz - c.pos.z) < 0.6) this.nextTarget(c, ai);
        // Уворот от быстро едущей машины.
        for (const v of g.vehicles.list) {
          if (Math.abs(v.speed) < 6) continue;
          const vp = v.position(_v);
          const rx = c.pos.x - vp.x, rz = c.pos.z - vp.z;
          if (rx * rx + rz * rz > 200) continue;
          const f = v.forward();
          const along = rx * f.x + rz * f.z;
          const lat = rx * f.z - rz * f.x;
          if (along > 0 && along < 14 && Math.abs(lat) < 2.5) {
            ai.state = 'flee'; ai.t = 2; ai.from.copy(vp);
            if (v.playerDriving && Math.random() < 0.5) g.police?.addCrime('reckless', c.pos, 0);
          }
        }
        break;
      }
      case 'idle':
        anim.talk = Math.random() < 0.002 ? !anim.talk : anim.talk;
        if (ai.t <= 0) { ai.state = 'walk'; anim.talk = false; }
        break;
      case 'flee': {
        speed = 6.2;
        const ax = c.pos.x - ai.from.x, az = c.pos.z - ai.from.z;
        const L = Math.hypot(ax, az) || 1;
        tx = c.pos.x + (ax / L) * 10; tz = c.pos.z + (az / L) * 10;
        // Не забегать в стены: держимся тротуара — бежим вдоль ближайшей стороны.
        if (g.world.layout.blockAt(tx, tz) === null && g.world.layout.blockAt(c.pos.x, c.pos.z)) {
          tx = c.pos.x + (ax / L) * 10; tz = c.pos.z;
        }
        if (ai.t <= 0) { ai.state = 'walk'; this.retarget(c, ai); }
        break;
      }
      case 'cower':
        anim.cower = true;
        if (ai.t <= 0) { ai.state = 'flee'; ai.t = 5; }
        break;
      case 'fight': {
        const p = g.player.char;
        tx = p.pos.x; tz = p.pos.z;
        const d = c.pos.distanceTo(p.pos);
        speed = d > 1.3 ? 4.5 : 0;
        if (d < 1.6 && ai.t <= 0 && p.alive) {
          ai.t = 0.9;
          anim.punchT = 0;
          setTimeout(() => { if (c.alive) g.combat.melee(c, 7); }, 150);
        }
        if (d > 25 || !p.alive) { ai.state = 'walk'; this.retarget(c, ai); }
        break;
      }
    }
    // Движение.
    const dx = tx - c.pos.x, dz = tz - c.pos.z;
    const L = Math.hypot(dx, dz);
    if (L > 0.05 && speed > 0) {
      c.yaw = dampAngle(c.yaw, Math.atan2(dx, dz), 8, dt);
      const step = Math.min(L, speed * dt);
      c.pos.x += (dx / L) * step + c.vel.x * dt;
      c.pos.z += (dz / L) * step + c.vel.z * dt;
    } else {
      c.pos.x += c.vel.x * dt;
      c.pos.z += c.vel.z * dt;
    }
    c.vel.multiplyScalar(Math.exp(-6 * dt));
    // Расталкивание с игроком.
    const p = g.player.char;
    if (!p.vehicle) {
      const ox = c.pos.x - p.pos.x, oz = c.pos.z - p.pos.z;
      const od = Math.hypot(ox, oz);
      if (od < 0.7 && od > 0.01) { c.pos.x += (ox / od) * (0.7 - od); c.pos.z += (oz / od) * (0.7 - od); }
    }
    c.pos.y = g.world.surfaceHeight(c.pos.x, c.pos.z);
    anim.speed = speed > 0 && L > 0.05 ? speed : 0;
    anim.grounded = true;
  }

  private retarget(c: Character, ai: PedAI) {
    // Вернуться на ближайший квартал.
    const L = this.game.world.layout;
    const b = L.blockAt(c.pos.x, c.pos.z) ?? L.blockAt(c.pos.x + 6, c.pos.z) ?? L.blockAt(c.pos.x - 6, c.pos.z) ?? L.blockAt(c.pos.x, c.pos.z + 6) ?? L.blockAt(c.pos.x, c.pos.z - 6) ?? ai.block;
    ai.block = b;
    const cs = this.corners(b);
    let best = 0, bd = Infinity;
    cs.forEach(([x, z], i) => { const d = Math.hypot(x - c.pos.x, z - c.pos.z); if (d < bd) { bd = d; best = i; } });
    ai.corner = best;
    ai.target.set(cs[best][0], 0.15, cs[best][1]);
    ai.crossing = false;
  }

  /** Паника вокруг точки (выстрелы, взрывы, смерть). */
  panic(pos: THREE.Vector3, radius: number) {
    for (const c of this.peds) {
      const ai = c.brain as PedAI;
      if (!c.alive || ai.state === 'scripted' || ai.state === 'fight') continue;
      const d = c.pos.distanceTo(pos);
      if (d > radius) continue;
      if (d < 12 && Math.random() < 0.35) { ai.state = 'cower'; ai.t = 2 + Math.random() * 3; }
      else { ai.state = 'flee'; ai.t = 5 + Math.random() * 5; }
      ai.from.copy(pos);
    }
  }

  /** Удар по пешеходу: кто-то даёт сдачи. */
  onHit(c: Character, attacker: Character | null) {
    const ai = c.brain as PedAI | null;
    if (!ai || ai.kind !== 'ped' || !c.alive) return;
    if (attacker === this.game.player.char && Math.random() < 0.25 && ai.state !== 'fight') { ai.state = 'fight'; ai.t = 0.5; }
    else if (ai.state !== 'fight') { ai.state = 'flee'; ai.t = 8; ai.from.copy(attacker?.pos ?? c.pos); }
  }

  /** Водитель трафика выходит/выталкивается из машины. */
  ejectDriver(v: Vehicle): Character | null {
    const g = this.game;
    const ai = v.ai as TrafficAI | null;
    if (!(ai && ai.kind === 'traffic' && ai.hasDriver) && !v.driver) return null;
    if (ai) ai.hasDriver = false;
    if (v.driver) { v.driver = null; }
    const p = v.exitPoint(new THREE.Vector3());
    p.y = g.world.surfaceHeight(p.x, p.z);
    const c = g.spawnCharacter(randomOutfit(Math.random), 'civ', p);
    c.maxHealth = c.health = 60;
    const b = g.world.layout.blockAt(p.x, p.z) ?? g.world.layout.blocks[0];
    const pa: PedAI = { kind: 'ped', state: 'flee', block: b, corner: 0, dir: 1, target: p.clone(), speed: 1.4, t: 6, from: v.position(), crossing: false, keep: false };
    c.brain = pa;
    c.vel.copy(v.exitPoint(new THREE.Vector3()).sub(v.position()).setY(0).normalize().multiplyScalar(4));
    this.peds.push(c);
    return c;
  }

  // ------------------------------------------------------------------ деньги
  private dropCash(c: Character) {
    if (Math.random() > 0.6) return;
    const amount = 10 + Math.floor(Math.random() * 50);
    const mesh = new THREE.Mesh(this.cashGeo, this.cashMat);
    mesh.position.copy(c.pos).add(new THREE.Vector3(0.5, 0.25, 0.3));
    this.game.engine.scene.add(mesh);
    this.pickups.push({ pos: mesh.position.clone(), amount, mesh, t: 0 });
  }

  private updatePickups(dt: number) {
    const g = this.game;
    const p = g.player.char.pos;
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const k = this.pickups[i];
      k.t += dt;
      k.mesh.rotation.y += dt * 2;
      k.mesh.position.y = k.pos.y + Math.sin(k.t * 3) * 0.08;
      if (!g.player.vehicle && k.pos.distanceTo(p) < 1.3) {
        g.economy.add(k.amount, 'Подобрано');
        g.hud.toast(`+$${k.amount}`, 'good');
        k.mesh.removeFromParent();
        this.pickups.splice(i, 1);
      } else if (k.t > 60) { k.mesh.removeFromParent(); this.pickups.splice(i, 1); }
    }
  }

  /** Сценарный пешеход для миссий (не управляется ИИ гуляния). */
  makeScripted(c: Character) {
    const b = this.game.world.layout.blockAt(c.pos.x, c.pos.z) ?? this.game.world.layout.blocks[0];
    c.brain = { kind: 'ped', state: 'scripted', block: b, corner: 0, dir: 1, target: c.pos.clone(), speed: 1.4, t: 0, from: c.pos.clone(), crossing: false, keep: true } as PedAI;
  }

  static sidewalkInset() {
    return SIDEWALK_W;
  }
}
