/**
 * Миникарта (поворачивается за камерой) и полноэкранная карта (перетаскивание, масштаб,
 * метка GPS по тапу). Подложка острова рисуется один раз в offscreen-canvas.
 */
import * as THREE from 'three';
import type { Game } from '../game/Game';
import { CITY_RECT, PIERS, GRID, lineX, lineZ, hwX, hwZ, WATER_Y } from '../world/CityLayout';

const MAP = { x0: -1350, z0: -1500, size: 2700, px: 1080 };
const s2p = MAP.px / MAP.size;

const DISTRICT_COL: Record<string, string> = {
  downtown: '#5d6470', residential: '#6a5d55', suburb: '#5f6b55', industrial: '#5b6063', port: '#545a60',
  park: '#3f6b3a', beach: '#7a7060', construction: '#6f6250', plaza: '#7a7468',
};

export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;
  private size = 150;
  private dpr = 1;
  private frame = 0;

  constructor(private game: Game, parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'minimap';
    parent.prepend(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.base = Minimap.renderBase(game);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.size = Math.round(Math.min(170, Math.max(118, window.innerHeight * 0.26)));
    this.canvas.width = this.canvas.height = this.size * this.dpr;
    this.canvas.style.width = this.canvas.style.height = this.size + 'px';
  }

  /** Подложка карты острова. */
  static renderBase(game: Game): HTMLCanvasElement {
    const cv = document.createElement('canvas');
    cv.width = cv.height = MAP.px;
    const c = cv.getContext('2d')!;
    const ter = game.world.terrain;
    // Рельеф/вода по сетке.
    const img = c.createImageData(MAP.px, MAP.px);
    for (let py = 0; py < MAP.px; py += 1) for (let px = 0; px < MAP.px; px += 1) {
      const x = MAP.x0 + px / s2p, z = MAP.z0 + py / s2p;
      const h = ter.groundHeight(x, z);
      let r: number, g: number, b: number;
      if (h < WATER_Y - 0.2) { const d = Math.min(1, (WATER_Y - h) / 8); r = 20 - d * 8; g = 52 - d * 14; b = 66 - d * 10; }
      else if (h < 1.2 && (z > CITY_RECT.z1 || x > CITY_RECT.x1)) { r = 132; g = 118; b = 88; }
      else { const k = Math.min(1, h / 140); r = 52 + k * 40; g = 70 + k * 20; b = 46 + k * 16; }
      const i = (py * MAP.px + px) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    const X = (x: number) => (x - MAP.x0) * s2p, Z = (z: number) => (z - MAP.z0) * s2p;
    // Город: подложка дорог.
    c.fillStyle = '#3a3c40';
    c.fillRect(X(CITY_RECT.x0), Z(CITY_RECT.z0), (CITY_RECT.x1 - CITY_RECT.x0) * s2p, (CITY_RECT.z1 - CITY_RECT.z0) * s2p);
    for (const p of PIERS) { c.fillStyle = '#4a4d52'; c.fillRect(X(p.x0), Z(p.z0), (p.x1 - p.x0) * s2p, (p.z1 - p.z0) * s2p); }
    // Кварталы.
    for (const b of game.world.layout.blocks) {
      c.fillStyle = '#8a8a86';
      c.fillRect(X(b.x0), Z(b.z0), (b.x1 - b.x0) * s2p, (b.z1 - b.z0) * s2p);
      c.fillStyle = DISTRICT_COL[b.district] ?? '#666';
      c.fillRect(X(b.inner.x0), Z(b.inner.z0), (b.inner.x1 - b.inner.x0) * s2p, (b.inner.z1 - b.inner.z0) * s2p);
      for (const p of b.buildings) {
        const t = p.height;
        c.fillStyle = t > 120 ? '#2c3038' : t > 40 ? '#3c4048' : '#4c4e52';
        c.fillRect(X(p.bounds.x0) + 0.5, Z(p.bounds.z0) + 0.5, Math.max(1, (p.bounds.x1 - p.bounds.x0) * s2p * 0.8), Math.max(1, (p.bounds.z1 - p.bounds.z0) * s2p * 0.8));
      }
    }
    // Шоссе ярче.
    c.fillStyle = '#6b6750';
    c.fillRect(X(lineX(0) - hwX(0)), Z(CITY_RECT.z0), hwX(0) * 2 * s2p, (CITY_RECT.z1 - CITY_RECT.z0) * s2p);
    for (const j of [0, GRID.nz]) c.fillRect(X(CITY_RECT.x0), Z(lineZ(j) - hwZ(j)), (CITY_RECT.x1 - CITY_RECT.x0) * s2p, hwZ(j) * 2 * s2p);
    // Серпантин.
    c.strokeStyle = '#4a4a44';
    c.lineWidth = 12 * s2p;
    c.beginPath();
    ter.roadPath.forEach(([x, z], i) => (i ? c.lineTo(X(x), Z(z)) : c.moveTo(X(x), Z(z))));
    c.stroke();
    return cv;
  }

  private worldToMap(x: number, z: number) {
    return [(x - MAP.x0) * s2p, (z - MAP.z0) * s2p];
  }

  update() {
    this.frame++;
    if (this.frame % 2) return;
    const g = this.game;
    const c = this.ctx;
    const S = this.size * this.dpr;
    const pl = g.player;
    const pp = pl.vehicle ? pl.vehicle.position() : pl.char.pos;
    const speed = pl.vehicle ? Math.abs(pl.vehicle.speed) : 0;
    const metersPerPx = 1.6 + Math.min(2.2, speed * 0.05);
    const scale = (s2p / metersPerPx) * (this.dpr / s2p) * (1 / s2p) * s2p; // пиксели канваса на пиксель подложки
    const zoom = this.dpr / metersPerPx / s2p;
    const rot = -g.cameraRig.yaw + Math.PI;
    c.save();
    c.clearRect(0, 0, S, S);
    c.beginPath();
    c.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = '#14303c';
    c.fillRect(0, 0, S, S);
    c.translate(S / 2, S / 2);
    c.rotate(rot);
    c.scale(zoom * s2p, zoom * s2p);
    const [mx, mz] = this.worldToMap(pp.x, pp.z);
    c.translate(-mx / s2p, -mz / s2p);
    c.scale(1 / s2p, 1 / s2p);
    c.globalAlpha = 0.95;
    c.drawImage(this.base, 0, 0);
    c.globalAlpha = 1;
    void scale;
    // Маршрут GPS.
    const route = g.markers.route;
    if (route.length >= 4) {
      c.strokeStyle = '#c66bff';
      c.lineWidth = 6 / (zoom * s2p) * s2p;
      c.lineJoin = 'round';
      c.beginPath();
      for (let i = 0; i < route.length; i += 2) {
        const [x, z] = this.worldToMap(route[i], route[i + 1]);
        if (i === 0) c.moveTo(x, z); else c.lineTo(x, z);
      }
      c.stroke();
    }
    // Круг поиска полиции.
    if (g.police && g.police.stars > 0 && g.police.searching) {
      const [x, z] = this.worldToMap(g.police.lastSeen.x, g.police.lastSeen.z);
      c.strokeStyle = Math.floor(g.time * 3) % 2 ? '#ff3b4e' : '#3b7bff';
      c.lineWidth = 3 / zoom;
      c.beginPath();
      c.arc(x, z, (70 + g.police.stars * 30) * s2p, 0, Math.PI * 2);
      c.stroke();
    }
    c.restore();
    // Метки (в экранных координатах, чтобы иконки не вращались).
    const toScreen = (x: number, z: number): [number, number] => {
      const dx = (x - pp.x) / metersPerPx * this.dpr, dz = (z - pp.z) / metersPerPx * this.dpr;
      const cs = Math.cos(rot), sn = Math.sin(rot);
      return [S / 2 + dx * cs - dz * sn, S / 2 + dx * sn + dz * cs];
    };
    const R = S / 2 - 8 * this.dpr;
    const drawBlip = (x: number, z: number, color: string, icon: string, edge: boolean, size = 5) => {
      let [sx, sy] = toScreen(x, z);
      const ox = sx - S / 2, oy = sy - S / 2;
      const d = Math.hypot(ox, oy);
      if (d > R) { if (!edge) return; sx = S / 2 + (ox / d) * R; sy = S / 2 + (oy / d) * R; }
      c.fillStyle = color;
      c.strokeStyle = '#000';
      c.lineWidth = 1.5 * this.dpr;
      c.beginPath();
      c.arc(sx, sy, size * this.dpr, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      if (icon) {
        c.fillStyle = '#000';
        c.font = `bold ${8 * this.dpr}px sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(icon, sx, sy + 0.5);
      }
    };
    for (const b of g.markers.blips) {
      const p = g.markers.blipPos(b);
      if (!p) continue;
      const big = b.kind === 'mission' || b.kind === 'shop' || b.kind === 'garage' || b.kind === 'side';
      drawBlip(p.x, p.z, b.color, b.icon, b.edge, big ? 6.5 : b.kind === 'enemy' ? 3.5 : 5);
    }
    if (g.markers.waypoint) drawBlip(g.markers.waypoint.x, g.markers.waypoint.z, '#c66bff', '', true, 5);
    if (g.police) for (const p of g.police.unitPositions()) drawBlip(p.x, p.z, Math.floor(g.time * 4) % 2 ? '#ff3b4e' : '#3b7bff', '', false, 3.5);
    // Тайники рядом.
    const pk = g.packages;
    if (pk) pk.spots.forEach((s, i) => { if (!pk.found.has(i) && s.distanceTo(pp) < 60) drawBlip(s.x, s.z, '#57e38a', '', false, 3); });
    // Игрок — стрелка.
    const yaw = pl.vehicle ? pl.vehicle.yaw : pl.char.yaw;
    c.save();
    c.translate(S / 2, S / 2);
    c.rotate(rot - yaw + Math.PI);
    c.fillStyle = '#fff';
    c.strokeStyle = '#000';
    c.lineWidth = 1.5 * this.dpr;
    c.beginPath();
    c.moveTo(0, -8 * this.dpr); c.lineTo(5.5 * this.dpr, 6 * this.dpr); c.lineTo(0, 3 * this.dpr); c.lineTo(-5.5 * this.dpr, 6 * this.dpr);
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();
    // «С» — север.
    const [nx, ny] = (() => { const cs = Math.cos(rot), sn = Math.sin(rot); return [S / 2 + (0 * cs - -R * sn) * 1, S / 2 + (0 * sn + -R * cs)]; })();
    c.fillStyle = '#fff';
    c.font = `bold ${10 * this.dpr}px sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('С', nx, ny);
    // Рамка.
    c.strokeStyle = 'rgba(255,255,255,0.5)';
    c.lineWidth = 2 * this.dpr;
    c.beginPath();
    c.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
    c.stroke();
  }

  /** Полноэкранная карта: возвращает элемент и функцию уничтожения. */
  openFullMap(container: HTMLElement, onClose: () => void) {
    const g = this.game;
    const wrap = document.createElement('div');
    wrap.className = 'fullmap';
    const cv = document.createElement('canvas');
    wrap.appendChild(cv);
    const legend = document.createElement('div');
    legend.className = 'fullmap-legend';
    legend.innerHTML = '<b>Карта Порт-Вельмара</b><br><span style="color:#ffd23b">●</span> Сюжет <span style="color:#3be0ff">●</span> Подработка <span style="color:#ff6b4a">●</span> Магазины <span style="color:#57e38a">●</span> Мастерская<br>Тап — поставить метку GPS';
    wrap.appendChild(legend);
    const close = document.createElement('button');
    close.className = 'btn close';
    close.textContent = '✕';
    close.onclick = () => { wrap.remove(); onClose(); };
    wrap.appendChild(close);
    container.appendChild(wrap);
    const ctx = cv.getContext('2d')!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pp = g.player.char.pos;
    let cx = pp.x, cz = pp.z, zoom = 0.6; // пикселей экрана на метр
    const draw = () => {
      cv.width = wrap.clientWidth * dpr; cv.height = wrap.clientHeight * dpr;
      cv.style.width = wrap.clientWidth + 'px'; cv.style.height = wrap.clientHeight + 'px';
      const W = cv.width, H = cv.height;
      ctx.fillStyle = '#14303c';
      ctx.fillRect(0, 0, W, H);
      const k = zoom * dpr;
      const sx = (x: number) => W / 2 + (x - cx) * k, sz = (z: number) => H / 2 + (z - cz) * k;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.base, sx(MAP.x0), sz(MAP.z0), MAP.size * k, MAP.size * k);
      if (g.markers.route.length >= 4) {
        ctx.strokeStyle = '#c66bff'; ctx.lineWidth = 3 * dpr; ctx.beginPath();
        for (let i = 0; i < g.markers.route.length; i += 2) { const x = sx(g.markers.route[i]), z = sz(g.markers.route[i + 1]); if (i) ctx.lineTo(x, z); else ctx.moveTo(x, z); }
        ctx.stroke();
      }
      ctx.font = `bold ${11 * dpr}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const b of g.markers.blips) {
        const p = g.markers.blipPos(b);
        if (!p) continue;
        ctx.fillStyle = b.color; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sx(p.x), sz(p.z), 8 * dpr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#000'; ctx.fillText(b.icon || '', sx(p.x), sz(p.z) + 1);
        if (b.label && zoom > 0.45) { ctx.fillStyle = '#fff'; ctx.fillText(b.label, sx(p.x), sz(p.z) - 16 * dpr); }
      }
      if (g.markers.waypoint) { ctx.fillStyle = '#c66bff'; ctx.beginPath(); ctx.arc(sx(g.markers.waypoint.x), sz(g.markers.waypoint.z), 7 * dpr, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(sx(pp.x), sz(pp.z), 6 * dpr, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#000'; ctx.stroke();
    };
    draw();
    // Перетаскивание, масштаб, метка.
    const pts = new Map<number, { x: number; y: number }>();
    let moved = 0;
    let pinch0 = 0, zoom0 = zoom;
    cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = 0; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); zoom0 = zoom; } });
    cv.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      if (pts.size === 2) {
        p.x = e.clientX; p.y = e.clientY;
        const [a, b] = [...pts.values()];
        zoom = THREE.MathUtils.clamp(zoom0 * Math.hypot(a.x - b.x, a.y - b.y) / (pinch0 || 1), 0.15, 3);
        moved = 99;
      } else {
        cx -= (e.clientX - p.x) / zoom; cz -= (e.clientY - p.y) / zoom;
        moved += Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y);
        p.x = e.clientX; p.y = e.clientY;
      }
      draw();
    });
    cv.addEventListener('pointerup', (e) => {
      pts.delete(e.pointerId);
      if (moved < 8 && pts.size === 0) {
        const r = cv.getBoundingClientRect();
        const x = cx + (e.clientX - r.left - r.width / 2) / zoom, z = cz + (e.clientY - r.top - r.height / 2) / zoom;
        g.markers.waypoint = new THREE.Vector3(x, 0, z);
        g.hud.toast('Метка GPS установлена');
        draw();
      }
    });
    cv.addEventListener('wheel', (e) => { zoom = THREE.MathUtils.clamp(zoom * (e.deltaY > 0 ? 0.85 : 1.18), 0.15, 3); draw(); }, { passive: true });
  }
}
