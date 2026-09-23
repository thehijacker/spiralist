// Realistic mode, style A: the squiggle spiral.
//
// One pen, one continuous line, drawn at the pen's real size. An Archimedean spiral runs out from
// the centre; the line oscillates across its own ring like a seismograph trace. Light areas: a calm,
// plain spiral. Darker: the wiggle grows taller and tighter until, at full darkness, the zigzag fills
// the whole gap between rings and adjacent strokes just touch. The stroke width never changes (it is
// the tool's physical width), and the tone channel is a steady hand pressure, so every bit of shading
// comes from how much line lies on the paper: a person or a pen plotter could draw the result.
//
// Scale: the sheet is `sheetMm` wide and the art circle's radius is `layoutR` of it, so one circle
// unit is sheetMm * layoutR mm (1 U = sheetMm / 1000 mm). The tool width in circle units sets the
// ring spacing (ringFactor x width), the tallest wiggle (ring spacing minus one width) and the
// tightest wiggle (the wavelength at which a full-height zigzag covers its band solid).
//
// Output: the spiral geometry format (spiral.js, STRIDE 7) with path 'real-squiggle',
// technique 'wave' (so the SVG export writes one stroke of the pen's width), plus `real` stats:
// line length in metres and an estimated hand drawing time.

import { sampleField } from '../tone.js';
import { STRIDE, MAX_POINTS, finishGeometry, wobbleOffset } from '../spiral.js';

// Presets trade detail (rings) for drawing time. More rings = finer image, more wiggles to draw,
// and a greyer highlight (a plain spiral already covers width / spacing of the paper).
export const PRESETS = Object.freeze({
  quick: { name: 'Quick sketch', ringFactor: 5.5 },
  detailed: { name: 'Detailed', ringFactor: 4.2 },
  masterpiece: { name: 'Masterpiece', ringFactor: 3.4 },
});

// Tone settings (tone.processTone) this style wants on top of TONE_DEFAULTS: a single fixed-width
// line has a narrower tonal range than width modulation (its lightest tone is a plain spiral), so
// stronger local contrast keeps eyes, nostrils and the mouth from sinking into the mid-greys.
export const SQUIGGLE_TONE = Object.freeze({ detail: 0.6 });

export const SQUIGGLE_DEFAULTS = Object.freeze({
  sheetMm: 210,        // sheet width
  toolMm: 0.5,         // the tool's real line width
  layoutR: 0.42,       // art circle radius, fraction of the sheet width (the app's default layout)
  preset: 'detailed',
  ringFactor: null,    // ring spacing / tool width (null: from the preset)
  minRings: 8,         // a fat tool on a small sheet still gets enough rings to show a subject
  maxRings: 200,
  toneGamma: 1.3,      // > 1 keeps light midtones calm (the plain spiral already greys the highlights)
  pack: 0.62,          // tightest wavelength vs the flank-touch estimate (the V notches at the crests need more)
  pressure: 0.82,      // steady hand pressure written to the tone channel (brush density)
  wobble: 0.35,        // 0 = plotter-perfect; 1 = loose hand (drift, uneven wiggles)
  direction: 'cw',
  edgeFade: 1.2,       // rings over which the drawing calms to the plain spiral at the rim
  seed: 1,
  speedMm: 40,         // hand speed along the line, mm/s (careful pen work)
  wiggleHz: 5,         // controlled zigzags a hand can make per second
});

// Wave shape, peak 1: asin(k sin) / asin(k). k -> 0 is a sine (the calm swell of light areas);
// k -> 1 is a triangle with rounded crests, whose straight flanks spread ink evenly across the band
// (a tall sine bunches ink at its crests), for the dense zigzag of the darks.
const wave = (ph, k) => Math.asin(k * Math.sin(ph)) / Math.asin(k);
const shapeK = u => 0.3 + 0.67 * u;

// Deterministic smooth 1D noise in [-1, 1] (hand irregularity along the line).
function hash1(i, seed) {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295 * 2 - 1;
}
function noise1(x, seed) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return hash1(i, seed) + (hash1(i + 1, seed) - hash1(i, seed)) * u;
}
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Resolved settings: tool width, ring spacing and the wiggle limits, all in circle units. */
export function squiggleScale(opts = {}) {
  const o = { ...SQUIGGLE_DEFAULTS, ...opts };
  const preset = PRESETS[o.preset] || PRESETS.detailed;
  const mmPerCU = o.sheetMm * o.layoutR;
  const t = o.toolMm / mmPerCU;
  const factor = o.ringFactor || preset.ringFactor;
  const rings = Math.max(o.minRings, Math.min(o.maxRings, Math.round(1 / (factor * t))));
  const d = 1 / rings;
  const tt = Math.min(t, d * 0.95);                  // a tool wider than the ring spacing is clamped
  // The smooth hand drift (wobbleOffset at 0.6 x wobble) squeezes neighbouring rings by up to
  // ~0.31 x 0.6 x wobble of the spacing; the tallest wiggle gives up a quarter of that, so full-dark rings
  // touch (as a careful hand's would) instead of crossing.
  const wob = Math.max(0, Math.min(1, o.wobble));
  const aMax = Math.max(0, (d - tt) / 2 - 0.25 * 0.31 * 0.6 * wob * d);
  // A full-height zigzag (peak to peak d - t) covers its band solid when its flank length per
  // wavelength times the width equals the band area: t * sqrt(lam^2 + 16 A^2) = lam * d.
  const lamSolid = 4 * aMax * tt / Math.sqrt(Math.max(1e-12, d * d - tt * tt));
  const lamMin = Math.max(lamSolid * o.pack, tt * 0.75);
  const lamMax = Math.max(lamMin * 1.5, d * 2.2);
  return { o, preset, mmPerCU, t: tt, rings, d, aMax, lamMin, lamMax, cMin: tt / d };
}

// Wiggle schedule: u in [0,1] -> amplitude and wavelength rise together (u = 0 is the plain spiral).
function schedule(S, u) {
  return {
    A: S.aMax * Math.pow(u, 0.8),
    lam: S.lamMax * Math.pow(S.lamMin / S.lamMax, Math.pow(u, 0.85)),
    k: shapeK(u),
  };
}

// Ink coverage of one ring band for a wiggle, measured, not estimated: rasterise one wavelength of
// the band (40 x 40 cells) and count the cells within half a tool width of the wave. A flank-length
// estimate double-counts where the strokes overlap at the crests and promised solid black too early.
function coverage(S, A, lam, k) {
  const r = S.t / 2, r2 = r * r;
  if (A < 1e-9) return Math.min(1, S.t / S.d);
  const M = 32, SEG = 2 * M, dx = lam / M;       // two wavelengths of curve, x from -lam/2
  const ys = new Float64Array(SEG + 1);
  for (let i = 0; i <= SEG; i++) ys[i] = A * wave(2 * Math.PI * (-0.5 + i / M), k);
  const NX = 40, NY = 40;
  let hit = 0;
  for (let ix = 0; ix < NX; ix++) {
    const x = (ix + 0.5) / NX * lam;
    const k0 = Math.max(0, Math.floor((x - r + lam / 2) / dx) - 1);
    const k1 = Math.min(SEG - 1, Math.floor((x + r + lam / 2) / dx) + 1);
    for (let iy = 0; iy < NY; iy++) {
      const y = ((iy + 0.5) / NY - 0.5) * S.d;
      for (let j = k0; j <= k1; j++) {
        const ax = -lam / 2 + j * dx, ay = ys[j], ex = dx, ey = ys[j + 1] - ay;
        const h = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
        const qx = x - ax - h * ex, qy = y - ay - h * ey;
        if (qx * qx + qy * qy <= r2) { hit++; break; }
      }
    }
  }
  return hit / (NX * NY);
}

/** Coverage -> schedule position lookup (coverage rises monotonically along the schedule). */
function inverseTable(S, N = 1024) {
  const U = 64;
  const cov = new Float64Array(U + 1);
  for (let i = 0; i <= U; i++) {
    const { A, lam, k } = schedule(S, i / U);
    cov[i] = Math.max(i ? cov[i - 1] + 1e-6 : 0, coverage(S, A, lam, k));
  }
  const lo = cov[0], hi = cov[U];
  const inv = new Float32Array(N + 1);
  let j = 0;
  for (let k = 0; k <= N; k++) {
    const c = lo + (hi - lo) * k / N;
    while (j < U && cov[j + 1] < c) j++;
    const a = cov[j], b = cov[Math.min(U, j + 1)];
    inv[k] = (j + (b > a ? (c - a) / (b - a) : 0)) / U;
  }
  return { inv, lo, hi, N };
}

/**
 * Build the squiggle spiral.
 * @param field  darkness field (tone.buildField); build it with `rings: squiggleScale(opts).rings`
 * @param opts   SQUIGGLE_DEFAULTS-shaped
 */
export function build(field, opts = {}) {
  const t0 = performance.now();
  const S = squiggleScale(opts);
  const { o, t, d, rings } = S;
  const table = inverseTable(S);
  const b = d / (2 * Math.PI);
  const theta0 = Math.PI;                    // start half a ring out
  const thetaEnd = 1 / b;
  const dirSign = o.direction === 'ccw' ? -1 : 1;
  const wob = Math.max(0, Math.min(1, o.wobble));
  const seed = (o.seed | 0) || 1;
  const fade = Math.max(0, o.edgeFade) * d;
  const fieldPx = 2 / field.G;
  const baseStep = Math.min(d / 3, fieldPx * 0.9);
  const PER_WAVE = 12;                       // chords per wiggle: crests stay round at 4K
  const speed = o.speedMm / S.mmPerCU;       // circle units per second
  const drift = [0, 0];
  const aCap = S.aMax;

  let cap = 1 << 16;
  let data = new Float32Array(cap * STRIDE);
  let n = 0, theta = theta0, prevTheta = theta0, phase = 0;
  let px = 0, py = 0, sAcc = 0, handT = 0, cycles = 0, centre = 0, lastDrift = 0;
  for (;;) {
    const last = theta >= thetaEnd;
    if (last) theta = thetaEnd;
    const r = b * theta;
    const c = Math.cos(theta), sn = Math.sin(theta);
    const bx = r * c, by = r * sn * dirSign;

    // Darkness under the pen -> target coverage -> position on the wiggle schedule.
    let D = Math.max(0, Math.min(1, sampleField(field, bx, by)));
    if (fade > 0) D *= 1 - smoothstep(1 - fade, 1, r);
    // the first ring stays a plain curl and the wiggle grows in over the next two: zigzags on a
    // radius smaller than their own height fold into a star-shaped knot at the centre
    const ramp = smoothstep(theta0 + Math.PI, theta0 + Math.PI * 5, theta);
    const cTarget = S.cMin + (1 - S.cMin) * Math.pow(D, o.toneGamma) * ramp;
    const k = Math.max(0, Math.min(1, (cTarget - table.lo) / Math.max(1e-9, table.hi - table.lo))) * table.N;
    const ki = Math.min(table.N - 1, k | 0);
    const u = table.inv[ki] + (table.inv[ki + 1] - table.inv[ki]) * (k - ki);
    const sch = schedule(S, u);
    // a hand's wiggles are never identical: slow drift of height and pitch along the line
    const jA = 1 - 0.08 * wob * (0.5 + 0.5 * noise1(sAcc / (d * 3.1), seed + 7));
    const jL = 1 + 0.07 * wob * noise1(sAcc / (d * 2.3), seed + 13);
    const A = Math.min(aCap, sch.A) * jA;
    const lam = sch.lam * jL;

    const vel = Math.sqrt(r * r + b * b);
    const travel = (theta - prevTheta) * vel;
    const dPhase = 2 * Math.PI * travel / lam;
    phase += dPhase;
    // the hand drift is a smooth field (correlation ~16 mm): re-evaluating it every ~0.25 mm of the
    // centre-line is plenty and saves most of the build's noise work
    centre += travel;
    if (n === 0 || centre - lastDrift > 0.003) { wobbleOffset(bx, by, wob * 0.6, seed, drift); lastDrift = centre; }
    const radial = drift[0] * c + drift[1] * sn * dirSign;
    const rr = r + A * wave(phase, sch.k) + radial * ramp;
    const x = rr * c, y = rr * sn * dirSign;
    let ds = 0;
    if (n > 0) { ds = Math.hypot(x - px, y - py); sAcc += ds; }
    // hand time: along the line at the hand's speed, but never faster than it can zigzag
    const dtFree = ds / speed, dt = Math.max(dtFree, dPhase / (2 * Math.PI * o.wiggleHz));
    handT += dt;
    cycles += dPhase / (2 * Math.PI);
    if (n >= MAX_POINTS) break;
    if (n >= cap) {
      cap = Math.ceil(cap * 1.7);
      const grown = new Float32Array(cap * STRIDE); grown.set(data); data = grown;
    }
    // dwell = hand time over free travel time: the pen lingers in the dense zigzags, so 'natural'
    // pacing (travel x dwell, the tone channel being a steady pressure) plays the drawing at the
    // hand's own rhythm, and wet media gather ink where a real pen would
    const dwell = dtFree > 1e-12 ? Math.min(6, dt / dtFree) : 1;
    const q = n * STRIDE;
    data[q] = x; data[q + 1] = y;
    data[q + 2] = t;                                            // the tool's width, always
    data[q + 3] = sAcc;
    data[q + 4] = o.pressure * (1 + 0.04 * wob * noise1(sAcc / (d * 7), seed + 3));
    data[q + 5] = (theta - theta0) / (2 * Math.PI);
    data[q + 6] = dwell;
    px = x; py = y; n++;
    if (last) break;

    prevTheta = theta;
    const step = A > 1e-9 ? Math.min(baseStep, lam / PER_WAVE) : baseStep;
    theta += Math.min(step / vel, 0.12);
  }
  const buildMs = performance.now() - t0;
  const geom = finishGeometry({
    n, data: data.subarray(0, n * STRIDE), colors: null,
    rings, spacing: d, technique: 'wave',
    maxWidth: t, minWidth: t, penWidth: t,
    start: 'center', path: 'real-squiggle',
    layout: { cx: 0.5, cy: 0.5, r: o.layoutR },
  });
  const lengthMm = geom.length * S.mmPerCU;
  geom.real = {
    style: 'squiggle', preset: o.preset, toolMm: o.toolMm, sheetMm: o.sheetMm,
    rings, spacingMm: +(d * S.mmPerCU).toFixed(3), lightestCoverage: +S.cMin.toFixed(3), darkestCoverage: +table.hi.toFixed(3),
    lengthM: +(lengthMm / 1000).toFixed(2), wiggles: Math.round(cycles),
    handSeconds: Math.round(handT), speedMm: o.speedMm, wiggleHz: o.wiggleHz,
    points: n, buildMs: +buildMs.toFixed(1), truncated: n >= MAX_POINTS,
  };
  return geom;
}

/** "1 h 12 min" style duration. */
export function formatDuration(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
