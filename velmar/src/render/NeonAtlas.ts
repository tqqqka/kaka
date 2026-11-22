/**
 * Процедурный атлас неоновых надписей (рисуется на canvas при запуске).
 * Белый текст со свечением; цвет задаётся вершинным цветом вывески.
 */
import * as THREE from 'three';

export const NEON_WORDS = [
  'БАР', 'ОТЕЛЬ', '24/7', 'КАЗИНО', 'ЛОМБАРД', 'АПТЕКА', 'КИНО', 'ШАУРМА',
  'КЛУБ', 'ПИЦЦА', 'СУШИ', 'КОФЕ', 'МОТЕЛЬ', 'ПРОДУКТЫ', 'РЕМОНТ', 'ТАТУ',
  'БАНК', 'ОБМЕН', 'ДИСКО', 'НОЧНОЙ', 'ПРИЛИВ', 'ВЕЛЬМАР', 'ГРИЛЬ', 'ЛАПША',
  'МАРКЕТ', 'САЛОН', 'КАРАОКЕ', 'РАДИО 101', 'ОТКРЫТО', 'ВЕЛЬМАР-ТВ', 'ГАЗЕТА', 'ЛОТО',
  // Специальные (индексы 32+): вывески ключевых мест.
  'МАСТЕРСКАЯ НИНЫ', 'КАЛИБР', 'ХАМЕЛЕОН', 'БОЛЬНИЦА', 'ПОЛИЦИЯ', 'АВТОВОКЗАЛ', 'СКЛАД №7', 'САБУРОВ',
] as const;

export const SPECIAL_SIGN: Record<string, number> = {
  garage: 32, gunshop: 33, paint1: 34, paint2: 34, hospital: 35, police: 36, bus: 37, warehouse: 38, spire: 39,
};

export const NEON_COLORS = [0xff2d7a, 0x2de2ff, 0xffb12d, 0x7dff5a, 0xb35cff, 0xff4b2d, 0xfff35a, 0x5a8bff];

const COLS = 4;
const ROWS = 10;
let _tex: THREE.CanvasTexture | null = null;

export function neonAtlas(): THREE.CanvasTexture {
  if (_tex) return _tex;
  const cw = 256, ch = 64;
  const cv = document.createElement('canvas');
  cv.width = cw * COLS;
  cv.height = ch * ROWS;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  NEON_WORDS.forEach((w, i) => {
    const cx = (i % COLS) * cw + cw / 2, cy = Math.floor(i / COLS) * ch + ch / 2;
    let size = 44;
    ctx.font = `bold ${size}px Arial, sans-serif`;
    while (ctx.measureText(w).width > cw - 24 && size > 12) { size -= 2; ctx.font = `bold ${size}px Arial, sans-serif`; }
    // Свечение в несколько проходов.
    ctx.shadowColor = '#fff';
    for (const [blur, alpha] of [[18, 0.5], [8, 0.8], [0, 1]] as const) {
      ctx.shadowBlur = blur;
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.fillText(w, cx, cy);
    }
    // Рамка-трубка вокруг надписи.
    ctx.shadowBlur = 6;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 3;
    ctx.strokeRect(cx - cw / 2 + 6, cy - ch / 2 + 5, cw - 12, ch - 10);
  });
  _tex = new THREE.CanvasTexture(cv);
  _tex.colorSpace = THREE.SRGBColorSpace;
  _tex.anisotropy = 4;
  _tex.generateMipmaps = true;
  return _tex;
}

/** UV-прямоугольник слова в атласе: [u0, v0, u1, v1]. */
export function neonUV(index: number): [number, number, number, number] {
  const c = index % COLS, r = Math.floor(index / COLS);
  const u0 = c / COLS, u1 = (c + 1) / COLS;
  const v1 = 1 - r / ROWS, v0 = 1 - (r + 1) / ROWS;
  return [u0, v0, u1, v1];
}

/** Радиальный градиент для световых пятен фонарей на земле. */
let _pool: THREE.CanvasTexture | null = null;
export function poolTexture(): THREE.CanvasTexture {
  if (_pool) return _pool;
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  _pool = new THREE.CanvasTexture(cv);
  _pool.colorSpace = THREE.SRGBColorSpace;
  return _pool;
}
