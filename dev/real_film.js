// Lab for the realistic film ("true drawing, sped up", js/film.js with realistic: true), with no
// app in the way: builds one style's geometry, then either grabs frames or encodes the whole film.
//   node tests/shoot.mjs "/dev/real_film.html?style=stipple;brush=fineliner;paper=cream;tool=0.4;length=30;at=0.02,0.2,0.5,0.98"
//   style    squiggle | stipple | scribble | engrave        img  bust | cat | ... (samples.js)
//   brush    brush id (fineliner, fountain, charcoal, ...) paper  paper id     ink  hex (optional)
//   tool     tool width mm      sheet  sheet width mm (210)  preset  quick | detailed | masterpiece
//   format   square | story | portrait | wide    length  s    fps  30 | 60    desk  desk id
//   light    window | raking | overhead   sign  "Name"   counter=0 (no clock)   style2=flat (the flat film)
//   at       film fractions to grab as JPEGs (shots/rf_<tag>_<pct>.jpg); t= seconds instead of fractions
//   encode=1 encode the whole film to shots/rf_<tag>.mp4 (via /__file)
//   tag      name for the files (default style_brush_sheet)
// Sets window.__done = { ok, info, files } for tests/shoot.mjs.
import { Renderer } from '../js/renderer.js';
import { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS } from '../js/tone.js';
import { brushById, paperById, inkMode } from '../js/materials.js';
import { FilmComposer, realInfo, formatHand, formatSpeed } from '../js/film.js';
import * as sceneLib from '../js/scene.js';
import * as tools from '../js/tools.js';

const q = new URLSearchParams(location.search.replace(/;/g, '&'));
const LAYOUT = { cx: 0.5, cy: 0.5, r: 0.42 };
const STYLE = q.get('style') || 'stipple';
const BRUSH = q.get('brush') || 'fineliner';
const PAPER = q.get('paper') || 'cream';
const TOOL = +(q.get('tool') || 0.4);
const SHEET = +(q.get('sheet') || 210);
const PRESET = q.get('preset') || 'detailed';
const FORMAT = q.get('format') || 'square';
const LENGTH = +(q.get('length') || 30);
const FPS = +(q.get('fps') || 30);
const FORMATS = { story: [1080, 1920], portrait: [1080, 1350], square: [1080, 1080], wide: [1920, 1080] };
const TAG = q.get('tag') || `${STYLE}_${BRUSH}_${SHEET}`;
const MARK = { charcoal: 0.9, chalk: 0.8, crayon: 0.9, pencil: 0.85 };

async function save(canvas, name) {
  const data = canvas.toDataURL('image/jpeg', 0.9);
  await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data }) });
  return `shots/${name}.jpg`;
}

async function geometry(src, flip) {
  const raster = rasterize(src, CROP_DEFAULTS);
  const opts = { sheetMm: SHEET, toolMm: TOOL, layoutR: LAYOUT.r, preset: PRESET, seed: 1, markRatio: MARK[BRUSH] || 1 };
  // the contract's builder first (js/real/index.js), then the style module itself
  let idx = null;
  try { idx = await import('../js/real/index.js'); } catch { idx = null; }
  const tCU = TOOL / (LAYOUT.r * SHEET);
  let tone = TONE_DEFAULTS, rings = 110;
  if (STYLE === 'squiggle') {
    const m = await import('../js/real/squiggle.js');
    tone = { ...TONE_DEFAULTS, ...m.SQUIGGLE_TONE };
    rings = m.squiggleScale(opts).rings;
  } else if (STYLE === 'stipple') rings = Math.max(12, Math.round(1 / (1.2 * tCU)));
  else if (STYLE === 'engrave') rings = 40;
  const L = processTone(raster, tone, { flip }).L;
  const field = buildField(raster, L, { rings, flip });
  if (idx?.buildReal) {
    try { return { geom: idx.buildReal(STYLE, field, opts), via: 'buildReal' }; } catch (e) { console.warn('buildReal failed, using the module', e); }
  }
  const mod = await import(`../js/real/${STYLE === 'engrave' ? 'engrave' : STYLE}.js`);
  return { geom: mod.build(field, opts), via: 'module' };
}

async function run() {
  const t0 = performance.now();
  const { makeSample } = await import('../js/samples.js');
  const img = await makeSample(q.get('img') || 'bust', 1024);
  const brush = brushById(BRUSH), paper = paperById(PAPER);
  const ink = q.get('ink') || brush.inks[0][0];
  const mode = inkMode(brush, ink, paper, false);
  const { geom, via } = await geometry(img, mode.flip);
  geom.layout ||= LAYOUT;
  const info = realInfo(geom);
  const state = { geom, brush, paper, ink, cover: mode.cover, photoColor: false, layout: { ...LAYOUT }, seed: 1, shape: STYLE === 'squiggle' ? 'circle' : 'square' };
  const [W, H] = FORMATS[FORMAT] || FORMATS.square;
  const renderer = new Renderer(document.createElement('canvas'));
  const desk = q.get('desk') || 'nero';
  await sceneLib.loadDesk(renderer.gl, desk, { urgent: true });
  const c = new FilmComposer({
    renderer, desk, live: false, W, H, format: FORMAT, length: LENGTH, fps: FPS,
    style: q.get('style2') || 'cinematic', showTool: q.get('tool2') !== '0', polaroid: q.get('polaroid') !== '0', reveal: false,
    pacing: 'natural', state, tools, sceneLib, signature: q.get('sign') || '',
    drawPhoto: (g, cx, cy, R) => g.drawImage(img, cx - R, cy - R, 2 * R, 2 * R),
    realistic: true, counter: q.get('counter') !== '0', light: q.get('light') || 'window',
  });
  c.prepare();
  const until = async ok => { for (let k = 0; k < 2000 && !ok(); k++) await new Promise(r => setTimeout(r, 30)); };
  await until(() => c.ready());
  const files = [];
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const g = out.getContext('2d');
  const report = {
    via, style: info?.style, sheetMm: info?.sheetMm, toolMm: info?.toolMm, points: geom.n,
    hand: info ? formatHand(info.handSeconds) : null, handSeconds: info && Math.round(info.handSeconds),
    peak: c.hand && Math.round(c.hand.peak), avg: c.hand && Math.round(c.hand.avg), open: c.hand?.open, D: c.D,
    toolLen: +c.toolLen.toFixed(4), mode: c.intent?.mode, macro: c.intent?.macro ? +c.intent.macro.zoom.toFixed(2) : null,
    sheetPx: c.sheetPx, macroCfg: c.macroCfg, prepMs: Math.round(performance.now() - t0),
  };
  if (c.plan) {
    // The camera never whip-pans: how fast what is at the frame's centre moves across the screen
    // (px per second at the film's size) and how fast the zoom changes; and the pen stays in frame.
    const pans = [], zooms = [];
    let inFrame = 0, drawing = 0;
    for (let i = 0; i + 1 < c.frames; i++) {
      const a = sceneLib.cameraBasis(c.plan.at(i / FPS), W, H, c.side), b = sceneLib.cameraBasis(c.plan.at((i + 1) / FPS), W, H, c.side);
      const p = sceneLib.unproject(a, W / 2, H / 2);
      if (p) { const s = sceneLib.project(b, p[0], p[1]); pans.push(Math.hypot(s[0] - W / 2, s[1] - H / 2) * FPS); }
      zooms.push(Math.abs(Math.log(c.plan.at((i + 1) / FPS).zoom / c.plan.at(i / FPS).zoom)) * FPS);
      const t = i / FPS;
      if (t > c.t0 && t < c.t1) {
        drawing++;
        const [x, y] = c.tipOnScreen(i);
        if (x >= 0 && y >= 0 && x <= W && y <= H) inFrame++;
      }
    }
    const pct = (arr, q) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
    report.camera = { panMaxPxS: Math.round(Math.max(...pans)), panP99PxS: Math.round(pct(pans, 0.99)), zoomMaxPerS: +Math.max(...zooms).toFixed(2),
      penInFrame: +(inFrame / Math.max(1, drawing)).toFixed(4) };
  }
  if (q.get('at') || q.get('t')) {
    const times = q.get('t') ? q.get('t').split(',').map(Number) : q.get('at').split(',').map(f => +f * LENGTH);
    report.shots = [];
    for (const t of times) {
      const i = Math.min(c.frames - 1, Math.max(0, Math.round(t * FPS)));
      c.rewind();
      c.draw(i, g);
      const tt = i / FPS;
      files.push(await save(out, `rf_${TAG}_${String(Math.round(tt * 100) / 100).replace('.', 'p')}s`));
      report.shots.push({ t: +tt.toFixed(2), hand: c.hand ? formatHand(c.hand.hand(tt), true) : null, speed: c.hand ? formatSpeed(c.hand.speed(tt)) : null,
        tip: c.tipOnScreen(i).map(v => Math.round(v)) });
    }
  }
  if (q.get('encode')) {
    const { encodeVideo } = await import('../js/encoder.js');
    const te = performance.now();
    const res = await encodeVideo({ width: W, height: H, fps: FPS, frames: c.frames, ...c.encodeHints(), drawFrame: (i, ctx) => c.draw(i, ctx) });
    const r = await fetch(`/__file?name=rf_${TAG}.mp4`, { method: 'POST', body: res.blob });
    files.push(`shots/rf_${TAG}.mp4 (${r.status})`);
    report.encodeMs = Math.round(performance.now() - te);
    report.composeMsPerFrame = +(c.stats.ms / Math.max(1, c.stats.frames)).toFixed(2);
    report.frames = res.frames; report.codec = res.codec;
  }
  c.destroy();
  window.__done = { ok: true, info: report, files };
}

run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
