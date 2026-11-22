/**
 * Точка входа: загрузка, главное меню, новая игра / продолжение, сохранения,
 * настройки, пауза, карта, автоопределение качества.
 */
import './styles.css';
import * as THREE from 'three';
import { Physics } from './core/Physics';
import { guessInitialQuality, type QualityName } from './core/Quality';
import { Game } from './game/Game';
import { MissionSystem } from './game/Missions';
import { storyMissions } from './game/Story';
import { sideJobs, Packages } from './game/SideJobs';
import { Shops } from './game/Shops';
import { Storage, type SaveData, type Settings } from './game/Save';
import { UI } from './ui/UI';
import { Minimap } from './ui/Minimap';
import { TouchControls } from './ui/TouchControls';
import type { WeaponId } from './entities/Weapons';
import type { VehicleKind } from './render/VehicleModels';

const params = new URLSearchParams(location.search);
const uiRoot = document.getElementById('ui-root')!;
const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;

/** Отложить на кадр, чтобы экран загрузки успел отрисоваться. */
const tick = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function boot() {
  // Экран загрузки рисуем до тяжёлой инициализации.
  const tmp = document.createElement('div');
  tmp.className = 'loading';
  tmp.innerHTML = '<div class="logo">VELMAR</div><div class="logo-sub">НОЧНОЙ ПРИЛИВ</div><div class="bar"><i style="width:10%"></i></div><div class="ltext">Физика Rapier…</div>';
  uiRoot.appendChild(tmp);
  await tick();
  await Physics.init();
  const settings = await Storage.loadSettings();
  let save = await Storage.loadSave();
  (tmp.querySelector('.bar i') as HTMLElement).style.width = '35%';
  (tmp.querySelector('.ltext') as HTMLElement).textContent = 'Генерация города…';
  await tick();
  const forced = params.get('quality') as QualityName | null;
  const quality: QualityName = forced ?? (settings.quality === 'auto' ? guessInitialQuality() : settings.quality);
  const game = new Game(canvas, uiRoot, quality);
  game.settings = settings;
  (window as unknown as Record<string, unknown>).__game = game;
  (window as unknown as Record<string, unknown>).__THREE = THREE;
  tmp.remove();

  // --- Системы игрового процесса ---
  const missions = new MissionSystem(game);
  game.missions = missions;
  const shops = new Shops(game);
  game.shops = shops;
  const packages = new Packages(game);
  game.packages = packages;
  game.modules.push(missions, shops, packages);
  missions.register(storyMissions(game.world.layout), sideJobs(game.world.layout));
  game.minimap = new Minimap(game, game.hud.mapSlot);
  const touch = new TouchControls(game, game.input, uiRoot);

  // --- Сохранение ---
  const writeSave = async () => {
    const c = game.player.char;
    const gc = game.garageCar && !game.garageCar.destroyed ? game.garageCar : null;
    const data: SaveData = {
      v: 1, savedAt: Date.now(), hours: game.hours, money: game.economy.money, health: c.health, armor: c.armor,
      pos: [c.pos.x, c.pos.z], owned: [...game.player.owned], ammo: JSON.parse(JSON.stringify(c.ammo)),
      storyIndex: missions.storyIndex, completed: [...missions.completed], packages: [...packages.found], stats: { ...game.economy.stats },
      garage: gc ? { kind: gc.kind, paint: gc.paint.getHex(), upgrades: { ...gc.upgrades } } : null,
    };
    await Storage.writeSave(data);
    save = data;
    game.hud.toast('Игра сохранена', 'good');
  };
  shops.onSave = () => void writeSave();
  missions.onPass = () => void writeSave();

  // --- Применение настроек ---
  const applySettings = (s: Settings) => {
    const eng = game.engine;
    eng.governor.autoPreset = s.quality === 'auto' && !forced;
    if (s.quality !== 'auto' && s.quality !== eng.preset.name && !forced) eng.applyPreset(s.quality);
    eng.governor.dynamicEnabled = s.dynamicRes;
    if (!s.dynamicRes) eng.governor.setScale(1);
    eng.userScale = s.renderScale;
    eng.applyPixelRatio();
    game.hud.showStats = s.showFps || params.has('stats');
    game.input.sensitivity = s.sensitivity;
    game.input.invertY = s.invertY;
    game.player.autoAim = s.autoAim;
    game.audio.setVolumes({ master: s.master, music: s.music, sfx: s.sfx });
    game.timeScale = s.timeScale;
    touch.layout = s.layout;
    touch.opacity = s.buttonOpacity;
    touch.scale = s.buttonScale;
    touch.applyLayout();
    void Storage.writeSettings(s);
  };
  touch.onLayoutChange = (l) => { settings.layout = l; void Storage.writeSettings(settings); };

  // --- Меню ---
  const resume = () => {
    ui.close();
    game.paused = false;
    if (game.state === 'paused') game.state = 'playing';
    touch.enabled = true;
    game.input.releaseAll();
  };
  const pause = () => {
    if (game.state !== 'playing') return;
    game.state = 'paused';
    touch.enabled = false;
    if (document.pointerLockElement) document.exitPointerLock();
    ui.showPause();
  };
  const startPlaying = () => {
    ui.close();
    game.hud.setVisible(true);
    touch.show(touch.isTouchDevice());
    touch.forceModeRefresh();
    touch.enabled = true;
    game.state = 'playing';
    game.audio.init();
    game.input.releaseAll();
  };
  const resetWorldForGame = () => {
    missions.abort();
    game.traffic && (game.traffic as unknown as { clearAll(): void }).clearAll();
    game.police?.clear();
    for (const v of [...game.vehicles.list]) if (!v.playerDriving) game.vehicles.remove(v);
    if (game.player.vehicle) { const v = game.player.vehicle; game.player.exitVehicle(true); game.vehicles.remove(v); }
    game.player.char.revive(100);
    game.player.char.armor = 0;
    game.player.owned = new Set<WeaponId>(['fist']);
    game.player.char.ammo = {};
    game.player.char.setWeapon('fist');
    game.economy.money = 500;
    game.garageCar = null;
  };
  const newGame = () => {
    resetWorldForGame();
    missions.storyIndex = 0;
    missions.completed.clear();
    packages.setFound([]);
    game.hours = 19.2;
    game.weather.set('clear');
    const bus = game.world.layout.place('bus');
    game.player.respawn(new THREE.Vector3(bus.x, 0.3, bus.z), 0);
    game.world.preload(bus.x, bus.z);
    game.cameraRig.snapBehind(0);
    startPlaying();
    missions.refreshMarkers();
    missions.start(missions.defs[0]);
  };
  const continueGame = () => {
    if (!save) return newGame();
    resetWorldForGame();
    const d = save;
    game.hours = d.hours;
    game.economy.money = d.money;
    game.economy.stats = { ...game.economy.stats, ...d.stats };
    missions.storyIndex = d.storyIndex;
    missions.completed.clear();
    for (const id of d.completed) missions.completed.add(id);
    packages.setFound(d.packages);
    for (const w of d.owned) game.player.owned.add(w);
    game.player.char.ammo = d.ammo;
    const best = [...d.owned].pop() ?? 'fist';
    game.player.char.setWeapon(best);
    const gp = game.world.layout.place('garage');
    game.player.respawn(new THREE.Vector3(gp.x, 0.3, gp.z), Math.PI);
    game.player.char.health = Math.max(30, d.health);
    game.player.char.armor = d.armor;
    game.world.preload(gp.x, gp.z);
    if (d.garage) {
      const v = game.vehicles.spawn(d.garage.kind as VehicleKind, new THREE.Vector3(gp.x + 6, 0.6, gp.z), Math.PI / 2, { paint: d.garage.paint });
      v.upgrades = { ...d.garage.upgrades };
      v.persistent = true;
      v.tag = 'owned';
      game.garageCar = v;
    }
    game.cameraRig.snapBehind(Math.PI);
    startPlaying();
    missions.refreshMarkers();
    game.hud.showBanner('ПОРТ-ВЕЛЬМАР', `Миссия: ${missions.nextStory()?.title ?? 'свободная игра'}`, 'info', 3000);
  };
  const ui = new UI(game, uiRoot, {
    onNewGame: newGame,
    onContinue: continueGame,
    onResume: resume,
    onQuitToMenu: () => { missions.abort(); game.stopVehicleSounds(); toMenu(); },
    onSettings: applySettings,
    onEditLayout: (on) => { touch.show(on || touch.isTouchDevice()); touch.setEditing(on); },
    onResetLayout: () => touch.resetLayout(),
    hasSave: () => !!save,
  });
  game.ui = ui;
  touch.onPause = pause;
  touch.onMap = () => { if (game.state === 'playing') { game.state = 'paused'; touch.enabled = false; ui.showMap(resume); } };
  applySettings(settings);

  // Облёт города в меню.
  let menuT = 0;
  const toMenu = () => {
    game.state = 'menu';
    game.hud.setVisible(false);
    touch.show(false);
    ui.showMain();
    if (game.hours > 5 && game.hours < 22) game.hours = 22.7;
  };
  game.frameHooks.push((dt) => {
    if (game.state !== 'menu') return;
    menuT += dt;
    const a = menuT * 0.035 + 2.2;
    const cam = game.engine.camera;
    cam.position.set(50 + Math.cos(a) * 430, 150 + Math.sin(menuT * 0.11) * 25, -150 + Math.sin(a) * 430);
    cam.lookAt(50, 110, -150);
    game.engine.setFov(55);
  });
  // Клавиши паузы/карты, сохранение при сворачивании.
  game.frameHooks.push(() => {
    const inp = game.input;
    if (inp.pressed('pause')) {
      if (game.state === 'playing' && !ui.isOpen) pause();
      else if (ui.current === 'shop') ui.closeModal();
      else if (game.state === 'paused' && (ui.current === 'pause')) resume();
      else if (game.state === 'paused') ui.showPause();
    }
    if (inp.pressed('map') && game.state === 'playing' && !ui.isOpen) { game.state = 'paused'; ui.showMap(resume); }
    touch.update();
    touch.highlight('interact', game.hud.hasPrompt);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && game.state === 'playing') pause(); });

  // --- Цикл ---
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.max(0, (now - last) / 1000);
    last = now;
    game.update(dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  ui.hideLoading();

  // Отладочные параметры: ?play — сразу в игру, ?mission=N, ?time=, ?rain, ?pos=x,z
  if (params.has('play') || params.has('mission')) {
    const n = Number(params.get('mission') ?? '-1');
    if (n >= 0) { missions.storyIndex = n; }
    startPlaying();
    const pos = (params.get('pos') ?? '').split(',').map(Number);
    if (pos.length === 2 && !isNaN(pos[0])) { game.player.teleport(new THREE.Vector3(pos[0], 0.3, pos[1]), 0); game.world.preload(pos[0], pos[1]); }
    else { const gp = game.world.layout.place(n >= 0 ? 'garage' : 'bus'); game.player.teleport(new THREE.Vector3(gp.x, 0.3, gp.z), Math.PI); game.world.preload(gp.x, gp.z); }
    game.cameraRig.snapBehind(Math.PI);
    missions.refreshMarkers();
    if (n >= 0 && params.has('start')) missions.start(missions.defs[n]);
  } else toMenu();
  if (params.has('time')) game.hours = parseFloat(params.get('time')!);
  if (params.has('rain')) { game.weather.locked = 'storm'; game.weather.wet = 1; }
}

boot().catch((e) => {
  console.error(e);
  uiRoot.innerHTML = `<div class="loading"><div class="logo">VELMAR</div><div class="ltext" style="color:#ff6b6b">Ошибка запуска: ${String(e?.message ?? e)}</div></div>`;
});
