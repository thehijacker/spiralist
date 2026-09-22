// Browser tests for js/samples.js: drives dev/samples_test.html headlessly.
//   node tests/samples.test.mjs [--browser chromium|firefox|webkit] [--quick]   (dev server on 8830)
// --quick skips the slow tests (idle release ~26 s, silent-worker fallback 5 s).
// Exits non-zero on any failure.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const { chromium, firefox, webkit } = require(PW);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const browserName = opt('browser', 'chromium');
const quick = args.includes('--quick');
const port = +opt('port', 8830);

const launchers = { chromium, firefox, webkit };
const launchOpts = browserName === 'chromium'
  ? { headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] }
  : { headless: true };
const browser = await launchers[browserName].launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('[error] ' + m.text()); });
await page.goto(`http://localhost:${port}/dev/samples_test.html${quick ? '?release=0' : ''}`);
let done;
try {
  await page.waitForFunction(() => window.__done, null, { timeout: 180000, polling: 250 });
  done = await page.evaluate(() => window.__done);
} catch (e) {
  done = { ok: false, results: [{ name: 'page', ok: false, error: 'timeout: ' + e.message }] };
}
const gpu = await page.evaluate(() => {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return gl ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'webgl2') : 'no webgl2';
  } catch { return 'no webgl2'; }
});
console.log(`samples tests · ${browserName} · ${gpu}`);
for (const r of done.results || []) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.error}`);
  if (r.info) console.log('      ' + JSON.stringify(r.info));
}
if (errors.length) console.log('console:\n' + errors.slice(0, 20).join('\n'));
await browser.close();
process.exit(done.ok ? 0 : 1);
