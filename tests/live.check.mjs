// Smoke-test the deployed site: loads without errors, draws, films a short clip.
//   node tests/live.check.mjs [url] [--browser chromium|firefox]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);
const args = process.argv.slice(2);
const url = args.find(a => a.startsWith('http')) || 'https://winchxyz.github.io/spiralist/';
const bi = args.indexOf('--browser');
const name = bi >= 0 ? args[bi + 1] : 'chromium';
const browser = await pw[name].launch(name === 'chromium' ? { headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
const t0 = Date.now();
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.SP && SP.geom && !SP.play.playing, null, { timeout: 90000 });
const loaded = (Date.now() - t0) / 1000;
await page.screenshot({ path: `shots/live_${name}.png` });
const state = await page.evaluate(() => ({ n: SP.geom.n, path: SP.geom.path, photo: SP.photo?.name, drawn: SP.renderer.drawn }));
let film = null;
if (name === 'chromium') {
  await page.evaluate(() => { SP.prefs.film.length = 10; SP.prefs.film.format = 'square'; });
  await page.evaluate(() => SP.openFilm());
  await page.waitForFunction(() => !document.getElementById('filmGo').disabled, null, { timeout: 30000 });
  await page.click('#filmGo');
  await page.waitForFunction(() => !document.getElementById('filmResult').hidden, null, { timeout: 180000 }).catch(() => {});
  film = await page.textContent('#filmMeta').catch(() => null);
}
const sw = await page.evaluate(async () => !!(await navigator.serviceWorker?.getRegistration()));
console.log(JSON.stringify({ url, browser: name, loadedSec: loaded, state, film, serviceWorker: sw, errors: errors.slice(0, 10) }, null, 1));
await browser.close();
