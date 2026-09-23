// Dev lab: renders contact sheets of the engine and saves them through the dev server.
//   node tests/shoot.mjs "/dev/lab.html?sheet=matrix;img=portrait;size=420;tech=thickness;rings=64"
//   sheet = matrix (brushes x papers) | brushes | papers | looks | previews | single, and for the
//   physics core:
//     consistency  preview vs box-downsampled 4x render per brush (report + pass/fail)
//     wet          wet media x papers; crop=x,y,w + big=px for 1:1 crops
//     swatch       a painter's swatch card (widening strokes, lingering U-turns); zoom=k, at=x,y
//     progress     one brush drawn to at=0.3,0.6,... (> 1 = finished + settle), zoom around the pen
//     lights       one brush under lights=az,el_az,el_... (degrees); crop + big for 1:1
//     paths        spiral | wander | contour | maze per brush
//     simdump      the wet state as images + stats (W S P M E, injection, conductance); profile=x,y0,y1;
//                  scissor=check reruns the schedule on the whole grid (must match exactly)
//     media        every medium on its own paper, 1:1 crop of a big render (crop=x,y,w; big=px)
//     wetset       the wet media with their Looks' lines and papers (crop=x,y,w + mag=k, or
//                  macro=x,y,k for the film's renderToTexture close-up); brushes= / papers= filter
//     macro        renderToTexture({ rect }) close-up: exactness, interleaving, timing; k=, at=
//     head         incremental fractional heads vs fresh renders (report)
//     headviz      a zig-zag drawn to fractional indices (at=...)
//     timing       still / scrub / wet step / film frame / macro frame costs per brush (report)
//   img = portrait | ramp | sample:<id> | <url>;  blank=1 renders paper only;  jpg=1 saves JPEG
//   single: brush, paper, ink, photo=1, crop=x,y,w (fractions, for 1:1 inspection of big sizes)
//   brushes= / papers= pick rows and columns; path=wander|contour|maze for any sheet; physics knobs
//   (light, view, eye, upto, settle, time, pacing, wet overrides) are listed at applyPhysics below.
// Sets window.__done = { ok, file, report } when the shot is saved (for tests/shoot.mjs).
import { Renderer } from '../js/renderer.js';
import { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS } from '../js/tone.js';
import { buildSpiral, LINE_DEFAULTS, previewStroke } from '../js/spiral.js';
import { buildMaze } from '../js/maze.js';
import { buildWander, buildContour } from '../js/freeline.js';
import { BRUSHES, PAPERS, LOOKS, brushById, paperById, inkMode } from '../js/materials.js';

const q = new URLSearchParams(location.search);
const LAYOUT = { cx: 0.5, cy: 0.5, r: 0.42 };
// nofloat=1: pretend float render targets are missing, so every sheet runs the 8-bit fallbacks
// (surface target, wet state, injection map). nofloat=linear: float targets but no linear filtering
// of 32-bit floats (common on phones), so the wet state is half float.
if (q.get('nofloat')) {
  const hide = q.get('nofloat') === 'linear' ? ['OES_texture_float_linear'] : ['EXT_color_buffer_float', 'EXT_color_buffer_half_float'];
  const get = WebGL2RenderingContext.prototype.getExtension;
  WebGL2RenderingContext.prototype.getExtension = function (name) { return hide.includes(name) ? null : get.call(this, name); };
}

// ------------------------------------------------------------------ synthetic test images
export function testImage(kind = 'portrait', S = 1024) {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const u = S / 100;
  if (kind === 'ramp') {
    // radial L ramp + stripes: tone-mapping and moire check
    const grd = g.createLinearGradient(0, 0, S, 0);
    grd.addColorStop(0, '#000'); grd.addColorStop(1, '#fff');
    g.fillStyle = grd; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 10; i++) { g.fillStyle = i % 2 ? '#000' : '#fff'; g.fillRect(i * 10 * u, 80 * u, 10 * u, 20 * u); }
    return c;
  }
  // a stylised portrait with real tonal structure
  const bg = g.createLinearGradient(0, 0, 0, S);
  bg.addColorStop(0, '#c9ced6'); bg.addColorStop(1, '#8d939c');
  g.fillStyle = bg; g.fillRect(0, 0, S, S);
  // shoulders
  g.fillStyle = '#2b2f3a';
  g.beginPath(); g.ellipse(50 * u, 108 * u, 46 * u, 30 * u, 0, 0, Math.PI * 2); g.fill();
  // neck
  g.fillStyle = '#b98a6e'; g.fillRect(42 * u, 62 * u, 16 * u, 18 * u);
  // hair back
  g.fillStyle = '#231a14';
  g.beginPath(); g.ellipse(50 * u, 40 * u, 27 * u, 31 * u, 0, 0, Math.PI * 2); g.fill();
  // face with side light
  const face = g.createRadialGradient(42 * u, 40 * u, 4 * u, 50 * u, 46 * u, 30 * u);
  face.addColorStop(0, '#f1cfb4'); face.addColorStop(0.6, '#d7a988'); face.addColorStop(1, '#8f624a');
  g.fillStyle = face;
  g.beginPath(); g.ellipse(50 * u, 47 * u, 20 * u, 26 * u, 0, 0, Math.PI * 2); g.fill();
  // fringe
  g.fillStyle = '#231a14';
  g.beginPath(); g.ellipse(46 * u, 25 * u, 22 * u, 10 * u, -0.3, 0, Math.PI * 2); g.fill();
  // brows, eyes
  g.strokeStyle = '#3a271c'; g.lineWidth = 1.6 * u; g.lineCap = 'round';
  for (const s of [-1, 1]) {
    g.beginPath(); g.moveTo((50 + s * 4) * u, 38 * u); g.quadraticCurveTo((50 + s * 9) * u, 35.5 * u, (50 + s * 14) * u, 38 * u); g.stroke();
    g.fillStyle = '#fbf6f1'; g.beginPath(); g.ellipse((50 + s * 9) * u, 43 * u, 4.2 * u, 2.1 * u, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#3d2a1f'; g.beginPath(); g.arc((50 + s * 9) * u, 43 * u, 1.9 * u, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#000'; g.beginPath(); g.arc((50 + s * 9) * u, 43 * u, 0.9 * u, 0, Math.PI * 2); g.fill();
  }
  // nose shadow, lips
  g.fillStyle = 'rgba(110,70,50,0.55)';
  g.beginPath(); g.moveTo(51 * u, 44 * u); g.lineTo(54 * u, 55 * u); g.lineTo(49 * u, 56 * u); g.closePath(); g.fill();
  g.fillStyle = '#9c4a44';
  g.beginPath(); g.ellipse(50 * u, 62 * u, 6 * u, 2.2 * u, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#5a2723'; g.lineWidth = 0.7 * u;
  g.beginPath(); g.moveTo(44.5 * u, 62 * u); g.quadraticCurveTo(50 * u, 63.2 * u, 55.5 * u, 62 * u); g.stroke();
  return c;
}

async function loadImage(spec) {
  if (spec && spec.startsWith('sample:')) {
    const { makeSample } = await import('../js/samples.js');
    return makeSample(spec.slice(7), 1024);
  }
  if (!spec || !spec.includes('.')) return testImage(spec || 'portrait');
  const img = new Image();
  img.src = spec;
  await img.decode();
  return img;
}

// A painter's swatch card as one line: horizontal strokes (boustrophedon) that widen from left to
// right, joined by lingering U-turns (dwell 2.5: pools). The top rows are far apart (each stroke
// dries alone); the bottom rows are close enough to touch while wet (merging, blooms).
export function swatchGeometry({ rows = 7, wMin = 0.004, wMax = 0.07, tone0 = 0.25, tone1 = 1 } = {}) {
  const pts = [];
  let s = 0, px = 0, py = 0, turn = 0;
  const push = (x, y, w, tone, dwell) => {
    if (pts.length) s += Math.hypot(x - px, y - py);
    pts.push(x, y, w, s, tone, turn, dwell);
    px = x; py = y;
  };
  const ys = [];
  for (let r = 0; r < rows; r++) ys.push(r < rows - 3 ? -0.85 + r * 0.3 : ys[ys.length - 1] + (r === rows - 3 ? 0.3 : 0.075));
  for (let r = 0; r < rows; r++) {
    const dir = r % 2 ? -1 : 1, y = ys[r];
    const N = 400;
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const x = dir * (-0.85 + 1.7 * u);
      const k = dir > 0 ? u : 1 - u;                    // wide on the right
      push(x, y, wMin + (wMax - wMin) * k, tone0 + (tone1 - tone0) * k, 1);
    }
    if (r < rows - 1) {
      const y2 = ys[r + 1], cx = dir * 0.85, rad = (y2 - y) / 2;
      const k = dir > 0 ? 1 : 0;
      for (let i = 1; i < 40; i++) {
        const a = Math.PI * i / 40;
        push(cx + dir * rad * Math.sin(a), y + rad - rad * Math.cos(a), wMin + (wMax - wMin) * k, tone0 + (tone1 - tone0) * k, 2.5);
      }
      turn++;
    }
  }
  const data = new Float32Array(pts);
  return { n: data.length / 7, data, colors: null, rings: rows, spacing: 0.1, length: s, turns: turn, technique: 'thickness', path: 'spiral', _pace: new Map() };
}

// ------------------------------------------------------------------ helpers
const geomCache = new Map();
function geometryFor(src, { rings, tech, flip, photo, line = {}, path = q.get('path') }) {
  const key = [rings, tech, flip, photo, JSON.stringify(line), path, location.search].join('|');
  if (geomCache.has(key)) return geomCache.get(key);
  const raster = rasterize(src, CROP_DEFAULTS);
  const tone = processTone(raster, TONE_DEFAULTS, { flip });
  const field = buildField(raster, tone.L, { rings, flip });
  const free = { shape: q.get('shape') || 'square', x: +(q.get('sx') || 0), y: +(q.get('sy') || 0), seed: +(q.get('seed') || 1) };
  if (path === 'wander' || path === 'contour') {
    const g2 = (path === 'wander' ? buildWander : buildContour)(field, { ...LINE_DEFAULTS, technique: tech, rings, ...line }, free, { colorFromPhoto: photo });
    geomCache.set(key, g2);
    return g2;
  }
  const g = path === 'maze'
    ? buildMaze(field, { ...LINE_DEFAULTS, technique: tech, rings, ...line },
      { shape: q.get('shape') || 'square', x: +(q.get('sx') || 0), y: +(q.get('sy') || 0), flow: +(q.get('flow') ?? 0.6), seed: +(q.get('seed') || 1) },
      { colorFromPhoto: photo })
    : buildSpiral(field, { ...LINE_DEFAULTS, technique: tech, rings, ...line }, { colorFromPhoto: photo });
  geomCache.set(key, g);
  return g;
}

// Physics knobs (renderer.setLight / setTime / render opts), for every sheet:
//   light=az,el[,intensity,warmth]  degrees; az = direction toward the light (x right, y down),
//                                   the default window light is az=-130,el=40
//   upto=0..1   drawing progress (fraction of the points) instead of the finished sheet
//   settle=0..1 drying after the drawing (default: 1 for the finished sheet)
//   time=s      scene time (neon flicker)       pacing=natural|steady|rings
//   view=x,y,z  direction toward the camera (default straight above 0,0,1; the film tilts it)
//   eye=x,y,z   camera position in sheet widths (x, y from the top-left corner, z above): local glints
function applyPhysics(r) {
  const L = q.get('light');
  const view = q.get('view') ? q.get('view').split(',').map(Number) : undefined;   // toward the camera, x,y,z
  const eye = q.get('eye') ? q.get('eye').split(',').map(Number) : undefined;      // camera position, sheet widths
  if (L) {
    const [az, el, it, wa] = L.split(',').map(Number);
    r.setLight({ azimuth: az * Math.PI / 180, elevation: (el || 40) * Math.PI / 180, intensity: it || 1, warmth: wa || 0, view, eye });
  } else r.setLight(view || eye ? { view, eye } : undefined);
  r.setTime(q.has('time') ? +q.get('time') : null);
}
function drawOpts(geom) {
  const f = q.has('upto') ? +q.get('upto') : 1;
  const upTo = f >= 1 ? Infinity : f * (geom.n - 1);
  const o = {};
  if (q.has('settle')) o.settle = +q.get('settle');
  return [upTo, o];
}

// wet=gran:0,mobile:0.8,load:1 overrides a medium's wet parameters (tuning experiments)
const wetOverride = q.get('wet') ? Object.fromEntries(q.get('wet').split(',').map(kv => kv.split(':')).map(([k, v]) => [k, +v])) : null;
const tuned = new Map();
function tune(brush) {
  if (!wetOverride || !(brush.wetness > 0)) return brush;
  if (!tuned.has(brush)) {
    const { load, ...rest } = wetOverride;
    tuned.set(brush, { ...brush, wetness: load ?? brush.wetness, wet: { ...brush.wet, ...rest } });
  }
  return tuned.get(brush);
}

let renderer;
function draw({ size, brush, paper, ink, geom, cover, photo }) {
  if (!renderer) renderer = new Renderer(document.createElement('canvas'));
  brush = tune(brush);
  renderer.setSize(size, size);
  renderer.setLayout(LAYOUT);
  renderer.setPaper(paper, 1);
  renderer.setStyle({ brush, ink, cover, photoColor: photo });
  renderer.setGeometry(geom, { pacing: q.get('pacing') || 'natural' });
  // simclock=1: the film-like wet clock (see sheet=head), e.g. for simdump's scissor=check
  if (q.get('simclock')) renderer.setSimClock({ at: [0, 0.02 * (geom.n - 1), geom.n - 1], v: [0, 0.2, 1], mix: 1 });
  applyPhysics(renderer);
  if (q.get('blank') === '1') renderer.renderBlank();   // paper only, no line
  else renderer.render(...drawOpts(geom));
  return renderer.canvas;
}

function sheetCanvas(cols, rows, cell, label = 18) {
  const c = document.createElement('canvas');
  c.width = cols * cell; c.height = rows * (cell + label);
  const g = c.getContext('2d');
  g.fillStyle = '#d9d5ce'; g.fillRect(0, 0, c.width, c.height);
  return { c, g, put(img, col, row, text) {
    g.drawImage(img, col * cell, row * (cell + label), cell, cell);
    g.fillStyle = '#222'; g.font = '12px system-ui'; g.fillText(text, col * cell + 6, row * (cell + label) + cell + 13);
  } };
}

function copyCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

// exact k x k box downsample
function boxDown(src, k) {
  const w = src.width, h = src.height;
  const g = document.createElement('canvas'); g.width = w; g.height = h;
  const gx = g.getContext('2d', { willReadFrequently: true }); gx.drawImage(src, 0, 0);
  const d = gx.getImageData(0, 0, w, h).data;
  const W = w / k, H = h / k;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const cx = c.getContext('2d');
  const out = cx.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, gg = 0, b = 0;
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) {
      const o = ((y * k + j) * w + x * k + i) * 4;
      r += d[o]; gg += d[o + 1]; b += d[o + 2];
    }
    const o = (y * W + x) * 4, n = k * k;
    out.data[o] = r / n; out.data[o + 1] = gg / n; out.data[o + 2] = b / n; out.data[o + 3] = 255;
  }
  cx.putImageData(out, 0, 0);
  return c;
}

// luminance difference of two same-size canvases, overall and blurred to ring scale
function lumDiff(a, b) {
  const w = a.width, h = a.height;
  const da = a.getContext('2d').getImageData(0, 0, w, h).data;
  const db = b.getContext('2d').getImageData(0, 0, w, h).data;
  const L = (d, o) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];
  // compare 8x8 block means (tone), which is what a viewer perceives at print distance
  const B = 8, diffs = [];
  let sumA = 0, sumB = 0;
  for (let y = 0; y + B <= h; y += B) for (let x = 0; x + B <= w; x += B) {
    let sa = 0, sb = 0;
    for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) {
      const o = ((y + j) * w + x + i) * 4;
      sa += L(da, o); sb += L(db, o);
    }
    sa /= B * B; sb /= B * B; sumA += sa; sumB += sb;
    diffs.push(Math.abs(sa - sb));
  }
  diffs.sort((p, q2) => p - q2);
  const mean = diffs.reduce((s2, v) => s2 + v, 0) / diffs.length;
  // Texture: the high-frequency energy (std of the image minus its 3x3 box blur) of each. Tone can
  // match while the texture does not (a preview mottled where the export is smooth); hfRatio = small
  // / big, 1 when the preview shows the same grain the downsampled export has.
  const hf = d => {
    const Lm = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) Lm[i] = L(d, i * 4);
    let s = 0, s2 = 0, n = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      let m = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) m += Lm[(y + j) * w + x + i];
      const v = Lm[y * w + x] - m / 9;
      s += v; s2 += v * v; n++;
    }
    return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
  };
  const hfA = hf(da), hfB = hf(db);
  return { meanBlockDL: +mean.toFixed(2), p99BlockDL: +diffs[Math.floor(diffs.length * 0.99)].toFixed(2),
    meanLumSmall: +(sumA / diffs.length).toFixed(1), meanLumBig: +(sumB / diffs.length).toFixed(1),
    hfSmall: +hfA.toFixed(2), hfBig: +hfB.toFixed(2), hfRatio: +(hfA / Math.max(hfB, 1e-3)).toFixed(3) };
}

async function save(canvas, name, type = 'image/png') {
  const data = canvas.toDataURL(type, 0.92);
  const r = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data }) });
  return r.json();
}

// ------------------------------------------------------------------ sheets
async function run() {
  const sheet = q.get('sheet') || 'matrix';
  const size = +(q.get('size') || 420);
  const rings = +(q.get('rings') || 64);
  const tech = q.get('tech') || 'thickness';
  const src = await loadImage(q.get('img') || 'portrait');
  const t0 = performance.now();
  let out;
  const brushes = (q.get('brushes') || BRUSHES.map(b => b.id).join(',')).split(',').map(brushById);
  const papers = (q.get('papers') || PAPERS.map(p => p.id).join(',')).split(',').map(paperById);

  if (sheet === 'matrix' || sheet === 'brushes' || sheet === 'papers') {
    const rowsP = sheet === 'brushes' ? [paperById(q.get('paper') || 'sketch')] : papers;
    const colsB = sheet === 'papers' ? [brushById(q.get('brush') || 'fineliner')] : brushes;
    const S = sheetCanvas(colsB.length, rowsP.length, size);
    rowsP.forEach((paper, r) => colsB.forEach((brush, c) => {
      const ink = q.get('ink') || (paper.dark ? (brush.inks.find(([h]) => inkMode(brush, h, paper).flip) || brush.inks[0])[0] : brush.inks[0][0]);
      const mode = inkMode(brush, ink, paper);
      const geom = geometryFor(src, { rings, tech, flip: mode.flip, photo: false });
      S.put(draw({ size, brush, paper, ink, geom, cover: mode.cover }), c, r, `${brush.name} · ${paper.name}`);
    }));
    out = S.c;
  } else if (sheet === 'looks') {
    const cols = 4, rows = Math.ceil(LOOKS.length / cols);
    const S = sheetCanvas(cols, rows, size);
    LOOKS.forEach((look, i) => {
      const brush = brushById(look.brush), paper = paperById(look.paper);
      const mode = inkMode(brush, look.ink, paper);
      const geom = geometryFor(src, { rings: look.line.rings, tech: look.line.technique, flip: mode.flip, photo: false, line: look.line });
      S.put(draw({ size, brush, paper, ink: look.ink, geom, cover: mode.cover }), i % cols, Math.floor(i / cols), look.name);
    });
    out = S.c;
  } else if (sheet === 'previews') {
    // brush chip previews: a 2.5-turn fragment with thin-to-thick ramp
    const S = sheetCanvas(brushes.length, 2, size);
    const paper = paperById(q.get('paper') || 'sketch');
    ['thickness', 'wave'].forEach((technique, r) => brushes.forEach((brush, c) => {
      const geom = previewStroke({ technique });
      const p = brush.prefersDark ? paperById('black') : paper;
      const ink = brush.inks[0][0];
      const mode = inkMode(brush, ink, p);
      S.put(draw({ size, brush, paper: p, ink, geom, cover: mode.cover }), c, r, brush.name);
    }));
    out = S.c;
  } else if (sheet === 'consistency') {
    // Preview vs export: render each brush at `size` and at 4x, box-downsample the big one and
    // compare mean luminance error (dL, 0..255) and its 99th percentile. Sheet: small | down(big).
    const paper = paperById(q.get('paper') || 'cream');
    const S = sheetCanvas(2, brushes.length, size);
    const report = [];
    for (const [r, brush] of brushes.entries()) {
      const ink = paper.dark ? (brush.inks.find(([h]) => inkMode(brush, h, paper).flip) || brush.inks[0])[0] : brush.inks[0][0];
      const mode = inkMode(brush, ink, paper);
      const geom = geometryFor(src, { rings, tech, flip: mode.flip, photo: false });
      const a = copyCanvas(draw({ size, brush, paper, ink, geom, cover: mode.cover }));
      const big = draw({ size: size * 4, brush, paper, ink, geom, cover: mode.cover });
      const b = boxDown(big, 4);
      S.put(a, 0, r, `${brush.name} @${size}`); S.put(b, 1, r, `${brush.name} @${size * 4} → ${size}`);
      report.push({ brush: brush.id, ...lumDiff(a, b) });
    }
    out = S.c;
    window.__report = report;
    // pass: a preview carries the same ink as the export it stands for (HEAD measured <= 2.9 / 2.7),
    // and a wet medium shows the texture the export has (high-frequency energy within 12%; the dry
    // media's ratios are reported: their grain is judged by B2's own ladders). Judged at preview
    // sizes (>= 400 px, the app's stage): below that a pixel spans several simulation cells.
    const wetIds = new Set(BRUSHES.filter(b => b.wetness > 0).map(b => b.id));
    window.__ok = report.every(r => r.meanBlockDL < 3.5 && Math.abs(r.meanLumSmall - r.meanLumBig) < 3.5
      && (!wetIds.has(r.brush) || size < 400 || r.hfBig < 6 || Math.abs(r.hfRatio - 1) < 0.12));
  } else if (sheet === 'wet') {
    // Wet media x papers (full discs). brushes= / papers= pick rows / columns.
    const wetB = (q.get('brushes') || 'fountain,marker,brush,watercolour').split(',').map(brushById);
    const pp = (q.get('papers') || 'sketch,cream,coldpress,kraft').split(',').map(paperById);
    // crop=x,y,w (fractions of the sheet) with big=px renders each cell large and shows the crop 1:1
    // (mag=k enlarges the crop k x with square pixels, for judging single pixels)
    const crop = q.get('crop'), big = +(q.get('big') || 2048), mag = +(q.get('mag') || 1);
    const S = sheetCanvas(pp.length, wetB.length, crop ? Math.round(+crop.split(',')[2] * big) * mag : size);
    wetB.forEach((brush, r) => pp.forEach((paper, c) => {
      const ink = q.get('ink') || brush.inks[+(q.get('inkIdx') || 0)][0];
      const mode = inkMode(brush, ink, paper);
      const geom = geometryFor(src, { rings, tech, flip: mode.flip, photo: false });
      let img = draw({ size: crop ? big : size, brush, paper, ink, geom, cover: mode.cover });
      if (crop) {
        const [cx, cy, cw] = crop.split(',').map(Number);
        const n = Math.round(cw * big);
        const cc = document.createElement('canvas'); cc.width = cc.height = n * mag;
        const g2 = cc.getContext('2d');
        g2.imageSmoothingEnabled = false;
        g2.drawImage(img, cx * big, cy * big, n, n, 0, 0, n * mag, n * mag);
        img = cc;
      }
      S.put(img, c, r, `${brush.name} · ${paper.name}`);
    }));
    out = S.c;
  } else if (sheet === 'swatch') {
    // The swatch card (swatchGeometry) for brushes x papers; upto/settle/light apply. zoom=k shows
    // the centre 1/k of the card at k x.
    const wetB = (q.get('brushes') || 'fountain,marker,brush,watercolour').split(',').map(brushById);
    const pp = (q.get('papers') || 'sketch,cream,coldpress,kraft').split(',').map(paperById);
    const zoom = +(q.get('zoom') || 1);
    const geom = swatchGeometry();
    const S = sheetCanvas(pp.length, wetB.length, size);
    wetB.forEach((brush, r) => pp.forEach((paper, c) => {
      const ink = q.get('ink') || brush.inks[+(q.get('inkIdx') || 0)][0];
      const mode = inkMode(brush, ink, paper);
      let img = draw({ size: size * zoom, brush, paper, ink, geom, cover: mode.cover });
      if (zoom > 1) {
        const [fx, fy] = (q.get('at') || '0.5,0.5').split(',').map(Number);
        const cc = document.createElement('canvas'); cc.width = cc.height = size;
        cc.getContext('2d').drawImage(img, -(fx * size * zoom - size / 2), -(fy * size * zoom - size / 2));
        img = cc;
      }
      S.put(img, c, r, `${brush.name} · ${paper.name}`);
    }));
    out = S.c;
  } else if (sheet === 'media') {
    // Every medium on its own paper (the one its Look uses), as a 1:1 crop of a big render:
    // crop=x,y,w (sheet fractions, default the eye and brow), big=px (default 2048), cols=4.
    // upto/settle/light/view/eye apply, so this is also the wet-vs-dry and lighting overview.
    const natural = { pencil: 'sketch', fineliner: 'cream', fountain: 'sketch', crayon: 'kraft', ballpoint: 'cream',
      marker: 'sketch', brush: 'coldpress', charcoal: 'coldpress', chalk: 'chalkboard', neon: 'black', gold: 'black',
      watercolour: 'coldpress' };
    const [cx, cy, cw] = (q.get('crop') || '0.3,0.33,0.2').split(',').map(Number);
    const big = +(q.get('big') || 2048), cell = Math.round(cw * big), cols = +(q.get('cols') || 4);
    const S = sheetCanvas(cols, Math.ceil(brushes.length / cols), cell);
    brushes.forEach((brush, i) => {
      const paper = paperById(q.get('paper') || natural[brush.id] || 'cream');
      const ink = q.get('ink') || (paper.dark ? (brush.inks.find(([h]) => inkMode(brush, h, paper).flip) || brush.inks[0])[0] : brush.inks[0][0]);
      const mode = inkMode(brush, ink, paper);
      const geom = geometryFor(src, { rings, tech, flip: mode.flip, photo: false });
      const img = draw({ size: big, brush, paper, ink, geom, cover: mode.cover });
      const cc = document.createElement('canvas'); cc.width = cc.height = cell;
      cc.getContext('2d').drawImage(img, -cx * big, -cy * big);
      S.put(cc, i % cols, Math.floor(i / cols), `${brush.name} · ${paper.name}`);
    });
    out = S.c;
  } else if (sheet === 'wetset') {
    // The wet media (fineliner, fountain, sumi, watercolour, marker) each with its Look's line and
    // paper, as the app would show them: size = the sheet's px (full disc), or crop=x,y,w + mag=k for
    // a close look. path=wander|contour|maze for other paths; papers=<id> puts them all on one paper.
    const SET = [
      ['fineliner', 'cream', { rings: 72, weight: 0.88, hairline: 0.08, wobble: 0.1 }],
      ['fountain', 'sketch', { rings: 64, weight: 0.85, hairline: 0.06, wobble: 0.1 }],
      ['brush', 'coldpress', { rings: 50, weight: 0.95, hairline: 0.06, wobble: 0.3 }],
      ['watercolour', 'coldpress', { rings: 50, weight: 0.95, hairline: 0.08, wobble: 0.2 }],
      ['marker', 'sketch', { rings: 40, weight: 0.94, hairline: 0.1, wobble: 0.15 }],
    ].filter(([id]) => !q.get('brushes') || q.get('brushes').split(',').includes(id));
    // macro=x,y,k: the film's nib close-up instead (renderToTexture with a rect 1/k of the sheet wide
    // around x,y, rendered at `size` texels, i.e. the sheet as if it were size * k px wide)
    const crop = q.get('crop'), mag = +(q.get('mag') || 1), cols = +(q.get('cols') || SET.length);
    const macro = q.get('macro') ? q.get('macro').split(',').map(Number) : null;
    const cell = crop ? Math.round(+crop.split(',')[2] * size) * mag : size;
    const S = sheetCanvas(Math.min(cols, SET.length), Math.ceil(SET.length / cols), cell);
    SET.forEach(([id, pid, line], i) => {
      const brush = brushById(id), paper = paperById(q.get('papers') || pid);
      const ink = brush.inks[+(q.get('inkIdx') || 0)][0];
      const mode = inkMode(brush, ink, paper);
      const geom = geometryFor(src, { rings: line.rings, tech, flip: mode.flip, photo: false, line });
      let img = draw({ size, brush, paper, ink, geom, cover: mode.cover });
      if (macro) {
        const [mx, my, k] = macro, r = renderer, gl = r.gl;
        const res = r.renderToTexture(drawOpts(geom)[0], { ...drawOpts(geom)[1], rect: [mx - 0.5 / k, my - 0.5 / k, mx + 0.5 / k, my + 0.5 / k], size });
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, res.tex, 0);
        const px = new Uint8Array(res.w * res.h * 4);
        gl.readPixels(0, 0, res.w, res.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb);
        r.releaseRect();
        const c = document.createElement('canvas'); c.width = res.w; c.height = res.h;
        const g = c.getContext('2d'), im = g.createImageData(res.w, res.h);
        for (let y = 0; y < res.h; y++) im.data.set(px.subarray((res.h - 1 - y) * res.w * 4, (res.h - y) * res.w * 4), y * res.w * 4);
        g.putImageData(im, 0, 0);
        // the asked rect inside the texture (which carries a margin)
        const sx = (mx - 0.5 / k - res.rect[0]) / (res.rect[2] - res.rect[0]) * res.w;
        const sy = (my - 0.5 / k - res.rect[1]) / (res.rect[3] - res.rect[1]) * res.h;
        const cc = document.createElement('canvas'); cc.width = cc.height = size;
        cc.getContext('2d').drawImage(c, sx, sy, size, size, 0, 0, size, size);
        img = cc;
      } else if (crop) {
        const [cx, cy, cw] = crop.split(',').map(Number), n = Math.round(cw * size);
        const cc = document.createElement('canvas'); cc.width = cc.height = n * mag;
        const g2 = cc.getContext('2d'); g2.imageSmoothingEnabled = false;
        g2.drawImage(img, cx * size, cy * size, n, n, 0, 0, n * mag, n * mag);
        img = cc;
      }
      S.put(img, i % cols, Math.floor(i / cols), `${brush.name} · ${paper.name}`);
    });
    out = S.c;
  } else if (sheet === 'paths') {
    // The four path types for each brush: spiral | wander | contour | maze (path-specific rings).
    const kinds = (q.get('kinds') || 'spiral,wander,contour,maze').split(',');
    const paper = paperById(q.get('paper') || 'cream');
    const S = sheetCanvas(kinds.length, brushes.length, size);
    const ringsFor = { spiral: rings, wander: +(q.get('wrings') || 64), contour: +(q.get('crings') || 80), maze: +(q.get('mrings') || 60) };
    brushes.forEach((brush, r) => kinds.forEach((path, c) => {
      const ink = q.get('ink') || (paper.dark ? (brush.inks.find(([h]) => inkMode(brush, h, paper).flip) || brush.inks[0])[0] : brush.inks[0][0]);
      const mode = inkMode(brush, ink, paper);
      const geom = geometryFor(src, { rings: ringsFor[path], tech, flip: mode.flip, photo: false, path });
      S.put(draw({ size, brush, paper, ink, geom, cover: mode.cover }), c, r, `${brush.name} · ${path} (${geom.n - 1} seg)`);
    }));
    out = S.c;
  } else if (sheet === 'progress') {
    // One brush drawn incrementally: columns = progress fractions (at=0.2,0.5,...; a value > 1
    // means finished with settle = value - 1). zoom=k crops k x around the pen.
    const brush = brushById(q.get('brush') || 'watercolour'), paper = paperById(q.get('paper') || 'coldpress');
    const ink = q.get('ink') || brush.inks[0][0];
    const mode = inkMode(brush, ink, paper);
    const geom = geometryFor(src, { rings, tech, flip: mode.flip, photo: false });
    const ats = (q.get('at') || '0.3,0.6,0.9,1.0,1.5,2').split(',').map(Number);
    const zoom = +(q.get('zoom') || 1);
    const S = sheetCanvas(ats.length, 1, size);
    const r = renderer || (renderer = new Renderer(document.createElement('canvas')));
    r.setSize(size * zoom, size * zoom); r.setLayout(LAYOUT); r.setPaper(paper, 1);
    r.setStyle({ brush, ink, cover: mode.cover, photoColor: false });
    r.setGeometry(geom, { pacing: q.get('pacing') || 'natural' });
    applyPhysics(r);
    const { headAt } = await import('../js/spiral.js');
    ats.forEach((f, c) => {
      const fi = f >= 1 ? Infinity : f * (geom.n - 1);
      r.render(fi, { settle: f >= 1 ? Math.min(1, f - 1) : 0 });
      let img = r.canvas;
      if (zoom > 1) {
        const h = headAt(geom, Math.min(geom.n - 1, fi));
        const Z = size * zoom;
        const px = (LAYOUT.cx + h.x * LAYOUT.r) * Z, py = (LAYOUT.cy + h.y * LAYOUT.r) * Z;
        const cc = document.createElement('canvas'); cc.width = cc.height = size;
        cc.getContext('2d').drawImage(img, -Math.max(0, Math.min(Z - size, px - size / 2)), -Math.max(0, Math.min(Z - size, py - size / 2)));
        img = cc;
      }
      S.put(img, c, 0, f >= 1 ? `settle ${Math.min(1, f - 1)}` : `${Math.round(f * 100)}%`);
    });
    out = S.c;
  } else if (sheet === 'lights') {
    // One brush under several key lights (az,el per column; light=... is ignored here).
    const brush = brushById(q.get('brush') || 'gold'), paper = paperById(q.get('paper') || (brush.prefersDark ? 'black' : 'cream'));
    const ink = q.get('ink') || brush.inks[0][0];
    const mode = inkMode(brush, ink, paper);
    const geom = geometryFor(src, { rings, tech, flip: mode.flip, photo: false });
    const lights = (q.get('lights') || '-130,40_-90,25_-30,20_150,15').split('_').map(s => s.split(',').map(Number));
    const crop = q.get('crop');
    const S = sheetCanvas(lights.length, 1, size);
    lights.forEach(([az, el], c) => {
      const big = crop ? +(q.get('big') || 2048) : size;
      const cv = draw({ size: big, brush, paper, ink, geom, cover: mode.cover });
      renderer.setLight({ azimuth: az * Math.PI / 180, elevation: el * Math.PI / 180 });
      renderer.render(Infinity);
      let img = cv;
      if (crop) {
        const [cx, cy, cw] = crop.split(',').map(Number);
        const cc = document.createElement('canvas'); cc.width = cc.height = Math.round(cw * big);
        cc.getContext('2d').drawImage(cv, -cx * big, -cy * big);
        img = cc;
      }
      S.put(img, c, 0, `${brush.name} light ${az}/${el}`);
    });
    out = S.c;
  } else if (sheet === 'paperlight') {
    // Papers (rows) under the named still lights (columns, papers.js LIGHTS): each cell is a 1:1
    // crop of a `size`-px render (the preview's density; big=4096 for an export's) straddling the
    // drawing's edge, so blank sheet and drawing show side by side. crop=x,y,w (sheet fractions);
    // full=1 puts the whole sheet in each cell instead (scaled to cell=px). Each paper gets its
    // natural medium unless brush= is given; blank=1 draws paper only.
    const { LIGHTS } = await import('../js/papers.js');
    const lightIds = (q.get('lights') || 'window,raking,overhead').split(',');
    const pair = { sketch: 'pencil', cream: 'fineliner', coldpress: 'watercolour', kraft: 'crayon', black: 'gold',
      chalkboard: 'chalk', blueprint: 'chalk' };
    const big = +(q.get('big') || size);
    const [cx, cy, cw] = (q.get('crop') || '0.03,0.36,0.3').split(',').map(Number);
    const full = q.get('full') === '1';
    const cell = full ? +(q.get('cell') || 420) : Math.round(cw * big);
    const S = sheetCanvas(lightIds.length, papers.length, cell);
    const report = [];
    for (const [r, paper] of papers.entries()) {
      const brush = brushById(q.get('brush') || pair[paper.id] || 'fineliner');
      const ink = q.get('ink') || (paper.dark ? (brush.inks.find(([h]) => inkMode(brush, h, paper).flip) || brush.inks[0])[0] : brush.inks[0][0]);
      const mode = inkMode(brush, ink, paper);
      const geom = geometryFor(src, { rings, tech, flip: mode.flip, photo: false });
      const cv = draw({ size: big, brush, paper, ink, geom, cover: mode.cover });
      for (const [c, id] of lightIds.entries()) {
        const L = LIGHTS[id];
        // ms: median of 5 composites under this light (the light changes only the composite),
        // synced with a pixel read
        const gl = renderer.gl, px = new Uint8Array(4), times = [];
        for (let k = 0; k < 5; k++) {
          renderer.setLight(L);
          const t = performance.now();
          if (q.get('blank') === '1') renderer.renderBlank(); else renderer.render(Infinity);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          times.push(performance.now() - t);
        }
        const ms = times.sort((a, b) => a - b)[2];
        let img = cv;
        if (!full) {
          img = document.createElement('canvas'); img.width = img.height = cell;
          img.getContext('2d').drawImage(cv, -cx * big, -cy * big);
        }
        // the blank corner at 1:1: mean colour (paper colour check) and luminance std (how much
        // texture shows at this density), 0..255
        const cs = Math.round(0.06 * big);
        const g = document.createElement('canvas'); g.width = g.height = cs;
        g.getContext('2d').drawImage(cv, -Math.round(0.01 * big), -Math.round(0.01 * big));
        const d = g.getContext('2d').getImageData(0, 0, cs, cs).data;
        let sr = 0, sg = 0, sb = 0, sl = 0, sl2 = 0;
        for (let i = 0; i < d.length; i += 4) {
          sr += d[i]; sg += d[i + 1]; sb += d[i + 2];
          const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          sl += l; sl2 += l * l;
        }
        const n = d.length / 4;
        report.push({ paper: paper.id, light: id, ms: +ms.toFixed(1), corner: [sr / n, sg / n, sb / n].map(v => +v.toFixed(1)),
          std: +Math.sqrt(Math.max(0, sl2 / n - (sl / n) ** 2)).toFixed(2) });
        S.put(img, c, r, `${paper.name} · ${brush.name} · ${L.name} @${big}`);
      }
    }
    window.__report = report;
    out = S.c;
  } else if (sheet === 'simdump') {
    // The wet simulation's state as images: W water, S suspended, P deposited, M moisture,
    // E extent, inj water / pigment / time, phys conductance. brush/paper/upto/settle as usual.
    const brush = brushById(q.get('brush') || 'watercolour'), paper = paperById(q.get('paper') || 'coldpress');
    const ink = q.get('ink') || brush.inks[0][0];
    const mode = inkMode(brush, ink, paper);
    const geom = q.get('swatch') ? swatchGeometry() : geometryFor(src, { rings, tech, flip: mode.flip, photo: false });
    const cv = draw({ size, brush, paper, ink, geom, cover: mode.cover });
    const r = renderer, gl = r.gl, sim = r.sim;
    const gw = sim.w, gh = sim.h;
    const readTex = (tex, float) => {
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      let px;
      if (float) { px = new Float32Array(gw * gh * 4); gl.readPixels(0, 0, gw, gh, gl.RGBA, gl.FLOAT, px); }
      else { const b = new Uint8Array(gw * gh * 4); gl.readPixels(0, 0, gw, gh, gl.RGBA, gl.UNSIGNED_BYTE, b); px = Float32Array.from(b, v => v / 255); }
      gl.deleteFramebuffer(fb);
      return px;
    };
    const A = readTex(sim.stateNew, sim.stateFmt !== 'rgba8');
    const B = readTex(sim.extent, sim.stateFmt !== 'rgba8');      // B is half float unless the state is 8-bit
    const I = readTex(sim.inj, sim.floatRT);
    const Ph = readTex(sim.phys, false);
    const C = sim.soakNew ? readTex(sim.soakNew, sim.stateFmt !== 'rgba8') : null;   // colourant in the fibres
    // scissor=check: the same schedule run on the whole grid every step must give the same state
    // (the renderer's per-step rects are an optimisation: they must never cut off liquid)
    let scissor = null;
    if (q.get('scissor') === 'check') {
      const K = sim.k, saved = r.simRects, full = new Int32Array(saved.length);
      for (let k = 0; k < full.length; k += 4) { full[k + 2] = gw; full[k + 3] = gh; }
      r.simRects = full; sim.reset(); r._simAdvance(K);
      const A2 = readTex(sim.stateNew, sim.stateFmt !== 'rgba8');
      const C2 = C && readTex(sim.soakNew, sim.stateFmt !== 'rgba8');
      r.simRects = saved; sim.reset(); r._simAdvance(K);
      const A3 = readTex(sim.stateNew, sim.stateFmt !== 'rgba8');        // the same run again
      const C3 = C && readTex(sim.soakNew, sim.stateFmt !== 'rgba8');
      const cmp = (x, y) => { let m = 0, n = 0; for (let i = 0; i < x.length; i++) { const d = Math.abs(x[i] - y[i]); if (d > 1e-6) n++; if (d > m) m = d; } return [m, n]; };
      let [m, n] = cmp(A3, A2);
      const [m0, n0] = cmp(A, A3);
      if (C) { const [mc, nc] = cmp(C3, C2); m = Math.max(m, mc); n += nc; }
      const where = [];
      for (let i = 0; i < A3.length && where.length < 8; i++) if (Math.abs(A3[i] - A2[i]) > 1e-6) where.push([(i >> 2) % gw, Math.floor((i >> 2) / gw), 'WSPM'[i & 3], +A3[i].toFixed(6), +A2[i].toFixed(6)]);
      const last = saved.subarray(K * 4, K * 4 + 4);
      scissor = { steps: K, maxDiff: +m.toExponential(2), valuesDiffering: n, rerunMaxDiff: +m0.toExponential(2), rerunDiffering: n0, where, lastRect: [...last] };
      if (m > 0) window.__ok = false;                              // exact: the rects are conservative
    }
    const chans = [['W', A, 0], ['S', A, 1], ['P', A, 2], ['M', A, 3], ['E', B, 0], ['D', B, 3], ['soak', C || A, C ? 0 : 3],
      ['inj W', I, 0], ['inj pig', I, 1], ['inj t', I, 3], ['cond', Ph, 1], ['height', Ph, 0]];
    const stats = {};
    const crop = (q.get('crop') || '0,0,1').split(',').map(Number);
    const x0 = Math.floor(crop[0] * gw), y0 = Math.floor(crop[1] * gh), cw = Math.max(8, Math.floor(crop[2] * gw));
    const S = sheetCanvas(chans.length + 1, 1, size);
    const c0 = document.createElement('canvas'); c0.width = c0.height = Math.round(crop[2] * size);
    c0.getContext('2d').drawImage(cv, -crop[0] * size, -crop[1] * size);
    S.put(c0, 0, 0, 'render');
    chans.forEach(([name, arr, ch], k) => {
      let mx = 0, sum = 0;
      for (let i = ch; i < arr.length; i += 4) { mx = Math.max(mx, arr[i]); sum += arr[i]; }
      stats[name] = { max: +mx.toFixed(4), mean: +(sum / (gw * gh)).toFixed(5) };
      const c = document.createElement('canvas'); c.width = c.height = cw;
      const g = c.getContext('2d'), im = g.createImageData(cw, cw);
      const sc = mx > 0 ? 1 / mx : 1;
      for (let y = 0; y < cw; y++) for (let x = 0; x < cw; x++) {
        const gx = x0 + x, gy = gh - 1 - (y0 + y);     // grid rows run up
        const v = gx < gw && gy >= 0 ? arr[(gy * gw + gx) * 4 + ch] * sc : 0;
        const o = (y * cw + x) * 4;
        im.data[o] = im.data[o + 1] = im.data[o + 2] = Math.round(255 * Math.sqrt(Math.max(0, v))); im.data[o + 3] = 255;
      }
      g.putImageData(im, 0, 0);
      S.put(c, k + 1, 0, `${name} max ${mx.toFixed(3)}`);
    });
    // profile=x,y0,y1 (sheet fractions): the channels along a vertical line, one value per cell
    let profile = null;
    if (q.get('profile')) {
      const [px, py0, py1] = q.get('profile').split(',').map(Number);
      const gx = Math.round(px * gw);
      profile = {};
      for (const [name, arr, ch] of chans) {
        const row = [];
        for (let gy = Math.round(py0 * gh); gy <= Math.round(py1 * gh); gy++) row.push(+arr[((gh - 1 - gy) * gw + gx) * 4 + ch].toFixed(3));
        profile[name] = row.join(' ');
      }
    }
    window.__report = { k: sim.k, fmt: sim.stateFmt, stats, profile, scissor };
    out = S.c;
  } else if (sheet === 'macro') {
    // renderToTexture({ rect }): the film's close-up of the nib. k = density (the rect is 1/k of
    // the sheet wide, rendered at `size` texels, i.e. as if the sheet were size * k px), at=x,y its
    // centre, upto= drawing progress. Report:
    //   exact     the rect vs the same crop of a full render at size * k (must match to the bit)
    //   interleave full sheet and rect frames alternating while drawing vs fresh renders of each
    //   rectMs    median time of a rect frame that moved (full redraw of the view), and held still
    // Image: the full sheet with the rect outlined | the rect.
    const brush = brushById(q.get('brush') || 'watercolour');
    const paper = paperById(q.get('paper') || (brush.prefersDark ? 'black' : brush.id === 'chalk' ? 'chalkboard' : 'coldpress'));
    const ink = q.get('ink') || (paper.dark ? (brush.inks.find(([h]) => inkMode(brush, h, paper).flip) || brush.inks[0])[0] : brush.inks[0][0]);
    const mode = inkMode(brush, ink, paper);
    const geom = geometryFor(src, { rings, tech, flip: mode.flip, photo: false });
    const k = +(q.get('k') || 8);
    const [cx, cy] = (q.get('at') || '0.45,0.42').split(',').map(Number);
    const rect = [cx - 0.5 / k, cy - 0.5 / k, cx + 0.5 / k, cy + 0.5 / k];
    const f = q.has('upto') ? +q.get('upto') : 1;
    const upTo = f >= 1 ? Infinity : f * (geom.n - 1);
    const setup = (x, S) => {
      x.setSize(S, S); x.setLayout(LAYOUT); x.setPaper(paper, 1);
      x.setStyle({ brush: tune(brush), ink, cover: mode.cover, photoColor: false });
      x.setGeometry(geom, { pacing: q.get('pacing') || 'natural' }); applyPhysics(x);
    };
    const readTex = (x, res) => {
      const gl = x.gl, fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, res.tex, 0);
      const px = new Uint8Array(res.w * res.h * 4);
      gl.readPixels(0, 0, res.w, res.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb);
      return px;                                           // bottom-up
    };
    const diff = (a, b) => { let m = 0, n = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { n++; if (d > m) m = d; } } return { max: m, n }; };
    const toCanvas = (px, w, h) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'), im = g.createImageData(w, h);
      for (let y = 0; y < h; y++) im.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      g.putImageData(im, 0, 0);
      return c;
    };
    const report = { brush: brush.id, paper: paper.id, k, size };
    const r = new Renderer(document.createElement('canvas'));
    setup(r, size);
    r.render(upTo, drawOpts(geom)[1]);
    const res = r.renderToTexture(upTo, { ...drawOpts(geom)[1], rect });
    report.rect = res.rect.map(v => +v.toFixed(5)); report.w = res.w; report.h = res.h;
    const rectPx = readTex(r, res);
    // 1. the same crop of a full render at the rect's density: the asked-for rect, inside the
    // texture (which covers res.rect, a margin larger)
    const Sbig = size * k;
    if (Sbig <= Math.min(r.maxSize, 8192)) {
      const big = new Renderer(document.createElement('canvas'));
      setup(big, Sbig);
      big.render(upTo, drawOpts(geom)[1]);
      const ox = Math.round(res.rect[0] * Sbig), oy = Math.round(res.rect[1] * Sbig);
      const tx = Math.ceil(rect[0] * Sbig) - ox, ty = Math.ceil(rect[1] * Sbig) - oy;
      const tw = Math.floor((rect[2] - rect[0]) * Sbig) - 1, th = Math.floor((rect[3] - rect[1]) * Sbig) - 1;
      const sub = new Uint8Array(tw * th * 4);             // the region of the rect texture, bottom-up
      for (let j = 0; j < th; j++) {
        const srcRow = res.h - 1 - (ty + th - 1 - j);
        sub.set(rectPx.subarray((srcRow * res.w + tx) * 4, (srcRow * res.w + tx + tw) * 4), j * tw * 4);
      }
      const gl = big.gl, px = new Uint8Array(tw * th * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(ox + tx, Sbig - (oy + ty) - th, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, px);
      report.exact = { ...diff(sub, px), region: [tx, ty, tw, th] };
      big.destroy();
    }
    // 2. interleaved full + rect frames while drawing, vs fresh renders of the last one
    const r2 = new Renderer(document.createElement('canvas'));
    setup(r2, size);
    const fr = [0.2, 0.35, 0.5, 0.65];
    for (const x of fr) { r2.renderToTexture(x * (geom.n - 1), { settle: 0 }); r2.renderToTexture(x * (geom.n - 1), { settle: 0, rect }); }
    const last = fr[fr.length - 1] * (geom.n - 1);
    const a1 = readTex(r2, r2.renderToTexture(last, { settle: 0 })), b1 = readTex(r2, r2.renderToTexture(last, { settle: 0, rect }));
    const r3 = new Renderer(document.createElement('canvas')); setup(r3, size);
    const a2 = readTex(r3, r3.renderToTexture(last, { settle: 0 }));
    const r4 = new Renderer(document.createElement('canvas')); setup(r4, size);
    const b2 = readTex(r4, r4.renderToTexture(last, { settle: 0, rect }));
    report.interleave = { full: diff(a1, a2), rect: diff(b1, b2) };
    // 3. timing: a rect that moves every frame (full redraw of the view) vs one that holds still
    const gl2 = r2.gl, one = new Uint8Array(4), sync = () => gl2.readPixels(0, 0, 1, 1, gl2.RGBA, gl2.UNSIGNED_BYTE, one);
    const moving = [], still = [];
    for (let i = 0; i < 12; i++) {
      const fi = (0.66 + i * 0.01) * (geom.n - 1), dx = i * 0.3 / (size * k);
      sync(); let t = performance.now();
      r2.renderToTexture(fi, { settle: 0, rect: [rect[0] + dx, rect[1], rect[2] + dx, rect[3]] }); sync();
      moving.push(performance.now() - t);
    }
    const hold = [rect[0] + 0.01, rect[1], rect[2] + 0.01, rect[3]];
    r2.renderToTexture(0.8 * (geom.n - 1), { settle: 0, rect: hold });
    for (let i = 1; i <= 12; i++) {
      sync(); const t = performance.now();
      r2.renderToTexture((0.8 + i * 0.002) * (geom.n - 1), { settle: 0, rect: hold }); sync();
      still.push(performance.now() - t);
    }
    const med = a => +a.sort((x, y) => x - y)[a.length >> 1].toFixed(2);
    report.rectMs = { moving: med(moving), still: med(still) };
    for (const x of [r2, r3, r4]) x.destroy();
    window.__report = report;
    window.__ok = (!report.exact || report.exact.max === 0) && report.interleave.full.max === 0 && report.interleave.rect.max === 0;
    // image: the sheet with the rect outlined | the rect
    const S = sheetCanvas(2, 1, size);
    const full = copyCanvas(r.canvas), g = full.getContext('2d');
    g.strokeStyle = '#e0301e'; g.lineWidth = 2;
    g.strokeRect(res.rect[0] * size, res.rect[1] * size, (res.rect[2] - res.rect[0]) * size, (res.rect[3] - res.rect[1]) * size);
    S.put(full, 0, 0, `${brush.name} · ${paper.name}`);
    S.put(toCanvas(rectPx, res.w, res.h), 1, 0, `rect x${k} (${res.w}x${res.h})`);
    r.destroy();
    out = S.c;
  } else if (sheet === 'headviz') {
    // A 3-segment zig-zag drawn to fractional indices (at=...): the head must stop exactly at the
    // interpolated point, with a round end, at every fraction.
    const brush = brushById(q.get('brush') || 'fineliner'), paper = paperById(q.get('paper') || 'cream');
    const pts = [[-0.8, -0.5], [-0.2, 0.5], [0.3, -0.5], [0.8, 0.4]];
    let s0 = 0;
    const data = new Float32Array(pts.length * 7);
    pts.forEach(([x, y], i) => {
      if (i) s0 += Math.hypot(x - pts[i - 1][0], y - pts[i - 1][1]);
      data.set([x, y, 0.05 + 0.03 * i, s0, 0.8, i, 1], i * 7);
    });
    const geom = { n: pts.length, data, colors: null, rings: 1, spacing: 0.1, length: s0, turns: 1, technique: 'thickness', path: 'spiral', _pace: new Map() };
    const ats = (q.get('at') || '0.25,0.5,0.99,1.5,2.75,3').split(',').map(Number);
    const S = sheetCanvas(ats.length, 1, size);
    const r = renderer || (renderer = new Renderer(document.createElement('canvas')));
    r.setSize(size, size); r.setLayout(LAYOUT); r.setPaper(paper, 1);
    r.setStyle({ brush, ink: brush.inks[0][0], cover: false, photoColor: false }); r.setGeometry(geom); r.setLight();
    ats.forEach((a, c) => { r.render(a); S.put(copyCanvas(r.canvas), c, 0, `upTo ${a}`); });
    out = S.c;
  } else if (sheet === 'head') {
    // Smooth head: drawing incrementally with fractional heads must end on exactly the image of a
    // fresh render(Infinity), and every frame must equal a fresh render of that frame.
    const report = [];
    const paper = paperById(q.get('paper') || 'cream');
    const frames = +(q.get('frames') || 60);
    const r = new Renderer(document.createElement('canvas'));
    const fresh = new Renderer(document.createElement('canvas'));
    const read = x => { const g = x.gl, px = new Uint8Array(size * size * 4); g.readPixels(0, 0, size, size, g.RGBA, g.UNSIGNED_BYTE, px); return px; };
    const diff = (a, b) => { let m = 0, c = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; if (d > 2) c++; } return { max: m, over2: c }; };
    for (const brush of brushes) {
      const ink = brush.prefersDark && !paper.dark ? brush.inks[0][0] : brush.inks[0][0];
      const mode = inkMode(brush, ink, paper);
      const geom = geometryFor(src, { rings, tech, flip: mode.flip, photo: false });
      // simclock=1: a film-like clock (the first 2% of the line gets a fifth of the simulation's
      // time, as the film's macro opening does), which must keep incremental == fresh too
      const clock = q.get('simclock') ? { at: [0, 0.02 * (geom.n - 1), geom.n - 1], v: [0, 0.2, 1], mix: 1 } : null;
      for (const x of [r, fresh]) {
        x.setSize(size, size); x.setLayout(LAYOUT); x.setPaper(paper, 1);
        x.setStyle({ brush, ink, cover: mode.cover, photoColor: false }); x.setGeometry(geom); x.setLight();
        x.setSimClock(clock);
      }
      let worstMid = { max: 0, over2: 0 };
      for (let i = 1; i <= frames; i++) {
        const fi = (geom.n - 1) * (i / (frames + 1)) + 0.37;
        r.render(fi);
        if (i === Math.round(frames / 2)) { fresh.render(fi); worstMid = diff(read(r), read(fresh)); }
      }
      r.render(Infinity); fresh.render(Infinity);
      report.push({ brush: brush.id, mid: worstMid, end: diff(read(r), read(fresh)) });
    }
    window.__report = report;
    window.__ok = report.every(x => x.mid.max === 0 && x.end.max === 0);     // incremental == fresh, to the bit
    out = r.canvas;
  } else if (sheet === 'timing') {
    // GPU timings (synced with a pixel read), per brush, on the lab geometry at `size`:
    //   stillMs  full still from scratch (sheet pass + injection map + all wet steps + composite)
    //   paperMs  the same with the geometry cached but the pigment redrawn (dry path)
    //   scrubMs  back to the start after a finished still, then one frame (a replay starting)
    //   stepMs   one wet-simulation step (full grid, averaged over the whole schedule)
    //   filmMed / filmAvg / filmMax  incremental renderToTexture frames across the drawing (fsize, frames)
    //   macroAvg / macroMax  the nib's rect (1/8 of the sheet at 1024 texels) following the pen each frame
    const report = [];
    const paper0 = q.get('paper');
    const reps = +(q.get('reps') || 5);
    const fsize = +(q.get('fsize') || 2048), frames = +(q.get('frames') || 240);
    const r = new Renderer(document.createElement('canvas'));
    const gl = r.gl, px = new Uint8Array(4);
    // (read from the canvas: a sim step leaves its float target bound, which RGBA/UNSIGNED_BYTE cannot read)
    const sync = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
    for (const brush of brushes) {
      const paper = paperById(paper0 || (brush.prefersDark ? 'black' : brush.id === 'watercolour' ? 'coldpress' : 'cream'));
      const ink = brush.inks[0][0];
      const mode = inkMode(brush, ink, paper);
      const geom = geometryFor(src, { rings, tech, flip: mode.flip, photo: false });
      r.setSize(size, size); r.setLayout(LAYOUT); r.setPaper(paper, 1);
      r.setStyle({ brush, ink, cover: mode.cover, photoColor: false }); r.setGeometry(geom); r.setLight();
      const still = [], dry = [];
      for (let i = 0; i <= reps; i++) {
        r.dirty = true; r.simDirty = true;
        sync();
        let t = performance.now();
        r.render(Infinity); sync();
        if (i) still.push(performance.now() - t);
        r.dirty = true;
        t = performance.now();
        r.render(Infinity); sync();
        if (i) dry.push(performance.now() - t);
      }
      const med = a => +a.sort((x, y) => x - y)[a.length >> 1].toFixed(2);
      // scrubbing back to the start after a finished still (playback restarting), then one frame on
      const scrub = [];
      for (let i = 0; i < reps; i++) {
        r.render(Infinity); sync();
        let t = performance.now(); r.render(0); sync(); const a = performance.now() - t;
        t = performance.now(); r.render(0.01 * (geom.n - 1)); sync();
        scrub.push(Math.max(a, performance.now() - t));
      }
      // one wet step on the full grid (the whole schedule from a reset, averaged)
      let stepMs = null;
      if (r.sim && brush.wetness > 0) {
        const st = [];
        for (let i = 0; i < 3; i++) {
          r.sim.reset(); sync();
          const t = performance.now(); r._simAdvance(300); sync();
          st.push((performance.now() - t) / 300);
        }
        stepMs = med(st);
      }
      // film: incremental frames at the film sheet size
      r.setSize(fsize, fsize);
      r.render(0); sync();
      let max = 0, sum = 0, rsum = 0, rmax = 0;
      const film = [];
      const steps0 = r.stats.wetSteps;
      const { headAt } = await import('../js/spiral.js');
      for (let i = 1; i <= frames; i++) {
        const fi = (geom.n - 1) * i / frames * 0.999;
        let t = performance.now();
        r.setTime(i / 60);
        r.renderToTexture(i === frames ? Infinity : fi, { settle: 0 }); sync();
        const dt = performance.now() - t;
        max = Math.max(max, dt); sum += dt; film.push(dt);
        // the macro close-up of the nib (1/8 of the sheet at 1024 texels), following the pen
        const h = headAt(geom, Math.min(geom.n - 1, fi));
        const hx = LAYOUT.cx + h.x * LAYOUT.r, hy = LAYOUT.cy + h.y * LAYOUT.r;
        t = performance.now();
        r.renderToTexture(i === frames ? Infinity : fi, { settle: 0, rect: [hx - 1 / 16, hy - 1 / 16, hx + 1 / 16, hy + 1 / 16], size: 1024 }); sync();
        const rt = performance.now() - t;
        rsum += rt; rmax = Math.max(rmax, rt);
      }
      r.releaseRect();
      report.push({ brush: brush.id, paper: paper.id, segments: geom.n - 1, stillMs: med(still), redrawMs: med(dry),
        scrubMs: med(scrub), stepMs, filmMed: med(film), filmAvg: +(sum / frames).toFixed(2), filmMax: +max.toFixed(1),
        macroAvg: +(rsum / frames).toFixed(2), macroMax: +rmax.toFixed(1), wetSteps: r.stats.wetSteps - steps0, sim: r.sim?.stateFmt || '-' });
      r.setTime(null);
    }
    window.__report = report;
    out = document.createElement('canvas'); out.width = out.height = 8;
  } else {
    // single large render (optionally a crop, for 1:1 inspection of big exports)
    const brush = brushById(q.get('brush') || 'fineliner'), paper = paperById(q.get('paper') || 'cream');
    const photo = q.get('photo') === '1';
    const ink = q.get('ink') || brush.inks[0][0];
    const mode = inkMode(brush, ink, paper, photo);
    const geom = geometryFor(src, { rings, tech, flip: mode.flip, photo });
    out = draw({ size, brush, paper, ink, geom, cover: mode.cover, photo });
    const crop = q.get('crop');   // x,y,w as fractions of the paper
    if (crop) {
      const [cx, cy, cw] = crop.split(',').map(Number);
      const c = document.createElement('canvas');
      c.width = c.height = Math.round(cw * size);
      c.getContext('2d').drawImage(out, -cx * size, -cy * size);
      out = c;
    }
  }
  const ms = performance.now() - t0;
  const res = await save(out, q.get('shot') || `lab_${sheet}`, q.get('jpg') ? 'image/jpeg' : 'image/png');
  window.__done = { ms, report: window.__report, ...res, ok: window.__ok !== false };   // (res carries the save's own ok)
  document.body.append(out);
  out.style.maxWidth = '100%';
}

run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
