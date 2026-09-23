// Dev lab for realistic mode, style D (flow engraving, js/real/engrave.js).
//   node tests/shoot.mjs "/dev/real_engrave.html?mode=single;img=sample:bust;tool=0.4;brush=fineliner;paper=cream"
//   mode   = single | lineup | ramp | stats | diag (the tone field; overlay=1 draws the line over it)
//   img    = sample:<id> | ramp (horizontal gradient)
//   tool   = tool width mm (default 0.4)      levels, flow, gamma, speed = engrave options
//   preset = quick | detailed | masterpiece   size = sheet px (928)   crop = x,y,w fractions (1:1 crops)
//   shot   = file name (default real_engrave_<mode>)   jpg=1 saves JPEG
// Sets window.__done = { ok, file, report }.
import { Renderer } from '../js/renderer.js';
import { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS } from '../js/tone.js';
import { brushById, paperById, inkMode } from '../js/materials.js';
import { build, ENGRAVE_PRESETS, ENGRAVE_DEFAULTS } from '../js/real/engrave.js';

const q = new URLSearchParams(location.search);
const LAYOUT = { cx: 0.5, cy: 0.5, r: 0.42 };

async function loadImage(spec) {
  if (spec === 'ramp') {
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 1024, 0);
    grd.addColorStop(0, '#000'); grd.addColorStop(1, '#fff');
    g.fillStyle = grd; g.fillRect(0, 0, 1024, 1024);
    return c;
  }
  const { makeSample } = await import('../js/samples.js');
  return makeSample((spec || 'sample:bust').replace('sample:', ''), 1024);
}

function engraveOpts(extra = {}) {
  const o = { ...(ENGRAVE_PRESETS[q.get('preset')] || {}) };
  for (const k of ['levels', 'flow', 'pack', 'gamma', 'minTooth', 'ramp']) if (q.has(k)) o[k] = +q.get(k);
  if (q.has('tool')) o.toolMm = +q.get('tool');
  if (q.has('speed')) o.speedMm = +q.get('speed');
  if (q.has('sheet')) o.sheetMm = +q.get('sheet');
  return { toolMm: 0.4, ...o, ...extra };
}

function fieldFor(src, flip, bands, auto = true) {
  const raster = rasterize(src, CROP_DEFAULTS);
  const tone = processTone(raster, { ...TONE_DEFAULTS, auto, detail: auto ? TONE_DEFAULTS.detail : 0 }, { flip });
  // blur the darkness to ~1/3 of a band (buildField's ring spacing = one band per ring across a radius)
  return buildField(raster, tone.L, { rings: Math.max(8, bands / 2), flip });
}

let renderer;
function render({ size, brushId, paperId, geom }) {
  if (!renderer) renderer = new Renderer(document.createElement('canvas'));
  const brush = brushById(brushId), paper = paperById(paperId);
  const ink = q.get('ink') || brush.inks[0][0];
  const mode = inkMode(brush, ink, paper);
  renderer.setSize(size, size);
  renderer.setLayout(LAYOUT);
  renderer.setPaper(paper, 1);
  renderer.setStyle({ brush, ink, cover: mode.cover, photoColor: false });
  renderer.setGeometry(geom, { pacing: 'steady' });
  renderer.setLight();
  renderer.setTime(null);
  renderer.render(Infinity);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.getContext('2d').drawImage(renderer.canvas, 0, 0);
  return c;
}

function geomFor(src, opts, auto = true) {
  // band count for the field blur (same formula as engrave.js)
  const w = opts.toolMm / (0.42 * (opts.sheetMm || 210));
  const bands = Math.round(1.97 / ((opts.levels || ENGRAVE_DEFAULTS.levels) * w));
  const field = fieldFor(src, false, bands, auto);
  const g = build(field, opts);
  return g;
}

const fmt = r => `${r.lengthM.toFixed(1)} m of line · ~${r.handMin < 90 ? Math.round(r.handMin) + ' min' : (r.handMin / 60).toFixed(1) + ' h'} by hand at ${r.speedMm / 10} cm/s · ${r.toolMm} mm tool`;

async function save(canvas, name, type) {
  const data = canvas.toDataURL(type, 0.92);
  const r = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data }) });
  return r.json();
}

async function run() {
  const mode = q.get('mode') || 'single';
  const size = +(q.get('size') || 928);
  let out, report;
  if (mode === 'single' || mode === 'stats') {
    const src = await loadImage(q.get('img') || 'sample:bust');
    const opts = engraveOpts();
    const geom = geomFor(src, opts);
    report = { ...geom.real, buildMs: +geom.real.buildMs.toFixed(1) };
    if (mode === 'stats') {
      // rebuild a few times for a steady build time
      const t = [];
      const field = fieldFor(src, false, geom.real.bands);
      for (let i = 0; i < 4; i++) t.push(build(field, opts).real.buildMs);
      report.buildMsRuns = t.map(v => +v.toFixed(1));
      out = document.createElement('canvas'); out.width = out.height = 8;
    } else {
      out = render({ size, brushId: q.get('brush') || 'fineliner', paperId: q.get('paper') || 'cream', geom });
      const crop = q.get('crop');
      if (crop) {
        const [cx, cy, cw] = crop.split(',').map(Number);
        const c = document.createElement('canvas');
        c.width = c.height = Math.round(cw * size);
        c.getContext('2d').drawImage(out, -cx * size, -cy * size);
        out = c;
      } else if (q.get('label') !== '0') {
        const g = out.getContext('2d');
        g.fillStyle = 'rgba(30,30,30,.8)'; g.font = `${Math.round(size / 58)}px system-ui`;
        g.fillText(fmt(geom.real), size * 0.08, size * 0.975);
      }
    }
  } else if (mode === 'lineup') {
    const panels = [
      { img: 'sample:bust', brush: 'fineliner', paper: 'cream', opts: { toolMm: 0.4 }, title: 'Plaster bust · 0.4 mm fineliner' },
      { img: 'sample:cat', brush: 'fineliner', paper: 'cream', opts: { toolMm: 0.4 }, title: 'Tabby cat · 0.4 mm fineliner' },
      { img: 'sample:bust', brush: 'charcoal', paper: 'coldpress', opts: { toolMm: 4, levels: +(q.get('clevels') || 3), speedMm: 60 }, title: 'Plaster bust · 4 mm charcoal stick' },
    ];
    const lab = 64;
    out = document.createElement('canvas');
    out.width = size * panels.length; out.height = size + lab;
    const g = out.getContext('2d');
    g.fillStyle = '#d9d5ce'; g.fillRect(0, 0, out.width, out.height);
    report = [];
    for (const [i, p] of panels.entries()) {
      const src = await loadImage(p.img);
      const opts = engraveOpts(p.opts);
      const geom = geomFor(src, opts);
      g.drawImage(render({ size, brushId: p.brush, paperId: p.paper, geom }), i * size, 0);
      g.fillStyle = '#222'; g.font = '600 20px system-ui';
      g.fillText(`D${i + 1}  ${p.title}`, i * size + 16, size + 26);
      g.font = '17px system-ui';
      g.fillText(fmt(geom.real), i * size + 16, size + 52);
      report.push({ panel: p.title, ...geom.real, buildMs: +geom.real.buildMs.toFixed(1) });
    }
  } else if (mode === 'diag') {
    // the darkness field the engraving reads (after the app's tone pipeline), for judging what
    // detail was there to draw
    const src = await loadImage(q.get('img') || 'sample:bust');
    const opts = engraveOpts();
    const w = opts.toolMm / (0.42 * (opts.sheetMm || 210));
    const field = fieldFor(src, false, Math.round(1.97 / ((opts.levels || ENGRAVE_DEFAULTS.levels) * w)));
    const G = field.G;
    out = document.createElement('canvas'); out.width = out.height = G;
    const g = out.getContext('2d');
    const im = g.createImageData(G, G);
    for (let i = 0; i < G * G; i++) {
      const v = 255 * (1 - field.D[i]);
      im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    if (q.get('overlay') === '1') {
      // the engraved line over the field it was read from, to check tone lands where it should
      const geom = build(field, opts);
      const d = geom.data;
      g.strokeStyle = 'rgba(220,30,30,0.8)'; g.lineWidth = Math.max(0.5, geom.maxWidth * G / 2);
      g.beginPath();
      for (let i = 0; i < geom.n; i++) {
        const X = (d[i * 7] + 1) / 2 * G, Y = (d[i * 7 + 1] + 1) / 2 * G;
        if (i) g.lineTo(X, Y); else g.moveTo(X, Y);
      }
      g.stroke();
      const cr = q.get('crop');
      if (cr) {
        const [cx, cy, cw] = cr.split(',').map(Number);
        const c2 = document.createElement('canvas'); c2.width = c2.height = 1024;
        c2.getContext('2d').drawImage(out, cx * G, cy * G, cw * G, cw * G, 0, 0, 1024, 1024);
        out = c2;
      }
    }
  } else if (mode === 'ramp') {
    // horizontal gradient: render + measured coverage per x bin (analytic from the geometry and
    // from the rendered pixels); both must rise monotonically toward black.
    const src = await loadImage('ramp');
    const opts = engraveOpts();
    const geom = geomFor(src, opts, false);
    const img = render({ size, brushId: q.get('brush') || 'fineliner', paperId: q.get('paper') || 'cream', geom });
    const bins = 12, cov = new Float64Array(bins);
    const d = geom.data, w = geom.maxWidth;
    for (let i = 1; i < geom.n; i++) {
      const x0 = d[(i - 1) * 7], y0 = d[(i - 1) * 7 + 1], x1 = d[i * 7], y1 = d[i * 7 + 1];
      const xm = (x0 + x1) / 2;
      if (Math.abs(xm) > 0.9 || Math.abs((y0 + y1) / 2) > 0.9) continue;
      const b = Math.min(bins - 1, Math.floor((xm + 0.9) / 1.8 * bins));
      cov[b] += Math.hypot(x1 - x0, y1 - y0) * w;
    }
    const binArea = (1.8 / bins) * 1.8;
    const analytic = [...cov].map(v => +(v / binArea).toFixed(3));
    // rendered luminance per bin inside the plate
    const px = img.getContext('2d').getImageData(0, 0, size, size).data;
    const lum = new Float64Array(bins), cnt = new Float64Array(bins);
    const toPx = u => (0.5 + 0.42 * u) * size;
    for (let y = Math.round(toPx(-0.9)); y < toPx(0.9); y++) for (let x = Math.round(toPx(-0.9)); x < toPx(0.9); x++) {
      const u = ((x + 0.5) / size - 0.5) / 0.42;
      const b = Math.min(bins - 1, Math.max(0, Math.floor((u + 0.9) / 1.8 * bins)));
      const o = (y * size + x) * 4;
      lum[b] += 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]; cnt[b]++;
    }
    const rendered = [...lum].map((v, i) => +(v / cnt[i]).toFixed(1));
    // monotonic within a tolerance: 0.005 coverage, or 1 grey level of the rendered page
    const mono = (a, tol) => a.every((v, i) => i === 0 || v <= a[i - 1] + tol);
    report = { analyticCoverage: analytic, renderedLum: rendered, coverageFallsLeftToRight: mono(analytic, 0.005),
      lumRisesLeftToRight: mono(rendered.map(v => -v), 1), ...geom.real };
    // plot strip under the render
    out = document.createElement('canvas'); out.width = size; out.height = size + 140;
    const g = out.getContext('2d');
    g.fillStyle = '#f4f1ea'; g.fillRect(0, 0, size, out.height);
    g.drawImage(img, 0, 0);
    const x0p = toPx(-0.9), x1p = toPx(0.9), top = size + 12, hgt = 110;
    g.strokeStyle = '#999'; g.strokeRect(x0p, top, x1p - x0p, hgt);
    g.fillStyle = '#222'; g.font = '13px system-ui';
    g.fillText('ink coverage per column (bars: line length x tool width / area; dots: rendered darkness)', x0p + 6, top + 16);
    for (let i = 0; i < bins; i++) {
      const bx = x0p + (x1p - x0p) * i / bins, bw = (x1p - x0p) / bins;
      const hb = Math.min(1, analytic[i]) * (hgt - 24);
      g.fillStyle = '#6b7fa8'; g.fillRect(bx + 4, top + hgt - hb, bw - 8, hb);
      const dk = 1 - rendered[i] / 240;
      g.fillStyle = '#c0392b'; g.beginPath(); g.arc(bx + bw / 2, top + hgt - Math.max(0, dk) * (hgt - 24), 4, 0, 7); g.fill();
    }
  }
  window.__report = report;
  const res = await save(out, q.get('shot') || `real_engrave_${mode}`, q.get('jpg') ? 'image/jpeg' : 'image/png');
  window.__done = { ok: true, report, ...res };
  document.body.append(out);
  out.style.maxWidth = '100%';
}

run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
