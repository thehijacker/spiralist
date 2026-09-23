// Realistic mode, style B (stipple tour) lab. Renders with the real renderer and saves shots/real_stipple_*.
//   node tests/shoot.mjs "/dev/real_stipple.html?view=sheet;img=bust;tool=0.4;brush=fineliner;paper=cream"
//   view = sheet   one sheet (size=928), crop=x,y,w for a 1:1 crop of a big render (size=4096)
//          ramp    a horizontal darkness ramp: render + measured coverage per band (monotonic check)
//          lineup  bust (fineliner 0.4) | cat (fineliner 0.4) | bust (charcoal 4) at 928 px, labelled
//          bench   build timing of every preset on the bust and cat fields (no render)
//   img = bust | cat | moon | peaks (samples);  tool = mm;  preset = quick | detailed | masterpiece
//   sheet = sheet width mm (210);  floor, cap = preset overrides;  seed, sx, sy (start), wobble, round;  shot = file name;  xing=1 counts
//   crossings of the final polyline.
// Sets window.__done = { ok, file, report }.
import { Renderer } from '../js/renderer.js';
import { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS } from '../js/tone.js';
import { brushById, paperById, inkMode } from '../js/materials.js';
import { build, countCrossings, STIPPLE_PRESETS } from '../js/real/stipple.js';

const q = new URLSearchParams(location.search);
const LAYOUT = { cx: 0.5, cy: 0.5, r: 0.42 };
const SHEET_MM = +(q.get('sheet') || 210);

async function loadSource(id) {
  const { makeSample } = await import('../js/samples.js');
  return makeSample(id, 1024);
}

// Field blur tied to the tool: the stipples sample a band about one tool width wide, not single pixels.
function fieldFor(src, toolMm) {
  const raster = rasterize(src, CROP_DEFAULTS);
  const tone = processTone(raster, TONE_DEFAULTS, { flip: false });
  const tCU = toolMm / (LAYOUT.r * SHEET_MM);
  return buildField(raster, tone.L, { rings: Math.max(12, Math.round(1 / (1.2 * tCU))) });
}

function rampField(G = 1024) {
  const D = new Float32Array(G * G);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) D[y * G + x] = x / (G - 1);
  return { G, D, rgb: null, raster: null, rings: 200 };
}

function geomFor(field, toolMm, extra = {}) {
  // floor= / cap= override the preset's widest spacing (tool widths) and darkest coverage (tuning)
  const name = extra.preset || q.get('preset') || 'detailed';
  const preset = q.has('floor') || q.has('cap')
    ? { ...STIPPLE_PRESETS[name], ...(q.has('floor') ? { floorT: +q.get('floor') } : {}), ...(q.has('cap') ? { cap: +q.get('cap') } : {}) }
    : name;
  return build(field, {
    sheetMm: SHEET_MM, toolMm, layoutR: LAYOUT.r, preset,
    seed: +(q.get('seed') || 1), x: +(q.get('sx') || 0), y: +(q.get('sy') || -0.3),
    ...(q.has('wobble') ? { wobble: +q.get('wobble') } : {}), ...(q.has('round') ? { round: +q.get('round') } : {}),
    ...extra, preset,
  });
}

let renderer;
function draw(size, brushId, paperId, geom) {
  if (!renderer) renderer = new Renderer(document.createElement('canvas'));
  const brush = brushById(brushId), paper = paperById(paperId);
  const ink = q.get('ink') || brush.inks[0][0];
  const mode = inkMode(brush, ink, paper);
  renderer.setSize(size, size);
  renderer.setLayout(LAYOUT);
  renderer.setPaper(paper, 1);
  renderer.setStyle({ brush, ink, cover: mode.cover, photoColor: false });
  renderer.setGeometry(geom, { pacing: 'natural' });
  renderer.setLight();
  renderer.setTime(null);
  renderer.render(Infinity);
  return renderer.canvas;
}

function copy(src, x = 0, y = 0, w = src.width, h = src.height) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(src, -x, -y);
  return c;
}

const fmtTime = min => (min >= 90 ? `${(min / 60).toFixed(1)} h` : `${Math.round(min)} min`);
const label = (g, toolMm, brushName) => `${brushName} ${toolMm} mm · ${g.real.lengthM.toFixed(1)} m of line · ~${fmtTime(g.real.handMin)} by hand (${g.real.strokesPerS} strokes/s, ${g.real.speedCmS} cm/s) · ${fmtTime(g.real.plotterMin)} on a plotter`;

async function save(canvas, name, type = 'image/jpeg') {
  const data = canvas.toDataURL(type, 0.92);
  const r = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data }) });
  return r.json();
}

function report(g, extra = {}) {
  const r = { ...g.real, ...extra };
  if (q.get('xing') === '1') { const t = performance.now(); r.finalCrossings = countCrossings(g); r.xingMs = Math.round(performance.now() - t); }
  return r;
}

async function run() {
  const view = q.get('view') || 'sheet';
  const toolMm = +(q.get('tool') || 0.4);
  const brushId = q.get('brush') || (toolMm >= 2 ? 'charcoal' : 'fineliner');
  const paperId = q.get('paper') || (brushId === 'charcoal' ? 'coldpress' : 'cream');
  let out, rep;
  if (view === 'sheet') {
    const src = await loadSource(q.get('img') || 'bust');
    const g = geomFor(fieldFor(src, toolMm), toolMm);
    const size = +(q.get('size') || 928);
    const img = draw(size, brushId, paperId, g);
    const crop = q.get('crop');
    if (crop) {
      const [cx, cy, cw] = crop.split(',').map(Number);
      out = copy(img, Math.round(cx * size), Math.round(cy * size), Math.round(cw * size), Math.round(cw * size));
    } else {
      out = copy(img);
      const c = out.getContext('2d');
      c.fillStyle = 'rgba(40,36,30,0.85)'; c.font = `${Math.round(size / 58)}px system-ui`;
      c.fillText(label(g, toolMm, brushById(brushId).name), size * 0.08, size * 0.965);
    }
    rep = report(g, { size });
  } else if (view === 'ramp') {
    // Darkness 0 -> 1 left to right. Coverage is measured on the render in 16 bands across the art
    // square: (paper - pixel) / (paper - ink) luminance, averaged, so it includes the real brush.
    const g = geomFor(rampField(), toolMm);
    const size = +(q.get('size') || 928);
    const img = copy(draw(size, brushId, paperId, g));
    const blank = (() => { renderer.renderBlank(); return copy(renderer.canvas); })();
    const d = img.getContext('2d').getImageData(0, 0, size, size).data;
    const b = blank.getContext('2d').getImageData(0, 0, size, size).data;
    const lum = (a, o) => 0.2126 * a[o] + 0.7152 * a[o + 1] + 0.0722 * a[o + 2];
    const inkL = (() => { const h = (q.get('ink') || brushById(brushId).inks[0][0]).slice(1); const v = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; })();
    const x0 = Math.round(size * (0.5 - LAYOUT.r * 0.97)), x1 = Math.round(size * (0.5 + LAYOUT.r * 0.97));
    const y0 = Math.round(size * (0.5 - LAYOUT.r * 0.9)), y1 = Math.round(size * (0.5 + LAYOUT.r * 0.9));
    const bands = 16, cov = [];
    for (let k = 0; k < bands; k++) {
      const a0 = Math.round(x0 + (x1 - x0) * k / bands), a1 = Math.round(x0 + (x1 - x0) * (k + 1) / bands);
      let sp = 0, sb = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = a0; x < a1; x++) { const o = (y * size + x) * 4; sp += lum(d, o); sb += lum(b, o); n++; }
      cov.push(+(((sb - sp) / n) / (sb / n - inkL)).toFixed(3));
    }
    let mono = true;
    for (let k = 1; k < bands; k++) if (cov[k] < cov[k - 1] - 0.005) mono = false;
    // sheet: render on top, then target vs measured bars
    const H = Math.round(size * 0.28);
    out = document.createElement('canvas'); out.width = size; out.height = size + H;
    const c = out.getContext('2d');
    c.drawImage(img, 0, 0);
    c.fillStyle = '#efeae0'; c.fillRect(0, size, size, H);
    const cap = (STIPPLE_PRESETS[q.get('preset') || 'detailed'] || STIPPLE_PRESETS.detailed).cap;
    for (let k = 0; k < bands; k++) {
      const a0 = x0 + (x1 - x0) * k / bands, bw = (x1 - x0) / bands;
      const Dm = (k + 0.5) / bands;
      const target = cap * Dm;
      c.fillStyle = '#b9ae98'; c.fillRect(a0 + 2, size + H - 20 - target * (H - 40), bw * 0.42, target * (H - 40));
      c.fillStyle = '#2a2622'; c.fillRect(a0 + bw * 0.5, size + H - 20 - cov[k] * (H - 40), bw * 0.42, cov[k] * (H - 40));
    }
    c.fillStyle = '#2a2622'; c.font = '14px system-ui';
    c.fillText(`darkness 0 -> 1 · coverage per band: target (light) vs measured on the render (dark) · monotonic: ${mono}`, 12, size + 18);
    c.fillText(label(g, toolMm, brushById(brushId).name), 12, size + 38);
    rep = report(g, { cov, mono, cap });
  } else if (view === 'lineup') {
    const size = +(q.get('size') || 928);
    const bust = await loadSource('bust'), cat = await loadSource('cat');
    const fine = +(q.get('fine') || 0.4), stick = +(q.get('stick') || 4);
    const panels = [
      ['Plaster bust', bust, fine, 'fineliner', 'cream'],
      ['Tabby cat', cat, fine, 'fineliner', 'cream'],
      ['Plaster bust', bust, stick, 'charcoal', 'coldpress'],
    ];
    const LH = 64;
    out = document.createElement('canvas'); out.width = size * 3; out.height = size + LH;
    const c = out.getContext('2d');
    c.fillStyle = '#e7e2d8'; c.fillRect(0, 0, out.width, out.height);
    rep = [];
    for (let i = 0; i < panels.length; i++) {
      const [name, src, tMm, br, pa] = panels[i];
      const g = geomFor(fieldFor(src, tMm), tMm);
      c.drawImage(draw(size, br, pa, g), i * size, 0);
      c.fillStyle = '#26221e'; c.font = 'bold 19px system-ui';
      c.fillText(`B · Stipple tour — ${name}`, i * size + 20, size + 26);
      c.font = '16px system-ui';
      c.fillText(`${brushById(br).name} ${tMm} mm on ${paperById(pa).name} ${SHEET_MM} mm · ${g.real.lengthM.toFixed(1)} m of line · ~${fmtTime(g.real.handMin)} by hand`, i * size + 20, size + 50);
      rep.push({ name, tMm, ...g.real });
    }
  } else if (view === 'presets') {
    const size = +(q.get('size') || 928);
    const src = await loadSource(q.get('img') || 'bust');
    const f = fieldFor(src, toolMm);
    const LH = 64;
    out = document.createElement('canvas'); out.width = size * 3; out.height = size + LH;
    const c = out.getContext('2d');
    c.fillStyle = '#e7e2d8'; c.fillRect(0, 0, out.width, out.height);
    rep = [];
    Object.keys(STIPPLE_PRESETS).forEach((p, i) => {
      const g = geomFor(f, toolMm, { preset: p });
      c.drawImage(draw(size, brushId, paperId, g), i * size, 0);
      c.fillStyle = '#26221e'; c.font = 'bold 19px system-ui';
      c.fillText(`${STIPPLE_PRESETS[p].name}`, i * size + 20, size + 26);
      c.font = '16px system-ui';
      c.fillText(`${brushById(brushId).name} ${toolMm} mm · ${g.real.stipples} stipples · ${g.real.lengthM.toFixed(1)} m · ~${fmtTime(g.real.handMin)} by hand · ${fmtTime(g.real.plotterMin)} plotter`, i * size + 20, size + 50);
      rep.push({ p, ...g.real });
    });
  } else if (view === 'bench') {
    rep = [];
    for (const id of ['bust', 'cat']) {
      const src = await loadSource(id);
      for (const t of [0.4, 0.5, 4]) {
        const f = fieldFor(src, t);
        for (const p of Object.keys(STIPPLE_PRESETS)) {
          geomFor(f, t, { preset: p });                  // warm the JIT
          const g = geomFor(f, t, { preset: p });
          rep.push({ id, t, p, ms: g.real.buildMs, split: g.real.ms, n: g.real.points, st: g.real.stipples, m: g.real.lengthM, min: g.real.handMin, left: g.real.crossingsLeft });
        }
      }
    }
    out = document.createElement('canvas'); out.width = out.height = 8;
  }
  window.__report = rep;
  const res = await save(out, q.get('shot') || `real_stipple_${view}`);
  window.__done = { ok: true, report: rep, ...res };
  document.body.append(out);
  out.style.maxWidth = '100%';
}

run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
