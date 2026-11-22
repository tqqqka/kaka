/**
 * Процедурный персонаж: скелет из 18 костей, геометрия из примитивов,
 * жёстко привязанных к костям, — одна SkinnedMesh (1 draw call).
 * Анимации (ходьба/бег, прицел, удар, прыжок, присед, сидение, смерть, плавание)
 * вычисляются кодом каждый кадр.
 */
import * as THREE from 'three';
import { MaterialLib } from '../render/Materials';
import { clamp, damp, lerp } from '../core/MathUtil';

export enum B {
  root, spine, chest, neck, head,
  upperArmL, foreArmL, handL, upperArmR, foreArmR, handR,
  thighL, shinL, footL, thighR, shinR, footR,
}
const BONE_COUNT = 17;
const PARENT = [-1, 0, 1, 2, 3, 2, 5, 6, 2, 8, 9, 0, 11, 12, 0, 14, 15];
/** Позиции костей относительно родителя (покой). Персонаж смотрит в +Z, левая сторона +X. */
const OFFSET: [number, number, number][] = [
  [0, 0.95, 0], [0, 0.08, 0], [0, 0.2, 0], [0, 0.24, 0], [0, 0.07, 0],
  [0.21, 0.19, 0], [0, -0.28, 0], [0, -0.26, 0],
  [-0.21, 0.19, 0], [0, -0.28, 0], [0, -0.26, 0],
  [0.1, -0.06, 0], [0, -0.42, 0], [0, -0.41, 0],
  [-0.1, -0.06, 0], [0, -0.42, 0], [0, -0.41, 0],
];

/** Слоты цвета: 0 кожа, 1 верх, 2 низ, 3 обувь, 4 волосы, 5 тёмное (глаза/ремень), 6 акцент/головной убор. */
export interface Outfit {
  skin: number; top: number; bottom: number; shoes: number; hair: number; dark: number; accent: number;
  /** Длинный рукав (иначе предплечья — кожа). */
  sleeves: boolean;
  cap: boolean;
  /** Пиджак/куртка до бёдер. */
  jacket: boolean;
  bulk: number;
  height: number;
}

const WORLD_POS: THREE.Vector3[] = (() => {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < BONE_COUNT; i++) {
    const o = new THREE.Vector3(...OFFSET[i]);
    out.push(PARENT[i] >= 0 ? o.add(out[PARENT[i]]) : o);
  }
  return out;
})();

type Part = { geo: THREE.BufferGeometry; bone: number; slot: number };

function capsuleBetween(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 6): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CapsuleGeometry(r, Math.max(0.01, len - r * 0.6), 2, seg);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const dir = b.clone().sub(a).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  g.applyMatrix4(new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)));
  return g;
}
function boxAt(x: number, y: number, z: number, w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}
function sphereAt(x: number, y: number, z: number, sx: number, sy: number, sz: number, ws = 10, hs = 8, thetaLen = Math.PI): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, ws, hs, 0, Math.PI * 2, 0, thetaLen);
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

/** Базовая геометрия (общая для всех персонажей с данным набором опций). */
const baseCache = new Map<string, THREE.BufferGeometry>();
function buildBase(opts: { cap: boolean; jacket: boolean; sleeves: boolean }): THREE.BufferGeometry {
  const key = `${opts.cap}|${opts.jacket}|${opts.sleeves}`;
  const cached = baseCache.get(key);
  if (cached) return cached;
  const P = WORLD_POS;
  const parts: Part[] = [];
  const add = (geo: THREE.BufferGeometry, bone: number, slot: number) => parts.push({ geo, bone, slot });
  // Таз и торс.
  add(boxAt(0, 0.93, 0, 0.33, 0.2, 0.21), B.root, 2);
  add(boxAt(0, 0.99, 0.0, 0.335, 0.05, 0.215), B.root, 5); // ремень
  add(boxAt(0, 1.12, 0, 0.31, 0.2, 0.19), B.spine, 1);
  add(boxAt(0, 1.33, 0, 0.4, 0.3, 0.23), B.chest, 1);
  if (opts.jacket) {
    add(boxAt(0, 1.3, 0.005, 0.42, 0.34, 0.245), B.chest, 6);
    add(boxAt(0, 1.08, 0.005, 0.345, 0.26, 0.225), B.spine, 6);
    add(boxAt(0, 1.3, 0.122, 0.12, 0.3, 0.01), B.chest, 1); // рубашка в вырезе
  }
  // Шея и голова.
  add(capsuleBetween(new THREE.Vector3(0, 1.46, 0), new THREE.Vector3(0, 1.56, 0), 0.055), B.neck, 0);
  add(sphereAt(0, 1.64, 0.005, 0.105, 0.125, 0.115, 12, 10), B.head, 0);
  // Волосы: шапка сверху и затылок.
  add(sphereAt(0, 1.67, -0.008, 0.112, 0.105, 0.122, 12, 6, Math.PI * 0.55), B.head, 4);
  {
    const back = sphereAt(0, 0, 0, 0.114, 0.118, 0.118, 12, 6, Math.PI * 0.5);
    back.rotateX(-Math.PI * 0.42);
    back.translate(0, 1.645, -0.012);
    add(back, B.head, 4);
  }
  add(boxAt(0.038, 1.655, 0.105, 0.025, 0.014, 0.012), B.head, 5); // глаза
  add(boxAt(-0.038, 1.655, 0.105, 0.025, 0.014, 0.012), B.head, 5);
  add(boxAt(0, 1.625, 0.118, 0.022, 0.04, 0.025), B.head, 0); // нос
  add(boxAt(0, 1.585, 0.104, 0.045, 0.01, 0.01), B.head, 5); // рот
  if (opts.cap) {
    add(sphereAt(0, 1.7, 0, 0.118, 0.07, 0.125, 12, 6, Math.PI * 0.5), B.head, 6);
    add(boxAt(0, 1.705, 0.12, 0.17, 0.015, 0.09), B.head, 6);
  }
  // Руки.
  for (const side of [1, -1]) {
    const ua = side > 0 ? B.upperArmL : B.upperArmR, fa = side > 0 ? B.foreArmL : B.foreArmR, ha = side > 0 ? B.handL : B.handR;
    add(sphereAt(P[ua].x, P[ua].y - 0.02, 0, 0.075, 0.07, 0.075, 8, 6), B.chest, opts.jacket ? 6 : 1);
    add(capsuleBetween(P[ua], P[fa], 0.058), ua, opts.jacket ? 6 : 1);
    add(capsuleBetween(P[fa], P[ha], 0.049), fa, opts.sleeves || opts.jacket ? (opts.jacket ? 6 : 1) : 0);
    add(boxAt(P[ha].x, P[ha].y - 0.05, 0.01, 0.06, 0.1, 0.04), ha, 0);
  }
  // Ноги.
  for (const side of [1, -1]) {
    const th = side > 0 ? B.thighL : B.thighR, sh = side > 0 ? B.shinL : B.shinR, ft = side > 0 ? B.footL : B.footR;
    add(capsuleBetween(P[th], P[sh], 0.08), th, 2);
    add(capsuleBetween(P[sh], P[ft].clone().add(new THREE.Vector3(0, 0.04, 0)), 0.064), sh, 2);
    add(boxAt(P[ft].x, 0.045, 0.045, 0.105, 0.09, 0.26), ft, 3);
  }
  // Слияние с атрибутами костей и слотов.
  let vcount = 0;
  for (const p of parts) vcount += p.geo.getAttribute('position').count;
  const pos = new Float32Array(vcount * 3), nrm = new Float32Array(vcount * 3);
  const si = new Uint16Array(vcount * 4), sw = new Float32Array(vcount * 4), slot = new Float32Array(vcount);
  const idx: number[] = [];
  let off = 0;
  for (const p of parts) {
    const g = p.geo.index ? p.geo : p.geo;
    const pa = g.getAttribute('position'), na = g.getAttribute('normal');
    for (let i = 0; i < pa.count; i++) {
      pos.set([pa.getX(i), pa.getY(i), pa.getZ(i)], (off + i) * 3);
      nrm.set([na.getX(i), na.getY(i), na.getZ(i)], (off + i) * 3);
      si[(off + i) * 4] = p.bone;
      sw[(off + i) * 4] = 1;
      slot[off + i] = p.slot;
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(off + g.index.getX(i));
    else for (let i = 0; i < pa.count; i++) idx.push(off + i);
    off += pa.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  geo.setAttribute('aSlot', new THREE.BufferAttribute(slot, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  baseCache.set(key, geo);
  return geo;
}

let sharedMat: THREE.MeshStandardMaterial | null = null;
function material() {
  if (!sharedMat) sharedMat = MaterialLib.std({ color: 0xffffff, vertexColors: true, roughness: 0.72, metalness: 0.0 });
  return sharedMat;
}

/** Состояние анимации, которое выставляет контроллер (игрок/ИИ). */
export interface AnimState {
  speed: number;
  grounded: boolean;
  aiming: boolean;
  twoHanded: boolean;
  aimPitch: number;
  crouch: number;
  sit: number;
  swim: boolean;
  cower: boolean;
  dead: boolean;
  /** Время с начала удара/отдачи (сбрасывается в 0 при событии). */
  punchT: number;
  recoilT: number;
  talk: boolean;
  handsUp: boolean;
}

export class CharacterModel {
  readonly mesh: THREE.SkinnedMesh;
  readonly bones: THREE.Bone[] = [];
  readonly root = new THREE.Group();
  readonly anim: AnimState = {
    speed: 0, grounded: true, aiming: false, twoHanded: false, aimPitch: 0, crouch: 0, sit: 0,
    swim: false, cower: false, dead: false, punchT: 9, recoilT: 9, talk: false, handsUp: false,
  };
  private phase = Math.random() * 10;
  private deadT = 0;
  private deadSide = 1;
  private airT = 0;
  private cur = { crouch: 0, sit: 0, aim: 0, run: 0, swim: 0, cower: 0, handsUp: 0 };
  /** Крепление оружия в правой руке. */
  readonly weaponSlot = new THREE.Group();

  constructor(readonly outfit: Outfit) {
    const base = buildBase(outfit);
    // Свой атрибут цвета; остальные атрибуты общие с базовой геометрией.
    const geo = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'skinIndex', 'skinWeight']) geo.setAttribute(name, base.getAttribute(name));
    geo.setIndex(base.index);
    geo.boundingSphere = base.boundingSphere;
    const slots = base.getAttribute('aSlot');
    const cols = [outfit.skin, outfit.top, outfit.bottom, outfit.shoes, outfit.hair, outfit.dark, outfit.accent].map((c) => new THREE.Color(c));
    const ca = new Float32Array(slots.count * 3);
    for (let i = 0; i < slots.count; i++) {
      const c = cols[slots.getX(i)];
      ca[i * 3] = c.r; ca[i * 3 + 1] = c.g; ca[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(ca, 3));

    for (let i = 0; i < BONE_COUNT; i++) {
      const b = new THREE.Bone();
      b.position.set(...OFFSET[i]);
      this.bones.push(b);
      if (PARENT[i] >= 0) this.bones[PARENT[i]].add(b);
    }
    this.mesh = new THREE.SkinnedMesh(geo, material());
    this.mesh.add(this.bones[0]);
    // Матрицы костей должны быть актуальны до вычисления обратных bind-матриц.
    this.mesh.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(this.bones));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    const s = outfit.height;
    this.mesh.scale.set(s * outfit.bulk, s, s * outfit.bulk);
    this.root.add(this.mesh);
    // Оружие держится вдоль -Y кисти.
    this.weaponSlot.position.set(0, -0.08, 0.02);
    this.weaponSlot.rotation.x = Math.PI / 2;
    this.bones[B.handR].add(this.weaponSlot);
  }

  /** Процедурная анимация. */
  update(dt: number) {
    const a = this.anim;
    const bn = this.bones;
    for (const b of bn) b.rotation.set(0, 0, 0);
    bn[B.root].position.set(...OFFSET[0]);
    const c = this.cur;
    c.crouch = damp(c.crouch, a.crouch, 10, dt);
    c.sit = damp(c.sit, a.sit, 10, dt);
    c.aim = damp(c.aim, a.aiming ? 1 : 0, 14, dt);
    c.swim = damp(c.swim, a.swim ? 1 : 0, 5, dt);
    c.cower = damp(c.cower, a.cower ? 1 : 0, 8, dt);
    c.handsUp = damp(c.handsUp, a.handsUp ? 1 : 0, 8, dt);
    const run = clamp((a.speed - 2.5) / 3.5, 0, 1);
    c.run = damp(c.run, run, 6, dt);

    // --- Смерть: падение навзничь/ничком ---
    if (a.dead) {
      this.deadT = Math.min(1, this.deadT + dt * 2.2);
      const t = this.deadT;
      const e = t * t * (3 - 2 * t);
      this.mesh.rotation.x = -this.deadSide * e * Math.PI / 2;
      this.mesh.position.y = lerp(0, 0.16, e);
      bn[B.upperArmL].rotation.z = 0.9 * e; bn[B.upperArmR].rotation.z = -0.7 * e;
      bn[B.upperArmL].rotation.x = -0.4 * e;
      bn[B.thighL].rotation.x = -0.25 * e; bn[B.shinL].rotation.x = 0.5 * e;
      bn[B.neck].rotation.y = 0.5 * e;
      return;
    }
    if (this.deadT > 0) { this.deadT = 0; this.mesh.rotation.x = 0; this.mesh.position.y = 0; }
    this.deadSide = Math.random() < 0.5 ? 1 : -1;

    // --- Цикл шага ---
    const stride = lerp(1.35, 2.4, c.run);
    if (a.grounded && a.speed > 0.1) this.phase += (a.speed / stride) * Math.PI * dt;
    else if (a.speed <= 0.1) this.phase = damp(this.phase, Math.round(this.phase / Math.PI) * Math.PI, 6, dt);
    const ph = this.phase;
    const moveAmt = clamp(a.speed / 1.4, 0, 1);
    const amp = lerp(0.45, 0.85, c.run) * moveAmt;
    const s = Math.sin(ph), co = Math.cos(ph);
    bn[B.thighL].rotation.x = -s * amp;
    bn[B.thighR].rotation.x = s * amp;
    bn[B.shinL].rotation.x = Math.max(0, co) * amp * 1.3 + 0.05;
    bn[B.shinR].rotation.x = Math.max(0, -co) * amp * 1.3 + 0.05;
    bn[B.footL].rotation.x = -bn[B.thighL].rotation.x * 0.3;
    bn[B.footR].rotation.x = -bn[B.thighR].rotation.x * 0.3;
    bn[B.upperArmL].rotation.x = s * amp * 0.7;
    bn[B.upperArmR].rotation.x = -s * amp * 0.7;
    bn[B.foreArmL].rotation.x = -0.2 - c.run * 0.9;
    bn[B.foreArmR].rotation.x = -0.2 - c.run * 0.9;
    bn[B.upperArmL].rotation.z = 0.08;
    bn[B.upperArmR].rotation.z = -0.08;
    bn[B.root].position.y += Math.abs(Math.sin(ph)) * 0.035 * amp - 0.02 * c.run;
    bn[B.spine].rotation.x = 0.12 * c.run;
    bn[B.root].rotation.y = s * 0.08 * amp;
    bn[B.chest].rotation.y = -s * 0.12 * amp;
    // Дыхание в покое.
    bn[B.chest].rotation.x = Math.sin(performance.now() * 0.0015 + this.phase) * 0.015;

    // --- В воздухе ---
    if (!a.grounded && c.swim < 0.5) {
      this.airT += dt;
      const k = clamp(this.airT * 4, 0, 1);
      bn[B.thighL].rotation.x = lerp(bn[B.thighL].rotation.x, -0.7, k);
      bn[B.thighR].rotation.x = lerp(bn[B.thighR].rotation.x, -0.2, k);
      bn[B.shinL].rotation.x = lerp(bn[B.shinL].rotation.x, 1.0, k);
      bn[B.shinR].rotation.x = lerp(bn[B.shinR].rotation.x, 0.5, k);
      bn[B.upperArmL].rotation.z = 0.6 * k; bn[B.upperArmR].rotation.z = -0.6 * k;
    } else this.airT = 0;

    // --- Присед (укрытие) ---
    if (c.crouch > 0.01) {
      const k = c.crouch;
      bn[B.root].position.y -= 0.36 * k;
      bn[B.thighL].rotation.x += -1.3 * k; bn[B.thighR].rotation.x += -1.1 * k;
      bn[B.shinL].rotation.x += 1.9 * k; bn[B.shinR].rotation.x += 1.7 * k;
      bn[B.footL].rotation.x += -0.5 * k; bn[B.footR].rotation.x += -0.5 * k;
      bn[B.spine].rotation.x += 0.35 * k;
    }

    // --- Сидение (машина/мотоцикл) ---
    if (c.sit > 0.01) {
      const k = c.sit;
      for (const b of [B.thighL, B.thighR]) bn[b].rotation.x = lerp(bn[b].rotation.x, -1.45, k);
      for (const b of [B.shinL, B.shinR]) bn[b].rotation.x = lerp(bn[b].rotation.x, 1.35, k);
      for (const b of [B.upperArmL, B.upperArmR]) bn[b].rotation.x = lerp(bn[b].rotation.x, -1.0, k);
      for (const b of [B.foreArmL, B.foreArmR]) bn[b].rotation.x = lerp(bn[b].rotation.x, -0.5, k);
      bn[B.root].position.y = lerp(bn[B.root].position.y, 0.62, k);
      bn[B.spine].rotation.x = lerp(bn[B.spine].rotation.x, 0.25, k);
    }

    // --- Плавание ---
    if (c.swim > 0.01) {
      const k = c.swim;
      bn[B.root].rotation.x = lerp(0, 1.25, k);
      const st = performance.now() * 0.004;
      bn[B.upperArmL].rotation.x = lerp(bn[B.upperArmL].rotation.x, -1.6 + Math.sin(st) * 1.4, k);
      bn[B.upperArmR].rotation.x = lerp(bn[B.upperArmR].rotation.x, -1.6 - Math.sin(st) * 1.4, k);
      bn[B.thighL].rotation.x = lerp(bn[B.thighL].rotation.x, Math.sin(st * 2) * 0.3, k);
      bn[B.thighR].rotation.x = lerp(bn[B.thighR].rotation.x, -Math.sin(st * 2) * 0.3, k);
    }

    // --- Прицеливание: правая рука (и левая для двуручного) вперёд ---
    if (c.aim > 0.01) {
      const k = c.aim;
      const pitch = a.aimPitch;
      const recoil = Math.max(0, 1 - a.recoilT * 9) * 0.25;
      bn[B.upperArmR].rotation.x = lerp(bn[B.upperArmR].rotation.x, -Math.PI / 2 - pitch - recoil, k);
      bn[B.upperArmR].rotation.z = lerp(bn[B.upperArmR].rotation.z, a.twoHanded ? 0.15 : 0.05, k);
      bn[B.foreArmR].rotation.x = lerp(bn[B.foreArmR].rotation.x, a.twoHanded ? -0.15 : 0, k);
      if (a.twoHanded) {
        bn[B.upperArmL].rotation.x = lerp(bn[B.upperArmL].rotation.x, -Math.PI / 2 - pitch + 0.15, k);
        bn[B.upperArmL].rotation.z = lerp(bn[B.upperArmL].rotation.z, -0.75, k);
        bn[B.foreArmL].rotation.x = lerp(bn[B.foreArmL].rotation.x, -0.55, k);
      }
      bn[B.chest].rotation.y = lerp(bn[B.chest].rotation.y, a.twoHanded ? 0.35 : 0.1, k);
      bn[B.neck].rotation.y = lerp(0, a.twoHanded ? -0.3 : -0.1, k);
      bn[B.neck].rotation.x = -pitch * 0.4 * k;
    }

    // --- Удар рукой ---
    if (a.punchT < 0.45) {
      const t = a.punchT / 0.45;
      const p = t < 0.35 ? t / 0.35 : 1 - (t - 0.35) / 0.65;
      bn[B.upperArmR].rotation.x = lerp(bn[B.upperArmR].rotation.x, -1.55, p);
      bn[B.foreArmR].rotation.x = lerp(bn[B.foreArmR].rotation.x, -0.1, p);
      bn[B.chest].rotation.y += -0.5 * p;
      bn[B.upperArmL].rotation.x = lerp(bn[B.upperArmL].rotation.x, -1.1, 0.6);
      bn[B.foreArmL].rotation.x = -1.8;
    }

    // --- Испуг (руки на голове) / руки вверх ---
    if (c.cower > 0.01) {
      const k = c.cower;
      bn[B.upperArmL].rotation.x = lerp(bn[B.upperArmL].rotation.x, -2.7, k);
      bn[B.upperArmR].rotation.x = lerp(bn[B.upperArmR].rotation.x, -2.7, k);
      bn[B.upperArmL].rotation.z = lerp(bn[B.upperArmL].rotation.z, 0.5, k);
      bn[B.upperArmR].rotation.z = lerp(bn[B.upperArmR].rotation.z, -0.5, k);
      bn[B.foreArmL].rotation.x = lerp(bn[B.foreArmL].rotation.x, -2.0, k);
      bn[B.foreArmR].rotation.x = lerp(bn[B.foreArmR].rotation.x, -2.0, k);
      bn[B.spine].rotation.x += 0.4 * k;
    }
    if (c.handsUp > 0.01) {
      const k = c.handsUp;
      bn[B.upperArmL].rotation.z = lerp(bn[B.upperArmL].rotation.z, 2.6, k);
      bn[B.upperArmR].rotation.z = lerp(bn[B.upperArmR].rotation.z, -2.6, k);
      bn[B.foreArmL].rotation.z = lerp(0, 0.6, k);
      bn[B.foreArmR].rotation.z = lerp(0, -0.6, k);
    }

    // --- Жестикуляция в диалоге ---
    if (a.talk) {
      const t = performance.now() * 0.003 + this.phase;
      bn[B.upperArmR].rotation.x += -0.35 - Math.sin(t) * 0.25;
      bn[B.foreArmR].rotation.x += -0.6 - Math.sin(t * 1.3) * 0.3;
      bn[B.head].rotation.x = Math.sin(t * 2.1) * 0.06;
      bn[B.head].rotation.y = Math.sin(t * 0.7) * 0.15;
    }
  }

  /** Позиция кости в мире. */
  boneWorld(b: B, out: THREE.Vector3) {
    return this.bones[b].getWorldPosition(out);
  }

  dispose() {
    this.mesh.geometry.getAttribute('color');
    this.mesh.geometry.deleteAttribute('color');
  }
}

// ---------------------------------------------------------------------------
// Готовые наряды персонажей
// ---------------------------------------------------------------------------
const SKINS = [0xf1c7a5, 0xe0ac86, 0xc68a62, 0x9c6845, 0x6e4a32, 0xf6d6bd];
const HAIRS = [0x1d1612, 0x3b2a1e, 0x6b4a2c, 0xa77b48, 0x8c8c8c, 0x1a1a1a, 0x7a2c1a];
const TOPS = [0x2d4e7a, 0x8a2f2f, 0x3e6b45, 0xd8d2c4, 0x2b2b2e, 0x7a5c8c, 0xc8a040, 0x4f6f7f, 0xb86a3a, 0xeaeaea, 0x5a5a5a];
const BOTTOMS = [0x2b3442, 0x3a3226, 0x1f1f22, 0x4b5563, 0x6b5b45, 0x2f3b2f, 0x82735c];
const SHOES = [0x1a1a1a, 0x3b2a1e, 0xe8e8e8, 0x5a3a2a];

export function randomOutfit(r: () => number): Outfit {
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  return {
    skin: pick(SKINS), top: pick(TOPS), bottom: pick(BOTTOMS), shoes: pick(SHOES), hair: pick(HAIRS), dark: 0x18181a,
    accent: pick(TOPS), sleeves: r() < 0.5, cap: false, jacket: r() < 0.35, bulk: 0.92 + r() * 0.2, height: 0.93 + r() * 0.13,
  };
}

export const OUTFITS: Record<string, Outfit> = {
  lev: { skin: 0xe2b48f, top: 0x5c6670, bottom: 0x232b38, shoes: 0x1a1512, hair: 0x241a14, dark: 0x111111, accent: 0x3d2a1e, sleeves: true, cap: false, jacket: true, bulk: 1.02, height: 1.02 },
  nina: { skin: 0xf1c7a5, top: 0x2f4d5c, bottom: 0x2f4d5c, shoes: 0x3a2a20, hair: 0xa8341c, dark: 0x111111, accent: 0x2f4d5c, sleeves: false, cap: false, jacket: false, bulk: 0.9, height: 0.95 },
  baron: { skin: 0xe8c0a0, top: 0x1a1a1a, bottom: 0xe8e4da, shoes: 0x2a1c14, hair: 0x9a9a9a, dark: 0x111111, accent: 0xe8e4da, sleeves: true, cap: false, jacket: true, bulk: 1.08, height: 1.0 },
  sedoy: { skin: 0xd8a888, top: 0x6a6a6a, bottom: 0x1e1e22, shoes: 0x111111, hair: 0xb8b8b8, dark: 0x111111, accent: 0x202024, sleeves: true, cap: false, jacket: true, bulk: 1.05, height: 1.01 },
  drobova: { skin: 0xf0c8a8, top: 0xd8d8d8, bottom: 0x1c2433, shoes: 0x111111, hair: 0x3a2a1e, dark: 0x111111, accent: 0x1c2433, sleeves: true, cap: false, jacket: true, bulk: 0.92, height: 0.97 },
  cop: { skin: 0xe0ac86, top: 0x1d2b4a, bottom: 0x1a2236, shoes: 0x111111, hair: 0x2a2018, dark: 0x0e0e10, accent: 0x15203a, sleeves: true, cap: true, jacket: false, bulk: 1.03, height: 1.0 },
  swat: { skin: 0xc68a62, top: 0x24272b, bottom: 0x24272b, shoes: 0x111111, hair: 0x111111, dark: 0x0e0e10, accent: 0x1a1c1f, sleeves: true, cap: true, jacket: true, bulk: 1.12, height: 1.02 },
  thug: { skin: 0xd8a888, top: 0x2a2a2e, bottom: 0x2a2a2e, shoes: 0xe8e8e8, hair: 0x111111, dark: 0x111111, accent: 0x8a1c1c, sleeves: true, cap: false, jacket: true, bulk: 1.06, height: 1.0 },
  guard: { skin: 0xc68a62, top: 0x1e1e1e, bottom: 0x1e1e1e, shoes: 0x111111, hair: 0x111111, dark: 0x0e0e10, accent: 0x1e1e1e, sleeves: true, cap: true, jacket: true, bulk: 1.1, height: 1.03 },
};
