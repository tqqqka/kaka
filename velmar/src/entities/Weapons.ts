/**
 * Оружие: характеристики и процедурные модели (без внешних ассетов).
 */
import * as THREE from 'three';
import { MaterialLib } from '../render/Materials';

export type WeaponId = 'fist' | 'pistol' | 'smg' | 'shotgun' | 'rifle';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  damage: number;
  /** Выстрелов в секунду. */
  rate: number;
  /** Разброс, рад. */
  spread: number;
  range: number;
  mag: number;
  reload: number;
  pellets: number;
  auto: boolean;
  twoHanded: boolean;
  price: number;
  ammoPrice: number;
  ammoPack: number;
  recoil: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  fist: { id: 'fist', name: 'Кулаки', damage: 14, rate: 2.2, spread: 0, range: 1.7, mag: 0, reload: 0, pellets: 1, auto: false, twoHanded: false, price: 0, ammoPrice: 0, ammoPack: 0, recoil: 0 },
  pistol: { id: 'pistol', name: 'Пистолет «Оса-9»', damage: 26, rate: 4, spread: 0.012, range: 90, mag: 12, reload: 1.2, pellets: 1, auto: false, twoHanded: false, price: 300, ammoPrice: 40, ammoPack: 36, recoil: 0.03 },
  smg: { id: 'smg', name: 'ПП «Шершень»', damage: 17, rate: 12, spread: 0.035, range: 70, mag: 30, reload: 1.6, pellets: 1, auto: true, twoHanded: true, price: 1100, ammoPrice: 70, ammoPack: 90, recoil: 0.02 },
  shotgun: { id: 'shotgun', name: 'Дробовик «Буря»', damage: 14, rate: 1.3, spread: 0.07, range: 35, mag: 6, reload: 2.2, pellets: 8, auto: false, twoHanded: true, price: 1600, ammoPrice: 60, ammoPack: 18, recoil: 0.09 },
  rifle: { id: 'rifle', name: 'Автомат «Сокол»', damage: 32, rate: 8, spread: 0.018, range: 160, mag: 30, reload: 2.0, pellets: 1, auto: true, twoHanded: true, price: 3200, ammoPrice: 110, ammoPack: 90, recoil: 0.035 },
};

export const WEAPON_ORDER: WeaponId[] = ['fist', 'pistol', 'smg', 'shotgun', 'rifle'];

let gunMat: THREE.MeshStandardMaterial | null = null;
const geoCache = new Map<WeaponId, THREE.BufferGeometry>();

/** Модель оружия: ствол направлен по +Z (в слоте руки повёрнут вдоль кисти). */
export function weaponMesh(id: WeaponId): THREE.Mesh | null {
  if (id === 'fist') return null;
  if (!gunMat) gunMat = MaterialLib.std({ color: 0x1b1c1e, roughness: 0.45, metalness: 0.7 });
  let g = geoCache.get(id);
  if (!g) {
    const parts: THREE.BufferGeometry[] = [];
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, rx = 0) => {
      const b = new THREE.BoxGeometry(w, h, d);
      if (rx) b.rotateX(rx);
      b.translate(x, y, z);
      parts.push(b);
    };
    if (id === 'pistol') {
      box(0.035, 0.05, 0.2, 0, 0.03, 0.06);
      box(0.03, 0.1, 0.045, 0, -0.03, -0.01, 0.25);
    } else if (id === 'smg') {
      box(0.045, 0.07, 0.34, 0, 0.03, 0.08);
      box(0.03, 0.12, 0.04, 0, -0.05, 0.02, 0.2);
      box(0.025, 0.16, 0.035, 0, -0.06, 0.13);
      box(0.02, 0.02, 0.12, 0, 0.04, 0.3);
    } else if (id === 'shotgun') {
      box(0.05, 0.06, 0.75, 0, 0.03, 0.22);
      box(0.04, 0.1, 0.25, 0, -0.02, -0.18, -0.2);
      box(0.045, 0.045, 0.22, 0, -0.01, 0.3);
    } else {
      box(0.045, 0.08, 0.55, 0, 0.03, 0.15);
      box(0.04, 0.1, 0.22, 0, 0.0, -0.18, -0.15);
      box(0.03, 0.15, 0.05, 0, -0.07, 0.12, 0.3);
      box(0.02, 0.02, 0.25, 0, 0.05, 0.5);
      box(0.03, 0.05, 0.1, 0, 0.1, 0.1);
    }
    g = mergeGeos(parts);
    geoCache.set(id, g);
  }
  const m = new THREE.Mesh(g, gunMat);
  m.castShadow = true;
  return m;
}

export function mergeGeos(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  const ni = parts.map((p) => (p.index ? p.index.count : p.getAttribute('position').count));
  for (const p of parts) n += p.getAttribute('position').count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  const idx: number[] = [];
  let off = 0;
  parts.forEach((p, k) => {
    const pa = p.getAttribute('position'), na = p.getAttribute('normal'), ua = p.getAttribute('uv');
    pos.set(pa.array as Float32Array, off * 3);
    nrm.set(na.array as Float32Array, off * 3);
    if (ua) uv.set(ua.array as Float32Array, off * 2);
    if (p.index) for (let i = 0; i < p.index.count; i++) idx.push(off + p.index.getX(i));
    else for (let i = 0; i < ni[k]; i++) idx.push(off + i);
    off += pa.count;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}
