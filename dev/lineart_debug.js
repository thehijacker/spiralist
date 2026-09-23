// Line art debug sheet: for each subject, the render, the plan (new line black, retrace grey,
// bridge red, hatch blue, start green dot) and the extracted strokes by kind.
// Uses js/lineart/index.js (LineArtEngine: lines + build in its Worker), like the app.
//   node tests/shoot.mjs "/dev/lineart_debug.html?imgs=bust,cat,moon;style=matisse;size=560;name=dbg"
//   inkcache=1 (default): the model's line map per subject is saved to shots/_ink_<id>.bin and reused
import { Renderer } from '../js/renderer.js';
import { CROP_DEFAULTS } from '../js/tone.js';
import { STRIDE } from '../js/spiral.js';
import { brushById, paperById } from '../js/materials.js';
import { LineArtEngine, lineStyleById, LAYOUT_R } from '../js/lineart/index.js';
import { KIND_COLORS } from '../js/lineart/strokes.js';

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) ? +q.get(k) : d);

export const SUBJECTS = {
  bust: { sample: 'bust', crop: CROP_DEFAULTS },
  cat: { sample: 'cat', crop: CROP_DEFAULTS },
  moon: { sample: 'moon', crop: CROP_DEFAULTS },
  peaks: { sample: 'peaks', crop: CROP_DEFAULTS },
  face: { sample: 'bust', crop: { x: 0.5, y: 0.4, zoom: 1.55, rotation: 0 } },
};

export async function loadSubject(id) {
  const S = SUBJECTS[id];
  const { makeSample } = await import('../js/samples.js');
  return { ...S, id, src: await makeSample(S.sample, 1024) };
}

/** The saved line map for a subject (dev speed-up), or null. */
export async function cachedInk(id) {
  if (q.get('inkcache') === '0') return null;
  try {
    const r = await fetch(`/shots/_ink_${id}.bin?v=${Date.now()}`);
    if (!r.ok) return null;
    const b = await r.arrayBuffer();
    return b.byteLength === 512 * 512 * 4 ? new Float32Array(b) : null;
  } catch { return null; }
}
export async function saveInk(id, ink) {
  if (!ink || q.get('inkcache') === '0') return;
  await fetch(`/__file?name=_ink_${id}.bin`, { method: 'POST', body: ink.buffer.slice(0) });
}

export async function linesFor(eng, subj, detail) {
  const ink = await cachedInk(subj.id);
  eng.keepInk = !ink;
  const r = await eng.lines(subj.src, subj.crop, { detail, ink });
  if (!ink && r.ink && r.engine === 'model') await saveInk(subj.id, r.ink);
  return r;
}

function drawPlan(g, geom, x0, y0, S) {
  const d = geom.data, seg = geom.lineart.seg, n = geom.n;
  const X = i => x0 + (d[i * STRIDE] * LAYOUT_R + 0.5) * S, Y = i => y0 + (d[i * STRIDE + 1] * LAYOUT_R + 0.5) * S;
  const col = ['#111', '#9a9a9a', '#e0201a', '#1f5fd6'];
  g.lineWidth = 1.6; g.lineCap = 'round';
  for (let i = 1; i < n; i++) {
    g.strokeStyle = col[seg[i]] || '#111';
    g.beginPath(); g.moveTo(X(i - 1), Y(i - 1)); g.lineTo(X(i), Y(i)); g.stroke();
  }
  g.fillStyle = '#0a0'; g.beginPath(); g.arc(X(0), Y(0), 5, 0, 7); g.fill();
  g.fillStyle = '#a0a'; g.beginPath(); g.arc(X(n - 1), Y(n - 1), 5, 0, 7); g.fill();
}

function drawStrokes(g, strokes, x0, y0, S) {
  g.lineWidth = 1.4;
  for (const s of strokes) {
    const p = s.points;
    g.strokeStyle = KIND_COLORS[s.kind] || '#000';
    g.beginPath();
    for (let k = 0; k < p.length; k += 2) {
      // the frame (0..1) maps onto the sheet's circle square: x_cu = 2p-1, sheet = cu*R+.5
      const x = x0 + ((p[k] * 2 - 1) * LAYOUT_R + 0.5) * S, y = y0 + ((p[k + 1] * 2 - 1) * LAYOUT_R + 0.5) * S;
      k ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  }
}

async function run() {
  const imgs = (q.get('imgs') || 'bust,cat,moon').split(',');
  const style = lineStyleById(q.get('style') || 'matisse');
  const S = num('size', 560);
  const eng = new LineArtEngine();
  const sheet = document.createElement('canvas');
  sheet.width = 3 * S; sheet.height = imgs.length * (S + 30);
  const g = sheet.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, sheet.width, sheet.height);
  const r = new Renderer(document.createElement('canvas'));
  r.setSize(S, S);
  r.setLayout({ cx: 0.5, cy: 0.5, r: LAYOUT_R });
  const stats = [];
  for (let ri = 0; ri < imgs.length; ri++) {
    const subj = await loadSubject(imgs[ri]);
    const detail = num('detail', style.defaults.detail);
    const lines = await linesFor(eng, subj, detail);
    const geom = await eng.build(style.id, lines, { sheetMm: 210, seed: num('seed', 3), hatch: q.has('hatch') ? num('hatch', 0) : undefined }, { tag: null });
    r.setSheetMm(210);
    r.setPaper(paperById(style.paper), 1);
    r.setStyle({ brush: brushById(style.tool), ink: style.ink, cover: false, photoColor: false });
    r.setGeometry(geom, { pacing: 'natural' });
    r.render(Infinity);
    const y = ri * (S + 30);
    g.drawImage(r.canvas, 0, y, S, S);
    drawPlan(g, geom, S, y, S);
    g.globalAlpha = 0.18; g.drawImage(subj.src, 2 * S + ((1 - LAYOUT_R * 2) / 2) * S, y + ((1 - LAYOUT_R * 2) / 2) * S, S * LAYOUT_R * 2, S * LAYOUT_R * 2); g.globalAlpha = 1;
    drawStrokes(g, lines.strokes, 2 * S, y, S);
    const la = geom.lineart;
    g.fillStyle = '#000'; g.font = '15px system-ui';
    g.fillText(`${subj.id} ${style.letter}  line ${la.lengthM} m  new ${la.drawnM}  retr ${la.retracedM}  bridge ${la.bridgesM}  hatch ${la.hatchM}  hand ${Math.round(la.handSeconds)} s  build ${la.buildMs} ms  wait ${la.timings.waitMs} ms`, 8, y + S + 20);
    stats.push({ img: subj.id, n: lines.strokes.length, kinds: lines.strokes.map(s => s.kind[0]).join(''), lengthM: la.lengthM, drawnM: la.drawnM, retracedM: la.retracedM, bridgesM: la.bridgesM, hatchM: la.hatchM, hand: Math.round(la.handSeconds), buildMs: la.buildMs, ms: la.ms, pts: la.points, pieces: la.strokes, waitMs: la.timings.waitMs, linesMs: lines.timings.total, engine: la.engine, stats: lines.stats });
  }
  const name = q.get('name') || 'la_dbg';
  const res = await (await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data: sheet.toDataURL('image/jpeg', 0.88) }) })).json();
  window.__done = { ok: true, file: res.file, stats };
}
if (!q.has('lib')) run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
