// Realistic mode, style B: STIPPLE TOUR (TSP art) drawn with ONE real tool at its real size.
//
// A person with a 0.5 mm fineliner (or a 4 mm charcoal stick) could draw this: the line never lifts,
// never changes width, never crosses itself. Tone comes only from how densely the line packs:
//   1. Stipples: a density field says how many points each patch of paper needs so that the tour
//      through them covers the wanted fraction of the paper with a line of the tool's width
//      (coverage ~ line length per area x tool width). Error diffusion places them on a fine grid,
//      then a few rounds of neighbour repulsion relax them into even, organic blue noise.
//      The tightest spacing is the tool width itself: the darkest tone is the line packed solid.
//   2. Tour: a Moore curve visits them in a local order (no long jumps), 2-opt with neighbour
//      lists straightens it, lone stipples that would make thin thorns are skipped, then every
//      remaining crossing is found with a segment grid and removed by its own 2-opt move (a
//      crossing is never shortest, so this always terminates).
//   3. Drawn, not plotted: every corner is rounded by a curve from edge midpoint to edge midpoint
//      (hairpins swing round in a U), and a smooth paper-space drift (one-to-one) adds the slight
//      unsteadiness of a hand. The finished line is checked again; corners whose curves graze a
//      neighbour are rounded less until it never crosses itself.
//   4. Honest numbers: line length in metres, a hand-drawing clock (per point, `geom.handT`) and a
//      plotter estimate, in `geom.real`.
//
// Units: circle units (art square [-1,1]^2, y down); the art square spans 2 * layoutR of the sheet
// width, so 1 circle unit = layoutR * sheetMm millimetres. 1 U (paper unit) = sheetMm / 1000 mm.
// Output: the spiral's geometry format (STRIDE 7: x, y, w, s, tone, turn, dwell), path 'real-stipple'.

import { sampleField } from '../tone.js';
import { STRIDE, MAX_POINTS, wobbleOffset, finishGeometry } from '../spiral.js';
import { mulberry32 } from '../freeline.js';

/**
 * Presets trade detail for drawing time. `cap` = coverage of the darkest tone (1 = packed solid);
 * `floorT` = widest spacing in tool widths (the faint web over the lightest paper);
 * `relax` = blue-noise relaxation rounds.
 */
export const STIPPLE_PRESETS = Object.freeze({
  quick: { name: 'Quick sketch', cap: 0.6, floorT: 20, relax: 3 },
  detailed: { name: 'Detailed', cap: 0.82, floorT: 15, relax: 4 },
  masterpiece: { name: 'Masterpiece', cap: 0.97, floorT: 12, relax: 5 },
});

export const STIPPLE_DEFAULTS = Object.freeze({
  sheetMm: 210,          // sheet width
  toolMm: 0.5,           // real tool width (pen line or stick contact)
  layoutR: 0.42,         // art half-width as a fraction of the sheet width (renderer layout.r)
  preset: 'detailed',
  gamma: 1.0,            // extra tone curve on the field (coverage = cap * D^gamma)
  x: 0, y: 0,            // where the pen starts, circle units
  seed: 1,
  round: 1,              // corner rounding 0..1 (1 = arcs from edge midpoint to edge midpoint)
  wobble: 0.3,           // paper-space hand drift, spiral.js wobble units (0.3 ~ 0.3 mm)
  pressure: 0.8,         // constant pressure for the brush shaders (no tone tricks)
  speedCmS: 0,           // hand speed for the time estimate; 0 = by tool (4 cm/s pen, 6 cm/s stick)
});

// Tour length per unit area through blue noise of spacing r is ~ 1/r, so the line covers about
// tau = t / r of the paper. Measured on the rendered ramp (dev/real_stipple.html?view=ramp) the
// covered fraction is m(tau) = 0.85 tau - 0.08 tau^2 (rounded corners shorten the line a little and
// neighbouring passes start to overlap); TAU inverts it so the render hits the wanted coverage.
const K = 1.0;
const TAU = c => (0.85 - Math.sqrt(Math.max(0, 0.7225 - 0.32 * c))) / 0.16;
// passes may crowd to 0.8 tool widths: the darkest tone is the line packed solid
const R_MIN_T = 0.8;
// Blue-noise point density for Poisson-like spacing r: ~0.87 / r^2.
const RHO = 0.87;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ------------------------------------------------------------------------------ bucket grid (CSR)
/** Static bucket grid over [-1.05, 1.05]^2: cells with index lists, for neighbour queries. */
function bucket(X, Y, n, cell) {
  const nx = Math.max(1, Math.ceil(2.1 / cell));
  const count = new Int32Array(nx * nx + 1);
  const key = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const cx = clamp(Math.floor((X[i] + 1.05) / cell), 0, nx - 1);
    const cy = clamp(Math.floor((Y[i] + 1.05) / cell), 0, nx - 1);
    key[i] = cy * nx + cx;
    count[key[i] + 1]++;
  }
  for (let k = 0; k < nx * nx; k++) count[k + 1] += count[k];
  const fill = count.slice(0, nx * nx);
  const items = new Int32Array(n);
  for (let i = 0; i < n; i++) items[fill[key[i]]++] = i;
  return { nx, cell, start: count, items };
}

// ------------------------------------------------------------------------------ stipples
/**
 * Stipples whose local spacing is r(x) = K t / c(x). Error diffusion on a grid finer than the
 * tool width gives the right count per patch with blue-noise character; repulsion then evens them.
 */
/** How many stipples stipples() will place, before placing them: the dither lays down the sum of
 * its per-cell probabilities, so a coarse grid of the same sum is within a few per cent. */
function stippleCount(field, P) {
  const { t, cap, gamma, rMax } = P;
  const tauFloor = K * t / rMax, tauMax = 1 / R_MIN_T;
  const lim = 1 - t * 0.75, g = t * 0.7, nx = Math.floor(2 * lim / g);
  const m = Math.min(nx, 256), c = 2 * lim / m;
  let s = 0;
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const D = Math.max(0, Math.min(1, sampleField(field, -lim + (i + 0.5) * c, -lim + (j + 0.5) * c)));
      const r = K * t / Math.min(tauMax, Math.max(tauFloor, TAU(cap * Math.pow(D, gamma))));
      s += Math.min(1, RHO * g * g / (r * r));
    }
  }
  return s * nx * nx / (m * m);
}

function stipples(field, P) {
  const { t, cap, gamma, rMax, relax, seed } = P;
  const rand = mulberry32(seed * 7919 + 23);
  const tauFloor = K * t / rMax, tauMax = 1 / R_MIN_T;
  const spacing = (x, y) => {
    const D = Math.max(0, Math.min(1, sampleField(field, x, y)));
    return K * t / Math.min(tauMax, Math.max(tauFloor, TAU(cap * Math.pow(D, gamma))));
  };
  // the art square with a margin of half a tool width so the line stays on the paper
  const lim = 1 - t * 0.75;
  const g = t * 0.7;
  const nx = Math.floor(2 * lim / g);
  const err = new Float32Array((nx + 2) * 2);   // two rows of diffused error
  const X = [], Y = [];
  for (let j = 0; j < nx; j++) {
    const cur = (j & 1) * (nx + 2), nxt = ((j + 1) & 1) * (nx + 2);
    for (let i = 0; i < nx + 2; i++) err[nxt + i] = 0;
    const dir = j & 1 ? -1 : 1;                   // serpentine: no directional worms
    for (let k = 0; k < nx; k++) {
      const i = dir > 0 ? k : nx - 1 - k;
      const x = -lim + (i + 0.5) * g, y = -lim + (j + 0.5) * g;
      const r = spacing(x, y);
      const p = Math.min(1, RHO * g * g / (r * r));
      const v = p + err[cur + i + 1];
      // a jittered threshold breaks the regular patterns error diffusion makes at low density
      const on = v > 0.5 + (rand() - 0.5) * 0.3;
      const e = v - (on ? 1 : 0);
      if (on) { X.push(x + (rand() - 0.5) * g * 0.8); Y.push(y + (rand() - 0.5) * g * 0.8); }
      err[cur + i + 1 + dir] += e * 7 / 16;
      err[nxt + i + 1 - dir] += e * 3 / 16;
      err[nxt + i + 1] += e * 5 / 16;
      err[nxt + i + 1 + dir] += e * 1 / 16;
    }
  }
  const n = X.length;
  const px = new Float64Array(X), py = new Float64Array(Y);
  const r = new Float64Array(n);
  const dx = new Float64Array(n), dy = new Float64Array(n);
  // Repulsion relaxation: pairs closer than the hex spacing of their density push apart, so clumps
  // and gaps left by the dither even out into an organic, nearly hexagonal spread.
  const HEX = 1.12;
  for (let it = 0; it < relax; it++) {
    for (let i = 0; i < n; i++) r[i] = spacing(px[i], py[i]);
    const cell = t * 2;
    const B = bucket(px, py, n, cell);
    dx.fill(0); dy.fill(0);
    for (let i = 0; i < n; i++) {
      const x = px[i], y = py[i], ri = r[i];
      const reach = ri * HEX * 1.05;
      const c0 = clamp(Math.floor((x - reach + 1.05) / cell), 0, B.nx - 1), c1 = clamp(Math.floor((x + reach + 1.05) / cell), 0, B.nx - 1);
      const r0 = clamp(Math.floor((y - reach + 1.05) / cell), 0, B.nx - 1), r1 = clamp(Math.floor((y + reach + 1.05) / cell), 0, B.nx - 1);
      let sx = 0, sy = 0;
      for (let cy = r0; cy <= r1; cy++) {
        for (let cx = c0; cx <= c1; cx++) {
          const k = cy * B.nx + cx;
          for (let m = B.start[k]; m < B.start[k + 1]; m++) {
            const j = B.items[m];
            if (j === i) continue;
            const ex = x - px[j], ey = y - py[j];
            const d2 = ex * ex + ey * ey;
            const R = HEX * 0.5 * (ri + r[j]);
            if (d2 >= R * R) continue;
            const d = Math.sqrt(d2) || 1e-9;
            const push = (R - d) / R;
            sx += ex / d * push * R; sy += ey / d * push * R;
          }
        }
      }
      dx[i] = sx; dy[i] = sy;
    }
    for (let i = 0; i < n; i++) {
      // damped step, never more than a third of the local spacing
      let mx = dx[i] * 0.2, my = dy[i] * 0.2;
      const m = Math.hypot(mx, my), cap3 = r[i] * 0.33;
      if (m > cap3) { mx *= cap3 / m; my *= cap3 / m; }
      px[i] = clamp(px[i] + mx, -lim, lim);
      py[i] = clamp(py[i] + my, -lim, lim);
    }
  }
  return { px, py, n };
}

// ------------------------------------------------------------------------------ tour
/** Moore curve (closed Hilbert) cell order over a 2^k grid, via its L-system. */
function mooreOrder(k) {
  let s = 'LFL+F+LFL';
  for (let it = 1; it < k; it++) {
    let o = '';
    for (const c of s) o += c === 'L' ? '-RF+LFL+FR-' : c === 'R' ? '+LF-RFR-FL+' : c;
    s = o;
  }
  const n = 1 << k;
  const order = new Int32Array(n * n).fill(-1);
  let x = n / 2, y = 0, dx = 0, dy = 1, idx = 0;
  order[y * n + x] = idx++;
  for (const c of s) {
    if (c === 'F') { x += dx; y += dy; if (x >= 0 && y >= 0 && x < n && y < n && order[y * n + x] < 0) order[y * n + x] = idx++; }
    else if (c === '+') { const q = dx; dx = -dy; dy = q; }
    else if (c === '-') { const q = dx; dx = dy; dy = -q; }
  }
  return order;
}

/** Visit order along a Moore curve, rotated to start at point `first`. */
function curveTour(px, py, n, first) {
  const k = Math.max(3, Math.min(10, Math.ceil(Math.log2(Math.sqrt(n / 2)))));
  const side = 1 << k;
  const order = mooreOrder(k);
  const keys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const fx = (px[i] + 1) / 2 * side, fy = (py[i] + 1) / 2 * side;
    const cx = clamp(Math.floor(fx), 0, side - 1), cy = clamp(Math.floor(fy), 0, side - 1);
    keys[i] = order[cy * side + cx] + (Math.atan2(fy - cy - 0.5, fx - cx - 0.5) + Math.PI) / (2 * Math.PI + 1e-9) * 0.999;
  }
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => keys[a] - keys[b]);
  const s0 = idx.indexOf(first);
  const tour = new Int32Array(n);
  for (let i = 0; i < n; i++) tour[i] = idx[(s0 + i) % n];
  return tour;
}

/** k nearest neighbours of every point (bucket-grid ring search). */
function knn(px, py, n, k, cell) {
  const B = bucket(px, py, n, cell);
  const out = new Int32Array(n * k).fill(-1);
  const bd = new Float64Array(k), bi = new Int32Array(k);
  for (let i = 0; i < n; i++) {
    const x = px[i], y = py[i];
    bd.fill(Infinity); bi.fill(-1);
    const ci = clamp(Math.floor((x + 1.05) / cell), 0, B.nx - 1), cj = clamp(Math.floor((y + 1.05) / cell), 0, B.nx - 1);
    for (let ring = 0; ring < B.nx; ring++) {
      if (bi[k - 1] >= 0 && (ring - 1) * cell > Math.sqrt(bd[k - 1])) break;
      for (let dj = -ring; dj <= ring; dj++) {
        const j = cj + dj;
        if (j < 0 || j >= B.nx) continue;
        const step = Math.abs(dj) === ring ? 1 : 2 * ring;
        for (let di = -ring; di <= ring; di += step || 1) {
          const ii = ci + di;
          if (ii < 0 || ii >= B.nx) continue;
          const key = j * B.nx + ii;
          for (let m = B.start[key]; m < B.start[key + 1]; m++) {
            const id = B.items[m];
            if (id === i) continue;
            const ex = px[id] - x, ey = py[id] - y, d = ex * ex + ey * ey;
            if (d >= bd[k - 1]) continue;
            let q = k - 1;
            while (q > 0 && bd[q - 1] > d) { bd[q] = bd[q - 1]; bi[q] = bi[q - 1]; q--; }
            bd[q] = d; bi[q] = id;
          }
        }
      }
    }
    for (let q = 0; q < k; q++) out[i * k + q] = bi[q];
  }
  return out;
}

/**
 * 2-opt on an open path (tour[0] stays the start) with neighbour lists. The work budget counts
 * reversed entries, not time, so results are repeatable.
 */
function twoOpt(px, py, tour, pos, nbr, k, budget) {
  const n = tour.length;
  const dist = (a, b) => Math.hypot(px[a] - px[b], py[a] - py[b]);
  const reverse = (i, j) => {
    while (i < j) {
      const a = tour[i], b = tour[j];
      tour[i] = b; pos[b] = i; tour[j] = a; pos[a] = j;
      i++; j--;
    }
  };
  let work = 0;
  for (let pass = 0; pass < 12 && work < budget; pass++) {
    let improved = 0;
    for (let i = 0; i < n - 1 && work < budget; i++) {
      const a = tour[i], b = tour[i + 1];
      const dab = dist(a, b);
      for (let m = 0; m < k; m++) {
        const c = nbr[a * k + m];
        if (c < 0) break;
        const dac = dist(a, c);
        if (dac >= dab) break;                    // neighbour lists are sorted: no gain beyond
        const j = pos[c];
        if (j > i + 1) {
          const d = j + 1 < n ? tour[j + 1] : -1;
          const gain = dab + (d >= 0 ? dist(c, d) - dist(b, d) : 0) - dac;
          if (gain > 1e-12) { work += j - i; reverse(i + 1, j); improved++; break; }
        } else if (j < i) {
          const e = tour[j + 1];
          const gain = dist(c, e) + dab - dac - dist(e, b);
          if (gain > 1e-12) { work += i - j; reverse(j + 1, i); improved++; break; }
        }
      }
    }
    if (!improved) break;
  }
  return work;
}

// ------------------------------------------------------------------------------ crossings
const orient = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

/**
 * All proper crossings between non-adjacent segments of a polyline given as endpoint arrays
 * (segment k = point k -> point k+1 of `get`). Returns a flat array of segment index pairs.
 */
function crossings(SX, SY, m, cell, limit = Infinity) {
  // m points -> m-1 segments
  const ns = m - 1;
  if (ns < 3) return [];
  const nx = Math.max(1, Math.ceil(2.1 / cell));
  const cellOf = v => clamp(Math.floor((v + 1.05) / cell), 0, nx - 1);
  const x0 = new Int32Array(ns), x1 = new Int32Array(ns), y0 = new Int32Array(ns), y1 = new Int32Array(ns);
  const count = new Int32Array(nx * nx + 1);
  for (let s = 0; s < ns; s++) {
    x0[s] = cellOf(Math.min(SX[s], SX[s + 1])); x1[s] = cellOf(Math.max(SX[s], SX[s + 1]));
    y0[s] = cellOf(Math.min(SY[s], SY[s + 1])); y1[s] = cellOf(Math.max(SY[s], SY[s + 1]));
    for (let cy = y0[s]; cy <= y1[s]; cy++) for (let cx = x0[s]; cx <= x1[s]; cx++) count[cy * nx + cx + 1]++;
  }
  for (let k = 0; k < nx * nx; k++) count[k + 1] += count[k];
  const fill = count.slice(0, nx * nx);
  const items = new Int32Array(count[nx * nx]);
  for (let s = 0; s < ns; s++) {
    for (let cy = y0[s]; cy <= y1[s]; cy++) for (let cx = x0[s]; cx <= x1[s]; cx++) items[fill[cy * nx + cx]++] = s;
  }
  const out = [];
  for (let cy = 0; cy < nx; cy++) {
    for (let cx = 0; cx < nx; cx++) {
      const k = cy * nx + cx, a0 = count[k], a1 = count[k + 1];
      for (let p = a0; p < a1; p++) {
        const s = items[p];
        const ax = SX[s], ay = SY[s], bx = SX[s + 1], by = SY[s + 1];
        for (let q = p + 1; q < a1; q++) {
          const u = items[q];
          if (u === s + 1 || u === s - 1) continue;
          // report each pair once: in the first cell both bounding boxes share
          if (Math.max(x0[s], x0[u]) !== cx || Math.max(y0[s], y0[u]) !== cy) continue;
          const cxp = SX[u], cyp = SY[u], dxp = SX[u + 1], dyp = SY[u + 1];
          const d1 = orient(ax, ay, bx, by, cxp, cyp), d2 = orient(ax, ay, bx, by, dxp, dyp);
          if (d1 * d2 >= 0) continue;
          const d3 = orient(cxp, cyp, dxp, dyp, ax, ay), d4 = orient(cxp, cyp, dxp, dyp, bx, by);
          if (d3 * d4 >= 0) continue;
          out.push(Math.min(s, u), Math.max(s, u));
          if (out.length / 2 >= limit) return out;
        }
      }
    }
  }
  return out;
}

/**
 * Spurs: a lone stipple that the tour visits by going out along a long edge and straight back makes a
 * thin thorn no hand would draw. Skip such stipples (turn > ~140 degrees, both edges longer than
 * 2 tool widths); they only sit in sparse, light areas, so the tone barely moves.
 */
function pruneSpurs(px, py, tour, t) {
  const out = new Int32Array(tour.length);
  let m = 0;
  const minL = 2 * t, cosMax = Math.cos(2.45);
  for (let i = 0; i < tour.length; i++) {
    out[m++] = tour[i];
    while (m >= 3) {
      const a = out[m - 3], b = out[m - 2], c = out[m - 1];
      const ux = px[b] - px[a], uy = py[b] - py[a], vx = px[c] - px[b], vy = py[c] - py[b];
      const l1 = Math.hypot(ux, uy), l2 = Math.hypot(vx, vy);
      if (l1 < minL || l2 < minL || (ux * vx + uy * vy) / (l1 * l2) > cosMax) break;
      out[m - 2] = c; m--;
    }
  }
  return out.slice(0, m);
}

/** Remove every crossing of the stipple tour with its own 2-opt move; returns rounds used. */
function uncross(px, py, tour, pos, cell) {
  const n = tour.length;
  const SX = new Float64Array(n), SY = new Float64Array(n);
  const reverse = (i, j) => {
    while (i < j) {
      const a = tour[i], b = tour[j];
      tour[i] = b; pos[b] = i; tour[j] = a; pos[a] = j;
      i++; j--;
    }
  };
  let fixed = 0;
  for (let round = 0; round < 60; round++) {
    for (let i = 0; i < n; i++) { SX[i] = px[tour[i]]; SY[i] = py[tour[i]]; }
    const pairs = crossings(SX, SY, n, cell);
    if (!pairs.length) return { rounds: round, fixed, left: 0 };
    // pairs as point ids, since each reversal renumbers the positions between
    const ids = pairs.map(s => [tour[s], tour[s + 1]]);
    for (let q = 0; q < ids.length; q += 2) {
      const [a, b] = ids[q], [c, d] = ids[q + 1];
      if (Math.abs(pos[a] - pos[b]) !== 1 || Math.abs(pos[c] - pos[d]) !== 1) continue;   // already changed
      let i = Math.min(pos[a], pos[b]), j = Math.min(pos[c], pos[d]);
      if (i > j) { const s = i; i = j; j = s; }
      if (j <= i + 1) continue;
      const A = tour[i], B2 = tour[i + 1], C = tour[j], D = tour[j + 1];
      const d1 = orient(px[A], py[A], px[B2], py[B2], px[C], py[C]), d2 = orient(px[A], py[A], px[B2], py[B2], px[D], py[D]);
      const d3 = orient(px[C], py[C], px[D], py[D], px[A], py[A]), d4 = orient(px[C], py[C], px[D], py[D], px[B2], py[B2]);
      if (d1 * d2 >= 0 || d3 * d4 >= 0) continue;
      reverse(i + 1, j);
      fixed++;
    }
  }
  for (let i = 0; i < n; i++) { SX[i] = px[tour[i]]; SY[i] = py[tour[i]]; }
  return { rounds: 60, fixed, left: crossings(SX, SY, n, cell).length / 2 };
}

// ------------------------------------------------------------------------------ drawn line
/**
 * Round every corner of the tour with a quadratic arc between points on its two edges (up to the
 * edge midpoints), sampled finely enough for a 4K export. Returns [x, y, dwell, ...].
 */
function roundCorners(px, py, tour, rf, touched, maxStep, angStep) {
  const n = tour.length;
  // growable typed arrays: a plain array push of ~300k points costs more than the whole tour
  let cap = Math.max(1024, n * 8), m = 0;
  let X = new Float64Array(cap), Y = new Float64Array(cap), DW = new Float32Array(cap), VID = new Int32Array(cap);
  const grow = () => {
    cap *= 2;
    const nX = new Float64Array(cap), nY = new Float64Array(cap), nD = new Float32Array(cap), nV = new Int32Array(cap);
    nX.set(X); nY.set(Y); nD.set(DW); nV.set(VID);
    X = nX; Y = nY; DW = nD; VID = nV;
  };
  const push = (x, y, dw, v) => {
    if (m === cap) grow();
    X[m] = x; Y[m] = y; DW[m] = dw; VID[m] = v; m++;
  };
  const line = (x0, y0, x1, y1, v) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-12) return;
    const m = Math.max(1, Math.ceil(len / maxStep));
    for (let s = 1; s <= m; s++) push(x0 + (x1 - x0) * s / m, y0 + (y1 - y0) * s / m, 1, v);
  };
  let cx = px[tour[0]], cy = py[tour[0]];
  push(cx, cy, 1, 0);
  for (let i = 1; i < n - 1; i++) {
    const a = tour[i - 1], b = tour[i], c = tour[i + 1];
    const ax = px[a], ay = py[a], bx = px[b], by = py[b], qx = px[c], qy = py[c];
    const l1 = Math.hypot(ax - bx, ay - by), l2 = Math.hypot(qx - bx, qy - by);
    if (l1 < 1e-9 || l2 < 1e-9) continue;
    // each edge is shared by two corners, so each may take up to half of it: at rf 1 the line runs
    // from edge midpoint to edge midpoint and has no straight, ruled-looking stretches at all
    const e1 = 0.5 * rf[i] * l1, e2 = 0.5 * rf[i] * l2;
    const u1x = (bx - ax) / l1, u1y = (by - ay) / l1, u2x = (qx - bx) / l2, u2y = (qy - by) / l2;
    const Ax = bx - u1x * e1, Ay = by - u1y * e1;
    const Bx = bx + u2x * e2, By = by + u2y * e2;
    line(cx, cy, Ax, Ay, i - 1);
    // turn angle decides the sampling (every ~12 degrees) and how long the hand lingers
    const ang = Math.acos(clamp(u1x * u2x + u1y * u2y, -1, 1));
    const k = Math.max(2, Math.min(48, Math.max(Math.ceil(ang / angStep), Math.ceil((e1 + e2) / maxStep))));
    const dw = 1 + 1.5 * (ang / Math.PI) * (ang / Math.PI);
    // A cubic whose handles follow the two edges. 2/3 of the cut is the plain quadratic corner;
    // hairpins get longer handles so the pen swings round in a U instead of stabbing out a spike.
    // The extra length is the same on both sides (from the shorter cut), or a lopsided hairpin
    // overshoots and loops; corners the crossing guard touched get none.
    const extra = touched[i] ? 0 : 0.55 * clamp((ang - 1.7) / 1.3, 0, 1) * Math.min(e1, e2);
    const h1 = e1 * 2 / 3 + extra, h2 = e2 * 2 / 3 + extra;
    const P1x = Ax + u1x * h1, P1y = Ay + u1y * h1, P2x = Bx - u2x * h2, P2y = By - u2y * h2;
    for (let s = 1; s <= k; s++) {
      const t = s / k, it = 1 - t;
      const w0 = it * it * it, w1 = 3 * it * it * t, w2 = 3 * it * t * t, w3 = t * t * t;
      push(w0 * Ax + w1 * P1x + w2 * P2x + w3 * Bx, w0 * Ay + w1 * P1y + w2 * P2y + w3 * By, dw, i);
    }
    cx = Bx; cy = By;
  }
  line(cx, cy, px[tour[n - 1]], py[tour[n - 1]], n - 1);
  return { X, Y, DW, VID, m };
}

// ------------------------------------------------------------------------------ build
/**
 * Build the stipple tour.
 * @param field  darkness field (tone.buildField)
 * @param opts   STIPPLE_DEFAULTS-shaped; preset may be a STIPPLE_PRESETS key or an object
 * @returns geometry (spiral.js format) + `real` stats { lengthM, handMin, speedCmS, stipples, ... }
 */
export function build(field, opts = {}) {
  const t0 = performance.now();
  const O = { ...STIPPLE_DEFAULTS, ...opts };
  const preset = typeof O.preset === 'string' ? STIPPLE_PRESETS[O.preset] || STIPPLE_PRESETS.detailed : { ...STIPPLE_PRESETS.detailed, ...O.preset };
  const mmPerCU = O.layoutR * O.sheetMm;          // millimetres per circle unit
  const t = O.toolMm / mmPerCU;                   // tool width, circle units
  // the widest spacing: floorT tool widths, but never wider than ~a fifth of the art
  const rMax = Math.max(3 * t, Math.min(preset.floorT * t, 0.35));
  const P = { t, cap: preset.cap, gamma: O.gamma, rMax, relax: preset.relax, seed: O.seed | 0 || 1 };

  // A sheet that is dark all over with a very fine pen would need more line than the geometry can
  // hold (MAX_POINTS, ~3.5 points per stipple at the least). Spread the stipples evenly instead:
  // lighter overall, still monotonic; the pen keeps its real width. The count is estimated first,
  // so an over-budget drawing places its dots once instead of twice.
  const maxStipples = Math.floor(MAX_POINTS / 3.5);
  const want = stippleCount(field, P);
  let tFit = t, reduced = null;
  if (want > maxStipples) {
    tFit = t * Math.sqrt(want / maxStipples) * 1.03;
    reduced = { from: Math.round(want), to: 0, unit: 'stipples', reason: 'points' };
  }
  let S = stipples(field, tFit === t ? P : { ...P, t: tFit });
  if (reduced) reduced.to = S.n;
  for (let tries = 0; S.n > maxStipples && tries < 6; tries++) {
    const from = reduced ? reduced.from : S.n;
    tFit *= Math.sqrt(S.n / maxStipples) * 1.03;
    S = stipples(field, { ...P, t: tFit });
    reduced = { from, to: S.n, unit: 'stipples', reason: 'points' };
  }
  const { px, py } = S;
  let n = S.n;
  const tS = performance.now();
  if (n < 2) { px[1] = px[0] + t; py[1] = py[0]; n = 2; }
  // start at the stipple nearest the chosen point
  let first = 0, bd = Infinity;
  for (let i = 0; i < n; i++) {
    const d = (px[i] - O.x) ** 2 + (py[i] - O.y) ** 2;
    if (d < bd) { bd = d; first = i; }
  }
  let tour = curveTour(px, py, n, first);
  const pos = new Int32Array(n);
  for (let i = 0; i < n; i++) pos[tour[i]] = i;
  const KN = 8;
  const nbr = knn(px, py, n, KN, t * 2);
  const tK = performance.now();
  twoOpt(px, py, tour, pos, nbr, KN, 120 * n);
  const nAll = n;
  tour = pruneSpurs(px, py, tour, t);
  n = tour.length;
  for (let i = 0; i < n; i++) pos[tour[i]] = i;
  const tO = performance.now();
  const unx = uncross(px, py, tour, pos, t * 2);
  const tX = performance.now();

  // The drawn line: rounded corners, sampled at <= 1.5 tool widths (and <= 1 mm). Rounding can make a
  // curve graze a neighbouring pass; wherever the finished line crosses itself, those corners are
  // rounded less and the line is rebuilt, until it is clean.
  const rf = new Float32Array(n).fill(clamp(O.round, 0, 1));
  const touched = new Uint8Array(n);
  // ~7 samples per stipple at full detail; a huge dark sheet (hundreds of thousands of stipples)
  // samples its curves more coarsely rather than ever exceeding MAX_POINTS
  let fine = Math.min(1, MAX_POINTS * 0.8 / (n * 7.5));
  let maxStep = Math.min(1.5 * t, 1 / mmPerCU) / fine, angStep = 0.21 / fine, fineTries = 0;
  // paper-space drift: neighbouring passes drift together (a smooth, nearly rigid warp of the sheet)
  const wob = [0, 0];
  const lim = 1 - t * 0.5, limS = 1 - t * 0.75;   // limS: where the stipples stop
  let L, guard = 0, left = 0;
  // The drift is a smooth noise field, sampled once on a grid and read bilinearly (still smooth and
  // one-to-one; ~20x cheaper than evaluating the noise at every one of ~300k line points).
  const WG = 192, wgx = new Float32Array((WG + 1) * (WG + 1)), wgy = new Float32Array((WG + 1) * (WG + 1));
  for (let j = 0; j <= WG; j++) for (let i = 0; i <= WG; i++) {
    wobbleOffset(-1 + 2 * i / WG, -1 + 2 * j / WG, O.wobble, P.seed, wob);
    wgx[j * (WG + 1) + i] = wob[0]; wgy[j * (WG + 1) + i] = wob[1];
  }
  const warp = (x, y, out) => {
    const fx = clamp((x + 1) / 2 * WG, 0, WG - 1e-9), fy = clamp((y + 1) / 2 * WG, 0, WG - 1e-9);
    const i = Math.floor(fx), j = Math.floor(fy), ax = fx - i, ay = fy - j, o = j * (WG + 1) + i;
    out[0] = (wgx[o] * (1 - ax) + wgx[o + 1] * ax) * (1 - ay) + (wgx[o + WG + 1] * (1 - ax) + wgx[o + WG + 2] * ax) * ay;
    out[1] = (wgy[o] * (1 - ax) + wgy[o + 1] * ax) * (1 - ay) + (wgy[o + WG + 1] * (1 - ax) + wgy[o + WG + 2] * ax) * ay;
  };
  const split = { round: 0, warp: 0, check: 0 };
  for (;;) {
    const tl = performance.now();
    L = roundCorners(px, py, tour, rf, touched, maxStep, angStep);
    // the estimate above was short: sample the corners coarser still (never cut the line)
    if (L.m > MAX_POINTS && fineTries < 6) {
      fineTries++;
      fine *= MAX_POINTS * 0.95 / L.m;
      maxStep = Math.min(1.5 * t, 1 / mmPerCU) / fine; angStep = 0.21 / fine;
      continue;
    }
    // hand drift, the frame and float32 storage go in BEFORE the check, so what is checked is
    // exactly what gets drawn
    const tw = performance.now();
    split.round += tw - tl;
    for (let i = 0; i < L.m; i++) {
      warp(L.X[i], L.Y[i], wob);
      // fade the drift out towards the frame instead of clamping: a clamp folds nearby passes onto
      // the edge (they can cross there); a smooth fade keeps the warp one-to-one
      const edge = limS - Math.max(Math.abs(L.X[i]), Math.abs(L.Y[i]));
      const k = edge <= 0 ? 0 : edge >= 0.06 ? 1 : (edge / 0.06) * (edge / 0.06) * (3 - 2 * edge / 0.06);
      L.X[i] = Math.fround(clamp(L.X[i] + wob[0] * k, -lim, lim));
      L.Y[i] = Math.fround(clamp(L.Y[i] + wob[1] * k, -lim, lim));
    }
    const tc = performance.now();
    split.warp += tc - tw;
    const pairs = crossings(L.X, L.Y, L.m, t * 1.1);
    split.check += performance.now() - tc;
    left = pairs.length / 2;
    if (!left || guard >= 6) break;
    // rounded less each round; from the fourth, those corners go straight (the uncrossed tour itself)
    const f = guard >= 3 ? 0 : 0.35;
    for (const sIdx of pairs) for (let v = L.VID[sIdx] - 1; v <= L.VID[sIdx] + 2; v++) if (v >= 0 && v < n) { rf[v] *= f; touched[v] = 1; }
    guard++;
  }
  const count = L.m;
  if (count > MAX_POINTS) throw new Error(`real-stipple: ${count} points exceeds the budget`);
  const data = new Float32Array(count * STRIDE);
  let s = 0, qx = 0, qy = 0;
  for (let i = 0; i < count; i++) {
    const x = L.X[i], y = L.Y[i];
    if (i) s += Math.hypot(x - qx, y - qy);
    const o = i * STRIDE;
    data[o] = x; data[o + 1] = y; data[o + 2] = t; data[o + 3] = s; data[o + 4] = O.pressure;
    data[o + 6] = L.DW[i];
    qx = x; qy = y;
  }
  const total = s || 1;
  const rings = Math.max(4, Math.round(1 / (rMax * 0.5)));
  for (let i = 0; i < count; i++) data[i * STRIDE + 5] = data[i * STRIDE + 3] / total * rings;

  const lengthM = total * mmPerCU / 1000;
  const speedCmS = O.speedCmS > 0 ? O.speedCmS : (O.toolMm <= 1.2 ? 4 : 6);
  // Hand time: the tour is a chain of short strokes, one per stipple. A careful hand makes at most
  // ~5 controlled strokes a second (neat handwriting pace; 3 for a stick, which moves the whole arm)
  // and travels speedCmS on the long ones, so each stroke takes max(length / speed, 1 / rate).
  // A pen plotter at 5 cm/s plus 20 ms per corner is given for comparison.
  // `handT` is the same clock per line point (seconds since the pen went down), so a film can play
  // the true drawing sped up: dense mazes take their real, slow time; long light strokes fly.
  const rate = O.toolMm <= 1.2 ? 5 : 3, vMm = speedCmS * 10;
  const perMm = new Float32Array(n);                // seconds per mm of line around each stipple
  let handS = 0;
  for (let i = 1; i < n; i++) {
    const a = tour[i - 1], b = tour[i];
    const lenMm = Math.hypot(px[a] - px[b], py[a] - py[b]) * mmPerCU;
    const T = Math.max(lenMm / vMm, 1 / rate);
    handS += T;
    const k = lenMm > 1e-9 ? T / lenMm : 1 / vMm;
    perMm[i - 1] += 0.5 * k; perMm[i] += 0.5 * k;
  }
  perMm[0] *= 2; if (n > 1) perMm[n - 1] *= 2;
  const handT = new Float32Array(count);
  for (let i = 1; i < count; i++) {
    handT[i] = handT[i - 1] + (data[i * STRIDE + 3] - data[(i - 1) * STRIDE + 3]) * mmPerCU * perMm[Math.min(n - 1, L.VID[i])];
  }
  // the rounded line is a little shorter than the tour it follows: rescale so both clocks agree
  const sc = count > 1 && handT[count - 1] > 0 ? handS / handT[count - 1] : 1;
  for (let i = 0; i < count; i++) handT[i] *= sc;
  const plotS = lengthM * 1000 / 50 + n * 0.02;
  const buildMs = performance.now() - t0;
  const geom = finishGeometry({
    n: count, data, colors: null, rings, spacing: K * t / preset.cap, technique: 'wave',
    maxWidth: t, minWidth: t, penWidth: t, shape: 'square',
    startPoint: { x: px[first], y: py[first] }, path: 'real-stipple', start: 'point',
  });
  geom.handT = handT;
  geom.real = {
    style: 'stipple', preset: preset.name, toolMm: O.toolMm, sheetMm: O.sheetMm,
    lengthM: +lengthM.toFixed(2), speedCmS, handMin: +(handS / 60).toFixed(1), strokesPerS: rate, plotterMin: +(plotS / 60).toFixed(1),
    stipples: n, spursSkipped: nAll - n, points: count, crossingsFixed: unx.fixed, crossingsLeft: unx.left, lineCrossings: left, guardRounds: guard,
    buildMs: Math.round(buildMs), truncated: false, sampling: { fine: +fine.toFixed(3) },
    ...(reduced ? { reduced } : {}),
    // the dots a full-detail drawing wants, per the most the line can hold (over 1: dots were spread)
    load: +((reduced ? reduced.from : S.n) / maxStipples).toFixed(3),
    ms: { stipple: Math.round(tS - t0), knn: Math.round(tK - tS), twoOpt: Math.round(tO - tK), uncross: Math.round(tX - tO), line: Math.round(performance.now() - tX), lineRound: Math.round(split.round), lineWarp: Math.round(split.warp), lineCheck: Math.round(split.check) },
  };
  return geom;
}

/** Proper self-crossings of a finished geometry's polyline (dev check; ~0.1-0.5 s). */
export function countCrossings(geom, cell) {
  const n = geom.n, SX = new Float64Array(n), SY = new Float64Array(n);
  for (let i = 0; i < n; i++) { SX[i] = geom.data[i * STRIDE]; SY[i] = geom.data[i * STRIDE + 1]; }
  return crossings(SX, SY, n, cell || Math.max(0.004, geom.penWidth * 2)).length / 2;
}
