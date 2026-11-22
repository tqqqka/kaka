/**
 * Игрок: кинематический контроллер персонажа Rapier (бег, прыжок, ступеньки, склоны),
 * плавание, укрытия, стрельба с автонаведением, ближний бой, оружие и патроны,
 * посадка/высадка из транспорта и управление им.
 */
import * as THREE from 'three';
import { RAPIER, G_CHAR, G_STATIC, G_VEHICLE, groups } from '../core/Physics';
import { Character } from './Character';
import { OUTFITS } from './CharacterModel';
import { WEAPONS, WEAPON_ORDER, type WeaponId } from './Weapons';
import { WATER_Y } from '../world/CityLayout';
import { clamp, damp, dampAngle } from '../core/MathUtil';
import type { Vehicle } from './Vehicle';
import type { Game } from '../game/Game';

export type PlayerState = 'foot' | 'driving' | 'dead' | 'busted' | 'cutscene';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export class Player {
  readonly char: Character;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  private kcc: RAPIER.KinematicCharacterController;
  state: PlayerState = 'foot';
  vehicle: Vehicle | null = null;
  private vy = 0;
  grounded = true;
  sprinting = false;
  swimming = false;
  private fireCd = 0;
  private reloadT = 0;
  private punchCd = 0;
  private airStartY = 0;
  private stepT = 0;
  cover: { normal: THREE.Vector3 } | null = null;
  knockT = 0;
  /** Купленные стволы. */
  owned = new Set<WeaponId>(['fist']);
  /** Цель автонаведения (для подсветки в HUD). */
  aimTarget: Character | null = null;
  readonly aimPoint = new THREE.Vector3();
  /** Блокировка управления (катсцены/меню). */
  locked = false;
  autoAim = true;
  private hornT = 0;

  constructor(private game: Game, pos: THREE.Vector3) {
    this.char = new Character(OUTFITS.lev, 'player');
    this.char.maxHealth = 100;
    this.char.pos.copy(pos);
    game.engine.scene.add(this.char.object);
    const w = game.physics.world;
    this.body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y + 0.9, pos.z));
    this.collider = w.createCollider(
      RAPIER.ColliderDesc.capsule(0.52, 0.32).setCollisionGroups(groups(G_CHAR, G_STATIC)),
      this.body,
    );
    this.kcc = w.createCharacterController(0.03);
    this.kcc.enableAutostep(0.42, 0.25, false);
    this.kcc.enableSnapToGround(0.45);
    this.kcc.setMaxSlopeClimbAngle((52 * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.kcc.setApplyImpulsesToDynamicBodies(true);
    this.kcc.setCharacterMass(85);
  }

  get pos() {
    return this.char.pos;
  }

  /** Телепорт (загрузка, респаун, катсцены). */
  teleport(p: THREE.Vector3, yaw = this.char.yaw) {
    if (this.vehicle) this.exitVehicle(true);
    this.char.pos.copy(p);
    this.char.yaw = yaw;
    this.body.setTranslation({ x: p.x, y: p.y + 0.9, z: p.z }, true);
    this.body.setNextKinematicTranslation({ x: p.x, y: p.y + 0.9, z: p.z });
    this.vy = 0;
  }

  giveWeapon(id: WeaponId, ammo: number) {
    this.owned.add(id);
    const a = (this.char.ammo[id] ??= { mag: 0, reserve: 0 });
    a.reserve += ammo;
    if (a.mag === 0) this.reload(true, id);
  }

  private reload(instant: boolean, id = this.char.weapon) {
    const w = WEAPONS[id];
    const a = this.char.ammo[id];
    if (!a || w.mag === 0) return;
    const need = w.mag - a.mag;
    if (need <= 0 || a.reserve <= 0) return;
    if (!instant) { this.reloadT = w.reload; this.game.audio.ui('click'); }
    const take = Math.min(need, a.reserve);
    a.mag += take;
    a.reserve -= take;
  }

  selectWeapon(dir: number | WeaponId) {
    const owned = WEAPON_ORDER.filter((w) => this.owned.has(w));
    let next: WeaponId;
    if (typeof dir === 'string') { if (!this.owned.has(dir)) return; next = dir; }
    else {
      const i = owned.indexOf(this.char.weapon);
      next = owned[(i + dir + owned.length) % owned.length];
    }
    if (next !== this.char.weapon) {
      this.char.setWeapon(next);
      this.reloadT = 0;
      this.game.audio.ui('click');
    }
  }

  get reloading() {
    return this.reloadT > 0;
  }

  // ======================================================================
  update(dt: number) {
    const g = this.game;
    const c = this.char;
    this.fireCd -= dt;
    this.punchCd -= dt;
    if (this.reloadT > 0) this.reloadT -= dt;
    c.model.anim.punchT += dt;
    c.model.anim.recoilT += dt;
    if (!c.alive) {
      if (this.vehicle) this.exitVehicle(true);
      c.deadTime += dt;
      this.state = 'dead';
      return;
    }
    if (this.state === 'cutscene' || this.locked) {
      c.model.anim.speed = 0;
      c.model.anim.aiming = false;
      return;
    }
    if (this.vehicle) this.updateDriving(dt);
    else this.updateFoot(dt);
  }

  // ------------------------------------------------------------------ пешком
  private updateFoot(dt: number) {
    const g = this.game;
    const inp = g.input;
    const c = this.char;
    const anim = c.model.anim;
    const camYaw = g.cameraRig.yaw;
    // Нокдаун (сбит машиной/взрывом).
    if (this.knockT > 0) {
      this.knockT -= dt;
      anim.dead = this.knockT > 0.4;
      anim.speed = 0;
      this.moveKCC(dt, c.vel.x * 0.5, c.vel.z * 0.5);
      c.vel.multiplyScalar(Math.exp(-3 * dt));
      return;
    }
    anim.dead = false;
    // Направление движения относительно камеры.
    const fx = Math.sin(camYaw), fz = Math.cos(camYaw);
    const rx = -Math.cos(camYaw), rz = Math.sin(camYaw);
    const mx = inp.moveX, my = inp.moveY;
    const mlen = Math.min(1, Math.hypot(mx, my));
    let wx = fx * my + rx * mx, wz = fz * my + rz * mx;
    const wl = Math.hypot(wx, wz);
    if (wl > 0) { wx /= wl; wz /= wl; }
    const armed = c.weapon !== 'fist';
    const aiming = (inp.isHeld('aim') || (armed && inp.isHeld('fire'))) && !this.swimming && this.reloadT <= 0;
    anim.aiming = aiming && armed;
    this.sprinting = inp.isHeld('sprint') && mlen > 0.3 && !aiming && !this.cover;
    // --- Укрытие ---
    if (inp.pressed('cover')) {
      if (this.cover) this.cover = null;
      else this.tryCover();
    }
    let speed = mlen < 0.55 ? 2.0 * (mlen / 0.55) : 4.8;
    if (this.sprinting) speed = 7.4;
    if (aiming) speed = Math.min(speed, 2.6);
    if (this.cover) {
      const n = this.cover.normal;
      // Движение вдоль стены; отойти от стены — выйти из укрытия.
      const along = wx * -n.z + wz * n.x;
      if (wx * n.x + wz * n.z > 0.75 && mlen > 0.6) this.cover = null;
      else {
        wx = -n.z * Math.sign(along) ; wz = n.x * Math.sign(along);
        speed = Math.abs(along) > 0.3 ? 1.8 : 0;
        // Проверяем, что стена ещё рядом.
        const hit = g.physics.raycast(_v.copy(c.pos).setY(c.pos.y + 0.8), _v2.copy(n).negate(), 1.2, G_STATIC);
        if (!hit) this.cover = null;
      }
    }
    anim.crouch = this.cover && !aiming ? 1 : this.cover ? 0.3 : 0;
    if (this.swimming) speed = this.sprinting ? 3.4 : 2.2 * mlen;
    const vx = wx * speed * (mlen > 0.05 ? 1 : 0), vz = wz * speed * (mlen > 0.05 ? 1 : 0);
    // Плавное ускорение.
    c.vel.x = damp(c.vel.x, vx, this.grounded ? 12 : 2, dt);
    c.vel.z = damp(c.vel.z, vz, this.grounded ? 12 : 2, dt);
    // Поворот: при прицеливании — по камере, иначе по движению.
    if (aiming) c.yaw = dampAngle(c.yaw, camYaw, 18, dt);
    else if (this.cover) c.yaw = dampAngle(c.yaw, Math.atan2(this.cover.normal.x, this.cover.normal.z), 10, dt);
    else if (Math.hypot(c.vel.x, c.vel.z) > 0.3) c.yaw = dampAngle(c.yaw, Math.atan2(c.vel.x, c.vel.z), 10, dt);
    // Прыжок и гравитация.
    if (!this.swimming) {
      if (this.grounded && inp.pressed('jump') && !this.cover) {
        this.vy = 5.6;
        this.grounded = false;
        this.airStartY = c.pos.y;
      }
      this.vy -= 19 * dt;
      if (this.grounded && this.vy < 0) this.vy = -2;
    } else this.vy = 0;
    const wasGrounded = this.grounded;
    const vyBefore = this.vy;
    this.moveKCC(dt, c.vel.x, c.vel.z);
    if (!wasGrounded && this.grounded) {
      // Урон от падения.
      if (vyBefore < -15) {
        const dmg = (-vyBefore - 15) * 9;
        c.damage(dmg, null, g.time);
        g.cameraRig.shake(0.5);
      }
      g.audio.footstep(c.pos, g.weather.wet);
    }
    if (this.grounded && !wasGrounded) this.vy = -2;
    if (!this.grounded && wasGrounded) this.airStartY = c.pos.y;
    // Плавание.
    const waterDepth = WATER_Y - c.pos.y;
    if (!this.swimming && waterDepth > 1.15) {
      this.swimming = true;
      g.particles.splash(c.pos.clone().setY(WATER_Y), 1.2);
      g.audio.splash(c.pos);
      if (c.weapon !== 'fist') c.setWeapon('fist');
    } else if (this.swimming && waterDepth < 0.9) this.swimming = false;
    if (this.swimming) {
      const target = WATER_Y - 1.35;
      c.pos.y = damp(c.pos.y, target, 5, dt);
      this.body.setNextKinematicTranslation({ x: c.pos.x, y: c.pos.y + 0.9, z: c.pos.z });
    }
    anim.swim = this.swimming;
    const hs = Math.hypot(c.vel.x, c.vel.z);
    anim.speed = hs;
    anim.grounded = this.grounded || this.swimming;
    // Шаги.
    if (this.grounded && hs > 0.5) {
      this.stepT += dt * hs / 1.6;
      if (this.stepT > 1) { this.stepT = 0; g.audio.footstep(c.pos, g.weather.wet); if (g.weather.wet > 0.5 && Math.random() < 0.5) g.particles.splash(c.pos, 0.15); }
    }
    // --- Стрельба / ближний бой ---
    this.updateCombat(dt, aiming);
    // --- Оружие ---
    if (inp.pressed('nextWeapon')) this.selectWeapon(1);
    if (inp.pressed('prevWeapon')) this.selectWeapon(-1);
    (['w1', 'w2', 'w3', 'w4', 'w5'] as const).forEach((k, i) => { if (inp.pressed(k)) this.selectWeapon(WEAPON_ORDER[i]); });
    if (inp.pressed('reload')) this.reload(false);
    // --- Посадка в транспорт ---
    if (inp.pressed('enter')) {
      const v = g.vehicles.nearestEnterable(c.pos);
      if (v) this.enterVehicle(v);
    }
  }

  private moveKCC(dt: number, vx: number, vz: number) {
    const c = this.char;
    const desired = { x: vx * dt, y: this.vy * dt, z: vz * dt };
    this.kcc.computeColliderMovement(this.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(G_CHAR, G_STATIC | G_VEHICLE));
    const m = this.kcc.computedMovement();
    const t = this.body.translation();
    const nx = t.x + m.x, ny = t.y + m.y, nz = t.z + m.z;
    this.body.setNextKinematicTranslation({ x: nx, y: ny, z: nz });
    this.grounded = this.kcc.computedGrounded();
    // Защита от проваливания под мир.
    const floor = this.game.world.surfaceHeight(nx, nz);
    if (ny - 0.9 < floor - 1.5 && floor > WATER_Y) {
      this.body.setNextKinematicTranslation({ x: nx, y: floor + 1.0, z: nz });
      c.pos.set(nx, floor + 0.1, nz);
      this.vy = 0;
      return;
    }
    c.pos.set(nx, ny - 0.9, nz);
  }

  private tryCover() {
    const g = this.game;
    const c = this.char;
    const o = _v.copy(c.pos).setY(c.pos.y + 0.8);
    let best: { d: number; n: THREE.Vector3; p: THREE.Vector3 } | null = null;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const d = _v2.set(Math.sin(a), 0, Math.cos(a));
      const hit = g.physics.raycast(o, d, 1.6, G_STATIC | G_VEHICLE);
      if (hit && Math.abs(hit.normal.y) < 0.4 && (!best || hit.dist < best.d)) best = { d: hit.dist, n: hit.normal.clone().setY(0).normalize(), p: hit.point.clone() };
    }
    if (!best) return;
    this.cover = { normal: best.n };
    const target = best.p.clone().addScaledVector(best.n, 0.45);
    const t = this.body.translation();
    this.body.setNextKinematicTranslation({ x: target.x, y: t.y, z: target.z });
    c.pos.set(target.x, c.pos.y, target.z);
    c.vel.set(0, 0, 0);
  }

  private updateCombat(dt: number, aiming: boolean) {
    const g = this.game;
    const inp = g.input;
    const c = this.char;
    const w = WEAPONS[c.weapon];
    // Точка прицела: луч из камеры.
    const cam = g.engine.camera;
    const dir = g.cameraRig.aimDir;
    const hit = g.physics.raycast(cam.position, dir, 250, G_STATIC | G_VEHICLE);
    this.aimPoint.copy(cam.position).addScaledVector(dir, hit ? hit.dist : 250);
    // Автонаведение (на сенсорном экране и геймпаде — всегда, на мыши — мягко).
    this.aimTarget = null;
    if (aiming && c.weapon !== 'fist') {
      const auto = this.autoAim && g.input.lastDevice !== 'keyboard';
      const t = g.combat.autoAimTarget(cam.position, dir, c, auto ? 0.26 : 0.05, w.range);
      if (t) { this.aimTarget = t; this.aimPoint.copy(t.chest(_v)); }
    }
    c.model.anim.aimPitch = clamp(-Math.asin(dir.y) * 1, -0.9, 0.9) * -1;
    if (c.weapon === 'fist') {
      if ((inp.pressed('melee') || inp.pressed('fire')) && this.punchCd <= 0) {
        this.punchCd = 0.42;
        c.model.anim.punchT = 0;
        setTimeout(() => { if (c.alive) g.combat.melee(c); }, 140);
      }
      return;
    }
    if (inp.pressed('melee') && this.punchCd <= 0) {
      this.punchCd = 0.5;
      c.model.anim.punchT = 0;
      setTimeout(() => { if (c.alive) g.combat.melee(c, 22); }, 140);
    }
    const a = c.ammo[c.weapon];
    const wantFire = w.auto ? inp.isHeld('fire') : inp.pressed('fire');
    if (wantFire && aiming && this.fireCd <= 0 && this.reloadT <= 0 && a) {
      if (a.mag <= 0) {
        if (a.reserve > 0) this.reload(false);
        else { g.audio.ui('error'); this.fireCd = 0.3; }
        return;
      }
      a.mag--;
      this.fireCd = 1 / w.rate;
      c.model.anim.recoilT = 0;
      const muzzle = c.model.weaponSlot.getWorldPosition(new THREE.Vector3());
      const f = _v2.copy(this.aimPoint).sub(muzzle).normalize();
      muzzle.addScaledVector(f, w.twoHanded ? 0.45 : 0.2);
      g.combat.fire(c, w, muzzle, f, this.cover ? 1.2 : 1);
      g.cameraRig.pitch -= w.recoil;
      g.cameraRig.shake(w.recoil * 2);
      if (a.mag === 0 && a.reserve > 0) this.reload(false);
    }
  }

  // ------------------------------------------------------------------ транспорт
  enterVehicle(v: Vehicle) {
    const g = this.game;
    if (v.driver && v.driver !== this.char) {
      // Вытаскиваем водителя.
      const d = v.driver;
      g.ejectDriver(v);
      g.events.emit('vehicleStolen', { vehicle: v, thief: this.char });
      void d;
    } else if (!v.playerDriving && v.tag !== 'owned' && v.tag !== 'mission') {
      g.events.emit('vehicleStolen', { vehicle: v, thief: this.char });
    }
    if (v.kinematic) v.setKinematic(false);
    this.cover = null;
    this.vehicle = v;
    this.state = 'driving';
    v.playerDriving = true;
    v.engineOn = true;
    v.driver = null;
    this.char.vehicle = v;
    this.char.model.anim.aiming = false;
    // Пешеход не сталкивается в машине.
    this.collider.setEnabled(false);
    const showRider = v.spec.type === 'moto' || v.spec.type === 'boat';
    this.char.visible = showRider;
    if (showRider) {
      v.visual.add(this.char.object);
      this.char.object.position.set(0, v.spec.type === 'moto' ? 0.15 : 0.35, v.spec.seat[2]);
      this.char.object.rotation.set(0, 0, 0);
      this.char.model.anim.sit = 1;
    }
    g.audio.ui('click');
    g.onEnterVehicle(v);
  }

  exitVehicle(force = false) {
    const g = this.game;
    const v = this.vehicle;
    if (!v) return;
    const fast = Math.abs(v.speed) > 7 && !force;
    v.playerDriving = false;
    v.ctl.throttle = 0; v.ctl.brake = 0; v.ctl.steer = 0; v.ctl.handbrake = true;
    if (v.spec.type !== 'heli') v.engineOn = false;
    this.vehicle = null;
    this.char.vehicle = null;
    this.state = 'foot';
    this.char.visible = true;
    this.char.model.anim.sit = 0;
    if (this.char.object.parent !== g.engine.scene) g.engine.scene.add(this.char.object);
    // Точка выхода: у двери, если там не стена; иначе сверху.
    const p = v.exitPoint(new THREE.Vector3());
    const vp = v.position();
    const side = p.clone().sub(vp).setY(0);
    const blocked = g.physics.raycast(vp.clone().setY(vp.y + 0.8), side.clone().normalize(), side.length() + 0.4, G_STATIC);
    if (blocked) p.copy(vp).add(new THREE.Vector3(0, v.spec.half[1] * 2 + 1, 0));
    else p.y = Math.max(vp.y, g.world.surfaceHeight(p.x, p.z)) + 0.1;
    this.collider.setEnabled(true);
    this.char.pos.copy(p);
    this.char.yaw = v.yaw;
    this.body.setTranslation({ x: p.x, y: p.y + 0.9, z: p.z }, true);
    this.body.setNextKinematicTranslation({ x: p.x, y: p.y + 0.9, z: p.z });
    this.vy = 0;
    if (fast) {
      // Выпрыгнул на ходу — кувырок и урон.
      const f = v.forward().multiplyScalar(v.speed * 0.5);
      this.char.vel.set(f.x, 0, f.z);
      this.knockT = 1.3;
      this.char.damage(Math.min(30, Math.abs(v.speed) * 1.2), null, g.time);
    }
    g.onExitVehicle(v);
  }

  private updateDriving(dt: number) {
    const g = this.game;
    const inp = g.input;
    const v = this.vehicle!;
    const c = v.ctl;
    this.char.pos.copy(v.position());
    if (v.spec.type === 'heli') {
      const up = (inp.isHeld('jump') || inp.isHeld('up') ? 1 : 0) + inp.gasAxis * (inp.lastDevice === 'gamepad' ? 1 : 0);
      const down = inp.isHeld('sprint') || inp.isHeld('down') || inp.isHeld('brake') ? 1 : 0;
      const touchUp = inp.isHeld('gas') ? 1 : 0;
      c.lift = clamp(up + touchUp - down - (inp.lastDevice === 'gamepad' ? inp.brakeAxis : 0), -1, 1);
      c.pitch = inp.moveY;
      c.roll = inp.moveX;
      const yawKeys = (inp.isHeld('yawL') ? 1 : 0) - (inp.isHeld('yawR') ? 1 : 0);
      c.yaw = clamp(yawKeys - inp.lookX * 0.03, -1, 1);
    } else {
      const gas = Math.max(inp.gasAxis, inp.moveY > 0.25 ? inp.moveY : 0);
      const brk = Math.max(inp.brakeAxis, inp.moveY < -0.25 ? -inp.moveY : 0);
      if (brk > 0.05 && v.speed > 1.0) { c.brake = brk; c.throttle = 0; }
      else if (brk > 0.05) { c.brake = 0; c.throttle = -brk; }
      else { c.brake = 0; c.throttle = gas; }
      c.steer = -inp.moveX;
      c.handbrake = inp.isHeld('jump') || inp.isHeld('handbrake');
    }
    if (inp.isHeld('horn') && v.spec.type !== 'boat') {
      this.hornT -= dt;
      if (this.hornT <= 0) { g.audio.horn(v.position()); this.hornT = 0.33; g.onHorn(v); }
    } else this.hornT = 0;
    if (inp.pressed('radio')) g.hud.toast(g.audio.cycleRadio());
    if (v.kind === 'police' && inp.pressed('camera')) v.siren = !v.siren;
    // Встать на колёса.
    if (v.isUpsideDown() && Math.abs(v.speed) < 2 && inp.pressed('jump')) v.flipUpright();
    if (inp.pressed('enter')) {
      if (v.spec.type === 'heli' && v.wheelsOnGround === 0 && v.position().y - g.world.surfaceHeight(v.position().x, v.position().z) > 4) {
        g.hud.toast('Сначала посадите вертолёт');
      } else this.exitVehicle();
    }
    if (v.destroyed && v.burnT < 0) this.exitVehicle(true);
  }

  /** Сбит машиной. */
  knockDown(dir: THREE.Vector3, speed: number) {
    if (this.vehicle || this.knockT > 0) return;
    this.knockT = 1.6;
    this.char.vel.copy(dir).multiplyScalar(speed * 0.6);
    this.vy = Math.min(6, speed * 0.3);
    this.grounded = false;
    this.char.damage(speed * 3.5, null, this.game.time);
  }

  respawn(p: THREE.Vector3, yaw: number) {
    this.char.revive(this.char.maxHealth);
    this.state = 'foot';
    this.knockT = 0;
    this.swimming = false;
    this.cover = null;
    this.teleport(p, yaw);
    this.collider.setEnabled(true);
  }

  sync(dt: number) {
    if (!this.vehicle || this.char.visible === false) {
      if (!this.vehicle) this.char.sync(dt);
      return;
    }
    // Сидит на мотоцикле/лодке — объект прикреплён к транспорту.
    this.char.model.update(dt);
  }
}
