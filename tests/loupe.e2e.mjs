// The stage loupe in the real app: zoom into fountain ink, charcoal and crayon drawings, shoot the
// sheet at several zooms (shots/loupe_*.png), time frames while panning and zooming, and check
// playback while zoomed, fit / reset, and console errors.
//   node tests/loupe.e2e.mjs [--mobile] [--port 8830] [--only fountain] [--zooms 1,4,12]
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const { chromium } = require(PW);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = k => args.includes('--' + k);
const mobile = flag('mobile');
const W = mobile ? 390 : 1440, H = mobile ? 844 : 900, dpr = mobile ? 3 : 2;
const tag = mobile ? 'm_' : '';
const media = (opt('only', 'fountain,charcoal,crayon')).split(',');
const zooms = (opt('zooms', mobile ? '1,6,30' : '1,4,12')).split(',').map(Number);
const at = (opt('at', '0.43,0.47')).split(',').map(Number);

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: dpr, hasTouch: mobile, isMobile: mobile });
const page = await context.newPage();
const logs = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => logs.push('[pageerror] ' + e.message));
await page.goto(`http://localhost:${opt('port', 8830)}/`);
await page.waitForFunction(() => window.SP && SP.geom && !SP.play.playing, null, { timeout: 60000 });
// welcome card off (the sample is already drawn behind it)
await page.evaluate(() => { document.getElementById('welcome').hidden = true; document.body.classList.remove('welcoming'); window.dispatchEvent(new Event('resize')); });
await page.waitForTimeout(400);

const settled = () => page.waitForFunction(() => !SP.loupe.busy(performance.now()) && !SP.renderer.pending(), null, { timeout: 30000 });
const sheet = page.locator('#sheet');
const out = [];
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };

for (const id of media) {
  await page.evaluate(id => SP.setBrush(id), id);
  await page.waitForFunction(() => !SP.renderer.pending(), null, { timeout: 30000 });
  await page.evaluate(() => { SP.loupe.fit({ instant: true }); SP.invalidate('render'); });
  await page.waitForTimeout(900);            // wet ink: dry fully at fit
  for (const z of zooms) {
    await page.evaluate(([z, at]) => { SP.loupe.fit({ instant: true }); if (z > 1) SP.loupe.zoomTo(z, at, { instant: true }); }, [z, at]);
    await settled();
    await page.waitForTimeout(150);
    const info = await page.evaluate(() => ({
      z: SP.loupe.z, mmPerCssPx: SP.loupe.mmPerPx(), canvas: SP.renderer.s.width, css: SP.loupe.cssW,
      badge: document.getElementById('loupeZ').textContent + ' / ' + document.getElementById('loupeMm').textContent,
      sharp: SP.loupe.stats.sharpMs.at(-1),
    }));
    // the canvas holds the close-up texel for texel (present() resamples nothing at rest)
    if (z > 1) info.exact = await page.evaluate(() => {
      const r = SP.renderer, gl = r.gl, f = SP.loupe.fine, S = r.s.width, Wp = S * SP.loupe.z;
      const v = f.view, R = f.rect, H = Math.round((R[3] - R[1]) * Wp);
      const dx = (v[0] - R[0]) * Wp, dy = H - (v[3] - R[1]) * Wp;
      const a = new Uint8Array(S * S * 4), b = new Uint8Array(S * S * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, a);
      gl.bindFramebuffer(gl.FRAMEBUFFER, r.rectView.sheetTex.fbo);
      gl.readPixels(Math.round(dx), Math.round(dy), S, S, gl.RGBA, gl.UNSIGNED_BYTE, b);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      let max = 0;
      for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
      return { offTexels: [+dx.toFixed(4), +dy.toFixed(4)], maxDiff: max };
    });
    const file = path.resolve(`shots/loupe_${tag}${id}_${z}x.png`);
    await sheet.screenshot({ path: file });
    out.push({ id, ...info, mmPerDevPx: info.mmPerCssPx * info.css / info.canvas, file });
  }
}

// Frame times while panning (a mouse drag) and wheel-zooming at the deepest zoom, per medium; and
// the sharp render's true cost (GPU included: a 1-px readPixels waits for it) from scratch.
const frames = {};
const box = await sheet.boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const runs = [...media.map(id => [id, true]), [media[0], false]];     // live sharp, then preview-only
for (const [id, live] of runs) {
  await page.evaluate(id => SP.setBrush(id), id);
  await page.waitForFunction(() => !SP.renderer.pending(), null, { timeout: 30000 });
  await page.evaluate(([z, at, live]) => {
    SP.loupe.fit({ instant: true }); SP.loupe.zoomTo(z, at, { instant: true });
    Object.assign(SP.loupe.live, { off: live ? 0 : Infinity, fails: 0, ema: 0 });
    SP.loupe.stats.live = 0; SP.loupe.stats.preview = 0;
  }, [zooms.at(-1), at, live]);
  await settled();
  const gpu = await page.evaluate(() => {
    const r = SP.renderer, gl = r.gl, px = new Uint8Array(4), ms = [];
    const v = SP.loupe.view(), S = r.s.width;
    for (let i = 0; i < 6; i++) {
      const d = (i + 1) * 7 / (S * SP.loupe.z);              // a moved rect: redrawn from scratch
      const t0 = performance.now();
      r.renderToTexture(Infinity, { rect: [v[0] + d, v[1], v[2] + d, v[3]], size: S });
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      ms.push(performance.now() - t0);
    }
    SP.loupe.sharpKey = ''; SP.invalidate('render');
    return ms.slice(1).sort((a, b) => a - b);
  });
  await settled();
  await page.evaluate(() => {
    // [frame end, interval]; intervals spanning the mid-pan screenshot are dropped below
    window.__ft = []; let last = performance.now();
    const f = t => { window.__ft.push([t, t - last]); last = t; if (window.__ftOn) requestAnimationFrame(f); };
    window.__ftOn = true; requestAnimationFrame(f);
    SP.loupe.stats.previewMs.length = 0;
  });
  let gap = [0, 0];
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 0; i < 90; i++) {
    const a = i / 90 * Math.PI * 2;
    await page.mouse.move(cx + Math.sin(a) * box.width * 0.2, cy + (1 - Math.cos(a)) * box.width * 0.1);
    await page.waitForTimeout(16);
    if (i === 30) {
      const g0 = await page.evaluate(() => performance.now());
      await sheet.screenshot({ path: path.resolve(`shots/loupe_${tag}${id}_panning${live ? '' : '_preview'}.png`) });
      gap = [g0, await page.evaluate(() => performance.now())];
    }
  }
  await page.mouse.up();
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 100); await page.waitForTimeout(40); }
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(40); }
  await settled();
  const ft = await page.evaluate(() => { window.__ftOn = false; return { ft: window.__ft.slice(2), prev: SP.loupe.stats.previewMs.slice(), live: SP.loupe.stats.live, preview: SP.loupe.stats.preview, off: SP.loupe.live.off }; });
  const iv = ft.ft.filter(([t, d]) => !(t > gap[0] && t - d < gap[1] + 20)).map(([, d]) => d);
  frames[id + (live ? '' : ' (preview only)')] = { n: iv.length, median: +pct(iv, 0.5).toFixed(2), p95: +pct(iv, 0.95).toFixed(2), max: +Math.max(...iv).toFixed(1),
    liveFrames: ft.live, previewFrames: ft.preview, liveBackedOff: ft.off !== 0 && live,
    previewCpuP95: +pct(ft.prev, 0.95).toFixed(2), sharpGpuMedian: +pct(gpu, 0.5).toFixed(1), sharpGpuMax: +Math.max(...gpu).toFixed(1) };
}
await page.locator('#stage').screenshot({ path: path.resolve(`shots/loupe_${tag}ui.png`) });

// playback keeps drawing while zoomed
const play = await page.evaluate(async () => {
  SP.play.f = 0.3; document.getElementById('btnPlay').click();
  await new Promise(r => setTimeout(r, 700));
  const f0 = SP.play.f; await new Promise(r => setTimeout(r, 500));
  const res = { f0, f1: SP.play.f, playing: SP.play.playing, zoomed: SP.loupe.active };
  document.getElementById('btnPlay').click();
  return res;
});
await page.waitForTimeout(300);
await page.locator('#sheet').screenshot({ path: path.resolve(`shots/loupe_${tag}playing.png`) });

// Fit button, keyboard, and a new photo reset the zoom
const resets = await page.evaluate(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  document.getElementById('loupeFit').click(); await wait(600);
  const afterFit = SP.loupe.active;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true })); await wait(500);
  const afterPlus = SP.loupe.zT;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true })); await wait(600);
  const afterZero = SP.loupe.active;
  // an eased zoom keeps the sheet point under the cursor where it was
  const s = [0.3, 0.7], a0 = SP.loupe.sheetAt(s);
  SP.loupe.zoomBy(3, s); await wait(120);
  const aMid = SP.loupe.sheetAt(s); await wait(600);
  const a1 = SP.loupe.sheetAt(s);
  const anchorErrPx = Math.max(Math.hypot(a1[0] - a0[0], a1[1] - a0[1]), Math.hypot(aMid[0] - a0[0], aMid[1] - a0[1])) * SP.loupe.cssW * SP.loupe.z;
  SP.loupe.fit({ instant: true });
  SP.loupe.zoomTo(5, [0.5, 0.5], { instant: true }); await wait(100);
  await SP.openSample('bust', { demo: false });
  await wait(300);
  return { afterFit, afterPlus, afterZero, anchorErrPx: +anchorErrPx.toFixed(3), afterPhoto: SP.loupe.active, rectFreed: !SP.renderer.rectView };
});

// phones: a two-finger pinch (fingers 40 -> 280 px apart: 7x), a double tap, and a one-finger pan
// that must not turn into the long-press compare
let touch = null;
if (mobile) {
  const cdp = await context.newCDPSession(page);
  await page.evaluate(() => SP.loupe.fit({ instant: true }));
  await page.waitForTimeout(300);
  const b = await sheet.boundingBox(), x = b.x + b.width / 2, y = b.y + b.height / 2;
  const tp = d => [{ x: x - d, y, id: 0 }, { x: x + d, y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(20) });
  for (let i = 1; i <= 10; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(20 + i * 12) }); await page.waitForTimeout(16); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(300);
  const afterPinch = await page.evaluate(() => +SP.loupe.zT.toFixed(2));
  await page.evaluate(() => SP.loupe.fit({ instant: true }));
  await page.waitForTimeout(400);
  await page.touchscreen.tap(x, y); await page.waitForTimeout(120); await page.touchscreen.tap(x, y);
  await page.waitForTimeout(500);
  const afterDoubleTap = await page.evaluate(() => +SP.loupe.zT.toFixed(2));
  const c0 = await page.evaluate(() => [...SP.loupe.c]);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 0 }] });
  for (let i = 1; i <= 40; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + i * 2, y: y + i, id: 0 }] }); await page.waitForTimeout(16); }
  const comparing = await page.evaluate(() => document.getElementById('btnCompare').classList.contains('on'));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(300);
  const c1 = await page.evaluate(() => [...SP.loupe.c]);
  await sheet.screenshot({ path: path.resolve(`shots/loupe_${tag}touch.png`) });
  touch = { afterPinch, afterDoubleTap, panned: [+(c1[0] - c0[0]).toFixed(4), +(c1[1] - c0[1]).toFixed(4)], comparingDuringPan: comparing };
}

console.log(JSON.stringify({ mobile, shots: out, frames, play, resets, touch }, null, 1));
console.log(logs.length ? logs.slice(0, 30).join('\n') : 'console: 0 errors / warnings');
await browser.close();
