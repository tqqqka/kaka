/**
 * Магазины и сервисы: оружейная «Калибр», мастерская Нины (сохранение, ремонт, тюнинг,
 * покраска, гараж), покраска «Хамелеон» (сброс розыска), больница (лечение).
 * Вход — маркер у здания, действие «E» / кнопка «Действие».
 */
import * as THREE from 'three';
import type { Game, GameModule } from './Game';
import { WEAPONS, type WeaponId } from '../entities/Weapons';
import type { WorldMarker, Blip } from './Markers';

export interface ShopItem {
  label: string;
  sub?: string;
  price: number;
  disabled?: boolean;
  action: () => void;
}

interface ShopPoint {
  id: string;
  title: string;
  pos: THREE.Vector3;
  needCar: boolean;
  marker: WorldMarker;
  blip: Blip;
}

export class Shops implements GameModule {
  private points: ShopPoint[] = [];
  private paintCd = 0;
  /** Колбэк сохранения (устанавливает App). */
  onSave: (() => void) | null = null;

  constructor(private game: Game) {
    const L = game.world.layout;
    const add = (id: string, title: string, needCar: boolean, color: number, icon: string, dx = 0, dz = 0) => {
      const p = L.place(id);
      const pos = new THREE.Vector3(p.x + dx, 0, p.z + dz);
      pos.y = game.world.surfaceHeight(pos.x, pos.z);
      const marker = game.markers.addMarker(pos, needCar ? 3.5 : 1.6, color, needCar ? 6 : 3);
      const blip = game.markers.addBlip({ kind: id === 'garage' ? 'garage' : 'shop', pos, label: title, color: '#' + new THREE.Color(color).getHexString(), icon, edge: false });
      this.points.push({ id, title, pos, needCar, marker, blip });
    };
    add('gunshop', 'Оружейная «Калибр»', false, 0xff6b4a, '⌖');
    add('garage', 'Мастерская Нины', false, 0x57e38a, 'G', -4, 0);
    add('paint1', 'Покраска «Хамелеон»', true, 0xc07bff, 'P');
    add('paint2', 'Покраска «Хамелеон-2»', true, 0xc07bff, 'P');
    add('hospital', 'Больница Св. Марка', false, 0xff4d6a, '+');
  }

  update(dt: number) {
    const g = this.game;
    this.paintCd -= dt;
    if (g.missions?.active && g.missions.current?.def.story) {
      // Во время сюжетной миссии магазины работают, а покраска — нет.
    }
    const p = g.player.vehicle ? g.player.vehicle.position() : g.player.char.pos;
    for (const s of this.points) {
      const d = Math.hypot(p.x - s.pos.x, p.z - s.pos.z);
      if (d > (s.needCar ? 4 : 1.8)) continue;
      if (s.needCar) {
        if (g.player.vehicle && this.paintCd <= 0 && Math.abs(g.player.vehicle.speed) < 3) this.paint(s);
        continue;
      }
      if (g.player.vehicle) continue;
      g.hud.setPrompt(`<kbd>E</kbd> ${s.title}`);
      if (g.input.pressed('interact')) {
        g.input.consume('interact');
        this.open(s.id);
      }
    }
  }

  /** Покраска: смена цвета, ремонт и сброс розыска. */
  private paint(s: ShopPoint) {
    const g = this.game;
    const v = g.player.vehicle!;
    const price = 250;
    this.paintCd = 8;
    if ((g.police?.stars ?? 0) > 0 && g.missions?.current?.def.id === 'm5') { g.hud.toast('Сейчас здесь не спрятаться', 'bad'); return; }
    if (!g.economy.spend(price)) return;
    const c = new THREE.Color().setHSL(Math.random(), 0.6, 0.35);
    (v.mat.userData.uPaint.value as THREE.Color).copy(c);
    v.paint.copy(c);
    v.health = v.maxHealth;
    g.police?.clear();
    g.hud.showBanner('ПЕРЕКРАШЕНО', `Розыск снят · −$${price}`, 'good', 2500);
  }

  open(id: string) {
    const g = this.game;
    const ui = g.ui;
    if (!ui) return;
    if (id === 'gunshop') {
      const items: ShopItem[] = [];
      for (const w of ['pistol', 'smg', 'shotgun', 'rifle'] as WeaponId[]) {
        const def = WEAPONS[w];
        const owned = g.player.owned.has(w);
        if (!owned) items.push({ label: def.name, sub: `Урон ${def.damage}${def.pellets > 1 ? '×' + def.pellets : ''} · ${def.rate}/с`, price: def.price, action: () => { if (g.economy.spend(def.price)) { g.player.giveWeapon(w, def.ammoPack); g.player.selectWeapon(w); g.hud.toast(`Куплено: ${def.name}`, 'good'); this.open('gunshop'); } } });
        else items.push({ label: `Патроны: ${def.name}`, sub: `+${def.ammoPack} шт.`, price: def.ammoPrice, action: () => { if (g.economy.spend(def.ammoPrice)) { g.player.giveWeapon(w, def.ammoPack); this.open('gunshop'); } } });
      }
      items.push({ label: 'Бронежилет', sub: 'Броня 100', price: 400, disabled: g.player.char.armor >= 100, action: () => { if (g.economy.spend(400)) { g.player.char.armor = 100; this.open('gunshop'); } } });
      ui.shop('Оружейная «Калибр»', 'Лицензия? Какая лицензия.', items);
    } else if (id === 'garage') {
      const items: ShopItem[] = [
        { label: 'Сохранить игру', sub: 'Прогресс, деньги, оружие', price: 0, action: () => { this.onSave?.(); ui.closeModal(); } },
        { label: 'Пропустить время', sub: 'Сон до утра (6:00) / вечера (20:00)', price: 0, action: () => { g.hours = g.hours > 6 && g.hours < 20 ? 20 : 6; g.hud.toast('Время идёт...'); ui.closeModal(); } },
      ];
      const v = this.lastCar();
      if (v && !v.destroyed) {
        const dmg = 1 - v.health / v.maxHealth;
        const repair = Math.round(50 + dmg * 600);
        items.push({ label: `Ремонт «${v.spec.name}»`, sub: `Состояние ${Math.round((1 - dmg) * 100)}%`, price: repair, disabled: dmg < 0.01, action: () => { if (g.economy.spend(repair)) { v.health = v.maxHealth; v.bodyMesh.geometry = v.bodyMesh.geometry; this.open('garage'); } } });
        const up = v.upgrades;
        const lvl = (n: number) => '★'.repeat(n) + '☆'.repeat(3 - n);
        items.push({ label: `Двигатель ${lvl(up.engine)}`, sub: '+18% тяги за уровень', price: 1500 * (up.engine + 1), disabled: up.engine >= 3, action: () => { if (g.economy.spend(1500 * (up.engine + 1))) { up.engine++; this.open('garage'); } } });
        items.push({ label: `Тормоза ${lvl(up.brakes)}`, sub: '+25% силы торможения', price: 800 * (up.brakes + 1), disabled: up.brakes >= 3, action: () => { if (g.economy.spend(800 * (up.brakes + 1))) { up.brakes++; this.open('garage'); } } });
        items.push({ label: `Броня ${lvl(up.armor)}`, sub: '−18% урона кузову', price: 1200 * (up.armor + 1), disabled: up.armor >= 3, action: () => { if (g.economy.spend(1200 * (up.armor + 1))) { up.armor++; this.open('garage'); } } });
        items.push({ label: 'Покраска', sub: 'Случайный цвет', price: 150, action: () => { if (g.economy.spend(150)) { const c = new THREE.Color().setHSL(Math.random(), 0.65, 0.4); (v.mat.userData.uPaint.value as THREE.Color).copy(c); v.paint.copy(c); } } });
        items.push({ label: 'Поставить в гараж', sub: 'Машина будет ждать здесь после загрузки', price: 0, action: () => { g.garageCar = v; v.persistent = true; v.tag = 'owned'; g.hud.toast('Машина в гараже', 'good'); ui.closeModal(); } });
      } else items.push({ label: 'Нет машины рядом', sub: 'Подгоните машину к мастерской', price: 0, disabled: true, action: () => {} });
      ui.shop('Мастерская Нины', 'Сохранение, ремонт и тюнинг', items);
    } else if (id === 'hospital') {
      const c = g.player.char;
      ui.shop('Больница Св. Марка', 'Медицина без вопросов', [
        { label: 'Лечение', sub: `Здоровье ${Math.round(c.health)}/${c.maxHealth}`, price: 100, disabled: c.health >= c.maxHealth, action: () => { if (g.economy.spend(100)) { c.health = c.maxHealth; this.open('hospital'); } } },
      ]);
    }
  }

  /** Последняя машина игрока рядом с мастерской. */
  private lastCar() {
    const g = this.game;
    const p = g.player.char.pos;
    let best = null as import('../entities/Vehicle').Vehicle | null;
    let bd = 25;
    for (const v of g.vehicles.list) {
      if (v.spec.type === 'heli') continue;
      const d = v.position().distanceTo(p);
      if (d < bd && (v.tag === 'owned' || v === g.lastPlayerVehicle)) { bd = d; best = v; }
    }
    return best;
  }
}
