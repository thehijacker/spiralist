// Dev lab: renders contact sheets of the engine and saves them through the dev server.
//   /dev/lab.html?sheet=matrix&img=portrait&size=420&tech=thickness&rings=64
//   sheet = matrix (brushes x papers) | brushes | papers | looks | previews | consistency | single
//   img = portrait | ramp | sample:<id> | <url>;  blank=1 renders paper only;  jpg=1 saves JPEG
//   single: brush, paper, ink, photo=1, crop=x,y,w (fractions, for 1:1 inspection of big sizes)
// Sets window.__done = { ok, file } when the shot is saved (for tests/shoot.mjs).
import { Renderer } from '../js/renderer.js';
import { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS } from '../js/tone.js';
import { buildSpiral, LINE_DEFAULTS, previewStroke } from '../js/spiral.js';
import { buildMaze } from '../js/maze.js';
import { buildWander, buildContour } from '../js/freeline.js';
import { BRUSHES, PAPERS, LOOKS, brushById, paperById, inkMode } from '../js/materials.js';

const q = new URLSearchParams(location.search);
const LAYOUT = { cx: 0.5, cy: 0.5, r: 0.42 };

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

// ------------------------------------------------------------------ helpers
const geomCache = new Map();
function geometryFor(src, { rings, tech, flip, photo, line = {} }) {
  const key = [rings, tech, flip, photo, JSON.stringify(line), location.search].join('|');
  if (geomCache.has(key)) return geomCache.get(key);
  const raster = rasterize(src, CROP_DEFAULTS);
  const tone = processTone(raster, TONE_DEFAULTS, { flip });
  const field = buildField(raster, tone.L, { rings, flip });
  const free = { shape: q.get('shape') || 'square', x: +(q.get('sx') || 0), y: +(q.get('sy') || 0), seed: +(q.get('seed') || 1) };
  if (q.get('path') === 'wander' || q.get('path') === 'contour') {
    const g2 = (q.get('path') === 'wander' ? buildWander : buildContour)(field, { ...LINE_DEFAULTS, technique: tech, rings, ...line }, free, { colorFromPhoto: photo });
    geomCache.set(key, g2);
    return g2;
  }
  const g = q.get('path') === 'maze'
    ? buildMaze(field, { ...LINE_DEFAULTS, technique: tech, rings, ...line },
      { shape: q.get('shape') || 'square', x: +(q.get('sx') || 0), y: +(q.get('sy') || 0), flow: +(q.get('flow') ?? 0.6), seed: +(q.get('seed') || 1) },
      { colorFromPhoto: photo })
    : buildSpiral(field, { ...LINE_DEFAULTS, technique: tech, rings, ...line }, { colorFromPhoto: photo });
  geomCache.set(key, g);
  return g;
}

let renderer;
function draw({ size, brush, paper, ink, geom, cover, photo }) {
  if (!renderer) renderer = new Renderer(document.createElement('canvas'));
  renderer.setSize(size, size);
  renderer.setLayout(LAYOUT);
  renderer.setPaper(paper, 1);
  renderer.setStyle({ brush, ink, cover, photoColor: photo });
  renderer.setGeometry(geom);
  if (q.get('blank') === '1') renderer.renderBlank();   // paper only, no line
  else renderer.render(Infinity);
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
  return { meanBlockDL: +mean.toFixed(2), p99BlockDL: +diffs[Math.floor(diffs.length * 0.99)].toFixed(2),
    meanLumSmall: +(sumA / diffs.length).toFixed(1), meanLumBig: +(sumB / diffs.length).toFixed(1) };
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
  window.__done = { ok: true, ms, report: window.__report, ...res };
  document.body.append(out);
  out.style.maxWidth = '100%';
}

run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
