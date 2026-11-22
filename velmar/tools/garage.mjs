// Каталог транспорта: снимает каждую модель в игре (один и тот же ракурс и свет)
// и сохраняет кадры + JSON с характеристиками для сборки общей таблицы.
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright'); }
const browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:5173/?quality=high&play=1&time=15.3', { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.state === 'playing', null, { timeout: 120000 });
const ALL = [
  ['sedan', 0x8c1d1d], ['taxi', null], ['police', null], ['sport', 0xc01818], ['muscle', 0x204a80], ['suv', 0x2f6b3a],
  ['van', 0xe8e8e8], ['armored', null], ['moto', 0xc01818], ['boat', null], ['heli', 0x1d3f8c], ['policeHeli', null],
];
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
const kinds = only ? ALL.filter((k) => only.includes(k[0])) : ALL;
await page.evaluate(() => {
  const g = window.__game;
  g.traffic.max = 0; for (const v of [...g.traffic.cars]) g.vehicles.remove(v); g.traffic.cars.length = 0;
  g.peds.max = 0; for (const c of [...g.peds.peds]) g.removeCharacter(c); g.peds.peds.length = 0;
  g.hud.setVisible(false); g.player.state = 'cutscene'; g.player.char.visible = false;
  g.weather.locked = 'clear';
});
fs.mkdirSync('shots/garage', { recursive: true });
const specs = {};
for (const [kind, paint] of kinds) {
  const info = await page.evaluate(([kind, paint]) => {
    const g = window.__game, T = window.__THREE;
    if (window.__show) { g.vehicles.remove(window.__show); window.__show = null; }
    const boat = kind === 'boat';
    const pos = boat ? new T.Vector3(1100, 0, 300) : new T.Vector3(0, kind === 'heli' || kind === 'policeHeli' ? 1 : 0.8, 150);
    g.player.teleport(new T.Vector3(pos.x - 20, 0.3, pos.z + (boat ? -60 : 20)), 0);
    g.world.preload(pos.x, pos.z);
    const yaw = boat ? 0.4 : 0.35;
    const v = g.vehicles.spawn(kind, pos, yaw, paint === null ? {} : { paint });
    v.persistent = true;
    window.__show = v;
    g.simulate(1.6);
    const p = v.position();
    const len = v.spec.half[2] * 2;
    const dist = len * 1.25 + (v.spec.type === 'heli' ? 7 : v.spec.type === 'moto' ? 2.2 : 3.2);
    const a = (boat ? 1.75 : 0.8) + v.yaw;
    const h = v.spec.type === 'heli' ? 3.2 : boat ? 5.5 : v.spec.colliderY + 0.9;
    const from = new T.Vector3(p.x + Math.sin(a) * dist, p.y + h, p.z + Math.cos(a) * dist);
    const look = p.clone().add(new T.Vector3(0, v.spec.type === 'heli' ? 1.3 : v.spec.colliderY * 0.75, 0));
    g.cameraRig.playShot({ from, to: from, lookFrom: look, lookTo: look, dur: 100, fov: 40 });
    for (let i = 0; i < 20; i++) g.world.update(from, g.time);
    const s = v.spec;
    return { name: s.name, type: s.type, speed: Math.round(s.maxSpeed * 3.6), hp: s.health, mass: s.mass, drive: s.drive, price: s.price };
  }, [kind, paint]);
  specs[kind] = info;
  await page.waitForTimeout(3500);
  await page.evaluate((n) => { document.body.style.outline = `${(n % 3) + 1}px solid transparent`; }, kinds.findIndex((k) => k[0] === kind));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `shots/garage/${kind}.png` });
  console.log(kind, JSON.stringify(info));
}
const prev = fs.existsSync('shots/garage/specs.json') ? JSON.parse(fs.readFileSync('shots/garage/specs.json', 'utf8')) : { specs: {} };
fs.writeFileSync('shots/garage/specs.json', JSON.stringify({ order: ALL.map((k) => k[0]), specs: { ...prev.specs, ...specs } }, null, 2));
await browser.close();
