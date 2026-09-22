// Samples lab: look at the procedural sample images raw, as the tone pipeline sees them, and time them.
//   /dev/samples.html?mode=raw;size=512            sheet of all samples (ids=bust,cat to pick)
//   /dev/samples.html?mode=one;id=bust;size=1024   one sample, full size (view=yaw,pitch,roll offsets)
//   /dev/samples.html?mode=views;id=bust;size=512;views=0,0,0~-1.24,0,0   several angles
//   /dev/samples.html?mode=tone;rings=72;size=400  raw | auto-tone lightness | ring-blurred field
//   /dev/samples.html?mode=spiral;ids=bust;size=500;rings=72   raw | field | real spiral render
//   /dev/samples.html?mode=time                    cold (compile + render) and warm times per sample
//   /dev/samples.html?mode=det                     determinism: two fresh renders compared per sample
// Sets window.__done = { ok, file, report } for tests/shoot.mjs.
import { SAMPLES, makeSample } from '../js/samples.js';
import { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS } from '../js/tone.js';

const q = new URLSearchParams(location.search);
const mode = q.get('mode') || 'raw';
const size = +(q.get('size') || 512);
const ids = (q.get('ids') || SAMPLES.map(s => s.id).join(',')).split(',');
const view = q.get('view') ? q.get('view').split(',').map(Number) : undefined;
const log = t => { document.getElementById('log').textContent += t + '\n'; };

async function save(canvas, name, type = 'image/png') {
  const data = canvas.toDataURL(type, 0.92);
  const r = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data }) });
  return r.json();
}

function sheet(cols, rows, cell, label = 18) {
  const c = document.createElement('canvas');
  c.width = cols * cell; c.height = rows * (cell + label);
  const g = c.getContext('2d');
  g.fillStyle = '#d9d5ce'; g.fillRect(0, 0, c.width, c.height);
  return { c, put(img, col, row, text) {
    g.drawImage(img, col * cell, row * (cell + label), cell, cell);
    g.fillStyle = '#222'; g.font = '12px system-ui';
    g.fillText(text, col * cell + 6, row * (cell + label) + cell + 13);
  } };
}

// Lightness array (0..1) -> greyscale canvas, with the art circle outlined.
function greyCanvas(L, G, circle = true) {
  const c = document.createElement('canvas'); c.width = c.height = G;
  const g = c.getContext('2d');
  const img = g.createImageData(G, G);
  for (let i = 0; i < G * G; i++) {
    const v = Math.round(Math.max(0, Math.min(1, L[i])) * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  if (circle) { g.strokeStyle = 'rgba(255,0,0,0.5)'; g.lineWidth = 2; g.beginPath(); g.arc(G / 2, G / 2, G / 2 - 1, 0, 7); g.stroke(); }
  return c;
}

function sync(canvas) { canvas.getContext('2d').getImageData(0, 0, 1, 1); }

async function run() {
  let out, name, report;
  if (mode === 'raw') {
    const S = sheet(ids.length, 1, size);
    for (const [i, id] of ids.entries()) S.put(await makeSample(id, size, { view }), i, 0, id);
    out = S.c; name = q.get('shot') || 'sample_raw';
  } else if (mode === 'views') {
    // one subject from several angles: views=yaw,pitch,roll~yaw,pitch,roll~...
    const id = q.get('id') || 'bust';
    const list = (q.get('views') || '0,0,0~0.33,0,0~-1.24,0,0~0.5,0,0').split('~').map(v => v.split(',').map(Number));
    const S = sheet(list.length, 1, size);
    for (const [i, v] of list.entries()) S.put(await makeSample(id, size, { view: v }), i, 0, `${id} ${v.join(',')}`);
    out = S.c; name = q.get('shot') || `sample_${id}_views`;
  } else if (mode === 'one') {
    const id = q.get('id') || 'bust';
    out = await makeSample(id, size, { view });
    name = q.get('shot') || `sample_${id}`;
  } else if (mode === 'tone') {
    const rings = +(q.get('rings') || 72);
    const S = sheet(3, ids.length, size);
    report = [];
    for (const [r, id] of ids.entries()) {
      const src = await makeSample(id, 1024, { view });
      const raster = rasterize(src, CROP_DEFAULTS);
      const tone = processTone(raster, TONE_DEFAULTS, { flip: false });
      const field = buildField(raster, tone.L, { rings, flip: false });
      const Lf = new Float32Array(field.D.length);
      for (let i = 0; i < Lf.length; i++) Lf[i] = 1 - field.D[i];
      S.put(src, 0, r, `${id} raw`);
      S.put(greyCanvas(tone.L, raster.G), 1, r, `auto tone (gamma ${tone.stats.gamma.toFixed(2)}, std ${tone.stats.std.toFixed(3)})`);
      S.put(greyCanvas(Lf, raster.G), 2, r, `field @ ${rings} rings`);
      report.push({ id, ...Object.fromEntries(Object.entries(tone.stats).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v])) });
    }
    out = S.c; name = q.get('shot') || 'sample_tone';
  } else if (mode === 'spiral') {
    // raw | field | real spiral render (engine defaults), one row per sample
    const { Renderer } = await import('../js/renderer.js');
    const { buildSpiral, LINE_DEFAULTS } = await import('../js/spiral.js');
    const { brushById, paperById, inkMode } = await import('../js/materials.js');
    const rings = +(q.get('rings') || 72);
    const brush = brushById(q.get('brush') || 'fineliner'), paper = paperById(q.get('paper') || 'cream');
    const ink = q.get('ink') || brush.inks[0][0];
    const mode2 = inkMode(brush, ink, paper);
    const r = new Renderer(document.createElement('canvas'));
    const S = sheet(3, ids.length, size);
    for (const [row, id] of ids.entries()) {
      const src = await makeSample(id, 1024, { view });
      const raster = rasterize(src, CROP_DEFAULTS);
      const tone = processTone(raster, TONE_DEFAULTS, { flip: mode2.flip });
      const field = buildField(raster, tone.L, { rings, flip: mode2.flip });
      const Lf = new Float32Array(field.D.length);
      for (let i = 0; i < Lf.length; i++) Lf[i] = 1 - field.D[i];
      const geom = buildSpiral(field, { ...LINE_DEFAULTS, rings });
      const px = size * 2;
      r.setSize(px, px); r.setLayout({ cx: 0.5, cy: 0.5, r: 0.42 }); r.setPaper(paper, 1);
      r.setStyle({ brush, ink, cover: mode2.cover, photoColor: false }); r.setGeometry(geom); r.render(Infinity);
      S.put(src, 0, row, `${id} raw`);
      S.put(greyCanvas(Lf, raster.G), 1, row, `field @ ${rings} rings (gamma ${tone.stats.gamma.toFixed(2)})`);
      S.put(r.canvas, 2, row, `${brush.name} · ${paper.name} · ${rings} rings`);
    }
    out = S.c; name = q.get('shot') || 'sample_spiral';
  } else if (mode === 'time') {
    const S = sheet(ids.length, 1, 256);
    report = [];
    for (const [i, id] of ids.entries()) {
      let t0 = performance.now();
      const a = await makeSample(id, 1024);
      sync(a);
      const cold = performance.now() - t0;
      t0 = performance.now();
      const b = await makeSample(id, 1024, { view: [0, 0, 0, 0] });   // new cache key: renders again
      sync(b);
      const warm = performance.now() - t0;
      report.push({ id, coldMs: +cold.toFixed(1), warmMs: +warm.toFixed(1) });
      S.put(a, i, 0, `${id} ${cold.toFixed(0)} / ${warm.toFixed(0)} ms`);
    }
    out = S.c; name = q.get('shot') || 'sample_time';
  } else if (mode === 'det') {
    report = [];
    for (const id of ids) {
      const a = await makeSample(id, 512);
      const b = await makeSample(id, 512, { view: [0, 0, 0, 0] });
      const da = a.getContext('2d').getImageData(0, 0, 512, 512).data;
      const db = b.getContext('2d').getImageData(0, 0, 512, 512).data;
      let diff = 0, maxd = 0;
      for (let i = 0; i < da.length; i++) { const d = Math.abs(da[i] - db[i]); if (d) diff++; if (d > maxd) maxd = d; }
      report.push({ id, differingBytes: diff, maxDiff: maxd });
    }
    out = document.createElement('canvas'); out.width = out.height = 8;
    name = 'sample_det';
  }
  if (report) log(JSON.stringify(report, null, 1));
  const res = await save(out, name, q.get('jpg') ? 'image/jpeg' : 'image/png');
  window.__done = { ok: true, report, ...res };
  document.body.append(out);
}

run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
