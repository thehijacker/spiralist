// Realistic mode, style D: flow engraving with ONE real pen.
//
// Like a banknote engraving, the drawing is a family of long parallel lines that follow the form
// of the subject, but drawn with a single fixed-width tool at its real size (no width tricks) and
// without ever lifting the pen. Tone comes only from how closely the lines pack.
//
//   1. Flow: the lines are level sets of phi(x, y) = the integral over y of (1 + a dB/dy), where B is
//      the heavily blurred LIGHTNESS of the photo. Every level set is a graph over x (phi grows
//      monotonically down each column), so each line crosses the whole plate; lines lift over light
//      forms and sink into dark ones, which reads as relief (a cheek, the curve of a skull) the way
//      engravers' lines wrap around a face. The integrand is also scaled by darkness^pack, so
//      within each column the lines crowd into the darks and open up in the lights.
//   2. Bands: the level sets phi = k*H cut the plate into bands H = levels x tool wide. A band holds
//      n = 1, 3, 5 ... lines evenly spaced across it; n at each column is the darkness times the
//      band's real height divided by the tool width (how many line widths cover that share of the
//      paper), dithered along the band (sigma-delta with hysteresis), never across it.
//   3. One line: every band has a carrier line (it spans the band). Extra lines come in pairs that
//      fork off the line below them and rejoin it (a "tooth": out along the upper strand, back along
//      the lower one, then on along the parent). The pairs open and close with a ramp, so a new line
//      grows out of its neighbour like a split engraved line, and teeth nest (n = 5 hangs off n = 3).
//      Nothing ever crosses. Bands are joined boustrophedon by a half-turn in the margin.
//
// Units: circle units (art circle radius 1). With the app layout r = 0.42 of the sheet width, one
// circle unit is 0.42 x sheetMm millimetres on paper, so the tool width in circle units is
// toolMm / (0.42 x sheetMm).

import { STRIDE, MAX_POINTS, finishGeometry } from '../spiral.js';
import { sampleField, boxBlur, boxRadiusForSigma } from '../tone.js';

export const ENGRAVE_DEFAULTS = Object.freeze({
  sheetMm: 210,     // sheet width
  layoutR: 0.42,    // art circle radius as a fraction of the sheet width (app layout)
  toolMm: 0.5,      // real nib / stick width
  levels: 5,        // band height in tool widths: n = levels lines pack solid (odd = full black reachable)
  flow: 0.4,        // how strongly lines bend over the form (0 = straight hatching)
  pack: 0.35,       // lines crowd toward the darks of each column (spacing ~ darkness^-pack), 0 = even;
                    // 0.5 opens the bands in the lights so white paper stays nearly white
  gamma: 1.0,       // darkness curve before it becomes line density
  minTooth: 8,      // shortest extra line pair, in band heights (3 read as rows of capsules / Morse
                    // code in the round 2 art review; engraved lines split for a long dark run)
  ramp: 2.5,        // how long a new pair takes to open from its parent, in band heights (a long
                    // taper reads as a line splitting, a short one as a lens)
  margin: 0.015,    // plate margin, circle units
  speedMm: 30,      // believable hand speed along the line, mm/s (careful pen hatching ~3 cm/s)
  reverseSec: 0.25, // extra time for each pen reversal (fork cusps, band turns)
  pressure: 0.85,   // constant hand pressure: brushes read tone as pressure, and here tone must
                    // come from line density alone
  seed: 1,          // staggers where the line pairs open in neighbouring bands
});

/** Detail presets: the tool size sets the scale, so detail costs line length (drawing time). */
export const ENGRAVE_PRESETS = Object.freeze({
  quick: { toolMm: 0.8, levels: 5, speedMm: 40, label: 'Quick sketch (0.8 mm marker)' },
  detailed: { toolMm: 0.4, levels: 5, speedMm: 30, label: 'Detailed (0.4 mm fineliner)' },
  masterpiece: { toolMm: 0.25, levels: 7, speedMm: 25, label: 'Masterpiece (0.25 mm technical pen)' },
});

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function hash(i, seed) {
  let h = Math.imul(i + 1, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Heavily blurred lightness on a small grid: the relief the lines ride over. */
function reliefGrid(field, S, sigmaCu) {
  const G = field.G, k = G / S;
  const B = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let s = 0;
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) s += field.D[(y * k + j) * G + x * k + i];
    B[y * S + x] = 1 - s / (k * k);
  }
  boxBlur(B, S, boxRadiusForSigma(sigmaCu * S / 2));
  return B;
}
function sampleGrid(B, S, x, y) {
  const gx = clamp((x + 1) * 0.5 * S - 0.5, 0, S - 1.001), gy = clamp((y + 1) * 0.5 * S - 0.5, 0, S - 1.001);
  const x0 = gx | 0, y0 = gy | 0, fx = gx - x0, fy = gy - y0;
  const a = B[y0 * S + x0], b = B[y0 * S + x0 + 1], c = B[(y0 + 1) * S + x0], d = B[(y0 + 1) * S + x0 + 1];
  return a + (b - a) * fx + (c - a + (d - c - b + a) * fx) * fy;
}

/**
 * Build the engraving. Returns the app's geometry (spiral.js format) with path 'real-engrave'
 * and `real` = { lengthM, handMin, points, buildMs, reversals, bands, toolMm, ... }.
 */
export function build(field, opts = {}) {
  // Over the point budget (a fine pen on a big sheet), the columns get coarser instead of failing:
  // the same lines at the same spacing, sampled with fewer vertices.
  let dxK = 1, over = 0;
  for (let i = 0; i < 4; i++) {
    const g = buildOnce(field, opts, dxK);
    if (!g.over) return g;
    over = g.over;
    dxK *= g.over / MAX_POINTS * 1.08;
  }
  throw new Error(`real-engrave: ${over} points exceeds the budget`);
}

function buildOnce(field, opts, dxK) {
  const t0 = performance.now();
  const o = { ...ENGRAVE_DEFAULTS, ...opts };
  const mmPerCu = o.layoutR * o.sheetMm;
  const w = o.toolMm / mmPerCu;                       // constant stroke width, circle units
  const M = Math.max(1, Math.round(o.levels));
  const lo = -1 + o.margin, hi = 1 - o.margin;
  const K = Math.max(2, Math.round((hi - lo) / (M * w)));   // bands top to bottom
  const H = (hi - lo) / K;                            // nominal band height (phi units ~ circle units)
  // columns: fine enough that the 4096 px export shows smooth curves, coarse enough for the budget
  const dx = Math.min(H / 6, 0.006, Math.max(w * 0.9, 0.0025)) * dxK;
  const xl = lo + H * 0.55, xr = hi - H * 0.55;       // room for the margin half-turns
  const C = Math.max(4, Math.round((xr - xl) / dx) + 1);
  const dxc = (xr - xl) / (C - 1);
  const xs = new Float64Array(C);
  for (let c = 0; c < C; c++) xs[c] = xl + c * dxc;

  // ---- 1. band boundaries Y[k][c]: level sets of phi, normalised per column to span [lo, hi]
  const S = 256, R = 768;
  const B = reliefGrid(field, S, 0.05);
  // darkness at band scale: where in each column the lines crowd (tighter spacing in the darks)
  const Dk = reliefGrid(field, S, Math.max(0.012, H * 0.7));
  const alpha = 0.14 * o.flow;
  const Y = new Float32Array((K + 1) * C);
  const cum = new Float64Array(R + 1);
  const dy = (hi - lo) / R;
  for (let c = 0; c < C; c++) {
    const x = xs[c];
    cum[0] = 0;
    let prev = sampleGrid(B, S, x, lo);
    for (let r = 0; r < R; r++) {
      const yy = lo + (r + 1) * dy;
      const cur = sampleGrid(B, S, x, yy);
      // bright forms push the lines up (relief); the floor keeps phi monotonic so lines never fold
      const dark = 1 - sampleGrid(Dk, S, x, yy - dy * 0.5);
      const g = clamp(1 - alpha * (cur - prev) / dy, 0.3, 3.5) * Math.pow(0.2 + dark, o.pack);
      cum[r + 1] = cum[r] + g;
      prev = cur;
    }
    const scale = K / cum[R];
    let r = 0;
    for (let k = 0; k <= K; k++) {
      const target = k / scale;
      while (r < R && cum[r + 1] < target) r++;
      const f = r >= R ? 0 : (target - cum[r]) / Math.max(1e-9, cum[r + 1] - cum[r]);
      Y[k * C + c] = lo + (r + clamp(f, 0, 1)) * dy;
    }
    Y[c] = lo; Y[K * C + c] = hi;
  }

  // ---- 2. line count per band and column (odd), sigma-delta along the band
  const nMaxAll = M % 2 ? M : M - 1;
  const NA = new Uint8Array(K * C);
  const nreal = new Float32Array(C);
  const minRun = Math.max(2, Math.round(o.minTooth * H / dxc));
  const rampC = Math.max(1, o.ramp * H / dxc);
  const fr = [0.1, 0.3, 0.5, 0.7, 0.9];
  // a pair shorter than its two ramps never opens: its strands would pile onto the parent as a blot
  // runs shorter than ~2 mm close into tiny loops that read as typos, not tone
  const minFeature = Math.max(4, Math.round(2 / mmPerCu / dxc));
  const minShort = Math.max(3, Math.round(Math.max(0.75 * minRun, 2.2 * rampC)));
  const LO = new Uint8Array(C), CAP = new Uint8Array(C), FR = new Float32Array(C);
  for (let k = 0; k < K; k++) {
    for (let c = 0; c < C; c++) {
      const y0 = Y[k * C + c], h = Y[(k + 1) * C + c] - y0;
      let d = 0;
      for (const f of fr) d += sampleField(field, xs[c], y0 + h * f);
      d = Math.pow(clamp(d / fr.length, 0, 1), o.gamma);
      nreal[c] = d * h / w;                           // line widths needed to cover that share
    }
    // Dither between the two odd counts around t: lo (largest odd <= t) and lo + 2. A jump in lo
    // is drawn where it happens, so a hard edge in the photo stays a hard edge.
    const rad = Math.max(1, Math.round(0.4 * H / dxc));
    let acc = 0;
    for (let c = -rad; c <= rad; c++) acc += nreal[clamp(c, 0, C - 1)];
    for (let c = 0; c < C; c++) {
      const h = Y[(k + 1) * C + c] - Y[k * C + c];
      const cap = Math.max(1, Math.min(nMaxAll, (Math.floor(h / w + 0.35) | 1)));
      const t = clamp(acc / (2 * rad + 1), 1, cap);
      acc += nreal[Math.min(C - 1, c + rad + 1)] - nreal[Math.max(0, c - rad)];
      const l = Math.min(cap, Math.floor((t - 1) / 2) * 2 + 1);
      LO[c] = l; CAP[c] = cap;
      // a hair above an odd count is not worth a scatter of lone pairs: it reads as noise, not tone
      const fr0 = l >= cap ? 0 : (t - l) / 2;
      FR[c] = fr0 < 0.2 ? 0 : fr0;
    }
    // sigma-delta with hysteresis: e is the line debt (in line-columns) against the fractional
    // target; a pair opens when the debt reaches T and closes when it is repaid by T, so pairs are
    // never shorter than 2T, the mean density is exact, and nothing is lost where lo keeps
    // changing (fur, hair). A random starting debt per band staggers the pairs like brickwork.
    const T = minShort * 0.5;
    // start in the state nearest the target, or a dark plate edge would wait T columns for its pair
    let e = (hash(k, o.seed) - 0.5) * 2 * T, on = FR[0] >= 0.5 && LO[0] + 2 <= CAP[0], run = 0, thr = T;
    for (let c = 0; c < C; c++) {
      const f = FR[c];
      // lo stepped: keep the drawn count where it was (3 = lo 3, or lo 1 plus a pair), otherwise
      // every band would flip at the same column and draw a stripe
      if (c && LO[c] !== LO[c - 1]) {
        const prev = NA[k * C + c - 1];
        on = LO[c] + 2 === prev && LO[c] + 2 <= CAP[c];
      }
      if (on && LO[c] + 2 > CAP[c]) on = false;
      e = clamp(e + f - (on ? 1 : 0), -3 * T, 3 * T);
      run++;
      // each switch draws its next threshold at random: along a smooth gradient the debt grows
      // the same way in every band, so fixed thresholds would switch them all in step
      if (!on && e >= thr && LO[c] + 2 <= CAP[c]) { on = true; run = 0; thr = T * (0.4 + 1.2 * hash(k * 7919 + c, o.seed)); }
      else if (on && run >= minShort && e <= -thr) { on = false; run = 0; thr = T * (0.4 + 1.2 * hash(k * 7919 + c, o.seed + 3)); }
      NA[k * C + c] = LO[c] + (on ? 2 : 0);
    }
    // slivers cannot open at all: drop them (short runs that follow a thin dark feature, like the
    // rim of an eye, stay and open with a steeper fork)
    for (let lev = 3; lev <= nMaxAll; lev += 2) {
      let s = -1;
      for (let c = 0; c <= C; c++) {
        const on = c < C && NA[k * C + c] >= lev;
        if (on && s < 0) s = c;
        if (!on && s >= 0) {
          if (c - s < minFeature) for (let u = s; u < c; u++) NA[k * C + u] = lev - 2;
          s = -1;
        }
      }
    }
  }

  // opening weight of line j (>= 1) at column c: ramps from 0 at its pair's start and end
  const pairStart = new Int32Array(C), pairEnd = new Int32Array(C);
  const aw = new Float32Array(C * (nMaxAll + 1));
  function weights(k) {
    aw.fill(0);
    for (let c = 0; c < C; c++) aw[c * (nMaxAll + 1)] = 1;
    for (let lev = 3; lev <= nMaxAll; lev += 2) {
      let s = -1;
      for (let c = 0; c <= C; c++) {
        const on = c < C && NA[k * C + c] >= lev;
        if (on && s < 0) s = c;
        if (!on && s >= 0) {
          const e = c - 1;
          const rl = Math.max(1, Math.min(rampC, (e - s) / 2.2));
          for (let u = s; u <= e; u++) {
            pairStart[u] = s; pairEnd[u] = e;
            const a = Math.min(1, (u - s) / rl, (e - u) / rl);
            // pair lev = lines lev-2 (return) and lev-1 (out)
            aw[u * (nMaxAll + 1) + lev - 2] = a;
            aw[u * (nMaxAll + 1) + lev - 1] = a;
          }
          s = -1;
        }
      }
    }
  }

  // ---- 3. one line: walk the bands boustrophedon, teeth nested inside each band
  let cap = 1 << 16;
  let pts = new Float64Array(cap * 3);   // x, y, flag (1 = reversal)
  let np = 0;
  const push = (x, y, flag = 0) => {
    if (np) {
      const px = pts[(np - 1) * 3], py = pts[(np - 1) * 3 + 1];
      if (Math.abs(x - px) < 1e-7 && Math.abs(y - py) < 1e-7) { if (flag) pts[(np - 1) * 3 + 2] = flag; return; }
    }
    if (np >= cap) { cap *= 2; const g = new Float64Array(cap * 3); g.set(pts); pts = g; }
    pts[np * 3] = x; pts[np * 3 + 1] = y; pts[np * 3 + 2] = flag; np++;
  };
  let band = 0;
  const lineY = (j, c) => {
    const base = c * (nMaxAll + 1);
    const n = NA[band * C + c];
    let A = 1, acc = 0.5;
    for (let l = 1; l < n; l++) { A += aw[base + l]; if (l <= j) acc += aw[base + l]; }
    const y0 = Y[band * C + c], h = Y[(band + 1) * C + c] - y0;
    return y0 + h * acc / A;
  };
  let cols = null;
  const emit = (j, t, flag = 0) => push(xs[cols[t]], lineY(j, cols[t]), flag);
  function walkOut(j, a, b) {
    let t = a;
    while (t <= b) {
      emit(j, t);
      if (NA[band * C + cols[t]] >= j + 3) {
        let e = t;
        while (e < b && NA[band * C + cols[e + 1]] >= j + 3) e++;
        walkOut(j + 2, t, e);                       // out along the upper strand
        emit(j + 1, e, 1);                          // reversal where the pair closes
        for (let u = e - 1; u >= t; u--) emit(j + 1, u);   // back along the lower strand
        emit(j, t, 1);                              // reversal at the fork, on along the parent
        for (let u = t + 1; u <= e; u++) emit(j, u);
        t = e + 1;
      } else t++;
    }
  }
  const fwd = new Int32Array(C), bwd = new Int32Array(C);
  for (let c = 0; c < C; c++) { fwd[c] = c; bwd[c] = C - 1 - c; }
  let reversals = 0;
  for (band = 0; band < K; band++) {
    weights(band);
    cols = band % 2 ? bwd : fwd;
    if (band > 0) {
      // half-turn in the margin from the previous band's carrier to this one's
      const c = cols[0];
      const px = pts[(np - 1) * 3], py = pts[(np - 1) * 3 + 1];
      const qy = lineY(0, c);
      const cy = (py + qy) / 2, rr = Math.abs(qy - py) / 2, side = band % 2 ? 1 : -1;
      for (let i = 1; i < 12; i++) {
        const th = Math.PI * i / 12;
        push(px + side * rr * Math.sin(th), cy - rr * Math.cos(th), i === 6 ? 2 : 0);
      }
      reversals++;
    }
    walkOut(0, 0, C - 1);
  }

  // ---- 4. geometry: constant width and constant pressure
  if (np > MAX_POINTS) return { over: np };
  const data = new Float32Array(np * STRIDE);
  let s = 0;
  for (let i = 0; i < np; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], flag = pts[i * 3 + 2];
    if (i) s += Math.hypot(x - pts[(i - 1) * 3], y - pts[(i - 1) * 3 + 1]);
    if (flag === 1) reversals++;
    const o2 = i * STRIDE;
    data[o2] = x; data[o2 + 1] = y; data[o2 + 2] = w; data[o2 + 3] = s;
    data[o2 + 4] = o.pressure;
    data[o2 + 6] = flag ? 2 : 1;                    // the pen stops to reverse: ink pools a little
  }
  for (let i = 0; i < np; i++) data[i * STRIDE + 5] = data[i * STRIDE + 3] / (s || 1) * K;
  const lengthMm = s * mmPerCu;
  const handSec = lengthMm / o.speedMm + reversals * o.reverseSec;
  const buildMs = performance.now() - t0;
  return finishGeometry({
    n: np, data, colors: null, rings: K, spacing: H, technique: 'thickness',
    maxWidth: w, minWidth: w, penWidth: w, shape: 'square', start: 'edge',
    startPoint: { x: data[0], y: data[1] },
    path: 'real-engrave',
    real: {
      toolMm: o.toolMm, sheetMm: o.sheetMm, bands: K, levels: M, columns: C,
      lengthM: lengthMm / 1000, handMin: handSec / 60, speedMm: o.speedMm, reversals,
      points: np, buildMs,
    },
  });
}
