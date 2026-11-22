/**
 * Полиция и уровень розыска (0–5★).
 *  - Преступления фиксируются, если есть свидетели (полиция в зоне видимости или прохожие рядом).
 *  - 1★: патрули пытаются задержать; 2★: стреляют; 3★: таран; 4★: вертолёт; 5★: спецназ на броневике.
 *  - Если полиция долго не видит игрока — режим поиска (мигающие звёзды), затем розыск снимается.
 */
import * as THREE from 'three';
import type { Game, PoliceLike } from '../game/Game';
import type { Vehicle } from '../entities/Vehicle';
import type { Character } from '../entities/Character';
import { OUTFITS } from '../entities/CharacterModel';
import { WEAPONS } from '../entities/Weapons';
import { DriverAI } from './DriverAI';
import { ShooterSystem, makeShooter, type ShooterAI } from './ShooterAI';
import type { TrafficAI } from './Traffic';
import { clamp } from '../core/MathUtil';

interface Unit {
  car: Vehicle;
  driver: DriverAI;
  cops: Character[];
  onFoot: boolean;
  heli: boolean;
}

const _v = new THREE.Vector3();

export class Police implements PoliceLike {
  wanted = 0;
  searching = false;
  private searchT = 0;
  private unseenT = 0;
  readonly lastSeen = new THREE.Vector3();
  private units: Unit[] = [];
  private spawnCd = 0;
  private minWanted = 0;
  readonly shooters: ShooterSystem;
  /** Розыск отключён (катсцены, начало игры). */
  disabled = false;
  private seeCd = 0;
  private playerSeen = false;

  constructor(private game: Game) {
    this.shooters = new ShooterSystem(game);
    game.events.on('death', (e) => {
      if (e.killer !== game.player.char || e.victim === game.player.char) return;
      if (e.victim.team === 'cop') this.addCrime('killCop', e.victim.pos, 2);
      else if (e.victim.team === 'civ') this.addCrime('kill', e.victim.pos, 1);
    });
    game.events.on('gunshot', (e) => { if (e.shooter === game.player.char && game.player.char.weapon !== 'fist') this.addCrime('shoot', e.pos, 1); });
    game.events.on('pedHit', (e) => { if (e.vehicle.playerDriving) this.addCrime('hitPed', e.victim.pos, 1); });
    game.events.on('vehicleStolen', (e) => { if (e.thief === game.player.char) { game.economy.stats.carsStolen++; this.addCrime(e.vehicle.kind === 'police' ? 'stealCop' : 'carjack', e.vehicle.position(), e.vehicle.kind === 'police' ? 2 : 1); } });
    game.events.on('vehicleDamaged', (e) => { if (e.by === game.player.char && e.vehicle.kind === 'police' && !e.vehicle.playerDriving) this.addCrime('damageCop', e.vehicle.position(), 1); });
    game.events.on('vehicleDestroyed', (e) => { if (e.by === game.player.char) { game.economy.stats.carsDestroyed++; this.addCrime('explosion', e.vehicle.position(), 1); } });
  }

  /** Есть ли свидетели у точки. */
  private witnessed(pos: THREE.Vector3, severity: number): boolean {
    const g = this.game;
    for (const u of this.units) {
      const p = u.onFoot && u.cops[0] ? u.cops[0].pos : u.car.position(_v);
      if (p.distanceTo(pos) < 90) return true;
    }
    for (const c of g.characters) {
      if (c.team === 'cop' && c.alive && c.pos.distanceTo(pos) < 70) return true;
    }
    // Патрульные машины в трафике.
    for (const v of g.vehicles.list) if (v.kind === 'police' && !v.destroyed && v.position(_v).distanceTo(pos) < 60) return true;
    // Прохожие звонят в полицию при серьёзных преступлениях.
    if (severity >= 1) {
      let n = 0;
      for (const c of g.characters) if (c.team === 'civ' && c.alive && c.pos.distanceTo(pos) < 30) n++;
      return n >= 1 && Math.random() < 0.8;
    }
    return false;
  }

  addCrime(kind: string, pos: THREE.Vector3, severity = 1) {
    if (this.disabled || severity <= 0) return;
    if (!this.witnessed(pos, severity) && kind !== 'mission') return;
    let lvl = this.wanted;
    if (kind === 'shoot') lvl = Math.max(lvl, 1);
    else if (kind === 'kill') lvl = Math.min(5, Math.max(lvl, 1) + (lvl >= 2 ? 0.34 : 1));
    else if (kind === 'killCop') lvl = Math.min(5, Math.max(lvl, 2) + 0.7);
    else if (kind === 'stealCop') lvl = Math.max(lvl, 2);
    else lvl = Math.max(lvl, Math.min(2, lvl + 0.5 * severity), 1);
    const before = Math.floor(this.wanted);
    this.wanted = clamp(lvl, 0, 5);
    this.lastSeen.copy(this.game.player.char.pos);
    this.searching = false;
    this.unseenT = 0;
    if (Math.floor(this.wanted) > before) this.game.audio.ui('error');
  }

  setMinWanted(n: number) {
    this.minWanted = n;
    if (this.wanted < n) this.wanted = n;
  }

  clear() {
    this.wanted = 0;
    this.searching = false;
    for (const u of this.units) this.removeUnit(u);
    this.units = [];
  }

  get stars() {
    return Math.floor(this.wanted + 0.001);
  }

  update(dt: number) {
    const g = this.game;
    const target = g.player.char;
    const tpos = g.player.vehicle ? g.player.vehicle.position() : target.pos;
    if (this.minWanted > 0 && this.wanted < this.minWanted) this.wanted = this.minWanted;
    // Патрульные машины трафика включают мигалки и переходят в погоню.
    if (this.stars > 0) {
      for (const v of g.vehicles.list) {
        const ai = v.ai as TrafficAI | null;
        if (v.kind === 'police' && ai && ai.kind === 'traffic' && !v.destroyed && v.position(_v).distanceTo(tpos) < 120 && this.units.length < this.maxUnits()) {
          v.setKinematic(false);
          v.ai = null;
          this.adopt(v);
        }
      }
    }
    // Видимость игрока.
    this.seeCd -= dt;
    if (this.seeCd <= 0) {
      this.seeCd = 0.4;
      this.playerSeen = false;
      for (const u of this.units) {
        const eye = u.onFoot && u.cops[0]?.alive ? u.cops[0].pos.clone().setY(u.cops[0].pos.y + 1.6) : u.car.position(_v).clone().setY(u.car.position(_v).y + 1.4);
        const range = u.heli ? 160 : 90;
        if (eye.distanceTo(tpos) < range && g.physics.lineOfSight(eye, tpos.clone().setY(tpos.y + 1.2))) { this.playerSeen = true; break; }
      }
    }
    if (this.stars > 0) {
      if (this.playerSeen) {
        this.lastSeen.copy(tpos);
        this.unseenT = 0;
        this.searching = false;
      } else {
        this.unseenT += dt;
        if (this.unseenT > 3) this.searching = true;
        const searchTime = 8 + this.stars * 5;
        const outside = tpos.distanceTo(this.lastSeen) > 70 + this.stars * 30;
        if (this.searching) this.searchT += dt * (outside ? 2 : 1);
        if (this.searchT > searchTime && this.minWanted === 0) {
          this.wanted = 0;
          this.searchT = 0;
          this.searching = false;
          g.hud.toast('Розыск снят', 'good');
        }
      }
      if (!this.searching) this.searchT = 0;
    }
    // Подкрепление.
    this.spawnCd -= dt;
    const want = this.maxUnits();
    if (this.units.filter((u) => !u.heli).length < want && this.spawnCd <= 0) {
      this.spawnCd = 3.5;
      this.spawnUnit(tpos, false);
    }
    if (this.stars >= 4 && !this.units.some((u) => u.heli) && this.spawnCd <= 0) {
      this.spawnCd = 4;
      this.spawnUnit(tpos, true);
    }
    // Управление юнитами.
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      const cp = u.car.position(_v).clone();
      const far = cp.distanceTo(tpos) > 260;
      const copsDead = u.cops.length > 0 && u.cops.every((c) => !c.alive);
      if ((this.stars === 0 && cp.distanceTo(g.engine.camera.position) > 60) || far || (u.car.destroyed && (copsDead || u.cops.length === 0))) {
        if (far || this.stars === 0) { this.removeUnit(u); this.units.splice(i, 1); continue; }
      }
      this.updateUnit(u, tpos, dt);
    }
  }

  private maxUnits() {
    const s = this.stars;
    return s === 0 ? 0 : s === 1 ? 1 : s === 2 ? 2 : s === 3 ? 3 : s === 4 ? 4 : 5;
  }

  /** Место появления: дорога позади игрока, вне поля зрения. */
  private spawnUnit(center: THREE.Vector3, heli: boolean) {
    const g = this.game;
    const graph = g.world.graph;
    let pos: THREE.Vector3 | null = null;
    let yaw = 0;
    // Кандидаты — перекрёстки в кольце 100–220 м, вне поля зрения камеры.
    const cand = graph.nodes.filter((n) => { const d = Math.hypot(n.x - center.x, n.z - center.z); return d > 100 && d < 220; });
    for (let k = 0; k < Math.min(12, cand.length); k++) {
      const n = cand[Math.floor(Math.random() * cand.length)];
      const to = new THREE.Vector3(n.x, 0, n.z).sub(g.engine.camera.position).setY(0).normalize();
      if (k < 8 && to.dot(new THREE.Vector3(g.cameraRig.aimDir.x, 0, g.cameraRig.aimDir.z).normalize()) > 0.6) continue;
      pos = new THREE.Vector3(n.x + 2, heli ? 70 : (n.i < 0 ? g.world.terrain.groundHeight(n.x, n.z) + 0.6 : 0.6), n.z + 2);
      yaw = Math.atan2(center.x - n.x, center.z - n.z);
      break;
    }
    if (!pos) return;
    const kind = heli ? 'policeHeli' : this.stars >= 5 && Math.random() < 0.5 ? 'armored' : 'police';
    const car = g.vehicles.spawn(kind, pos, yaw, { paint: kind === 'armored' ? 0x24272b : undefined });
    this.adopt(car, heli);
  }

  private adopt(car: Vehicle, heli = false) {
    const g = this.game;
    car.siren = true;
    car.engineOn = true;
    car.tag = 'police';
    car.persistent = true;
    const cops: Character[] = [];
    const n = heli ? 1 : car.kind === 'armored' ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const c = g.spawnCharacter(car.kind === 'armored' ? OUTFITS.swat : OUTFITS.cop, 'cop', car.position());
      c.vehicle = car;
      c.visible = false;
      c.maxHealth = c.health = car.kind === 'armored' ? 140 : 90;
      c.armor = car.kind === 'armored' ? 60 : 0;
      makeShooter(c, this.stars >= 4 || car.kind === 'armored' ? 'rifle' : this.stars >= 3 ? 'smg' : 'pistol', { accuracy: car.kind === 'armored' ? 0.7 : 0.5, holdDist: 10 + Math.random() * 6 });
      cops.push(c);
    }
    car.driver = cops[0];
    this.units.push({ car, driver: new DriverAI(g, car), cops, onFoot: false, heli });
  }

  private updateUnit(u: Unit, tpos: THREE.Vector3, dt: number) {
    const g = this.game;
    const car = u.car;
    const d = car.position(_v).distanceTo(tpos);
    const p = g.player;
    if (u.heli) {
      // Вертолёт кружит над игроком.
      const t = g.time * 0.3;
      const goal = tpos.clone().add(new THREE.Vector3(Math.cos(t) * 30, 38, Math.sin(t) * 30));
      const cp = car.position();
      const to = goal.sub(cp);
      const loc = to.clone().applyQuaternion(car.quaternion().invert());
      car.ctl.lift = clamp(to.y * 0.15, -1, 1);
      car.ctl.pitch = clamp(loc.z * 0.03, -1, 1);
      car.ctl.roll = clamp(loc.x * 0.03, -1, 1);
      const face = Math.atan2(tpos.x - cp.x, tpos.z - cp.z);
      const dy = Math.atan2(Math.sin(face - car.yaw), Math.cos(face - car.yaw));
      car.ctl.yaw = clamp(dy * 1.5, -1, 1);
      const cop = u.cops[0];
      if (cop && cop.alive && this.stars >= 4) {
        cop.pos.copy(cp).add(new THREE.Vector3(0, 0.5, 0));
        const ai = cop.brain as ShooterAI;
        ai.fireCd -= dt;
        if (ai.fireCd <= 0 && this.playerSeen && Math.random() < 0.5) {
          ai.fireCd = 2.5;
          const dir = tpos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, 1, (Math.random() - 0.5) * 4)).sub(cop.pos).normalize();
          g.combat.fire(cop, { ...WEAPONS.rifle, damage: 18 }, cop.pos.clone(), dir);
        }
      }
      return;
    }
    if (!u.onFoot) {
      const shouldExit = (d < 16 && (!p.vehicle || Math.abs(p.vehicle.speed) < 4)) || (car.destroyed && d < 80) || (d < 25 && Math.abs(car.speed) < 0.8 && u.driver.stuckT > 1);
      if (shouldExit && this.stars > 0) {
        u.driver.stop();
        if (Math.abs(car.speed) < 2 || car.destroyed) this.exitCops(u);
        return;
      }
      if (this.stars === 0) { u.driver.driveTo(car.position().add(car.forward().multiplyScalar(30)), 10, dt); car.siren = false; return; }
      // Погоня: цель — точка перед игроком (упреждение), на 3★+ — таран.
      const lead = p.vehicle ? p.vehicle.linvel().multiplyScalar(this.stars >= 3 ? 0.6 : 0.3) : new THREE.Vector3();
      const tgt = tpos.clone().add(lead);
      u.driver.skill = 1 + this.stars * 0.1;
      u.driver.driveSmart(tgt, d > 60 ? 40 : Math.max(12, (p.vehicle ? Math.abs(p.vehicle.speed) : 0) + 6), dt);
      return;
    }
    // Пешие копы.
    let allInCarRange = true;
    for (const c of u.cops) {
      if (!c.alive) continue;
      const ai = c.brain as ShooterAI;
      ai.target = p.char;
      if (this.stars === 0) ai.mode = 'idle';
      else if (this.stars === 1 && !p.vehicle) ai.mode = 'arrest';
      else ai.mode = 'attack';
      this.shooters.update(c, dt);
      if (c.pos.distanceTo(car.position(_v)) > 6) allInCarRange = false;
    }
    // Игрок уехал — копы возвращаются в машину.
    if (p.vehicle && d > 30 && !car.destroyed) {
      for (const c of u.cops) {
        if (!c.alive) continue;
        const ai = c.brain as ShooterAI;
        ai.mode = 'follow';
        ai.target = null;
        this.shooters.move(c, car.position().x - c.pos.x, car.position().z - c.pos.z, 5.5, dt, null);
      }
      if (allInCarRange || d > 70) {
        for (const c of u.cops) if (c.alive) { c.vehicle = car; c.visible = false; }
        u.onFoot = false;
        car.driver = u.cops.find((c) => c.alive) ?? null;
        if (!car.driver) u.cops.length = 0;
      }
    }
  }

  private exitCops(u: Unit) {
    u.onFoot = true;
    const car = u.car;
    car.driver = null;
    u.cops.forEach((c, i) => {
      if (!c.alive) return;
      const p = car.exitPoint(new THREE.Vector3());
      if (i % 2 === 1) p.add(car.forward().multiplyScalar(-1.2)).sub(new THREE.Vector3().subVectors(p, car.position()).setY(0).multiplyScalar(2));
      p.y = this.game.world.surfaceHeight(p.x, p.z);
      c.pos.copy(p);
      c.vehicle = null;
      c.visible = true;
    });
  }

  private removeUnit(u: Unit) {
    const g = this.game;
    for (const c of u.cops) g.removeCharacter(c);
    if (!u.car.playerDriving) g.vehicles.remove(u.car);
  }

  /** Пешие полицейские вне юнитов (миссии) обновляются здесь же. */
  get unitCount() {
    return this.units.length;
  }

  unitPositions(): THREE.Vector3[] {
    return this.units.map((u) => (u.onFoot && u.cops[0] ? u.cops[0].pos : u.car.position()));
  }
}
