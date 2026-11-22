/**
 * Меню и окна: экран загрузки, главное меню, пауза, настройки, редактор раскладки
 * сенсорных кнопок, полноэкранная карта, статистика/задания, окно магазина.
 */
import type { Game } from '../game/Game';
import type { Settings } from '../game/Save';
import type { ShopItem } from '../game/Shops';
import { money } from '../core/MathUtil';

function h(tag: string, cls = '', html = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

export interface UICallbacks {
  onNewGame(): void;
  onContinue(): void;
  onResume(): void;
  onQuitToMenu(): void;
  onSettings(s: Settings): void;
  onEditLayout(on: boolean): void;
  onResetLayout(): void;
  hasSave(): boolean;
}

export class UI {
  readonly root: HTMLDivElement;
  private layer: HTMLDivElement;
  private modal: HTMLDivElement | null = null;
  private loading: HTMLDivElement;
  current: 'none' | 'main' | 'pause' | 'settings' | 'map' | 'stats' | 'shop' | 'layout' | 'about' = 'none';
  private back: (() => void) | null = null;

  constructor(private game: Game, parent: HTMLElement, private cb: UICallbacks) {
    this.root = h('div', 'ui') as HTMLDivElement;
    parent.appendChild(this.root);
    this.layer = h('div', 'ui-layer') as HTMLDivElement;
    this.root.appendChild(this.layer);
    this.loading = h('div', 'loading', `<div class="logo">VELMAR</div><div class="logo-sub">НОЧНОЙ ПРИЛИВ</div><div class="bar"><i></i></div><div class="ltext">Загрузка...</div>`) as HTMLDivElement;
    this.root.appendChild(this.loading);
  }

  setLoading(p: number, text: string) {
    (this.loading.querySelector('.bar i') as HTMLElement).style.width = `${Math.round(p * 100)}%`;
    (this.loading.querySelector('.ltext') as HTMLElement).textContent = text;
  }
  hideLoading() {
    this.loading.classList.add('out');
    setTimeout(() => this.loading.remove(), 600);
  }

  private clear() {
    this.layer.innerHTML = '';
    this.layer.className = 'ui-layer';
    this.current = 'none';
    this.back = null;
  }

  private panel(title: string, cls = ''): HTMLElement {
    this.layer.innerHTML = '';
    this.layer.className = `ui-layer on ${cls}`;
    const p = h('div', 'panel');
    if (title) p.appendChild(h('h2', '', title));
    this.layer.appendChild(p);
    return p;
  }

  private button(parent: HTMLElement, text: string, fn: () => void, cls = '') {
    const b = h('button', `btn ${cls}`, text) as HTMLButtonElement;
    b.addEventListener('click', (e) => { e.stopPropagation(); this.game.audio.init(); this.game.audio.ui('click'); fn(); });
    parent.appendChild(b);
    return b;
  }

  // ------------------------------------------------------------------ главное меню
  showMain() {
    this.clear();
    this.current = 'main';
    this.layer.className = 'ui-layer on main';
    const w = h('div', 'main-menu');
    w.appendChild(h('div', 'logo', 'VELMAR'));
    w.appendChild(h('div', 'logo-sub', 'НОЧНОЙ ПРИЛИВ'));
    const list = h('div', 'menu-list');
    if (this.cb.hasSave()) this.button(list, 'Продолжить', () => this.cb.onContinue(), 'primary');
    this.button(list, 'Новая игра', () => {
      if (this.cb.hasSave()) this.confirm('Начать заново? Текущее сохранение будет перезаписано при следующем сохранении.', () => this.cb.onNewGame());
      else this.cb.onNewGame();
    }, this.cb.hasSave() ? '' : 'primary');
    this.button(list, 'Настройки', () => this.showSettings(() => this.showMain()));
    this.button(list, 'Управление', () => this.showControlsHelp(() => this.showMain()));
    this.button(list, 'Об игре', () => this.showAbout(() => this.showMain()));
    w.appendChild(list);
    w.appendChild(h('div', 'menu-foot', 'Процедурный город · Three.js + Rapier · v1.0'));
    this.layer.appendChild(w);
  }

  // ------------------------------------------------------------------ пауза
  showPause() {
    const g = this.game;
    const p = this.panel('Пауза');
    this.current = 'pause';
    const info = h('div', 'pause-info');
    const st = g.missions?.current;
    info.innerHTML = `<div>${g.currentDistrictName()} · ${String(Math.floor(g.hours)).padStart(2, '0')}:${String(Math.floor((g.hours % 1) * 60)).padStart(2, '0')}</div>
      <div>${money(g.economy.money)} · Миссия: ${st ? st.def.title : g.missions?.nextStory()?.title ?? 'сюжет пройден'}</div>`;
    p.appendChild(info);
    this.button(p, 'Продолжить', () => this.cb.onResume(), 'primary');
    this.button(p, 'Карта', () => this.showMap(() => this.showPause()));
    this.button(p, 'Задания и статистика', () => this.showStats(() => this.showPause()));
    this.button(p, 'Настройки', () => this.showSettings(() => this.showPause()));
    this.button(p, 'Раскладка кнопок', () => this.showLayoutEditor(() => this.showPause()));
    if (st) this.button(p, 'Отменить миссию', () => { g.missions?.abort(); this.cb.onResume(); });
    this.button(p, 'Выйти в меню', () => this.confirm('Выйти в главное меню? Несохранённый прогресс будет потерян (сохраняйтесь в мастерской).', () => this.cb.onQuitToMenu()));
  }

  close() {
    this.clear();
  }

  // ------------------------------------------------------------------ настройки
  showSettings(back: () => void) {
    const g = this.game;
    const s = g.settings!;
    const p = this.panel('Настройки', 'wide');
    this.current = 'settings';
    const form = h('div', 'settings');
    const row = (label: string, el: HTMLElement) => { const r = h('label', 'srow'); r.appendChild(h('span', '', label)); r.appendChild(el); form.appendChild(r); };
    const select = (value: string, opts: [string, string][], on: (v: string) => void) => {
      const sel = document.createElement('select');
      for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; if (v === value) o.selected = true; sel.appendChild(o); }
      sel.onchange = () => on(sel.value);
      return sel;
    };
    const range = (value: number, min: number, max: number, step: number, on: (v: number) => void, fmt = (v: number) => v.toFixed(2)) => {
      const w = h('span', 'range');
      const r = document.createElement('input');
      r.type = 'range'; r.min = String(min); r.max = String(max); r.step = String(step); r.value = String(value);
      const out = h('em', '', fmt(value));
      r.oninput = () => { out.textContent = fmt(+r.value); on(+r.value); };
      w.appendChild(r); w.appendChild(out);
      return w;
    };
    const check = (value: boolean, on: (v: boolean) => void) => {
      const c = document.createElement('input'); c.type = 'checkbox'; c.checked = value; c.onchange = () => on(c.checked); return c;
    };
    const apply = () => this.cb.onSettings(s);
    row('Качество графики', select(s.quality, [['auto', 'Авто (по FPS)'], ['low', 'Низкое'], ['medium', 'Среднее'], ['high', 'Высокое']], (v) => { s.quality = v as Settings['quality']; apply(); }));
    row('Масштаб разрешения', range(s.renderScale, 0.5, 1, 0.05, (v) => { s.renderScale = v; apply(); }, (v) => `${Math.round(v * 100)}%`));
    row('Динамическое разрешение', check(s.dynamicRes, (v) => { s.dynamicRes = v; apply(); }));
    row('Показывать FPS', check(s.showFps, (v) => { s.showFps = v; apply(); }));
    row('Чувствительность камеры', range(s.sensitivity, 0.3, 2.5, 0.05, (v) => { s.sensitivity = v; apply(); }));
    row('Инверсия по вертикали', check(s.invertY, (v) => { s.invertY = v; apply(); }));
    row('Автоприцел (тач/геймпад)', check(s.autoAim, (v) => { s.autoAim = v; apply(); }));
    row('Вибрация', check(s.vibration, (v) => { s.vibration = v; apply(); }));
    row('Громкость: общая', range(s.master, 0, 1, 0.05, (v) => { s.master = v; apply(); }, (v) => `${Math.round(v * 100)}%`));
    row('Громкость: радио', range(s.music, 0, 1, 0.05, (v) => { s.music = v; apply(); }, (v) => `${Math.round(v * 100)}%`));
    row('Громкость: эффекты', range(s.sfx, 0, 1, 0.05, (v) => { s.sfx = v; apply(); }, (v) => `${Math.round(v * 100)}%`));
    row('Скорость времени суток', range(s.timeScale, 0, 4, 0.25, (v) => { s.timeScale = v; apply(); }, (v) => (v === 0 ? 'стоп' : `×${v}`)));
    p.appendChild(form);
    const bar = h('div', 'row-btns');
    this.button(bar, 'Назад', back, 'primary');
    p.appendChild(bar);
  }

  // ------------------------------------------------------------------ раскладка
  showLayoutEditor(back: () => void) {
    const g = this.game;
    this.clear();
    this.current = 'layout';
    this.layer.className = 'ui-layer on layout';
    const bar = h('div', 'layout-bar');
    bar.appendChild(h('div', '', 'Перетаскивайте кнопки. Размер и прозрачность:'));
    const sz = document.createElement('input');
    sz.type = 'range'; sz.min = '0.6'; sz.max = '1.6'; sz.step = '0.05'; sz.value = String(g.settings!.buttonScale);
    sz.oninput = () => { g.settings!.buttonScale = +sz.value; this.cb.onSettings(g.settings!); };
    const op = document.createElement('input');
    op.type = 'range'; op.min = '0.2'; op.max = '1'; op.step = '0.05'; op.value = String(g.settings!.buttonOpacity);
    op.oninput = () => { g.settings!.buttonOpacity = +op.value; this.cb.onSettings(g.settings!); };
    bar.appendChild(sz);
    bar.appendChild(op);
    this.button(bar, 'Сбросить', () => this.cb.onResetLayout());
    this.button(bar, 'Готово', () => { this.cb.onEditLayout(false); back(); }, 'primary');
    this.layer.appendChild(bar);
    this.cb.onEditLayout(true);
  }

  // ------------------------------------------------------------------ карта
  showMap(back: () => void) {
    this.clear();
    this.current = 'map';
    this.layer.className = 'ui-layer on map';
    this.game.minimap?.openFullMap(this.layer, back);
  }

  // ------------------------------------------------------------------ статистика
  showStats(back: () => void) {
    const g = this.game;
    const p = this.panel('Задания и статистика', 'wide');
    this.current = 'stats';
    const ms = g.missions!;
    const list = h('div', 'mlist');
    ms.defs.forEach((d, i) => {
      const done = ms.completed.has(d.id);
      const cur = i === ms.storyIndex;
      list.appendChild(h('div', `mitem ${done ? 'done' : cur ? 'cur' : 'locked'}`, `<b>${i + 1}. ${d.title}</b><span>${done ? '✓ выполнено' : cur ? 'доступно — жёлтый маркер' : 'закрыто'}</span><small>${done || cur ? d.desc : '…'}</small>`));
    });
    p.appendChild(h('h3', '', 'Сюжет'));
    p.appendChild(list);
    p.appendChild(h('h3', '', 'Подработка (голубые маркеры)'));
    p.appendChild(h('div', 'mlist', ms.side.map((d) => `<div class="mitem"><b>${d.title}</b><small>${d.desc}</small></div>`).join('')));
    const s = g.economy.stats;
    const t = Math.floor(s.playTime / 60);
    p.appendChild(h('h3', '', 'Статистика'));
    p.appendChild(h('div', 'stats-grid', [
      ['Время в игре', `${Math.floor(t / 60)} ч ${t % 60} мин`], ['Заработано', money(s.moneyEarned)], ['Угнано машин', s.carsStolen],
      ['Уничтожено машин', s.carsDestroyed], ['Убито врагов', s.kills], ['Полицейских', s.copsKilled], ['Смертей', s.deaths], ['Арестов', s.arrests],
      ['Пассажиров такси', s.taxiFares], ['Побед в гонках', s.racesWon], ['Тайников', `${g.packages?.found.size ?? 0}/${g.packages?.spots.length ?? 20}`],
    ].map(([a, b]) => `<div><span>${a}</span><b>${b}</b></div>`).join('')));
    const bar = h('div', 'row-btns');
    this.button(bar, 'Назад', back, 'primary');
    p.appendChild(bar);
  }

  showControlsHelp(back: () => void) {
    const p = this.panel('Управление', 'wide');
    p.appendChild(h('div', 'help', `
      <h3>Клавиатура и мышь</h3>
      <p><b>WASD</b> — движение / газ-тормоз-руль · <b>Мышь</b> — камера · <b>ЛКМ</b> — огонь · <b>ПКМ</b> — прицел<br>
      <b>Shift</b> — бег (вертолёт: вниз) · <b>Пробел</b> — прыжок / ручник (вертолёт: вверх) · <b>C</b> — укрытие · <b>V</b> — удар<br>
      <b>F</b> — сесть/выйти · <b>E</b> — действие (магазины, миссии) · <b>R</b> — перезарядка · <b>1–5, колесо, Tab</b> — оружие<br>
      <b>H</b> — сигнал · <b>N</b> — радио · <b>T</b> — мигалка (полиция) · <b>Q/E</b> — рыскание вертолёта · <b>M</b> — карта · <b>Esc</b> — пауза · <b>Enter</b> — пропустить реплику</p>
      <h3>Геймпад</h3>
      <p>Левый стик — движение · Правый — камера · RT — огонь/газ · LT — прицел/тормоз · A — прыжок/ручник · Y — сесть/выйти · B — удар · X — перезарядка · LB/RB — оружие · D-pad вверх — действие · Start — пауза · Back — карта</p>
      <h3>Сенсорный экран</h3>
      <p>Левая половина — плавающий стик. Правая — поворот камеры. Кнопки меняются в зависимости от транспорта. Раскладку можно изменить: Пауза → «Раскладка кнопок».</p>`));
    const bar = h('div', 'row-btns');
    this.button(bar, 'Назад', back, 'primary');
    p.appendChild(bar);
  }

  showAbout(back: () => void) {
    const p = this.panel('Об игре', 'wide');
    p.appendChild(h('div', 'help', `<p><b>VELMAR: Ночной прилив</b> — криминальная история о водителе Льве Корсаке, вернувшемся в Порт-Вельмар после пяти лет колонии.</p>
      <p>Весь мир, здания, машины, персонажи, текстуры и звук сгенерированы кодом: Three.js (WebGL2, PBR, каскадные тени, GTAO, bloom), физика Rapier, звук WebAudio.</p>
      <p>Районы: деловой центр «Стеклянный Шпиль», Кирпичный квартал, Ржавый Пояс, Доки, Сосновая Гряда, Солнечный Берег и Вельмарские холмы.</p>`));
    const bar = h('div', 'row-btns');
    this.button(bar, 'Назад', back, 'primary');
    p.appendChild(bar);
  }

  // ------------------------------------------------------------------ магазин
  shop(title: string, sub: string, items: ShopItem[]) {
    const g = this.game;
    g.paused = true;
    const p = this.panel(title, 'shop');
    this.current = 'shop';
    p.appendChild(h('div', 'shop-sub', `${sub} · <b>${money(g.economy.money)}</b>`));
    const list = h('div', 'shop-list');
    for (const it of items) {
      const row = h('div', `shop-item ${it.disabled ? 'dis' : ''}`, `<div><b>${it.label}</b>${it.sub ? `<small>${it.sub}</small>` : ''}</div>`);
      const b = this.button(row, it.price ? money(it.price) : 'OK', () => { if (!it.disabled) it.action(); }, it.disabled ? '' : 'primary');
      if (it.disabled) (b as HTMLButtonElement).disabled = true;
      list.appendChild(row);
    }
    p.appendChild(list);
    const bar = h('div', 'row-btns');
    this.button(bar, 'Закрыть', () => this.closeModal(), '');
    p.appendChild(bar);
  }

  closeModal() {
    this.game.paused = false;
    this.clear();
  }

  confirm(text: string, yes: () => void) {
    if (this.modal) this.modal.remove();
    const m = h('div', 'confirm') as HTMLDivElement;
    m.appendChild(h('p', '', text));
    const bar = h('div', 'row-btns');
    this.button(bar, 'Да', () => { m.remove(); this.modal = null; yes(); }, 'primary');
    this.button(bar, 'Нет', () => { m.remove(); this.modal = null; });
    m.appendChild(bar);
    this.root.appendChild(m);
    this.modal = m;
  }

  get isOpen() {
    return this.current !== 'none';
  }
}
