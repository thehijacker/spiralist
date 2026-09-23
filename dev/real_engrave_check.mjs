// Node check for js/real/engrave.js (no browser). For a horizontal ramp and a synthetic "portrait"
// (blobs and hard edges, so the flow bends the lines and the packing works), at each tool size:
//   - coverage per column bin of the ramp must fall monotonically from dark to light
//   - one line: consecutive points closer than a band, constant width, finite numbers
//   - no proper crossings (touching at forks is allowed; the pen reverses there)
//   - point budget and build time
//   node dev/real_engrave_check.mjs            exits 1 on any failure
import { build } from '../js/real/engrave.js';
import { MAX_POINTS } from '../js/spiral.js';

const G = 1024;
function rampField() {
  const D = new Float32Array(G * G);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) D[y * G + x] = 1 - (x + 0.5) / G;
  return { G, D, rings: 40 };
}
function blobField() {
  const D = new Float32Array(G * G);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    const u = x / G * 2 - 1, v = y / G * 2 - 1;
    let d = 0.25 + 0.5 * Math.exp(-((u + 0.3) ** 2 + (v - 0.1) ** 2) * 6);   // soft dark blob
    if ((u - 0.35) ** 2 + (v + 0.2) ** 2 < 0.09) d = 0.05;                   // light disc, hard edge
    if (Math.abs(u - 0.35) < 0.02 && v > 0.2) d = 0.95;                       // thin dark bar
    D[y * G + x] = d;
  }
  return { G, D, rings: 40 };
}

/** Count proper crossings between non-adjacent segments (uniform grid of segment boxes). */
function crossings(g) {
  const d = g.data, n = g.n, cell = 0.01, N = Math.ceil(2.2 / cell);
  const buckets = new Map();
  const key = (i, j) => i * 100003 + j;
  const cellOf = v => Math.floor((v + 1.1) / cell);
  for (let s = 0; s < n - 1; s++) {
    const x0 = d[s * 7], y0 = d[s * 7 + 1], x1 = d[s * 7 + 7], y1 = d[s * 7 + 8];
    for (let i = cellOf(Math.min(x0, x1)); i <= cellOf(Math.max(x0, x1)); i++) {
      for (let j = cellOf(Math.min(y0, y1)); j <= cellOf(Math.max(y0, y1)); j++) {
        if (i < 0 || j < 0 || i >= N || j >= N) continue;
        const k = key(i, j);
        let b = buckets.get(k);
        if (!b) buckets.set(k, b = []);
        b.push(s);
      }
    }
  }
  const orient = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const seen = new Set();
  let count = 0;
  const eps = 1e-12;
  for (const b of buckets.values()) {
    for (let p = 0; p < b.length; p++) for (let q = p + 1; q < b.length; q++) {
      const s = Math.min(b[p], b[q]), t = Math.max(b[p], b[q]);
      if (t - s <= 1) continue;
      const k = s * n + t;
      if (seen.has(k)) continue;
      seen.add(k);
      const ax = d[s * 7], ay = d[s * 7 + 1], bx = d[s * 7 + 7], by = d[s * 7 + 8];
      const cx = d[t * 7], cy = d[t * 7 + 1], dx = d[t * 7 + 7], dy = d[t * 7 + 8];
      const o1 = orient(ax, ay, bx, by, cx, cy), o2 = orient(ax, ay, bx, by, dx, dy);
      const o3 = orient(cx, cy, dx, dy, ax, ay), o4 = orient(cx, cy, dx, dy, bx, by);
      // strictly on opposite sides both ways: a real crossing, not a touch at a fork or cusp
      if (((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) && ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))) count++;
    }
  }
  return count;
}

let ok = true;
for (const [toolMm, levels] of [[0.8, 5], [0.4, 5], [0.25, 7], [4, 3]]) {
  for (const [name, field] of [['ramp', rampField()], ['blobs', blobField()]]) {
    const runs = [];
    let g;
    for (let i = 0; i < 3; i++) { g = build(field, { toolMm, levels }); runs.push(+g.real.buildMs.toFixed(1)); }
    const d = g.data, w = Math.fround(g.maxWidth);
    let maxStep = 0, widthOk = true, finite = true;
    const bins = 12, cov = new Float64Array(bins);
    for (let i = 0; i < g.n; i++) {
      for (let k = 0; k < 7; k++) if (!Number.isFinite(d[i * 7 + k])) finite = false;
      if (d[i * 7 + 2] !== w) widthOk = false;
      if (!i) continue;
      const x0 = d[(i - 1) * 7], y0 = d[(i - 1) * 7 + 1], x1 = d[i * 7], y1 = d[i * 7 + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      maxStep = Math.max(maxStep, len);
      const xm = (x0 + x1) / 2;
      if (Math.abs(xm) > 0.9 || Math.abs((y0 + y1) / 2) > 0.9) continue;
      cov[Math.min(bins - 1, Math.floor((xm + 0.9) / 1.8 * bins))] += len * w;
    }
    const coverage = [...cov].map(v => +(v / ((1.8 / bins) * 1.8)).toFixed(3));
    // pairs are at least ~3 bands long, so a 15 mm bin holds only a few of them per band with a
    // coarse tool: allow dither noise that grows with the tool width
    const tol = 0.005 + 0.03 * toolMm;
    const monotonic = coverage.every((v, i) => i === 0 || v <= coverage[i - 1] + tol);
    const cross = crossings(g);
    const pass = finite && widthOk && maxStep < g.spacing && cross === 0 && g.n < MAX_POINTS
      && (name !== 'ramp' || monotonic);
    ok = ok && pass;
    console.log(JSON.stringify({ field: name, toolMm, levels, pass, buildMs: runs, points: g.n,
      lengthM: +g.real.lengthM.toFixed(2), handMin: +g.real.handMin.toFixed(1), bands: g.real.bands,
      maxStep: +maxStep.toFixed(4), band: +g.spacing.toFixed(4), crossings: cross,
      ...(name === 'ramp' ? { coverage, monotonic } : {}) }));
  }
}
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
