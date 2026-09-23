// End-to-end: film a timelapse through the real UI and verify the file with ffprobe.
//   node tests/film.e2e.mjs [--browser chromium|firefox|webkit] [--format square|story|portrait|wide]
//        [--length 10] [--look classic] [--sample bust] [--reveal] [--no-tool]
//        [--style cinematic|flat] [--fps 30|60] [--maze] [--path maze|wander|contour] [--at x,y]
//        [--edge] [--pacing natural]   (--at: where a maze / free line starts, circle units)
//        [--desk nero|calacatta|travertine|limewash|velvet|leather|sunlit|onyx]   (the background)
//        [--frames intro,25,50,75,end]   (which moments to extract as JPEGs; default all five, plus 'sign'
//        and 'final' (the last frame) when signed)
//        [--sign "Anna Smith"]   (typed into the dialog's Sign it field: the pen signs the corner)
//        [--brush watercolour] [--paper coldpress]   (after --look: a tool / paper of their own)
//        [--real squiggle|stipple|scribble|engrave] [--tool fineliner] [--tool-mm 0.4] [--sheet 841]
//        [--preset detailed] [--light window|raking|overhead] [--no-counter]
//          (Realistic mode, "true drawing, sped up": the app's own setMode / setRealStyle / setRealTool;
//          checks window.__filmLast.real and adds the 'macro' moment, the real-speed opening)
// Prints the probe (frame count must equal length x fps), the composer's timing
// (window.__filmLast) and writes shots/e2e_<tag>.mp4 plus shots/e2e_<tag>_<moment>.jpg.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = k => args.includes('--' + k);
const browserName = opt('browser', 'chromium');
const format = opt('format', 'square'), length = +opt('length', 10);
const style = opt('style', 'cinematic'), fps = +opt('fps', style === 'cinematic' ? 60 : 30);
const path = opt('path', flag('maze') || opt('maze-at', null) ? 'maze' : 'spiral');
const maze = path !== 'spiral';
const desk = opt('desk', null);
const real = opt('real', null);
const tag = [browserName, format, `${length}s`, style, `${fps}fps`, real ? `real-${real}-${opt('tool', '')}${opt('sheet', '')}` : maze ? path : flag('edge') ? 'edge' : 'spiral',
  opt('look', ''), opt('brush', ''), desk || '', flag('reveal') ? 'reveal' : '', opt('sign', null) ? 'signed' : ''].filter(Boolean).join('_');
const browser = await pw[browserName].launch(browserName === 'chromium'
  ? { headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => logs.push('[pageerror] ' + e.message));
await page.goto('http://localhost:8830/');
await page.waitForFunction(() => window.SP && window.SP.geom && !window.SP.play.playing, null, { timeout: 60000 });
if (opt('sample', null)) await page.evaluate(id => SP.openSample(id, { demo: false }), opt('sample'));
if (opt('look', null)) await page.evaluate(id => SP.applyLook(id), opt('look'));
if (opt('brush', null)) await page.evaluate(id => SP.setBrush(id), opt('brush'));
if (opt('paper', null)) await page.evaluate(id => SP.setPaper(id), opt('paper'));
if (real) {
  await page.evaluate(({ style, tool, mm, sheet, preset, light }) => {
    SP.setMode('realistic');
    SP.setRealStyle(style);
    if (tool || mm) SP.setRealTool(tool || SP.doc.real.tool, mm ? +mm : undefined);
    SP.change(d => {
      if (sheet) { d.real.sheetAuto = false; d.real.sheetMm = +sheet; }
      if (preset) d.real.preset = preset;
      if (light) d.real.light = light;
    });
  }, { style: real, tool: opt('tool', null), mm: opt('tool-mm', null), sheet: opt('sheet', null), preset: opt('preset', null), light: opt('light', null) });
  await page.waitForFunction(s => window.SP.geom?.real?.style === s && !window.SP.building, real, { timeout: 90000, polling: 250 });
} else if (maze) {
  const at = (opt('at', opt('maze-at', '')) || '').split(',').map(Number);
  await page.evaluate(({ path, x, y }) => SP.change(d => {
    d.line.path = path;
    const start = d.free || d.maze;          // the start point (doc.free since free lines)
    if (start && Number.isFinite(x) && Number.isFinite(y)) { start.x = x; start.y = y; }
  }), { path, x: at[0], y: at[1] });
  await page.waitForFunction(p => window.SP.geom && window.SP.geom.path === p, path, { timeout: 60000 });
} else {
  await page.evaluate(edge => SP.change(d => { d.line.path = 'spiral'; d.line.start = edge ? 'edge' : 'center'; }), flag('edge'));
  await page.waitForFunction(edge => window.SP.geom && window.SP.geom.path !== 'maze' && window.SP.geom.start === (edge ? 'edge' : 'center'),
    flag('edge'), { timeout: 30000 });
}
await page.evaluate(({ format, length, reveal, tool, style, fps, pacing, desk, counter }) => {
  const f = SP.prefs.film;
  f.format = format; f.length = length; f.lengthChosen = true; f.reveal = reveal; f.showTool = tool; f.style = style; f.fps = fps; f.fpsChosen = true;
  if (desk) f.desk = desk;
  if (pacing) SP.prefs.pacing = pacing;
  f.counter = counter;
}, { format, length, reveal: flag('reveal'), tool: !flag('no-tool'), style, fps, pacing: opt('pacing', null), desk, counter: !flag('no-counter') });
await page.evaluate(() => { SP.prefs.film.signature = ''; });
await page.evaluate(() => SP.openFilm());
await page.waitForFunction(() => !document.getElementById('filmGo').disabled && document.getElementById('filmSummary').textContent, null, { timeout: 30000 });
if (opt('sign', null)) {
  // typed like a person would, into the real field (it persists as prefs.film.signature)
  await page.fill('#filmSign', '');
  await page.type('#filmSign', opt('sign'), { delay: 20 });
  await page.waitForTimeout(700);
}
await page.waitForTimeout(600);
const summary = await page.textContent('#filmSummary');
// --prefix rf: name the files shots/rf_<tag>… (the realistic film's shots)
const prefix = opt('prefix', 'e2e');
if (flag('dialog-shot')) await page.locator('#filmDialog').screenshot({ path: `shots/${prefix}_${tag}_dialog.png` });
const t0 = Date.now();
await page.click('#filmGo');
let ok = true;
try {
  await page.waitForFunction(() => !document.getElementById('filmResult').hidden || document.getElementById('toasts').textContent.includes('stopped'),
    null, { timeout: length * 1000 * 8 + 60000, polling: 500 });
} catch (e) { ok = false; logs.push('timeout: ' + e.message); }
const secs = (Date.now() - t0) / 1000;
const meta = await page.textContent('#filmMeta').catch(() => '');
const toastText = await page.textContent('#toasts').catch(() => '');
const timing = await page.evaluate(() => window.__filmLast || null);
let probe = null, file = null, check = null;
if (ok && !(await page.isHidden('#filmResult'))) {
  const ext = meta.includes('.webm') ? 'webm' : 'mp4';
  file = `shots/${prefix}_${tag}.${ext}`;
  const b64 = await page.evaluate(async () => {
    const r = await fetch(document.getElementById('filmVideo').src);
    const buf = new Uint8Array(await r.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries',
      'stream=codec_name,profile,level,width,height,pix_fmt,nb_read_frames,r_frame_rate:format=duration,size', '-of', 'json', file]).toString();
    probe = JSON.parse(out);
    const st = probe.streams?.[0] || {};
    check = { frames: +st.nb_read_frames, expected: length * fps, framesOk: +st.nb_read_frames === length * fps,
      duration: +probe.format?.duration, durationOk: Math.abs(+probe.format?.duration - length) < 0.05, level: st.level };
  } catch (e) { probe = { error: String(e.message) }; }
  // the intro close-up, the quarters of the drawing, and the final reveal
  const moments = { intro: 0.35, 25: length * 0.25, 50: length * 0.5, 75: length * 0.75, end: Math.max(0, length - 0.3),
    sign: timing?.sign ? timing.sign.t0 + 0.7 * (timing.sign.t1 - timing.sign.t0) : null, final: length - 1 / fps / 2,
    // realistic: inside the real-speed opening (the macro), and early in the follow shot
    macro: timing?.real ? 0.4 + 0.8 * timing.real.open : 2, follow: length * 0.15 };
  const want = (opt('frames', opt('sign', null) ? 'intro,25,50,75,end,sign,final' : real ? 'macro,follow,50,75,end' : 'intro,25,50,75,end')).split(',');
  for (const name of want) {
    const t = moments[name] ?? +name;
    if (t == null || !Number.isFinite(t)) continue;
    const out = file.replace(/\.\w+$/, `_${name}.jpg`);
    // 'final': decode the last 0.2 s and keep overwriting, so the file ends as the very last frame
    const a = name === 'final' ? ['-sseof', '-0.2', '-i', file, '-update', '1', '-q:v', '3', out]
      : ['-ss', String(t), '-i', file, '-frames:v', '1', '-q:v', '3', out];
    try { execFileSync('ffmpeg', ['-v', 'error', '-y', ...a]); } catch { /* ignore */ }
  }
}
if (real && check) {
  // the realistic film must have been filmed as one (the hand's clock, the real sheet)
  const R = timing?.real;
  check.realOk = !!R && R.style === real && R.handSeconds > 0 && R.peak >= 1 && R.length === length;
}
const hand = real ? await page.textContent('#filmHand').catch(() => '') : undefined;
console.log(JSON.stringify({ browser: browserName, format, length, style, fps, maze, path, desk, summary, hand, secs, meta, toast: toastText, file, check, timing, probe: probe?.streams?.[0] }, null, 1));
if (logs.length) console.log(logs.slice(0, 30).join('\n'));
await browser.close();
