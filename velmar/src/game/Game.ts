/**
 * Game — корневой объект: связывает рендер, физику, мир, игрока, транспорт, ИИ,
 * миссии, интерфейс и сохранения. Содержит главный игровой цикл.
 */
import * as THREE from 'three';
import { Engine } from '../core/Engine';
import { Physics } from '../core/Physics';
import { Input } from '../core/Input';
import { AudioEngine, EngineSound, SirenSound } from '../core/Audio';
import { EventBus } from '../core/Events';
import type { QualityName } from '../core/Quality';
import { World } from '../world/World';
import { Particles } from '../render/Particles';
import { Decals } from '../render/Decals';
import { Weather } from '../render/Weather';
import { SharedUniforms } from '../render/Materials';
import { Player } from '../entities/Player';
import { CameraRig } from '../entities/CameraRig';
import { VehicleManager } from '../entities/VehicleManager';
import { Character } from '../entities/Character';
import { randomOutfit } from '../entities/CharacterModel';
import type { Vehicle } from '../entities/Vehicle';
import { Combat } from './Combat';
import { Economy } from './Economy';
import { HUD } from '../ui/HUD';
import { DISTRICT_NAMES } from '../world/CityLayout';
import { clamp } from '../core/MathUtil';
import { Traffic } from '../ai/Traffic';
import { Markers } from './Markers';
import type { MissionSystem } from './Missions';
import type { Shops } from './Shops';
import type { Packages } from './SideJobs';
import type { Settings } from './Save';
import type { UI } from '../ui/UI';
import type { Minimap } from '../ui/Minimap';
import { Pedestrians } from '../ai/Pedestrians';
import { Police } from '../ai/Police';

/** Модули, подключаемые после базовой инициализации (ИИ, миссии, UI). */
export interface GameModule {
  update(dt: number): void;
}
export interface PoliceLike extends GameModule {
  wanted: number;
  searching: boolean;
  addCrime(kind: string, pos: THREE.Vector3, severity?: number): void;
  clear(): void;
  setMinWanted(n: number): void;
}

export type GameState = 'menu' | 'playing' | 'paused' | 'dead' | 'loading';

export class Game {
  readonly engine: Engine;
  readonly physics: Physics;
  readonly world: World;
  readonly input: Input;
  readonly audio = new AudioEngine();
  readonly events = new EventBus();
  readonly particles: Particles;
  readonly decals: Decals;
  readonly weather: Weather;
  readonly vehicles: VehicleManager;
  readonly cameraRig: CameraRig;
  readonly combat: Combat;
  readonly economy: Economy;
  readonly hud: HUD;
  player!: Player;
  readonly characters = new Set<Character>();
  /** Подключаемые системы. */
  traffic: GameModule | null = null;
  peds: Pedestrians | null = null;
  police: Police | null = null;
  missions: MissionSystem | null = null;
  shops: Shops | null = null;
  packages: Packages | null = null;
  readonly markers: Markers;
  settings: Settings | null = null;
  ui: UI | null = null;
  minimap: Minimap | null = null;
  /** Пауза симуляции (магазин/меню поверх игры). */
  paused = false;
  /** Машина игрока в гараже (сохраняется). */
  garageCar: Vehicle | null = null;
  lastPlayerVehicle: Vehicle | null = null;
  readonly modules: GameModule[] = [];

  state: GameState = 'loading';
  time = 0;
  /** Время суток, ч. */
  hours = 20.5;
  /** Скорость часов: игровых минут в реальную секунду. */
  timeScale = 1;
  difficulty = 1;
  private engineSounds = new Map<Vehicle, EngineSound>();
  private sirens = new Map<Vehicle, SirenSound>();
  private flashT = 0;
  /** Обработчики, вызываемые каждый кадр (миссионные триггеры, UI). */
  readonly frameHooks: ((dt: number) => void)[] = [];
  private deadTimer = 0;
  onRespawn: ((kind: 'dead' | 'busted') => void) | null = null;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement, quality: QualityName) {
    this.engine = new Engine(canvas, quality);
    this.physics = new Physics();
    this.world = new World(this.engine.scene);
    this.world.applyPreset(this.engine.preset);
    this.input = new Input(canvas);
    this.particles = new Particles(this.engine.scene);
    this.decals = new Decals(this.engine.scene);
    this.weather = new Weather(this, this.engine.preset.rainCount);
    this.vehicles = new VehicleManager(this);
    this.cameraRig = new CameraRig(this);
    this.combat = new Combat(this);
    this.economy = new Economy(this);
    this.hud = new HUD(this, uiRoot);
    this.markers = new Markers(this);
    this.engine.presetListeners.push((p) => {
      this.world.applyPreset(p);
      this.weather.setCount(p.rainCount);
      this.particles.density = p.name === 'low' ? 0.5 : p.name === 'medium' ? 0.8 : 1;
    });
    // Статические коллайдеры мира.
    this.physics.addStatic(this.world.staticColliders());
    this.physics.addTrimesh(this.world.terrain.physVerts, this.world.terrain.physIdx);
    this.world.onPropColliders = (add, rem) => this.physics.updateProps(add, rem);
    // Игрок.
    const g = this.world.layout.place('bus');
    this.player = new Player(this, new THREE.Vector3(g.x, 0.2, g.z));
    this.characters.add(this.player.char);
    this.player.char.onDeath = (victim, killer) => { this.events.emit('death', { victim, killer }); this.onPlayerDeath(); };
    this.events.on('death', (e) => this.onDeathEvent(e.victim, e.killer));
    // ИИ: трафик, пешеходы, полиция.
    this.traffic = new Traffic(this);
    this.peds = new Pedestrians(this);
    this.police = new Police(this);
    this.modules.push(this.traffic, this.peds, this.police);
  }

  // ======================================================================
  // Главный цикл
  // ======================================================================
  /** Пропуск рендера (тесты/бенчмарки): симуляция идёт, кадр не рисуется. */
  skipRender = false;

  /** Прогнать симуляцию на seconds секунд без рендера (для автотестов в headless). */
  simulate(seconds: number, step = 1 / 30) {
    this.skipRender = true;
    for (let t = 0; t < seconds; t += step) this.update(step);
    this.skipRender = false;
  }

  update(rawDt: number) {
    const dt = Math.min(Math.max(rawDt, 0.0001), 0.066);
    this.input.poll();
    if ((this.state === 'playing' || this.state === 'dead') && !this.paused) {
      this.time += dt;
      this.hours = (this.hours + (dt * this.timeScale) / 60) % 24;
      this.economy.stats.playTime += dt;
      this.player.update(dt);
      this.physics.step(dt);
      this.vehicles.update(dt);
      for (const m of this.modules) m.update(dt);
      this.markers.update(dt);
      this.updateCharacters(dt);
      this.player.sync(dt);
      this.vehicleHits();
      this.cameraRig.update(dt);
      for (const h of this.frameHooks) h(dt);
      if (this.state === 'dead') this.updateDead(dt);
      this.updateSounds();
    } else {
      for (const h of this.frameHooks) h(dt);
    }
    this.weather.update(dt, this.hours);
    this.particles.update(dt);
    this.world.update(this.engine.camera.position, this.time);
    // Вспышка взрыва — кратковременное усиление рассеянного света.
    if (this.flashT > 0) {
      this.flashT = Math.max(0, this.flashT - dt * 3);
      this.engine.sky.hemi.intensity += this.flashT * 3;
    }
    this.audio.updateListener(this.engine.camera);
    if (!this.skipRender) this.engine.render(Math.max(rawDt, 0.0001), this.hours);
    else this.engine.camera.updateMatrixWorld();
    if (this.state !== 'menu') { this.hud.update(dt); this.minimap?.update(); }
    if (!this.skipRender) this.input.endFrame();
  }

  /** Обновление NPC: дальние не рендерятся и не анимируются, тени — только у ближних. */
  private updateCharacters(dt: number) {
    const cam = this.engine.camera.position;
    const shadowR = this.engine.preset.name === 'low' ? 0 : this.engine.preset.name === 'medium' ? 35 : 60;
    for (const c of this.characters) {
      if (c === this.player.char) continue;
      if (!c.alive) c.deadTime += dt;
      const d2 = c.pos.distanceToSquared(cam);
      const far = d2 > 95 * 95;
      if (far) { c.object.visible = false; continue; }
      c.model.mesh.castShadow = d2 < shadowR * shadowR;
      c.sync(dt);
    }
    this.player.char.model.mesh.castShadow = this.engine.preset.name !== 'low' || !this.player.vehicle;
  }

  /** Машины сбивают пешеходов и игрока. */
  private vehicleHits() {
    const pl = this.player;
    for (const v of this.vehicles.list) {
      const sp = Math.abs(v.speed);
      if (sp < 3.5 || v.spec.type === 'heli' || v.spec.type === 'boat') continue;
      const vp = v.position();
      const f = v.forward();
      const hx = v.spec.half[0] + 0.35, hz = v.spec.half[2] + 0.35;
      for (const c of this.characters) {
        if (c.vehicle || (!c.alive && c.deadTime > 0.5)) continue;
        const dx = c.pos.x - vp.x, dz = c.pos.z - vp.z;
        if (dx * dx + dz * dz > 36 || Math.abs(c.pos.y - vp.y) > 2.5) continue;
        const lz = dx * f.x + dz * f.z;
        const lx = dx * f.z - dz * f.x;
        if (Math.abs(lz) > hz || Math.abs(lx) > hx) continue;
        const push = new THREE.Vector3(f.x * Math.sign(v.speed), 0, f.z * Math.sign(v.speed));
        if (c === pl.char) pl.knockDown(push, sp);
        else {
          if (!c.alive) continue;
          c.vel.copy(push).multiplyScalar(sp * 0.7);
          const killed = c.damage(sp * 6, v.playerDriving ? pl.char : v.driver, this.time);
          this.particles.blood(c.chest(new THREE.Vector3()), push);
          this.audio.punch(c.pos);
          this.events.emit('pedHit', { victim: c, vehicle: v, speed: sp });
          if (killed && v.playerDriving) this.economy.stats.kills++;
        }
      }
    }
  }

  // ======================================================================
  // Звук двигателей и сирен (только ближайшие источники)
  // ======================================================================
  private updateSounds() {
    if (!this.audio.ctx) return;
    const cam = this.engine.camera.position;
    const cand = this.vehicles.list
      .filter((v) => (v.engineOn || v.kinematic || v.playerDriving) && !v.destroyed)
      .map((v) => ({ v, d: v.position().distanceTo(cam) }))
      .filter((o) => o.d < 90 || o.v.playerDriving || (o.v.spec.type === 'heli' && o.d < 400))
      .sort((a, b) => a.d - b.d)
      .slice(0, 5);
    const keep = new Set(cand.map((c) => c.v));
    for (const [v, s] of this.engineSounds) if (!keep.has(v)) { s.stop(); this.engineSounds.delete(v); }
    for (const { v } of cand) {
      let s = this.engineSounds.get(v);
      const kind = v.spec.type === 'heli' ? 'heli' : v.spec.type === 'moto' ? 'moto' : v.spec.type === 'boat' ? 'boat' : 'car';
      if (!s) { s = new EngineSound(this.audio, kind); this.engineSounds.set(v, s); }
      const rpm = kind === 'heli' ? v.rotorSpeed : clamp(Math.abs(v.speed) / (v.spec.maxSpeed * 0.55) % 1.0 * 0.7 + Math.abs(v.speed) / v.spec.maxSpeed * 0.3, 0, 1);
      const load = Math.abs(v.ctl.throttle) || (v.kinematic ? 0.3 : 0);
      s.set(v.position(), rpm, load, v.playerDriving ? 1 : 0.6);
    }
    const sirensNear = this.vehicles.list.filter((v) => v.siren && !v.destroyed).map((v) => ({ v, d: v.position().distanceTo(cam) })).sort((a, b) => a.d - b.d).slice(0, 2);
    const sk = new Set(sirensNear.map((o) => o.v));
    for (const [v, s] of this.sirens) if (!sk.has(v)) { s.stop(); this.sirens.delete(v); }
    for (const { v } of sirensNear) {
      let s = this.sirens.get(v);
      if (!s) { s = new SirenSound(this.audio); this.sirens.set(v, s); }
      s.set(v.position(), 1);
    }
    const night = this.engine.sky.night;
    this.audio.setHum(0.04 + (1 - night) * 0.03);
  }

  stopVehicleSounds() {
    for (const s of this.engineSounds.values()) s.stop();
    for (const s of this.sirens.values()) s.stop();
    this.engineSounds.clear();
    this.sirens.clear();
  }

  // ======================================================================
  // Колбэки систем
  // ======================================================================
  flash(_pos: THREE.Vector3, k: number) {
    this.flashT = Math.max(this.flashT, k);
  }

  onCharacterHit(victim: Character, attacker: Character | null, dmg: number) {
    if (victim === this.player.char) {
      this.cameraRig.shake(Math.min(0.4, dmg / 60));
    }
    this.peds?.panic(victim.pos, 25);
    this.peds?.onHit(victim, attacker);
  }

  private onDeathEvent(victim: Character, killer: Character | null) {
    if (killer === this.player.char && victim !== this.player.char) {
      this.economy.stats.kills++;
      if (victim.team === 'cop') this.economy.stats.copsKilled++;
    }
  }

  /** Враждебен ли персонаж игроку (для автонаведения). */
  isHostile(c: Character): boolean {
    if (c.team === 'enemy') return true;
    if (c.team === 'cop') return (this.police?.wanted ?? 0) > 0;
    return false;
  }

  ejectDriver(v: Vehicle) {
    const d = this.peds?.ejectDriver(v) ?? null;
    if (!d && v.driver) v.driver = null;
  }

  onEnterVehicle(v: Vehicle) {
    this.audio.init();
    this.lastPlayerVehicle = v;
    if (v.kind === 'police') v.siren = false;
  }

  onExitVehicle(_v: Vehicle) {
    /* пусто: миссии подписываются через frameHooks */
  }

  onHorn(_v: Vehicle) {
    /* пешеходы отпрыгивают — обрабатывается в Pedestrians через события */
  }

  currentDistrictName(): string {
    const p = this.player.char.pos;
    const d = this.world.districtName(p.x, p.z);
    if (d === 'hills') return 'Вельмарские холмы';
    if (d === 'beach') return 'Солнечный Берег';
    if (d === 'port') return 'Доки Вельмара';
    if (d === 'road') return this.lastDistrictName;
    this.lastDistrictName = DISTRICT_NAMES[d as keyof typeof DISTRICT_NAMES] ?? this.lastDistrictName;
    return this.lastDistrictName;
  }
  private lastDistrictName = 'Порт-Вельмар';

  // ======================================================================
  // Смерть / арест
  // ======================================================================
  private onPlayerDeath() {
    this.state = 'dead';
    this.deadTimer = 0;
    this.economy.stats.deaths++;
    this.hud.showBanner('ЛЕВ ПОГИБ', 'Больница Св. Марка спишет $100 и 10% наличных', 'bad', 4500);
    this.audio.ui('fail');
  }

  /** Арест (вызывает полиция). */
  bust() {
    if (this.state !== 'playing') return;
    this.state = 'dead';
    this.deadTimer = 0;
    this.player.state = 'busted';
    this.player.char.model.anim.handsUp = true;
    if (this.player.vehicle) this.player.exitVehicle(true);
    this.economy.stats.arrests++;
    this.hud.showBanner('АРЕСТОВАН', 'Адвокат обошёлся в 15% наличных', 'bad', 4500);
    this.audio.ui('fail');
  }

  private updateDead(dt: number) {
    this.deadTimer += dt;
    this.engine.sky.weather.fogBoost = Math.min(1, this.deadTimer * 0.3);
    if (this.deadTimer < 4.5) return;
    const busted = this.player.state === 'busted';
    const place = this.world.layout.place(busted ? 'police' : 'hospital');
    const fee = busted ? Math.floor(this.economy.money * 0.15) : 100 + Math.floor(this.economy.money * 0.1);
    this.economy.money = Math.max(0, this.economy.money - fee);
    this.player.char.model.anim.handsUp = false;
    this.player.respawn(new THREE.Vector3(place.x, 0.3, place.z), Math.PI);
    this.world.preload(place.x, place.z);
    this.cameraRig.snapBehind(Math.PI);
    this.police?.clear();
    this.state = 'playing';
    this.onRespawn?.(busted ? 'busted' : 'dead');
  }

  /** Новый персонаж-NPC в мире. */
  spawnCharacter(outfit = randomOutfit(Math.random), team: Character['team'] = 'civ', pos?: THREE.Vector3): Character {
    const c = new Character(outfit, team);
    if (pos) c.pos.copy(pos);
    c.onDeath = (victim, killer) => this.events.emit('death', { victim, killer });
    this.engine.scene.add(c.object);
    this.characters.add(c);
    return c;
  }

  removeCharacter(c: Character) {
    this.characters.delete(c);
    c.object.removeFromParent();
    c.model.dispose();
  }

  get night() {
    return SharedUniforms.uNight.value;
  }
}
