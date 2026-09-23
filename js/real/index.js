// Realistic mode: "a real pen on a real sheet". One entry point for the four one-line styles
// (A squiggle spiral, B stipple tour, C scribble, D flow engraving). Every style draws ONE line at
// the tool's real width with constant pressure; shading comes only from how dense and wiggly that
// line gets, so a person could draw the result by hand.
//
// buildReal(styleId, field, opts) -> geom (spiral.js format) with
//   geom.real  = { style, letter, preset, tool, toolMm, sheetMm, lengthM, handSeconds, points, buildMs }
//   geom.handT = Float32Array(n), cumulative seconds of hand drawing per point (monotone), so a
//                film or the stage can play the true drawing sped up.
// The hand clock is also installed as every pacing table of the geometry (geom._pace), so anything
// that paces by pacingTable/indexAt (stage, wet simulation, film) follows the real hand rhythm.
//
// Scale: all four builders work in circle units with layout r = LAYOUT_R, so one circle unit is
// LAYOUT_R x sheetMm millimetres and the tool width is toolMm / (LAYOUT_R x sheetMm).

import { build as buildSquiggle, squiggleScale, PRESETS as SQUIGGLE_PRESETS, SQUIGGLE_TONE } from './squiggle.js';
import { build as buildStipple } from './stipple.js';
import { build as buildScribble } from './scribble.js';
import { build as buildEngrave, ENGRAVE_PRESETS } from './engrave.js';
import { STRIDE } from '../spiral.js';

export const LAYOUT_R = 0.42;

/** Detail presets shared by every style (each style maps them to its own knobs). */
export const REAL_PRESETS = [
  { id: 'quick', name: 'Quick sketch' },
  { id: 'detailed', name: 'Detailed' },
  { id: 'masterpiece', name: 'Masterpiece' },
];

/**
 * Standard sheet sizes, smallest first (auto picks the first one the tool can draw a face on). The
 * drawing is square, so a sheet is the square cut from (or drawn on) that paper: A4 = 21 x 21 cm.
 * 120 cm lets 3 mm brushes stop short of 150 cm; 200 cm gives a 5 mm chalk stick a face.
 */
export const SHEETS = [
  { mm: 210, name: 'A4', label: '21 cm' },
  { mm: 297, name: 'A3', label: '29.7 cm' },
  { mm: 420, name: 'A2', label: '42 cm' },
  { mm: 594, name: 'A1', label: '59.4 cm' },
  { mm: 841, name: 'A0', label: '84.1 cm' },
  { mm: 1000, name: '100 cm', label: '100 cm' },
  { mm: 1200, name: '120 cm', label: '120 cm' },
  { mm: 1500, name: '150 cm', label: '150 cm' },
  { mm: 2000, name: '200 cm', label: '200 cm' },
];

// A broad tool is a stick or a brush moved by the whole arm: slower strokes per second, faster travel.
const isStick = toolMm => toolMm >= 1.5;
const tCU = (toolMm, sheetMm) => toolMm / (LAYOUT_R * sheetMm);
// Share of the tool width that marks at full strength (soft media leave a grainy halo): the
// scribble calibrates its loop density with it (measured in part 1).
const MARK_RATIO = { charcoal: 0.9, chalk: 0.8, crayon: 0.9, pencil: 0.85 };

function engraveLevels(o) {
  const p = ENGRAVE_PRESETS[o.preset] || ENGRAVE_PRESETS.detailed;
  // broad sticks: at most 5 lines per band. Part 1 used 3 to keep bands short, but 3 lines give
  // only two tones (1 or 3 lines), so a stick engraving barely showed a face on 1.5 m; 5 reads
  return isStick(o.toolMm) ? Math.min(5, p.levels) : p.levels;
}

/**
 * The four styles. minSheetRatio = the smallest sheet width / tool width at which this style can
 * still draw a recognisable face at the Detailed preset (measured on the part 1 busts):
 *   A squiggle: ~40 rings at 4.2 tool widths per ring      -> ~360
 *   B stipple:  a stick on A0 is a worm maze; on 150 cm a portrait (round 2 art review) -> ~350
 *   C scribble: likewise; at 140 a stick drew a SHORTER drawing than a pen on A4       -> ~330
 *   D engrave:  ~100 bands of 3-5 lines (1 m barely reads)  -> ~360 (150 cm for a stick)
 * tone = tone settings merged over the user's untouched defaults; fieldRings = the blur scale of
 * the darkness field each builder was tuned with.
 */
export const REAL_STYLES = [
  {
    id: 'squiggle', letter: 'A', name: 'Squiggle spiral',
    blurb: 'One spiral from the centre that zigzags tighter where the photo is dark.',
    build: buildSquiggle, presets: SQUIGGLE_PRESETS, minSheetRatio: 360, tone: SQUIGGLE_TONE, shape: 'circle',
    fieldRings: o => squiggleScale(o).rings,
    options: o => ({ speedMm: isStick(o.toolMm) ? 60 : 40, wiggleHz: isStick(o.toolMm) ? 3 : 5 }),
  },
  {
    id: 'stipple', letter: 'B', name: 'Stipple tour',
    blurb: 'A maze-like tour through thousands of dots, packed where it is dark.',
    build: buildStipple, presets: null, minSheetRatio: 350, tone: {}, shape: 'square',
    fieldRings: o => Math.max(12, Math.round(1 / (1.2 * tCU(o.toolMm, o.sheetMm)))),
    options: () => ({}),
  },
  {
    id: 'scribble', letter: 'C', name: 'Scribble',
    blurb: 'Circling loops that pile up in the shadows, like ballpoint shading.',
    build: buildScribble, presets: null, minSheetRatio: 330, tone: {}, shape: 'square',
    fieldRings: () => 110,
    options: o => ({ markRatio: MARK_RATIO[o.tool] || 1 }),
  },
  {
    id: 'engrave', letter: 'D', name: 'Flow engraving',
    blurb: 'Long parallel strokes that bend over the form, like an old banknote.',
    build: buildEngrave, presets: ENGRAVE_PRESETS, minSheetRatio: 360, tone: {}, shape: 'square',
    fieldRings: o => {
      const bands = Math.round(1.97 / (engraveLevels(o) * tCU(o.toolMm, o.sheetMm)));
      return Math.max(8, Math.round(bands / 2));
    },
    options: o => {
      const p = ENGRAVE_PRESETS[o.preset] || ENGRAVE_PRESETS.detailed;
      // the preset's own tool size is ignored: the user's tool is the real one
      return { levels: engraveLevels(o), speedMm: isStick(o.toolMm) ? 60 : p.speedMm };
    },
  },
];

export const realStyleById = id => REAL_STYLES.find(s => s.id === id) || REAL_STYLES[0];

/** The smallest standard sheet on which this tool can draw a face in this style. */
export function autoSheet(styleId, toolMm) {
  const need = realStyleById(styleId).minSheetRatio * toolMm;
  return (SHEETS.find(s => s.mm >= need * 0.97) || SHEETS[SHEETS.length - 1]).mm;
}

/**
 * How well a sheet suits the tool: ok = a face will read; tooSmall = honest warning; tooBig = the
 * drawing would take days (and more line than the geometry holds), so the UI offers it disabled.
 */
export function sheetFit(styleId, toolMm, sheetMm) {
  const ratio = sheetMm / toolMm, min = realStyleById(styleId).minSheetRatio;
  return { ratio, min, ok: ratio >= min * 0.97, tooSmall: ratio < min * 0.97, tooBig: ratio > Math.max(1300, min * 4) };
}

/**
 * A sheet picked by hand that the tool can no longer fill (a fine pen landing on a 150 cm sheet
 * chosen for a stick) snaps to the largest sheet that still fits; null when the sheet is fine.
 */
export function fitManualSheet(styleId, toolMm, sheetMm) {
  if (!sheetFit(styleId, toolMm, sheetMm).tooBig) return null;
  const ok = SHEETS.filter(s => !sheetFit(styleId, toolMm, s.mm).tooBig);
  return (ok.length ? ok[ok.length - 1] : SHEETS[0]).mm;
}

/** The resolved options a builder gets (also the cache key of a build). */
export function realOptions(styleId, o) {
  const style = realStyleById(styleId);
  const base = {
    sheetMm: o.sheetMm || 210, toolMm: o.toolMm || 0.5, layoutR: LAYOUT_R,
    preset: o.preset || 'detailed', seed: o.seed || 1, tool: o.tool || 'fineliner',
  };
  if (o.x != null) base.x = o.x;
  if (o.y != null) base.y = o.y;
  return { ...base, ...style.options(base) };
}

/** The darkness-field blur (buildField rings) this style was tuned with, for these options. */
export function realFieldRings(styleId, o) {
  return realStyleById(styleId).fieldRings(realOptions(styleId, o));
}

/** Build one style. field = tone.buildField output (only G, D, rings are read). */
export function buildReal(styleId, field, opts = {}) {
  const t0 = performance.now();
  const style = realStyleById(styleId);
  const o = realOptions(style.id, opts);
  const geom = style.build(field, o);
  if (!opts.exact) handWarp(geom, o);
  const mmPerCU = LAYOUT_R * o.sheetMm;
  const src = geom.real || geom.stats || {};
  const lengthM = (geom.length || 0) * mmPerCU / 1000;
  let handSeconds = src.handSeconds ?? (src.handMin != null ? src.handMin * 60 : null);
  if (!(handSeconds > 0)) handSeconds = lengthM * 1000 / (isStick(o.toolMm) ? 50 : 30);
  const handT = geom.handT instanceof Float32Array && geom.handT.length === geom.n ? geom.handT : deriveHandT(geom, handSeconds);
  geom.handT = handT;
  if (style.id === 'squiggle') {
    // The squiggle's dwell (up to 6) is a pace (hand time / free travel) and the hand clock above
    // already carries it. The wet simulation reads dwell as the pen LINGERING, and a fast zigzag
    // does not linger: left as is, watercolour and fountain ink pool in bands over every dark area.
    const d = geom.data;
    for (let i = 0; i < geom.n; i++) if (d[i * STRIDE + 6] > 1.3) d[i * STRIDE + 6] = 1.3;
  }
  geom.real = {
    ...src,
    style: style.id, letter: style.letter, name: style.name, preset: o.preset, tool: o.tool,
    toolMm: o.toolMm, sheetMm: o.sheetMm, lengthM, handSeconds: handT[geom.n - 1] || handSeconds,
    points: geom.n, buildMs: Math.round(performance.now() - t0),
  };
  installHandPacing(geom);
  return geom;
}

/**
 * The hand's drift. Every builder is mathematically exact (a perfect spiral, dead-straight rows),
 * which reads as a plotter under a film that says 'drawn by hand'. A person's arm drifts slowly:
 * the whole drawing is bent by a smooth, seeded warp of the plane (three octaves, wavelengths
 * 30-100 mm scaled up with the arm's reach on big sheets, amplitude 1.2 % of each wavelength, so
 * about 2 mm on A4). The warp's slope stays under 0.25, so it is one-to-one: lines that did not
 * cross still never cross, and neighbouring lines keep their spacing. opts.exact skips it.
 */
export function handWarp(geom, o) {
  const { n, data } = geom;
  if (!n) return geom;
  const mmPerCU = LAYOUT_R * o.sheetMm, reach = Math.sqrt(Math.max(1, o.sheetMm / 210));
  let h = (o.seed | 0) * 0x9e3779b1 + 0x7f4a7c15;
  const rnd = () => { h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
  const waves = [];
  for (const lamMm of [30, 55, 100]) {
    const lam = lamMm * reach / mmPerCU, amp = 0.012 * lam, k = 2 * Math.PI / lam;
    // two waves per axis per octave, at random directions and phases
    for (let axis = 0; axis < 2; axis++) for (let j = 0; j < 2; j++) {
      const a = rnd() * Math.PI * 2;
      waves.push({ axis, kx: k * Math.cos(a), ky: k * Math.sin(a), ph: rnd() * Math.PI * 2, amp: amp / Math.SQRT2 });
    }
  }
  let s = 0, px = 0, py = 0;
  for (let i = 0; i < n; i++) {
    const o2 = i * STRIDE, x = data[o2], y = data[o2 + 1];
    let dx = 0, dy = 0;
    for (const w of waves) {
      const v = w.amp * Math.sin(w.kx * x + w.ky * y + w.ph);
      if (w.axis) dy += v; else dx += v;
    }
    const nx = x + dx, ny = y + dy;
    if (i) s += Math.hypot(nx - px, ny - py);
    data[o2] = nx; data[o2 + 1] = ny; data[o2 + 3] = s;
    px = nx; py = ny;
  }
  geom.length = s;
  if (geom.startPoint) geom.startPoint = { x: data[0], y: data[1] };
  return geom;
}

/**
 * A per-point hand clock for builders that only report the total: time along the line weighted by
 * the builder's dwell (how much slower the hand is there than free travel), scaled to the total.
 */
export function deriveHandT(geom, handSeconds) {
  const { n, data } = geom;
  const T = new Float32Array(n);
  let acc = 0;
  for (let i = 1; i < n; i++) {
    const ds = Math.max(0, data[i * STRIDE + 3] - data[(i - 1) * STRIDE + 3]);
    const dwell = Math.max(1, data[i * STRIDE + 6] || 1);
    acc += ds * dwell + 1e-9;   // + epsilon: strictly monotone even at repeated points
    T[i] = acc;
  }
  const k = acc > 0 ? handSeconds / acc : 0;
  for (let i = 1; i < n; i++) T[i] *= k;
  return T;
}

/** Every pacing of a realistic drawing is the hand clock: the only honest pace there is. */
export function installHandPacing(geom) {
  if (!geom.handT) return geom;
  if (!(geom._pace instanceof Map)) geom._pace = new Map();
  for (const k of ['natural', 'steady', 'rings']) geom._pace.set(k, geom.handT);
  return geom;
}

/** Hand time -> the fractional point index reached by then (binary search in handT). */
export function indexAtHand(geom, seconds) {
  const T = geom.handT, n = geom.n;
  if (!T || n < 2 || seconds <= 0) return 0;
  if (seconds >= T[n - 1]) return n - 1;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= seconds) lo = m; else hi = m; }
  const span = T[hi] - T[lo];
  return lo + (span > 0 ? (seconds - T[lo]) / span : 0);
}

/** '25 min', '1 h 05 min', '3 d 4 h' — drawing time as a person would say it. */
export function formatHand(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 90) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 48) return `${h} h ${String(m).padStart(2, '0')} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** '4 mm', '0.4 mm', '84.1 cm', '1.5 m' */
export function formatMm(mm) {
  if (mm >= 1000) return `${+(mm / 1000).toFixed(2)} m`;
  if (mm >= 100) return `${+(mm / 10).toFixed(1)} cm`;
  return `${+mm.toFixed(2)} mm`;
}

/** The square sheet as a person would buy or cut it: '21 × 21 cm', '1.5 × 1.5 m'. */
export function formatSheet(mm) {
  if (mm >= 1000) { const m = +(mm / 1000).toFixed(2); return `${m} × ${m} m`; }
  const cm = +(mm / 10).toFixed(1);
  return `${cm} × ${cm} cm`;
}
