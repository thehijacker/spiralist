// Dev lab for the realistic SCRIBBLE (circulism) line: js/real/scribble.js with the real renderer.
//   node tests/shoot.mjs "/dev/real_scribble.html?mode=single;img=bust;brush=fineliner;paper=cream;tool=0.4"
//   mode = single  one sheet (size=928; crop=x,y,w fractions of the sheet for a 1:1 crop of a big render)
//          ramp    a horizontal black-to-white gradient + measured ink per band (monotone check)
//          lineup  bust (fineliner) + cat (fineliner) + bust (charcoal), labelled with length and time
//          presets the bust at Quick sketch / Detailed / Masterpiece
//          timing  build time per preset (no render)
//   img = bust | cat | moon | peaks | ramp;  preset = quick | detailed | masterpiece;  seed=;  shot=name
// Sets window.__done = { ok, file, report } for tests/shoot.mjs.
import { Renderer } from '../js/renderer.js';
import { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS } from '../js/tone.js';
import { brushById, paperById, inkMode } from '../js/materials.js';
import { build, formatHandTime, SCRIBBLE_PRESETS } from '../js/real/scribble.js';

const q = new URLSearchParams(location.search);
const LAYOUT = { cx: 0.5, cy: 0.5, r: 0.42 };
const INKS = { fineliner: '#17171a', charcoal: '#1b1715', ballpoint: '#1d3a8a', pencil: '#2a2a2e' };

async function loadImage(id) {
  if (id === 'ramp') {
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 1024, 0);
    grd.addColorStop(0, '#000'); grd.addColorStop(1, '#fff');
    g.fillStyle = grd; g.fillRect(0, 0, 1024, 1024);
    return c;
  }
  const { makeSample } = await import('../js/samples.js');
  return makeSample(id, 1024);
}

const fields = new Map();
async function fieldFor(img, flip, { auto = true } = {}) {
  const key = img + '|' + flip + '|' + auto;
  if (fields.has(key)) return fields.get(key);
  const src = await loadImage(img);
  const raster = rasterize(src, CROP_DEFAULTS);
  // the ramp keeps its linear tones (auto levels would re-solve the midtones)
  const tone = processTone(raster, auto ? TONE_DEFAULTS : { ...TONE_DEFAULTS, auto: false, detail: 0 }, { flip });
  const field = buildField(raster, tone.L, { rings: 110, flip });
  fields.set(key, field);
  return field;
}

// raw=1: a plain Canvas 2D stroke at the true width (fast algorithm iteration, no media physics)
function renderRaw({ size, paper, ink, geom }) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = paper.color; g.fillRect(0, 0, size, size);
  const k = LAYOUT.r * size, ox = LAYOUT.cx * size, oy = LAYOUT.cy * size;
  g.strokeStyle = ink; g.lineWidth = Math.max(0.6, geom.data[2] * k); g.lineJoin = g.lineCap = 'round';
  g.beginPath();
  const d = geom.data;
  g.moveTo(ox + d[0] * k, oy + d[1] * k);
  for (let i = 1; i < geom.n; i++) g.lineTo(ox + d[i * 7] * k, oy + d[i * 7 + 1] * k);
  g.stroke();
  return c;
}

let renderer;
function render({ size, brush, paper, ink, geom, cover }) {
  if (q.get('raw')) return renderRaw({ size, paper, ink, geom });
  if (!renderer) renderer = new Renderer(document.createElement('canvas'));
  renderer.setSize(size, size);
  renderer.setLayout(LAYOUT);
  renderer.setPaper(paper, 1);
  renderer.setStyle({ brush, ink, cover, photoColor: false });
  renderer.setGeometry(geom, { pacing: 'steady' });
  renderer.render(Infinity);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.getContext('2d').drawImage(renderer.canvas, 0, 0);
  return c;
}

// soft sticks mark with only part of their width at full strength (a calibration, per medium)
const MARK = { charcoal: 0.9, chalk: 0.8, crayon: 0.9, pencil: 0.85 };

async function sheet({ img, brushId, paperId, toolMm, preset, seed, size, auto = true, vignette }) {
  const brush = brushById(brushId), paper = paperById(paperId);
  const ink = q.get('ink') || INKS[brushId] || brush.inks[0][0];
  const mode = inkMode(brush, ink, paper, false);
  const field = await fieldFor(img, mode.flip, { auto });
  const opts = { toolMm, preset, seed, sheetMm: 210, layoutR: LAYOUT.r, markRatio: MARK[brushId] || 1 };
  if (vignette != null) opts.vignette = vignette;
  for (const k of ['notan', 'cmax', 'gamma', 'loopScale']) if (q.has(k)) opts[k] = +q.get(k);
  const geom = build(field, opts);
  const t0 = performance.now();
  const canvas = render({ size, brush, paper, ink, geom, cover: mode.cover });
  return { canvas, geom, renderMs: performance.now() - t0 };
}

async function save(canvas, name, type = 'image/jpeg') {
  const data = canvas.toDataURL(type, 0.93);
  const r = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data }) });
  return r.json();
}

const fmtStats = s => `${s.lengthM.toFixed(1)} m of line · ~${formatHandTime(s.handSeconds)} by hand · ${(s.points / 1000).toFixed(0)}k pts`;
const statsOut = (g, extra = {}) => ({ ...g.stats, lengthM: +g.stats.lengthM.toFixed(2), handMin: +(g.stats.handSeconds / 60).toFixed(1), buildMs: Math.round(g.stats.buildMs), ...extra });

async function run() {
  const mode = q.get('mode') || 'single';
  const size = +(q.get('size') || 928);
  const preset = q.get('preset') || 'detailed';
  const seed = +(q.get('seed') || 1);
  let out, report;

  if (mode === 'single') {
    const brushId = q.get('brush') || 'fineliner';
    const { canvas, geom, renderMs } = await sheet({
      img: q.get('img') || 'bust', brushId, paperId: q.get('paper') || 'cream',
      toolMm: +(q.get('tool') || 0.4), preset, seed, size,
    });
    out = canvas;
    const crop = q.get('crop');   // x,y,w fractions of the sheet: a 1:1 crop
    if (crop) {
      const [cx, cy, cw] = crop.split(',').map(Number);
      const c = document.createElement('canvas');
      c.width = c.height = Math.round(cw * size);
      c.getContext('2d').drawImage(out, -cx * size, -cy * size);
      out = c;
    }
    report = statsOut(geom, { renderMs: Math.round(renderMs) });
  } else if (mode === 'ramp') {
    const brushId = q.get('brush') || 'fineliner';
    const { canvas, geom } = await sheet({ img: 'ramp', brushId, paperId: q.get('paper') || 'cream', toolMm: +(q.get('tool') || 0.4), preset, seed, size, auto: false, vignette: 0 });
    // measured: mean luminance of 10 vertical bands inside the art square, and line mm per mm^2
    const g = canvas.getContext('2d');
    const x0 = Math.round((0.5 - LAYOUT.r) * size), wArt = Math.round(2 * LAYOUT.r * size);
    const bands = 10, lum = [], dens = [];
    const d = g.getImageData(x0, x0, wArt, wArt).data;
    for (let b = 0; b < bands; b++) {
      let s = 0, n = 0;
      for (let y = 0; y < wArt; y += 2) for (let x = Math.floor(b * wArt / bands); x < Math.floor((b + 1) * wArt / bands); x++) {
        const o = (y * wArt + x) * 4; s += 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]; n++;
      }
      lum.push(+(s / n).toFixed(1));
    }
    const F = 210 * LAYOUT.r, len = new Float64Array(bands);
    const D = geom.data;
    for (let i = 1; i < geom.n; i++) {
      const o = i * 7, p = o - 7;
      const xm = 0.5 * (D[o] + D[p]);
      const b = Math.max(0, Math.min(bands - 1, Math.floor((xm + 1) / 2 * bands)));
      len[b] += Math.hypot(D[o] - D[p], D[o + 1] - D[p + 1]) * F;
    }
    const bandArea = (2 * F / bands) * 2 * F;
    for (let b = 0; b < bands; b++) dens.push(+(len[b] / bandArea).toFixed(3));
    let mono = true;
    for (let b = 1; b < bands; b++) if (dens[b] > dens[b - 1] + 1e-9 || lum[b] < lum[b - 1] - 2) mono = false;   // (2: grain noise where the darks saturate)
    // strip chart under the sheet: the measured band luminance
    const c = document.createElement('canvas');
    c.width = size; c.height = size + 70;
    const cx = c.getContext('2d');
    cx.fillStyle = '#e8e4dc'; cx.fillRect(0, 0, c.width, c.height);
    cx.drawImage(canvas, 0, 0);
    cx.font = '13px system-ui'; cx.fillStyle = '#222';
    for (let b = 0; b < bands; b++) {
      const bx = x0 + b * wArt / bands;
      cx.fillStyle = `rgb(${lum[b]},${lum[b]},${lum[b]})`; cx.fillRect(bx + 2, size + 6, wArt / bands - 4, 24);
      cx.fillStyle = '#222'; cx.fillText(dens[b].toFixed(2), bx + 8, size + 48);
    }
    cx.fillText('line mm per mm² per band (measured from the geometry); swatches = rendered band tone', x0, size + 66);
    out = c;
    report = { ...statsOut(geom), bandLum: lum, bandDensity: dens, monotone: mono };
  } else if (mode === 'lineup' || mode === 'presets') {
    const cell = size;
    // presets: the bust in 0.4 mm fineliner at each preset (detail vs drawing time)
    const items = mode === 'presets'
      ? Object.keys(SCRIBBLE_PRESETS).map(p => ({ img: 'bust', brushId: 'fineliner', paperId: 'cream', toolMm: 0.4, preset: p, title: `Bust · 0.4 mm fineliner · ${SCRIBBLE_PRESETS[p].label}` }))
      : [
        { img: 'bust', brushId: 'fineliner', paperId: 'cream', toolMm: 0.4, title: 'Bust · 0.4 mm fineliner · cream' },
        { img: 'cat', brushId: 'fineliner', paperId: 'cream', toolMm: 0.4, title: 'Cat · 0.4 mm fineliner · cream' },
        { img: 'bust', brushId: 'charcoal', paperId: 'coldpress', toolMm: 4, title: 'Bust · 4 mm charcoal · cold-press' },
      ];
    const c = document.createElement('canvas');
    const lab = 64;
    c.width = cell * items.length; c.height = cell + lab;
    const cx = c.getContext('2d');
    cx.fillStyle = '#d9d5ce'; cx.fillRect(0, 0, c.width, c.height);
    report = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const { canvas, geom } = await sheet({ preset, seed, size: cell, ...it });
      cx.drawImage(canvas, i * cell, 0);
      cx.fillStyle = '#1d1d1f'; cx.font = '600 17px system-ui';
      cx.fillText(`${'ABC'[i]}  ${it.title}`, i * cell + 16, cell + 26);
      cx.font = '15px system-ui'; cx.fillStyle = '#3a3a3c';
      cx.fillText(`Scribble (${SCRIBBLE_PRESETS[it.preset || preset].label}) · ${fmtStats(geom.stats)}`, i * cell + 16, cell + 50);
      report.push({ title: it.title, ...statsOut(geom) });
    }
    out = c;
  } else if (mode === 'timing') {
    const field = await fieldFor(q.get('img') || 'bust', false);
    report = {};
    for (const p of Object.keys(SCRIBBLE_PRESETS)) {
      for (const tool of [0.4, 4]) {
        build(field, { toolMm: tool, preset: p });   // warm the JIT
        const ms = [];
        let g;
        for (let k = 0; k < 3; k++) { g = build(field, { toolMm: tool, preset: p, seed: k + 1 }); ms.push(g.stats.buildMs); }
        report[`${p}@${tool}mm`] = { ...statsOut(g), buildMs: ms.map(Math.round) };
      }
    }
    window.__report = report;
    window.__done = { ok: true, report };
    return;
  }
  const res = await save(out, q.get('shot') || `real_scribble_${mode}`, q.get('png') ? 'image/png' : 'image/jpeg');
  window.__done = { report, ...res, ok: true };
  document.body.append(out);
}

run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
