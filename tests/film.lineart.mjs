// Line art film, straight through the composer (no app UI needed): extract the lines of a sample,
// build one style with js/lineart/index.js, film it with FilmComposer + the encoder, verify the file
// with ffprobe and extract frames across the timeline.
//   node tests/film.lineart.mjs [--style picasso|matisse|blind|brush] [--sample bust|cat|moon]
//        [--length 15|30|60] [--format square|story|portrait|wide] [--fps 30|60] [--desk nero]
//        [--sign "Anna"] [--flat] [--engine auto|xdog] [--prefix lf] [--frames macro,look,retrace,25,50,75,end,final]
// Writes shots/<prefix>_<style>_<sample>_<length>s.mp4 and .._<moment>.jpg; prints the composer's facts
// (hand seconds, pauses, speed-up, macro) and the probe.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = k => args.includes('--' + k);
const style = opt('style', 'matisse'), sample = opt('sample', 'bust');
const length = +opt('length', 30), format = opt('format', 'square'), fps = +opt('fps', 30);
const desk = opt('desk', 'nero'), prefix = opt('prefix', 'lf');
const tag = [style, sample, `${length}s`, format, flag('flat') ? 'flat' : '', opt('sign', null) ? 'signed' : ''].filter(Boolean).join('_');

const browser = await pw.chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const logs = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => logs.push('[pageerror] ' + e.message));
// the app's page (its fonts: Geist for the counter, Instrument Serif for the end card)
await page.goto(`http://localhost:${opt('port', 8830)}/`);
// (only the fonts are needed: the app itself may be mid-edit by another engineer)
await page.waitForFunction(() => window.SP && window.SP.geom, null, { timeout: 20000 }).catch(() => logs.push('(app did not start: filming without it)'));
await page.evaluate(() => document.fonts.ready);
const t0 = Date.now();
const res = await page.evaluate(async o => {
  const [film, scene, tools, enc, la, samples, tone, mats, R] = await Promise.all([
    import('/js/film.js'), import('/js/scene.js'), import('/js/tools.js'), import('/js/encoder.js'),
    import('/js/lineart/index.js'), import('/js/samples.js'), import('/js/tone.js'), import('/js/materials.js'), import('/js/renderer.js')]);
  const S = la.lineStyleById(o.style);
  const src = await samples.makeSample(o.sample, 1024);
  const eng = new la.LineArtEngine();
  const tl = performance.now();
  const lines = await eng.lines(src, tone.CROP_DEFAULTS, { detail: S.defaults.detail, engine: o.engine });
  const linesMs = performance.now() - tl;
  const geom = await eng.build(o.style, lines, { sheetMm: 210, tool: S.tool, toolMm: S.toolMm, seed: 3 });
  const brush = mats.BRUSHES.find(b => b.id === S.tool), paper = mats.PAPERS.find(p => p.id === S.paper);
  const state = { geom, brush, paper, ink: S.ink, cover: false, photoColor: false, layout: { cx: 0.5, cy: 0.5, r: la.LAYOUT_R },
    seed: 3, shape: 'square', mode: 'lineart', sheetMm: 210, light: null };
  const fmt = film.FORMATS[o.format];
  const renderer = new R.Renderer(document.createElement('canvas'));
  await scene.loadDesk(renderer.gl, o.desk, { urgent: true });
  if (o.sign) { const sig = await import('/js/signature.js'); await Promise.race([sig.ensureSignatureFont(), new Promise(r => setTimeout(r, 2500))]); }
  const c = new film.FilmComposer({ renderer, desk: o.desk, W: fmt.w, H: fmt.h, format: o.format, length: o.length, fps: o.fps,
    showTool: true, polaroid: true, reveal: false, pacing: 'natural', state, tools, sceneLib: scene,
    style: o.flat ? 'flat' : 'cinematic', counter: true, signature: o.sign || '' });
  c.prepare();
  while (!c.ready()) await new Promise(r => setTimeout(r, 30));
  const te = performance.now();
  const out = await enc.encodeVideo({ width: fmt.w, height: fmt.h, fps: c.fps, frames: c.frames, ...c.encodeHints(), drawFrame: (i, ctx) => c.draw(i, ctx) });
  const encMs = performance.now() - te;
  const buf = new Uint8Array(await out.blob.arrayBuffer());
  const up = await fetch('/__file?name=' + encodeURIComponent(o.file), { method: 'POST', body: buf });
  // the timeline's landmarks: the longest look, a retrace, the hand at the quarters
  const Rl = c.real, C = Rl.clock, L = geom.lineart;
  const tAtHand = h => { let lo = c.t0, hi = c.t1; for (let k = 0; k < 50; k++) { const m = (lo + hi) / 2; if (c.hand.hand(m) < h) lo = m; else hi = m; } return hi; };
  let best = -1, bp = 0;
  for (let i = 1; i < C.P.length; i++) if (C.P[i] > bp && C.F[i] > 0.15 * C.total) { bp = C.P[i]; best = i; }
  const lookAt = best > 0 ? tAtHand(C.F[best] - C.P[best] * 0.6) : null;
  let retraceAt = null;
  if (L.seg) {
    // the middle of the longest retraced run after the opening
    let runA = -1, bestLen = 0, bestMid = -1;
    for (let i = 0; i <= L.seg.length; i++) {
      const on = i < L.seg.length && L.seg[i] === 1;
      if (on && runA < 0) runA = i;
      if (!on && runA >= 0) { if (i - runA > bestLen && C.F[runA] > 0.1 * C.total) { bestLen = i - runA; bestMid = (runA + i) >> 1; } runA = -1; }
    }
    if (bestMid > 0) retraceAt = tAtHand(C.F[bestMid]);
  }
  // the look: the pen stays on the paper (a settle of at most 0.02) and the wrist turns a little
  const lookPose = lookAt ? c.toolPose(lookAt) : null, lookLift = lookPose ? +lookPose.lift.toFixed(3) : null;
  const lookWrist = lookPose && c.t0 < lookAt - 0.3 ? +(lookPose.angle - c.toolPose(lookAt - 0.3).angle).toFixed(2) : null;
  let maxLiftDrawing = 0;
  for (let t = c.t0 + 0.5; t < c.t1 - 0.2; t += 1 / 30) maxLiftDrawing = Math.max(maxLiftDrawing, c._look(t));
  return {
    ok: up.ok, bytes: buf.length, codec: out.codec, engine: out.engine, linesMs: Math.round(linesMs), encMs: Math.round(encMs),
    lineEngine: L.engine, style: L.style, hand: +Rl.handT[Rl.handT.length - 1].toFixed(1), handSeconds: L.handSeconds,
    lengthM: L.lengthM, retracedM: L.retracedM, bridgesM: L.bridgesM, pauses: C.count, pauseSeconds: +C.paused.toFixed(1), filmClock: +C.total.toFixed(1),
    t0: c.t0, t1: +c.t1.toFixed(3), D: +c.D.toFixed(3), tDone: +c.tDone.toFixed(3), open: +c.hand.open.toFixed(2), peak: +c.hand.peak.toFixed(2), avg: +c.hand.avg.toFixed(2),
    macro: c.intent?.macro ? { zoom: +c.intent.macro.zoom.toFixed(2), hold: c.intent.macro.hold } : null, mode: c.intent?.mode,
    lookAt, lookPause: +bp.toFixed(2), lookLift, lookWrist, maxLookDuringDrawing: +maxLiftDrawing.toFixed(3), retraceAt,
    speedAt: [0.2, 1, 3, 8, 15, 25].filter(t => t < c.t1).map(t => [t, +c.hand.speed(t).toFixed(2)]),
    sign: c.sign ? { t0: c.tS0, t1: c.tS1 } : null, composeMs: +(c.stats.ms / Math.max(1, c.stats.frames)).toFixed(2),
  };
}, { style, sample, length, format, fps, desk, sign: opt('sign', null), flat: flag('flat'), engine: opt('engine', 'auto'), file: `${prefix}_${tag}.mp4` });
const file = `shots/${prefix}_${tag}.mp4`;
let probe = null, check = null;
try {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries',
    'stream=codec_name,profile,level,width,height,pix_fmt,nb_read_frames,r_frame_rate:format=duration,size', '-of', 'json', file]).toString();
  probe = JSON.parse(out);
  const st = probe.streams?.[0] || {};
  check = { frames: +st.nb_read_frames, expected: length * fps, framesOk: +st.nb_read_frames === length * fps,
    duration: +probe.format?.duration, durationOk: Math.abs(+probe.format?.duration - length) < 0.05 };
} catch (e) { probe = { error: String(e.message) }; }
const moments = { macro: 0.4 + 0.8 * res.open, look: res.lookAt, retrace: res.retraceAt, 25: res.t0 + res.D * 0.25, 50: res.t0 + res.D * 0.5,
  75: res.t0 + res.D * 0.75, end: res.tDone + 0.1, card: length - 0.4, final: length - 1 / fps / 2, sign: res.sign ? res.sign.t0 + 0.7 * (res.sign.t1 - res.sign.t0) : null };
const want = opt('frames', 'macro,look,retrace,25,50,75,end,final').split(',');
for (const name of want) {
  const t = moments[name] ?? +name;
  if (t == null || !Number.isFinite(t)) continue;
  const out = file.replace(/\.\w+$/, `_${name}.jpg`);
  const a = name === 'final' ? ['-sseof', '-0.2', '-i', file, '-update', '1', '-q:v', '3', out] : ['-ss', String(t), '-i', file, '-frames:v', '1', '-q:v', '3', out];
  try { execFileSync('ffmpeg', ['-v', 'error', '-y', ...a]); } catch { /* ignore */ }
}
console.log(JSON.stringify({ tag, secs: (Date.now() - t0) / 1000, file, check, res, probe: probe?.streams?.[0] }, null, 1));
if (logs.length) console.log(logs.filter(l => !/wasm streaming/.test(l)).slice(0, 30).join('\n'));
await browser.close();
