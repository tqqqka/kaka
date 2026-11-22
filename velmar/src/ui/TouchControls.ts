/**
 * Сенсорное управление: плавающий виртуальный стик слева, обзор пальцем справа,
 * контекстные кнопки (пешком / машина / вертолёт / лодка). Мультитач через Pointer Events.
 * Раскладку можно редактировать (перетаскивание, размер, прозрачность) — сохраняется в настройках.
 */
import type { Action, Input } from '../core/Input';
import type { Game } from '../game/Game';
import type { ControlLayout } from '../game/Save';

interface BtnDef {
  id: string;
  label: string;
  action: Action;
  /** Позиция по умолчанию: доли ширины/высоты от правого-нижнего угла. */
  rx: number;
  ry: number;
  size: number;
  modes: ('foot' | 'car' | 'heli' | 'boat')[];
  hold?: boolean;
  cls?: string;
}

const BUTTONS: BtnDef[] = [
  { id: 'fire', label: '🔫', action: 'fire', rx: 0.075, ry: 0.36, size: 78, modes: ['foot'], hold: true, cls: 'big red' },
  { id: 'aim', label: '◎', action: 'aim', rx: 0.2, ry: 0.42, size: 58, modes: ['foot'], hold: true },
  { id: 'jump', label: '⤒', action: 'jump', rx: 0.075, ry: 0.13, size: 64, modes: ['foot'] },
  { id: 'sprint', label: '»', action: 'sprint', rx: 0.19, ry: 0.13, size: 58, modes: ['foot'], hold: true },
  { id: 'melee', label: '✊', action: 'melee', rx: 0.3, ry: 0.12, size: 52, modes: ['foot'] },
  { id: 'cover', label: '▣', action: 'cover', rx: 0.3, ry: 0.3, size: 50, modes: ['foot'] },
  { id: 'reload', label: '⟳', action: 'reload', rx: 0.21, ry: 0.62, size: 46, modes: ['foot'] },
  { id: 'weapon', label: '⇆', action: 'nextWeapon', rx: 0.08, ry: 0.62, size: 52, modes: ['foot'] },
  { id: 'enter', label: '🚗', action: 'enter', rx: 0.085, ry: 0.8, size: 58, modes: ['foot', 'car', 'heli', 'boat'], cls: 'yellow' },
  { id: 'interact', label: 'E', action: 'interact', rx: 0.2, ry: 0.8, size: 50, modes: ['foot', 'car', 'boat'] },
  { id: 'gas', label: '▲', action: 'gas', rx: 0.08, ry: 0.15, size: 84, modes: ['car', 'boat', 'heli'], hold: true, cls: 'big green' },
  { id: 'brake', label: '▼', action: 'brake', rx: 0.21, ry: 0.11, size: 70, modes: ['car', 'boat', 'heli'], hold: true, cls: 'big' },
  { id: 'handbrake', label: 'P', action: 'handbrake', rx: 0.25, ry: 0.36, size: 56, modes: ['car'], hold: true },
  { id: 'horn', label: '📯', action: 'horn', rx: 0.1, ry: 0.45, size: 50, modes: ['car', 'boat'], hold: true },
  { id: 'radio', label: '♫', action: 'radio', rx: 0.3, ry: 0.58, size: 44, modes: ['car', 'boat', 'heli'] },
  { id: 'siren', label: '🚨', action: 'camera', rx: 0.2, ry: 0.58, size: 44, modes: ['car'] },
  { id: 'yawL', label: '⟲', action: 'yawL', rx: 0.33, ry: 0.13, size: 52, modes: ['heli'], hold: true },
  { id: 'yawR', label: '⟳', action: 'yawR', rx: 0.33, ry: 0.32, size: 52, modes: ['heli'], hold: true },
];

export class TouchControls {
  readonly root: HTMLDivElement;
  private stickBase: HTMLDivElement;
  private stickKnob: HTMLDivElement;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private btns = new Map<string, { def: BtnDef; el: HTMLDivElement }>();
  private topBar: HTMLDivElement;
  private skipBtn!: HTMLDivElement;
  private cine = false;
  editing = false;
  enabled = true;
  private mode: BtnDef['modes'][number] = 'foot';
  layout: ControlLayout = {};
  opacity = 0.75;
  scale = 1;
  onLayoutChange: ((l: ControlLayout) => void) | null = null;
  onPause: (() => void) | null = null;
  onMap: (() => void) | null = null;

  constructor(private game: Game, private input: Input, parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'touch';
    parent.appendChild(this.root);
    this.stickBase = document.createElement('div');
    this.stickBase.className = 'stick';
    this.stickKnob = document.createElement('div');
    this.stickKnob.className = 'knob';
    this.stickBase.appendChild(this.stickKnob);
    this.root.appendChild(this.stickBase);
    for (const def of BUTTONS) {
      const el = document.createElement('div');
      el.className = `tbtn ${def.cls ?? ''}`;
      el.innerHTML = `<span>${def.label}</span>`;
      el.dataset.id = def.id;
      this.root.appendChild(el);
      this.btns.set(def.id, { def, el });
      this.bindButton(def, el);
    }
    this.topBar = document.createElement('div');
    this.topBar.className = 'touch-top';
    this.topBar.innerHTML = '<div class="tbtn small" data-a="map">🗺</div><div class="tbtn small" data-a="pause">❚❚</div>';
    // Кнопка «пропустить реплику» в катсценах.
    this.skipBtn = document.createElement('div');
    this.skipBtn.className = 'tbtn skip';
    this.skipBtn.innerHTML = '<span>▶▶</span>';
    this.root.appendChild(this.skipBtn);
    this.skipBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.input.touchDown('skip'); setTimeout(() => this.input.touchUp('skip'), 60); });
    this.root.appendChild(this.topBar);
    this.topBar.querySelector('[data-a=map]')!.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.onMap?.(); });
    this.topBar.querySelector('[data-a=pause]')!.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.onPause?.(); });
    // Стик и обзор — на всём слое.
    this.root.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', (e) => this.onUp(e));
    this.applyLayout();
    window.addEventListener('resize', () => this.applyLayout());
    this.show(this.isTouchDevice());
  }

  isTouchDevice() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0 || new URLSearchParams(location.search).has('touch');
  }

  show(v: boolean) {
    this.root.style.display = v ? '' : 'none';
  }

  private bindButton(def: BtnDef, el: HTMLDivElement) {
    let drag: { id: number; ox: number; oy: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      if (this.editing) {
        const r = el.getBoundingClientRect();
        drag = { id: e.pointerId, ox: e.clientX - r.left - r.width / 2, oy: e.clientY - r.top - r.height / 2 };
        return;
      }
      el.classList.add('down');
      this.input.touchDown(def.action);
      if (this.game.settings?.vibration) navigator.vibrate?.(8);
      if (!def.hold) setTimeout(() => this.input.touchUp(def.action), 60);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.editing || !drag || drag.id !== e.pointerId) return;
      const W = window.innerWidth, H = window.innerHeight;
      const cx = e.clientX - drag.ox, cy = e.clientY - drag.oy;
      this.layout[def.id] = { x: (W - cx) / W, y: (H - cy) / H, s: this.layout[def.id]?.s ?? 1 };
      this.applyLayout();
    });
    const up = (e: PointerEvent) => {
      if (this.editing) { if (drag) this.onLayoutChange?.(this.layout); drag = null; return; }
      el.classList.remove('down');
      if (def.hold) this.input.touchUp(def.action);
      void e;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  applyLayout() {
    const W = window.innerWidth, H = window.innerHeight;
    const k = Math.min(1.25, Math.max(0.7, Math.min(W, H) / 420)) * this.scale;
    for (const { def, el } of this.btns.values()) {
      const l = this.layout[def.id];
      const rx = l?.x ?? def.rx, ry = l?.y ?? def.ry;
      const size = def.size * k * (l?.s ?? 1);
      el.style.width = el.style.height = size + 'px';
      el.style.left = W - rx * W - size / 2 + 'px';
      el.style.top = H - ry * H - size / 2 + 'px';
      el.style.fontSize = size * 0.38 + 'px';
      el.style.opacity = String(this.opacity);
    }
    this.stickBase.style.width = this.stickBase.style.height = 130 * k + 'px';
    this.stickKnob.style.width = this.stickKnob.style.height = 56 * k + 'px';
  }

  resetLayout() {
    this.layout = {};
    this.applyLayout();
    this.onLayoutChange?.(this.layout);
  }

  setEditing(on: boolean) {
    this.editing = on;
    this.root.classList.toggle('editing', on);
    if (on) for (const { el } of this.btns.values()) el.style.display = '';
  }

  private onDown(e: PointerEvent) {
    if (!this.enabled || this.editing) return;
    const W = window.innerWidth;
    if (e.clientX < W * 0.42 && this.stickId === null) {
      this.stickId = e.pointerId;
      this.stickOrigin = { x: e.clientX, y: e.clientY };
      this.stickBase.style.left = e.clientX + 'px';
      this.stickBase.style.top = e.clientY + 'px';
      this.stickBase.classList.add('on');
      this.stickKnob.style.transform = 'translate(-50%,-50%)';
    } else if (this.lookId === null) {
      this.lookId = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
    }
    this.input.lastDevice = 'touch';
  }

  private onMove(e: PointerEvent) {
    if (e.pointerId === this.stickId) {
      const R = this.stickBase.clientWidth / 2;
      let dx = e.clientX - this.stickOrigin.x, dy = e.clientY - this.stickOrigin.y;
      const d = Math.hypot(dx, dy);
      if (d > R) { dx = (dx / d) * R; dy = (dy / d) * R; }
      this.stickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      const nx = dx / R, ny = -dy / R;
      const mag = Math.hypot(nx, ny);
      const dead = 0.12;
      const k = mag < dead ? 0 : (mag - dead) / (1 - dead) / (mag || 1);
      this.input.touchMoveX = nx * k;
      this.input.touchMoveY = ny * k;
    } else if (e.pointerId === this.lookId) {
      this.input.touchLook(e.clientX - this.lookLast.x, e.clientY - this.lookLast.y);
      this.lookLast = { x: e.clientX, y: e.clientY };
    }
  }

  private onUp(e: PointerEvent) {
    if (e.pointerId === this.stickId) {
      this.stickId = null;
      this.input.touchMoveX = this.input.touchMoveY = 0;
      this.stickBase.classList.remove('on');
    } else if (e.pointerId === this.lookId) this.lookId = null;
  }

  /** Показ кнопок по режиму (пешком/машина/вертолёт/лодка). */
  update() {
    if (this.editing) return;
    const cine = this.game.player.state === 'cutscene';
    if (cine !== this.cine) {
      this.cine = cine;
      this.root.classList.toggle('cine', cine);
    }
    const v = this.game.player.vehicle;
    const mode = !v ? 'foot' : v.spec.type === 'heli' ? 'heli' : v.spec.type === 'boat' ? 'boat' : 'car';
    if (mode !== this.mode) {
      this.mode = mode;
      for (const { def, el } of this.btns.values()) el.style.display = def.modes.includes(mode) ? '' : 'none';
    }
    const siren = this.btns.get('siren');
    if (siren) siren.el.style.display = mode === 'car' && v?.kind === 'police' ? '' : 'none';
  }

  /** Подсветка кнопки «Действие», когда рядом есть с чем взаимодействовать. */
  highlight(id: string, on: boolean) {
    this.btns.get(id)?.el.classList.toggle('hl', on);
  }

  forceModeRefresh() {
    this.mode = 'foot';
    for (const { def, el } of this.btns.values()) el.style.display = def.modes.includes('foot') ? '' : 'none';
  }
}
