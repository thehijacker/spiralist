// Free-flowing single lines that start where the user points.
//
//   Wander  — the line meanders in unexpected directions across the whole image. Points are
//             scattered with blue-noise spacing that shrinks where the photo is dark (a
//             variable-radius Poisson disk), joined into one route that begins at the chosen point
//             (nearest-neighbour tour, then 2-opt so it never crosses itself), and drawn through
//             them as a smooth centripetal Catmull-Rom curve. Tone comes from how densely the line
//             packs, plus a little pressure.
//   Contour — a continuous-line drawing: the line traces the outlines of the subject (iso-contours
//             of the tone field at a few levels, like the edges of light and shadow) and glides
//             from one outline to the next with thin gestural strokes, never lifting the pen.
//
// Both return the spiral's geometry format (spiral.js), so rendering, pacing, film and export work
// unchanged. Coordinates: circle units, the art square is [-1,1]^2 (optionally masked to a circle).

import { sampleField, sampleColor, ensureFieldColor, boxBlur, boxRadiusForSigma } from './tone.js';
import { STRIDE, MAX_POINTS, LINE_DEFAULTS, wobbleOffset, finishGeometry } from './spiral.js';

export const FREE_DEFAULTS = Object.freeze({
  shape: 'square',   // 'square' | 'circle'
  x: 0, y: 0,        // start point, circle units
  seed: 1,
  flow: 0.8,         // maze only: corridors follow the photo's contours
});

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const insideFrame = (shape, x, y, margin) => (shape === 'circle'
  ? x * x + y * y <= (1 - margin) * (1 - margin)
  : Math.abs(x) <= 1 - margin && Math.abs(y) <= 1 - margin);
const edgeDistance = (shape, x, y) => (shape === 'circle' ? 1 - Math.hypot(x, y) : 1 - Math.max(Math.abs(x), Math.abs(y)));

// ------------------------------------------------------------------------------ uniform grid
/** Bucket grid over [-1,1]^2 for neighbour queries. */
class Grid {
  constructor(cell) {
    this.cell = cell;
    this.n = Math.max(1, Math.ceil(2 / cell));
    this.heads = new Int32Array(this.n * this.n).fill(-1);
    this.next = [];
  }
  key(x, y) {
    const i = Math.min(this.n - 1, Math.max(0, Math.floor((x + 1) / this.cell)));
    const j = Math.min(this.n - 1, Math.max(0, Math.floor((y + 1) / this.cell)));
    return j * this.n + i;
  }
  add(id, x, y) {
    const k = this.key(x, y);
    this.next[id] = this.heads[k];
    this.heads[k] = id;
  }
}

// ------------------------------------------------------------------------------ wander
/**
 * Variable-radius Poisson disk: radius shrinks with darkness. Returns Float64Array [x0,y0,x1,y1..]
 * with the start point first.
 */
function stipple(field, { hMin, hMax, gamma, shape, x0, y0, seed, maxPoints }) {
  const rand = mulberry32(seed * 7919 + 17);
  // line length per area ~ 1 / spacing, so spacing ~ 1 / darkness keeps tone linear
  const floor = hMin / hMax;
  const radius = (x, y) => {
    const D = Math.pow(Math.max(0, sampleField(field, x, y)), gamma);
    return hMin / (floor + (1 - floor) * D);
  };
  const grid = new Grid(hMin);
  const reach = Math.ceil(hMax / hMin);
  const xs = [], ys = [], rs = [];
  const active = [];
  const margin = hMin * 0.6;
  const add = (x, y) => {
    const id = xs.length;
    xs.push(x); ys.push(y); rs.push(radius(x, y));
    grid.add(id, x, y);
    active.push(id);
  };
  const ok = (x, y, r) => {
    if (!insideFrame(shape, x, y, margin)) return false;
    const ci = Math.floor((x + 1) / grid.cell), cj = Math.floor((y + 1) / grid.cell);
    for (let dj = -reach; dj <= reach; dj++) {
      const j = cj + dj;
      if (j < 0 || j >= grid.n) continue;
      for (let di = -reach; di <= reach; di++) {
        const i = ci + di;
        if (i < 0 || i >= grid.n) continue;
        for (let id = grid.heads[j * grid.n + i]; id >= 0; id = grid.next[id]) {
          const need = 0.5 * (r + rs[id]);
          const dx = xs[id] - x, dy = ys[id] - y;
          if (dx * dx + dy * dy < need * need) return false;
        }
      }
    }
    return true;
  };
  add(Math.max(-1 + margin, Math.min(1 - margin, x0)), Math.max(-1 + margin, Math.min(1 - margin, y0)));
  if (!insideFrame(shape, xs[0], ys[0], margin)) { xs[0] = 0; ys[0] = 0; }
  // seed a sparse lattice too, so disconnected regions of the frame are always reached
  const lattice = hMax * 3;
  for (let y = -1 + lattice / 2; y < 1; y += lattice) {
    for (let x = -1 + lattice / 2; x < 1; x += lattice) {
      const jx = x + (rand() - 0.5) * lattice * 0.5, jy = y + (rand() - 0.5) * lattice * 0.5;
      if (ok(jx, jy, radius(jx, jy))) add(jx, jy);
    }
  }
  while (active.length && xs.length < maxPoints) {
    const k = Math.floor(rand() * active.length);
    const id = active[k];
    const r = rs[id];
    let placed = false;
    for (let t = 0; t < 24; t++) {
      const a = rand() * Math.PI * 2;
      const d = r * (1 + rand());
      const x = xs[id] + Math.cos(a) * d, y = ys[id] + Math.sin(a) * d;
      const rr = radius(x, y);
      if (ok(x, y, rr)) { add(x, y); placed = true; break; }
    }
    if (!placed) { active[k] = active[active.length - 1]; active.pop(); }
  }
  const out = new Float64Array(xs.length * 2);
  for (let i = 0; i < xs.length; i++) { out[2 * i] = xs[i]; out[2 * i + 1] = ys[i]; }
  return out;
}

/** k nearest neighbours for every point (grid search). */
function knn(pts, k, cell) {
  const n = pts.length / 2;
  const grid = new Grid(cell);
  for (let i = 0; i < n; i++) grid.add(i, pts[2 * i], pts[2 * i + 1]);
  const out = new Int32Array(n * k).fill(-1);
  const bestD = new Float64Array(k), bestI = new Int32Array(k);
  for (let i = 0; i < n; i++) {
    const x = pts[2 * i], y = pts[2 * i + 1];
    bestD.fill(Infinity); bestI.fill(-1);
    const ci = Math.floor((x + 1) / cell), cj = Math.floor((y + 1) / cell);
    for (let ring = 0; ring < grid.n; ring++) {
      // stop once the ring is farther than the current k-th best
      if (bestI[k - 1] >= 0 && (ring - 1) * cell > Math.sqrt(bestD[k - 1])) break;
      for (let dj = -ring; dj <= ring; dj++) {
        const j = cj + dj;
        if (j < 0 || j >= grid.n) continue;
        const step = (Math.abs(dj) === ring) ? 1 : 2 * ring;
        for (let di = -ring; di <= ring; di += step || 1) {
          const ii = ci + di;
          if (ii < 0 || ii >= grid.n) continue;
          for (let id = grid.heads[j * grid.n + ii]; id >= 0; id = grid.next[id]) {
            if (id === i) continue;
            const dx = pts[2 * id] - x, dy = pts[2 * id + 1] - y, d = dx * dx + dy * dy;
            if (d >= bestD[k - 1]) continue;
            let m = k - 1;
            while (m > 0 && bestD[m - 1] > d) { bestD[m] = bestD[m - 1]; bestI[m] = bestI[m - 1]; m--; }
            bestD[m] = d; bestI[m] = id;
          }
        }
      }
    }
    for (let m = 0; m < k; m++) out[i * k + m] = bestI[m];
  }
  return out;
}

/**
 * Cell order of a Moore curve (a closed Hilbert curve) over a 2^k x 2^k grid, via its L-system.
 * Closed means the route can start at ANY cell without a long jump back.
 */
function mooreOrder(k) {
  let s = 'LFL+F+LFL';
  for (let it = 1; it < k; it++) {
    let t = '';
    for (const c of s) t += c === 'L' ? '-RF+LFL+FR-' : c === 'R' ? '+LF-RFR-FL+' : c;
    s = t;
  }
  const n = 1 << k;
  const order = new Int32Array(n * n).fill(-1);
  // this axiom, started at (n/2, 0) heading +y, visits every cell and ends beside where it began
  let x = n / 2, y = 0, dx = 0, dy = 1, idx = 0;
  order[y * n + x] = idx++;
  for (const c of s) {
    if (c === 'F') { x += dx; y += dy; if (x >= 0 && y >= 0 && x < n && y < n && order[y * n + x] < 0) order[y * n + x] = idx++; }
    else if (c === '+') { const t = dx; dx = -dy; dy = t; }
    else if (c === '-') { const t = dx; dx = dy; dy = -t; }
  }
  return order;
}

/** Route through every point along a Moore curve, rotated so it starts at point 0. */
function curveTour(pts) {
  const n = pts.length / 2;
  const k = Math.max(3, Math.min(9, Math.ceil(Math.log2(Math.sqrt(n / 2)))));
  const side = 1 << k;
  const order = mooreOrder(k);
  const keyOf = i => {
    const cx = Math.min(side - 1, Math.max(0, Math.floor((pts[2 * i] + 1) / 2 * side)));
    const cy = Math.min(side - 1, Math.max(0, Math.floor((pts[2 * i + 1] + 1) / 2 * side)));
    // points sharing a cell are ordered by angle around its centre so they read as a small loop
    const ax = (pts[2 * i] + 1) / 2 * side - cx - 0.5, ay = (pts[2 * i + 1] + 1) / 2 * side - cy - 0.5;
    return order[cy * side + cx] + (Math.atan2(ay, ax) + Math.PI) / (2 * Math.PI + 1e-9) * 0.999;
  };
  const keys = new Float64Array(n);
  for (let i = 0; i < n; i++) keys[i] = keyOf(i);
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => keys[a] - keys[b]);
  const s0 = idx.indexOf(0);
  const tour = new Int32Array(n);
  for (let i = 0; i < n; i++) tour[i] = idx[(s0 + i) % n];
  return tour;
}

/** Nearest-neighbour route from point 0 through every point (open path). */
function nearestTour(pts, cell) {
  const n = pts.length / 2;
  const grid = new Grid(cell);
  // fill buckets in reverse so lists read in index order (determinism)
  for (let i = n - 1; i >= 0; i--) grid.add(i, pts[2 * i], pts[2 * i + 1]);
  const used = new Uint8Array(n);
  const tour = new Int32Array(n);
  let cur = 0;
  used[0] = 1;
  tour[0] = 0;
  const cellCount = new Int32Array(grid.n * grid.n);
  for (let i = 0; i < n; i++) cellCount[grid.key(pts[2 * i], pts[2 * i + 1])]++;
  cellCount[grid.key(pts[0], pts[1])]--;
  for (let t = 1; t < n; t++) {
    const x = pts[2 * cur], y = pts[2 * cur + 1];
    const ci = Math.floor((x + 1) / cell), cj = Math.floor((y + 1) / cell);
    let best = -1, bd = Infinity;
    for (let ring = 0; ring < grid.n * 2; ring++) {
      if (best >= 0 && (ring - 1) * cell > Math.sqrt(bd)) break;
      for (let dj = -ring; dj <= ring; dj++) {
        const j = cj + dj;
        if (j < 0 || j >= grid.n) continue;
        const step = Math.abs(dj) === ring ? 1 : 2 * ring;
        for (let di = -ring; di <= ring; di += step || 1) {
          const ii = ci + di;
          if (ii < 0 || ii >= grid.n) continue;
          const key = j * grid.n + ii;
          if (!cellCount[key]) continue;
          for (let id = grid.heads[key]; id >= 0; id = grid.next[id]) {
            if (used[id]) continue;
            const dx = pts[2 * id] - x, dy = pts[2 * id + 1] - y, d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = id; }
          }
        }
      }
    }
    used[best] = 1;
    cellCount[grid.key(pts[2 * best], pts[2 * best + 1])]--;
    tour[t] = best;
    cur = best;
  }
  return tour;
}

/**
 * 2-opt on an open path with neighbour lists. Removes crossings (a crossing is never shortest) and
 * straightens the route. The work budget is counted in moves, not time, so results are repeatable.
 */
function twoOpt(pts, tour, nbr, k, budget) {
  const n = tour.length;
  const pos = new Int32Array(n);
  for (let i = 0; i < n; i++) pos[tour[i]] = i;
  const dist = (a, b) => Math.hypot(pts[2 * a] - pts[2 * b], pts[2 * a + 1] - pts[2 * b + 1]);
  const reverse = (i, j) => {
    while (i < j) {
      const a = tour[i], b = tour[j];
      tour[i] = b; pos[b] = i; tour[j] = a; pos[a] = j;
      i++; j--;
    }
  };
  let work = 0;
  for (let pass = 0; pass < 8 && work < budget; pass++) {
    let improved = false;
    for (let i = 0; i < n - 1 && work < budget; i++) {
      const a = tour[i];
      for (let m = 0; m < k; m++) {
        const c = nbr[a * k + m];
        if (c < 0) break;
        const j = pos[c];
        const b = tour[i + 1];
        if (j > i + 1) {
          const d = j + 1 < n ? tour[j + 1] : -1;
          const gain = dist(a, b) + (d >= 0 ? dist(c, d) - dist(b, d) : 0) - dist(a, c);
          if (gain > 1e-12) { work += j - i; reverse(i + 1, j); improved = true; break; }
        } else if (j < i) {
          const e = tour[j + 1];
          const gain = dist(c, e) + dist(a, b) - dist(c, a) - dist(e, b);
          if (gain > 1e-12) { work += i - j; reverse(j + 1, i); improved = true; break; }
        }
      }
    }
    if (!improved) break;
  }
  return tour;
}

/** Centripetal Catmull-Rom through ordered points, sampled every `step`. Returns [x,y,curv,...]. */
function spline(pts, order, step) {
  const n = order.length;
  const P = i => { const k = order[Math.max(0, Math.min(n - 1, i))]; return [pts[2 * k], pts[2 * k + 1]]; };
  const out = [];
  let prevX = null, prevY = null, prevA = null;
  for (let i = 0; i < n - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const d = (a, b) => Math.max(1e-9, Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5));
    const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const m = Math.max(1, Math.ceil(len / step));
    for (let s = i === 0 ? 0 : 1; s <= m; s++) {
      const t = t1 + (t2 - t1) * (s / m);
      const lerp = (a, b, ta, tb) => {
        const w = (t - ta) / (tb - ta || 1);
        return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
      };
      const A1 = lerp(p0, p1, t0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, t0, t2), B2 = lerp(A2, A3, t1, t3);
      const C = lerp(B1, B2, t1, t2);
      let curv = 0;
      if (prevX !== null) {
        const a = Math.atan2(C[1] - prevY, C[0] - prevX);
        if (prevA !== null) {
          let da = a - prevA;
          while (da > Math.PI) da -= 2 * Math.PI;
          while (da < -Math.PI) da += 2 * Math.PI;
          curv = Math.abs(da) / Math.max(1e-6, Math.hypot(C[0] - prevX, C[1] - prevY));
        }
        prevA = a;
      }
      out.push(C[0], C[1], curv);
      prevX = C[0]; prevY = C[1];
    }
  }
  return out;
}

/**
 * Turn a dense centre-line [x,y,curv,...] into geometry: width from darkness (and a pressure
 * wobble), optional hand drift, colour, dwell from curvature.
 * `thin` (optional array) marks points that belong to gestural connectors (drawn as a hairline).
 */
function toGeometry(field, line, base, { h, shape, fade, seed, colorFromPhoto, thin = null, press = null, extra = {} }) {
  const L = { ...LINE_DEFAULTS, ...line };
  const count = base.length / 3;
  const data = new Float32Array(count * STRIDE);
  const colors = colorFromPhoto ? new Uint8Array(count * 4) : null;
  if (colorFromPhoto) ensureFieldColor(field);
  const rgb = [0, 0, 0], wob = [0, 0];
  const wobble = Math.max(0, Math.min(1, L.wobble));
  const wide = L.technique === 'wave' ? L.penWidth : L.weight;
  const wMax = h * Math.min(0.92, wide), wMin = h * Math.min(wMax / h, L.technique === 'wave' ? L.penWidth : L.hairline);
  let sAcc = 0, px = 0, py = 0;
  for (let i = 0; i < count; i++) {
    const bx = base[3 * i], by = base[3 * i + 1], curv = base[3 * i + 2];
    let D = press ? press[i] : sampleField(field, bx, by);
    if (fade > 0) D *= smoothstep(0, fade, edgeDistance(shape, bx, by));
    wobbleOffset(bx, by, wobble * 0.6, seed, wob);
    let x = bx + wob[0], y = by + wob[1];
    // hand drift and gestural arcs must never leave the frame
    if (shape === 'circle') { const r = Math.hypot(x, y); if (r > 0.999) { x *= 0.999 / r; y *= 0.999 / r; } }
    else { x = Math.max(-0.999, Math.min(0.999, x)); y = Math.max(-0.999, Math.min(0.999, y)); }
    let w = L.technique === 'wave' ? wMin : wMin + (wMax - wMin) * D;
    // a hand never presses evenly: slow pressure drift along the line
    w *= 1 + 0.12 * Math.sin(sAcc * 23.0 + seed) * Math.sin(sAcc * 7.3 + 1.7 * seed);
    if (thin && thin[i]) w = Math.min(w, wMin * 1.2);
    if (curv > 0) w = Math.min(w, 1.8 / curv);
    if (i) sAcc += Math.hypot(x - px, y - py);
    const o = i * STRIDE;
    data[o] = x; data[o + 1] = y; data[o + 2] = Math.max(0, w); data[o + 3] = sAcc; data[o + 4] = thin && thin[i] ? D * 0.3 : D;
    data[o + 6] = 1 + Math.min(2, curv * h * 0.35) * (0.5 + 0.5 * D);
    if (colors) {
      sampleColor(field, bx, by, rgb);
      colors[i * 4] = rgb[0]; colors[i * 4 + 1] = rgb[1]; colors[i * 4 + 2] = rgb[2]; colors[i * 4 + 3] = 255;
    }
    px = x; py = y;
  }
  const total = data[(count - 1) * STRIDE + 3] || 1;
  const rings = Math.round(1 / h);
  for (let i = 0; i < count; i++) data[i * STRIDE + 5] = data[i * STRIDE + 3] / total * rings;
  return finishGeometry({
    n: count, data, colors, rings, spacing: h, technique: L.technique,
    maxWidth: wMax, minWidth: wMin, penWidth: L.technique === 'wave' ? wMin : null,
    shape, startPoint: { x: base[0], y: base[1] }, ...extra,
  });
}

/**
 * Wander: one meandering, never-crossing line whose packing follows the photo's darkness.
 * @param opts { colorFromPhoto, draft } — draft uses fewer points for live gestures
 */
export function buildWander(field, line, free, opts = {}) {
  const L = { ...LINE_DEFAULTS, ...line };
  const F = { ...FREE_DEFAULTS, ...free };
  const detail = Math.max(12, Math.min(200, L.rings));
  // darkest areas: passes ~0.6 spiral-ring spacings apart; the lightest ~7x sparser
  const hMin = 0.6 / detail * (opts.draft ? 1.4 : 1);
  const hMax = hMin * 7;
  const pts = stipple(field, {
    hMin, hMax, gamma: 1.1, shape: F.shape, x0: F.x, y0: F.y, seed: F.seed | 0 || 1,
    maxPoints: Math.min(60000, Math.floor(MAX_POINTS / 12)),
  });
  const cell = hMin * 2;
  // a space-filling curve has no long jumps; 2-opt then untangles it into an organic, non-crossing route
  const tour = curveTour(pts);
  const K = 10;
  const nbr = knn(pts, K, cell);
  twoOpt(pts, tour, nbr, K, (opts.draft ? 30 : 200) * tour.length);
  // widths are relative to the densest packing, so dark passages stay lines, not a solid fill
  const h = hMin * 1.15;
  const step = Math.min(h / 3, 2 / field.G * 0.9);
  const base = spline(pts, tour, step);
  return toGeometry(field, { ...L, weight: Math.min(L.weight, 0.6), hairline: Math.max(0.1, L.hairline * 1.5) }, new Float64Array(base), {
    h, shape: F.shape, fade: Math.max(0, L.edgeFade) * h, seed: F.seed | 0 || 1,
    colorFromPhoto: opts.colorFromPhoto, extra: { path: 'wander', start: 'point' },
  });
}

// ------------------------------------------------------------------------------ contour
/** Marching squares on a scalar grid -> polylines (arrays of [x,y] in circle units). */
function isolines(values, G, level) {
  const at = (i, j) => values[j * G + i];
  const segs = new Map();                 // edge key -> [edge key, edge key] adjacency
  const pos = new Map();                  // edge key -> [x, y]
  const toC = v => (v + 0.5) / G * 2 - 1;
  const edgePoint = (i0, j0, i1, j1) => {
    const a = at(i0, j0), b = at(i1, j1);
    const t = (level - a) / (b - a || 1e-9);
    return [toC(i0 + (i1 - i0) * t), toC(j0 + (j1 - j0) * t)];
  };
  // edge ids: horizontal edge (i,j)-(i+1,j) = 2*(j*G+i); vertical (i,j)-(i,j+1) = 2*(j*G+i)+1
  const link = (e1, p1, e2, p2) => {
    if (!pos.has(e1)) pos.set(e1, p1);
    if (!pos.has(e2)) pos.set(e2, p2);
    if (!segs.has(e1)) segs.set(e1, []);
    if (!segs.has(e2)) segs.set(e2, []);
    segs.get(e1).push(e2);
    segs.get(e2).push(e1);
  };
  for (let j = 0; j < G - 1; j++) {
    for (let i = 0; i < G - 1; i++) {
      const v0 = at(i, j) > level, v1 = at(i + 1, j) > level, v2 = at(i + 1, j + 1) > level, v3 = at(i, j + 1) > level;
      const code = (v0 ? 1 : 0) | (v1 ? 2 : 0) | (v2 ? 4 : 0) | (v3 ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const T = 2 * (j * G + i), B = 2 * ((j + 1) * G + i), Lf = 2 * (j * G + i) + 1, R = 2 * (j * G + i + 1) + 1;
      const pT = () => edgePoint(i, j, i + 1, j), pB = () => edgePoint(i, j + 1, i + 1, j + 1);
      const pL = () => edgePoint(i, j, i, j + 1), pR = () => edgePoint(i + 1, j, i + 1, j + 1);
      switch (code) {
        case 1: case 14: link(Lf, pL(), T, pT()); break;
        case 2: case 13: link(T, pT(), R, pR()); break;
        case 3: case 12: link(Lf, pL(), R, pR()); break;
        case 4: case 11: link(R, pR(), B, pB()); break;
        case 6: case 9: link(T, pT(), B, pB()); break;
        case 7: case 8: link(Lf, pL(), B, pB()); break;
        case 5: link(Lf, pL(), T, pT()); link(R, pR(), B, pB()); break;
        case 10: link(T, pT(), R, pR()); link(Lf, pL(), B, pB()); break;
        default: break;
      }
    }
  }
  // walk chains
  const seen = new Set();
  const lines = [];
  const walk = (start) => {
    const chain = [start];
    seen.add(start);
    let prev = -1, cur = start;
    for (;;) {
      const nb = segs.get(cur).filter(e => e !== prev && !seen.has(e));
      if (!nb.length) break;
      prev = cur; cur = nb[0];
      seen.add(cur);
      chain.push(cur);
    }
    return chain;
  };
  // open chains first (start at endpoints), then loops
  for (const [e, nb] of segs) if (nb.length === 1 && !seen.has(e)) lines.push({ keys: walk(e), closed: false });
  for (const [e] of segs) if (!seen.has(e)) { const keys = walk(e); lines.push({ keys, closed: true }); }
  return lines.map(l => ({ closed: l.closed, pts: l.keys.map(k => pos.get(k)) }));
}

function polyLength(p) {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return s;
}

function chaikin(p, closed, iterations) {
  let q = p;
  for (let k = 0; k < iterations; k++) {
    const out = closed ? [] : [q[0]];
    const n = q.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = q[i], b = q[(i + 1) % n];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!closed) out.push(q[n - 1]);
    q = out;
  }
  return q;
}

/** Split polylines where they leave the frame. */
function clipToFrame(lines, shape, margin) {
  const out = [];
  for (const l of lines) {
    let cur = [];
    const allIn = l.pts.every(p => insideFrame(shape, p[0], p[1], margin));
    if (allIn) { out.push(l); continue; }
    for (const p of l.pts) {
      if (insideFrame(shape, p[0], p[1], margin)) cur.push(p);
      else if (cur.length) { out.push({ closed: false, pts: cur }); cur = []; }
    }
    if (cur.length) out.push({ closed: false, pts: cur });
  }
  return out;
}

/**
 * Canny edges on a G x G scalar grid, linked into chains. Returns [{ closed, pts: [[x,y]..], str: [..] }]
 * in circle units; str = edge strength relative to the high threshold (>= ~0.45).
 */
function cannyChains(src, G, { hiPct, loRatio, shape, margin }) {
  const N = G * G;
  const mag = new Float32Array(N), dir = new Uint8Array(N);
  for (let j = 1; j < G - 1; j++) for (let i = 1; i < G - 1; i++) {
    const a = src[(j - 1) * G + i - 1], b = src[(j - 1) * G + i], c = src[(j - 1) * G + i + 1];
    const d = src[j * G + i - 1], f = src[j * G + i + 1];
    const g = src[(j + 1) * G + i - 1], h = src[(j + 1) * G + i], k = src[(j + 1) * G + i + 1];
    const gx = (c + 2 * f + k) - (a + 2 * d + g), gy = (g + 2 * h + k) - (a + 2 * b + c);
    mag[j * G + i] = Math.hypot(gx, gy);
    let ang = Math.atan2(gy, gx) * 180 / Math.PI;
    if (ang < 0) ang += 180;
    dir[j * G + i] = ang < 22.5 || ang >= 157.5 ? 0 : ang < 67.5 ? 1 : ang < 112.5 ? 2 : 3;
  }
  // non-maximum suppression: keep only the ridge of each edge
  const OFF = [[1, 0], [1, 1], [0, 1], [-1, 1]];
  const nms = new Float32Array(N);
  for (let j = 1; j < G - 1; j++) for (let i = 1; i < G - 1; i++) {
    const p = j * G + i, m = mag[p];
    if (m <= 0) continue;
    const [ox, oy] = OFF[dir[p]];
    if (m >= mag[p + oy * G + ox] && m > mag[p - oy * G - ox]) nms[p] = m;
  }
  const inFrame = p => {
    const x = ((p % G) + 0.5) / G * 2 - 1, y = (((p / G) | 0) + 0.5) / G * 2 - 1;
    return insideFrame(shape, x, y, margin);
  };
  const vals = [];
  for (let p = 0; p < N; p += 3) if (nms[p] > 0 && inFrame(p)) vals.push(nms[p]);
  vals.sort((a, b) => a - b);
  const hi = vals[Math.floor(vals.length * hiPct)] || 1e9, lo = hi * loRatio;
  // hysteresis: weak edges survive only when connected to strong ones
  const edge = new Uint8Array(N);
  const stack = [];
  for (let p = 0; p < N; p++) if (nms[p] >= hi && inFrame(p)) { edge[p] = 1; stack.push(p); }
  while (stack.length) {
    const p = stack.pop();
    const i = p % G, j = (p / G) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 1 || jj < 1 || ii >= G - 1 || jj >= G - 1) continue;
      const q = jj * G + ii;
      if (!edge[q] && nms[q] >= lo && inFrame(q)) { edge[q] = 1; stack.push(q); }
    }
  }
  // link edge pixels into chains, preferring to keep going straight
  const seen = new Uint8Array(N);
  const nbrs = p => {
    const i = p % G, j = (p / G) | 0, out = [];
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const q = (j + dj) * G + i + di;
      if (edge[q] && !seen[q]) out.push(q);
    }
    return out;
  };
  const degree = p => {
    const i = p % G, j = (p / G) | 0;
    let d = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if ((di || dj) && edge[(j + dj) * G + i + di]) d++;
    return d;
  };
  const toC = p => [((p % G) + 0.5) / G * 2 - 1, (((p / G) | 0) + 0.5) / G * 2 - 1];
  const walk = start => {
    const chain = [start];
    seen[start] = 1;
    let cur = start, px = 0, py = 0;
    for (;;) {
      const cand = nbrs(cur);
      if (!cand.length) break;
      let best = cand[0], bs = -Infinity;
      for (const q of cand) {
        const dx = (q % G) - (cur % G), dy = ((q / G) | 0) - ((cur / G) | 0);
        const sc = (dx * px + dy * py) / Math.hypot(dx, dy) - (Math.abs(dx) + Math.abs(dy) === 2 ? 0.05 : 0);
        if (sc > bs) { bs = sc; best = q; }
      }
      px = (best % G) - (cur % G); py = ((best / G) | 0) - ((cur / G) | 0);
      seen[best] = 1;
      chain.push(best);
      cur = best;
    }
    return chain;
  };
  const chains = [];
  for (let p = 0; p < N; p++) if (edge[p] && !seen[p] && degree(p) === 1) chains.push({ closed: false, px: walk(p) });
  for (let p = 0; p < N; p++) if (edge[p] && !seen[p]) {
    const px = walk(p);
    const a = px[0], b = px[px.length - 1];
    const closed = px.length > 8 && Math.abs((a % G) - (b % G)) <= 1 && Math.abs(((a / G) | 0) - ((b / G) | 0)) <= 1;
    chains.push({ closed, px });
  }
  return chains.map(c => ({ closed: c.closed, pts: c.px.map(toC), str: c.px.map(p => Math.min(1.6, (nms[p] || mag[p]) / hi)) }));
}

/** Moving average of a polyline (window 2r+1); open ends keep their endpoints. */
function smoothChain(p, closed, r) {
  const n = p.length;
  if (n < 3) return p;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0, c = 0;
    const rr = closed ? r : Math.min(r, i, n - 1 - i);
    for (let k = -rr; k <= rr; k++) {
      const q = p[closed ? (i + k + n) % n : i + k];
      sx += q[0]; sy += q[1]; c++;
    }
    out[i] = [sx / c, sy / c];
  }
  return out;
}

function chaikinScalar(v, closed, iterations) {
  let q = v;
  for (let k = 0; k < iterations; k++) {
    const out = closed ? [] : [q[0]];
    const n = q.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = q[i], b = q[(i + 1) % n];
      out.push(a * 0.75 + b * 0.25, a * 0.25 + b * 0.75);
    }
    if (!closed) out.push(q[n - 1]);
    q = out;
  }
  return q;
}

/**
 * Contour: a continuous-line drawing of the subject's outlines. Edges are found where light meets
 * shadow (Canny), linked into strokes whose weight follows the edge strength, and joined into one
 * journey from the chosen point by thin gestural glides. Detail (line.rings) sets how many edges
 * are kept and how small a feature may be.
 */
export function buildContour(field, line, free, opts = {}) {
  const L = { ...LINE_DEFAULTS, ...line };
  const F = { ...FREE_DEFAULTS, ...free };
  const detail = Math.max(12, Math.min(200, L.rings));
  const h = 1 / detail;
  const k = Math.min(1, detail / 150);                 // 0 = only the boldest lines .. 1 = fine detail
  const G = Math.min(field.G, 512);
  const src = new Float32Array(G * G);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) src[j * G + i] = sampleField(field, (i + 0.5) / G * 2 - 1, (j + 0.5) / G * 2 - 1);
  boxBlur(src, G, boxRadiusForSigma(G * (0.004 + 0.007 * (1 - k))));
  const chains = cannyChains(src, G, { hiPct: 0.92 - 0.14 * k, loRatio: 0.45, shape: F.shape, margin: h * 0.8 });
  const minLen = 0.03 + 0.1 * (1 - k);
  let lines = [];
  for (const c of chains) {
    if (polyLength(c.pts) < minLen) continue;
    // pixel chains step in 45-degree stairs: average them out before rounding into a drawn curve
    const sm = smoothChain(c.pts, c.closed, 3);
    const pts = [], str = [];
    for (let i = 0; i < sm.length; i += 3) { pts.push(sm[i]); str.push(c.str[i]); }
    if (!c.closed && (sm.length - 1) % 3) { pts.push(sm[sm.length - 1]); str.push(c.str[c.str.length - 1]); }
    if (pts.length < 3) continue;
    lines.push({ closed: c.closed, pts: chaikin(pts, c.closed, 3), str: chaikinScalar(str, c.closed, 3) });
  }
  if (!lines.length) {
    // nothing to outline (a flat photo): a single loop, so there is still one line to draw
    const loop = [], str = [];
    for (let a = 0; a <= Math.PI * 2; a += 0.05) { loop.push([Math.cos(a) * 0.5, Math.sin(a) * 0.5]); str.push(0.6); }
    lines = [{ closed: false, pts: loop, str }];
  }

  // order the strokes into one journey from the chosen point; loops can be entered anywhere
  const rand = mulberry32((F.seed | 0) * 131 + 7);
  const route = [], rstr = [], connector = [];
  let cx = F.x, cy = F.y;
  const left = lines.slice();
  while (left.length) {
    let bi = -1, bj = 0, bd = Infinity, rev = false;
    for (let i = 0; i < left.length; i++) {
      const l = left[i];
      if (l.closed) {
        for (let j = 0; j < l.pts.length; j += 3) {
          const d = Math.hypot(l.pts[j][0] - cx, l.pts[j][1] - cy);
          if (d < bd) { bd = d; bi = i; bj = j; rev = false; }
        }
      } else {
        const a = l.pts[0], b = l.pts[l.pts.length - 1];
        const da = Math.hypot(a[0] - cx, a[1] - cy), db = Math.hypot(b[0] - cx, b[1] - cy);
        if (da < bd) { bd = da; bi = i; rev = false; }
        if (db < bd) { bd = db; bi = i; rev = true; }
      }
    }
    const l = left.splice(bi, 1)[0];
    let pts = l.pts, str = l.str;
    if (l.closed) {
      pts = pts.slice(bj).concat(pts.slice(0, bj + 1));
      str = str.slice(bj).concat(str.slice(0, bj + 1));
      if (rand() < 0.5) { pts.reverse(); str.reverse(); }
    } else if (rev) { pts = pts.slice().reverse(); str = str.slice().reverse(); }
    // a gestural glide from where the pen is to the next stroke: a gentle arc, drawn as a hairline
    if (route.length) {
      const [ex, ey] = pts[0];
      const dx = ex - cx, dy = ey - cy, d = Math.hypot(dx, dy);
      const bend = (rand() - 0.5) * 0.45 * d;
      const mx = (cx + ex) / 2 - dy / (d || 1) * bend, my = (cy + ey) / 2 + dx / (d || 1) * bend;
      const m = Math.max(2, Math.ceil(d / 0.01));
      for (let s = 1; s < m; s++) {
        const t = s / m;
        route.push([(1 - t) * (1 - t) * cx + 2 * (1 - t) * t * mx + t * t * ex, (1 - t) * (1 - t) * cy + 2 * (1 - t) * t * my + t * t * ey]);
        rstr.push(0.15); connector.push(1);
      }
    }
    for (let i = 0; i < pts.length; i++) { route.push(pts[i]); rstr.push(str[i]); connector.push(0); }
    [cx, cy] = pts[pts.length - 1];
  }

  // resample the route evenly, carrying pressure, the connector flag and a curvature estimate
  const step = Math.min(h / 3, 2 / field.G * 0.9);
  const base = [], thin = [], press = [];
  let prevA = null;
  for (let i = 0; i < route.length - 1; i++) {
    const [ax, ay] = route[i], [bx, by] = route[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const m = Math.max(1, Math.ceil(len / step));
    const a = Math.atan2(by - ay, bx - ax);
    let curv = 0;
    if (prevA !== null && len > 1e-9) {
      let da = a - prevA;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      curv = Math.abs(da) / len;
    }
    if (len > 1e-9) prevA = a;
    const glide = connector[i] || connector[i + 1];
    for (let s = i === 0 ? 0 : 1; s <= m; s++) {
      const t = s / m;
      base.push(ax + (bx - ax) * t, ay + (by - ay) * t, curv);
      thin.push(glide ? 1 : 0);
      const p = rstr[i] + (rstr[i + 1] - rstr[i]) * t;
      press.push(glide ? 0.1 : Math.max(0.12, Math.min(1, 0.25 + 0.6 * p)));
    }
    if (base.length / 3 > MAX_POINTS * 0.9) break;
  }
  return toGeometry(field, { ...L, hairline: Math.min(L.hairline, 0.08) }, new Float64Array(base), {
    h, shape: F.shape, fade: 0, seed: F.seed | 0 || 1, colorFromPhoto: opts.colorFromPhoto,
    thin, press, extra: { path: 'contour', start: 'point', levels: 1, outlines: lines.length },
  });
}
