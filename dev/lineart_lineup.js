// Line art line-up: the four styles (A-D, js/lineart/styles.js LINE_STYLES) x subjects, end to end
// through the app's own engine (js/lineart/index.js: LineArtEngine.lines, then .build in its
// Worker) and the real renderer, on one sheet.
//   node tests/shoot.mjs "/dev/lineart_lineup.html?name=lineart_lineup_v2" --timeout 600000
//   vars     letters to draw (ABCD)          imgs   comma list (bust,cat,moon,face)
//   size     cell px (928)                   crop   x,y,w fractions: save one cell 1:1 cropped
//   name     output name (lineart_lineup)    seed   hand seed
//   inkcache 1 = reuse shots/_ink_<subject>.bin (the model's own line map, saved by a real run)
// Subjects: the samples, plus 'face' = the Plaster bust framed close on the face (no sample
// photo of a real person ships with the app).
import { Renderer } from '../js/renderer.js';
import { CROP_DEFAULTS } from '../js/tone.js';
import { brushById, paperById } from '../js/materials.js';
import { LineArtEngine, LINE_STYLES, LAYOUT_R } from '../js/lineart/index.js';

const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) ? +q.get(k) : d);

const SUBJECTS = {
  bust: { sample: 'bust', crop: CROP_DEFAULTS },
  cat: { sample: 'cat', crop: CROP_DEFAULTS },
  moon: { sample: 'moon', crop: CROP_DEFAULTS },
  peaks: { sample: 'peaks', crop: CROP_DEFAULTS },
  face: { sample: 'bust', crop: { x: 0.5, y: 0.4, zoom: 1.55, rotation: 0 } },
};

async function cachedInk(id) {
  if (q.get('inkcache') !== '1') return null;
  try {
    const r = await fetch(`/shots/_ink_${id}.bin?v=${Date.now()}`);
    if (!r.ok) return null;
    const b = await r.arrayBuffer();
    return b.byteLength === 512 * 512 * 4 ? new Float32Array(b) : null;
  } catch { return null; }
}

const fmtT = s => (s >= 60 ? `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s` : `${Math.round(s)} s`);

async function run() {
  const letters = (q.get('vars') || 'ABCD').split('');
  const imgs = (q.get('imgs') || 'bust,cat,moon,face').split(',');
  const size = num('size', 928);
  const crop = q.get('crop') ? q.get('crop').split(',').map(Number) : null;
  const HEAD = crop ? 0 : 92, FOOT = crop ? 0 : 62, GAP = crop ? 0 : 10;
  const cell = crop ? Math.round(crop[2] * size) : size;
  const sheet = document.createElement('canvas');
  sheet.width = letters.length * (cell + GAP) + GAP;
  sheet.height = HEAD + imgs.length * (cell + FOOT + GAP) + GAP;
  const g = sheet.getContext('2d');
  g.fillStyle = '#d9d6cf'; g.fillRect(0, 0, sheet.width, sheet.height);
  const r = new Renderer(document.createElement('canvas'));
  r.setSize(size, size);
  r.setLayout({ cx: 0.5, cy: 0.5, r: LAYOUT_R });
  const eng = new LineArtEngine();
  const byLetter = Object.fromEntries(LINE_STYLES.map(s => [s.letter, s]));
  const stats = [];
  if (HEAD) letters.forEach((L, ci) => {
    const V = byLetter[L], x = GAP + ci * (cell + GAP);
    g.fillStyle = '#111'; g.font = 'bold 44px system-ui'; g.fillText(L, x + 6, 50);
    g.font = 'bold 28px system-ui'; g.fillText(V.name, x + 52, 46);
    g.font = `${cell < 700 ? 13 : 17}px system-ui`; g.fillStyle = '#333';
    g.fillText(V.blurb, x + 8, 78, cell - 12);
  });
  const { makeSample } = await import('../js/samples.js');
  for (let ri = 0; ri < imgs.length; ri++) {
    const S = SUBJECTS[imgs[ri]];
    const src = await makeSample(S.sample, 1024);
    const ink = await cachedInk(imgs[ri]);
    for (let ci = 0; ci < letters.length; ci++) {
      const L = letters[ci], V = byLetter[L];
      const t0 = performance.now();
      const lines = await eng.lines(src, S.crop, { detail: V.defaults.detail, ink });
      const tEx = performance.now() - t0;
      const sheetMm = 210;
      const geom = await eng.build(V.id, lines, { sheetMm, seed: num('seed', 3) }, { tag: null });
      r.setSheetMm(sheetMm);
      r.setPaper(paperById(V.paper), 1);
      r.setStyle({ brush: brushById(V.tool), ink: V.ink, cover: false, photoColor: false });
      r.setGeometry(geom, { pacing: 'natural' });
      r.render(Infinity);
      const x = GAP + ci * (cell + GAP), y = HEAD + GAP + ri * (cell + FOOT + GAP);
      if (crop) g.drawImage(r.canvas, Math.round(crop[0] * size), Math.round(crop[1] * size), cell, cell, x, y, cell, cell);
      else g.drawImage(r.canvas, x, y, cell, cell);
      const la = geom.lineart;
      if (FOOT) {
        const fs = cell < 700 ? 15 : 19;
        g.fillStyle = '#111'; g.font = `bold ${fs + 1}px system-ui`;
        g.fillText(`${L} · ${imgs[ri]}  ·  ${la.lengthM} m  ·  ${fmtT(la.handSeconds)} by hand`, x + 6, y + cell + fs + 8, cell - 12);
        g.font = `${fs - 1}px system-ui`; g.fillStyle = '#333';
        g.fillText(`new ${la.drawnM} · retraced ${la.retracedM}${la.hatchM ? ' · hatch ' + la.hatchM : ''} m  ·  ${V.tool} ${V.toolMm} mm on ${V.paper}${la.engine && la.engine !== 'model' ? ' · ' + la.engine : ''}`, x + 6, y + cell + 2 * fs + 14, cell - 12);
      }
      stats.push({ v: L, img: imgs[ri], in: lines.strokes.length, picked: la.picked, used: la.strokes, dropped: la.dropped, lengthM: la.lengthM, drawnM: la.drawnM, retracedM: la.retracedM, bridgesM: la.bridgesM, hatchM: la.hatchM, hand: Math.round(la.handSeconds), engine: la.engine, face: !!(lines.features && lines.features.face), linesMs: Math.round(tEx), inference: lines.timings && lines.timings.inference, cached: !!lines.cached || !!(lines.timings && lines.timings.cached), buildMs: la.buildMs, waitMs: la.timings.waitMs });
    }
  }
  const name = q.get('name') || 'lineart_lineup';
  const res = await (await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data: sheet.toDataURL('image/jpeg', 0.9) }) })).json();
  window.__done = { ok: true, file: res.file || name, w: sheet.width, h: sheet.height, stats };
}
run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
