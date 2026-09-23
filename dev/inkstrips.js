// Strip exactness for the wet media on the thirsty papers (S): dev/export.html?t=strips runs every
// brush on cream, where the fibre-scale feathering is off; this runs the cases that exercise it
// (and the cockle): a forced-strip export vs a single-pass export, pixel by pixel (must be 0).
//   node tests/shoot.mjs "/dev/inkstrips.html?size=2048;cases=fountain:kraft,brush:sketch"
import { exportPNG } from '../js/export.js';
import { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS } from '../js/tone.js';
import { buildSpiral, LINE_DEFAULTS } from '../js/spiral.js';
import { brushById, paperById, inkMode } from '../js/materials.js';
import { makeSample } from '../js/samples.js';

const q = new URLSearchParams(location.search);

async function pixels(blob, S) {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(S, S), g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, S, S).data;
}

async function run() {
  const S = +(q.get('size') || 2048), strip = +(q.get('strip') || 256);
  const cases = (q.get('cases') || 'fountain:kraft,fountain:sketch,marker:kraft,brush:sketch,watercolour:sketch,watercolour:coldpress').split(',');
  const src = await makeSample('bust', 1024);
  const raster = rasterize(src, CROP_DEFAULTS);
  const tone = processTone(raster, TONE_DEFAULTS, {});
  const field = buildField(raster, tone.L, { rings: 64 });
  const geom = buildSpiral(field, { ...LINE_DEFAULTS, rings: 64 }, {});
  const rows = [];
  for (const c of cases) {
    const [bid, pid] = c.split(':');
    const brush = brushById(bid), paper = paperById(pid), ink = brush.inks[0][0];
    const mode = inkMode(brush, ink, paper);
    const st = { geom, brush, paper, ink, cover: mode.cover, photoColor: false, layout: { cx: 0.5, cy: 0.5, r: 0.42 }, seed: 1, shape: 'circle' };
    const t0 = performance.now();
    const a = await pixels(await exportPNG(st, { size: S }), S);
    const t1 = performance.now();
    const stats = {};
    const b = await pixels(await exportPNG(st, { size: S, strip, stats }), S);
    let max = 0, n = 0;
    for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d) { n++; if (d > max) max = d; } }
    rows.push({ c, max, nDiff: n, singleMs: Math.round(t1 - t0), strips: stats.strips });
  }
  window.__done = { ok: rows.every(r => r.max === 0), rows };
}
run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
