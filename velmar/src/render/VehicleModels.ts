/**
 * Процедурные модели транспорта. Кузов собирается из выдавленных профилей и
 * примитивов в одну геометрию с атрибутом aPart (краска/стекло/хром/фары...),
 * который материал «car» превращает в разные PBR-свойства. Колёса рисуются отдельно (инстансы).
 * Перёд машины смотрит в +Z.
 */
import * as THREE from 'three';
import { GeomBuilder } from '../world/GeomBuilder';

export type VehicleKind =
  | 'sedan' | 'sport' | 'suv' | 'van' | 'taxi' | 'police' | 'muscle' | 'armored'
  | 'moto' | 'boat' | 'heli' | 'policeHeli';

export const enum Part {
  Paint = 0, Glass = 1, Chrome = 2, Black = 3, Head = 4, Tail = 5, Interior = 6,
  SirenR = 7, SirenB = 8, Amber = 9, Paint2 = 10, Metal = 11, Sign = 12,
}

export interface VehicleSpec {
  kind: VehicleKind;
  name: string;
  type: 'car' | 'moto' | 'boat' | 'heli';
  /** Полуразмеры коллайдера кузова. */
  half: [number, number, number];
  /** Смещение центра коллайдера по Y относительно начала тела. */
  colliderY: number;
  wheelBase: number;
  track: number;
  wheelR: number;
  wheelW: number;
  /** Высота точки крепления подвески относительно начала тела. */
  wheelY: number;
  mass: number;
  engine: number;
  maxSpeed: number;
  brake: number;
  steer: number;
  grip: number;
  health: number;
  price: number;
  paints: number[];
  paint2?: number;
  camDist: number;
  camHeight: number;
  /** Ведущие колёса: 'rwd' | 'fwd' | 'awd'. */
  drive: 'rwd' | 'fwd' | 'awd';
  seat: [number, number, number];
}

const PAINTS = [0x8c1d1d, 0x1d3f8c, 0xe8e8e8, 0x1a1a1a, 0x5a5f66, 0x2f6b3a, 0xc9a227, 0x6a2c70, 0xb85a1d, 0x9aa3ad, 0x203040, 0x7a1f3d];

export const SPECS: Record<VehicleKind, VehicleSpec> = {
  sedan: { kind: 'sedan', name: 'Вега', type: 'car', half: [0.88, 0.45, 2.2], colliderY: 0.78, wheelBase: 2.7, track: 1.56, wheelR: 0.33, wheelW: 0.22, wheelY: -0.12, mass: 1300, engine: 5200, maxSpeed: 52, brake: 55, steer: 0.55, grip: 2.4, health: 1000, price: 2500, paints: PAINTS, camDist: 6.2, camHeight: 2.0, drive: 'fwd', seat: [0.38, 0.35, -0.2] },
  taxi: { kind: 'taxi', name: 'Вега Такси', type: 'car', half: [0.88, 0.45, 2.2], colliderY: 0.78, wheelBase: 2.7, track: 1.56, wheelR: 0.33, wheelW: 0.22, wheelY: -0.12, mass: 1320, engine: 5000, maxSpeed: 50, brake: 55, steer: 0.55, grip: 2.4, health: 1000, price: 2000, paints: [0xf0b81a], camDist: 6.2, camHeight: 2.0, drive: 'fwd', seat: [0.38, 0.35, -0.2] },
  police: { kind: 'police', name: 'Патруль', type: 'car', half: [0.9, 0.45, 2.25], colliderY: 0.78, wheelBase: 2.8, track: 1.6, wheelR: 0.34, wheelW: 0.23, wheelY: -0.12, mass: 1500, engine: 7400, maxSpeed: 60, brake: 60, steer: 0.55, grip: 2.7, health: 1300, price: 4000, paints: [0x141820], paint2: 0xe8e8e8, camDist: 6.4, camHeight: 2.0, drive: 'rwd', seat: [0.38, 0.35, -0.2] },
  sport: { kind: 'sport', name: 'Стрела GT', type: 'car', half: [0.95, 0.38, 2.15], colliderY: 0.6, wheelBase: 2.6, track: 1.66, wheelR: 0.34, wheelW: 0.28, wheelY: -0.1, mass: 1250, engine: 9500, maxSpeed: 72, brake: 70, steer: 0.5, grip: 3.2, health: 900, price: 9000, paints: [0xc01818, 0xf0c020, 0x1a1a1a, 0xe8e8e8, 0x1d5fd0, 0x26a050], camDist: 6.0, camHeight: 1.8, drive: 'rwd', seat: [0.4, 0.2, -0.3] },
  muscle: { kind: 'muscle', name: 'Буйвол', type: 'car', half: [0.95, 0.45, 2.4], colliderY: 0.75, wheelBase: 2.9, track: 1.62, wheelR: 0.35, wheelW: 0.27, wheelY: -0.12, mass: 1550, engine: 8800, maxSpeed: 64, brake: 60, steer: 0.5, grip: 2.6, health: 1200, price: 6500, paints: [0x1a1a1a, 0x7a1010, 0x204a80, 0xd0a020, 0x2a5a2a], camDist: 6.6, camHeight: 2.0, drive: 'rwd', seat: [0.4, 0.3, -0.4] },
  suv: { kind: 'suv', name: 'Тайга', type: 'car', half: [0.98, 0.62, 2.35], colliderY: 1.1, wheelBase: 2.85, track: 1.7, wheelR: 0.4, wheelW: 0.27, wheelY: -0.15, mass: 2000, engine: 7800, maxSpeed: 50, brake: 70, steer: 0.52, grip: 2.6, health: 1500, price: 5000, paints: PAINTS, camDist: 7.0, camHeight: 2.4, drive: 'awd', seat: [0.42, 0.6, -0.1] },
  van: { kind: 'van', name: 'Грузовичок', type: 'car', half: [1.0, 0.95, 2.6], colliderY: 1.33, wheelBase: 3.2, track: 1.76, wheelR: 0.38, wheelW: 0.25, wheelY: -0.15, mass: 2600, engine: 7600, maxSpeed: 40, brake: 80, steer: 0.5, grip: 2.4, health: 1700, price: 3000, paints: [0xe8e8e8, 0x2a4a7a, 0x8a8f94, 0xb84a2a], camDist: 8.5, camHeight: 3.0, drive: 'rwd', seat: [0.45, 0.85, 1.4] },
  armored: { kind: 'armored', name: 'Инкассатор', type: 'car', half: [1.1, 1.05, 2.9], colliderY: 1.5, wheelBase: 3.5, track: 1.9, wheelR: 0.45, wheelW: 0.32, wheelY: -0.2, mass: 5200, engine: 15000, maxSpeed: 38, brake: 120, steer: 0.48, grip: 2.6, health: 5000, price: 12000, paints: [0x4a5048], camDist: 9.5, camHeight: 3.3, drive: 'awd', seat: [0.5, 0.95, 1.7] },
  moto: { kind: 'moto', name: 'Оса 600', type: 'moto', half: [0.3, 0.4, 1.0], colliderY: 0.75, wheelBase: 1.45, track: 0.5, wheelR: 0.32, wheelW: 0.14, wheelY: -0.05, mass: 280, engine: 2600, maxSpeed: 64, brake: 22, steer: 0.45, grip: 2.6, health: 500, price: 3000, paints: [0xc01818, 0x1a1a1a, 0x1d5fd0, 0xf0c020, 0x26a050], camDist: 5.0, camHeight: 1.7, drive: 'rwd', seat: [0, 0.55, -0.25] },
  boat: { kind: 'boat', name: 'Чайка', type: 'boat', half: [1.2, 0.5, 3.5], colliderY: 0.0, wheelBase: 0, track: 0, wheelR: 0, wheelW: 0, wheelY: 0, mass: 1400, engine: 16000, maxSpeed: 30, brake: 0, steer: 0.6, grip: 0, health: 1400, price: 7000, paints: [0xe8e8e8, 0x1d3f8c, 0xc01818], paint2: 0x1d3f8c, camDist: 10, camHeight: 3.5, drive: 'rwd', seat: [0, 0.7, -0.8] },
  heli: { kind: 'heli', name: 'Сокол-2', type: 'heli', half: [1.0, 0.9, 2.4], colliderY: 1.25, wheelBase: 0, track: 0, wheelR: 0, wheelW: 0, wheelY: 0, mass: 1600, engine: 0, maxSpeed: 55, brake: 0, steer: 0, grip: 0, health: 1500, price: 20000, paints: [0x1d3f8c, 0xe8e8e8, 0x1a1a1a, 0xc01818], paint2: 0xe8e8e8, camDist: 13, camHeight: 4.0, drive: 'rwd', seat: [0.4, 0.9, 1.2] },
  policeHeli: { kind: 'policeHeli', name: 'Полиция-1', type: 'heli', half: [1.0, 0.9, 2.4], colliderY: 1.25, wheelBase: 0, track: 0, wheelR: 0, wheelW: 0, wheelY: 0, mass: 1700, engine: 0, maxSpeed: 55, brake: 0, steer: 0, grip: 0, health: 1800, price: 0, paints: [0x141820], paint2: 0xe8e8e8, camDist: 13, camHeight: 4.0, drive: 'rwd', seat: [0.4, 0.9, 1.2] },
};

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Добавить коробку с поворотом (rx — наклон вокруг X). */
function pbox(gb: GeomBuilder, part: number, x: number, y: number, z: number, w: number, h: number, d: number, rx = 0, ry = 0, rz = 0) {
  gb.setAttr(part);
  const g = new THREE.BoxGeometry(w, h, d);
  _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(1, 1, 1));
  gb.addGeometry(g, _m);
  g.dispose();
}
function pcyl(gb: GeomBuilder, part: number, x: number, y: number, z: number, r: number, len: number, axis: 'x' | 'y' | 'z', seg = 10, r2 = r) {
  gb.setAttr(part);
  const g = new THREE.CylinderGeometry(r2, r, len, seg);
  _e.set(axis === 'z' ? Math.PI / 2 : 0, 0, axis === 'x' ? Math.PI / 2 : 0);
  _m.compose(_p.set(x, y, z), _q.setFromEuler(_e), _s.set(1, 1, 1));
  gb.addGeometry(g, _m);
  g.dispose();
}
function psphere(gb: GeomBuilder, part: number, x: number, y: number, z: number, sx: number, sy: number, sz: number) {
  gb.setAttr(part);
  const g = new THREE.SphereGeometry(1, 14, 10);
  _m.compose(_p.set(x, y, z), _q.identity(), _s.set(sx, sy, sz));
  gb.addGeometry(g, _m);
  g.dispose();
}
/** Выдавленный боковой профиль (точки [z, y]) шириной w. */
function profile(gb: GeomBuilder, part: number, pts: [number, number][], w: number, bevel = 0.05, yOff = 0) {
  gb.setAttr(part);
  const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.01, w - bevel * 2), bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 4 });
  g.translate(0, yOff, -(w - bevel * 2) / 2);
  g.rotateY(-Math.PI / 2);
  _m.identity();
  gb.addGeometry(g, _m);
  g.dispose();
}

interface CarShape {
  L: number; W: number; clear: number; belt: number; hoodF: number; hoodZ: number; roof: number; roofF: number; roofR: number; deckZ: number; deckY: number; tailY: number;
}

function carBody(gb: GeomBuilder, s: CarShape, kind: VehicleKind) {
  const h = s.L / 2;
  // Нижняя часть кузова.
  profile(gb, Part.Paint, [
    [-h + 0.05, s.clear], [h - 0.05, s.clear], [h + 0.02, s.clear + 0.22], [h - 0.05, s.hoodF], [s.hoodZ, s.belt],
    [s.deckZ, s.belt], [-h + 0.1, s.deckY], [-h, s.tailY], [-h - 0.02, s.clear + 0.22],
  ], s.W, 0.06);
  // Стеклянная «теплица» салона.
  profile(gb, Part.Glass, [[s.hoodZ - 0.02, s.belt - 0.02], [s.roofF, s.roof], [s.roofR, s.roof], [s.deckZ + 0.02, s.belt - 0.02]], s.W - 0.2, 0.04, 0);
  // Крыша и стойки.
  pbox(gb, Part.Paint, 0, s.roof + 0.02, (s.roofF + s.roofR) / 2, s.W - 0.24, 0.06, s.roofF - s.roofR + 0.08);
  const aLen = Math.hypot(s.hoodZ - s.roofF, s.roof - s.belt);
  const aAng = Math.atan2(s.hoodZ - s.roofF, s.roof - s.belt);
  const cLen = Math.hypot(s.roofR - s.deckZ, s.roof - s.belt);
  const cAng = Math.atan2(s.roofR - s.deckZ, s.roof - s.belt);
  for (const sx of [-1, 1]) {
    const x = sx * (s.W / 2 - 0.13);
    pbox(gb, Part.Paint, x, (s.belt + s.roof) / 2, (s.hoodZ + s.roofF) / 2, 0.08, aLen, 0.09, -aAng);
    pbox(gb, Part.Paint, x, (s.belt + s.roof) / 2, (s.deckZ + s.roofR) / 2, 0.08, cLen, 0.14, cAng);
    pbox(gb, Part.Black, x * 1.003, (s.belt + s.roof) / 2, (s.roofF + s.roofR) / 2 - 0.05, 0.07, s.roof - s.belt, 0.1);
    // Зеркала.
    pbox(gb, Part.Paint, sx * (s.W / 2 + 0.06), s.belt + 0.1, s.hoodZ - 0.1, 0.12, 0.09, 0.14);
    // Ручки дверей и пороги.
    pbox(gb, Part.Chrome, sx * (s.W / 2 + 0.005), s.belt - 0.12, (s.hoodZ + s.deckZ) / 2 + 0.3, 0.02, 0.03, 0.16);
    pbox(gb, Part.Black, sx * (s.W / 2 - 0.02), s.clear + 0.06, 0, 0.06, 0.1, s.L * 0.55);
    // Колёсные арки.
    for (const wz of [h - 0.95, -h + 0.95]) pbox(gb, Part.Black, sx * (s.W / 2 - 0.02), s.clear + 0.22, wz, 0.05, 0.45, 0.95);
  }
  // Фары, фонари, решётка, бамперы, номера.
  for (const sx of [-1, 1]) {
    pbox(gb, Part.Head, sx * (s.W / 2 - 0.25), s.hoodF - 0.08, h + 0.01, 0.36, 0.12, 0.06);
    pbox(gb, Part.Tail, sx * (s.W / 2 - 0.22), s.tailY - 0.1, -h - 0.01, 0.38, 0.12, 0.06);
    pbox(gb, Part.Amber, sx * (s.W / 2 - 0.05), s.hoodF - 0.08, h - 0.05, 0.08, 0.08, 0.06);
  }
  pbox(gb, Part.Black, 0, s.clear + 0.32, h + 0.01, s.W * 0.5, 0.16, 0.05);
  pbox(gb, Part.Black, 0, s.clear + 0.12, h + 0.03, s.W - 0.05, 0.14, 0.1);
  pbox(gb, Part.Black, 0, s.clear + 0.12, -h - 0.03, s.W - 0.05, 0.14, 0.1);
  pbox(gb, Part.Sign, 0, s.clear + 0.3, h + 0.04, 0.42, 0.11, 0.01);
  pbox(gb, Part.Sign, 0, s.tailY - 0.22, -h - 0.04, 0.42, 0.11, 0.01);
  pcyl(gb, Part.Chrome, s.W / 2 - 0.35, s.clear + 0.08, -h - 0.05, 0.04, 0.15, 'z', 8);
  if (kind === 'sport') pbox(gb, Part.Black, 0, s.deckY + 0.18, -h + 0.18, s.W - 0.2, 0.04, 0.28);
  if (kind === 'muscle') pbox(gb, Part.Black, 0, s.belt + 0.06, s.hoodZ + 0.75, 0.5, 0.1, 0.8);
}

function wheelsUnderglow(gb: GeomBuilder, s: CarShape) {
  // Тёмное днище (видно при опрокидывании).
  pbox(gb, Part.Black, 0, s.clear + 0.02, 0, s.W - 0.2, 0.04, s.L - 0.3);
}

const cache = new Map<VehicleKind, THREE.BufferGeometry>();

export function vehicleGeometry(kind: VehicleKind): THREE.BufferGeometry {
  const c = cache.get(kind);
  if (c) return c;
  const gb = new GeomBuilder('aPart', 1);
  switch (kind) {
    case 'sedan': case 'taxi': case 'police': {
      const s: CarShape = { L: 4.5, W: 1.8, clear: 0.28, belt: 0.95, hoodF: 0.78, hoodZ: 0.95, roof: 1.42, roofF: 0.15, roofR: -0.95, deckZ: -1.45, deckY: 0.93, tailY: 0.82 };
      carBody(gb, s, kind);
      wheelsUnderglow(gb, s);
      if (kind === 'taxi') {
        pbox(gb, Part.Sign, 0, s.roof + 0.16, -0.4, 0.7, 0.2, 0.3);
        pbox(gb, Part.Black, 0, s.belt - 0.25, 0.1, s.W + 0.02, 0.06, 2.0);
      }
      if (kind === 'police') {
        pbox(gb, Part.Black, 0, s.roof + 0.09, -0.4, 1.2, 0.07, 0.3);
        pbox(gb, Part.SirenR, -0.32, s.roof + 0.17, -0.4, 0.5, 0.1, 0.24);
        pbox(gb, Part.SirenB, 0.32, s.roof + 0.17, -0.4, 0.5, 0.1, 0.24);
        for (const sx of [-1, 1]) pbox(gb, Part.Paint2, sx * (s.W / 2 + 0.01), (s.clear + s.belt) / 2 + 0.06, -0.2, 0.02, s.belt - s.clear - 0.25, 2.0);
        pbox(gb, Part.Chrome, 0, s.clear + 0.35, s.L / 2 + 0.08, s.W * 0.7, 0.3, 0.06);
      }
      break;
    }
    case 'sport': {
      const s: CarShape = { L: 4.3, W: 1.9, clear: 0.2, belt: 0.78, hoodF: 0.62, hoodZ: 0.55, roof: 1.15, roofF: -0.15, roofR: -0.95, deckZ: -1.6, deckY: 0.8, tailY: 0.72 };
      carBody(gb, s, kind);
      wheelsUnderglow(gb, s);
      break;
    }
    case 'muscle': {
      const s: CarShape = { L: 4.8, W: 1.9, clear: 0.27, belt: 0.92, hoodF: 0.82, hoodZ: 0.75, roof: 1.32, roofF: 0.05, roofR: -1.1, deckZ: -1.75, deckY: 0.92, tailY: 0.86 };
      carBody(gb, s, kind);
      wheelsUnderglow(gb, s);
      break;
    }
    case 'suv': {
      const s: CarShape = { L: 4.7, W: 1.95, clear: 0.45, belt: 1.25, hoodF: 1.1, hoodZ: 1.25, roof: 1.85, roofF: 0.6, roofR: -2.0, deckZ: -2.25, deckY: 1.25, tailY: 1.15 };
      carBody(gb, s, kind);
      wheelsUnderglow(gb, s);
      pbox(gb, Part.Black, 0, s.roof + 0.08, -0.6, s.W - 0.3, 0.05, 1.8);
      for (const sx of [-1, 1]) pbox(gb, Part.Black, sx * 0.6, s.roof + 0.05, -0.6, 0.05, 0.08, 2.0);
      break;
    }
    case 'van': case 'armored': {
      const arm = kind === 'armored';
      const L = arm ? 5.8 : 5.2, W = arm ? 2.2 : 2.0, clear = arm ? 0.45 : 0.38, H = arm ? 2.5 : 2.3;
      const h = L / 2;
      // Кабина и кузов-фургон.
      profile(gb, Part.Paint, [[-h, clear], [h, clear], [h + 0.02, clear + 0.4], [h - 0.1, 1.05], [h - 0.8, 1.2], [h - 0.8, H - 0.1], [-h, H - 0.1]], W, 0.06);
      profile(gb, Part.Glass, [[h - 0.15, 1.12], [h - 0.75, H - 0.25], [h - 1.3, H - 0.25], [h - 1.3, 1.12]], W - 0.12, 0.03);
      if (!arm) for (const sx of [-1, 1]) pbox(gb, Part.Glass, sx * (W / 2 + 0.005), 1.6, h - 1.05, 0.02, 0.55, 0.6);
      if (arm) {
        for (const sx of [-1, 1]) {
          pbox(gb, Part.Metal, sx * (W / 2 + 0.02), 1.35, -0.6, 0.03, 1.6, 3.6);
          pbox(gb, Part.Glass, sx * (W / 2 + 0.03), 1.75, -1.2, 0.02, 0.14, 0.5);
        }
        pbox(gb, Part.Metal, 0, clear + 0.4, h + 0.08, W, 0.35, 0.12);
        pbox(gb, Part.Amber, -0.4, H, h - 1.0, 0.22, 0.12, 0.22);
        pbox(gb, Part.Amber, 0.4, H, h - 1.0, 0.22, 0.12, 0.22);
      }
      for (const sx of [-1, 1]) {
        pbox(gb, Part.Head, sx * (W / 2 - 0.3), 0.85, h + 0.01, 0.34, 0.16, 0.06);
        pbox(gb, Part.Tail, sx * (W / 2 - 0.15), 0.9, -h - 0.01, 0.2, 0.3, 0.06);
        pbox(gb, Part.Black, sx * (W / 2 + 0.08), 1.6, h - 0.75, 0.1, 0.22, 0.12);
        for (const wz of [h - 0.95, -h + 1.0]) pbox(gb, Part.Black, sx * (W / 2 - 0.02), clear + 0.24, wz, 0.05, 0.5, 1.0);
      }
      pbox(gb, Part.Black, 0, clear + 0.15, h + 0.04, W, 0.18, 0.1);
      pbox(gb, Part.Black, 0, clear + 0.15, -h - 0.04, W, 0.18, 0.1);
      pbox(gb, Part.Black, 0, 0.7, h + 0.02, W * 0.55, 0.25, 0.04);
      pbox(gb, Part.Black, 0, clear + 0.02, 0, W - 0.2, 0.04, L - 0.4);
      if (!arm) pbox(gb, Part.Black, 0, (H + clear) / 2, -h - 0.02, 0.03, H - clear - 0.3, 0.02);
      break;
    }
    case 'moto': {
      // Рама, бак, сиденье, обтекатель, руль, вилка.
      pbox(gb, Part.Paint, 0, 0.78, 0.2, 0.3, 0.22, 0.55, -0.15);
      pbox(gb, Part.Black, 0, 0.86, -0.35, 0.26, 0.09, 0.6, 0.05);
      pbox(gb, Part.Paint, 0, 0.82, -0.78, 0.22, 0.16, 0.4, 0.25);
      pbox(gb, Part.Metal, 0, 0.5, -0.05, 0.22, 0.32, 0.7);
      pbox(gb, Part.Paint, 0, 0.92, 0.62, 0.34, 0.3, 0.3, -0.5);
      pbox(gb, Part.Glass, 0, 1.12, 0.6, 0.28, 0.2, 0.04, -0.6);
      pbox(gb, Part.Chrome, 0, 0.62, 0.6, 0.06, 0.6, 0.06, -0.35);
      pbox(gb, Part.Black, 0, 1.02, 0.48, 0.66, 0.04, 0.04);
      pbox(gb, Part.Head, 0, 0.88, 0.78, 0.16, 0.1, 0.05);
      pbox(gb, Part.Tail, 0, 0.84, -1.0, 0.12, 0.06, 0.04);
      pcyl(gb, Part.Chrome, 0.14, 0.45, -0.6, 0.05, 0.6, 'z', 8);
      break;
    }
    case 'boat': {
      // Корпус: V-образный профиль, рубка, лобовое стекло, мотор.
      gb.setAttr(Part.Paint);
      const hull = new THREE.BufferGeometry();
      const L = 7.2, W = 2.5, D = 0.9;
      const p: number[] = [];
      const sec = (z: number, w: number, keel: number, top: number) => [[-w / 2, top, z], [w / 2, top, z], [0, keel, z]];
      const zs = [-L / 2, -L / 4, 0, L / 4, L / 2 - 0.4, L / 2];
      const ws = [W * 0.9, W, W, W * 0.85, W * 0.45, 0.05];
      const ks = [-D * 0.55, -D * 0.6, -D * 0.6, -D * 0.5, -D * 0.2, 0.3];
      const rings = zs.map((z, i) => sec(z, ws[i], ks[i], 0.45));
      for (let i = 0; i < rings.length - 1; i++) {
        const A = rings[i], Bv = rings[i + 1];
        // Левый борт, правый борт.
        p.push(...A[0], ...A[2], ...Bv[2], ...A[0], ...Bv[2], ...Bv[0]);
        p.push(...A[1], ...Bv[1], ...Bv[2], ...A[1], ...Bv[2], ...A[2]);
      }
      const A0 = rings[0];
      p.push(...A0[0], ...A0[1], ...A0[2]);
      hull.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      hull.computeVertexNormals();
      _m.identity();
      gb.addGeometry(hull, _m);
      hull.dispose();
      pbox(gb, Part.Paint2, 0, 0.46, -0.2, W - 0.1, 0.06, L - 1.2);
      pbox(gb, Part.Paint, 0, 0.75, 0.2, 1.6, 0.6, 1.4);
      pbox(gb, Part.Glass, 0, 1.25, 0.75, 1.5, 0.45, 0.05, -0.5);
      pbox(gb, Part.Interior, 0, 0.75, -1.6, 1.8, 0.5, 1.2);
      pbox(gb, Part.Black, 0, 0.6, -L / 2 - 0.15, 0.35, 0.9, 0.4);
      pbox(gb, Part.Chrome, 0, 0.6, -L / 2 + 0.5, W - 0.2, 0.05, 0.05);
      pbox(gb, Part.Head, 0, 0.9, L / 2 - 0.7, 0.2, 0.1, 0.1);
      break;
    }
    case 'heli': case 'policeHeli': {
      psphere(gb, Part.Paint, 0, 1.25, 0.6, 1.0, 1.0, 1.9);
      psphere(gb, Part.Glass, 0, 1.45, 1.55, 0.82, 0.72, 0.9);
      pcyl(gb, Part.Paint, 0, 1.45, -2.6, 0.22, 3.6, 'z', 10, 0.12);
      pbox(gb, Part.Paint2, 0, 2.0, -4.3, 0.08, 1.1, 0.7, 0.35);
      pbox(gb, Part.Paint2, 0, 1.5, -4.0, 1.4, 0.06, 0.4);
      pbox(gb, Part.Metal, 0, 2.3, 0.4, 0.5, 0.3, 1.2);
      pcyl(gb, Part.Metal, 0, 2.5, 0.5, 0.08, 0.3, 'y', 8);
      for (const sx of [-1, 1]) {
        pbox(gb, Part.Metal, sx * 0.85, 0.12, 0.5, 0.08, 0.08, 3.0);
        pbox(gb, Part.Metal, sx * 0.75, 0.5, 1.2, 0.06, 0.7, 0.06, 0, 0, sx * 0.3);
        pbox(gb, Part.Metal, sx * 0.75, 0.5, -0.4, 0.06, 0.7, 0.06, 0, 0, sx * 0.3);
        pbox(gb, Part.Tail, sx * 0.72, 1.0, -0.4, 0.05, 0.08, 0.08);
      }
      pbox(gb, Part.Head, 0, 0.45, 1.9, 0.25, 0.15, 0.2);
      if (kind === 'policeHeli') {
        pbox(gb, Part.SirenR, -0.3, 0.3, 0.5, 0.2, 0.08, 0.2);
        pbox(gb, Part.SirenB, 0.3, 0.3, 0.5, 0.2, 0.08, 0.2);
      }
      break;
    }
  }
  const g = gb.build();
  cache.set(kind, g);
  return g;
}

/** Лопасти несущего и хвостового винта (вращаются отдельно). */
export function rotorGeometry(): { main: THREE.BufferGeometry; tail: THREE.BufferGeometry } {
  const gb = new GeomBuilder('aPart', 1);
  for (let k = 0; k < 4; k++) pbox(gb, Part.Black, 0, 0, 0, 0.3, 0.04, 11, 0, (k * Math.PI) / 2, 0);
  pcyl(gb, Part.Metal, 0, 0, 0, 0.18, 0.2, 'y', 8);
  const main = gb.build();
  const tb = new GeomBuilder('aPart', 1);
  for (let k = 0; k < 2; k++) pbox(tb, Part.Black, 0, 0, 0, 0.03, 1.5, 0.14, (k * Math.PI) / 2, 0, 0);
  return { main, tail: tb.build() };
}

/** Колесо: шина + диск (вершинные цвета), радиус 1, ширина 1, ось вдоль X. */
export function wheelGeometry(): THREE.BufferGeometry {
  const tire = new THREE.CylinderGeometry(1, 1, 1, 18, 1, false);
  tire.rotateZ(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(0.62, 0.62, 1.04, 12, 1, false);
  rim.rotateZ(Math.PI / 2);
  const hub = new THREE.CylinderGeometry(0.2, 0.2, 1.1, 6);
  hub.rotateZ(Math.PI / 2);
  const parts = [tire, rim, hub];
  const cols = [[0.03, 0.03, 0.03], [0.55, 0.56, 0.58], [0.2, 0.2, 0.22]];
  let n = 0;
  for (const p of parts) n += p.getAttribute('position').count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const idx: number[] = [];
  let off = 0;
  parts.forEach((p, k) => {
    const pa = p.getAttribute('position'), na = p.getAttribute('normal');
    pos.set(pa.array as Float32Array, off * 3);
    nrm.set(na.array as Float32Array, off * 3);
    for (let i = 0; i < pa.count; i++) col.set(cols[k], (off + i) * 3);
    for (let i = 0; i < p.index!.count; i++) idx.push(off + p.index!.getX(i));
    off += pa.count;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}
