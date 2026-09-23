// Line art lab: the extracted strokes, coloured by kind, over the photo and alone on white.
//   node tests/shoot.mjs "/dev/lineart_lines.html?img=sample:bust;details=0.2,0.5,0.9;name=la_lines_bust"
//   img = sample:<bust|cat|peaks|moon> | <url>;  all=1 also draws every traced line faintly
//   engine = auto | xdog (force the fallback);  size = model input px (512);  cell = panel px
// Sheet: row 0 photo | line map | face landmarks;  then per detail: over the photo | alone on white.
// Sets window.__done = { ok, file, report } for tests/shoot.mjs.
import { extractLines, frameCanvas } from '../js/lineart/lines.js';
import { KIND_COLORS, strokeLength, validateStrokes } from '../js/lineart/strokes.js';
import { CROP_DEFAULTS } from '../js/tone.js';

const q = new URLSearchParams(location.search);
const details = (q.get('details') || '0.2,0.5,0.9').split(',').map(Number);
const cell = +(q.get('cell') || 400);
const size = +(q.get('size') || 512);
const engine = q.get('engine') || 'auto';
const backend = q.get('backend') || 'auto';
const name = q.get('name') || 'la_lines';
const log = t => { document.getElementById('log').textContent += t + '\n'; };

async function loadImage(spec) {
  if (spec.startsWith('sample:')) {
    const { makeSample } = await import('../js/samples.js');
    return makeSample(spec.slice(7), 1024);
  }
  const img = new Image(); img.src = spec; await img.decode(); return img;
}

function drawStrokes(g, strokes, S, { colour = true, width = 2 } = {}) {
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (const s of strokes) {
    const p = s.points;
    g.strokeStyle = colour ? KIND_COLORS[s.kind] : '#1b1a17';
    g.lineWidth = width * (0.6 + 0.8 * s.saliency);
    g.beginPath();
    g.moveTo(p[0] * S, p[1] * S);
    for (let i = 2; i < p.length; i += 2) g.lineTo(p[i] * S, p[i + 1] * S);
    if (s.closed) g.closePath();
    g.stroke();
  }
}

function legend(g, x, y) {
  let xx = x;
  g.font = '11px system-ui';
  for (const [k, c] of Object.entries(KIND_COLORS)) {
    g.fillStyle = c; g.fillRect(xx, y - 8, 10, 10);
    g.fillStyle = '#222'; g.fillText(k, xx + 13, y + 1);
    xx += g.measureText(k).width + 26;
  }
}

async function run() {
  const src = await loadImage(q.get('img') || 'sample:bust');
  const crop = { ...CROP_DEFAULTS };
  const label = 34;
  const cols = Math.max(3, details.length);
  const c = document.createElement('canvas');
  c.width = cols * cell; c.height = 3 * (cell + label) + 24;
  const g = c.getContext('2d');
  g.fillStyle = '#e7e3dc'; g.fillRect(0, 0, c.width, c.height);
  const text = (t, col, row, line = 0) => {
    g.fillStyle = '#222'; g.font = '12px system-ui';
    g.fillText(t, col * cell + 6, row * (cell + label) + cell + 14 + line * 14);
  };
  const photo = frameCanvas(src, crop, cell);
  const report = { img: q.get('img'), engine, runs: [] };

  let first = null;
  for (let k = 0; k < details.length; k++) {
    const d = details[k];
    const r = await extractLines(src, crop, { detail: d, size, engine, backend, debugInk: k === 0, debugAll: q.get('all') === '1' });
    if (!first) first = r;
    const v = validateStrokes(r.strokes);
    const total = r.strokes.reduce((s, x) => s + strokeLength(x), 0);
    const kinds = {};
    r.strokes.forEach(s => { kinds[s.kind] = (kinds[s.kind] || 0) + 1; });
    report.runs.push({ detail: d, n: r.strokes.length, length: +total.toFixed(2), valid: v.ok, kinds, timings: r.timings, engine: r.engine, stats: r.stats, modelError: r.modelError, faceError: r.faceError });
    log(JSON.stringify(report.runs[report.runs.length - 1]));
    // over the photo
    const x0 = k * cell, y1 = 1 * (cell + label), y2 = 2 * (cell + label);
    g.save(); g.translate(x0, y1);
    g.drawImage(photo, 0, 0); g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillRect(0, 0, cell, cell);
    drawStrokes(g, r.strokes, cell, { width: 2.2 });
    g.restore();
    text(`detail ${d}: ${r.strokes.length} strokes, length ${total.toFixed(1)} frames, ${r.engine}`, k, 1);
    text(`forced: ${(r.stats.forced || []).join(' ') || '-'}`, k, 1, 1);
    // alone on white
    g.save(); g.translate(x0, y2);
    g.fillStyle = '#fff'; g.fillRect(0, 0, cell, cell);
    if (r.all) { g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 1; for (const p of r.all) { g.beginPath(); g.moveTo(p[0] * cell, p[1] * cell); for (let i = 2; i < p.length; i += 2) g.lineTo(p[i] * cell, p[i + 1] * cell); g.stroke(); } }
    drawStrokes(g, r.strokes, cell, { width: 1.8 });
    g.restore();
    const t = r.timings;
    text(`${t.backend || ''} face ${t.face ?? '-'} ms, load ${t.modelLoad ?? '-'} ms, infer ${t.inference ?? (t.cached ? 'cached' : '-')} ms, vec ${t.vectorise} ms`, k, 2);
  }
  // row 0: photo | line map | landmarks
  g.drawImage(photo, 0, 0);
  text(`photo (${q.get('img')})`, 0, 0);
  if (first.ink) {
    const N = first.N, im = new ImageData(N, N);
    for (let i = 0; i < N * N; i++) { const v = 255 * (1 - first.ink[i]); im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255; }
    const t = Object.assign(document.createElement('canvas'), { width: N, height: N });
    t.getContext('2d').putImageData(im, 0, 0);
    g.drawImage(t, cell, 0, cell, cell);
    text(`line map (${first.engine}${first.modelError ? ': ' + first.modelError.slice(0, 40) : ''})`, 1, 0);
  }
  g.save(); g.translate(2 * cell, 0);
  g.drawImage(photo, 0, 0);
  const f = first.features.face;
  if (f) {
    g.fillStyle = '#e11d48';
    for (let i = 0; i < f.landmarks.length / 2; i++) g.fillRect(f.landmarks[i * 2] * cell - 1, f.landmarks[i * 2 + 1] * cell - 1, 2, 2);
    g.strokeStyle = '#2563eb'; g.lineWidth = 1.5; g.strokeRect(f.box.x * cell, f.box.y * cell, f.box.w * cell, f.box.h * cell);
  }
  g.restore();
  text(f ? 'face landmarks (478)' : `no face${first.faceError ? ': ' + first.faceError.slice(0, 50) : ''}`, 2, 0);
  legend(g, 8, c.height - 8);

  const data = c.toDataURL('image/png');
  const res = await (await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data }) })).json();
  report.crossOriginIsolated = self.crossOriginIsolated;
  window.__done = { ok: report.runs.every(r => r.valid), file: res.file, report };
}

run().catch(e => { log('ERROR ' + (e.stack || e)); window.__done = { ok: false, error: String(e.stack || e) }; });
