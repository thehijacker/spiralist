// Node check for js/real/stipple.js (no browser, no GPU): the realistic-mode contract on a darkness ramp.
//   node dev/real_stipple_check.mjs [tool=0.5] [preset=detailed|quick|masterpiece]
// Checks: one polyline with a constant width equal to the real tool, no self-crossings (brute force,
// independent of the builder's own grid), point count under MAX_POINTS, and line density rising
// monotonically with darkness (length per band x tool width, 16 bands). Prints stats; exit 1 on failure.
import { build, STIPPLE_PRESETS } from '../js/real/stipple.js';
import { STRIDE, MAX_POINTS } from '../js/spiral.js';

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(k + '=')); return a ? a.slice(k.length + 1) : d; };
const toolMm = +arg('tool', 0.5), preset = arg('preset', 'detailed');
const G = 1024;
const D = new Float32Array(G * G);
for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) D[y * G + x] = x / (G - 1);
const field = { G, D, rgb: null, raster: null, rings: 200 };
build(field, { toolMm, preset });                       // warm the JIT, as the app would be
const g = build(field, { toolMm, preset, x: 0, y: -0.3 });
const { n, data } = g;
const fails = [];

// constant width = the tool
const t = toolMm / (0.42 * 210);
let wMin = Infinity, wMax = -Infinity;
for (let i = 0; i < n; i++) { wMin = Math.min(wMin, data[i * STRIDE + 2]); wMax = Math.max(wMax, data[i * STRIDE + 2]); }
if (Math.abs(wMin - t) > 1e-6 || Math.abs(wMax - t) > 1e-6) fails.push(`width ${wMin}..${wMax} != ${t}`);
if (n >= MAX_POINTS) fails.push(`points ${n} >= ${MAX_POINTS}`);
if (g.path !== 'real-stipple') fails.push('path');

// crossings, brute force over neighbouring coarse cells (segments bucketed by midpoint)
const orient = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
let maxSeg = 0;
for (let s = 0; s < n - 1; s++) maxSeg = Math.max(maxSeg, Math.hypot(data[(s + 1) * STRIDE] - data[s * STRIDE], data[(s + 1) * STRIDE + 1] - data[s * STRIDE + 1]));
const C = Math.max(0.01, maxSeg), nx = Math.ceil(2.2 / C), cells = new Map();
for (let s = 0; s < n - 1; s++) {
  const mx = (data[s * STRIDE] + data[(s + 1) * STRIDE]) / 2, my = (data[s * STRIDE + 1] + data[(s + 1) * STRIDE + 1]) / 2;
  const k = Math.floor((my + 1.1) / C) * nx + Math.floor((mx + 1.1) / C);
  if (!cells.has(k)) cells.set(k, []);
  cells.get(k).push(s);
}
let crossings = 0;
for (const [k, list] of cells) {
  const cx = k % nx, cy = Math.floor(k / nx);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const other = cells.get((cy + dy) * nx + cx + dx);
    if (!other) continue;
    for (const s of list) for (const u of other) {
      if (u <= s + 1) continue;
      const ax = data[s * STRIDE], ay = data[s * STRIDE + 1], bx = data[(s + 1) * STRIDE], by = data[(s + 1) * STRIDE + 1];
      const px = data[u * STRIDE], py = data[u * STRIDE + 1], qx = data[(u + 1) * STRIDE], qy = data[(u + 1) * STRIDE + 1];
      if (orient(ax, ay, bx, by, px, py) * orient(ax, ay, bx, by, qx, qy) >= 0) continue;
      if (orient(px, py, qx, qy, ax, ay) * orient(px, py, qx, qy, bx, by) >= 0) continue;
      crossings++;
    }
  }
}
if (crossings) fails.push(`${crossings} self-crossings`);

// density per band: line length x tool width / band area (a coverage estimate before the brush).
// The outer bands hold the frame margin and a stick has few stipples per band, so the check is over
// the interior bands (8 for a stick) and allows a 0.01 plateau where the darkest tone saturates.
const bands = toolMm > 1.2 ? 8 : 16, len = new Float64Array(bands);
for (let s = 0; s < n - 1; s++) {
  const mx = (data[s * STRIDE] + data[(s + 1) * STRIDE]) / 2;
  const b = Math.min(bands - 1, Math.max(0, Math.floor((mx + 1) / 2 * bands)));
  len[b] += Math.hypot(data[(s + 1) * STRIDE] - data[s * STRIDE], data[(s + 1) * STRIDE + 1] - data[s * STRIDE + 1]);
}
const cov = Array.from(len, l => +(l * t / (2 / bands * 2)).toFixed(3));
for (let b = 2; b < bands - 1; b++) if (cov[b] < cov[b - 1] - 0.01) fails.push(`density not monotonic at band ${b}`);

console.log(JSON.stringify({ preset: STIPPLE_PRESETS[preset].name, toolMm, ...g.real, crossings, lineCoverage: cov }));
console.log(fails.length ? 'FAIL: ' + fails.join('; ') : 'ok');
process.exit(fails.length ? 1 : 0);
