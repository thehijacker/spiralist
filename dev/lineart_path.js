// Line art path lab: plans ONE line through line-art strokes (js/lineart/path.js), renders it
// with the real renderer and draws the plan next to it (order as a colour ramp, retraced passages,
// new bridges), then saves shots/la_path_<name>.
//   node tests/shoot.mjs "/dev/lineart_path.html?img=sample:bust;tool=fineliner;paper=cream"
//   img      sample:bust | sample:cat | <url>
//   src      auto (lines.js when it exists, else the stand-in) | standin | lines
//   tool     brush id (fineliner, brush, fountain, ...); toolMm; paper; ink
//   style    sparse | rich;  wobble, overshoot, hatch 0..1;  seed;  speed (mm/s)
//   size     render px (928);  crop=x,y,w (fractions of the sheet; the render is then made at
//            size and the crop saved 1:1, e.g. size=3840;crop=0.3,0.2,0.3)
//   view     both (render | plan) | render | plan
//   name     shot name suffix
import { Renderer } from '../js/renderer.js';
import { rasterize, processTone, buildField, sampleField, TONE_DEFAULTS, CROP_DEFAULTS } from '../js/tone.js';
import { LINE_DEFAULTS, STRIDE } from '../js/spiral.js';
import { buildContour } from '../js/freeline.js';
import { brushById, paperById } from '../js/materials.js';
import { buildLineArt, LAYOUT_R } from '../js/lineart/path.js';
import { makeStroke, validateStrokes } from '../js/lineart/strokes.js';

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) ? +q.get(k) : d);

async function loadImage(spec) {
  if (spec.startsWith('sample:')) {
    const { makeSample } = await import('../js/samples.js');
    return makeSample(spec.slice(7), 1024);
  }
  const img = new Image();
  img.src = spec;
  await img.decode();
  return img;
}

/** Stand-in strokes: the Contour path's edge chains (split where its thin glides run). */
function standinStrokes(field) {
  const g = buildContour(field, { ...LINE_DEFAULTS, rings: num('detail', 80) }, { shape: 'square', x: 0, y: -0.4, seed: 1 });
  const d = g.data, strokes = [];
  let run = [], tones = [];
  const flush = () => {
    if (run.length >= 8) {
      const pts = [];
      for (let k = 0; k < run.length; k += 2) pts.push((run[k][0] + 1) / 2, (run[k][1] + 1) / 2);
      let dark = 0;
      for (const p of run) dark += sampleField(field, p[0], p[1]);
      const t = tones.reduce((a, b) => a + b, 0) / tones.length;
      const a = run[0], b = run[run.length - 1];
      strokes.push(makeStroke(pts, {
        closed: Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01 && run.length > 30,
        saliency: Math.min(1, Math.max(0, (t - 0.2) / 0.55)), kind: 'other', dark: dark / run.length,
      }));
    }
    run = []; tones = [];
  };
  for (let i = 0; i < g.n; i++) {
    const tone = d[i * STRIDE + 4];
    if (tone < 0.08) { flush(); continue; }
    run.push([d[i * STRIDE], d[i * STRIDE + 1]]); tones.push(tone);
  }
  flush();
  return strokes;
}

function darkGrid(field, w = 64) {
  const data = new Float32Array(w * w);
  for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) data[j * w + i] = sampleField(field, (i + 0.5) / w * 2 - 1, (j + 0.5) / w * 2 - 1);
  return { w, h: w, data };
}

async function getStrokes(src, field) {
  const mode = q.get('src') || 'auto';
  if (mode !== 'standin') {
    try {
      const mod = await import('../js/lineart/lines.js');
      if (mod.extractLines) {
        const r = await mod.extractLines(src, CROP_DEFAULTS, { detail: num('detail', q.get('style') === 'rich' ? 0.7 : 0.5) });
        if (r && r.strokes && r.strokes.length) return { ...r, from: 'lines.js' };
      }
      if (mode === 'lines') throw new Error('lines.js returned no strokes');
    } catch (e) {
      if (mode === 'lines') throw e;
      console.log('lines.js unavailable, using the stand-in: ' + e.message);
    }
  }
  return { strokes: standinStrokes(field), features: { face: null, dark: darkGrid(field) }, from: 'standin' };
}

// plan view: faint photo, new line coloured by hand time (violet -> yellow), retraced passages
// dark grey, new bridges red, the start a green ring and the end a black square
function drawPlan(geom, size, src) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#fbfaf7'; g.fillRect(0, 0, size, size);
  const R = LAYOUT_R * size, ox = size / 2 - R, side = 2 * R;
  g.globalAlpha = 0.13;
  const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight, s0 = Math.min(sw, sh);
  g.drawImage(src, (sw - s0) / 2, (sh - s0) / 2, s0, s0, ox, ox, side, side);
  g.globalAlpha = 1;
  const X = i => size / 2 + R * geom.data[i * STRIDE], Y = i => size / 2 + R * geom.data[i * STRIDE + 1];
  const { seg } = geom.lineart, T = geom.handT, Tn = T[geom.n - 1] || 1;
  g.lineCap = 'round'; g.lineJoin = 'round';
  const ramp = t => `hsl(${Math.round(275 - 225 * t)}, 85%, ${Math.round(38 + 14 * t)}%)`;
  for (let i = 1; i < geom.n; i++) {
    const s = seg[i];
    if (s === 1) { g.strokeStyle = 'rgba(40,40,40,0.9)'; g.lineWidth = 1.2; g.setLineDash([]); }
    else if (s === 2) { g.strokeStyle = '#e0181b'; g.lineWidth = 2.2; g.setLineDash([]); }
    else { g.strokeStyle = ramp(T[i] / Tn); g.lineWidth = s === 3 ? 1.5 : 3; g.setLineDash([]); }
    g.beginPath(); g.moveTo(X(i - 1), Y(i - 1)); g.lineTo(X(i), Y(i)); g.stroke();
  }
  // retraced passages again on top, so the doubling is visible over the ramp
  g.strokeStyle = 'rgba(20,20,20,0.85)'; g.lineWidth = 1;
  for (let i = 1; i < geom.n; i++) if (seg[i] === 1) { g.beginPath(); g.moveTo(X(i - 1), Y(i - 1)); g.lineTo(X(i), Y(i)); g.stroke(); }
  // stroke numbers at their entries
  g.font = 'bold 11px system-ui'; g.fillStyle = '#111';
  let last = -1;
  for (let i = 0; i < geom.n; i++) {
    const k = geom.lineart.stroke[i];
    if (k >= 0 && k !== last) { g.fillText(String(k + 1), X(i) + 4, Y(i) - 4); last = k; }
  }
  g.strokeStyle = '#0a8f3a'; g.lineWidth = 3;
  g.beginPath(); g.arc(X(0), Y(0), 9, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#000'; g.fillRect(X(geom.n - 1) - 5, Y(geom.n - 1) - 5, 10, 10);
  const L = geom.lineart;
  g.fillStyle = 'rgba(251,250,247,0.85)'; g.fillRect(0, 0, size, 44);
  g.fillStyle = '#111'; g.font = '13px system-ui';
  g.fillText(`${L.strokes} strokes · line ${L.lengthM} m · new ${L.drawnM} m · retraced ${L.retracedM} m · bridges ${L.bridgesM} m · hatch ${L.hatchM} m`, 10, 18);
  g.fillText(`hand ${Math.floor(L.handSeconds / 60)} min ${Math.round(L.handSeconds % 60)} s · ${L.tool} ${L.toolMm} mm on ${L.sheetMm} mm · dropped ${L.dropped} · colour = hand time, grey = retrace, red = bridge`, 10, 36);
  return c;
}

async function save(canvas, name, type = 'image/jpeg') {
  const data = canvas.toDataURL(type, 0.93);
  const r = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data }) });
  return r.json();
}

async function run() {
  const src = await loadImage(q.get('img') || 'sample:bust');
  const raster = rasterize(src, CROP_DEFAULTS);
  const tone = processTone(raster, TONE_DEFAULTS, {});
  const field = buildField(raster, tone.L, { rings: 60 });
  const got = await getStrokes(src, field);
  const valid = validateStrokes(got.strokes);
  const tool = q.get('tool') || 'fineliner';
  const brush = brushById(tool);
  const paper = paperById(q.get('paper') || 'cream');
  const opts = {
    sheetMm: num('sheet', 210), toolMm: num('toolMm', tool === 'fineliner' ? 0.4 : 1.2), tool,
    style: q.get('style') || 'sparse', wobble: num('wobble', 0.5), overshoot: num('overshoot', 0.5),
    hatch: num('hatch', 0), seed: num('seed', 1), speedMm: num('speed', 24),
  };
  if (q.has('pressure')) opts.pressure = q.get('pressure') === '1';
  const geom = buildLineArt(got.strokes, got.features || {}, opts);

  const size = num('size', 928);
  const view = q.get('view') || 'both';
  const r = new Renderer(document.createElement('canvas'));
  r.setSize(size, size);
  r.setLayout({ cx: 0.5, cy: 0.5, r: LAYOUT_R });
  r.setSheetMm(opts.sheetMm);
  r.setPaper(paper, 1);
  r.setStyle({ brush, ink: q.get('ink') || brush.inks[0][0], cover: false, photoColor: false });
  r.setGeometry(geom, { pacing: 'natural' });
  r.render(Infinity);
  let img = r.canvas;
  if (q.get('crop')) {
    const [cx, cy, cw] = q.get('crop').split(',').map(Number);
    const px = Math.round(cw * size);
    const c = document.createElement('canvas');
    c.width = c.height = px;
    c.getContext('2d').drawImage(r.canvas, Math.round(cx * size), Math.round(cy * size), px, px, 0, 0, px, px);
    img = c;
  }
  let out = img;
  if (view !== 'render') {
    const plan = drawPlan(geom, q.get('crop') ? 928 : size, src);
    if (view === 'plan') out = plan;
    else {
      const c = document.createElement('canvas');
      c.width = img.width + plan.width; c.height = Math.max(img.height, plan.height);
      const g = c.getContext('2d');
      g.fillStyle = '#ddd'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0); g.drawImage(plan, img.width, 0);
      out = c;
    }
  }
  const name = 'la_path_' + (q.get('name') || `${(q.get('img') || 'sample:bust').replace(/\W+/g, '_')}_${tool}`);
  const res = await save(out, name);
  const { seg, stroke, order, ...stats } = geom.lineart;
  window.__done = { ok: true, file: res.file || name, from: got.from, strokesIn: got.strokes.length, valid: valid.ok, errors: valid.errors.slice(0, 3),
    stats, n: geom.n, order: order.slice(0, 40).map(o => `${o.kind}:${o.lenMm}`).join(' ') };
}
run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
