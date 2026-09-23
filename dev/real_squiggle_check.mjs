// Node check for js/real/squiggle.js: build time, point count, constant width, one joined line.
//   node dev/real_squiggle_check.mjs
import { build, squiggleScale, PRESETS, formatDuration } from '../js/real/squiggle.js';
import { STRIDE } from '../js/spiral.js';

const G = 1024;
// a face-like test field: horizontal ramp plus a dark disc, so every tone occurs
const D = new Float32Array(G * G);
for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
  const u = x / (G - 1), cx = (x - G * 0.35) / G, cy = (y - G * 0.4) / G;
  D[y * G + x] = Math.min(1, u * 0.9 + (cx * cx + cy * cy < 0.01 ? 0.5 : 0));
}
const field = { G, D, rgb: null, raster: null, rings: 44 };

for (const [tool, preset] of [[0.4, 'quick'], [0.4, 'detailed'], [0.4, 'masterpiece'], [0.5, 'detailed'], [4, 'detailed']]) {
  const opts = { toolMm: tool, preset, ...(tool >= 2 ? { minRings: 11 } : {}) };
  const S = squiggleScale(opts);
  build(field, opts);                       // warm the JIT
  const g = build(field, opts);
  let wMin = Infinity, wMax = 0, maxGap = 0;
  for (let i = 0; i < g.n; i++) {
    const w = g.data[i * STRIDE + 2];
    wMin = Math.min(wMin, w); wMax = Math.max(wMax, w);
    if (i) maxGap = Math.max(maxGap, Math.hypot(g.data[i * STRIDE] - g.data[(i - 1) * STRIDE], g.data[i * STRIDE + 1] - g.data[(i - 1) * STRIDE + 1]));
  }
  console.log(`${tool} mm ${PRESETS[preset].name}: rings ${S.rings}, d ${(S.d * S.mmPerCU).toFixed(2)} mm, lamMin ${(S.lamMin * S.mmPerCU).toFixed(2)} mm, cMin ${S.cMin.toFixed(2)} | ` +
    `pts ${g.n}, ${g.real.buildMs} ms, ${g.real.lengthM} m, wiggles ${g.real.wiggles}, hand ${formatDuration(g.real.handSeconds)} | ` +
    `w ${(wMin * S.mmPerCU).toFixed(3)}..${(wMax * S.mmPerCU).toFixed(3)} mm, max chord ${(maxGap * S.mmPerCU).toFixed(3)} mm`);
}
