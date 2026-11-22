/**
 * Движок миссий: сценарий = последовательность шагов (Step). Библиотека шагов:
 * диалог/катсцена, «доехать до», «сесть в транспорт», «уничтожить всех», погоня,
 * гонка, стелс, «оторваться от полиции», ожидание, произвольное действие.
 * Общие условия провала (смерть, арест, гибель напарника, уничтожение ключевой машины).
 */
import * as THREE from 'three';
import type { Game, GameModule } from './Game';
import type { Character } from '../entities/Character';
import type { Vehicle } from '../entities/Vehicle';
import { OUTFITS, randomOutfit } from '../entities/CharacterModel';
import { makeShooter, type ShooterAI } from '../ai/ShooterAI';
import { DriverAI } from '../ai/DriverAI';
import type { WeaponId } from '../entities/Weapons';
import type { VehicleKind } from '../render/VehicleModels';
import type { WorldMarker, Blip, TargetArrow } from './Markers';
import { clamp } from '../core/MathUtil';

export type StepStatus = 'run' | 'done' | 'fail';
export interface Step {
  start?(m: MissionRun): void;
  update(m: MissionRun, dt: number): StepStatus;
  end?(m: MissionRun): void;
}

export interface MissionDef {
  id: string;
  title: string;
  giver: string;
  /** Где стоит маркер начала. */
  where: () => THREE.Vector3;
  desc: string;
  reward: number;
  story: boolean;
  build: (m: MissionRun) => Step[];
}

export interface Speaker { name: string; color: string }
export const SPEAKERS: Record<string, Speaker> = {
  lev: { name: 'Лев', color: '#ffb13b' },
  sedoy: { name: 'Седой', color: '#c8c8c8' },
  nina: { name: 'Нина', color: '#ff6b4a' },
  baron: { name: 'Барон', color: '#ffd23b' },
  drobova: { name: 'Капитан Дробова', color: '#6ea8ff' },
  knut: { name: 'Кнут', color: '#7dff5a' },
  zhora: { name: 'Жора Шнырь', color: '#d8a0ff' },
  thug: { name: 'Громила', color: '#ff7a7a' },
  radio: { name: 'Рация', color: '#9cd7ff' },
  client: { name: 'Пассажир', color: '#e0e0e0' },
};

export interface Line { who: string; text: string; ms?: number }

/** Состояние запущенной миссии. */
export class MissionRun {
  idx = 0;
  steps: Step[];
  readonly actors = new Map<string, Character>();
  readonly chars: Character[] = [];
  readonly vehicles: Vehicle[] = [];
  readonly enemies: Character[] = [];
  readonly drivers = new Map<Vehicle, DriverAI>();
  readonly data: Record<string, unknown> = {};
  readonly blips: Blip[] = [];
  readonly markers: WorldMarker[] = [];
  readonly arrows: TargetArrow[] = [];
  /** Проверки провала: вернуть текст причины или null. */
  readonly guards: (() => string | null)[] = [];
  failReason = '';
  objectiveText = '';
  stepStarted = false;
  elapsed = 0;

  constructor(readonly game: Game, readonly def: MissionDef) {
    this.steps = def.build(this);
  }

  objective(text: string) {
    this.objectiveText = text;
    this.game.hud.setObjective(text);
  }

  /** Сюжетный персонаж (без ИИ гуляния). */
  actor(key: string, outfitKey: keyof typeof OUTFITS, pos: THREE.Vector3, yaw = 0, team: Character['team'] = 'ally'): Character {
    const c = this.game.spawnCharacter(OUTFITS[outfitKey], team, pos);
    c.yaw = yaw;
    this.game.peds?.makeScripted(c);
    this.actors.set(key, c);
    this.chars.push(c);
    return c;
  }

  enemy(pos: THREE.Vector3, weapon: WeaponId, opts: Partial<ShooterAI> = {}, outfit: keyof typeof OUTFITS | null = 'thug'): Character {
    const c = this.game.spawnCharacter(outfit ? OUTFITS[outfit] : randomOutfit(Math.random), 'enemy', pos);
    c.maxHealth = c.health = 70;
    makeShooter(c, weapon, { mode: 'attack', target: this.game.player.char, accuracy: 0.45, ...opts });
    this.enemies.push(c);
    this.chars.push(c);
    return c;
  }

  vehicle(kind: VehicleKind, pos: THREE.Vector3, yaw: number, paint?: number): Vehicle {
    const v = this.game.vehicles.spawn(kind, pos, yaw, { paint });
    v.persistent = true;
    v.tag = 'mission';
    this.vehicles.push(v);
    return v;
  }

  driver(v: Vehicle): DriverAI {
    let d = this.drivers.get(v);
    if (!d) { d = new DriverAI(this.game, v); this.drivers.set(v, d); v.engineOn = true; }
    return d;
  }

  blip(b: Partial<Blip> & { kind: Blip['kind'] }) {
    const x = this.game.markers.addBlip(b);
    this.blips.push(x);
    return x;
  }

  marker(pos: THREE.Vector3, r = 3, color: THREE.ColorRepresentation = 0xffd23b) {
    const m = this.game.markers.addMarker(pos, r, color);
    this.markers.push(m);
    return m;
  }

  arrow(color: THREE.ColorRepresentation, c?: Character, v?: Vehicle) {
    const a = this.game.markers.addArrow(color, c, v);
    this.arrows.push(a);
    return a;
  }

  clearMarks() {
    for (const b of this.blips) this.game.markers.removeBlip(b);
    for (const m of this.markers) this.game.markers.removeMarker(m);
    for (const a of this.arrows) this.game.markers.removeArrow(a);
    this.blips.length = this.markers.length = this.arrows.length = 0;
    this.game.markers.gpsTarget = null;
  }

  /** Удалить всё созданное миссией. */
  cleanup(keepVehicles = false) {
    this.clearMarks();
    for (const c of this.chars) if (c !== this.game.player.char) this.game.removeCharacter(c);
    for (const v of this.vehicles) {
      if (v.playerDriving && keepVehicles) { v.persistent = false; v.tag = 'owned'; continue; }
      if (!v.playerDriving) this.game.vehicles.remove(v);
      else { v.persistent = false; v.tag = 'owned'; }
    }
    this.game.hud.setObjective('');
    this.game.hud.setTimer(null);
    this.game.hud.setSubtitle('', '');
  }
}

// ===========================================================================
// Библиотека шагов
// ===========================================================================
const _v = new THREE.Vector3();

export const S = {
  /** Произвольное мгновенное действие. */
  run(fn: (m: MissionRun) => void): Step {
    return { update(m) { fn(m); return 'done'; } };
  },

  wait(sec: number): Step {
    let t = 0;
    return { start() { t = 0; }, update(_m, dt) { t += dt; return t >= sec ? 'done' : 'run'; } };
  },

  /** Затемнение экрана с действием в середине (смена времени/места). */
  fade(fn: (m: MissionRun) => void, text = ''): Step {
    let t = 0;
    let did = false;
    return {
      start(m) { t = 0; did = false; m.game.hud.fade(true, text); },
      update(m, dt) {
        t += dt;
        if (t > 0.7 && !did) { did = true; fn(m); }
        if (t > 1.6) { m.game.hud.fade(false); return 'done'; }
        return 'run';
      },
    };
  },

  /**
   * Диалог. Если игрок пешком — катсцена с кадрами камеры и рамкой; в машине — «по телефону».
   */
  talk(lines: Line[], opts: { phone?: boolean; listener?: string } = {}): Step {
    let i = -1;
    let t = 0;
    let dur = 0;
    let cine = false;
    const next = (m: MissionRun) => {
      i++;
      if (i >= lines.length) return false;
      const L = lines[i];
      const sp = SPEAKERS[L.who] ?? { name: L.who, color: '#fff' };
      dur = (L.ms ?? clamp(L.text.length * 58, 2300, 6500)) / 1000;
      t = 0;
      m.game.hud.setSubtitle((opts.phone ? '📱 ' : '') + sp.name, L.text, sp.color);
      for (const c of m.actors.values()) c.model.anim.talk = false;
      const speaker = L.who === 'lev' ? m.game.player.char : m.actors.get(L.who);
      if (speaker && cine) {
        speaker.model.anim.talk = true;
        const listener = L.who === 'lev' ? (m.actors.get(opts.listener ?? '') ?? [...m.actors.values()][0]) : m.game.player.char;
        S.shotFor(m, speaker, listener ?? null, i);
      }
      return true;
    };
    return {
      start(m) {
        i = -1;
        cine = !opts.phone && !m.game.player.vehicle;
        if (cine) {
          m.game.player.state = 'cutscene';
          m.game.hud.setLetterbox(true);
          // Персонажи поворачиваются друг к другу.
          const p = m.game.player.char;
          for (const c of m.actors.values()) {
            if (c.pos.distanceTo(p.pos) < 12 && c.alive) {
              c.yaw = Math.atan2(p.pos.x - c.pos.x, p.pos.z - c.pos.z);
              if (!c.vehicle) p.yaw = Math.atan2(c.pos.x - p.pos.x, c.pos.z - p.pos.z);
            }
          }
        } else m.game.audio.ui('phone');
        next(m);
      },
      update(m, dt) {
        t += dt;
        if (m.game.input.pressed('skip') || m.game.input.pressed('jump') && cine) t = dur;
        if (t >= dur && !next(m)) return 'done';
        return 'run';
      },
      end(m) {
        m.game.hud.setSubtitle('', '');
        for (const c of m.actors.values()) c.model.anim.talk = false;
        if (cine) {
          m.game.hud.setLetterbox(false);
          m.game.cameraRig.endShot();
          m.game.player.state = m.game.player.vehicle ? 'driving' : 'foot';
          m.game.cameraRig.snapBehind(m.game.player.char.yaw);
        }
      },
    };
  },

  /** Кадр камеры для реплики: крупный план или «через плечо». */
  shotFor(m: MissionRun, speaker: Character, listener: Character | null, i: number) {
    const head = speaker.pos.clone().setY(speaker.pos.y + 1.6);
    const f = speaker.forward();
    const right = new THREE.Vector3(-f.z, 0, f.x);
    let from: THREE.Vector3, look: THREE.Vector3;
    if (i % 2 === 0 || !listener) {
      from = head.clone().addScaledVector(f, 1.9).addScaledVector(right, 0.7).add(new THREE.Vector3(0, -0.05, 0));
      look = head.clone();
    } else {
      const lh = listener.pos.clone().setY(listener.pos.y + 1.6);
      from = lh.clone().addScaledVector(listener.forward(), -1.3).addScaledVector(new THREE.Vector3(-listener.forward().z, 0, listener.forward().x), -0.55).add(new THREE.Vector3(0, 0.15, 0));
      look = head.clone();
    }
    const to = from.clone().addScaledVector(right, 0.25);
    m.game.cameraRig.playShot({ from, to, lookFrom: look, lookTo: look.clone().add(new THREE.Vector3(0, 0.02, 0)), dur: 5, fov: 42 });
  },

  /** Доехать/дойти до точки. */
  goTo(pos: THREE.Vector3 | (() => THREE.Vector3), opts: { r?: number; text: string; vehicle?: 'any' | 'none' | (() => Vehicle | null); color?: number; time?: number; stop?: boolean; air?: boolean } ): Step {
    let target = new THREE.Vector3();
    let t = 0;
    return {
      start(m) {
        target = typeof pos === 'function' ? pos() : pos.clone();
        // Воздушные цели (крыша Шпиля) сохраняют высоту, наземные — прижимаются к поверхности.
        if (!opts.air) target.y = m.game.world.surfaceHeight(target.x, target.z);
        m.marker(target, opts.r ?? 3, opts.color ?? 0xffd23b);
        m.blip({ kind: 'dest', pos: target, label: opts.text, color: '#ffd23b' });
        m.game.markers.gpsTarget = target;
        m.objective(opts.text);
        t = opts.time ?? 0;
      },
      update(m, dt) {
        if (opts.time) {
          t -= dt;
          m.game.hud.setTimer(t);
          if (t <= 0) { m.failReason = 'Время вышло'; return 'fail'; }
        }
        const p = m.game.player;
        const pp = p.vehicle ? p.vehicle.position(_v) : p.char.pos;
        const d = Math.hypot(pp.x - target.x, pp.z - target.z);
        if (d > (opts.r ?? 3) + (p.vehicle ? 1.5 : 0) || Math.abs(pp.y - target.y) > (opts.air ? 14 : 6)) return 'run';
        const vreq = opts.vehicle;
        if (vreq === 'none' && p.vehicle) { m.game.hud.setPrompt('Выйдите из машины'); return 'run'; }
        if (vreq === 'any' && !p.vehicle) return 'run';
        if (typeof vreq === 'function' && p.vehicle !== vreq()) { m.game.hud.setPrompt('Нужна другая машина'); return 'run'; }
        if (opts.stop !== false && p.vehicle && Math.abs(p.vehicle.speed) > 3) { m.game.hud.setPrompt('Остановитесь'); return 'run'; }
        m.game.hud.setPrompt('');
        return 'done';
      },
      end(m) { m.clearMarks(); m.game.hud.setTimer(null); m.game.hud.setPrompt(''); },
    };
  },

  enterVehicle(get: () => Vehicle, text: string): Step {
    return {
      start(m) {
        const v = get();
        m.arrow(0x3be0ff, undefined, v);
        m.blip({ kind: 'target', vehicle: v, label: text, color: '#3be0ff' });
        m.objective(text);
      },
      update(m) {
        const v = get();
        if (v.destroyed) { m.failReason = 'Машина уничтожена'; return 'fail'; }
        return m.game.player.vehicle === v ? 'done' : 'run';
      },
      end(m) { m.clearMarks(); },
    };
  },

  /** Уничтожить всех врагов миссии. */
  killAll(text: string, filter?: (c: Character) => boolean): Step {
    return {
      start(m) {
        m.objective(text);
        for (const e of m.enemies) if (!filter || filter(e)) { m.arrow(0xff3b4e, e); m.blip({ kind: 'enemy', char: e, color: '#ff3b4e', edge: false }); }
      },
      update(m) {
        const left = m.enemies.filter((e) => e.alive && (!filter || filter(e))).length;
        m.game.hud.setObjective(`${text} <b>(${left})</b>`);
        return left === 0 ? 'done' : 'run';
      },
      end(m) { m.clearMarks(); },
    };
  },

  /** Оторваться от полиции. */
  loseWanted(text = 'Оторвитесь от полиции'): Step {
    return {
      start(m) { m.objective(text); },
      update(m) { return (m.game.police?.stars ?? 0) === 0 ? 'done' : 'run'; },
    };
  },

  /**
   * Погоня: цель уходит по городу; нужно уничтожить машину (или довести до minHealth).
   */
  chase(get: () => Vehicle, opts: { text: string; minHealth?: number; maxDist?: number }): Step {
    let lostT = 0;
    let goal = new THREE.Vector3();
    let goalT = 0;
    return {
      start(m) {
        const v = get();
        m.arrow(0xff3b4e, undefined, v);
        m.blip({ kind: 'target', vehicle: v, color: '#ff3b4e', label: 'Цель' });
        m.objective(opts.text);
        lostT = 0;
      },
      update(m, dt) {
        const g = m.game;
        const v = get();
        const hpFrac = v.health / v.maxHealth;
        if (v.destroyed || hpFrac < (opts.minHealth ?? 0)) return 'done';
        const pp = g.player.vehicle ? g.player.vehicle.position() : g.player.char.pos;
        const vp = v.position();
        const d = vp.distanceTo(pp);
        if (d > (opts.maxDist ?? 260)) { lostT += dt; g.hud.setPrompt(`Цель уходит! ${Math.ceil(10 - lostT)}`); }
        else { lostT = 0; g.hud.setPrompt(''); }
        if (lostT > 10) { m.failReason = 'Цель скрылась'; return 'fail'; }
        // Беглец выбирает дальние перекрёстки от игрока.
        goalT -= dt;
        if (goalT <= 0 || vp.distanceTo(goal) < 25) {
          goalT = 12;
          const graph = g.world.graph;
          let best = graph.nodes[0], bs = -Infinity;
          for (let k = 0; k < 30; k++) {
            const n = graph.nodes[Math.floor(Math.random() * graph.nodes.length)];
            if (n.i < 0) continue;
            const dv = Math.hypot(n.x - vp.x, n.z - vp.z);
            const dp = Math.hypot(n.x - pp.x, n.z - pp.z);
            const score = dp - Math.abs(dv - 300) * 0.5;
            if (dv > 120 && score > bs) { bs = score; best = n; }
          }
          goal = new THREE.Vector3(best.x, 0, best.z);
        }
        const dr = m.driver(v);
        dr.skill = 1.15;
        dr.driveSmart(goal, v.spec.maxSpeed * 0.75, dt);
        return 'run';
      },
      end(m) { m.clearMarks(); m.game.hud.setPrompt(''); },
    };
  },

  /** Гонка по контрольным точкам против соперников. */
  race(cps: THREE.Vector3[], rivals: () => Vehicle[], opts: { text: string; place?: number }): Step {
    let next = 0;
    let marker: WorldMarker | null = null;
    let blip: Blip | null = null;
    const prog = new Map<Vehicle, number>();
    let finished: (Vehicle | 'player')[] = [];
    const show = (m: MissionRun) => {
      if (marker) m.game.markers.removeMarker(marker);
      if (blip) m.game.markers.removeBlip(blip);
      const p = cps[next];
      marker = m.game.markers.addMarker(p, 7, next === cps.length - 1 ? 0xffffff : 0x3be0ff, 25);
      blip = m.game.markers.addBlip({ kind: 'checkpoint', pos: p, color: '#3be0ff' });
      m.game.markers.gpsTarget = p;
    };
    return {
      start(m) {
        next = 0; finished = [];
        for (const v of rivals()) { prog.set(v, 0); m.arrow(0xff6b4a, undefined, v); }
        show(m);
      },
      update(m, dt) {
        const g = m.game;
        const pv = g.player.vehicle;
        // Соперники едут по точкам.
        for (const v of rivals()) {
          const k = prog.get(v) ?? 0;
          if (k >= cps.length || v.destroyed) continue;
          const dr = m.driver(v);
          dr.skill = 1.25;
          dr.driveSmart(cps[k], v.spec.maxSpeed * 0.82, dt);
          if (v.position().distanceTo(cps[k]) < 14) {
            prog.set(v, k + 1);
            if (k + 1 >= cps.length) finished.push(v);
          }
        }
        if (pv && pv.position().distanceTo(cps[next]) < 12) {
          next++;
          g.audio.ui('ok');
          if (next >= cps.length) {
            finished.push('player');
            if (marker) g.markers.removeMarker(marker);
            if (blip) g.markers.removeBlip(blip);
            const place = finished.indexOf('player') + 1;
            m.data.place = place;
            if (place > (opts.place ?? 1)) { m.failReason = `Вы финишировали ${place}-м`; return 'fail'; }
            return 'done';
          }
          show(m);
        }
        if (finished.length >= rivals().length && !finished.includes('player') && rivals().length > 0) {
          m.failReason = 'Все соперники финишировали раньше';
          return 'fail';
        }
        // Текущее место.
        const myScore = next * 10000 - (pv ? pv.position().distanceTo(cps[Math.min(next, cps.length - 1)]) : 9999);
        let place = 1;
        for (const v of rivals()) {
          const k = prog.get(v) ?? 0;
          const sc = k * 10000 - (k < cps.length ? v.position().distanceTo(cps[k]) : 0);
          if (sc > myScore) place++;
        }
        g.hud.setObjective(`${opts.text} — <b>место ${place}/${rivals().length + 1}</b> · КТ ${next}/${cps.length}`);
        if (!pv) { g.hud.setPrompt('Вернитесь в машину!'); } else g.hud.setPrompt('');
        return 'run';
      },
      end(m) {
        if (marker) m.game.markers.removeMarker(marker);
        if (blip) m.game.markers.removeBlip(blip);
        m.clearMarks();
        m.game.hud.setPrompt('');
      },
    };
  },

  /** Стелс: сфотографировать точки, не попавшись охране. */
  stealth(points: THREE.Vector3[], text: string): Step {
    let done = 0;
    const markers: WorldMarker[] = [];
    let detected = false;
    let flash = 0;
    return {
      start(m) {
        done = 0; detected = false;
        for (const e of m.enemies) {
          const ai = e.brain as ShooterAI;
          ai.onDetect = () => { detected = true; };
        }
        points.forEach((p) => markers.push(m.game.markers.addMarker(p, 1.5, 0x57e38a, 4)));
        for (const p of points) m.blip({ kind: 'dest', pos: p, color: '#57e38a' });
        m.objective(text);
      },
      update(m, dt) {
        const g = m.game;
        if (detected) { m.failReason = 'Охрана вас заметила'; return 'fail'; }
        flash = Math.max(0, flash - dt);
        // Подозрительность охраны — на HUD.
        const sus = Math.max(0, ...m.enemies.filter((e) => e.alive).map((e) => (e.brain as ShooterAI).suspicion));
        let prompt = sus > 0.05 ? `👁 ${'▮'.repeat(Math.ceil(sus * 10))}` : '';
        const p = g.player.char.pos;
        for (let i = 0; i < points.length; i++) {
          if (!markers[i] || !markers[i].group.parent) continue;
          if (p.distanceTo(points[i]) < 2.3) {
            prompt = '<kbd>E</kbd> Сфотографировать';
            if (g.input.pressed('interact')) {
              g.input.consume('interact');
              g.markers.removeMarker(markers[i]);
              done++;
              g.hud.photoFlash();
              g.audio.ui('click');
              g.hud.toast(`Снимок ${done}/${points.length}`, 'good');
            }
          }
        }
        g.hud.setPrompt(prompt);
        g.hud.setObjective(`${text} <b>(${done}/${points.length})</b>`);
        return done >= points.length ? 'done' : 'run';
      },
      end(m) {
        for (const mk of markers) m.game.markers.removeMarker(mk);
        markers.length = 0;
        m.clearMarks();
        m.game.hud.setPrompt('');
      },
    };
  },

  /** Шаг, создаваемый в момент старта (когда параметры известны только во время миссии). */
  lazy(make: (m: MissionRun) => Step): Step {
    let inner: Step | null = null;
    return {
      start(m) { inner = make(m); inner.start?.(m); },
      update(m, dt) { return inner ? inner.update(m, dt) : 'done'; },
      end(m) { inner?.end?.(m); },
    };
  },

  /** Обновлять ИИ врагов, пока идёт этот шаг (параллельно с другим). */
  withEnemies(inner: Step): Step {
    return {
      start(m) { inner.start?.(m); },
      update(m, dt) { return inner.update(m, dt); },
      end(m) { inner.end?.(m); },
    };
  },
};

// ===========================================================================
// Система миссий
// ===========================================================================
export class MissionSystem implements GameModule {
  current: MissionRun | null = null;
  /** Индекс следующей сюжетной миссии. */
  storyIndex = 0;
  readonly completed = new Set<string>();
  defs: MissionDef[] = [];
  side: MissionDef[] = [];
  private startMarker: WorldMarker | null = null;
  private startBlip: Blip | null = null;
  private sideMarkers: { def: MissionDef; marker: WorldMarker; blip: Blip }[] = [];
  private cooldown = 0;
  onPass: ((d: MissionDef) => void) | null = null;

  constructor(private game: Game) {}

  get active() {
    return !!this.current;
  }

  register(story: MissionDef[], side: MissionDef[]) {
    this.defs = story;
    this.side = side;
    this.refreshMarkers();
  }

  nextStory(): MissionDef | null {
    return this.defs[this.storyIndex] ?? null;
  }

  /** Маркеры начала: следующая сюжетная + побочные. */
  refreshMarkers() {
    const g = this.game;
    if (this.startMarker) g.markers.removeMarker(this.startMarker);
    if (this.startBlip) g.markers.removeBlip(this.startBlip);
    this.startMarker = null;
    this.startBlip = null;
    for (const s of this.sideMarkers) { g.markers.removeMarker(s.marker); g.markers.removeBlip(s.blip); }
    this.sideMarkers = [];
    if (this.current) return;
    const d = this.nextStory();
    if (d && this.storyIndex > 0) {
      const p = d.where();
      p.y = g.world.surfaceHeight(p.x, p.z);
      this.startMarker = g.markers.addMarker(p, 2.2, 0xffd23b, 30);
      this.startBlip = g.markers.addBlip({ kind: 'mission', pos: p, label: d.title, color: '#ffd23b', icon: d.giver[0].toUpperCase() });
    }
    for (const s of this.side) {
      const p = s.where();
      p.y = g.world.surfaceHeight(p.x, p.z);
      this.sideMarkers.push({ def: s, marker: g.markers.addMarker(p, 2.2, 0x3be0ff, 14), blip: g.markers.addBlip({ kind: 'side', pos: p, label: s.title, color: '#3be0ff', icon: s.giver }) });
    }
  }

  start(def: MissionDef) {
    if (this.current) return;
    const g = this.game;
    this.current = new MissionRun(g, def);
    this.refreshMarkers();
    g.markers.waypoint = null;
    g.hud.showBanner(def.title.toUpperCase(), def.story ? 'Сюжетная миссия' : 'Подработка', 'info', 2800);
    g.audio.ui('ok');
  }

  /** Проверка нажатия «действие» у маркера начала. Возвращает true, если обработано. */
  onInteract(): boolean {
    return false;
  }

  update(dt: number) {
    const g = this.game;
    this.cooldown -= dt;
    const run = this.current;
    if (!run) {
      // Игрок в маркере начала?
      const p = g.player.char.pos;
      const d = this.nextStory();
      let prompt = '';
      if (d && this.startMarker && p.distanceTo(this.startMarker.pos) < 2.6 && g.state === 'playing' && this.cooldown <= 0) {
        prompt = `<kbd>E</kbd> ${d.title}`;
        if (g.input.pressed('interact')) { g.input.consume('interact'); this.start(d); }
      }
      for (const s of this.sideMarkers) {
        if (p.distanceTo(s.marker.pos) < 2.6 && this.cooldown <= 0) {
          prompt = `<kbd>E</kbd> ${s.def.title}`;
          if (g.input.pressed('interact')) { g.input.consume('interact'); this.start(s.def); }
        }
      }
      if (prompt) g.hud.setPrompt(prompt);
      return;
    }
    run.elapsed += dt;
    // Общие условия провала.
    if (g.state === 'dead') { this.fail(g.player.state === 'busted' ? 'Вас арестовали' : 'Лев погиб'); return; }
    for (const chk of run.guards) {
      const r = chk();
      if (r) { this.fail(r); return; }
    }
    // ИИ врагов миссии.
    for (const e of run.enemies) if (e.alive && !e.vehicle && g.police) g.police.shooters.update(e, dt);
    const step = run.steps[run.idx];
    if (!step) { this.pass(); return; }
    if (!run.stepStarted) { run.stepStarted = true; step.start?.(run); }
    const st = step.update(run, dt);
    if (st === 'done') {
      step.end?.(run);
      run.idx++;
      run.stepStarted = false;
      if (run.idx >= run.steps.length) this.pass();
    } else if (st === 'fail') {
      step.end?.(run);
      this.fail(run.failReason || 'Миссия провалена');
    }
  }

  pass() {
    const g = this.game;
    const run = this.current;
    if (!run) return;
    const def = run.def;
    this.current = null;
    run.cleanup(true);
    g.economy.add(def.reward, def.title);
    g.hud.showBanner('МИССИЯ ВЫПОЛНЕНА', `+$${def.reward.toLocaleString('ru-RU')}`, 'good', 4000);
    g.audio.ui('pass');
    this.completed.add(def.id);
    if (def.story && this.defs[this.storyIndex] === def) this.storyIndex++;
    g.police?.setMinWanted(0);
    this.cooldown = 3;
    this.refreshMarkers();
    this.onPass?.(def);
  }

  fail(reason: string) {
    const g = this.game;
    const run = this.current;
    if (!run) return;
    this.current = null;
    // Активные шаги (катсцены) корректно завершаются.
    const step = run.steps[run.idx];
    if (run.stepStarted) step?.end?.(run);
    run.cleanup(false);
    g.hud.showBanner('МИССИЯ ПРОВАЛЕНА', reason, 'bad', 4000);
    g.audio.ui('fail');
    g.police?.setMinWanted(0);
    if (g.player.state === 'cutscene') g.player.state = 'foot';
    this.cooldown = 4;
    this.refreshMarkers();
  }

  /** Отмена (из меню паузы). */
  abort() {
    if (this.current) this.fail('Миссия отменена');
  }
}
