// Realistic mode, style C: SCRIBBLE (circulism).
//
// One real pen at its real size draws the photo with one continuous line of small overlapping
// loops, the way an artist shades with a ballpoint. The stroke width never changes: tone comes only
// from how much line lies on each square millimetre of paper.
//
// Physics of the tone. A line of width w laid down at L mm of line per mm^2, crossing itself at
// random, covers c = 1 - exp(-w L) of the paper (Poisson overlap). So the line density a tone needs
// is L = -ln(1 - c) / w: the tool width sets the whole scale (a 4 mm charcoal needs a tenth of the
// line a 0.4 mm pen does, and its loops are ten times bigger).
//
// Construction:
//   1. guide points: blue noise whose spacing h shrinks where the photo is dark (dark: h ~ 1.25 loop
//      radii, so neighbouring bands of loops overlap; light: h = 1/L, a lone travelling line; paper
//      white: no points, the pen only crosses it)
//   2. a tour through them (Hilbert order, then a windowed 2-opt that removes the worst detours;
//      crossings stay, as they would for a person scribbling)
//   3. a centripetal Catmull-Rom guide curve through the tour
//   4. the pen circles around the guide: loop radius R(tone) and a turn rate chosen so that the pen
//      travels m = L h mm per mm of guide (m = 1: no loops, the pen just travels the guide).
//      Loops are hand-made: radius, eccentricity, orientation and pace drift with smooth noise.
//
// Output: the app's geometry (spiral.js STRIDE 7: x, y, w, s, tone, turn, dwell) in circle units,
// the art square [-1,1]^2; 1 circle unit = sheetMm * layoutR mm on paper. path: 'real-scribble'.

import { sampleField } from '../tone.js';
import { STRIDE, MAX_POINTS, finishGeometry } from '../spiral.js';

export const SCRIBBLE_PRESETS = Object.freeze({
  // lighter shading and bigger, faster loops: an evening's sketch
  quick: { label: 'Quick sketch', cmax: 0.8, gamma: 1.2, loopScale: 1.55 },
  // the default: full tonal range at a comfortable loop size
  detailed: { label: 'Detailed', cmax: 0.92, gamma: 1.0, loopScale: 1 },
  // near-solid darks and small, slow loops that keep more of the photo's detail
  masterpiece: { label: 'Masterpiece', cmax: 0.97, gamma: 0.92, loopScale: 0.72 },
});

export const SCRIBBLE_DEFAULTS = Object.freeze({
  sheetMm: 210,        // sheet width on paper
  layoutR: 0.42,       // half the art square, fraction of the sheet width (renderer layout r)
  toolMm: 0.5,         // real stroke width of the tool
  preset: 'detailed',
  seed: 1,
  loopHz: 4,           // loops per second a hand keeps up when shading (for the drawing time)
  travelMmS: 60,       // pen speed on a travelling stroke, mm/s
  pressure: 0.8,       // constant pressure handed to the brush (it is NOT used to shade)
  markRatio: 1,        // share of the tool width that marks at full strength (soft charcoal ~0.6)
  vignette: 0.28,      // soft fade toward the frame, fraction of the half width (0 = ruled edge)
});

// ------------------------------------------------------------------------------ helpers
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash1(i, seed) {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
/** Smooth 1D value noise in [-1, 1]: the slow drifts of a hand. */
function noise1(x, seed) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  const a = hash1(i, seed), b = hash1(i + 1, seed);
  return (a + (b - a) * u) * 2 - 1;
}

/** Hilbert index of integer cell (x, y) on an n x n grid (n a power of two). */
function hilbertIndex(n, x, y) {
  let d = 0;
  for (let s = n >> 1; s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0, ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { x = n - 1 - x; y = n - 1 - y; }
      const t = x; x = y; y = t;
    }
  }
  return d;
}

// ------------------------------------------------------------------------------ tone model
/**
 * Everything the line does at darkness D, tabulated (the field is sampled per point).
 *   R  loop radius (mm)   h  guide spacing (mm, Infinity = no guide point)   m  pen mm per guide mm
 */
function toneTable(o, P) {
  const N = 256;
  // the width that actually darkens: a soft stick's grainy edge adds little tone
  const w = o.toolMm * Math.max(0.2, Math.min(1, o.markRatio));
  // a pen's darkest loops are ~2.6 widths across; a broad stick's are blobs ~1.5 widths across (a
  // bigger loop would lose the face), and the widest loops stay within a few mm of that
  const Rdark = Math.max(0.75, w <= 1 ? 1.3 * w : 0.45 * w + 0.85) * P.loopScale;
  const Rlight = Rdark + Math.min(2.2 * Rdark, 4 * P.loopScale);
  const hMax = Math.max(22, 6 * Rlight);           // sparsest travelling line; lighter = no points
  const t = { N, R: new Float32Array(N + 1), h: new Float32Array(N + 1), m: new Float32Array(N + 1), c: new Float32Array(N + 1), Rdark, Rlight, hMax };
  // A broad stick cannot render fine gradations; an artist simplifies to a few values (big light
  // and dark masses), so the tone is pushed toward an S-curve as the tool widens.
  const notan = o.notan != null ? o.notan : Math.max(0, Math.min(1, (o.toolMm - 0.8) / 3));
  // ...and its darks go solid, the one thing a broad stick does better than a pen
  const cmax = P.cmax + (0.97 - P.cmax) * notan * 0.8;
  for (let i = 0; i <= N; i++) {
    const D0 = i / N;
    const sc = Math.min(1, Math.max(0, (D0 - 0.12) / 0.8));
    const D = D0 + (sc * sc * (3 - 2 * sc) - D0) * notan;
    const c = cmax * Math.pow(D, P.gamma);
    const L = -Math.log(1 - c) / w;                // mm of line per mm^2
    const R = Rlight + (Rdark - Rlight) * Math.pow(D, 0.6);
    const h0 = 1.25 * R;
    let h, m;
    // lights: a lone line that still wiggles a little (M_MIN), so it reads as the same hand
    // a tour through blue noise of spacing h lays KAPPA / h mm of guide per mm^2 (measured on
    // the ramp), so the pen must travel m = L h / KAPPA per mm of guide
    if (L * h0 / KAPPA >= M_MIN) { h = h0; m = L * h0 / KAPPA; }
    else if (L > M_MIN * KAPPA / hMax) { h = M_MIN * KAPPA / L; m = M_MIN; }
    else { h = Infinity; m = M_MIN; }
    t.R[i] = R; t.h[i] = h; t.m[i] = m; t.c[i] = c;
  }
  return t;
}
const M_MIN = 1.15;
const KAPPA = 0.68;
const lookup = (arr, N, D) => {
  const x = Math.max(0, Math.min(1, D)) * N, i = Math.min(N - 1, x | 0), f = x - i;
  return arr[i] + (arr[i + 1] - arr[i]) * f;
};

// ------------------------------------------------------------------------------ guide points
/**
 * Variable-spacing blue noise (Bridson dart throwing), in mm on the frame [-F, F]^2. A candidate
 * keeps 0.5 (r + min(r_j, r)) from every point: dark points pack tight next to light ones, light
 * points keep their own spacing.
 */
function guidePoints(D, F, tab, rand) {
  const hMin = tab.h[tab.N];
  const cell = Math.max(hMin, 0.5);
  const gn = Math.ceil(2 * F / cell);
  const heads = new Int32Array(gn * gn).fill(-1);
  const next = [], xs = [], ys = [], rs = [];
  const active = [];
  const spacing = (x, y) => lookup(tab.h, tab.N, D(x, y));
  const ci = v => Math.max(0, Math.min(gn - 1, Math.floor((v + F) / cell)));
  const ok = (x, y, r) => {
    const m = Math.max(tab.Rdark, Math.min(r, tab.Rlight)) * 0.9;   // loops must stay on the sheet
    if (x < -F + m || x > F - m || y < -F + m || y > F - m) return false;
    const reach = Math.ceil(r / cell);
    const cx = ci(x), cy = ci(y);
    for (let j = Math.max(0, cy - reach); j <= Math.min(gn - 1, cy + reach); j++) {
      for (let i = Math.max(0, cx - reach); i <= Math.min(gn - 1, cx + reach); i++) {
        for (let id = heads[j * gn + i]; id >= 0; id = next[id]) {
          const need = 0.5 * (r + Math.min(rs[id], r));
          const dx = xs[id] - x, dy = ys[id] - y;
          if (dx * dx + dy * dy < need * need) return false;
        }
      }
    }
    return true;
  };
  const add = (x, y, r) => {
    const id = xs.length;
    xs.push(x); ys.push(y); rs.push(r);
    const k = ci(y) * gn + ci(x);
    next[id] = heads[k]; heads[k] = id;
    active.push(id);
  };
  // a jittered lattice of seeds so every inked region is reached, however isolated
  const lat = Math.min(12, tab.hMax * 0.5);
  for (let y = -F + lat / 2; y < F; y += lat) {
    for (let x = -F + lat / 2; x < F; x += lat) {
      const jx = x + (rand() - 0.5) * lat * 0.6, jy = y + (rand() - 0.5) * lat * 0.6;
      const r = spacing(jx, jy);
      if (Number.isFinite(r) && ok(jx, jy, r)) add(jx, jy, r);
    }
  }
  const cap = 400000;
  while (active.length && xs.length < cap) {
    const k = Math.floor(rand() * active.length);
    const id = active[k];
    const r0 = rs[id];
    let placed = false;
    for (let tries = 0; tries < 14; tries++) {
      const a = rand() * Math.PI * 2, d = r0 * (1 + rand());
      const x = xs[id] + Math.cos(a) * d, y = ys[id] + Math.sin(a) * d;
      const r = spacing(x, y);
      if (Number.isFinite(r) && ok(x, y, r)) { add(x, y, r); placed = true; break; }
    }
    if (!placed) { active[k] = active[active.length - 1]; active.pop(); }
  }
  return { xs, ys, n: xs.length };
}

// ------------------------------------------------------------------------------ tour
/** Hilbert order, then windowed 2-opt passes that undo the curve's worst doubling back. */
function tour(G, F) {
  const { xs, ys, n } = G;
  const H = 1024;
  const keys = new Float64Array(n);
  // the curve's grid is turned off the sheet's axes, so its right-angled detours do not line up
  // into a visible lattice
  const ca = Math.cos(0.52), sa = Math.sin(0.52), S = F * 1.42;
  for (let i = 0; i < n; i++) {
    const rx = xs[i] * ca - ys[i] * sa, ry = xs[i] * sa + ys[i] * ca;
    const gx = Math.max(0, Math.min(H - 1, Math.floor((rx + S) / (2 * S) * H)));
    const gy = Math.max(0, Math.min(H - 1, Math.floor((ry + S) / (2 * S) * H)));
    keys[i] = hilbertIndex(H, gx, gy);
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => keys[a] - keys[b]);
  const X = new Float64Array(n), Y = new Float64Array(n);
  for (let i = 0; i < n; i++) { X[i] = xs[order[i]]; Y[i] = ys[order[i]]; }
  const d = (i, j) => Math.hypot(X[i] - X[j], Y[i] - Y[j]);
  const W = 48;
  for (let pass = 0; pass < 3; pass++) {
    let gain = 0;
    for (let i = 0; i < n - 3; i++) {
      const a = d(i, i + 1);
      for (let j = i + 2; j < Math.min(n - 1, i + W); j++) {
        const delta = d(i, j) + d(i + 1, j + 1) - a - d(j, j + 1);
        if (delta < -1e-6) {
          // reverse i+1..j
          for (let p = i + 1, q = j; p < q; p++, q--) {
            let t = X[p]; X[p] = X[q]; X[q] = t;
            t = Y[p]; Y[p] = Y[q]; Y[q] = t;
          }
          gain -= delta;
          break;
        }
      }
    }
    if (gain < 1e-3) break;
  }
  return { X, Y, n };
}

/**
 * Tangent at b for a U-turn when a -> b -> c turns by more than ~115 degrees, else null. Its
 * direction is the bisector of the two legs (sideways at the tip), its length ~ the legs.
 */
function hairpin(ax, ay, bx, by, cx, cy, lab) {
  const lbc = Math.hypot(cx - bx, cy - by);
  if (lab < 1e-6 || lbc < 1e-6) return null;
  const ix = (bx - ax) / lab, iy = (by - ay) / lab, ox = (cx - bx) / lbc, oy = (cy - by) / lbc;
  if (ix * ox + iy * oy > -0.42) return null;
  let tx = ix + ox, ty = iy + oy;
  let tl = Math.hypot(tx, ty);
  if (tl < 1e-3) { tx = -iy; ty = ix; tl = 1; }     // exact reversal: either side will do
  const k = 0.9 * Math.min(lab, lbc) / tl;
  return [tx * k, ty * k];
}

// ------------------------------------------------------------------------------ build
// Sampling levels, finest first: [chords per loop, longest chord on a travelling stroke (mm)].
// Over the point budget the loops are drawn with fewer chords before any detail is given up. A
// pen's loops are tiny (a 0.4 mm pen's darkest are ~0.5 mm across, 5 px at the 4K export on A2),
// so 8 chords still round them to within half a pixel.
const FIDELITY = [[18, 0.4], [15, 0.5], [13, 0.65], [11, 0.8], [10, 1], [9, 1.2], [8, 1.5]];
const GUIDE_CAP = 400000;
const BUDGET = MAX_POINTS - 1;

/** The darkness under the pen, in mm on the frame [-F, F]^2, with the soft vignette. */
function darkness(field, o, F, seed) {
  // a soft, uneven vignette: the shading thins out toward the frame the way a hand stops short
  // of it, instead of a ruled edge
  const vig = Math.max(0, o.vignette) * F;
  return vig > 0
    ? (x, y) => {
      const e = F - Math.max(Math.abs(x), Math.abs(y));
      const a = Math.atan2(y, x) * 7;
      const v = vig * (0.8 + 0.4 * noise1(a, seed + 13) + 0.2 * noise1(a * 3.7, seed + 14));
      const f = Math.min(1, Math.max(0, e / v));
      return sampleField(field, x / F, y / F) * f * f * (3 - 2 * f);
    }
    : (x, y) => sampleField(field, x / F, y / F);
}

// The drawing's size before any of it is laid, from the darkness alone: blue noise of spacing h
// holds ~GUIDE_RHO / h^2 guide points per mm^2, its tour lays KAPPA / h mm of guide per mm^2, and
// each mm of guide takes the same steps as the walk (stepsOf). EST_K is the walk's measured excess
// (hairpins, the darkest of three samples per segment).
const GUIDE_RHO = 0.72;
const EST_K = 1.2;
function darkGrid(D, F, n = 128) {
  const g = new Float32Array(n * n), c = 2 * F / n;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) g[j * n + i] = D(-F + (i + 0.5) * c, -F + (j + 0.5) * c);
  return { g, A: c * c };
}
function estimate(grid, tab, [spl, dsm]) {
  let guide = 0, pts = 0;
  for (let k = 0; k < grid.g.length; k++) {
    const Dk = grid.g[k], h = lookup(tab.h, tab.N, Dk);
    if (!Number.isFinite(h)) continue;
    const R = lookup(tab.R, tab.N, Dk), m = lookup(tab.m, tab.N, Dk);
    const rate = Math.sqrt(Math.max(0, m * m - 1)) / Math.max(0.2, R * 0.6) * 1.3;
    guide += grid.A * GUIDE_RHO / (h * h);
    pts += grid.A * KAPPA / h * Math.max(1 / dsm, rate * spl / (Math.PI * 2));
  }
  return { guide, pts: pts * EST_K };
}

const PRESET_ORDER = ['quick', 'detailed', 'masterpiece'];   // coarse to fine

/**
 * Always the whole drawing, within MAX_POINTS. The line a tone needs is set by the tool (see the
 * tone model), so over the budget the loops first get fewer chords, then grow bigger: the same
 * line length in fewer, larger loops (less detail, said so in stats.reduced). The loop size is
 * picked from an estimate before the guide and its tour are built, so the build runs once (a
 * second time only when the exact count disagrees). A finer preset never ends coarser than the
 * next coarser one: when its fitted loops would be bigger than that preset's, it is drawn as that
 * preset (stats.reduced.asPreset).
 * @param field  darkness field (tone.buildField); D = 1 means the darkest ink
 * @param opts   SCRIBBLE_DEFAULTS-shaped, plus any preset key overridden (cmax, gamma, loopScale)
 */
export function build(field, opts = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const want = SCRIBBLE_PRESETS[opts.preset] ? opts.preset : 'detailed';
  const own = ['cmax', 'gamma', 'loopScale'].some(k => opts[k] != null);
  const o = { ...SCRIBBLE_DEFAULTS, ...opts };
  const F = o.sheetMm * o.layoutR;
  const grid = darkGrid(darkness(field, o, F, (o.seed | 0) || 1), F);
  const coarsest = FIDELITY[FIDELITY.length - 1];
  // how far over the budget a preset's line is at loop scale ls (points go as 1 / loop size,
  // guide points as 1 / loop size squared)
  const overAt = (preset, ls) => {
    const P = { ...SCRIBBLE_PRESETS[preset], loopScale: ls };
    for (const k of ['cmax', 'gamma']) if (opts[k] != null) P[k] = opts[k];
    const e = estimate(grid, toneTable(o, P), coarsest);
    return Math.max(e.pts / BUDGET, Math.sqrt(e.guide / (GUIDE_CAP * 0.9)));
  };
  const fit = (preset, ls) => {
    for (let i = 0; i < 8; i++) {
      const over = overAt(preset, ls);
      if (over <= 1) break;
      ls *= over * 1.02;
    }
    return ls;
  };
  const ls0 = opts.loopScale != null ? opts.loopScale : SCRIBBLE_PRESETS[want].loopScale;
  const load = overAt(want, ls0);
  let preset = want, ls = load > 1 ? fit(want, ls0) : ls0;
  // over the budget, a finer preset falls back to a coarser one before its loops outgrow that one's
  for (let idx = PRESET_ORDER.indexOf(preset); !own && ls > ls0 && idx > 0; idx--) {
    const q = PRESET_ORDER[idx - 1], lsQ = SCRIBBLE_PRESETS[q].loopScale;
    if (ls <= lsQ) break;
    preset = q;
    ls = fit(q, lsQ);
  }
  for (let tries = 0; tries < 10; tries++) {
    const r = buildOnce(field, { ...opts, preset, loopScale: ls }, t0);
    if (r.geom) {
      const st = r.geom.stats;
      st.preset = want;
      st.load = +load.toFixed(3);
      const Pf = { ...SCRIBBLE_PRESETS[preset], loopScale: ls };
      for (const k of ['cmax', 'gamma']) if (opts[k] != null) Pf[k] = opts[k];
      st.estimate = Math.round(estimate(grid, toneTable(o, Pf), [st.sampling.segPerLoop, st.sampling.dsMax]).pts);
      if (ls !== ls0 || preset !== want) {
        st.reduced = { from: +ls0.toFixed(3), to: +ls.toFixed(3), unit: 'loop size', reason: 'points' };
        if (preset !== want) st.reduced.asPreset = SCRIBBLE_PRESETS[preset].label;
      }
      return r.geom;
    }
    ls *= Math.max(1.03, r.grow);
    // the exact count may push a finer preset's loops past the coarser one's after all
    const idx = PRESET_ORDER.indexOf(preset), q = PRESET_ORDER[idx - 1];
    if (!own && q && ls > SCRIBBLE_PRESETS[q].loopScale) { preset = q; ls = fit(q, SCRIBBLE_PRESETS[q].loopScale); }
  }
  throw new Error('real-scribble: could not fit the point budget');
}

function buildOnce(field, opts, t0) {
  const o = { ...SCRIBBLE_DEFAULTS, ...opts };
  const P = { ...(SCRIBBLE_PRESETS[o.preset] || SCRIBBLE_PRESETS.detailed) };
  for (const k of ['cmax', 'gamma', 'loopScale']) if (opts[k] != null) P[k] = opts[k];
  const F = o.sheetMm * o.layoutR;                  // mm per circle unit (half the art square)
  const seed = (o.seed | 0) || 1;
  const rand = mulberry32(seed * 7919 + 101);
  const tab = toneTable(o, P);
  const D = darkness(field, o, F, seed);

  const G = guidePoints(D, F, tab, rand);
  // the guide stopped at its cap: part of the sheet would get no loops. Bigger loops, fewer points.
  if (G.n >= GUIDE_CAP) return { grow: 1.3 };
  if (G.n < 2) { G.xs.push(0, 1); G.ys.push(0, 0); G.n = G.xs.length; }
  const T = tour(G, F);
  const tTour = (typeof performance !== 'undefined' ? performance : Date).now();

  // Count the points before laying any (exact: the same step rule as the walk below), and pick
  // the finest sampling that fits the budget.
  const TAU = Math.PI * 2;
  const segRate = new Float32Array(Math.max(1, T.n - 1));
  for (let i = 0; i < T.n - 1; i++) {
    const x1 = T.X[i], y1 = T.Y[i], x2 = T.X[i + 1], y2 = T.Y[i + 1];
    const Dm = Math.max(D(x1, y1), D((x1 + x2) / 2, (y1 + y2) / 2), D(x2, y2));
    const Rm = lookup(tab.R, tab.N, Dm), mm = lookup(tab.m, tab.N, Dm);
    segRate[i] = Math.sqrt(Math.max(0, mm * mm - 1)) / Math.max(0.2, Rm * 0.6) * 1.3;
  }
  const stepsOf = (i, chord, spl, dsm) => Math.max(1, Math.ceil(chord / dsm), Math.ceil(chord * segRate[i] / (TAU / spl)));
  const countAt = ([spl, dsm]) => {
    let c = 1;
    for (let i = 0; i < T.n - 1; i++) {
      const chord = Math.hypot(T.X[i + 1] - T.X[i], T.Y[i + 1] - T.Y[i]);
      if (chord >= 1e-6) c += stepsOf(i, chord, spl, dsm);
    }
    return c;
  };
  let fid = FIDELITY[0], need = countAt(fid);
  for (let f = 1; need > BUDGET && f < FIDELITY.length; f++) { fid = FIDELITY[f]; need = countAt(fid); }
  // still over at the coarsest sampling: loops scale up (points go as 1 / loop size)
  if (need > BUDGET) return { grow: need / BUDGET * 1.02 };
  const [segPerLoop, dsMax] = fid;

  // output buffer, sized from the count
  let cap = Math.min(MAX_POINTS, need + 16);
  let data = new Float32Array(cap * STRIDE);
  let n = 0;
  const wU = o.toolMm / F;
  let sMm = 0, phi = rand() * 6.283, sGuide = 0, handS = 0, loops = 0;
  let px = 0, py = 0;
  let over = false;

  const emit = (x, y, loopy) => {
    if (n >= cap) {
      if (cap >= MAX_POINTS) { over = true; return; }
      cap = Math.min(MAX_POINTS, Math.ceil(cap * 1.7));
      const g2 = new Float32Array(cap * STRIDE); g2.set(data); data = g2;
    }
    const k = n * STRIDE;
    data[k] = x / F; data[k + 1] = y / F; data[k + 2] = wU;
    data[k + 3] = sMm / F; data[k + 4] = o.pressure;
    data[k + 5] = phi / TAU + sGuide / (TAU * tab.Rdark);   // monotone "turn" for ring pacing
    data[k + 6] = 1 + 0.25 * loopy;                          // the hand lingers in tight loops
    n++;
  };

  // centripetal Catmull-Rom through the tour
  const { X, Y } = T;
  const N = T.n;
  let prevPin = null;
  let tnx = 0, tny = 1;
  let gx = X[0], gy = Y[0];
  px = gx; py = gy;
  emit(px, py, 0);
  for (let i = 0; i < N - 1 && !over; i++) {
    const i0 = Math.max(0, i - 1), i3 = Math.min(N - 1, i + 2);
    const x0 = X[i0], y0 = Y[i0], x1 = X[i], y1 = Y[i], x2 = X[i + 1], y2 = Y[i + 1], x3 = X[i3], y3 = Y[i3];
    const chord = Math.hypot(x2 - x1, y2 - y1);
    if (chord < 1e-6) { prevPin = null; continue; }
    const k01 = Math.sqrt(Math.max(1e-6, Math.hypot(x1 - x0, y1 - y0)));
    const k12 = Math.sqrt(chord);
    const k23 = Math.sqrt(Math.max(1e-6, Math.hypot(x3 - x2, y3 - y2)));
    // tangents (Barry-Goldman, centripetal), scaled to the segment
    let m1x = ((x1 - x0) / k01 - (x2 - x0) / (k01 + k12) + (x2 - x1) / k12) * k12;
    let m1y = ((y1 - y0) / k01 - (y2 - y0) / (k01 + k12) + (y2 - y1) / k12) * k12;
    let m2x = ((x2 - x1) / k12 - (x3 - x1) / (k12 + k23) + (x3 - x2) / k23) * k12;
    let m2y = ((y2 - y1) / k12 - (y3 - y1) / (k12 + k23) + (y3 - y2) / k23) * k12;
    // hairpins: the tour doubles back at x2. A spline through it makes a sharp V; a hand swings
    // round in a U. Leave x2 sideways, toward the side the next point lies on.
    const pin = hairpin(x1, y1, x2, y2, x3, y3, chord);
    if (pin) { m2x = pin[0]; m2y = pin[1]; }
    if (prevPin) { m1x = prevPin[0] * chord / prevPin[2]; m1y = prevPin[1] * chord / prevPin[2]; }
    prevPin = pin ? [pin[0], pin[1], chord] : null;
    // how finely to walk this segment: enough samples per loop at its darkest point
    const steps = stepsOf(i, chord, segPerLoop, dsMax);
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      const nx = h00 * x1 + h10 * m1x + h01 * x2 + h11 * m2x;
      const ny = h00 * y1 + h10 * m1y + h01 * y2 + h11 * m2y;
      const dg = Math.hypot(nx - gx, ny - gy);
      if (dg > 1e-9) { tnx = -(ny - gy) / dg; tny = (nx - gx) / dg; }   // guide normal
      gx = nx; gy = ny; sGuide += dg;
      const Dk = D(gx, gy);
      const m = lookup(tab.m, tab.N, Dk);
      // hand-made loops: radius, pace, shape and tilt drift slowly along the guide
      const u = sGuide / (tab.Rdark * 2.5);
      const R = lookup(tab.R, tab.N, Dk) * (1 + 0.2 * noise1(u, seed + 3) + 0.12 * noise1(u * 3.1, seed + 4));
      const loopy = Math.min(1, Math.max(0, (m - 1) / 1.4));
      const rEff = R * loopy * loopy * (3 - 2 * loopy);
      if (rEff > 1e-4) {
        const rate = Math.sqrt(m * m - 1) / Math.max(rEff, 0.15 * R);
        phi += dg * rate * (1 + 0.28 * noise1(u * 2.3, seed + 5));
      }
      const tilt = 1.6 * noise1(u * 0.3, seed + 7);
      const ecc = 0.74 + 0.24 * noise1(u * 1.3, seed + 9);
      const cx = rEff * Math.cos(phi), cy = rEff * ecc * Math.sin(phi);
      const ct = Math.cos(tilt), st = Math.sin(tilt);
      // the loop centre also drifts sideways every couple of loops, so dark passages pile up as
      // irregular overlapping loops rather than a regular coil
      const side = rEff * 0.55 * noise1(u * 1.9, seed + 11);
      const x = gx + cx * ct - cy * st + side * tnx, y = gy + cx * st + cy * ct + side * tny;
      const ds = Math.hypot(x - px, y - py);
      sMm += ds;
      // hand speed: loops at loopHz (small loops are slow), travelling strokes at travelMmS
      const vLoop = Math.max(15, Math.min(o.travelMmS, TAU * Math.max(rEff, 0.3) * o.loopHz));
      handS += ds / (o.travelMmS + (vLoop - o.travelMmS) * loopy);
      px = x; py = y;
      emit(x, y, loopy);
    }
  }
  if (over) return { grow: 1.1 };                 // cannot happen (the count is exact); never cut short
  loops = phi / TAU;
  const t1 = (typeof performance !== 'undefined' ? performance : Date).now();
  const geom = finishGeometry({
    n, data: data.subarray(0, n * STRIDE), colors: null,
    rings: Math.round(2 * F / (2 * tab.Rdark)), spacing: tab.Rdark / F, technique: 'thickness',
    maxWidth: wU, minWidth: wU, penWidth: wU, shape: 'square',
    startPoint: { x: X[0] / F, y: Y[0] / F },
    path: 'real-scribble',
  });
  geom.stats = {
    toolMm: o.toolMm, sheetMm: o.sheetMm, preset: o.preset,
    lengthM: sMm / 1000, handSeconds: handS, points: n, guidePoints: G.n, loops: Math.round(loops),
    buildMs: t1 - t0, tourMs: tTour - t0, truncated: false, sampling: { segPerLoop, dsMax },
    loopRadiusMm: [tab.Rdark, tab.Rlight],
  };
  return { geom };
}

/** "1 h 23 min" style drawing time. */
export function formatHandTime(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
