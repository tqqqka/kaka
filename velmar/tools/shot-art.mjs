// Скриншоты через headless Chromium (Playwright).
// Использование: node tools/shot.mjs "<query>" out.png [waitMs] [width] [height]
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright'); }
const { chromium } = pw;
const [,, query = '', out = 'shots/shot.png', wait = '4000', w = '1280', h = '720'] = process.argv;
const url = `http://localhost:4180/index.html?shots=1&${query}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
if (process.env.EVAL) { await page.waitForTimeout(1500); console.log('eval', await page.evaluate(process.env.EVAL)); }
await page.waitForTimeout(+wait);
if (process.env.SCRIPT) { const fn = new Function('page', `return (async () => { ${process.env.SCRIPT} })()`); await fn(page); }
const stats = await page.evaluate(() => {
  const g = window.__game ?? null; const e = window.__engine ?? g?.engine; if (g) { const pl=g.player; const v=pl.vehicle; window.__dbg = {pos: pl.char.pos.toArray().map(x=>+x.toFixed(1)), state: pl.state, veh: v? {kind:v.kind, speed:+v.speed.toFixed(1), pos: v.position().toArray().map(x=>+x.toFixed(1)), hp: Math.round(v.health)}:null, chars: g.characters.size, vehicles: g.vehicles.count}; }
  return e ? JSON.stringify(e.stats) : 'no-engine';
});
// Headless-композитор иногда не обновляет слой WebGL-канваса: форсируем перерисовку.
await page.evaluate(() => { document.body.style.outline = '1px solid transparent'; });
await page.waitForTimeout(300);
await page.screenshot({ path: out });
console.log('stats', stats);
console.log('dbg', await page.evaluate(() => JSON.stringify(window.__dbg ?? null)));
for (const l of logs.slice(-40)) console.log(l.slice(0, 600));
await browser.close();
