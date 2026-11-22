/**
 * HUD: здоровье/броня, деньги, звёзды розыска, оружие и патроны, спидометр,
 * прицел, цель миссии, субтитры, всплывающие уведомления, большие баннеры, FPS/статистика.
 * Миникарта рисуется отдельным модулем (Minimap) в контейнер HUD.
 */
import { money } from '../core/MathUtil';
import { WEAPONS } from '../entities/Weapons';
import type { Game } from '../game/Game';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
}

export class HUD {
  readonly root: HTMLDivElement;
  private hp: HTMLDivElement;
  private ar: HTMLDivElement;
  private moneyEl: HTMLDivElement;
  private stars: HTMLDivElement;
  private weapon: HTMLDivElement;
  private ammo: HTMLDivElement;
  private speedo: HTMLDivElement;
  private cross: HTMLDivElement;
  private objective: HTMLDivElement;
  private subtitle: HTMLDivElement;
  private toasts: HTMLDivElement;
  private banner: HTMLDivElement;
  private stats: HTMLDivElement;
  private prompt: HTMLDivElement;
  private letterbox: HTMLDivElement;
  private district: HTMLDivElement;
  private timerEl: HTMLDivElement;
  private dmgFlash: HTMLDivElement;
  private fadeEl: HTMLDivElement;
  private photo: HTMLDivElement;
  readonly mapSlot: HTMLDivElement;
  showStats = false;
  private lastMoney = -1;
  private shownMoney = 0;
  private lastHp = 100;
  private districtTimer = 0;
  private lastDistrict = '';

  constructor(private game: Game, parent: HTMLElement) {
    this.root = el('div', 'hud', parent);
    this.mapSlot = el('div', 'hud-map', this.root);
    const bars = el('div', 'hud-bars', this.mapSlot);
    this.hp = el('div', 'bar hp', bars, '<i></i>');
    this.ar = el('div', 'bar ar', bars, '<i></i>');
    const tr = el('div', 'hud-tr', this.root);
    this.moneyEl = el('div', 'hud-money', tr);
    this.stars = el('div', 'hud-stars', tr);
    const wb = el('div', 'hud-weapon', tr);
    this.weapon = el('div', 'w-name', wb);
    this.ammo = el('div', 'w-ammo', wb);
    this.speedo = el('div', 'hud-speedo', this.root);
    this.cross = el('div', 'hud-cross', this.root, '<i></i><i></i><i></i><i></i>');
    this.objective = el('div', 'hud-objective', this.root);
    this.timerEl = el('div', 'hud-timer', this.root);
    this.subtitle = el('div', 'hud-subtitle', this.root);
    this.toasts = el('div', 'hud-toasts', this.root);
    this.banner = el('div', 'hud-banner', this.root);
    this.stats = el('div', 'hud-stats', this.root);
    this.prompt = el('div', 'hud-prompt', this.root);
    this.letterbox = el('div', 'hud-letterbox', this.root, '<i></i><i></i>');
    this.district = el('div', 'hud-district', this.root);
    this.dmgFlash = el('div', 'hud-dmg', this.root);
    this.photo = el('div', 'hud-photo', this.root);
    this.fadeEl = el('div', 'hud-fade', parent);
  }

  toast(text: string, kind: 'info' | 'good' | 'bad' = 'info') {
    const t = el('div', `toast ${kind}`, this.toasts, text);
    setTimeout(() => t.classList.add('out'), 3200);
    setTimeout(() => t.remove(), 3800);
    while (this.toasts.children.length > 4) this.toasts.firstChild?.remove();
  }

  /** Большой баннер по центру («МИССИЯ ВЫПОЛНЕНА»). */
  showBanner(title: string, sub = '', kind: 'good' | 'bad' | 'info' = 'info', ms = 3500) {
    this.banner.innerHTML = `<div class="b-title ${kind}">${title}</div>${sub ? `<div class="b-sub">${sub}</div>` : ''}`;
    this.banner.classList.add('on');
    clearTimeout((this.banner as unknown as { _t: number })._t);
    (this.banner as unknown as { _t: number })._t = window.setTimeout(() => this.banner.classList.remove('on'), ms);
  }

  setObjective(text: string) {
    this.objective.innerHTML = text;
    this.objective.classList.toggle('on', !!text);
  }

  setTimer(sec: number | null, label = '') {
    if (sec === null) { this.timerEl.classList.remove('on'); return; }
    const m = Math.floor(Math.max(0, sec) / 60), s = Math.floor(Math.max(0, sec) % 60);
    this.timerEl.innerHTML = `${label ? `<span>${label}</span>` : ''}${m}:${s.toString().padStart(2, '0')}`;
    this.timerEl.classList.add('on');
    this.timerEl.classList.toggle('warn', sec < 10);
  }

  setSubtitle(speaker: string, text: string, color = '#ffb13b') {
    if (!text) { this.subtitle.classList.remove('on'); return; }
    this.subtitle.innerHTML = speaker ? `<b style="color:${color}">${speaker}:</b> ${text}` : text;
    this.subtitle.classList.add('on');
  }

  private promptSet = false;
  private promptText = '';
  /** Подсказка действия: модули выставляют её каждый кадр, иначе она скрывается. */
  setPrompt(text: string) {
    if (text) this.promptSet = true;
    if (text === this.promptText) return;
    this.promptText = text;
    this.prompt.innerHTML = text;
    this.prompt.classList.toggle('on', !!text);
  }
  get hasPrompt() {
    return !!this.promptText;
  }

  setLetterbox(on: boolean) {
    this.letterbox.classList.toggle('on', on);
    this.root.classList.toggle('cinematic', on);
  }

  /** Затемнение экрана с подписью (смена сцены). */
  fade(on: boolean, text = '') {
    this.fadeEl.innerHTML = text ? `<span>${text}</span>` : '';
    this.fadeEl.classList.toggle('on', on);
  }

  photoFlash() {
    this.photo.classList.remove('on');
    void this.photo.offsetWidth;
    this.photo.classList.add('on');
  }

  damageFlash() {
    this.dmgFlash.classList.remove('on');
    void this.dmgFlash.offsetWidth;
    this.dmgFlash.classList.add('on');
  }

  update(dt: number) {
    const g = this.game;
    if (!this.promptSet && this.promptText) this.setPrompt('');
    this.promptSet = false;
    const c = g.player.char;
    this.hp.style.setProperty('--v', `${Math.max(0, c.health / c.maxHealth) * 100}%`);
    this.ar.style.setProperty('--v', `${Math.max(0, c.armor)}%`);
    this.ar.style.display = c.armor > 0 ? '' : 'none';
    if (c.health < this.lastHp - 0.5) this.damageFlash();
    this.lastHp = c.health;
    // Деньги «докручиваются».
    const m = g.economy.money;
    if (this.lastMoney < 0) this.shownMoney = m;
    this.shownMoney += (m - this.shownMoney) * Math.min(1, dt * 6);
    if (Math.abs(m - this.shownMoney) < 1) this.shownMoney = m;
    this.moneyEl.textContent = money(this.shownMoney);
    this.lastMoney = m;
    // Розыск.
    const lvl = g.police?.wanted ?? 0;
    const flashing = g.police?.searching ?? false;
    let st = '';
    for (let i = 0; i < 5; i++) st += `<i class="${i < lvl ? 'on' : ''}${i < lvl && flashing ? ' blink' : ''}">★</i>`;
    this.stars.innerHTML = st;
    this.stars.style.opacity = lvl > 0 ? '1' : '0.25';
    // Оружие.
    const w = WEAPONS[c.weapon];
    this.weapon.textContent = w.name;
    const a = c.ammo[c.weapon];
    this.ammo.textContent = a ? `${a.mag} / ${a.reserve}` : '';
    // Спидометр.
    const v = g.player.vehicle;
    if (v) {
      const kmh = Math.round(Math.abs(v.speed) * 3.6);
      const hpPct = Math.round((v.health / v.maxHealth) * 100);
      const alt = v.spec.type === 'heli' ? `<small>ВЫС ${Math.round(v.position().y)} м</small>` : '';
      this.speedo.innerHTML = `<b>${kmh}</b><span>км/ч</span>${alt}<div class="vhp"><i style="width:${hpPct}%"></i></div><em>${v.spec.name}</em>`;
      this.speedo.classList.add('on');
    } else this.speedo.classList.remove('on');
    // Прицел.
    const aiming = !v && c.model.anim.aiming;
    this.cross.classList.toggle('on', aiming);
    this.cross.classList.toggle('lock', aiming && !!g.player.aimTarget);
    // Подсказка «действие» сбрасывается каждый кадр — модули выставляют её заново.
    // Район.
    const dn = g.currentDistrictName();
    if (dn !== this.lastDistrict) { this.lastDistrict = dn; this.district.textContent = dn; this.district.classList.add('on'); this.districtTimer = 3; }
    if (this.districtTimer > 0) { this.districtTimer -= dt; if (this.districtTimer <= 0) this.district.classList.remove('on'); }
    // Статистика.
    if (this.showStats) {
      const s = g.engine.stats;
      this.stats.style.display = 'block';
      this.stats.innerHTML = `FPS ${s.fps.toFixed(0)} · ${s.frameMs.toFixed(1)} мс<br>draw ${s.calls} · tri ${(s.triangles / 1000).toFixed(0)}k<br>${s.preset.toUpperCase()} · ×${s.scale.toFixed(2)}<br>чанки ${g.world.stats.loadedChunks}/${g.world.stats.lod1Chunks} · авто ${g.vehicles.count} · люди ${g.characters.size}`;
    } else this.stats.style.display = 'none';
  }

  setVisible(v: boolean) {
    this.root.style.display = v ? '' : 'none';
  }
}
