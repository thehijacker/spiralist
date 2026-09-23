// Node check for js/real/scribble.js on synthetic fields (no DOM):
//   node dev/real_scribble_check.mjs
// One polyline, constant width equal to the tool, point budget, and line density rising with darkness.
import { build, SCRIBBLE_PRESETS } from '../js/real/scribble.js';
import { STRIDE, MAX_POINTS } from '../js/spiral.js';

const G = 512;
function field(fn) {
  const D = new Float32Array(G * G);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) D[y * G + x] = fn((x + 0.5) / G * 2 - 1, (y + 0.5) / G * 2 - 1);
  return { G, D, rgb: null, rings: 110 };
}
const fail = [];
const ramp = field(x => (1 - x) / 2);            // dark on the left
for (const preset of Object.keys(SCRIBBLE_PRESETS)) {
  for (const toolMm of [0.4, 4]) {
    const g = build(ramp, { toolMm, preset, vignette: 0 });
    const F = 210 * 0.42, d = g.data;
    let wBad = 0;
    for (let i = 0; i < g.n; i++) if (Math.abs(d[i * STRIDE + 2] * F - toolMm) > 1e-4) wBad++;
    if (wBad) fail.push(`${preset}@${toolMm}: ${wBad} points with another width`);
    if (g.n >= MAX_POINTS || g.stats.truncated) fail.push(`${preset}@${toolMm}: point budget`);
    // s must grow by exactly the segment lengths (one joined polyline, no lifts)
    let sErr = 0;
    for (let i = 1; i < g.n; i++) {
      const ds = Math.hypot(d[i * STRIDE] - d[(i - 1) * STRIDE], d[i * STRIDE + 1] - d[(i - 1) * STRIDE + 1]);
      sErr = Math.max(sErr, Math.abs(d[i * STRIDE + 3] - d[(i - 1) * STRIDE + 3] - ds));
    }
    if (sErr > 1e-4) fail.push(`${preset}@${toolMm}: path length mismatch ${sErr}`);
    // density per vertical band must fall from dark (left) to light (right)
    const bands = 8, len = new Float64Array(bands);
    for (let i = 1; i < g.n; i++) {
      const xm = 0.5 * (d[i * STRIDE] + d[(i - 1) * STRIDE]);
      const b = Math.max(0, Math.min(bands - 1, Math.floor((xm + 1) / 2 * bands)));
      len[b] += Math.hypot(d[i * STRIDE] - d[(i - 1) * STRIDE], d[i * STRIDE + 1] - d[(i - 1) * STRIDE + 1]) * F;
    }
    const dens = Array.from(len, v => +(v / ((2 * F / bands) * 2 * F)).toFixed(3));
    for (let b = 1; b < bands; b++) if (dens[b] > dens[b - 1]) fail.push(`${preset}@${toolMm}: density not monotone ${dens}`);
    console.log(`${preset}@${toolMm}mm  ${g.stats.lengthM.toFixed(1)} m  ${(g.stats.handSeconds / 60).toFixed(1)} min  ${g.n} pts  ${Math.round(g.stats.buildMs)} ms  density ${dens.join(' ')}`);
  }
}
console.log(fail.length ? 'FAIL\n' + fail.join('\n') : 'ok');
process.exit(fail.length ? 1 : 0);
