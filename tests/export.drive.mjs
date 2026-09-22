// Browser checks for the sharing half of js/export.js that need a real browser context:
//   downloadBlob -> a real download event with the right name and bytes
//   copyPNG      -> clipboard write inside a click, read back and decoded
//   exportPNG    -> progress reaches 1, the PNG decodes in the browser's own <img>
//   shareFile / canShareFiles -> outcomes on a desktop browser without Web Share for files
// Run: node tests/export.drive.mjs [--browser chromium|firefox|webkit]   (dev server on 8830)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const { chromium, firefox, webkit } = require(PW);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const browserName = opt('browser', 'chromium');
const launchers = { chromium, firefox, webkit };
const browser = await launchers[browserName].launch(browserName === 'chromium'
  ? { headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] } : { headless: true });
const context = await browser.newContext({ acceptDownloads: true });
if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:8830' });
const page = await context.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
await page.goto('http://localhost:8830/dev/export.html?t=none');
await page.waitForFunction(() => document.getElementById('log'));

// A page-side fixture: a real state, and a button whose click runs the gesture-bound calls.
await page.evaluate(async () => {
  const [{ rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS }, { buildSpiral, LINE_DEFAULTS }, m, exp] = await Promise.all([
    import('/js/tone.js'), import('/js/spiral.js'), import('/js/materials.js'), import('/js/export.js')]);
  const c = Object.assign(document.createElement('canvas'), { width: 512, height: 512 });
  const g = c.getContext('2d');
  g.fillStyle = '#bbb'; g.fillRect(0, 0, 512, 512);
  g.fillStyle = '#222'; g.beginPath(); g.arc(256, 230, 130, 0, 7); g.fill();
  const raster = rasterize(c, CROP_DEFAULTS);
  const tone = processTone(raster, TONE_DEFAULTS);
  const geom = buildSpiral(buildField(raster, tone.L, { rings: 48 }), { ...LINE_DEFAULTS, rings: 48 });
  window.fx = { exp, state: { geom, brush: m.brushById('pencil'), paper: m.paperById('sketch'), ink: '#2a2a2e', cover: false, photoColor: false, layout: { cx: 0.5, cy: 0.5, r: 0.42 }, seed: 1 } };
  const b = document.createElement('button');
  b.id = 'go'; b.textContent = 'go';
  b.onclick = () => {
    // exactly what js/download.js does: no await before copyPNG inside the click
    window.copyResult = exp.copyPNG(exp.exportPNG(window.fx.state, { size: 1024 }));
  };
  const s = document.createElement('button');
  s.id = 'share'; s.textContent = 'share';
  s.onclick = () => { window.shareResult = exp.shareFile(new Blob(['x'], { type: 'image/png' }), 'x.png', 'Spiralist'); };
  document.body.append(b, s);
});

const report = { browser: browserName };

// 1. exportPNG + the browser's own decoder
report.decode = await page.evaluate(async () => {
  const fr = [];
  const blob = await window.fx.exp.exportPNG(window.fx.state, { size: 3000, onProgress: f => fr.push(f) });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  await img.decode();
  URL.revokeObjectURL(url);
  return { w: img.naturalWidth, h: img.naturalHeight, bytes: blob.size, type: blob.type, progress: fr.map(v => +v.toFixed(3)), lastIsOne: fr[fr.length - 1] === 1 };
});

// 2. downloadBlob -> download event
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 30000 }),
  page.evaluate(async () => {
    const blob = await window.fx.exp.exportPNG(window.fx.state, { size: 800 });
    window.dlBytes = blob.size;
    window.fx.exp.downloadBlob(blob, window.fx.exp.fileName(['Spiralist', 'Test photo', 'Pencil', 800], 'png'));
  }),
]);
const path = await download.path();
const fs = await import('node:fs');
const bytes = fs.readFileSync(path);
report.download = {
  suggested: download.suggestedFilename(),
  bytes: bytes.length,
  expectedBytes: await page.evaluate(() => window.dlBytes),
  pngSignature: bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
  anchorsLeft: await page.evaluate(() => document.querySelectorAll('a[download]').length),
};

// 3. copyPNG inside a real click, then read the clipboard back
await page.click('#go');
report.copy = await page.evaluate(async () => {
  const ok = await window.copyResult;
  let back = null;
  try {
    const items = await navigator.clipboard.read();
    const item = items.find(i => i.types.includes('image/png'));
    if (item) {
      const blob = await item.getType('image/png');
      const bmp = await createImageBitmap(blob);
      back = { types: items.flatMap(i => i.types), w: bmp.width, h: bmp.height };
    }
  } catch (e) { back = { error: String(e) }; }
  return { ok, back };
});

// 4. share probes (desktop headless has no file share target)
await page.click('#share');
report.share = await page.evaluate(async () => ({
  result: await window.shareResult,
  canShareMp4: window.fx.exp.canShareFiles('video/mp4'),
  canShareWebmCodecs: window.fx.exp.canShareFiles('video/webm;codecs=vp9'),
  hasShare: !!navigator.share, hasCanShare: !!navigator.canShare,
}));

report.ok = report.decode.w === 3000 && report.decode.lastIsOne && report.download.bytes === report.download.expectedBytes &&
  report.download.suggested === 'spiralist-test-photo-pencil-800.png' && report.download.pngSignature && report.download.anchorsLeft === 0 &&
  (browserName !== 'chromium' || (report.copy.ok === true && report.copy.back?.w === 1024)) &&
  ['unsupported', 'shared', 'cancelled', 'failed'].includes(report.share.result);
console.log(JSON.stringify(report, null, 1));
if (errors.length) console.log('console:\n' + errors.slice(0, 30).join('\n'));
await browser.close();
process.exit(report.ok ? 0 : 1);
