/**
 * Транспорт: машины и мотоцикл (Rapier DynamicRayCastVehicleController),
 * лодка (плавучесть по точкам корпуса), вертолёт (аркадная аэродинамика).
 * Повреждения: по резкому изменению скорости, вмятины в геометрии, дым, пожар, взрыв.
 * Трафик может работать в кинематическом режиме (движется по полосам ИИ)
 * и переключаться в динамику при ДТП или когда в машину садится игрок.
 */
import * as THREE from 'three';
import { RAPIER, G_STATIC, G_VEHICLE, G_DEBRIS, groups } from '../core/Physics';
import { SPECS, vehicleGeometry, rotorGeometry, type VehicleKind, type VehicleSpec } from '../render/VehicleModels';
import { MaterialLib, type CarMaterialData } from '../render/Materials';
import { WATER_Y } from '../world/CityLayout';
import { clamp, damp } from '../core/MathUtil';
import type { Character } from './Character';
import type { Game } from '../game/Game';

let nextVid = 1;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

export interface VehicleControl {
  /** -1..1: газ вперёд/назад. */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1..1 (+ — влево). */
  steer: number;
  handbrake: boolean;
  /** Вертолёт: подъём -1..1, рыскание -1..1, тангаж/крен -1..1. */
  lift: number;
  yaw: number;
  pitch: number;
  roll: number;
}

export interface Upgrades { engine: number; brakes: number; armor: number }

export class Vehicle {
  readonly id = nextVid++;
  readonly spec: VehicleSpec;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  ctrl: RAPIER.DynamicRayCastVehicleController | null = null;
  readonly root = new THREE.Group();
  /** Узел для визуального крена мотоцикла. */
  readonly visual = new THREE.Group();
  readonly bodyMesh: THREE.Mesh;
  readonly mat: THREE.MeshStandardMaterial;
  private rotor: THREE.Mesh | null = null;
  private tailRotor: THREE.Mesh | null = null;
  health: number;
  maxHealth: number;
  destroyed = false;
  burnT = -1;
  sinkT = 0;
  driver: Character | null = null;
  /** Пассажиры (миссии: клиент такси, напарник). */
  passengers: Character[] = [];
  playerDriving = false;
  readonly ctl: VehicleControl = { throttle: 0, brake: 0, steer: 0, handbrake: false, lift: 0, yaw: 0, pitch: 0, roll: 0 };
  kinematic = false;
  /** Скорость вперёд (м/с), со знаком. */
  speed = 0;
  private prevVel = new THREE.Vector3();
  private steerCur = 0;
  readonly wheelSpin: number[] = [0, 0, 0, 0];
  private wheelLocal: THREE.Vector3[] = [];
  private wheelSusp: number[] = [0, 0, 0, 0];
  private wheelRest = 0.3;
  siren = false;
  sirenPhase = 0;
  headlights = false;
  hazard = false;
  engineOn = false;
  rotorSpeed = 0;
  lean = 0;
  upgrades: Upgrades = { engine: 0, brakes: 0, armor: 0 };
  /** Свой экземпляр геометрии (создаётся при первой вмятине). */
  private ownGeo = false;
  lastImpact = 0;
  lastDamager: Character | null = null;
  /** Метки миссий/ИИ. */
  tag = '';
  /** Время последнего «присутствия» рядом с игроком — для деспавна. */
  lastSeen = 0;
  /** ИИ-водитель (трафик/полиция). */
  ai: unknown = null;
  /** Не удалять менеджером (миссионная). */
  persistent = false;
  inWater = false;
  readonly paint: THREE.Color;
  wheelsOnGround = 0;
  airTime = 0;

  constructor(private game: Game, readonly kind: VehicleKind, pos: THREE.Vector3, yaw: number, opts: { kinematic?: boolean; paint?: number } = {}) {
    const spec = (this.spec = SPECS[kind]);
    this.health = this.maxHealth = spec.health;
    const paint = opts.paint ?? spec.paints[Math.floor(Math.random() * spec.paints.length)];
    this.paint = new THREE.Color(paint);
    this.mat = MaterialLib.createCarMaterial(paint, spec.paint2 ?? 0xffffff);
    this.bodyMesh = new THREE.Mesh(vehicleGeometry(kind), this.mat);
    this.bodyMesh.castShadow = true;
    this.bodyMesh.receiveShadow = true;
    this.visual.add(this.bodyMesh);
    this.root.add(this.visual);
    if (spec.type === 'heli') {
      const r = rotorGeometry();
      this.rotor = new THREE.Mesh(r.main, this.mat);
      this.rotor.position.set(0, 2.62, 0.5);
      this.tailRotor = new THREE.Mesh(r.tail, this.mat);
      this.tailRotor.position.set(0.15, 2.0, -4.35);
      this.visual.add(this.rotor, this.tailRotor);
    }
    game.engine.scene.add(this.root);

    // --- Физика ---
    const w = game.physics.world;
    _q.setFromAxisAngle(UP, yaw);
    const bd = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
      .setLinearDamping(spec.type === 'boat' ? 0.12 : spec.type === 'heli' ? 0.25 : 0.05)
      .setAngularDamping(spec.type === 'heli' ? 2.5 : spec.type === 'boat' ? 1.5 : 0.7)
      .setCanSleep(true)
      .setCcdEnabled(spec.type === 'car' || spec.type === 'moto');
    this.body = w.createRigidBody(bd);
    const [hx, hy, hz] = spec.half;
    const m = spec.mass;
    const comY = spec.type === 'car' || spec.type === 'moto' ? spec.colliderY - hy * 0.75 : spec.colliderY;
    const cd = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(0, spec.colliderY, 0)
      .setMassProperties(m, { x: 0, y: comY, z: 0 }, { x: m * (hy * hy + hz * hz) * 0.4, y: m * (hx * hx + hz * hz) * 0.4, z: m * (hx * hx + hy * hy) * 0.4 }, { x: 0, y: 0, z: 0, w: 1 })
      .setFriction(0.5)
      .setRestitution(0.1)
      .setCollisionGroups(groups(G_VEHICLE, G_STATIC | G_VEHICLE | G_DEBRIS));
    this.collider = w.createCollider(cd, this.body);
    game.physics.owners.set(this.collider.handle, this);

    if (spec.type === 'car' || spec.type === 'moto') this.setupWheels();
    if (opts.kinematic) this.setKinematic(true);
    this.syncVisual();
  }

  private setupWheels() {
    const s = this.spec;
    const vc = this.game.physics.world.createVehicleController(this.body);
    vc.indexUpAxis = 1;
    vc.setIndexForwardAxis = 2;
    const rest = s.type === 'moto' ? 0.25 : 0.3;
    const connY = s.wheelR + rest - 0.1;
    const pts: [number, number, number][] = [
      [s.track / 2, connY, s.wheelBase / 2], [-s.track / 2, connY, s.wheelBase / 2],
      [s.track / 2, connY, -s.wheelBase / 2], [-s.track / 2, connY, -s.wheelBase / 2],
    ];
    pts.forEach(([x, y, z], i) => {
      vc.addWheel({ x, y, z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, rest, s.wheelR);
      vc.setWheelSuspensionStiffness(i, s.kind === 'sport' ? 40 : 32);
      vc.setWheelSuspensionCompression(i, 2.6);
      vc.setWheelSuspensionRelaxation(i, 3.4);
      vc.setWheelMaxSuspensionForce(i, s.mass * 45);
      vc.setWheelMaxSuspensionTravel(i, 0.25);
      vc.setWheelFrictionSlip(i, s.grip);
      vc.setWheelSideFrictionStiffness(i, 1.0);
      this.wheelLocal.push(new THREE.Vector3(x, y, z));
      this.wheelRest = rest;
    });
    this.ctrl = vc;
  }

  get pos(): THREE.Vector3 {
    const t = this.body.translation();
    return _v.set(t.x, t.y, t.z);
  }
  position(out = new THREE.Vector3()) {
    const t = this.body.translation();
    return out.set(t.x, t.y, t.z);
  }
  quaternion(out = new THREE.Quaternion()) {
    const r = this.body.rotation();
    return out.set(r.x, r.y, r.z, r.w);
  }
  forward(out = new THREE.Vector3()) {
    return out.set(0, 0, 1).applyQuaternion(this.quaternion(_q));
  }
  get yaw(): number {
    const f = this.forward(_v2);
    return Math.atan2(f.x, f.z);
  }
  linvel(out = new THREE.Vector3()) {
    const v = this.body.linvel();
    return out.set(v.x, v.y, v.z);
  }

  // ------------------------------------------------------------------ режимы
  /** Кинематика для трафика: тело двигается ИИ, на него не действуют силы. */
  setKinematic(on: boolean) {
    if (on === this.kinematic) return;
    this.kinematic = on;
    this.body.setBodyType(on ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic, true);
    if (!on) {
      const f = this.forward(_v2).multiplyScalar(this.speed);
      this.body.setLinvel({ x: f.x, y: 0, z: f.z }, true);
      this.prevVel.set(f.x, 0, f.z);
    }
  }

  /** Перемещение в кинематическом режиме (вызывает ИИ трафика). */
  moveKinematic(x: number, y: number, z: number, yaw: number, speed: number, dt: number) {
    _q.setFromAxisAngle(UP, yaw);
    this.body.setNextKinematicTranslation({ x, y, z });
    this.body.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
    this.speed = speed;
    for (let i = 0; i < 4; i++) this.wheelSpin[i] += (speed / Math.max(0.2, this.spec.wheelR)) * dt;
  }

  teleport(p: THREE.Vector3, yaw: number) {
    _q.setFromAxisAngle(UP, yaw);
    this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    this.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.prevVel.set(0, 0, 0);
  }

  // ------------------------------------------------------------------ физика
  /** Силы перед шагом физики. */
  preStep(dt: number) {
    if (this.kinematic) return;
    const b = this.body;
    b.resetForces(false);
    b.resetTorques(false);
    const s = this.spec;
    // Собственный вектор: временные _v/_v2 переиспользуются внутри шагов.
    const fwd = this.forward(new THREE.Vector3());
    const vel = this.linvel(_v);
    this.speed = vel.dot(fwd);
    const active = !this.destroyed && (this.driver !== null || this.playerDriving) && this.sinkT < 1;
    if (active && b.isSleeping()) b.wakeUp();
    const c = this.ctl;
    if (s.type === 'car' || s.type === 'moto') this.wheeledStep(dt, active, fwd);
    else if (s.type === 'boat') this.boatStep(dt, active, fwd);
    else this.heliStep(dt, active);
    void c;
    // Машина в воде: тонет, двигатель глохнет.
    const t = b.translation();
    if (s.type !== 'boat' && s.type !== 'heli') {
      const depth = WATER_Y - (t.y + s.colliderY);
      this.inWater = depth > 0;
      if (depth > 0) {
        const lv = b.linvel();
        b.setLinvel({ x: lv.x * 0.96, y: lv.y * 0.9 + Math.min(depth, 1) * 0.12, z: lv.z * 0.96 }, true);
        this.sinkT += dt / 5;
        if (this.sinkT > 1 && !this.destroyed) { this.destroyed = true; this.health = 0; this.engineOn = false; }
      }
    }
  }

  private wheeledStep(dt: number, active: boolean, fwd: THREE.Vector3) {
    const vc = this.ctrl!;
    const s = this.spec;
    const c = this.ctl;
    const em = 1 + this.upgrades.engine * 0.18;
    let engine = 0;
    if (active) {
      const top = s.maxSpeed * (1 + this.upgrades.engine * 0.08);
      if (c.throttle > 0) {
        engine = c.throttle * s.engine * em;
        if (this.speed > top * 0.85) engine *= clamp((top - this.speed) / (top * 0.15), 0, 1);
        // Тяга на старте выше (момент на низких оборотах).
        if (this.speed < 8) engine *= 1.35;
      } else if (c.throttle < 0) {
        engine = c.throttle * s.engine * 0.6;
        if (this.speed < -14) engine = 0;
      }
    }
    const driven = s.drive === 'awd' ? [0, 1, 2, 3] : s.drive === 'fwd' ? [0, 1] : [2, 3];
    const brake = active ? c.brake * s.brake * (1 + this.upgrades.brakes * 0.25) : (this.destroyed ? 8 : 3);
    const roll = active && c.throttle === 0 && c.brake === 0 ? 0.6 : 0;
    // Руль: меньше угол на скорости, плавный поворот.
    const speedK = 1 / (1 + Math.abs(this.speed) * 0.11);
    const target = active ? c.steer * s.steer * speedK : 0;
    this.steerCur = damp(this.steerCur, target, 5.5, dt);
    for (let i = 0; i < 4; i++) {
      vc.setWheelEngineForce(i, driven.includes(i) ? engine / driven.length : 0);
      const hb = c.handbrake && active && i >= 2;
      vc.setWheelBrake(i, hb ? s.brake * 1.2 : brake + roll);
      vc.setWheelSteering(i, i < 2 ? this.steerCur : 0);
      // Ручник: задняя ось теряет сцепление — занос.
      vc.setWheelFrictionSlip(i, hb ? s.grip * 0.45 : s.grip * (this.destroyed ? 0.6 : 1));
    }
    vc.updateVehicle(dt, undefined, groups(G_VEHICLE, G_STATIC | G_VEHICLE));
    let ground = 0;
    for (let i = 0; i < 4; i++) if (vc.wheelIsInContact(i)) ground++;
    this.wheelsOnGround = ground;
    this.airTime = ground === 0 ? this.airTime + dt : 0;
    const b = this.body;
    // Прижимная сила и стабилизация.
    const v2 = this.speed * this.speed;
    if (ground > 0) b.addForce({ x: 0, y: -v2 * s.mass * 0.0035, z: 0 }, true);
    const q = this.quaternion(_q);
    const right = _v.set(1, 0, 0).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    if (s.type === 'moto' && !this.destroyed) {
      // Мотоцикл держится вертикально (визуальный крен отдельно).
      const av = b.angvel();
      const rollErr = right.y;
      const k = s.mass * 40;
      const fz = fwd;
      b.addTorque({ x: fz.x * rollErr * k - av.x * s.mass * 2, y: 0, z: fz.z * rollErr * k - av.z * s.mass * 2 }, true);
      this.lean = damp(this.lean, -this.steerCur * clamp(this.speed / 12, 0, 1) * 1.1, 6, dt);
    }
    // Помощь в воздухе: чуть выравнивать, чтобы машина реже переворачивалась.
    if (ground === 0 && active && up.y > 0.2) {
      const av = b.angvel();
      b.setAngvel({ x: av.x * 0.985, y: av.y, z: av.z * 0.985 }, true);
    }
  }

  private boatStep(dt: number, active: boolean, fwd: THREE.Vector3) {
    const b = this.body;
    const s = this.spec;
    const q = this.quaternion(_q);
    const t = b.translation();
    const [hx, , hz] = s.half;
    const pts = [[hx, -0.4, hz * 0.8], [-hx, -0.4, hz * 0.8], [hx, -0.4, -hz * 0.8], [-hx, -0.4, -hz * 0.8], [0, -0.5, 0], [0, -0.4, hz]];
    let submerged = 0;
    const time = this.game.time;
    for (const [x, y, z] of pts) {
      const p = _v.set(x, y, z).applyQuaternion(q).add(_v2.set(t.x, t.y, t.z));
      const wave = Math.sin(p.x * 0.21 + time * 1.1) * 0.12 + Math.sin(p.z * 0.37 + time * 1.6) * 0.08;
      const depth = WATER_Y + wave - p.y;
      if (depth > 0) {
        submerged++;
        const f = Math.min(depth, 0.8) * s.mass * 9.81 * 0.55;
        const pv = b.velocityAtPoint({ x: p.x, y: p.y, z: p.z });
        b.addForceAtPoint({ x: -pv.x * s.mass * 0.03, y: f - pv.y * s.mass * 0.6, z: -pv.z * s.mass * 0.03 }, { x: p.x, y: p.y, z: p.z }, true);
      }
    }
    this.wheelsOnGround = submerged;
    if (submerged > 0) {
      // Киль: гасим боковое скольжение.
      const v = b.linvel();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      const side = v.x * right.x + v.y * right.y + v.z * right.z;
      b.addForce({ x: -right.x * side * s.mass * 1.5, y: 0, z: -right.z * side * s.mass * 1.5 }, true);
      if (active) {
        const c = this.ctl;
        const thrust = (c.throttle > 0 ? c.throttle : c.throttle * 0.5) * s.engine * (1 + this.upgrades.engine * 0.15);
        const lim = this.speed > s.maxSpeed ? 0 : 1;
        b.addForce({ x: fwd.x * thrust * lim, y: 0, z: fwd.z * thrust * lim }, true);
        // Нос приподнимается на скорости.
        const stern = _v.set(0, 0, -hz).applyQuaternion(q);
        b.addForceAtPoint({ x: 0, y: -Math.abs(this.speed) * s.mass * 0.05, z: 0 }, { x: t.x + stern.x, y: t.y + stern.y, z: t.z + stern.z }, true);
        const turn = c.steer * s.mass * 2.2 * clamp(Math.abs(this.speed) / 6, 0.25, 1.5) * Math.sign(this.speed || 1);
        b.addTorque({ x: 0, y: turn, z: 0 }, true);
      }
    }
  }

  private heliStep(dt: number, active: boolean) {
    const b = this.body;
    const s = this.spec;
    const c = this.ctl;
    this.rotorSpeed = damp(this.rotorSpeed, active ? 1 : 0, active ? 0.8 : 0.3, dt);
    if (this.destroyed) this.rotorSpeed = damp(this.rotorSpeed, 0, 1, dt);
    const q = this.quaternion(_q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const g = 9.81 * s.mass;
    const rs = this.rotorSpeed;
    // Подъёмная сила вдоль оси винта, высота > 600 м — потолок.
    const t = b.translation();
    const ceiling = t.y > 600 ? 0.4 : 1;
    const lift = rs * rs * g * (1 + c.lift * 0.75) * ceiling * (this.destroyed ? 0.3 : 1);
    b.addForce({ x: up.x * lift, y: up.y * lift, z: up.z * lift }, true);
    if (rs > 0.3 && active) {
      // Целевые углы тангажа и крена; рыскание — скоростью.
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      const right = new THREE.Vector3(-1, 0, 0).applyQuaternion(q);
      const pitchNow = Math.asin(clamp(-fwd.y, -1, 1));
      const rollNow = Math.asin(clamp(right.y, -1, 1));
      const pitchT = c.pitch * 0.42, rollT = c.roll * 0.4;
      const av = b.angvel();
      const I = s.mass * 3;
      const tp = (pitchT - pitchNow) * I * 8;
      const tr = (rollT - rollNow) * I * 8;
      const flatRight = new THREE.Vector3(fwd.z, 0, -fwd.x).normalize();
      const flatFwd = new THREE.Vector3(fwd.x, 0, fwd.z).normalize();
      b.addTorque({
        x: flatRight.x * tp + flatFwd.x * tr - av.x * I * 2,
        y: c.yaw * I * 2.2 - av.y * I * 1.6,
        z: flatRight.z * tp + flatFwd.z * tr - av.z * I * 2,
      }, true);
    }
    // Ветер/сопротивление.
    const v = b.linvel();
    b.addForce({ x: -v.x * s.mass * 0.08, y: -v.y * s.mass * 0.25, z: -v.z * s.mass * 0.08 }, true);
  }

  /** После шага: детектор ударов по скачку скорости. */
  postStep(dt: number) {
    if (this.kinematic) return;
    const v = this.linvel(_v);
    const dv = _v2.copy(v).sub(this.prevVel);
    const mag = dv.length();
    const threshold = this.spec.type === 'heli' ? 5 : 3.5;
    if (mag > threshold && this.game.time - this.lastImpact > 0.15) {
      this.lastImpact = this.game.time;
      const dmg = (mag - threshold) * 48 * (this.spec.type === 'heli' ? 3 : 1);
      // Направление удара в локальных координатах (против изменения скорости).
      const local = dv.clone().negate().normalize().applyQuaternion(this.quaternion(_q).invert());
      this.damage(dmg, null, local);
      this.game.audio?.impact(this.position(), Math.min(1, mag / 15));
      this.game.particles.sparks(this.position().add(new THREE.Vector3(0, 0.6, 0)), dv.clone().normalize().negate(), Math.min(20, Math.round(mag)));
    }
    this.prevVel.copy(v);
    void dt;
  }

  // ------------------------------------------------------------------ урон
  damage(amount: number, by: Character | null, localDir?: THREE.Vector3) {
    if (this.destroyed) return;
    amount *= 1 - this.upgrades.armor * 0.18;
    if (this.kind === 'armored') amount *= 0.6;
    this.health -= amount;
    if (by) this.lastDamager = by;
    this.game.events.emit('vehicleDamaged', { vehicle: this, by, amount });
    if (localDir && amount > 25) this.dent(localDir, Math.min(0.28, amount / 900));
    if (this.health <= 0) {
      this.health = 0;
      if (this.burnT < 0) this.burnT = 0;
    }
  }

  /** Вмятина: смещаем вершины кузова у точки удара. */
  private dent(dir: THREE.Vector3, depth: number) {
    if (this.spec.type === 'heli' || this.spec.type === 'boat') return;
    if (!this.ownGeo) {
      this.bodyMesh.geometry = this.bodyMesh.geometry.clone();
      this.ownGeo = true;
    }
    const g = this.bodyMesh.geometry;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const [hx, hy, hz] = this.spec.half;
    const center = new THREE.Vector3(0, this.spec.colliderY, 0);
    // Точка удара на поверхности коробки кузова.
    const d = dir.clone().normalize();
    const k = Math.min(hx / Math.abs(d.x || 1e-6), hy / Math.abs(d.y || 1e-6), hz / Math.abs(d.z || 1e-6));
    const hit = center.clone().addScaledVector(d, k);
    const r = 0.9;
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i);
      const dist = p.distanceTo(hit);
      if (dist > r) continue;
      const f = (1 - dist / r) ** 2 * depth;
      p.addScaledVector(d, -f);
      p.y -= f * 0.3 * Math.sign(d.y + 0.01);
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
  }

  explode() {
    if (this.destroyed && this.burnT < 0) return;
    this.destroyed = true;
    this.burnT = -1;
    this.health = 0;
    (this.mat.userData as CarMaterialData).uBurnt.value = 1;
    const p = this.position().add(new THREE.Vector3(0, 0.8, 0));
    this.game.combat.explosion(p, 9, 140, this.lastDamager);
    this.body.applyImpulse({ x: (Math.random() - 0.5) * this.spec.mass * 2, y: this.spec.mass * 6, z: (Math.random() - 0.5) * this.spec.mass * 2 }, true);
    this.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * this.spec.mass * 3, y: 0, z: (Math.random() - 0.5) * this.spec.mass * 3 }, true);
    this.siren = false;
    this.headlights = false;
    this.engineOn = false;
    this.game.events.emit('vehicleDestroyed', { vehicle: this, by: this.lastDamager });
  }

  // ------------------------------------------------------------------ визуал
  update(dt: number) {
    const ud = this.mat.userData as CarMaterialData;
    // Пожар и взрыв.
    if (this.burnT >= 0) {
      this.burnT += dt;
      const hood = this.position().add(this.forward(_v2).multiplyScalar(this.spec.half[2] * 0.6)).add(new THREE.Vector3(0, this.spec.colliderY + 0.4, 0));
      if (Math.random() < 0.6) this.game.particles.fire(hood, 0.8);
      if (Math.random() < 0.5) this.game.particles.smoke(hood, 1, 1.2);
      if (this.burnT > 5) this.explode();
    } else if (!this.destroyed && this.health < this.maxHealth * 0.35 && Math.random() < 0.25) {
      const hood = this.position().add(this.forward(_v2).multiplyScalar(this.spec.half[2] * 0.6)).add(new THREE.Vector3(0, this.spec.colliderY + 0.4, 0));
      this.game.particles.smoke(hood, this.health < this.maxHealth * 0.2 ? 0.9 : 0.3, 0.6);
    }
    if (this.destroyed && Math.random() < 0.08) this.game.particles.smoke(this.position().add(new THREE.Vector3(0, 1, 0)), 0.9, 1.5);
    // Огни.
    const night = this.game.engine.sky.night > 0.5;
    const lightsOn = !this.destroyed && (this.engineOn || this.kinematic) && (night || this.game.weather.rain > 0.3);
    ud.uLights.value.x = lightsOn ? 1 : 0;
    ud.uLights.value.y = !this.destroyed && (this.ctl.brake > 0.1 || (this.kinematic && this.speed < 2)) ? 1 : 0;
    ud.uLights.value.z = this.hazard ? (Math.sin(this.game.time * 8) > 0 ? 1 : 0) : 0;
    ud.uLights.value.w = this.kind === 'taxi' && !this.destroyed ? 1 : 0;
    if (this.siren) this.sirenPhase += dt * 2.2;
    ud.uSiren.value.set(this.sirenPhase, this.siren ? 1 : 0);
    this.headlights = lightsOn;
    // Винты вертолёта.
    if (this.rotor) {
      this.rotor.rotation.y += this.rotorSpeed * dt * 28;
      this.tailRotor!.rotation.x += this.rotorSpeed * dt * 40;
    }
    this.syncVisual();
  }

  syncVisual() {
    const t = this.body.translation(), r = this.body.rotation();
    this.root.position.set(t.x, t.y, t.z);
    this.root.quaternion.set(r.x, r.y, r.z, r.w);
    if (this.spec.type === 'moto') this.visual.rotation.z = this.lean;
    else if (this.spec.type === 'boat') this.visual.rotation.x = -clamp(this.speed * 0.006, 0, 0.12);
  }

  /** Записывает матрицы колёс в общий инстанс-меш. Возвращает число записанных. */
  writeWheels(target: THREE.InstancedMesh, start: number): number {
    if (!this.wheelLocal.length || !this.root.visible) return 0;
    const s = this.spec;
    const vc = this.ctrl!;
    this.root.updateMatrixWorld();
    const n = s.type === 'moto' ? 2 : 4;
    for (let k = 0; k < n; k++) {
      const i = s.type === 'moto' ? k * 2 : k;
      let susp = this.wheelRest - 0.07;
      if (!this.kinematic) {
        susp = vc.wheelSuspensionLength(i) ?? 0.2;
        const spin = vc.wheelRotation(i) ?? 0;
        this.wheelSpin[i] = spin;
      }
      this.wheelSusp[i] = susp;
      const wl = this.wheelLocal[i];
      const x = s.type === 'moto' ? 0 : wl.x;
      _v.set(x, wl.y - susp, wl.z);
      const steer = i < 2 ? this.steerCur : 0;
      _q.setFromEuler(new THREE.Euler(-this.wheelSpin[i], steer, 0, 'YXZ'));
      _m.compose(_v, _q, _v2.set(s.wheelW, s.wheelR, s.wheelR));
      if (s.type === 'moto') _m.premultiply(new THREE.Matrix4().makeRotationZ(this.lean));
      _m.premultiply(this.root.matrixWorld);
      target.setMatrixAt(start + k, _m);
    }
    return n;
  }

  /** Есть ли место у водительской двери (куда ставить игрока при выходе). */
  exitPoint(out = new THREE.Vector3()): THREE.Vector3 {
    const q = this.quaternion(_q);
    const side = this.spec.type === 'moto' ? 0.9 : this.spec.half[0] + 0.7;
    out.set(side, 0, this.spec.type === 'moto' ? 0 : 0.3).applyQuaternion(q).add(this.position());
    return out;
  }

  isUpsideDown() {
    return new THREE.Vector3(0, 1, 0).applyQuaternion(this.quaternion(_q)).y < 0.2;
  }

  /** Перевернуть на колёса (кнопка «встать на колёса»). */
  flipUpright() {
    const p = this.position();
    p.y += 1.2;
    this.teleport(p, this.yaw);
  }

  dispose() {
    const w = this.game.physics.world;
    this.game.physics.owners.delete(this.collider.handle);
    if (this.ctrl) w.removeVehicleController(this.ctrl);
    w.removeRigidBody(this.body);
    this.game.engine.scene.remove(this.root);
    if (this.ownGeo) this.bodyMesh.geometry.dispose();
    MaterialLib.unregister(this.mat);
    this.mat.dispose();
  }
}
