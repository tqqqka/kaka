// Автотест сюжета: запускает каждую миссию и проходит шаги, «читерски» выполняя цели
// (пропуск диалогов, телепорт к точкам, уничтожение врагов). Ловит исключения и зависания.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright'); }
const browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message + '\n' + e.stack));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:5173/?quality=low&play=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.state === 'playing', null, { timeout: 120000 });
const only = (process.env.ONLY ?? '0,1,2,3').split(',').map(Number);
for (const n of only) {
  const res = await page.evaluate(async (n) => {
    const g = window.__game, T = window.__THREE, ms = g.missions;
    g.skipRender = true;
    ms.abort();
    g.player.char.revive(100);
    g.state = 'playing';
    g.economy.money = 5000;
    ms.start(ms.side[n]);
    const run = ms.current;
    const log = [];
    let guard = 0;
    let lastIdx = -1, stuck = 0;
    while (ms.current === run && guard < 6000) {
      guard++;
      const step = run.steps[run.idx];
      if (run.idx !== lastIdx) { lastIdx = run.idx; stuck = 0; log.push(run.idx + ':' + (run.objectiveText || '').replace(/<[^>]+>/g, '').slice(0, 40)); } else stuck++;
      // «Читы» для продвижения.
      g.input.touchDown('skip'); g.input.touchUp('skip');
      g.player.char.health = 100;
      const pl = g.player;
      // Убить врагов.
      if (stuck > 20) for (const e of run.enemies) if (e.alive) e.damage(999, pl.char, g.time);
      // Ключевые машины: сесть, если цель «сядьте».
      if (stuck > 30 && /Сядьте|Садитесь|Захватите|Уходите|Найдите и угоните/.test(run.objectiveText)) {
        const v = run.vehicles.find((v) => !v.destroyed && !v.playerDriving && v.tag === 'mission' && v.kind !== 'police' || v.kind === 'heli' || v.kind === 'boat') ?? run.vehicles[0];
        if (/угоните/.test(run.objectiveText)) { const want = run.data.want; const v2 = g.vehicles.spawn(want, pl.char.pos.clone().add(new T.Vector3(3, 0.5, 0)), 0); pl.enterVehicle(v2); }
        else if (v && !v.playerDriving) { if (pl.vehicle) pl.exitVehicle(true); pl.enterVehicle(v); }
      }
      // Цели «доехать»: телепорт к маркеру GPS.
      const tgt = g.markers.gpsTarget;
      if (tgt && stuck > 10) {
        const needNone = /Выйдите|Подойдите|Заберите кейс|Задержите|поговорите/.test(run.objectiveText);
        if (needNone && pl.vehicle) pl.exitVehicle(true);
        if (pl.vehicle) { pl.vehicle.teleport(tgt.clone().setY(tgt.y + (pl.vehicle.spec.type === 'heli' ? 1 : 0.6)), pl.vehicle.yaw); }
        else pl.teleport(tgt.clone().setY(tgt.y + 0.2), pl.char.yaw);
      }
      // Погоня: добить машину-цель.
      if (/Догоните|Уничтожьте машину|Повредите/.test(run.objectiveText) && stuck > 5) { const v = run.data.target ?? run.data.van ?? run.data.car; if (v) v.damage(v.maxHealth * 0.6, pl.char); }
      // Стелс: нажать «сфотографировать» у точек.
      if (/Сфотографируйте/.test(run.objectiveText) && stuck > 5) {
        const pts = [...g.markers.world].filter((m) => m.radius === 1.5);
        if (pts[0]) { pl.teleport(pts[0].pos.clone(), 0); for (const e of run.enemies) e.brain.suspicion = 0; g.input.touchUp('interact'); g.input.touchDown('interact'); }
      } else g.input.touchUp('interact');
      // Посадка на крышу Шпиля.
      if (/Посадите/.test(run.objectiveText) && stuck > 10 && pl.vehicle) { pl.exitVehicle(true); pl.teleport(new T.Vector3(50, 291.3, -150), 0); }
      if (/Летите/.test(run.objectiveText) && stuck > 5 && pl.vehicle) pl.vehicle.teleport(new T.Vector3(50, 293, -150), 0);
      // Гонка: телепорт по чекпойнтам.
      if (/Гонка|гонка/.test(run.objectiveText) && pl.vehicle && tgt) pl.vehicle.teleport(tgt.clone().setY(0.6), pl.vehicle.yaw);
      g.simulate(0.2, 1 / 30);
      if (g.state === 'dead') { log.push('DEAD'); break; }
    }
    const passed = ms.completed.has(ms.side[n].id);
    const out = { n, title: ms.side[n].title, passed, steps: run.steps.length, reached: run.idx, guard, log: log.join(' | ') };
    g.skipRender = false;
    return out;
  }, n);
  console.log(JSON.stringify(res));
}
console.log('ERRORS', errors.length);
for (const e of errors.slice(0, 10)) console.log(e.slice(0, 800));
await browser.close();
