// Brush lab: measurement + contact sheets for tuning the drawing media (js/brushes.js).
//   node tests/shoot.mjs "/dev/brush_lab.html?mode=cons;size=256;paper=cream"
// Open through dev/brush_lab.html. Tuning without disturbing others: cp js/brushes.js
// dev/brush_wip.js, edit that, and add wip=1 (an import map swaps the module); shaders=fix swaps
// in dev/brush_shaders_fix.js (proposed engine fix); tool=lab runs dev/lab.js with the same maps.
//   mode=cons     preview vs export: every brush at `size` and at k x size, box-downsampled; reports
//                 the lab metrics (full image) AND the ink-only part (render minus blank paper), so
//                 paper-surface drift is separated from brush drift.
//   mode=ladder   synthetic tone ladder: horizontal rows, 11 pressure steps left -> right, at
//                 `size` (and k x size box-downsampled). Reports contrast per step: monotonicity,
//                 plateaus and per-step consistency. wmode=thick (width follows tone) | pen (fixed).
//   mode=ramp     the real pipeline on the ramp image: luminance profile across the disc.
//   mode=detail   one card per brush: disc | 1:1 preview crop | two 1:1 crops of a big=4096 (or
//                 8192...) sheet, rendered as strips like the exporter | chips. at=, at2= crop centres.
//   mode=appchips the app's tool chips (corner close-up, 140 x 104 px), zoom= for inspection.
//   mode=perf     median full-redraw time per brush at `size`.
//   mode=sheet    every brush on its natural paper (or paper=<id>), full discs.
// Common: brushes=a,b  paper=nat|<id>  ink=<hex>  size  rings  tech=thickness|wave
//         img=portrait|ramp|sample:<id>  jpg=1  shot=name (use a brush_ prefix)
import { Renderer } from '../js/renderer.js';
import { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS } from '../js/tone.js';
import { buildSpiral, LINE_DEFAULTS, previewStroke, STRIDE } from '../js/spiral.js';
import { BRUSHES, brushById, paperById, inkMode } from '../js/materials.js';

const q = new URLSearchParams(location.search);
const LAYOUT = { cx: 0.5, cy: 0.5, r: 0.42 };
const NATURAL = {
  pencil: 'sketch', fineliner: 'cream', fountain: 'cream', crayon: 'sketch', ballpoint: 'cream',
  marker: 'sketch', brush: 'coldpress', charcoal: 'coldpress', chalk: 'chalkboard', neon: 'black', gold: 'black',
};

// ------------------------------------------------------------------ images
function testImage(kind = 'portrait', S = 1024) {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const u = S / 100;
  if (kind === 'ramp') {
    const grd = g.createLinearGradient(0, 0, S, 0);
    grd.addColorStop(0, '#000'); grd.addColorStop(1, '#fff');
    g.fillStyle = grd; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 10; i++) { g.fillStyle = i % 2 ? '#000' : '#fff'; g.fillRect(i * 10 * u, 80 * u, 10 * u, 20 * u); }
    return c;
  }
  const bg = g.createLinearGradient(0, 0, 0, S);
  bg.addColorStop(0, '#c9ced6'); bg.addColorStop(1, '#8d939c');
  g.fillStyle = bg; g.fillRect(0, 0, S, S);
  g.fillStyle = '#2b2f3a';
  g.beginPath(); g.ellipse(50 * u, 108 * u, 46 * u, 30 * u, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#b98a6e'; g.fillRect(42 * u, 62 * u, 16 * u, 18 * u);
  g.fillStyle = '#231a14';
  g.beginPath(); g.ellipse(50 * u, 40 * u, 27 * u, 31 * u, 0, 0, Math.PI * 2); g.fill();
  const face = g.createRadialGradient(42 * u, 40 * u, 4 * u, 50 * u, 46 * u, 30 * u);
  face.addColorStop(0, '#f1cfb4'); face.addColorStop(0.6, '#d7a988'); face.addColorStop(1, '#8f624a');
  g.fillStyle = face;
  g.beginPath(); g.ellipse(50 * u, 47 * u, 20 * u, 26 * u, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#231a14';
  g.beginPath(); g.ellipse(46 * u, 25 * u, 22 * u, 10 * u, -0.3, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#3a271c'; g.lineWidth = 1.6 * u; g.lineCap = 'round';
  for (const s of [-1, 1]) {
    g.beginPath(); g.moveTo((50 + s * 4) * u, 38 * u); g.quadraticCurveTo((50 + s * 9) * u, 35.5 * u, (50 + s * 14) * u, 38 * u); g.stroke();
    g.fillStyle = '#fbf6f1'; g.beginPath(); g.ellipse((50 + s * 9) * u, 43 * u, 4.2 * u, 2.1 * u, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#3d2a1f'; g.beginPath(); g.arc((50 + s * 9) * u, 43 * u, 1.9 * u, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#000'; g.beginPath(); g.arc((50 + s * 9) * u, 43 * u, 0.9 * u, 0, Math.PI * 2); g.fill();
  }
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

// ------------------------------------------------------------------ geometry
const geomCache = new Map();
function geometryFor(src, { rings, tech, flip, line = {} }) {
  const key = [rings, tech, flip, JSON.stringify(line)].join('|');
  if (geomCache.has(key)) return geomCache.get(key);
  const raster = rasterize(src, CROP_DEFAULTS);
  const tone = processTone(raster, TONE_DEFAULTS, { flip });
  const field = buildField(raster, tone.L, { rings, flip });
  const g = buildSpiral(field, { ...LINE_DEFAULTS, technique: tech, rings, ...line }, {});
  geomCache.set(key, g);
  return g;
}

// Serpentine of horizontal rows; pressure steps 0..1 in STEPS bands from left to right.
export const STEPS = 11;
export const LADDER_X = 0.92;
function ladderGeometry({ rows = 64, wmode = 'thick' } = {}) {
  const d = 1 / rows;                         // row spacing, like the ring spacing at `rows` rings
  const pts = [];
  let s = 0, px = 0, py = 0, first = true;
  const push = (x, y, w, t, turn) => {
    if (!first) s += Math.hypot(x - px, y - py);
    first = false;
    pts.push(x, y, w, s, t, turn, 1);   // one record per point: STRIDE (7) floats, dwell last
    px = x; py = y;
  };
  const width = t => (wmode === 'pen' ? d * 0.18 : d * (0.08 + 0.8 * t));
  const toneAt = x => Math.min(STEPS - 1, Math.floor((x + LADDER_X) / (2 * LADDER_X) * STEPS)) / (STEPS - 1);
  let j = 0;
  for (let y = -0.9; y <= 0.9 + 1e-9; y += d, j++) {
    const dir = j % 2 ? -1 : 1;
    for (let i = 0; i <= 600; i++) {
      const x = dir * (-LADDER_X + (2 * LADDER_X) * i / 600);
      const t = toneAt(Math.max(-LADDER_X, Math.min(LADDER_X - 1e-6, x)));
      push(x, y, width(t), t, j);
    }
  }
  const data = new Float32Array(pts);
  const n = data.length / STRIDE;
  return { n, data, colors: null, rings: rows, spacing: d, length: s, turns: j, technique: 'thickness', _pace: new Map() };
}

// ------------------------------------------------------------------ rendering
let renderer;
function draw({ size, brush, paper, ink, geom, cover, blank = false, seed = 1 }) {
  if (!renderer) renderer = new Renderer(document.createElement('canvas'));
  renderer.setSize(size, size);
  renderer.setLayout(LAYOUT);
  renderer.setPaper(paper, seed);
  renderer.setStyle({ brush, ink, cover, photoColor: false });
  renderer.setGeometry(geom);
  if (blank) renderer.renderBlank();
  else renderer.render(Infinity);
  return copyCanvas(renderer.canvas);
}

// A w x w window at (x, y) of a big x big sheet (strip rendering: setPaperSize + setOrigin).
let winRenderer;
function drawWindow({ big, x, y, w, brush, paper, ink, geom, cover, seed = 1 }) {
  if (!winRenderer) winRenderer = new Renderer(document.createElement('canvas'));
  const r = winRenderer;
  r.setPaperSize(big, big);
  r.setSize(w, w);
  r.setOrigin(x, y);
  r.setLayout(LAYOUT);
  r.setPaper(paper, seed);
  r.setStyle({ brush, ink, cover, photoColor: false });
  r.setGeometry(geom);
  r.render(Infinity);
  return copyCanvas(r.canvas);
}

function copyCanvas(src, w = src.width, h = src.height, sx = 0, sy = 0, sw = src.width, sh = src.height) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  return c;
}

function lumArray(c) {
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  const L = new Float32Array(c.width * c.height);
  for (let i = 0; i < L.length; i++) L[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
  return L;
}

// exact k x k box downsample
function boxDown(src, k) {
  const w = src.width, h = src.height;
  const d = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const W = w / k, H = h / k;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const cx = c.getContext('2d', { willReadFrequently: true });
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

// Block statistics identical to dev/lab.js lumDiff (8x8 block means), on luminance arrays.
function blockStats(La, Lb, w, h, B = 8) {
  const diffs = [];
  let sumA = 0, sumB = 0;
  for (let y = 0; y + B <= h; y += B) for (let x = 0; x + B <= w; x += B) {
    let sa = 0, sb = 0;
    for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) {
      const o = (y + j) * w + x + i;
      sa += La[o]; sb += Lb[o];
    }
    sa /= B * B; sb /= B * B; sumA += sa; sumB += sb;
    diffs.push(Math.abs(sa - sb));
  }
  diffs.sort((p, r) => p - r);
  const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  return { dl: +mean.toFixed(2), p99: +diffs[Math.floor(diffs.length * 0.99)].toFixed(2),
    small: +(sumA / diffs.length).toFixed(1), big: +(sumB / diffs.length).toFixed(1) };
}

function sub(a, b) { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] - b[i]; return o; }

function inkFor(brush, paper) {
  if (q.get('ink')) return q.get('ink');
  if (paper.dark) return (brush.inks.find(([h]) => inkMode(brush, h, paper).flip) || brush.inks[0])[0];
  return brush.inks[0][0];
}
function paperFor(brush) {
  const p = q.get('paper') || 'nat';
  return paperById(p === 'nat' ? NATURAL[brush.id] : p);
}

function sheetCanvas(cols, rows, cellW, cellH = cellW, label = 18) {
  const c = document.createElement('canvas');
  c.width = cols * cellW; c.height = rows * (cellH + label);
  const g = c.getContext('2d');
  g.fillStyle = '#d9d5ce'; g.fillRect(0, 0, c.width, c.height);
  return { c, g, put(img, col, row, text, w = cellW, h = cellH) {
    g.drawImage(img, col * cellW, row * (cellH + label), w, h);
    if (text) { g.fillStyle = '#222'; g.font = '12px system-ui'; g.fillText(text, col * cellW + 6, row * (cellH + label) + cellH + 13); }
  } };
}

async function save(canvas, name, type = 'image/png') {
  const data = canvas.toDataURL(type, 0.92);
  const r = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data }) });
  return r.json();
}

// ------------------------------------------------------------------ modes
async function run() {
  const mode = q.get('mode') || 'cons';
  const size = +(q.get('size') || (mode === 'cons' ? 256 : 900));
  const k = +(q.get('k') || 4);
  const rings = +(q.get('rings') || 64);
  const tech = q.get('tech') || 'thickness';
  const brushes = (q.get('brushes') || BRUSHES.map(b => b.id).join(',')).split(',').map(brushById);
  const t0 = performance.now();
  let out, report;

  if (mode === 'cons') {
    const src = await loadImage(q.get('img') || 'portrait');
    const S = sheetCanvas(3, brushes.length, size);
    report = [];
    for (const [r, brush] of brushes.entries()) {
      const paper = paperFor(brush), ink = inkFor(brush, paper), mode2 = inkMode(brush, ink, paper);
      const geom = geometryFor(src, { rings, tech, flip: mode2.flip });
      const args = { brush, paper, ink, geom, cover: mode2.cover };
      const a = draw({ size, ...args });
      const b = boxDown(draw({ size: size * k, ...args }), k);
      const a0 = draw({ size, ...args, blank: true });
      const b0 = boxDown(draw({ size: size * k, ...args, blank: true }), k);
      const La = lumArray(a), Lb = lumArray(b), La0 = lumArray(a0), Lb0 = lumArray(b0);
      const full = blockStats(La, Lb, size, size);
      const ink2 = blockStats(sub(La, La0), sub(Lb, Lb0), size, size);
      report.push({ brush: brush.id, paper: paper.id, meanBlockDL: full.dl, lumSmall: full.small, lumBig: full.big,
        inkDL: ink2.dl, inkP99: ink2.p99, inkSmall: ink2.small, inkBig: ink2.big });
      // third column: signed ink difference, grey = equal, dark = small render has more ink
      const dc = document.createElement('canvas'); dc.width = dc.height = size;
      const dg = dc.getContext('2d'); const id = dg.createImageData(size, size);
      for (let i = 0; i < La.length; i++) {
        const v = 128 + 4 * ((La[i] - La0[i]) - (Lb[i] - Lb0[i]));
        id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = Math.max(0, Math.min(255, v)); id.data[i * 4 + 3] = 255;
      }
      dg.putImageData(id, 0, 0);
      S.put(a, 0, r, `${brush.id} @${size}`); S.put(b, 1, r, `@${size * k} down`); S.put(dc, 2, r, 'ink diff x4');
    }
    out = S.c;
  } else if (mode === 'ladder') {
    // Pressure ladder: contrast vs tone per brush, preview size and k x size downsampled.
    const wmode = q.get('wmode') || 'thick';
    const geom = ladderGeometry({ rows: rings, wmode });
    const S = sheetCanvas(2, brushes.length, size, Math.round(size * 0.5));
    report = [];
    for (const [r, brush] of brushes.entries()) {
      const paper = paperFor(brush), ink = inkFor(brush, paper), m = inkMode(brush, ink, paper);
      const args = { brush, paper, ink, geom, cover: m.cover };
      const a = draw({ size, ...args }), a0 = draw({ size, ...args, blank: true });
      let b = null, b0 = null;
      if (k > 1) { b = boxDown(draw({ size: size * k, ...args }), k); b0 = boxDown(draw({ size: size * k, ...args, blank: true }), k); }
      const prof = (img, blank) => {
        const L = lumArray(img), L0 = lumArray(blank), vals = [];
        const y0 = Math.round(size * (0.5 - 0.3 * 0.42 * 2)), y1 = Math.round(size * (0.5 + 0.3 * 0.42 * 2));
        for (let st = 0; st < STEPS; st++) {
          // inner 60% of each band (away from step transitions)
          const xa = -LADDER_X + 2 * LADDER_X * (st + 0.2) / STEPS, xb = -LADDER_X + 2 * LADDER_X * (st + 0.8) / STEPS;
          const px0 = Math.round(size * (0.5 + xa * 0.42)), px1 = Math.round(size * (0.5 + xb * 0.42));
          let s = 0, s0 = 0, n = 0;
          for (let y = y0; y < y1; y++) for (let x = px0; x < px1; x++) { s += L[y * size + x]; s0 += L0[y * size + x]; n++; }
          vals.push(+((s - s0) / n).toFixed(2));
        }
        return vals;
      };
      const pa = prof(a, a0), pb = b ? prof(b, b0) : null;
      const c = pa.map(Math.abs);
      const steps = c.slice(1).map((v, i) => +(v - c[i]).toFixed(2));
      const range = c[STEPS - 1] - c[0];
      report.push({ brush: brush.id, paper: paper.id, contrast: c.map(v => +v.toFixed(1)),
        minStep: Math.min(...steps.slice(1)), inversions: steps.filter(v => v < 0).length, range: +range.toFixed(1),
        consDelta: pb ? +Math.max(...pa.map((v, i) => Math.abs(v - pb[i]))).toFixed(2) : null,
        consMean: pb ? +(pa.reduce((s, v, i) => s + (v - pb[i]), 0) / STEPS).toFixed(2) : null,
        diff: pb ? pa.map((v, i) => +(v - pb[i]).toFixed(1)) : null });
      const h = Math.round(size * 0.5), y0 = Math.round((size - h) / 2);
      S.put(copyCanvas(a, size, h, 0, y0, size, h), 0, r, `${brush.id} @${size}`, size, h);
      if (b) S.put(copyCanvas(b, size, h, 0, y0, size, h), 1, r, `@${size * k} down`, size, h);
    }
    out = S.c;
  } else if (mode === 'ramp') {
    const src = testImage('ramp');
    const cols = +(q.get('cols') || 20);
    const S = sheetCanvas(4, Math.ceil(brushes.length / 4), size);
    report = [];
    for (const [i, brush] of brushes.entries()) {
      const paper = paperFor(brush), ink = inkFor(brush, paper), m = inkMode(brush, ink, paper);
      const geom = geometryFor(src, { rings, tech, flip: m.flip });
      const a = draw({ size, brush, paper, ink, geom, cover: m.cover });
      const L = lumArray(a);
      const vals = [];
      const y0 = Math.round(size * 0.36), y1 = Math.round(size * 0.58);
      for (let cI = 0; cI < cols; cI++) {
        const x0 = Math.round(size * (0.15 + 0.7 * cI / cols)), x1 = Math.round(size * (0.15 + 0.7 * (cI + 1) / cols));
        let s = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += L[y * size + x]; n++; }
        vals.push(+(s / n).toFixed(1));
      }
      const steps = vals.slice(1).map((v, j) => +(v - vals[j]).toFixed(2));
      report.push({ brush: brush.id, paper: paper.id, lum: vals, inversions: steps.filter(v => v < -0.5).length,
        minStep: Math.min(...steps), range: +(vals[cols - 1] - vals[0]).toFixed(1) });
      S.put(a, i % 4, Math.floor(i / 4), `${brush.id} · ${paper.id}`);
    }
    out = S.c;
  } else if (mode === 'detail') {
    // One row per brush: disc (downscaled) | preview 1:1 crop | 4K 1:1 crop of the crop centre | chips
    const src = await loadImage(q.get('img') || 'portrait');
    const big = +(q.get('big') || 4096);
    const cell = +(q.get('cell') || 320);
    const [cx, cy] = (q.get('at') || '0.40,0.36').split(',').map(Number);     // dark-ish: hair / face edge
    const [cx2, cy2] = (q.get('at2') || '0.40,0.56').split(',').map(Number);  // mid-tone: cheek
    const S = sheetCanvas(5, brushes.length, cell);
    for (const [r, brush] of brushes.entries()) {
      const paper = paperFor(brush), ink = inkFor(brush, paper), m = inkMode(brush, ink, paper);
      const geom = geometryFor(src, { rings, tech, flip: m.flip });
      const args = { brush, paper, ink, geom, cover: m.cover };
      const a = draw({ size, ...args });
      S.put(a, 0, r, `${brush.id} · ${paper.id} · ${ink}`);
      S.put(copyCanvas(a, cell, cell, Math.round(cx * size - cell / 2), Math.round(cy * size - cell / 2), cell, cell), 1, r, `1:1 @${size}`);
      // 1:1 windows of the big sheet, rendered as strips of it exactly like the exporter does
      S.put(drawWindow({ big, x: Math.round(cx * big - cell / 2), y: Math.round(cy * big - cell / 2), w: cell, ...args }), 2, r, `1:1 @${big} A`);
      S.put(drawWindow({ big, x: Math.round(cx2 * big - cell / 2), y: Math.round(cy2 * big - cell / 2), w: cell, ...args }), 3, r, `1:1 @${big} B`);
      for (const [j, technique] of ['thickness', 'wave'].entries()) {
        const p = brush.prefersDark ? paperById('black') : paperById(q.get('chipPaper') || 'sketch');
        const ci = brush.inks[0][0], cm = inkMode(brush, ci, p);
        const chip = draw({ size: 160, brush, paper: p, ink: ci, geom: previewStroke({ technique }), cover: cm.cover });
        S.g.drawImage(chip, 4 * cell, r * (cell + 18) + j * 160, 160, 160);
      }
    }
    out = S.c;
  } else if (mode === 'perf') {
    // GPU time of a full redraw per brush at `size` (median of `reps`, synced with a pixel read).
    const src = await loadImage(q.get('img') || 'portrait');
    const reps = +(q.get('reps') || 5);
    report = [];
    const r = new Renderer(document.createElement('canvas'));
    const gl = r.gl, px = new Uint8Array(4);
    for (const brush of brushes) {
      const paper = paperFor(brush), ink = inkFor(brush, paper), m = inkMode(brush, ink, paper);
      const geom = geometryFor(src, { rings, tech, flip: m.flip });
      r.setSize(size, size); r.setLayout(LAYOUT); r.setPaper(paper, 1);
      r.setStyle({ brush, ink, cover: m.cover, photoColor: false }); r.setGeometry(geom);
      const times = [];
      for (let i = 0; i <= reps; i++) {
        r.dirty = true;
        const t = performance.now();
        r.render(Infinity);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        if (i) times.push(performance.now() - t);   // first run warms up shaders
      }
      times.sort((x, y) => x - y);
      report.push({ brush: brush.id, ms: +times[times.length >> 1].toFixed(1), segments: geom.n - 1 });
    }
    out = document.createElement('canvas'); out.width = out.height = 8;
  } else if (mode === 'appchips') {
    // The app's tool chips (js/app.js): a close-up of the outer rings sweeping in from a corner,
    // 70 x 52 CSS px at dpr 2, on the current sheet or a dark board for light media.
    const w = +(q.get('w') || 140), h = +(q.get('h') || 104), scale = +(q.get('zoom') || 2);
    const papers = (q.get('papers') || 'sketch,cream,kraft,black').split(',').map(paperById);
    const S = sheetCanvas(brushes.length, papers.length * 2, w * scale, h * scale, 14);
    const r = new Renderer(document.createElement('canvas'));
    papers.forEach((p0, pi) => ['thickness', 'wave'].forEach((technique, ti) => brushes.forEach((brush, c) => {
      const pap = brush.prefersDark && !p0.dark ? paperById(brush.id === 'chalk' ? 'chalkboard' : 'black') : p0;
      const ink = pap.dark ? (brush.inks.find(([hx]) => inkMode(brush, hx, pap).flip) || brush.inks[0])[0] : brush.inks[0][0];
      const m = inkMode(brush, ink, pap);
      r.setSize(w, h);
      r.setLayout({ cx: -0.05, cy: 1.08 * h / w, r: 1.12 });
      r.setPaper(pap, 1);
      r.setStyle({ brush, ink, cover: m.cover, photoColor: false });
      r.setGeometry(previewStroke({ technique }));
      r.render(Infinity);
      const big = document.createElement('canvas'); big.width = w * scale; big.height = h * scale;
      const bg = big.getContext('2d'); bg.imageSmoothingEnabled = false; bg.drawImage(r.canvas, 0, 0, w * scale, h * scale);
      S.put(big, c, pi * 2 + ti, `${brush.name} ${pap.id}`, w * scale, h * scale);
    })));
    out = S.c;
  } else {
    // sheet: every brush on its paper
    const src = await loadImage(q.get('img') || 'portrait');
    const cols = +(q.get('cols') || 4);
    const S = sheetCanvas(cols, Math.ceil(brushes.length / cols), size);
    for (const [i, brush] of brushes.entries()) {
      const paper = paperFor(brush), ink = inkFor(brush, paper), m = inkMode(brush, ink, paper);
      const geom = geometryFor(src, { rings, tech, flip: m.flip });
      S.put(draw({ size, brush, paper, ink, geom, cover: m.cover }), i % cols, Math.floor(i / cols), `${brush.name} · ${paper.name} · ${ink}`);
    }
    out = S.c;
  }
  const ms = performance.now() - t0;
  const res = await save(out, q.get('shot') || `brush_${mode}`, q.get('jpg') ? 'image/jpeg' : 'image/png');
  window.__done = { ok: true, ms: Math.round(ms), report, ...res };
}

run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
