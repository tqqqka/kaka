// Бенчмарк: draw calls, треугольники, время CPU-симуляции и кадра по пресетам и сценариям.
// Внимание: в облаке рендер идёт через SwiftShader (CPU), поэтому мс кадра — не показатель GPU телефона;
// draw calls и треугольники от железа не зависят.
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright'); }
const browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const scenarios = [
  { id: 'street_day', time: 14, pos: [-3, 108], yaw: Math.PI, cam: null },
  { id: 'night_rain', time: 22.5, pos: [-3, 108], yaw: Math.PI, rain: true },
  { id: 'aerial', time: 17, pos: [-420, 620], yaw: 2.4, air: [-420, 260, 620, 60, 60, -150] },
  { id: 'driving', time: 19, pos: [-560, 503], yaw: Math.PI / 2, drive: true },
];
const rows = [];
for (const q of ['low', 'medium', 'high']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`http://localhost:5173/?quality=${q}&play=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.state === 'playing', null, { timeout: 120000 });
  for (const sc of scenarios) {
    const r = await page.evaluate(async (sc) => {
      const g = window.__game, T = window.__THREE;
      g.engine.governor.autoPreset = false; g.engine.governor.dynamicEnabled = false; g.engine.governor.setScale(1);
      g.hours = sc.time;
      g.weather.locked = sc.rain ? 'storm' : 'clear'; g.weather.rain = sc.rain ? 1 : 0; g.weather.wet = sc.rain ? 1 : 0;
      if (g.player.vehicle) { const v = g.player.vehicle; g.player.exitVehicle(true); g.vehicles.remove(v); }
      g.player.teleport(new T.Vector3(sc.pos[0], 0.3, sc.pos[1]), sc.yaw);
      g.world.preload(sc.pos[0], sc.pos[1]);
      if (sc.drive) { const v = g.vehicles.spawn('sedan', new T.Vector3(sc.pos[0], 0.6, sc.pos[1]), sc.yaw); g.player.enterVehicle(v); }
      g.cameraRig.snapBehind(sc.yaw);
      // Прогрев: стриминг чанков, трафик, пешеходы.
      g.skipRender = true;
      for (let i = 0; i < 40; i++) g.update(1 / 30);
      if (sc.drive) g.input.touchDown('gas');
      const t0 = performance.now();
      for (let i = 0; i < 60; i++) g.update(1 / 30);
      const cpu = (performance.now() - t0) / 60;
      g.skipRender = false;
      if (sc.air) { g.player.state = 'cutscene'; g.cameraRig.playShot({ from: new T.Vector3(sc.air[0], sc.air[1], sc.air[2]), to: new T.Vector3(sc.air[0], sc.air[1], sc.air[2]), lookFrom: new T.Vector3(sc.air[3], sc.air[4], sc.air[5]), lookTo: new T.Vector3(sc.air[3], sc.air[4], sc.air[5]), dur: 100 }); for (let i = 0; i < 30; i++) g.world.update(new T.Vector3(sc.air[0], sc.air[1], sc.air[2]), g.time); }
      // Замер кадров.
      const times = [];
      await new Promise((res) => { let n = 0, last = performance.now(); const f = (now) => { times.push(now - last); last = now; if (++n < 12) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
      const s = g.engine.stats;
      const out = { calls: s.calls, tris: s.triangles, cpuMs: +cpu.toFixed(2), frameMs: +(times.slice(4).reduce((a, b) => a + b, 0) / (times.length - 4)).toFixed(0), chunks: g.world.stats.loadedChunks, cars: g.vehicles.count, peds: g.characters.size, programs: s.programs, geos: s.geometries };
      if (sc.drive) g.input.touchUp('gas');
      if (sc.air) { g.cameraRig.endShot(); g.player.state = 'foot'; }
      return out;
    }, sc);
    rows.push({ preset: q, scenario: sc.id, ...r });
    console.log(q, sc.id, JSON.stringify(r));
  }
  await page.close();
}
fs.writeFileSync('shots/bench.json', JSON.stringify(rows, null, 2));
await browser.close();
