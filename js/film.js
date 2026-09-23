// Timelapse: timeline maths, the frame composers and the Film dialog (setup -> filming -> result).
//
// Timeline for a film of length L seconds (TIMELINE holds each style's numbers):
//   0 .. intro            the tool glides in and touches down at the start of the line
//   intro .. +D           the drawing (D = drawSeconds(L)), eased in and out
//   .. +lift              the tool lifts (cinematic: and is laid down on the desk beside the sheet)
//   .. +hold              the finished drawing holds (shorter when the reveal follows: it is a hold)
//   .. +reveal (optional) the photo appears inside the art and the drawing comes back
// The transport on the stage previews the D seconds of drawing (cinematic timeline).
//
// Two styles share that structure:
//   flat       the whole sheet from straight above on the chosen desk (the original film)
//   cinematic  a perspective shot of the sheet on the chosen premium desk (js/scene.js, desks.js;
//              the dialog's Background picker, prefs.film.desk, Nero marble by default). The pen lands in an
//              extreme close-up and draws at close to real speed; time then speeds up steadily as
//              the camera pulls back (a centre spiral), roams over the region being filled (maze,
//              wander, contour) or pushes in as the line closes (a spiral from the rim). It ends on
//              a straight full-sheet shot that keeps creeping in, while the pen lies on the desk
//              and the reveal retraces the drawing. Pace and camera are planned for the whole film
//              up front as functions of time, so the dialog's live preview and the encode match.
// Realistic and Line art films (doc.mode 'realistic' | 'lineart') are the true drawing: the pen
// follows the planned order on the hand's own clock (geom.handT), opens in the macro at 1x and
// speeds up to what the film's length needs. A Line art drawing (1-4 min by hand) films at near
// real speed (15/30/60 s, about 2-8x at 30 s; never slowed below 1x: a short one holds longer at
// the end), its looks at the model play at half the line's speed-up with the pen hovering, and the
// counter and end card say the hand time to the second ("2 min 02 s of drawing in 30 s").
// Everything is a pure function of the frame's time: frames can be drawn in any order.

import { Renderer } from './renderer.js';
import { indexAt, headAt, STRIDE } from './spiral.js';
import { hexToRgb, luminance } from './materials.js';
import { toast, announce, bindSeg, reducedMotion, isTouch } from './ui.js';
import { DESKS, deskById } from './desks.js';
import { cleanSignature, traceSignature, timeSignature, placeSignature, ensureSignatureFont, signatureFontLoaded, SIGNATURE_MAX } from './signature.js';
import { shareToX, openXIntent } from './share.js';
import { lightById } from './papers.js';
import { formatHand as formatHandSaid } from './real/index.js';

export const FPS = 30;
export const FPS_CHOICES = [30, 60];
export const STYLES = ['cinematic', 'flat'];
// signTravel: the pen's hop from the end of the line to the start of the signature; signHoldCut:
// how much of the hold the signing replaces (the name being written is a moment of rest too)
const TIMELINE = {
  flat: { intro: 0.6, lift: 0.45, hold: 1.7, holdReveal: 1.7, reveal: 2.4, signTravel: 0.4, signHoldCut: 0.4 },
  // the cinematic film puts ink on paper by ~0.4 s, and with the reveal on it skips most of the
  // hold (the reveal is a hold of its own)
  cinematic: { intro: 0.4, lift: 0.6, hold: 1.6, holdReveal: 0.8, reveal: 2.0, signTravel: 0.45, signHoldCut: 0.4 },
};

/** Seconds the pen takes to write signature `text` (0 without one): 1.0 s, up to 1.4 s for long names. */
export function signSeconds(text) {
  const t = cleanSignature(text);
  return t ? 1.0 + 0.4 * clamp((t.length - 4) / (SIGNATURE_MAX - 12), 0, 1) : 0;
}

// Width of the signature's line per medium (mm on the 200 mm sheet: the nib of that kind of tool),
// and how its strokes start and end: the share of the full width at the very start (w0) and end
// (w1) and over how many mm it gets there. A brush swells in and flicks out; a pen starts on its
// full nib and lifts off with a short taper; a crayon or charcoal stick wears to a blunt end.
const SIGN_PEN = {
  pencil: { mm: 0.5, w0: 0.6, in: 0.4, w1: 0.35, out: 0.9 },
  fineliner: { mm: 0.42, w0: 0.9, in: 0.1, w1: 0.55, out: 0.3 },
  fountain: { mm: 0.55, w0: 0.85, in: 0.15, w1: 0.4, out: 0.6 },
  crayon: { mm: 1.15, w0: 0.7, in: 0.5, w1: 0.55, out: 0.8 },
  ballpoint: { mm: 0.42, w0: 0.8, in: 0.15, w1: 0.45, out: 0.5 },
  marker: { mm: 1.15, w0: 0.95, in: 0.1, w1: 0.8, out: 0.3 },
  brush: { mm: 1.05, w0: 0.2, in: 1.2, w1: 0.12, out: 2.4 },
  charcoal: { mm: 1.25, w0: 0.6, in: 0.6, w1: 0.4, out: 1.2 },
  chalk: { mm: 1.3, w0: 0.6, in: 0.6, w1: 0.45, out: 1.2 },
  neon: { mm: 0.75, w0: 0.9, in: 0.1, w1: 0.6, out: 0.3 },
  gold: { mm: 0.7, w0: 0.85, in: 0.15, w1: 0.5, out: 0.4 },
  watercolour: { mm: 1.15, w0: 0.25, in: 1.2, w1: 0.15, out: 2.2 },
};
const SHEET_MM = 200;
const WIPE_IN = 0.85, WIPE_HOLD = 0.55, WIPE_OUT = 0.6;   // cinematic reveal (sums to 2.0 s)
const TRACK_HZ = 60;           // pen / camera tracks are sampled at this rate, then interpolated
const TOOL_LEN = { flat: 0.3, cinematic: 0.45 };   // tool length in sheet widths (a ~140 mm pen on A4 in cinematic)
const TOOL_ANGLE = 35;         // resting hand angle, degrees from vertical (body toward lower right)
const HOLD_ELEV = 28;          // how steeply the held pen rises from the paper (depth of field)
const PATH_SAMPLES = 16384;    // the line resampled by progress, for the pacing (a few samples per inner ring)
const DEG = Math.PI / 180;
export const FORMATS = {
  story: { w: 1080, h: 1920, name: 'Story' },
  portrait: { w: 1080, h: 1350, name: 'Portrait' },
  square: { w: 1080, h: 1080, name: 'Square' },
  wide: { w: 1920, h: 1080, name: 'Wide' },
};
// Where the pen tip may go in the cinematic frame (fractions x0, y0, x1, y1): clear of the edges,
// and of the bottom of a story, where apps put their UI.
const SAFE = {
  story: [0.1, 0.1, 0.9, 0.76],
  portrait: [0.1, 0.1, 0.9, 0.84],
  square: [0.1, 0.1, 0.9, 0.9],
  wide: [0.08, 0.1, 0.92, 0.9],
};

/**
 * Where the sheet lies in the frame (the flat film's layout; the cinematic film's final framing):
 * side (px), centre. Keeps the art clear of the bottom ~20% of a story, where apps put their UI.
 * The cinematic film ends on a looser shot, so the desk frames the sheet the way a product shot
 * would (and the chosen desk is actually seen).
 */
export function sheetPlace(format, W, H, style = 'cinematic') {
  const k = Math.min(W, H), cine = style === 'cinematic';
  if (format === 'story') return { side: W * 0.86, cx: W / 2, cy: H * 0.42 };
  if (format === 'portrait') return { side: k * (cine ? 0.74 : 0.84), cx: W / 2, cy: H * (cine ? 0.46 : 0.48) };
  if (format === 'wide') return { side: H * (cine ? 0.78 : 0.86), cx: W * (cine ? 0.44 : 0.42), cy: H / 2 };
  return { side: k * (cine ? 0.76 : 0.86), cx: W / 2, cy: H / 2 };
}

/**
 * Seconds of drawing in a film of `length` s (the stage transport previews exactly this). sign =
 * signSeconds(signature): a signed film spends that long writing the name (and the hop to it),
 * taken from the drawing and a little of the hold.
 */
export function drawSeconds(length, reveal = false, style = 'cinematic', sign = 0) {
  const T = TIMELINE[style] || TIMELINE.cinematic;
  const signing = sign > 0 ? T.signTravel + sign - (reveal ? 0 : T.signHoldCut) : 0;
  return Math.max(3, length - T.intro - T.lift - (reveal ? T.holdReveal + T.reveal : T.hold) - signing);
}

// Smoothstep ramp integrated: S(x) = x^3 - x^4 / 2, S(1) = 0.5.
const S = x => x * x * x - 0.5 * x * x * x * x;
/**
 * Pen progress (0..1, fed to the pacing table) after fraction u of the drawing time D: the pen
 * accelerates over the first easeIn seconds (0.5) and settles over the last easeOut (0.6). The
 * flat film and the stage transport use it; the cinematic film paces the pen to its camera
 * (scene.js planPace).
 */
export function drawProgress(u, D, easeIn = 0.5, easeOut = 0.6) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const a = Math.min(easeIn, D / 4), b = Math.min(easeOut, D / 4);
  const A = D - 0.5 * a - 0.5 * b;
  const t = u * D;
  let p;
  if (t < a) p = a * S(t / a);
  else if (t <= D - b) p = 0.5 * a + (t - a);
  else p = A - b * S((D - t) / b);
  return Math.min(1, Math.max(0, p / A));
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mix = (a, b, t) => a + (b - a) * t;
const easeInOut = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const smooth = (a, b, x) => easeInOut((x - a) / (b - a));
const smoother = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };

// ---------------------------------------------------------------------------------- realistic film
// "True drawing, sped up": the pen runs along the one line in its real order, timed by the hand
// time the style models (geom.handT), opening at real speed and ramping to a timelapse.
// Real lengths of the tools (mm) and the sprite calibration: TOOL_LEN.cinematic (0.45 of the
// film's 210 mm sheet) is a ~140 mm pen, so a tool of L mm on a sheet S mm wide is
// 0.45 * (L / 140) * (210 / S) sheet widths long.
const TOOL_MM = { pencil: 175, fineliner: 140, fountain: 140, ballpoint: 145, marker: 135, brush: 190,
  crayon: 90, charcoal: 110, chalk: 80, neon: 140, goldpen: 140 };
const REAL_A4 = 210;

/**
 * The realistic geometry's facts, whatever style made it: { style, sheetMm, toolMm, handSeconds,
 * lengthM, handT (cumulative hand seconds per point, monotone) } or null when the geometry is not
 * a realistic one. js/real/index.js (buildReal) gives geom.real + geom.handT; a style module's own
 * geometry is accepted too (scribble keeps its facts in geom.stats), and a missing handT is derived
 * from arc length x dwell (every style slows the hand where dwell rises) scaled to the style's total.
 */
const realCache = new WeakMap();
export function realInfo(geom) {
  // (a Line art drawing, js/lineart/index.js, keeps its facts in geom.lineart and films the same way)
  const R = geom?.real || (geom?.path?.startsWith?.('real-') ? geom.stats : null) || (geom?.path === 'lineart' ? geom.lineart : null);
  if (!R || !(geom.n > 1)) return null;
  // (the dialog asks on every refresh: a derived clock is made once per geometry)
  const hit = realCache.get(geom);
  if (hit && hit.src === R && hit.T === geom.handT) return hit.info;
  const info = realFacts(geom, R);
  realCache.set(geom, { src: R, T: geom.handT, info });
  return info;
}

function realFacts(geom, R) {
  const n = geom.n, data = geom.data;
  const sheetMm = +R.sheetMm > 0 ? +R.sheetMm : REAL_A4;
  const toolMm = +R.toolMm > 0 ? +R.toolMm : 0.5;
  let total = +R.handSeconds > 0 ? +R.handSeconds : +R.handMin > 0 ? R.handMin * 60 : 0;
  let T = geom.handT && geom.handT.length === n ? geom.handT : null;
  if (!T) {
    const mmPerCu = sheetMm * (geom.layout?.r || 0.42);
    const speed = +R.speedMm > 0 ? +R.speedMm : +R.speedCmS > 0 ? R.speedCmS * 10 : 30;
    T = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const a = (i - 1) * STRIDE, b = i * STRIDE;
      const ds = Math.hypot(data[b] - data[a], data[b + 1] - data[a + 1]) * mmPerCu;
      T[i] = T[i - 1] + ds / speed * Math.max(1, 0.5 * (data[a + 6] + data[b + 6]));
    }
    if (total > 0 && T[n - 1] > 0) { const k = total / T[n - 1]; for (let i = 1; i < n; i++) T[i] *= k; }
  }
  if (!(total > 0)) total = T[n - 1];
  if (!(total > 0)) return null;
  const style = String(R.style || geom.path || '').replace(/^real-/, '');
  const info = { style, sheetMm, toolMm, handSeconds: total, lengthM: +R.lengthM || 0, handT: T, preset: R.preset || null,
    lineart: geom.path === 'lineart' };
  // the film's own clock: the hand's, except that a Line art artist's looks at the model play
  // slower than the drawing (lineClock), so the pause reads at 4-8x instead of flashing by
  info.clock = info.lineart ? lineClock(geom, T, sheetMm) : { F: T, P: null, total: T[n - 1] };
  if (info.lineart) {
    const L = geom.lineart;
    Object.assign(info, { retracedM: +L.retracedM || 0, bridgesM: +L.bridgesM || 0, engine: L.engine || null,
      pauses: info.clock.count, pauseSeconds: info.clock.paused });
  }
  return info;
}

// Line art (doc.mode 'lineart'): the looks at the model play at 1/PAUSE_SLOW of the drawing's
// speed-up. The pen stays on the paper while the artist looks (the one-line promise, and the ink
// pools there in the drawing): it only settles and the wrist turns a little.
const PAUSE_SLOW = 2;
const PAUSE_MIN = 0.12;        // hand seconds: shorter stops are the hand turning, not a look
const LOOK_LIFT = 0.02;        // tool settle at the top of a long look (tools.js: 0 touching .. 1 high)
const LOOK_WRIST = 4;          // degrees the wrist turns during a long look
/**
 * The pauses in a Line art geometry and the film clock that shows them. js/lineart/path.js adds
 * each look to the segment that arrives at a feature's entry (handT[i] - handT[i - 1] = travel +
 * pause), so the film moves the pen over that segment at the hand's speed first and then holds it
 * at the entry. geom.lineart.pause (seconds per point) is used when the planner provides it;
 * otherwise a pause is the time a segment takes beyond what its neighbours' speed explains.
 * Returns { F (film clock per point: the hand's, with the pauses stretched), P (pause seconds per
 * segment ending at i, or 0), total, count, paused }.
 */
function lineClock(geom, T, sheetMm) {
  const n = geom.n, d = geom.data;
  const given = geom.lineart?.pause;
  const P = new Float32Array(n);
  const mmPerCu = sheetMm * (geom.layout?.r || 0.42);
  const ds = i => Math.hypot(d[i * STRIDE] - d[(i - 1) * STRIDE], d[i * STRIDE + 1] - d[(i - 1) * STRIDE + 1]) * mmPerCu;
  const dt = i => T[i] - T[i - 1];
  let count = 0, paused = 0;
  for (let i = 1; i < n; i++) {
    let p;
    if (given && given.length === n) p = +given[i] || 0;
    else {
      const t = dt(i);
      if (t < PAUSE_MIN) continue;
      // the hand's speed just before and just after (mm/s), never under the planner's 1.5 mm/s floor
      let v = 1.5;
      for (const j of [i - 1, i + 1, i - 2, i + 2]) if (j >= 1 && j < n && dt(j) > 1e-6) v = Math.max(v, ds(j) / dt(j));
      p = t - ds(i) / v;
    }
    if (p >= PAUSE_MIN) { P[i] = Math.min(p, dt(i)); count++; paused += P[i]; }
  }
  const F = new Float64Array(n);
  for (let i = 1; i < n; i++) F[i] = F[i - 1] + dt(i) + (PAUSE_SLOW - 1) * P[i];
  return { F, P, total: F[n - 1], count, paused };
}

/**
 * The film's length in seconds for prefs.film `f`: a realistic drawing of half an hour or more
 * films for 60 s unless a length was picked by hand (f.lengthChosen), so its sped-up pen stays
 * readable. The stage transport can use it to preview the same film.
 */
export function filmLengthFor(f, geom, realistic = false) {
  // Line art (a geometry of path 'lineart', whatever the caller says): a drawing of 1-4 minutes
  // films at near real speed, so 30 s unless a length was picked by hand, and never 10 s (15/30/60)
  if (geom?.path === 'lineart' && realInfo(geom)) return lineartLength(f);
  const R = realistic ? realInfo(geom) : null;
  return R && !f.lengthChosen && R.handSeconds >= 1800 ? 60 : f.length;
}
/**
 * Seconds of drawing in the film prefs.film `f` makes of `geom` (what the stage transport should
 * preview): drawSeconds for the film's length, except that a Line art drawing shorter than that
 * at real speed is drawn at 1x (FilmComposer._shortenDrawing) and the sheet holds longer.
 */
export function filmDrawSeconds(f, geom, realistic = false) {
  const R = realistic || geom?.path === 'lineart' ? realInfo(geom) : null;
  const D = R ? drawSeconds(filmLengthFor(f, geom, realistic), false, f.style, signSeconds(f.signature))
    : drawSeconds(f.length, f.reveal, f.style, signSeconds(f.signature));
  return R?.lineart && R.clock.total + 0.2 < D ? R.clock.total + 0.2 : D;
}
export const LINEART_LENGTHS = [15, 30, 60];
function lineartLength(f) {
  const L = +f.length;
  if (!f.lengthChosen) return 30;
  return LINEART_LENGTHS.includes(L) ? L : L < 15 ? 15 : L > 60 ? 60 : 30;
}

/**
 * Hand time for the counter and the dialog: '12 s', '4 min', '1 h 04 min'. A total is said exactly
 * as the app's inspector says it (js/real/index.js rounds the minutes), so one drawing never reads
 * '24 min' there and '23 min' here; withSeconds is the live counter, a clock that counts up.
 */
export function formatHand(sec, withSeconds = false) {
  // (withSeconds 'total': a whole Line art drawing, said to the second: '2 min 02 s')
  if (!withSeconds || (withSeconds === 'total' && sec >= 3600)) return formatHandSaid(sec);
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  return withSeconds ? `${m} min ${String(r).padStart(2, '0')} s` : `${m} min`;
}

/** A speed-up for people: 1x, 2.5x, 38x, 240x, 1200x (two significant figures, no flicker). */
export function formatSpeed(k) {
  if (!(k >= 1.25)) return '1×';
  if (k < 10) { const r = Math.round(k * 2) / 2; return `${r % 1 ? r.toFixed(1) : r}×`; }
  const p = Math.pow(10, Math.floor(Math.log10(k)) - 1);
  return `${Math.round(k / p) * p}×`;
}

/**
 * The realistic film's clock: hand seconds as a function of film time over the drawing [t0, t1].
 * The hand starts at real speed (1x) for `open` seconds (the macro close-up, where the ink is seen
 * going down and soaking in), accelerates continuously (a smooth ramp in log speed: the speed
 * doubles at a steady rate) to the timelapse speed the film needs, cruises, and eases back down to
 * 1x for the last `last` seconds, so the final stroke is drawn at a believable pace before the pen
 * lifts. The peak speed is solved so the hand time adds up to exactly `total`.
 * Returns { at(t) -> 0..1 of the hand time, hand(t) -> s, speed(t) -> x, peak, avg, open, last }.
 */
export function planHandPace({ t0, t1, total, open = 2.6, last = 0.9, hz = 240 }) {
  const D = Math.max(1e-3, t1 - t0);
  const n = Math.max(3, Math.ceil(D * hz) + 1), dt = D / (n - 1);
  // the 1x opening is a tenth of the drawing at most: a 15 s clip must not spend 2.6 s (17%) on a
  // resting pen over a dot of ink
  const a = Math.min(open, 0.1 * D), b = Math.min(last, 0.12 * D);
  const rate = new Float64Array(n);
  // the hand's first touch: from rest to real speed over a fifth of a second
  const touch = s => smooth(0, Math.min(0.2, a), s);
  const fill = L => {
    const up = clamp(0.5 * L / Math.LN2, 0.6, 0.34 * D), down = clamp(0.32 * L / Math.LN2, 0.5, 0.2 * D);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const s = i * dt;
      const l = L * smoother(a, a + up, s) * (1 - smoother(D - b - down, D - b, s));
      rate[i] = Math.exp(l) * touch(s);
      if (i) sum += 0.5 * (rate[i - 1] + rate[i]) * dt;
    }
    return sum;
  };
  let peak = 1;
  if (fill(0) >= total) {
    // a drawing shorter than the film at real speed: one steady (slower) pace, still eased in
    const k = total / fill(0);
    for (let i = 0; i < n; i++) rate[i] *= k;
    peak = k;
  } else {
    let lo = 0, hi = 1;
    while (fill(hi) < total && hi < 30) hi *= 1.6;
    for (let k = 0; k < 40; k++) { const m = 0.5 * (lo + hi); if (fill(m) < total) lo = m; else hi = m; }
    fill(hi);
    peak = Math.exp(hi);
  }
  const H = new Float64Array(n);
  for (let i = 1; i < n; i++) H[i] = H[i - 1] + 0.5 * (rate[i - 1] + rate[i]) * dt;
  const scale = total / (H[n - 1] || 1);
  for (let i = 0; i < n; i++) { H[i] *= scale; rate[i] *= scale; }
  const look = (arr, t) => {
    if (t <= t0) return arr === H ? 0 : arr[0];
    if (t >= t1) return arr === H ? total : arr[n - 1];
    const f = (t - t0) / dt, i = Math.min(n - 2, Math.floor(f));
    return mix(arr[i], arr[i + 1], f - i);
  };
  return {
    at: t => look(H, t) / total, hand: t => look(H, t), speed: t => look(rate, t),
    peak: peak * scale, avg: total / D, open: a, last: b, total, D,
  };
}

/**
 * The key light for renderer.setLight (feature-detected): the renderer's own window light from
 * the upper left (where the scene's light pool and the tool shadows come from), swinging 50
 * degrees toward the top as sweep goes 0 -> 1 and rising as rise goes 0 -> 1 (to 62 degrees: a
 * camera looking straight down only catches a reflection from a high light), so gold, graphite,
 * wax and wet ink glint during the hold. glint = [direction, weight] (the macro): the light moves
 * toward that direction, where the fresh ink mirrors it into the lens, as a macro shot places its
 * strip light for the highlight. A unit direction [x, y, z] (paper space, y down, z up) that also
 * carries x/y/z, azimuth/elevation (radians) and sweep; view and eye are added per frame by the
 * cinematic film.
 */
const LIGHT_AZ0 = Math.atan2(-0.65, -0.55);        // renderer.js LIGHT0: the stills' light
function lightAt(sweep, rise = 0, glint = null, base = null) {
  // base (the realistic film): the light the user chose (papers.js LIGHTS), held still
  let az = (base ? base.azimuth : LIGHT_AZ0) + 50 * DEG * sweep, el = (base ? base.elevation / DEG : 40) * DEG + 22 * rise * DEG;
  if (glint && glint[1] > 0) {
    const [g, w] = glint;
    const gaz = Math.atan2(g[1], g[0]), gel = Math.asin(clamp(g[2], -1, 1));
    let da = gaz - az;
    da -= 2 * Math.PI * Math.round(da / (2 * Math.PI));
    az += da * w;
    el = mix(el, clamp(gel, 30 * DEG, 68 * DEG), w);
  }
  const d = [Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el)];
  const L = Object.assign(d, { x: d[0], y: d[1], z: d[2], azimuth: az, elevation: el, sweep, valueOf: () => az });
  if (base) { L.intensity = base.intensity; L.warmth = base.warmth; }
  return L;
}

// zero-phase Gaussian smoothing of a sampled track (edges held)
function gauss(src, sigma) {
  const n = src.length, out = new Float64Array(n);
  if (!(sigma > 0.5)) { out.set(src); return out; }
  const R = Math.ceil(sigma * 3), w = new Float64Array(2 * R + 1);
  let ws = 0;
  for (let k = -R; k <= R; k++) { w[k + R] = Math.exp(-0.5 * (k / sigma) ** 2); ws += w[k + R]; }
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -R; k <= R; k++) s += src[clamp(i + k, 0, n - 1)] * w[k + R];
    out[i] = s / ws;
  }
  return out;
}

// A frame-sized 2D layer for the tool (depth of field and the crisp nib are composited from it).
function makeLayer(W, H) {
  let c = null, g = null;
  try { c = new OffscreenCanvas(W, H); g = c.getContext('2d'); } catch { g = null; }
  if (!g) { c = document.createElement('canvas'); c.width = W; c.height = H; g = c.getContext('2d'); }
  return g ? { c, g } : null;
}

// Does this browser's 2D context blur with ctx.filter? (Checked once: Safari before 18 ignores it.)
let filterOk = null;
function canvasBlurWorks() {
  if (filterOk !== null) return filterOk;
  filterOk = false;
  try {
    const L = makeLayer(16, 16);
    const g = L.g;
    g.fillStyle = '#fff'; g.fillRect(7, 7, 2, 2);
    const M = makeLayer(16, 16);
    M.g.filter = 'blur(2px)';
    M.g.drawImage(L.c, 0, 0);
    filterOk = M.g.filter === 'blur(2px)' && M.g.getImageData(3, 7, 1, 1).data[3] > 0;
  } catch { filterOk = false; }
  return filterOk;
}

// ---------------------------------------------------------------------------------- composer
/**
 * Composes timelapse frames. All geometry of the frame scales with the output size, so the same
 * composer drives the small live preview and the full-size encode.
 */
export class FilmComposer {
  /**
   * @param o { W, H, format, length, fps, style: 'flat'|'cinematic', showTool, polaroid, reveal,
   *            pacing, state, drawPhoto(ctx,cx,cy,R), tools (tools.js), sceneLib (scene.js),
   *            desk: id (desks.js; default 'nero'), renderer (optional, shared: the dialog's
   *            preview and its encodes use one context, so the scene program and the baked desk
   *            are made once), live: bool (a preview: never waits for the desk to bake),
   *            signature: text (optional: the pen signs the sheet's lower-right corner at the end) }
   * Cinematic needs sceneLib and a renderer with renderToTexture; otherwise it films flat.
   */
  constructor(o) {
    Object.assign(this, o);
    this.fps = o.fps || FPS;
    this.frames = Math.round(this.length * this.fps);
    this.signature = cleanSignature(o.signature);
    // o.realistic (doc.mode === 'realistic'): true drawing, sped up. Only a geometry that carries
    // its real facts (realInfo) can be filmed that way; anything else films as it always has.
    // (the app's renderState says so itself: state.mode, state.light)
    // Line art (state.mode 'lineart') is a true drawing too: the artist's own order and clock
    const lineMode = o.state?.mode === 'lineart' || (o.lineart ?? false);
    this.real = (o.realistic ?? (o.state?.mode === 'realistic' || lineMode)) || lineMode ? realInfo(o.state?.geom) : null;
    this.lineart = !!this.real?.lineart;
    if (this.real) {
      // no photo reveal, no fades: only what a camera over a real desk would record
      this.reveal = false;
      this.pacing = 'natural';
      this.counter = o.counter !== false;
      this.realScale = REAL_A4 / this.real.sheetMm;
      const L = o.light ?? o.state?.light;
      this.baseLight = L && typeof L === 'object' && Number.isFinite(L.azimuth) ? L : lightById(L || 'window');
    } else { this.counter = false; this.realScale = 1; }
    this._setStyle(o.style === 'cinematic' && o.sceneLib ? 'cinematic' : 'flat');
    const { side, cx, cy } = sheetPlace(this.format, this.W, this.H, this.style);
    this.side = Math.round(side / 2) * 2;
    this.px = Math.round(cx - this.side / 2);
    this.py = Math.round(cy - this.side / 2);
    this.state = o.state;
    this.stats = { frames: 0, ms: 0 };
  }

  _setStyle(style) {
    this.style = style;
    const T = this.tl = TIMELINE[style];
    // the signature: hop over (t1 .. tS0), write (tS0 .. tS1); the pen is done at tDone
    this.signW = signSeconds(this.signature);
    this.D = drawSeconds(this.length, this.reveal, style, this.signW);
    this.t0 = T.intro;
    this.t1 = T.intro + this.D;
    this.tS0 = this.signW ? this.t1 + T.signTravel : this.t1;
    this.tS1 = this.tS0 + this.signW;
    this.tDone = this.tS1;
    this.hold = this.reveal ? T.holdReveal : T.hold - (this.signW ? T.signHoldCut : 0);
    this.tReveal = this.tDone + T.lift + this.hold;
    this.toolLen = TOOL_LEN[style];
    this.restAt = this.tDone + T.lift + 0.5;       // replaced by the camera plan in cinematic
    if (this.real) {
      // the tool at its real length on this sheet: a charcoal stick on a 1 m sheet looks small
      const mm = TOOL_MM[this.state?.brush?.tool] || 140;
      this.toolLen = TOOL_LEN[style] * (mm / 140) * this.realScale;
      // the pen follows the hand's own clock (both styles)
      const C = this.real.clock;
      const total = this.lineart ? C.total : this.real.handSeconds;
      // Line art at near real speed: a drawing shorter than the film's drawing time is drawn at 1x
      // (never slowed down); the sheet then holds longer on the desk
      if (this.lineart && total + 0.2 < this.D) this._shortenDrawing(total + 0.2);
      this.hand = planHandPace({ t0: this.t0, t1: this.t1, total });
      this.pace = this.hand;
    }
  }

  /** The drawing takes D seconds of the film instead (the pen's work ends sooner; the hold grows). */
  _shortenDrawing(D) {
    const T = this.tl, cut = this.D - D;
    this.D = D;
    this.t1 -= cut; this.tS0 -= cut; this.tS1 -= cut; this.tDone -= cut;
    this.hold += cut;
    this.tReveal = this.tDone + T.lift + this.hold;
    this.restAt = this.tDone + T.lift + 0.5;
  }

  /**
   * Line art: where the pen is on the film clock `h` (film-clock seconds, lineClock's F): the
   * fractional point index, the hand's own seconds at that moment, and how far a look at the model
   * has got (0 drawing .. 1 at the top of a long look: the settle and the turn of the wrist).
   */
  _lineAt(h) {
    const C = this.real.clock, F = C.F, P = C.P, T = this.real.handT, n = F.length;
    if (h <= 0) return { fi: 0, hand: 0, look: 0 };
    if (h >= F[n - 1]) return { fi: n - 1, hand: T[n - 1], look: 0 };
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (F[m] <= h) lo = m; else hi = m; }
    const local = h - F[lo], p = P ? P[hi] : 0;
    const move = Math.max(0, T[hi] - T[lo] - p);
    if (local < move || !p) {
      const k = move > 0 ? Math.min(1, local / move) : 1;
      return { fi: lo + k, hand: T[lo] + k * move, look: 0 };
    }
    // the look: the pen rests at the feature's entry, settles and the wrist turns a little, then
    // draws on; a long look turns it further than a glance
    const u = clamp((local - move) / (p * PAUSE_SLOW), 0, 1);
    const up = smooth(0, 0.3, u) * (1 - smooth(0.72, 1, u));
    return { fi: hi, hand: T[lo] + move + u * p, look: up * clamp(p / 0.7, 0.35, 1) };
  }

  /** Line art: the hover of a look at time t (0 elsewhere). */
  _look(t) {
    if (!this.lineart || !this.hand || t <= this.t0 || t >= this.t1) return 0;
    return this._lineAt(this.hand.hand(t)).look;
  }

  prepare() {
    const s = this.state;
    if (!this.renderer) {
      this.renderer = new Renderer(document.createElement('canvas'));
      this.ownsRenderer = true;
    }
    this.canvas = this.renderer.canvas;
    this.desk = deskById(this.desk).id;
    if (this.style === 'cinematic' && typeof this.renderer.renderToTexture !== 'function') this._setStyle('flat');
    const r = this.renderer;
    r.setLayout(s.layout);
    r.setPaper(s.paper, s.seed);
    r.setStyle(s);
    // the paper's grain, fibres and grit at their real millimetre size on the realistic film's
    // sheet (the shared renderer goes back to the A4 default for any other film)
    if (typeof r.setSheetMm === 'function') r.setSheetMm(this.real ? this.real.sheetMm : REAL_A4);
    // wet media advance with the drawing's pacing time: the renderer must know which one plays
    if (typeof r.setPacing === 'function') r.setPacing(this.pacing);
    // the cinematic pen is paced to the shot, so the pace comes before the pen's track
    if (this.style === 'cinematic') this._pace();
    this.sign = this.signW ? this._signLayout() : null;
    if (this.signW && !this.sign) this._dropSignature();
    this.penTrack = this._penTrack();
    this.pen = new Float64Array(this.frames);     // per-frame pen index (the tools lab reads it)
    for (let i = 0; i < this.frames; i++) this.pen[i] = this._fi(i / this.fps);
    if (this.style === 'cinematic') this._prepareCinematic();
    else {
      r.setSize(this.side, this.side);
      // (a shared renderer's canvas may still be a cinematic film's frame size)
      if (this.canvas.width !== this.side || this.canvas.height !== this.side) { this.canvas.width = this.side; this.canvas.height = this.side; }
      this._flatScene();
      this.bg = this._background();
    }
    // the renderer draws the signature too, as more of the same line (lifted between strokes), so
    // it is written by the same medium on the same paper under the same light
    r.setGeometry(this.sign ? this._signGeometry(s.geom) : s.geom);
    // Wet ink keeps the film's time: where the film lingers (the macro opening shows the first
    // turns for over a second) the fresh ink gets simulation steps to soak in and bleed on screen,
    // instead of the few its share of the line's pen time would give it.
    if (typeof r.setSimClock === 'function') r.setSimClock(this._simClock());
  }

  /**
   * The wet simulation's clock: film time over the pen's work (drawing, then signing), half and
   * half with the pen's own time, so the macro's ink bleeds visibly while the rest of the sheet
   * keeps its rhythm and the finished film stays close to the still.
   */
  _simClock() {
    const a = this.t0, b = this.sign ? this.tS1 : this.t1, M = 400;
    if (!(b > a)) return null;
    const at = [], v = [];
    for (let j = 0; j <= M; j++) {
      const t = a + (b - a) * j / M, fi = this._upTo(Math.min(t, b - 1e-6));
      if (Number.isFinite(fi)) { at.push(fi); v.push(j / M); }
    }
    return { at, v, mix: 0.5 };
  }

  destroy() {
    if (this.macroTex || this.macroCfg) this._macroRelease();
    try { this.scene?.destroy(); } catch { /* context already gone */ }
    if (this.ownsRenderer) this.renderer?.destroy();
    if (this.bg) { this.bg.width = this.bg.height = 0; }
    for (const L of this.layers || []) if (L) { L.c.width = L.c.height = 0; }
    this.renderer = null; this.scene = null; this.layers = null;
  }

  /**
   * Can a frame be drawn now without blocking on the driver? (The scene program and the medium's
   * programs compile in the background the first time a context shows a film; the dialog's
   * preview waits for them, and so does an encode before its first frame.)
   */
  ready() {
    const lib = this.sceneLib, r = this.renderer;
    if (r?.pending?.()) return false;
    return !this.scene || !lib?.sceneReady || lib.sceneReady(r.gl);
  }

  /** The preview loops: forget cached frames so the next draw starts clean. */
  rewind() {
    this.sheetKey = null; this.macroKey = null;
    if (this.style === 'flat') this.renderer?.render(0);
  }

  // ---------------------------------------------------------------- timeline & pen
  /** Fractional point index of the pen at time t (s). */
  _fi(t) {
    const { geom } = this.state;
    if (this.pace) return this._idx(this.pace.at(t));
    const u = (t - this.t0) / this.D;
    return u <= 0 ? 0 : u >= 1 ? geom.n - 1 : indexAt(geom, drawProgress(u, this.D, 0.5, 0.6), this.pacing);
  }

  /**
   * Fractional point index at progress p: along the pacing table, or (realistic) at that share of
   * the hand time, found in geom.handT.
   */
  _idx(p) {
    const { geom } = this.state;
    if (!this.real) return indexAt(geom, p, this.pacing);
    if (this.lineart) return this._lineAt(clamp(p, 0, 1) * this.real.clock.total).fi;
    const T = this.real.handT, n = geom.n, h = clamp(p, 0, 1) * T[n - 1];
    if (h <= T[0]) return 0;
    if (h >= T[n - 1]) return n - 1;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= h) lo = m; else hi = m; }
    const d = T[hi] - T[lo];
    return lo + (d > 0 ? (h - T[lo]) / d : 0);
  }

  /** Circle units -> px in the flat framing (dev/tools_film.js places its crops with it). */
  _toFrame(x, y) {
    const L = this.state.layout;
    return [this.px + (L.cx + x * L.r) * this.side, this.py + (L.cy + y * L.r) * this.side];
  }

  /** Circle units -> world (sheet widths, sheet centred on the origin). */
  _world(x, y) {
    const L = this.state.layout;
    return [L.cx + x * L.r - 0.5, L.cy + y * L.r - 0.5];
  }

  /** Screen px of the final framing -> world. */
  _fromFrame(sx, sy) {
    return [(sx - this.px) / this.side - 0.5, (sy - this.py) / this.side - 0.5];
  }

  _mode() {
    const { geom } = this.state;
    // spirals grow from the centre (or close in from the rim); every other path (maze, wander,
    // contour) starts where the user pointed and roams, so the camera follows it
    // (a Line art drawing goes feature by feature: the camera follows the pen)
    const spiral = !geom.path || geom.path === 'spiral' || (!!this.real && geom.path === 'real-squiggle');
    return !spiral ? 'follow' : geom.start === 'edge' ? 'edge' : 'center';
  }

  // ---------------------------------------------------------------- signature
  /** Film without the signature after all (it could not be traced here). */
  _dropSignature() {
    this.signature = '';
    this._setStyle(this.style);
    if (this.style === 'cinematic') this._pace();
  }

  /**
   * The signature on the sheet: traced and timed like handwriting (signature.js), right-aligned in
   * the lower-right corner clear of the art, in world units, with the line's width (the medium's own
   * nib, swelling and tapering where strokes start and end), pressure and dwell per time sample.
   */
  _signLayout() {
    let tr = null;
    try { tr = traceSignature(this.signature); } catch (e) { console.warn(e); }
    if (!tr || !tr.strokes.length) return null;
    const s = this.state, L = s.layout;
    const place = placeSignature(tr, { x: L.cx - 0.5, y: L.cy - 0.5, r: L.r, square: s.shape === 'square' });
    if (this.real) {
      // a name keeps its handwritten size on a big sheet (as on A4), but never under ~9 widths of
      // the tool writing it (a stick needs bigger letters); shrunk toward its lower-right corner
      const R = this.real, now = place.em * R.sheetMm;
      const want = Math.max(place.em * REAL_A4, 9 * R.toolMm);
      if (want < now) {
        const right = place.x + tr.width * place.em, bottom = place.y + tr.bottom * place.em;
        place.em *= want / now;
        place.x = right - tr.width * place.em;
        place.y = bottom - tr.bottom * place.em;
      }
    }
    const tm = timeSignature(tr, this.signW);
    const pen = SIGN_PEN[s.brush?.id] || SIGN_PEN.fineliner;
    const brushy = s.brush?.id === 'brush' || s.brush?.id === 'watercolour';
    const emMm = place.em * SHEET_MM, n = tm.n;
    const x = new Float64Array(n), y = new Float64Array(n), w = new Float32Array(n), tone = new Float32Array(n), dwell = new Float32Array(n);
    // the hand's cruising speed on the paper: faster passages press less (a brush thins there)
    const sp = [];
    for (let k = 0; k < n; k++) if (tm.down[k]) sp.push(tm.speed[k]);
    sp.sort((a, b) => a - b);
    const vRef = sp[Math.floor(sp.length * 0.6)] || 1;
    for (let k = 0; k < n; k++) {
      x[k] = place.x + tm.x[k] * place.em;
      y[k] = place.y + tm.y[k] * place.em;
      if (!tm.down[k]) { dwell[k] = 1; continue; }
      const a = tm.along[k] * emMm, b = tm.left[k] * emMm;
      const fIn = pen.w0 + (1 - pen.w0) * smooth(0, pen.in, a);
      const fOut = pen.w1 + (1 - pen.w1) * smooth(0, pen.out, b);
      const q = clamp(tm.speed[k] / vRef, 0.3, 1.8);
      tone[k] = clamp(0.8 - 0.25 * (q - 1), 0.5, 0.95);
      w[k] = pen.mm / SHEET_MM / L.r * fIn * fOut * (brushy ? clamp(1.2 - 0.3 * (q - 1), 0.75, 1.35) : 1);
      // the realistic film signs with the very tool that drew: one fixed width, no swell
      // (Line art: the same nib, brush or pencil, swelling and tapering as the drawing's own line did)
      // (never broader than that kind of tool signs: a 1.5 mm brush writes a name with its tip)
      if (this.lineart) w[k] *= Math.min(this.real.toolMm, pen.mm) / this.real.sheetMm * SHEET_MM / pen.mm;
      else if (this.real) { w[k] = this.real.toolMm / this.real.sheetMm / L.r; tone[k] = 0.8; }
      // the nib rests a moment where a stroke starts (wet media leave a small blot there)
      dwell[k] = 1 + 0.6 * Math.exp(-a / 0.25) + 0.25 * Math.exp(-b / 0.2);
    }
    // in the air, smoothed: the pen rises and settles rather than jumping between heights
    const air = gauss(Float64Array.from(tm.down, d => 1 - d), 0.02 / tm.dt);
    const box = [place.x, place.y + tr.top * place.em, place.x + tr.width * place.em, place.y + tr.bottom * place.em];
    return { n, x, y, w, tone, dwell, down: tm.down, air, box, em: place.em, text: tr.text, font: tr.font };
  }

  /** Pen on the signature at time t (tS0 .. tS1): world tip and how high it is off the paper. */
  _signAt(t) {
    const S = this.sign;
    const f = clamp((t - this.tS0) / Math.max(1e-6, this.tS1 - this.tS0), 0, 1) * (S.n - 1);
    const i = Math.min(S.n - 2, Math.floor(f)), k = f - i;
    return [mix(S.x[i], S.x[i + 1], k), mix(S.y[i], S.y[i + 1], k), mix(S.air[i], S.air[i + 1], k)];
  }

  /**
   * The renderer's geometry for a signed film: the drawing, then the signature's samples as more of
   * the same line. Lifts are zero-width stretches (a zero-width segment draws nothing, and pours no
   * liquid), bridged at both ends by zero-width points so no stroke tapers across a hop. Arc length
   * runs on only where the pen touches, so steady pacing gives the hops no time either.
   */
  _signGeometry(g) {
    const S = this.sign, L = this.state.layout, nD = g.n;
    const n = nD + 2 + S.n;
    const data = new Float32Array(n * STRIDE);
    data.set(g.data.subarray(0, nD * STRIDE));
    const e = (nD - 1) * STRIDE, sEnd = g.data[e + 3], turn = g.data[e + 5];
    const put = (i, x, y, w, s, tone, dwell) => {
      const b = i * STRIDE;
      data[b] = x; data[b + 1] = y; data[b + 2] = w; data[b + 3] = s; data[b + 4] = tone; data[b + 5] = turn; data[b + 6] = dwell;
    };
    const cu = (X, Y) => [(X + 0.5 - L.cx) / L.r, (Y + 0.5 - L.cy) / L.r];     // world -> circle units
    put(nD, g.data[e], g.data[e + 1], 0, sEnd, 0, 1);
    const [x0, y0] = cu(S.x[0], S.y[0]);
    put(nD + 1, x0, y0, 0, sEnd, 0, 1);
    let s = sEnd, px = x0, py = y0;
    for (let k = 0; k < S.n; k++) {
      const [x, y] = cu(S.x[k], S.y[k]);
      if (k && S.down[k] && S.down[k - 1]) s += Math.hypot(x - px, y - py);
      put(nD + 2 + k, x, y, S.w[k], s, S.tone[k], S.dwell[k]);
      px = x; py = y;
    }
    let colors = null;
    if (g.colors) {
      // photo colours: the name in a legible ink for the paper (dark on light, light on dark)
      colors = new Uint8Array(n * 4);
      colors.set(g.colors.subarray(0, nD * 4));
      const c = luminance(hexToRgb(this.state.paper.color)) < 0.45 ? [240, 234, 222] : [30, 28, 27];
      for (let i = nD; i < n; i++) colors.set([c[0], c[1], c[2], 255], i * 4);
    }
    this.signFrom = nD + 2;
    return { ...g, n, data, colors, _pace: new Map() };
  }

  /** The pen tip (world) at any time: on the line, hopping over to the signature, writing it. */
  _tipAt(t) {
    const S = this.sign, { geom } = this.state;
    if (!S || t <= this.t1) { const h = headAt(geom, this._fi(t)); return this._world(h.x, h.y); }
    if (t < this.tS0) {
      const h = headAt(geom, geom.n - 1), [ex, ey] = this._world(h.x, h.y);
      const k = smoother(this.t1, this.tS0, t);
      return [mix(ex, S.x[0], k), mix(ey, S.y[0], k)];
    }
    const [x, y] = this._signAt(t);
    return [x, y];
  }

  /** How high the pen is while it hops to the signature and writes it (0 = touching). */
  _signLift(t, bob) {
    if (t < this.tS0) {
      const k = clamp((t - this.t1) / Math.max(1e-6, this.tS0 - this.t1), 0, 1);
      return mix(bob, 0.03, smooth(0.5, 1, k)) + 0.32 * Math.sin(Math.PI * smoother(0, 1, k));
    }
    return 0.02 + 0.2 * this._signAt(t)[2];
  }

  /** Renderer point index to draw up to at time t (Infinity = everything, dried by settle). */
  _upTo(t) {
    if (t < this.t1) return this._fi(t);
    if (!this.sign) return Infinity;
    if (t < this.tS0) return this.state.geom.n - 1;
    if (t >= this.tS1) return Infinity;
    return this.signFrom + clamp((t - this.tS0) / (this.tS1 - this.tS0), 0, 1) * (this.sign.n - 1);
  }

  /** The cinematic pace: what the shot wants, then the pen timed to it (scene.js). */
  _pace() {
    const { geom, layout: L } = this.state;
    const lib = this.sceneLib;
    const K = PATH_SAMPLES, data = geom.data;
    const x = new Float64Array(K), y = new Float64Array(K), S = new Float64Array(K), turns = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      const fi = this._idx(k / (K - 1));
      const h = headAt(geom, fi);
      [x[k], y[k]] = this._world(h.x, h.y);
      const i = Math.min(geom.n - 1, Math.floor(fi)), j = Math.min(geom.n - 1, i + 1);
      S[k] = mix(data[i * STRIDE + 3], data[j * STRIDE + 3], fi - i) * L.r;
      turns[k] = mix(data[i * STRIDE + 5], data[j * STRIDE + 5], fi - i);
    }
    const [ax, ay] = this._world(0, 0);
    this.art = { x: ax, y: ay, r: L.r };
    this.frame = { W: this.W, H: this.H, side: this.side, cx: this.px + this.side / 2, cy: this.py + this.side / 2 };
    this.safe = SAFE[this.format] || SAFE.square;
    const mode = this._mode();
    // the macro opening needs the renderer's rect view (the nib's surroundings at a finer density),
    // and a first stretch of line with ink worth seeing that close: a spiral from the rim of a pale
    // photo starts with hairlines at the lightest pressure, and a macro of them shows a pen drawing
    // nothing (the shot then opens as it would without the macro)
    const r = this.renderer;
    let macro = this.macro !== false && typeof r?.releaseRect === 'function' && typeof r?.renderToTexture === 'function';
    if (macro) {
      let n = 0, ink = 0;
      for (let k = 0; k < K && S[k] - S[0] < 0.12; k++) {
        const i = Math.min(geom.n - 1, Math.floor(this._idx(k / (K - 1))));
        // on-screen width at the macro (px) weighted by pressure: a firm line or a wide one reads
        // (a wave's pen is the same all along; its tone only moves the wave)
        const press = geom.technique === 'wave' ? 1 : Math.sqrt(clamp(data[i * STRIDE + 4], 0, 1));
        ink += data[i * STRIDE + 2] * L.r * (lib.MACRO?.zoom || 5.5) * this.side * press;
        n++;
      }
      this.macroInk = n ? ink / n : 0;
      macro = this.macroInk >= 1.2;
    }
    let shot;
    if (this.real) {
      // Shot sizes in millimetres of paper across the frame's short side, so a 1 m sheet is filmed
      // the way a camera over it would be: the macro sees ~45 mm around a fine pen (more around a
      // broad stick: its line would fill the frame), the follow shot ~2.6x and ~4x that.
      const R = this.real, spanMm = R.sheetMm * Math.min(this.W, this.H) / this.side;
      const field = clamp(45 * Math.sqrt(R.toolMm / 0.4), 36, 150);
      const z = mm => Math.max(1.1, spanMm / mm);
      const open = this.hand.open;
      if (macro) macro = { zoom: clamp(z(field), 3.5, 14), hold: Math.max(0.6, open - 0.5), ease: clamp(0.3 * this.D, 1.2, 2.6) };
      // Line art plays at 2-8x, not hundreds: the camera can stay closer and drift with the hand
      // from feature to feature (a look at an eye, then the nose) instead of framing the region
      const mid = this.lineart ? 3.3 : 4;
      shot = {
        center: { close: z(field * 2.2), pull: Math.min(z(field * 2.2), z(field * 4.5)), pullAt: open + 0.3 },
        follow: { close: z(field * 2.6), mid: Math.min(z(field * 2.6), z(field * mid)), hold: open, ease: clamp(0.25 * this.D, 1.5, 3) },
      };
    }
    this.intent = lib.shotIntent({ mode, t0: this.t0, t1: this.t1, art: this.art, frame: this.frame, safe: this.safe, path: { x, y }, macro, shot });
    // the realistic pen keeps the hand's clock; the camera follows it (no pace for the shot)
    if (this.real) { this.pace = this.hand; return; }
    // a spiral's pen is held back by how fast it turns (frames per ring); a maze's, wander's or
    // contour's by how fast it crosses the screen
    const spiral = mode !== 'follow';
    this.pace = lib.planPace({ t0: this.t0, t1: this.t1, S, T: spiral ? turns : null, zp: spiral ? Infinity : 1.6,
      zoomAt: this.intent.zoomAt, easeOut: 0.9 });
  }

  /**
   * The pen over the whole film at TRACK_HZ: tip position (world), and the slow signals the
   * tool's body follows — velocity (lean) and pressure (bob). Smoothed without phase lag, so the
   * body anticipates turns rather than trembling on every ring.
   */
  _penTrack() {
    const { geom } = this.state;
    const n = Math.max(2, Math.ceil(this.length * TRACK_HZ) + 1);
    const x = new Float64Array(n), y = new Float64Array(n), tone = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / TRACK_HZ;
      [x[i], y[i]] = this._tipAt(t);
      // (a signature is written with a light, even hand)
      tone[i] = this.sign && t > this.t1 ? 0.6 : headAt(geom, this._fi(t)).tone;
    }
    const vx = new Float64Array(n), vy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      vx[i] = (x[b] - x[a]) * TRACK_HZ / Math.max(1, b - a);
      vy[i] = (y[b] - y[a]) * TRACK_HZ / Math.max(1, b - a);
    }
    return { n, x, y, vx: gauss(vx, 0.22 * TRACK_HZ), vy: gauss(vy, 0.22 * TRACK_HZ), tone: gauss(tone, 0.07 * TRACK_HZ) };
  }

  _track(key, t) {
    const P = this.penTrack, f = clamp(t * TRACK_HZ, 0, P.n - 1), i = Math.min(P.n - 2, Math.floor(f)), k = f - i;
    return P[key][i] + (P[key][i + 1] - P[key][i]) * k;
  }

  /**
   * Tool pose at time t: tip (world), lift, alpha, hand angle (deg), sway phase, and (cinematic)
   * elev: how steeply the body rises from the desk (deg), for depth of field.
   */
  toolPose(t) {
    if (this.style === 'cinematic') return this._poseCinematic(t);
    const { geom } = this.state;
    const a = TOOL_ANGLE * DEG;
    const body = [Math.sin(a), Math.cos(a)];            // from the tip toward the back end
    const across = [-Math.cos(a), Math.sin(a)];
    const LEN = this.toolLen, T = this.tl;
    let x, y, lift, alpha = 1, look = 0;
    const at = fi => { const h = headAt(geom, fi); return this._world(h.x, h.y); };
    // pressure: dark passages press down, pale ones barely touch (the shadow closes in / opens)
    const bob = 0.12 * Math.pow(1 - clamp(this._track('tone', t), 0, 1), 1.5);
    if (t < this.t0) {
      // glides in along a shallow arc and decelerates onto the paper
      const k = clamp(t / this.t0, 0, 1), e = 1 - Math.pow(1 - k, 3);
      [x, y] = at(0);
      const off = (1 - e) * LEN * 1.05;
      x += body[0] * off + across[0] * off * 0.25 * Math.sin(Math.PI * e);
      y += body[1] * off + across[1] * off * 0.25 * Math.sin(Math.PI * e);
      lift = Math.max(bob * e, Math.pow(1 - e, 1.4));
      alpha = smooth(0, 0.35, k);
    } else if (t < this.t1) {
      [x, y] = at(this._fi(t));
      look = this._look(t);
      lift = Math.max(bob, LOOK_LIFT * look);
    } else if (this.sign && t < this.tDone) {
      // hops over to the corner and signs
      [x, y] = this._tipAt(t);
      lift = this._signLift(t, bob);
    } else {
      // lifts straight up first, then leaves toward the lower right, accelerating
      const k = clamp((t - this.tDone) / T.lift, 0, 1), e = k * k;
      [x, y] = this._tipAt(this.tDone);
      x += body[0] * e * LEN * 1.3;
      y += body[1] * e * LEN * 1.3;
      lift = Math.min(1, bob + (1 - bob) * smooth(0, 0.6, k));
      alpha = 1 - smooth(0.55, 1, k);
    }
    // the body leans into the direction of travel (the hand leads, the tip follows)
    const v = this._track('vx', t) * across[0] + this._track('vy', t) * across[1];
    const lean = -7 * Math.tanh(v / 2.2);
    return { x, y, lift, alpha, angle: TOOL_ANGLE + lean + LOOK_WRIST * look, sway: (t * 0.31) % 1, elev: HOLD_ELEV };
  }

  /**
   * The cinematic pen never fades: it sweeps in from outside the opening shot and decelerates onto
   * the start of the line, draws (leaning with its velocity, pressing on dark passages), then is
   * lifted, carried to the desk beside the sheet and laid down there for the rest of the film (or,
   * where the frame has no room for it, carried out of frame).
   */
  /**
   * Realistic films: a real arm, not a plotter carriage. The elbow stays low right, so the pen lies
   * further round to the right when the tip is on the left of the sheet: 12 deg across A4, up to
   * 24 deg on a big sheet, where the whole arm swings. Degrees added to the pen's azimuth.
   */
  _arm(fi) {
    if (!this.real) return 0;
    const u = clamp((headAt(this.state.geom, fi).x + 1) / 2, 0, 1);
    return (12 + 12 * clamp((this.real.sheetMm - 210) / 800, 0, 1)) * (0.5 - u);
  }

  _poseCinematic(t) {
    const { geom } = this.state;
    const T = this.tl;
    const a = TOOL_ANGLE * DEG;
    const across = [-Math.cos(a), Math.sin(a)];
    const at = fi => { const h = headAt(geom, fi); return this._world(h.x, h.y); };
    const bob = 0.12 * Math.pow(1 - clamp(this._track('tone', t), 0, 1), 1.5);
    const v = this._track('vx', t) * across[0] + this._track('vy', t) * across[1];
    const lean = -7 * Math.tanh(v / 2.2);
    let x, y, lift, angle = TOOL_ANGLE + lean, elev = HOLD_ELEV, sway = (t * 0.31) % 1;
    if (t < this.t0) {
      const E = this.entry;
      const k = clamp(t / this.t0, 0, 1), e = 1 - (1 - k) * (1 - k);
      [x, y] = at(0);
      const off = (1 - e) * E.dist;
      // a shallow arc, as a hand swings in from the side
      x += E.dir[0] * off + E.dir[1] * off * 0.18 * Math.sin(Math.PI * e);
      y += E.dir[1] * off - E.dir[0] * off * 0.18 * Math.sin(Math.PI * e);
      lift = Math.max(bob * e, Math.pow(1 - e, 1.3));
      angle += this._arm(0);   // the arm arrives already turned for the first stroke
    } else if (t <= this.t1) {
      const fi = this._fi(t);
      [x, y] = at(fi);
      const look = this._look(t);
      lift = Math.max(bob, LOOK_LIFT * look);
      angle += this._arm(fi) + LOOK_WRIST * look;
    } else if (this.sign && t <= this.tDone) {
      [x, y] = this._tipAt(t);
      lift = this._signLift(t, bob);
      angle += this._arm(geom.n - 1);   // the signing hand keeps the arm where the drawing ended
    } else {
      const k = clamp((t - this.tDone) / T.lift, 0, 1);
      const [ex, ey] = this._tipAt(this.tDone);
      const R = this.rest;
      const leanOff = smooth(0, 0.5, k);
      if (R) {
        const m = smoother(0.1, 0.9, k);
        const dx = R.x - ex, dy = R.y - ey, d = Math.hypot(dx, dy) || 1;
        // carried in a low arc (bowing away from the viewer), turned, and set down
        const bow = 0.12 * d * Math.sin(Math.PI * m);
        x = mix(ex, R.x, m) + dy / d * bow;
        y = mix(ey, R.y, m) - dx / d * bow;
        lift = Math.max(bob * (1 - smooth(0, 0.2, k)), smooth(0, 0.25, k)) * (1 - smooth(0.66, 0.97, k));
        angle = mix(TOOL_ANGLE + lean * (1 - leanOff) + this._arm(geom.n - 1), R.angle, smoother(0.15, 0.85, k));
        elev = mix(HOLD_ELEV, 0, smooth(0.5, 0.97, k));
        // once down it lies still: the hand's micro-wobble stops where it is
        const tDown = this.tDone + T.lift;
        if (t >= tDown) sway = (tDown * 0.31) % 1;
      } else {
        const E = this.exit;
        const e = k * k;
        x = ex + E.dir[0] * e * E.dist;
        y = ey + E.dir[1] * e * E.dist;
        lift = Math.min(1, bob + (1 - bob) * smooth(0, 0.5, k));
        angle = TOOL_ANGLE + lean * (1 - leanOff) + this._arm(geom.n - 1);
      }
    }
    return { x, y, lift, alpha: 1, angle, sway, elev };
  }

  /**
   * The tool with a hint of motion blur: its tip is sampled over the end of the frame's shutter
   * and tools.drawToolMotion averages the sprite along that path, which softens its edges in the
   * direction of travel (flat style; the cinematic style has a full shutter, _drawToolCinematic).
   * view = { toCtx(x, y) -> [cx, cy] (world -> ctx space), size (tool length in ctx units) }.
   */
  _drawTool(g, t, view) {
    if (!this.showTool || !this.tools) return;
    const pose = this.toolPose(t);
    if (pose.alpha <= 0.01) return;
    const s = this.state;
    const opts = { color: s.photoColor ? '#8a5a44' : s.ink, lift: pose.lift, alpha: pose.alpha, angle: pose.angle, sway: pose.sway };
    try {
      const K = 4, shutter = this._shutter(t, 0.2 / this.fps);
      const pts = [];
      for (let k = 0; k < K; k++) {
        const p = k === K - 1 ? pose : this.toolPose(t - shutter * (1 - k / (K - 1)));
        const [x, y] = view.toCtx(p.x, p.y);
        pts.push({ x, y, lift: p.lift, sway: p.sway });
      }
      if (this.tools.drawToolMotion) this.tools.drawToolMotion(g, s.brush.tool, pts, view.size, { ...opts, maxBlur: view.size * 0.022 });
      else this.tools.drawTool(g, s.brush.tool, pts[K - 1].x, pts[K - 1].y, view.size, opts);
    } catch (e) { console.warn(e); }
  }

  _reveal(t) {
    if (!this.reveal || !this.drawPhoto) return 0;
    const r = t - this.tReveal;
    return r < 0 ? 0 : r < 0.6 ? easeInOut(r / 0.6) : r < 1.8 ? 1 : easeInOut(1 - (r - 1.8) / 0.6);
  }

  /** Cinematic reveal: [photo spread, drawing returned], both 0..1 along the drawing order. */
  _wipe(t) {
    if (!this.reveal || !this.drawPhoto) return [0, 0];
    const r = t - this.tReveal;
    return [easeInOut(r / WIPE_IN), easeInOut((r - WIPE_IN - WIPE_HOLD) / WIPE_OUT)];
  }

  draw(i, g) {
    const t0 = performance.now();
    if (this.style === 'cinematic') this._drawCinematic(i, g);
    else this._drawFlat(i, g);
    this.stats.frames++; this.stats.ms += performance.now() - t0;
  }

  /** Switch the desk (the dialog's live preview): only the scene and, when flat, the desk change. */
  setDesk(id) {
    id = deskById(id).id;
    if (id === this.desk) return;
    this.desk = id;
    if (!this.scene) return;
    this.scene.setDesk(id);
    if (this.style === 'flat') this.bg = this._background(this.bg);
  }

  // ---------------------------------------------------------------- flat
  /** The flat film's desk comes from the cinematic scene when this browser can render it. */
  _flatScene() {
    const lib = this.sceneLib, r = this.renderer;
    if (!lib?.FilmScene || typeof r.renderToTexture !== 'function') return;
    try {
      const dark = luminance(hexToRgb(this.state.paper.color)) < 0.45;
      this.scene = new lib.FilmScene(r.gl, { dark, seed: this.state.seed, desk: this.desk, wait: !this.live });
    } catch (e) { console.warn(e); this.scene = null; }
  }

  /**
   * The chosen desk seen from straight above under the scene's window light, with the sheet (blank)
   * and its shadow exactly where the flat film draws the sheet. Leaf shadows are left out: they
   * could not fall across the sheet drawn on top. Renders through the shared canvas, then gives it
   * back at the sheet's size.
   */
  _deskShot(g) {
    const { W, H, side } = this, r = this.renderer, lib = this.sceneLib;
    const sheet = r.renderToTexture(0, { settle: 0 });
    if (!sheet) return false;
    const tx = (W / 2 - (this.px + side / 2)) / side, ty = (H / 2 - (this.py + side / 2)) / side;
    const basis = lib.cameraBasis({ tx, ty, zoom: 1, pitch: 0, yaw: 0, roll: 0 }, W, H, side);
    this.canvas.width = W; this.canvas.height = H;
    this.scene.render({ sheet, basis, focus: [tx, ty], light: 0, time: 0, sun: false });
    g.drawImage(this.canvas, 0, 0, W, H);
    this.canvas.width = side; this.canvas.height = side;
    this.bgStage = this.scene.deskStage;
    return true;
  }

  /** Desk + sheet shadow + taped photo, painted once (again when a desk still baking arrives). */
  _background(c = null) {
    const { W, H, side, px, py, state } = this;
    if (!c) c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const dark = luminance(hexToRgb(state.paper.color)) < 0.2;
    if (this.scene && this.live && !this.ready()) {
      // a preview whose scene program is still compiling: the plain desk for now, the chosen one
      // as soon as the scene can draw (_drawFlat)
      this.bgStage = 'pending';
    } else if (this.scene) {
      let ok = false;
      try { ok = this._deskShot(g); } catch (e) { console.warn(e); }
      if (ok) {
        if (this.polaroid && this.drawPhoto && this.format !== 'square') this._polaroid(g, dark);
        return c;
      }
      this.scene = null;
    }
    // the desk follows the paper, not the UI theme
    const base = dark ? ['#262422', '#141312'] : ['#e4ded4', '#cfc7ba'];
    const grd = g.createRadialGradient(W * 0.45, H * 0.4, 0, W * 0.5, H * 0.5, Math.hypot(W, H) * 0.62);
    grd.addColorStop(0, base[0]); grd.addColorStop(1, base[1]);
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    // fine desk grain
    const n = document.createElement('canvas'); n.width = n.height = 256;
    const ng = n.getContext('2d'); const im = ng.createImageData(256, 256);
    let seed = 1234567;
    for (let i = 0; i < im.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const v = (seed >> 16) & 255;
      im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = dark ? 10 : 14;
    }
    ng.putImageData(im, 0, 0);
    g.fillStyle = g.createPattern(n, 'repeat'); g.fillRect(0, 0, W, H);
    // sheet contact + ambient shadow
    g.save();
    g.fillStyle = state.paper.color;
    g.shadowColor = dark ? 'rgba(0,0,0,.7)' : 'rgba(40,30,20,.32)';
    g.shadowBlur = side * 0.05; g.shadowOffsetY = side * 0.018;
    g.fillRect(px, py, side, side);
    g.shadowColor = 'rgba(0,0,0,.25)'; g.shadowBlur = side * 0.004; g.shadowOffsetY = side * 0.002;
    g.fillRect(px, py, side, side);
    g.restore();
    if (this.polaroid && this.drawPhoto && this.format !== 'square') this._polaroid(g, dark);
    return c;
  }

  /** Where the taped photo lies in the final framing: photo size (px), centre, rotation (deg). */
  _polaroidPlace() {
    const { W, H, side, px, py, format } = this;
    let size, x, y, rot;
    if (format === 'story') { size = W * 0.3; x = W * 0.2; y = py + side + H * 0.035; rot = -6; }
    else if (format === 'portrait') { size = W * 0.2; x = W * 0.03; y = H * 0.73; rot = -8; }
    else { size = H * 0.34; x = px + side + (W - px - side - H * 0.34) / 2; y = H * 0.26; rot = 5; }
    // the cinematic story keeps it smaller and lower, toward the near edge of the desk: in the
    // tilted shots it is then mostly out of frame or soft, instead of competing with the drawing
    if (this.style === 'cinematic' && format === 'story') { size = W * 0.26; x = W * 0.14; y = py + side + H * 0.075; }
    // a realistic film's big sheet: the print keeps its real size (it lies where it would, its
    // corner as near the sheet as before)
    if (this.realScale < 1) { const s2 = size * clamp(this.realScale * 1.15, 0.2, 1); x += (size - s2) * 0.5; y += (size - s2) * 0.15; size = s2; }
    return { size, cx: x + size / 2, cy: y + size / 2, rot };
  }

  /** The polaroid itself around (0, 0) in the current transform: frame, photo, tape. */
  _paintPolaroid(g, size) {
    const pad = size * 0.06, bottom = size * 0.2;
    g.fillStyle = '#fbfaf6';
    g.fillRect(-size / 2 - pad, -size / 2 - pad, size + 2 * pad, size + pad + bottom);
    g.shadowColor = 'transparent';
    g.save();
    g.beginPath(); g.rect(-size / 2, -size / 2, size, size); g.clip();
    g.fillStyle = '#ddd'; g.fillRect(-size / 2, -size / 2, size, size);
    this.drawPhoto(g, 0, 0, size / 2);
    g.restore();
    this._paintTape(g, size);
  }

  /**
   * The back of the photo, for a cinematic film with the reveal on: it lies face down until the
   * reveal, so the reveal is not given away in every shot. A print's back: warm white card with
   * the paper maker's faint printing.
   */
  _paintPolaroidBack(g, size) {
    const pad = size * 0.06, bottom = size * 0.2;
    const x0 = -size / 2 - pad, y0 = -size / 2 - pad, w = size + 2 * pad, h = size + pad + bottom;
    const gr = g.createLinearGradient(x0, y0, x0 + w, y0 + h);
    gr.addColorStop(0, '#f1ede4'); gr.addColorStop(1, '#e4ded2');
    g.fillStyle = gr;
    g.fillRect(x0, y0, w, h);
    g.save();
    g.beginPath(); g.rect(x0, y0, w, h); g.clip();
    g.translate(x0 + w / 2, y0 + h / 2);
    g.rotate(-30 * Math.PI / 180);
    g.fillStyle = 'rgba(120,110,95,.09)';
    for (let k = -6; k <= 6; k++) g.fillRect(-w, k * h * 0.16, w * 2, h * 0.012);
    g.restore();
    this._paintTape(g, size);
  }

  _paintTape(g, size) {
    const pad = size * 0.06;
    g.rotate(-3 * Math.PI / 180);
    g.fillStyle = 'rgba(236,226,196,.78)';
    g.fillRect(-size * 0.2, -size / 2 - pad - size * 0.07, size * 0.4, size * 0.13);
  }

  _polaroid(g, dark) {
    const { size, cx, cy, rot } = this._polaroidPlace();
    g.save();
    g.translate(cx, cy);
    g.rotate(rot * Math.PI / 180);
    g.shadowColor = dark ? 'rgba(0,0,0,.6)' : 'rgba(40,30,20,.3)';
    g.shadowBlur = size * 0.06; g.shadowOffsetY = size * 0.02;
    this._paintPolaroid(g, size);
    g.restore();
  }

  _drawFlat(i, g) {
    const { W, H, side, px, py, state } = this;
    const t = i / this.fps;
    // a desk that was still baking when the film was prepared (a live preview): repaint it
    if (this.scene && this.bgStage !== 'full' && this.scene.deskStage !== this.bgStage && this.ready()) this.bg = this._background(this.bg);
    const { settle } = this._hooks(t);
    this.renderer.render(this._upTo(t), { settle });
    g.drawImage(this.bg, 0, 0, W, H);
    g.drawImage(this.canvas, px, py, side, side);

    // reveal: the photo fades in inside the circle, then back out
    const a = this._reveal(t);
    if (a > 0) {
      const L = state.layout;
      const cx = px + L.cx * side, cy = py + L.cy * side, R = L.r * side;
      g.save();
      g.globalAlpha = a;
      g.beginPath();
      if (state.shape === 'square') g.rect(cx - R, cy - R, 2 * R, 2 * R); else g.arc(cx, cy, R, 0, Math.PI * 2);
      g.clip();
      this.drawPhoto(g, cx, cy, R);
      g.restore();
    }
    this._drawTool(g, t, { toCtx: (x, y) => [px + (x + 0.5) * side, py + (y + 0.5) * side], size: side * this.toolLen });
    if (this.counter) this._drawCounter(g, t);
  }

  // ---------------------------------------------------------------- cinematic
  _prepareCinematic() {
    const { W, H, side, state: s, sceneLib: lib } = this;
    const T = this.tl;
    const mode = this.intent.mode;
    // the shot arrives on the straight full sheet while the pen is laid down, then creeps in to
    // the end; a spiral from the rim ends on the eyes, so it pulls back only as the pen lifts
    // (a signed film: after the signing, which has a shot of its own)
    const tTake = mode === 'edge' ? this.t1 - 0.25 : this.t1 - Math.min(1.4, 0.3 * this.D);
    const tSettle = mode === 'edge' ? this.tDone + 1.1 : this.tDone + 0.15;
    const tFinal = mode === 'edge' ? this.tDone + 1.5 : this.tDone + T.lift + 0.3;
    // the signing shot: the camera leans in over the corner while the name is written (the rim
    // spiral finishes on the eyes first, so it leaves them only as the pen lifts)
    const sign = this.sign ? { t0: this.tS0, t1: this.tS1, tIn: mode === 'edge' ? this.t1 - 0.05 : this.t1 - 0.5,
      tOut: tFinal - 0.05, box: this.sign.box } : null;
    this.plan = lib.planCamera({
      length: this.length, t0: this.t0, t1: this.t1, tTake, tSettle, tFinal,
      head: t => [this._track('x', t), this._track('y', t)],
      progress: t => this.pace.at(t),
      intent: this.intent, art: this.art, frame: this.frame, safe: this.safe, sign,
    });
    this.restAt = tFinal;
    this._placePen();
    // Sheet resolution: about one texel per output pixel at the closest point of the shot, so the
    // close-up is crisp without rendering texels nobody sees.
    // (the macro opening is rendered apart, at its own density: see _macroSetup)
    const r = this.renderer;
    const want = (this.plan.maxZoomBase ?? this.plan.maxZoom) * side * 1.08;
    const sheetPx = clamp(Math.ceil(want / 64) * 64, 512, Math.min(3072, r.maxSize || 3072));
    r.setSize(sheetPx, sheetPx);
    // renderToTexture never draws to the canvas: it becomes the film frame
    this.canvas.width = W; this.canvas.height = H;
    this.sheetPx = sheetPx;
    this._macroSetup();
    // dark and mid papers (black card, chalkboard, blueprint, kraft) bloom more and shade deeper
    const dark = luminance(hexToRgb(s.paper.color)) < 0.45;
    this.scene = new lib.FilmScene(r.gl, { dark, seed: s.seed, glow: !!s.brush?.glow, desk: this.desk, wait: !this.live });
    if (this.polaroid && this.drawPhoto && this.format !== 'square') {
      const pl = this._polaroidPlace();
      const k = Math.min(1024, Math.max(128, Math.round(pl.size * 1.6)));
      // canvas covers the frame (-0.56..0.56 x -0.56..0.7 of the photo size) plus the tape
      const x0 = -0.6, x1 = 0.6, y0 = -0.66, y1 = 0.74;
      const c = document.createElement('canvas');
      c.width = Math.round(k * (x1 - x0)); c.height = Math.round(k * (y1 - y0));
      const g = c.getContext('2d');
      g.translate(-x0 * k, -y0 * k);
      if (this.reveal) this._paintPolaroidBack(g, k); else this._paintPolaroid(g, k);
      const rot = pl.rot * DEG, sw = pl.size / side;
      const ocx = 0, ocy = (y0 + y1) / 2 * sw;     // canvas centre relative to the photo centre
      const [wx, wy] = this._fromFrame(pl.cx, pl.cy);
      this.scene.setPolaroid(c, {
        x: wx + (ocx * Math.cos(rot) - ocy * Math.sin(rot)),
        y: wy + (ocx * Math.sin(rot) + ocy * Math.cos(rot)),
        hw: (x1 - x0) / 2 * sw, hh: (y1 - y0) / 2 * sw, rot,
      });
      c.width = c.height = 0;
    }
    const art = { ...this.art, square: s.shape === 'square' };
    if (this.reveal && this.drawPhoto) {
      const S = clamp(Math.round(2 * s.layout.r * sheetPx), 256, 2048);
      const c = document.createElement('canvas');
      c.width = c.height = S;
      const g = c.getContext('2d');
      g.beginPath();
      if (art.square) g.rect(0, 0, S, S); else g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
      g.clip();
      this.drawPhoto(g, S / 2, S / 2, S / 2);
      const order = this._orderMap();
      this.scene.setPhoto(c, art, order);
      c.width = c.height = 0;
      order.width = order.height = 0;
    } else this.scene.setPhoto(null, art);
    this.sheetKey = null;
    // the tool's layers: the streak, the sprite (and scratch), the depth-of-field accumulator and a
    // half-resolution layer for the blurred bands
    this.layers = this.showTool && this.tools
      ? [makeLayer(W, H), makeLayer(W, H), makeLayer(W, H), makeLayer(Math.ceil(W / 2), Math.ceil(H / 2))] : null;
    if (this.layers && this.layers.some(L => !L)) this.layers = null;
    this.dof = !!this.layers && canvasBlurWorks();
  }

  /**
   * Where the pen comes from and where it goes. It enters along its own body (from the lower
   * right, where the hand is): on the first frame its nib is already a little inside the opening
   * shot (so the film's first frame, the one feeds and thumbnails show, is never empty paper) and
   * the rest of it beyond the edge. At the end it lies on the desk where the final framing has
   * room for it: below the sheet in a story or a portrait, beside it in a wide film, and on the
   * sheet's bottom margin, clear of the art, in a square one (below the sheet when the margin
   * carries a signature).
   */
  _placePen() {
    const lib = this.sceneLib, { W, H, side } = this;
    const { geom } = this.state;
    const a = TOOL_ANGLE * DEG, dir = [Math.sin(a), Math.cos(a)];
    const at = fi => { const h = headAt(geom, fi); return this._world(h.x, h.y); };
    const outBy = (b, x, y) => { const q = lib.project(b, x, y); return Math.max(-q[0], q[0] - W, -q[1], q[1] - H); };
    // distance along dir from (x, y) until the tip is `need` px outside the frame of camera b
    const leave = (b, x, y, need) => {
      let d = 0;
      while (d < 4 && outBy(b, x + dir[0] * d, y + dir[1] * d) < need) d += 0.005;
      return d;
    };
    const b0 = lib.cameraBasis(this.plan.at(0), W, H, side);
    const [sx, sy] = at(0);
    const scale0 = Math.hypot(...lib.planeTransform(b0, sx, sy).slice(0, 2));
    // measured on screen, so a macro opening (where a tool length spans twice the frame) still
    // shows the nib well inside the first frame and brings it down over a short, visible glide
    const k = Math.min(W, H);
    this.entry = { dir, dist: Math.max(0.12 * k / scale0, leave(b0, sx, sy, -Math.min(0.3 * this.toolLen * scale0, 0.22 * k))) };
    // the final framing (straight, zoom 1): screen px -> world is a plain scale
    const T = this.tl, L = this.toolLen * side;
    const yb = this.py + side;          // bottom of the sheet in the final framing
    let tip = null, ang = 0;
    if (this.format === 'story') { tip = [W * 0.55, yb + (H - yb) * 0.32]; ang = 101; }
    else if (this.format === 'portrait') { tip = [W * 0.5, yb + (H - yb) * 0.5]; ang = 98; }
    else if (this.format === 'wide') { tip = [this.px + side + (W - this.px - side) * 0.1, H * 0.8]; ang = 100; }
    else if (this.sign) {
      // the desk below the sheet: the margin holds the signature
      tip = [W / 2 - L * 0.5, yb + (H - yb) * 0.5]; ang = 92;
    } else {
      // the sheet's bottom margin, below the art
      const artBottom = this.py + (this.state.layout.cy + this.state.layout.r) * side;
      tip = [W / 2 - L * 0.42, (artBottom + yb) / 2 + side * 0.004]; ang = 93;
    }
    // a realistic big sheet's small tool is put down where a hand would: just off the sheet's lower
    // edge, under the right half of the drawing (not far out on the desk, where it would be lost)
    if (this.realScale < 0.75 && this.format !== 'wide') { tip = [this.px + side * 0.62, yb + Math.max(L * 0.35, side * 0.035)]; ang = 99; }
    // the end card ("2 min 02 s of drawing in 30 s") has the lower right corner: a tool laid down
    // across it slides left until its back end clears the card
    const card = this.counter ? this._cardBox() : null;
    if (card) {
      const bx = tip[0] + Math.sin(ang * DEG) * L, pad = 0.03 * L;
      const top = Math.min(tip[1], tip[1] + Math.cos(ang * DEG) * L) - pad, bottom = Math.max(tip[1], tip[1] + Math.cos(ang * DEG) * L) + pad;
      if (bottom > card.y0 && top < card.y1 && bx > card.x0 - pad) tip[0] = Math.max(side * 0.03, tip[0] - (bx - card.x0 + 2.5 * pad));
    }
    const back = [tip[0] + Math.sin(ang * DEG) * L, tip[1] + Math.cos(ang * DEG) * L];
    const fits = back[0] < W - side * 0.02 && back[1] > 0 && tip[1] < H - side * 0.03;
    if (fits) {
      const [rx, ry] = this._fromFrame(tip[0], tip[1]);
      this.rest = { x: rx, y: ry, angle: ang };
      this.exit = null;
    } else {
      // no room: carried out of the final frame, one tool length beyond its edge
      const bF = lib.cameraBasis(this.plan.at(this.tDone + T.lift), W, H, side);
      const [ex, ey] = this._tipAt(this.tDone);
      this.rest = null;
      this.exit = { dir, dist: leave(bF, ex, ey, L * 1.1) };
    }
  }

  /**
   * The drawing order over the art square, for the reveal wipe: each cell holds when the pen first
   * reached it, gaps between the lines are filled from their neighbours, and the values are
   * equalised by area, so the wipe uncovers the art at an even rate whatever the path (a disc
   * growing from a spiral's centre, a flood through a maze from its start).
   */
  _orderMap() {
    const { geom } = this.state;
    const G = 192, n = geom.n, data = geom.data;
    const first = new Float32Array(G * G).fill(-1);
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      const gx = Math.floor((data[o] + 1) * 0.5 * G), gy = Math.floor((data[o + 1] + 1) * 0.5 * G);
      if (gx < 0 || gy < 0 || gx >= G || gy >= G) continue;
      const c = gy * G + gx;
      if (first[c] < 0) first[c] = i / Math.max(1, n - 1);
    }
    // fill the gaps between neighbouring lines (and a margin around the art) from filled cells
    for (let pass = 0; pass < 12; pass++) {
      const src = first.slice();
      let empty = 0;
      for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
        const c = y * G + x;
        if (src[c] >= 0) continue;
        let m = Infinity;
        if (x > 0 && src[c - 1] >= 0) m = Math.min(m, src[c - 1]);
        if (x < G - 1 && src[c + 1] >= 0) m = Math.min(m, src[c + 1]);
        if (y > 0 && src[c - G] >= 0) m = Math.min(m, src[c - G]);
        if (y < G - 1 && src[c + G] >= 0) m = Math.min(m, src[c + G]);
        if (m < Infinity) first[c] = m; else empty++;
      }
      if (!empty) break;
    }
    // equalise: rank of each cell among the filled ones
    const idx = [];
    for (let c = 0; c < G * G; c++) if (first[c] >= 0) idx.push(c);
    idx.sort((p, q) => first[p] - first[q]);
    const eq = new Float32Array(G * G).fill(1);
    for (let k = 0; k < idx.length; k++) eq[idx[k]] = k / Math.max(1, idx.length - 1);
    // two box blurs: a soft, organic wipe front instead of the grid's steps
    let a = eq, b = new Float32Array(G * G);
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
        let s = 0, w = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= G || yy >= G) continue;
          s += a[yy * G + xx]; w++;
        }
        b[y * G + x] = s / w;
      }
      [a, b] = [b, a];
    }
    const c = document.createElement('canvas');
    c.width = c.height = G;
    const g = c.getContext('2d');
    const im = g.createImageData(G, G);
    for (let k = 0; k < G * G; k++) {
      const v = Math.round(clamp(a[k], 0, 1) * 255);
      im.data[k * 4] = im.data[k * 4 + 1] = im.data[k * 4 + 2] = v; im.data[k * 4 + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    return c;
  }

  // Optional renderer features (feature-detected): a moving light for gold / wet-ink glints,
  // time for neon flicker, and ink that settles (dries) once the pen has passed: settle is 0 while
  // drawing and rises to 1 over the hold, so wet ink dries on camera.
  // view: direction toward the camera (cinematic), so glints follow the moving camera.
  _hooks(t, view = null, eye = null) {
    const r = this.renderer, T = this.tl;
    const settle = smooth(this.tDone, this.tDone + T.lift + T.hold - (this.signW ? T.signHoldCut : 0), t);
    // (the realistic film's light is the one the user chose, and it stays where it is)
    const sweep = this.real ? 0 : smooth(this.tDone + T.lift, this.length, t);
    // the light rises as the pen is put down, so the ink is still wet when a glint can first show
    // on the straight-down final framing, and the gloss is seen to go as it dries (settle)
    const rise = view && !this.real ? smooth(this.tDone, this.tDone + T.lift + 0.8, t) : 0;
    // the macro's glint light, and a lighter touch of it while the fresh signature is filmed
    let glint = null;
    if (view) {
      const w = Math.max(this.plan?.macroW ? this.plan.macroW(t) : 0,
        this.sign ? 0.8 * smoother(this.tS0 - 0.3, this.tS0 + 0.1, t) * (1 - smoother(this.tS1, this.tS1 + 0.8, t)) : 0);
      if (w > 0) glint = [[-view[0], -view[1], view[2]], w];
    }
    let key = settle.toFixed(3);
    if (typeof r.setTime === 'function') { r.setTime(t); key += `|${t}`; }
    if (typeof r.setLight === 'function') {
      const L = lightAt(sweep, rise, glint, this.real ? this.baseLight : null);
      if (view) L.view = view;
      if (eye) L.eye = eye;
      r.setLight(L);
      key += `|${sweep.toFixed(4)}|${rise.toFixed(4)}|${glint ? glint[1].toFixed(4) : 0}|${view ? view.map(v => v.toFixed(4)).join(',') : ''}|${eye ? eye.map(v => v.toFixed(4)).join(',') : ''}`;
    }
    return { settle, sweep, key };
  }

  _sheet(t, view, eye) {
    const upTo = this._upTo(t), r = this.renderer;
    const { settle, sweep, key } = this._hooks(t, view, eye);
    // a finished, unchanging sheet is not rendered again (most of the hold, without the hooks)
    const k = `${upTo}|${key}`;
    if (k !== this.sheetKey || !this.sheet) {
      this.sheet = r.renderToTexture(upTo, { settle });
      this.sheetKey = k;
    }
    // the macro opening: the part of the sheet in view, rendered at the macro's own density
    let macro = null;
    const mw = this.macroCfg ? this._macroNeed(t) : 0;
    if (mw > 0) {
      const rect = this._macroRect(t);
      const mk = `${k}|${rect.join(',')}`;
      if (mk !== this.macroKey || !this.macroTex) {
        this.macroTex = r.renderToTexture(upTo, { settle, rect, size: this.macroCfg.S });
        this.macroKey = mk;
      }
      if (this.macroTex) macro = { tex: this.macroTex.tex, rect: this.macroTex.rect, w: mw };
    } else if (this.macroTex) this._macroRelease();
    return { sheet: this.sheet, sweep, macro };
  }

  // ---------------------------------------------------------------- macro opening
  /**
   * The macro's rendering: a fixed density (texels per sheet width: one texel per output pixel at
   * the nearest point of the closest shot, so the tooth and the ink's edge are sharp) and a fixed
   * square rect that follows what the camera sees. Density and size never change during the shot,
   * so the grain never shimmers and the rect's targets are made once.
   */
  _macroSetup() {
    this.macroCfg = null;
    this.macroRectPrev = null;
    const M = this.intent?.macro;
    if (!M) return;
    const r = this.renderer;
    // (a realistic big sheet's macro sees a few cm of a metre-wide sheet: it needs the finer density)
    const D = Math.min(this.real ? 12288 : 8192, Math.ceil(M.zoom * this.side * 1.25 / 64) * 64);
    let ext = 0;
    for (let t = 0; t <= this.plan.tMacroEnd + 0.1; t += 1 / 30) {
      if (this._macroNeed(t, true) <= 0) continue;
      const bb = this._visible(t);
      if (bb) ext = Math.max(ext, bb[2] - bb[0], bb[3] - bb[1]);
    }
    if (!(ext > 0)) return;
    const S = clamp(Math.ceil(ext * D / 64) * 64, 256, Math.min(2048, (r.maxSize || 4096) / 2));
    this.macroCfg = { D, S, span: S / D };
  }

  /**
   * How much the macro rendering is needed at time t (0..1): where the shot is closer than the
   * sheet texture's resolution can serve (it fades out as the pull-back reaches the plan's own
   * close-ups, which the sheet texture is sized for).
   */
  _macroNeed(t, setup = false) {
    if (!this.plan || t > this.plan.tMacroEnd + 0.1 || (!setup && !this.macroCfg)) return 0;
    const cam = this.plan.at(t);
    const need = cam.zoom * this.side * (1 + 0.45 * Math.sin(cam.pitch)) * 1.08;
    return smooth(1.0, 1.25, need / this.sheetPx);
  }

  /** The part of the sheet in view at time t: world bbox [x0, y0, x1, y1] (clipped to the sheet). */
  _visible(t) {
    const lib = this.sceneLib, { W, H, side } = this;
    const b = lib.cameraBasis(this.plan.at(t), W, H, side);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [sx, sy] of [[0, 0], [W / 2, 0], [W, 0], [W, H / 2], [W, H], [W / 2, H], [0, H], [0, H / 2]]) {
      const p = lib.unproject(b, sx, sy);
      if (!p) return [-0.5, -0.5, 0.5, 0.5];
      x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
    }
    x0 = Math.max(-0.5, x0); y0 = Math.max(-0.5, y0); x1 = Math.min(0.5, x1); y1 = Math.min(0.5, y1);
    return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
  }

  /**
   * The macro rect at time t (sheet fractions): the fixed-size square over what is in view, on the
   * point in focus where the view is larger than it. Kept where it is while it still covers what
   * it must (a rect that moves is redrawn from scratch).
   */
  _macroRect(t) {
    const cfg = this.macroCfg, sw = cfg.span, cam = this.plan.at(t);
    const bb = this._visible(t) || [-0.5, -0.5, 0.5, 0.5];
    // what must be covered: the view, or the rect-sized window of it around the point in focus
    const need = [0, 1].map(a => {
      const lo = bb[a], hi = bb[a + 2], f = a ? cam.fy : cam.fx;
      if (hi - lo <= sw) return [lo, hi];
      const c = clamp(f, lo + sw / 2, hi - sw / 2);
      return [c - sw / 2, c + sw / 2];
    });
    const P = this.macroRectPrev;
    const inside = P && [0, 1].every(a => P[a] - 0.5 <= need[a][0] + 1e-9 && P[a + 2] - 0.5 >= need[a][1] - 1e-9);
    if (inside) return P;
    // centred on what is needed, snapped to a coarse grid so it moves in few, whole steps, and kept
    // on the sheet (the renderer clips a rect to the sheet, which would change its density)
    const g = 64 / cfg.D;
    const rect = [0, 1].map(a => clamp(Math.round((0.5 * (need[a][0] + need[a][1]) - sw / 2 + 0.5) / g) * g, 0, Math.max(0, 1 - sw)));
    const out = [rect[0], rect[1], rect[0] + sw, rect[1] + sw];
    this.macroRectPrev = out;
    return out;
  }

  _macroRelease() {
    try { this.renderer?.releaseRect?.(); } catch { /* context gone */ }
    this.macroTex = null; this.macroKey = null; this.macroRectPrev = null;
  }

  _drawCinematic(i, g) {
    const { W, H, side, sceneLib: lib } = this;
    const t = i / this.fps;
    const cam = this.plan.at(t);
    const basis = lib.cameraBasis(cam, W, H, side);
    // the lens's real aperture on a realistic film's big sheet (scene.lens reads it)
    if (this.real) basis.ap = clamp(this.realScale, 0.2, 1);
    // toward the camera from the point in focus (paper axes: x right, y down, z up), and the camera
    // itself in sheet widths from the sheet's top-left corner: every pixel then sees the lens from
    // its own angle, so a wet line or a gold flake glints locally and the glint travels as it moves
    const v = [basis.C[0] - cam.fx, basis.C[1] - cam.fy, basis.C[2]], vn = Math.hypot(...v);
    const eye = [basis.C[0] + 0.5, basis.C[1] + 0.5, basis.C[2]];
    const { sheet, sweep, macro } = this._sheet(t, v.map(c => c / vn), eye);
    if (!sheet) throw Object.assign(new Error('The graphics context was lost'), { code: 'encode' });
    this.scene.render({ sheet, basis, focus: [cam.fx, cam.fy], wipe: this._wipe(t), light: sweep, time: t, macro, scale: this.realScale });
    g.drawImage(this.canvas, 0, 0, W, H);
    if (this.showTool && this.tools) {
      try { this._drawToolCinematic(g, t, basis, [cam.fx, cam.fy]); } catch (e) { console.warn(e); }
    }
    if (this.counter) this._drawCounter(g, t);
  }

  /**
   * The realistic film's clock, set small in a bottom corner like a timecode burnt in by the
   * camera: the hand time drawn so far and the speed-up ("1 h 04 min · 240×"), digits in fixed
   * cells so nothing jitters as they count. When the pen lifts it gives way to the end card line,
   * "3 h 12 min of drawing in 30 s", in the same corner.
   */
  /** The end card's line: '3 h 12 min of drawing in 30 s' (Line art to the second: '2 min 02 s …'). */
  _cardText() {
    const total = (this.lineart ? this.real.handT[this.real.handT.length - 1] : this.hand.total) + (this.sign ? this.signW : 0);
    return `${formatHand(total, this.lineart ? 'total' : false)} of drawing in ${Math.round(this.length)} s`;
  }

  /** Where the end card's plate lies in the frame (px), as _drawCounter draws it. */
  _cardBox() {
    if (!this.hand) return null;
    const { W, H } = this, k = Math.min(W, H), m = Math.round(0.045 * k);
    const x1 = W - m, y1 = this.format === 'story' ? Math.round(H * 0.855) : H - m;
    const px = Math.round(0.034 * k);
    let tw = this._cardText().length * px * 0.42;
    try {
      const g = makeLayer(4, 4).g;
      g.font = `italic 400 ${px}px "Instrument Serif", Georgia, serif`;
      tw = g.measureText(this._cardText()).width;
    } catch { /* the estimate */ }
    const padX = px * 0.6, padY = px * 0.34;
    return { x0: x1 - tw - padX, x1: x1 + padX, y0: y1 - px * 0.78 - padY, y1: y1 + px * 0.24 + padY };
  }

  _drawCounter(g, t) {
    const { W, H } = this, H0 = this.hand;
    if (!H0) return;
    const k = Math.min(W, H), m = Math.round(0.045 * k);
    // (a story: below where the pen is laid down, above the apps' reply bar)
    const x1 = W - m, y1 = this.format === 'story' ? Math.round(H * 0.855) : H - m;
    const signing = this.sign && t > this.t1 ? clamp(t - this.tS0, 0, this.signW) : 0;
    // (Line art: the film clock stretches the looks; the counter reads the hand's own seconds)
    const handNow = this.lineart ? (t >= this.t1 ? this.real.handT[this.real.handT.length - 1] : this._lineAt(H0.hand(t)).hand) : H0.hand(t);
    const hand = handNow + signing;
    const drawing = t >= this.t0 && t < this.tDone;
    const speed = t < this.t1 ? H0.speed(t) : 1;
    const endAt = this.tDone + 0.35;
    const e = smooth(endAt, endAt + 0.5, t);
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.textBaseline = 'alphabetic';
    g.shadowColor = 'rgba(0,0,0,.45)';
    g.shadowBlur = k * 0.012;
    g.shadowOffsetY = k * 0.0015;
    const cells = (text, x, y, px, color) => {
      // right-aligned, each digit in a cell as wide as the widest digit (tabular figures)
      const dw = g.measureText('0').width;
      let w = 0;
      for (const ch of text) w += /\d/.test(ch) ? dw : g.measureText(ch).width;
      let cx = x - w;
      g.fillStyle = color;
      for (const ch of text) {
        const cw = /\d/.test(ch) ? dw : g.measureText(ch).width;
        g.fillText(ch, cx + (cw - g.measureText(ch).width) / 2, y);
        cx += cw;
      }
      return w;
    };
    // a soft scrim behind the type, as a colourist would pull down a corner: legible over white
    // paper and dark marble alike, with no hard-edged box (the blur of a shape drawn off-canvas and
    // shadow-cast into place, which every 2D canvas supports)
    const plate = (x0, x1p, py0, py1, a) => {
      const h = py1 - py0, off = 4 * (W + H);
      g.save();
      g.globalAlpha = a;
      g.shadowColor = 'rgba(14,12,10,.5)';
      g.shadowBlur = h * 0.8;
      g.shadowOffsetX = off; g.shadowOffsetY = 0;
      g.fillStyle = '#000';
      g.beginPath();
      if (g.roundRect) g.roundRect(x0 - off, py0, x1p - x0, h, h / 2); else g.rect(x0 - off, py0, x1p - x0, h);
      g.fill();
      g.restore();
    };
    if (e < 1 && t >= this.t0 - 0.2) {
      const px = Math.round(0.024 * k);
      const a = (1 - e) * smooth(this.t0 - 0.2, this.t0 + 0.2, t);
      g.font = `500 ${px}px Geist, "Helvetica Neue", Arial, sans-serif`;
      const sp = drawing || t < this.t0 ? `  ·  ${formatSpeed(speed)}` : '';
      const main = formatHand(hand, speed < 40);
      // measure first (same cells as drawn), so the plate fits the text
      const dw = g.measureText('0').width;
      const wOf = s => [...s].reduce((w, ch) => w + (/\d/.test(ch) ? dw : g.measureText(ch).width), 0);
      const tw = wOf(sp) + wOf(main), padX = px * 0.75, padY = px * 0.5;
      plate(x1 - tw - padX, x1 + padX, y1 - px * 0.95 - padY, y1 + px * 0.25 + padY, a);
      g.globalAlpha = a;
      const w = cells(sp, x1, y1, px, 'rgba(255,250,242,.7)');
      cells(main, x1 - w, y1, px, 'rgba(255,250,242,.96)');
    }
    if (e > 0) {
      const px = Math.round(0.034 * k);
      g.font = `italic 400 ${px}px "Instrument Serif", Georgia, serif`;
      const text = this._cardText();
      const tw = g.measureText(text).width, padX = px * 0.6, padY = px * 0.34;
      plate(x1 - tw - padX, x1 + padX, y1 - px * 0.78 - padY, y1 + px * 0.24 + padY, e);
      g.globalAlpha = e;
      g.textAlign = 'right';
      g.fillStyle = 'rgba(255,250,242,.97)';
      g.fillText(text, x1, y1);
    }
    g.restore();
  }

  /**
   * The cinematic tool: drawn in the desk plane's local frame at its tip, so it scales with the
   * perspective and turns with the camera, its shadow falling away from the window like the
   * sheet's (the context gets the rotation only and the size carries the scale, because tools.js
   * pads its layers in user units).
   * - A real 180-degree shutter: copies of the sprite along the tip's true path over half a frame
   *   are averaged, so a pen racing round a ring at timelapse speed is a translucent streak, as a
   *   hand is in a real timelapse, instead of strobing from one clock position to the next. The
   *   nib is then laid over it crisp where it touches the line, so the contact always reads.
   * - Depth of field: the body rises from the paper toward the lens, so it is blurred along its
   *   length with the scene's own thin lens (the nib, on the paper, is as sharp as the line).
   * The sprite is painted once per frame; the streak, the nib and the blur are made from it.
   */
  /**
   * Shutter time (film seconds) for the tool's motion blur. A realistic film is a timelapse: a
   * camera over a real desk exposes each frame for ~1/60 s of the hand's own motion, so at 500x
   * the pen is crisp and jumps between frames instead of smearing into a ghost across the sheet.
   */
  _shutter(t, base) {
    if (!this.real || !this.hand) return base;
    return Math.min(base, (1 / 60) / Math.max(1, this.hand.speed(t)));
  }

  _drawToolCinematic(g, t, basis, focus) {
    const lib = this.sceneLib, tools = this.tools, s = this.state;
    const pose = this.toolPose(t);
    const [a, b] = lib.planeTransform(basis, pose.x, pose.y);
    const sc = Math.hypot(a, b), ca = a / sc, sa = b / sc;
    const size = this.toolLen * sc;
    const kind = s.brush.tool;
    const opts = { color: s.photoColor ? '#8a5a44' : s.ink, lift: pose.lift, angle: pose.angle, sway: pose.sway };
    // the tip's path over the shutter, in device px, oldest first
    const K = 14, shutter = this._shutter(t, 0.5 / this.fps);
    const path = [];
    let trail = 0;
    for (let k = 0; k < K; k++) {
      const p = k === K - 1 ? pose : this.toolPose(t - shutter * (1 - k / (K - 1)));
      const q = lib.project(basis, p.x, p.y);
      if (k) trail += Math.hypot(q[0] - path[k - 1][0], q[1] - path[k - 1][1]);
      path.push([q[0], q[1]]);
    }
    const tip = path[K - 1];
    const toCtx = (X, Y) => [ca * X + sa * Y, -sa * X + ca * Y];      // device -> rotated context
    const [tx, ty] = toCtx(tip[0], tip[1]);
    if (!this.layers) {
      g.save();
      g.setTransform(ca, sa, -sa, ca, 0, 0);
      tools.drawToolMotion(g, kind, path.map(([X, Y]) => { const [x, y] = toCtx(X, Y); return { x, y }; }), size, { ...opts, maxBlur: Infinity });
      g.restore();
      return;
    }
    // device box of the still sprite: its own bounds, turned by the context's rotation
    const bb = tools.toolBounds(kind, tx, ty, size, opts);
    let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
    for (const [u, v] of [[bb.x, bb.y], [bb.x + bb.w, bb.y], [bb.x, bb.y + bb.h], [bb.x + bb.w, bb.y + bb.h]]) {
      const X = ca * u - sa * v, Y = sa * u + ca * v;
      sx0 = Math.min(sx0, X); sy0 = Math.min(sy0, Y); sx1 = Math.max(sx1, X); sy1 = Math.max(sy1, Y);
    }
    let ox0 = 0, oy0 = 0, ox1 = 0, oy1 = 0;
    for (const [X, Y] of path) {
      ox0 = Math.min(ox0, X - tip[0]); oy0 = Math.min(oy0, Y - tip[1]);
      ox1 = Math.max(ox1, X - tip[0]); oy1 = Math.max(oy1, Y - tip[1]);
    }
    // depth of field along the body: blur radius at the tip and at thirds up to the raised end
    const ln = lib.lens(basis, focus);
    const ang = pose.angle * DEG, d = [Math.sin(ang), Math.cos(ang)];
    const hBack = this.toolLen * Math.tan((pose.elev || 0) * DEG);
    const cocs = [0, 1, 2, 3].map(j => ln.coc(pose.x + d[0] * this.toolLen * j / 3, pose.y + d[1] * this.toolLen * j / 3, hBack * j / 3));
    const maxCoc = this.dof ? Math.max(...cocs) : 0;
    const pad = 3 + 2.5 * maxCoc;
    // boxes on even pixels, so the half-resolution blur passes line up exactly
    const boxOf = (x0, y0, x1, y1) => {
      const r = { x: Math.max(0, Math.floor(x0 / 2) * 2), y: Math.max(0, Math.floor(y0 / 2) * 2),
        x1: Math.min(this.W, Math.ceil(x1 / 2) * 2), y1: Math.min(this.H, Math.ceil(y1 / 2) * 2) };
      r.w = r.x1 - r.x; r.h = r.y1 - r.y;
      return r;
    };
    const sBox = boxOf(sx0 - 2, sy0 - 2, sx1 + 2, sy1 + 2);
    const box = boxOf(sx0 + ox0 - pad, sy0 + oy0 - pad, sx1 + ox1 + pad, sy1 + oy1 + pad);
    if (box.w <= 0 || box.h <= 0 || sBox.w <= 0 || sBox.h <= 0) return;
    const [Lt, Ln, La, Lh] = this.layers;
    const reset = (L, r = box) => {
      const c = L.g;
      c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; c.filter = 'none';
      if (r) c.clearRect(r.x, r.y, r.w, r.h);
    };
    // 1. the sprite at this instant, painted once
    reset(Ln);
    Ln.g.setTransform(ca, sa, -sa, ca, 0, 0);
    tools.drawTool(Ln.g, kind, tx, ty, size, opts);
    Ln.g.setTransform(1, 0, 0, 1, 0, 0);
    let src = Ln;
    if (trail > 0.75) {
      // 2. the shutter: N copies along the path, each at 1/N ('lighter' on premultiplied pixels;
      // N a power of two, so a fully covered pixel still adds up to exactly opaque in 8 bits)
      const N = Math.min(16, Math.max(2, 2 ** Math.ceil(Math.log2(trail / 1.5))));
      reset(Lt);
      Lt.g.globalCompositeOperation = 'lighter';
      Lt.g.globalAlpha = 1 / N;
      for (let j = 0; j < N; j++) {
        const u = (j + 0.5) / N * (K - 1), i = Math.min(K - 2, Math.floor(u)), f = u - i;
        const dx = mix(path[i][0], path[i + 1][0], f) - tip[0], dy = mix(path[i][1], path[i + 1][1], f) - tip[1];
        Lt.g.drawImage(Ln.c, sBox.x, sBox.y, sBox.w, sBox.h, sBox.x + dx, sBox.y + dy, sBox.w, sBox.h);
      }
      reset(Lt, null);
      if (trail > 3) {
        // 3. the nib, crisp, over the streak: fully where it touches, fading out up the body
        const r = size * 0.16, nb = boxOf(tip[0] - r, tip[1] - r, tip[0] + r, tip[1] + r);
        if (nb.w > 0 && nb.h > 0) {
          const gr = Ln.g.createRadialGradient(tip[0], tip[1], 0, tip[0], tip[1], r);
          gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.45, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
          Ln.g.globalCompositeOperation = 'destination-in';
          Ln.g.fillStyle = gr;
          Ln.g.fillRect(nb.x, nb.y, nb.w, nb.h);
          Ln.g.globalCompositeOperation = 'source-over';
          Lt.g.drawImage(Ln.c, nb.x, nb.y, nb.w, nb.h, nb.x, nb.y, nb.w, nb.h);
        }
      }
      src = Lt;
    }
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (maxCoc < 0.75) {
      g.drawImage(src.c, box.x, box.y, box.w, box.h, box.x, box.y, box.w, box.h);
      g.restore();
      return;
    }
    // 4. four bands along the body, each blurred by its own radius (at half resolution: they are
    // blurred anyway) and weighted by a tent along the body's screen axis (the weights sum to one
    // everywhere), added up premultiplied
    const P0 = lib.project(basis, pose.x, pose.y), P1 = lib.project(basis, pose.x + d[0] * this.toolLen, pose.y + d[1] * this.toolLen);
    const tmp = src === Lt ? Ln : Lt;
    const hb = { x: box.x / 2, y: box.y / 2, w: box.w / 2, h: box.h / 2 };
    reset(La);
    for (let j = 0; j < 4; j++) {
      const half = cocs[j] > 0.6;
      const L = half ? Lh : tmp, r = half ? hb : box, k = half ? 0.5 : 1;
      reset(L, r);
      if (half) L.g.filter = `blur(${(0.25 * cocs[j]).toFixed(2)}px)`;
      L.g.drawImage(src.c, box.x, box.y, box.w, box.h, r.x, r.y, r.w, r.h);
      L.g.filter = 'none';
      const gr = L.g.createLinearGradient(P0[0] * k, P0[1] * k, P1[0] * k, P1[1] * k);
      const stop = (u, w) => gr.addColorStop(clamp(u, 0, 1), `rgba(0,0,0,${w})`);
      if (j > 0) { stop(0, 0); stop((j - 1) / 3, 0); }
      stop(j / 3, 1);
      if (j < 3) { stop((j + 1) / 3, 0); stop(1, 0); }
      L.g.globalCompositeOperation = 'destination-in';
      L.g.fillStyle = gr;
      L.g.fillRect(r.x, r.y, r.w, r.h);
      L.g.globalCompositeOperation = 'source-over';
      La.g.globalCompositeOperation = 'lighter';
      La.g.drawImage(L.c, r.x, r.y, r.w, r.h, box.x, box.y, box.w, box.h);
      La.g.globalCompositeOperation = 'source-over';
    }
    g.drawImage(La.c, box.x, box.y, box.w, box.h, box.x, box.y, box.w, box.h);
    g.restore();
  }

  /**
   * Extra encodeVideo options: the cinematic film asks for a keyframe where the finale starts (the
   * reveal, or the camera's arrival on the final framing), so it starts from a clean picture.
   * Encoders that barely refine a slowly changing image after a move (Firefox's Media Foundation
   * H.264) otherwise keep the move's softness. `keyFrames` (frame indices) is ignored by an
   * encoder that does not support it.
   */
  encodeHints() {
    if (this.style !== 'cinematic') return {};
    const at = this.reveal && this.drawPhoto ? this.tReveal : this.restAt;
    return { keyFrames: [Math.min(this.frames - 1, Math.ceil(at * this.fps))] };
  }

  /** Pen tip on screen (px) at frame i — for tests: the tip must sit on the line and in frame. */
  tipOnScreen(i) {
    const t = i / this.fps;
    const p = this.toolPose(t);
    if (this.style !== 'cinematic') return [this.px + (p.x + 0.5) * this.side, this.py + (p.y + 0.5) * this.side];
    const b = this.sceneLib.cameraBasis(this.plan.at(t), this.W, this.H, this.side);
    return this.sceneLib.project(b, p.x, p.y).slice(0, 2);
  }
}

// ---------------------------------------------------------------------------------- dialog
// One renderer (one WebGL context) for the dialog's live preview and its encodes: the film scene's
// program and the baked desks live in that context, so they are made once, not per film. Kept a
// minute after the dialog closes (reopening is instant), then freed.
let stage = null, stageTimer = 0, stageInUse = false, onStageRestored = null;
function filmStage() {
  clearTimeout(stageTimer);
  if (stage && (stage.renderer.lost || stage.renderer.gl.isContextLost())) { try { stage.renderer.destroy(); } catch { /* gone */ } stage = null; }
  if (!stage) {
    // A film shows one medium, so no warm-up of the others. block: false = its programs compile
    // off this thread while the dialog keeps responding (the preview and an encode wait for
    // composer.ready()). onRestored lets the dialog restart a preview the GPU interrupted.
    const renderer = new Renderer(document.createElement('canvas'), { block: false, lowMemory: isTouch(), onRestored: () => onStageRestored?.() });
    stage = { renderer };
  }
  return stage;
}
// Between films the context stays (its scene program and baked desk make reopening instant), but
// the sheet-sized targets, the macro's rect view and the wet grid go back at once: on a phone they
// are most of the film's GPU memory.
function trimStage() {
  const r = stage?.renderer;
  if (!r || r.lost) return;
  try { r.releaseRect(); r.freeSim(); r.setSize(16, 16); } catch { /* context gone */ }
}
function releaseStageLater() {
  clearTimeout(stageTimer);
  if (stageInUse) return;
  trimStage();
  stageTimer = setTimeout(() => { stage?.renderer.destroy(); stage = null; }, 60000);
}

/**
 * Get the film ready before the dialog opens (e.g. when the pointer reaches the Film button):
 * the film's context, the scene program and desk `desk` start compiling and baking in the
 * background, so the dialog's preview can start at once. Safe to call any number of times.
 */
export async function warmFilm(desk = 'nero') {
  try {
    const scene = await import('./scene.js');
    scene.loadDesk(filmStage().renderer.gl, deskById(desk).id);
    releaseStageLater();          // (freed again if the dialog is not opened after all)
  } catch (e) { console.warn(e); }
}

export function createFilmDialog(app) {
  const $ = id => document.getElementById(id);
  const dlg = $('filmDialog');
  const f = app.prefs.film;
  if (!STYLES.includes(f.style)) f.style = 'cinematic';
  if (!FPS_CHOICES.includes(+f.fps)) f.fps = f.style === 'cinematic' ? 60 : 30;
  if (!DESKS.some(d => d.id === f.desk)) f.desk = 'nero';
  const previewCanvas = $('filmPreview');
  const video = $('filmVideo');
  let preview = null, previewRaf = 0, previewStart = 0, openedAt = 0;
  let abort = null, result = null, resultUrl = '';
  let ringsOverride = null;
  let modules = null;

  async function loadModules() {
    if (!modules) {
      const [tools, encoder, exp, scene] = await Promise.all([
        import('./tools.js').catch(() => null),
        import('./encoder.js'),
        import('./export.js'),
        import('./scene.js').catch(e => { console.warn(e); return null; }),
      ]);
      modules = { tools, encoder, exp, scene };
    }
    return modules;
  }

  // the background picker: one swatch per desk (the images load when the dialog first opens)
  const deskSeg = dlg.querySelector('[data-film="desk"]');
  for (const d of DESKS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.v = d.id;
    b.title = `${d.name}: ${d.note}`;
    b.setAttribute('aria-label', d.name);
    const img = document.createElement('img');
    img.alt = ''; img.width = 64; img.height = 43; img.decoding = 'async';
    img.dataset.src = `img/desks/${d.id}.jpg`;
    b.append(img);
    deskSeg.append(b);
  }
  function deskCaption() {
    const d = deskById(f.desk), cap = $('filmDeskCap');
    cap.replaceChildren();
    const b = document.createElement('b');
    b.textContent = d.name;
    cap.append(b, ` · ${d.note}`);
  }
  // Bake the chosen desk in the film's context now, in the background, so neither the preview
  // nor the Film button waits for it later.
  function prebake() {
    if (!modules?.scene?.loadDesk) return;
    try {
      const gl = filmStage().renderer.gl;
      modules.scene.loadDesk(gl, f.desk);
      // then, in the background, the other desks' programs: picking one bakes it at once
      modules.scene.warmDesks?.(gl, DESKS.map(d => d.id));
    } catch (e) { console.warn(e); }
  }

  const segs = {
    desk: bindSeg(deskSeg, f.desk, v => {
      f.desk = v; app.persist(); deskCaption();
      prebake();
      // the preview switches at once (the desk sharpens as it bakes)
      if (preview) preview.setDesk(v); else refresh();
    }),
    format: bindSeg(dlg.querySelector('[data-film="format"]'), f.format, v => { f.format = v; app.persist(); reprobe(); }),
    // (a length picked by hand is kept even where a realistic drawing would default to 60 s)
    length: bindSeg(dlg.querySelector('[data-film="length"]'), String(f.length), v => { f.length = +v; f.lengthChosen = true; app.persist(); refresh(); app.refreshTransport(); }),
    style: bindSeg(dlg.querySelector('[data-film="style"]'), f.style, v => {
      f.style = v;
      // 60 fps is the cinematic default; follow the style until the rate is chosen by hand
      if (!f.fpsChosen) { f.fps = v === 'cinematic' ? 60 : 30; segs.fps.set(String(f.fps)); }
      app.persist(); reprobe();
    }),
    fps: bindSeg(dlg.querySelector('[data-film="fps"]'), String(f.fps), v => { f.fps = +v; f.fpsChosen = true; app.persist(); reprobe(); }),
    pacing: bindSeg(dlg.querySelector('[data-film="pacing"]'), app.prefs.pacing, v => { app.prefs.pacing = v; app.persist(); refresh(); app.refreshTransport(); }),
    start: bindSeg(dlg.querySelector('[data-film="start"]'), app.doc.line.start, v => { app.doc.line.start = v; app.persist(); refresh(); app.refreshTransport(); }),
  };
  for (const key of ['showTool', 'polaroid', 'reveal', 'counter']) {
    const el = dlg.querySelector(`[data-film="${key}"]`);
    if (!el) continue;
    // the realistic film's clock is on unless turned off
    el.checked = key === 'counter' ? f.counter !== false : !!f[key];
    el.addEventListener('change', () => { f[key] = el.checked; app.persist(); refresh(); app.refreshTransport(); });
  }
  // Sign it: the name is kept as typed; the preview restarts once typing pauses (a new signature
  // changes the timeline, so the whole film is planned again)
  const signEl = $('filmSign');
  signEl.maxLength = SIGNATURE_MAX;
  signEl.value = typeof f.signature === 'string' ? f.signature.slice(0, SIGNATURE_MAX) : '';
  let signTimer = 0, signShown = cleanSignature(signEl.value);
  signEl.addEventListener('input', () => {
    f.signature = signEl.value.slice(0, SIGNATURE_MAX);
    app.persist();
    clearTimeout(signTimer);
    signTimer = setTimeout(() => {
      const now = cleanSignature(f.signature);
      if (now === signShown) return;
      signShown = now;
      refresh(); app.refreshTransport();
    }, 400);
  });
  signEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('filmGo').focus(); } });

  function currentFormat() { return FORMATS[f.format] || FORMATS.square; }
  // Realistic mode (doc.mode, with a geometry that carries its hand time): the film is the true
  // drawing, sped up
  // Line art mode films the same way, at near real speed (15, 30 or 60 s)
  const lineNow = () => app.doc?.mode === 'lineart' && app.geom?.path === 'lineart';
  const realNow = () => (app.doc?.mode === 'realistic' || lineNow() ? realInfo(app.geom) : null);
  const filmLength = () => filmLengthFor(f, app.geom, app.doc?.mode === 'realistic');
  const modeLight = () => (lineNow() ? app.doc?.lineart?.light : app.doc?.real?.light);
  // the sheet's width in the full-size film's final frame (the fine-line guard is judged on it)
  function filmSide() { const fmt = currentFormat(); return sheetPlace(f.format, fmt.w, fmt.h, f.style).side; }
  const fps = () => (FPS_CHOICES.includes(+f.fps) ? +f.fps : FPS);

  function filmGeometry(side) {
    // a realistic drawing is filmed as it is: its line is the real tool's width on the real sheet
    if (realNow()) { $('filmGuard').hidden = true; ringsOverride = null; return app.geom; }
    // Fine-line guard: below ~4 output px between rings, H.264 and social apps smear the line.
    const rings = app.doc.line.rings;
    const maxRings = Math.floor((side * app.layout.r) / 4.5);
    const guard = $('filmGuard');
    if (rings > maxRings) {
      guard.hidden = false;
      guard.replaceChildren();
      const span = document.createElement('span');
      span.textContent = ringsOverride
        ? `Filming with ${ringsOverride} rings so the line stays crisp in video.`
        : `At ${rings} rings the line is finer than a video pixel and may shimmer. ${maxRings} rings or fewer films best.`;
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'text-btn';
      btn.textContent = ringsOverride ? `Use ${rings}` : `Film with ${maxRings}`;
      btn.addEventListener('click', () => { ringsOverride = ringsOverride ? null : maxRings; refresh(); });
      guard.append(span, btn);
    } else {
      guard.hidden = true;
      ringsOverride = null;
    }
    const want = { start: app.doc.line.start, ...(ringsOverride ? { rings: ringsOverride } : {}) };
    const same = !ringsOverride && app.geom && app.geom.start === want.start;
    return same ? app.geom : app.geometryWith(want);
  }

  function snapshotState(side) {
    const st = app.renderState(filmGeometry(side));
    return { ...st, layout: { ...st.layout } };
  }

  function composerFor(W, H, live = false) {
    return new FilmComposer({
      renderer: filmStage().renderer, desk: f.desk, live,
      W, H, format: f.format, length: filmLength(), showTool: f.showTool, polaroid: f.polaroid, reveal: f.reveal && !realNow(),
      pacing: app.prefs.pacing, state: snapshotState(filmSide()),
      realistic: !!realNow(), lineart: lineNow(), counter: f.counter !== false, light: modeLight(),
      drawPhoto: app.photo ? (g, cx, cy, R) => app.drawPhotoInCircle(g, cx, cy, R) : null,
      tools: modules?.tools, sceneLib: modules?.scene, style: f.style,
      // the pace and the camera are planned in seconds, so the preview runs the film's own frame
      // rate and shows exactly the frames it will encode (a 30 fps preview of a 60 fps film would
      // strobe twice as much as the result)
      fps: fps(),
      signature: f.signature,
    });
  }

  function summary() {
    const fmt = currentFormat();
    const rate = fps();
    const mbps = (fmt.w * fmt.h >= 1920 * 1080 ? 12 : fmt.h === 1350 ? 9 : 8) * Math.pow(rate / 30, 0.6);
    // a moving camera changes every pixel of every frame, so it uses nearly all of its bitrate
    const len = filmLength();
    const mb = Math.round(mbps * len / 8 * (f.style === 'cinematic' ? 0.92 : 0.7));
    const engine = modules?.probe;
    const container = engine?.webcodecs ? 'MP4' : engine?.recorder ? engine.recorder.ext.toUpperCase() : null;
    $('filmSummary').textContent = container
      ? `${container} · ${fmt.w} × ${fmt.h} · ${rate} fps · about ${Math.max(1, mb)} MB`
      : `${fmt.w} × ${fmt.h} · ${rate} fps`;
    $('filmGoLabel').textContent = `Film ${len}-second video`;
    // realistic: how long the drawing takes by hand, and how much the film speeds it up
    const R = realNow(), hand = $('filmHand');
    if (hand) {
      hand.hidden = !R;
      if (R) {
        const D = drawSeconds(len, false, f.style, signSeconds(f.signature));
        const avg = R.handSeconds / Math.max(1, D);
        hand.textContent = R.lineart
          // (the looks at the model play a little slower than the line: the speed-up is the line's)
          ? `${formatHand(R.handSeconds, 'total')} of drawing by hand · shown ${avg >= 1.25 ? `about ${formatSpeed(R.clock.total / Math.max(1, D))} faster` : 'at real speed'} in ${len} s`
          : `About ${formatHand(R.handSeconds)} of drawing by hand · shown ${avg >= 1.25 ? `about ${formatSpeed(avg)} faster` : 'at real speed'} in ${len} s`;
      }
    }
    const note = $('filmEngineNote');
    if (engine && !engine.webcodecs && engine.recorder) note.textContent = `This browser records in real time — filming takes ${len} s. Keep this tab open.`;
    else if (engine && !engine.webcodecs && !engine.recorder) note.textContent = 'Video needs a newer browser — image export still works.';
    else note.textContent = '';
    $('filmGo').disabled = !!(engine && !engine.webcodecs && !engine.recorder);
  }

  // live looping preview of the actual composition
  function startPreview() {
    stopPreview();
    const fmt = currentFormat();
    const maxW = previewCanvas.parentElement.clientWidth || 300;
    // the stylesheet caps the preview's height (38dvh on phones): size to that cap, or the canvas
    // would be squashed and its grid row laid out for the wrong height
    const cssMax = parseFloat(getComputedStyle(previewCanvas).maxHeight);
    const maxH = Math.min(440, window.innerHeight * 0.45, cssMax > 0 ? cssMax : Infinity);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = Math.min(maxW / fmt.w, maxH / fmt.h) * dpr;
    const W = Math.round(fmt.w * scale / 2) * 2, H = Math.round(fmt.h * scale / 2) * 2;
    previewCanvas.width = W; previewCanvas.height = H;
    previewCanvas.style.width = `${W / dpr}px`;
    try {
      preview = composerFor(W, H, true);
      preview.prepare();
    } catch (e) { console.warn(e); preview = null; return; }
    previewStart = performance.now();
    const g = previewCanvas.getContext('2d');
    let lastFrame = -1;
    const loop = now => {
      previewRaf = requestAnimationFrame(loop);
      // (the first time, the scene's program may still be compiling: skip frames, don't freeze)
      if (!preview.ready()) { previewStart = now; return; }
      const t = ((now - previewStart) / 1000) % preview.length;
      const i = Math.floor(t * preview.fps);
      if (i === lastFrame) return;
      if (i < lastFrame) preview.rewind();
      lastFrame = i;
      try { preview.draw(i, g); } catch (e) {
        cancelAnimationFrame(previewRaf);
        // a lost GPU context is not a bug: the stage's onRestored starts the preview again
        if (!(stage?.renderer.lost || stage?.renderer.gl.isContextLost())) console.warn(e);
      }
      if (openedAt) {
        // for tests and tuning: how long the dialog took to show its first frame, and the desk
        window.__filmPreview = { firstFrameMs: Math.round(performance.now() - openedAt),
          stage: () => preview?.scene?.deskStage ?? null, desk: () => preview?.scene?.desk?.id ?? null };
        openedAt = 0;
      }
    };
    if (reducedMotion()) preview.draw(Math.round(preview.frames * 0.6), g);
    else previewRaf = requestAnimationFrame(loop);
  }
  function stopPreview() {
    cancelAnimationFrame(previewRaf);
    preview?.destroy();
    preview = null;
  }
  // the context comes back empty (scene, desk and sheet made in it are gone): start over
  onStageRestored = () => { if (dlg.open && !$('filmSetup').hidden) startPreview(); };

  function refresh() {
    segs.desk.set(f.desk);
    deskCaption();
    segs.pacing.set(app.prefs.pacing);
    segs.start.set(app.doc.line.start);
    segs.style.set(f.style);
    segs.fps.set(String(fps()));
    segs.length.set(String(filmLength()));
    // realistic: no photo reveal, no pace or start to choose (the hand's own clock and order),
    // and the drawing clock to show or not
    const R = !!realNow();
    for (const [id, hide] of [['filmRevealRow', R], ['filmMore', R], ['filmCounterRow', !R]]) { const el = $(id); if (el) el.hidden = hide; }
    // Line art is filmed at near real speed: 15, 30 or 60 s (no 10 s clip of a 2 minute drawing)
    const line = lineNow();
    for (const b of dlg.querySelectorAll('[data-film="length"] [data-v]')) b.hidden = b.disabled = line && !LINEART_LENGTHS.includes(+b.dataset.v);
    summary();
    filmGeometry(filmSide());
    if (!$('filmSetup').hidden) startPreview();
  }

  // format and frame rate change what the encoder must support
  async function reprobe() {
    refresh();
    if (!modules?.encoder) return;
    const fmt = currentFormat();
    try { modules.probe = await modules.encoder.probeVideo({ width: fmt.w, height: fmt.h, fps: fps() }); } catch { /* keep the old answer */ }
    summary();
  }

  function showView(which) {
    $('filmSetup').hidden = which !== 'setup';
    $('filmProgress').hidden = which !== 'progress';
    $('filmResult').hidden = which !== 'result';
    $('filmFootSetup').hidden = which !== 'setup';
    $('filmFootProgress').hidden = which !== 'progress';
    $('filmFootResult').hidden = which !== 'result';
    previewCanvas.hidden = which === 'result';
    video.hidden = which !== 'result';
    $('filmTitle').textContent = which === 'result' ? 'Your timelapse' : 'Film the drawing';
  }

  async function open() {
    openedAt = performance.now();
    stageInUse = true;
    app.pause();
    clearResult();
    showView('setup');
    for (const img of deskSeg.querySelectorAll('img[data-src]')) { img.src = img.dataset.src; img.removeAttribute('data-src'); }
    dlg.showModal();
    // the signature's handwriting face: a preview traced with the fallback face is redone once it loads
    if (!signatureFontLoaded()) {
      ensureSignatureFont().then(() => { if (cleanSignature(f.signature) && dlg.open && !$('filmSetup').hidden) startPreview(); });
    }
    await loadModules();
    prebake();
    // the preview starts at once; the first encoder probe can take seconds (hardware start-up)
    // and only changes the summary line
    refresh();
    $('filmGo').focus();
    try {
      const fmt = currentFormat();
      modules.probe = await modules.encoder.probeVideo({ width: fmt.w, height: fmt.h, fps: fps() });
    } catch { modules.probe = null; }
    summary();
  }

  function clearResult() {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = ''; result = null;
    video.removeAttribute('src'); video.load();
  }

  async function go(scaleDown = 1) {
    const { encoder, tools } = await loadModules();
    const fmt = currentFormat();
    const W = Math.round(fmt.w * scaleDown / 2) * 2, H = Math.round(fmt.h * scaleDown / 2) * 2;
    stopPreview();
    showView('progress');
    $('filmBar').style.width = '0%';
    $('filmPct').textContent = 'Filming… 0%';
    $('filmEta').textContent = '';
    // this take's own controller: a retry makes its own, and the Stop button / Escape reach
    // whichever is current through `abort`
    const ac = new AbortController();
    abort = ac;
    let wake = null;
    try { wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
    const t0 = performance.now();
    let passT0 = t0, lastUi = 0, retry = false;
    const g2 = previewCanvas.getContext('2d');
    let composer = null;
    try {
      // the desk is normally baked by now (it started when the dialog opened or the desk was
      // picked); if not, finish it before the first frame rather than film a stand-in
      if (modules.scene?.loadDesk) await modules.scene.loadDesk(filmStage().renderer.gl, f.desk, { urgent: true });
      // the handwriting face for the signature (offline: the system's cursive after a moment)
      if (cleanSignature(f.signature)) await Promise.race([ensureSignatureFont(), new Promise(r => setTimeout(r, 2500))]);
      composer = composerFor(W, H);
      composer.tools = tools;
      // The medium's programs, then the scene's, finish compiling off this thread (prepare()
      // already draws the flat film's desk shot with the medium's programs).
      const until = async ok => {
        while (!ok()) {
          if (ac.signal.aborted) throw Object.assign(new Error('Filming stopped'), { code: 'aborted' });
          await new Promise(r => setTimeout(r, 30));
        }
      };
      const st = composer.state;
      await until(() => !composer.renderer.pending?.(st.brush, st.paper));
      composer.prepare();
      await until(() => composer.ready());
      const prepMs = performance.now() - t0;
      const res = await encoder.encodeVideo({
        width: W, height: H, fps: composer.fps, frames: composer.frames, signal: ac.signal,
        ...composer.encodeHints(),
        drawFrame: (i, ctx) => composer.draw(i, ctx),
        onProgress: (done, total, canvas) => {
          const now = performance.now();
          // (0, total, null) = the encoder started over (hardware -> software, or -> the
          // recorder): the time estimate counts from the new pass, not the failed one
          if (done === 0 && !canvas) { passT0 = now; lastUi = 0; }
          if (now - lastUi < 100 && done < total) return;
          lastUi = now;
          const pct = Math.round(done / total * 100);
          $('filmBar').style.width = `${pct}%`;
          $('filmPct').textContent = `Filming… ${pct}%`;
          const el = (now - passT0) / 1000;
          const eta = done > 5 ? Math.max(0, el / done * (total - done)) : null;
          $('filmEta').textContent = `Frame ${done} of ${total}${eta != null ? ` · about ${Math.ceil(eta)} s left` : ''}`;
          if (canvas) {
            if (previewCanvas.width !== 300 || previewCanvas.height !== Math.round(300 * H / W)) {
              previewCanvas.width = 300; previewCanvas.height = Math.round(300 * H / W);
              previewCanvas.style.width = '';
            }
            g2.drawImage(canvas, 0, 0, previewCanvas.width, previewCanvas.height);
          }
          if (pct % 25 === 0) announce(`Filming ${pct}%`);
        },
      });
      // timing for tests and tuning: composer ms per frame vs the whole encode
      window.__filmLast = {
        style: composer.style, fps: composer.fps, frames: composer.frames, width: W, height: H,
        sheetPx: composer.sheetPx || composer.side, prepMs: Math.round(prepMs),
        composeMsPerFrame: +(composer.stats.ms / Math.max(1, composer.stats.frames)).toFixed(2),
        totalMs: Math.round(performance.now() - t0), encoder: res.perFrameMs, codec: res.codec, engine: res.engine,
        sign: composer.sign ? { t0: composer.tS0, t1: composer.tS1, em: +composer.sign.em.toFixed(4), font: composer.sign.font, text: composer.sign.text } : null,
        real: composer.real ? { style: composer.real.style, sheetMm: composer.real.sheetMm, toolMm: composer.real.toolMm,
          handSeconds: Math.round(composer.real.handSeconds), peak: Math.round(composer.hand.peak), avg: Math.round(composer.hand.avg),
          open: composer.hand.open, toolLen: +composer.toolLen.toFixed(4), mode: composer.intent?.mode || null, length: composer.length,
          lineart: composer.lineart ? { handT: +composer.real.handT[composer.real.handT.length - 1].toFixed(1), pauses: composer.real.pauses,
            pauseSeconds: +composer.real.pauseSeconds.toFixed(1), drawEnd: +composer.t1.toFixed(3), macro: !!composer.intent?.macro,
            retracedM: composer.real.retracedM, engine: composer.real.engine } : null } : null,
      };
      result = res;
      showResult(res, W, H);
    } catch (e) {
      if (e?.code === 'aborted' || ac.signal.aborted) {
        toast('Filming stopped.');
        showView('setup'); startPreview();
      } else if (e?.code === 'unsupported') {
        // a smaller take would fail the same way: say so once
        console.warn(e);
        toast('This browser cannot make this video. Try Square or 30 fps — image export still works.', { error: true });
        showView('setup'); startPreview();
      } else if (scaleDown === 1) {
        console.warn('film failed, retrying smaller', e);
        toast('That was too much for this device — trying a smaller video.');
        retry = true;
      } else {
        console.error(e);
        toast('Filming stopped — this device ran out of video memory. Try Square or a shorter length.', { error: true });
        showView('setup'); startPreview();
      }
    } finally {
      composer?.destroy();
      // (the result view plays the file; the next preview sizes the stage again)
      if (!retry && result) trimStage();
      try { await wake?.release(); } catch { /* ignore */ }
      if (abort === ac) abort = null;
    }
    // only after this take has cleaned up, so the retry's controller and wake lock are its own
    // (a retry started inside catch had its controller cleared by this take's finally)
    if (retry) return go(2 / 3);
  }

  function fileBase() {
    const name = (app.photo?.name || 'drawing').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'drawing';
    const look = lineNow() ? `line-art-${app.doc.lineart?.style || app.geom?.lineart?.style || 'drawing'}` : app.lookName();
    return `spiralist-${name}-${String(look).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${filmLength()}s`;
  }

  function showResult(res, W, H) {
    showView('result');
    resultUrl = URL.createObjectURL(res.blob);
    video.src = resultUrl;
    video.play().catch(() => {});
    const mb = (res.blob.size / 1e6).toFixed(1);
    $('filmMeta').textContent = `${fileBase()}.${res.ext} · ${W} × ${H} · ${res.fps} fps · ${mb} MB`;
    const note = $('filmNote');
    note.hidden = res.ext !== 'webm';
    note.textContent = 'Saved as WebM. Some apps (Instagram, iMessage) won\'t accept it — Chrome, Edge or Safari make MP4.';
    const canShare = modules.exp.canShareFiles(res.mimeType);
    $('filmXNote').hidden = true;
    $('filmShare').hidden = !canShare;
    $('filmDownload').classList.toggle('primary', !canShare);
    $('filmDownload').classList.toggle('secondary', canShare);
    announce('Video ready');
    (canShare ? $('filmShare') : $('filmDownload')).focus();
  }

  $('filmGo').addEventListener('click', () => go());
  $('filmStop').addEventListener('click', () => abort?.abort());
  $('filmAgain').addEventListener('click', () => { clearResult(); showView('setup'); startPreview(); });
  $('filmDownload').addEventListener('click', () => {
    if (!result) return;
    modules.exp.downloadBlob(result.blob, `${fileBase()}.${result.ext}`);
    toast(`Saved ${fileBase()}.${result.ext}`);
  });
  $('filmShare').addEventListener('click', async () => {
    if (!result) return;
    const out = await modules.exp.shareFile(result.blob, `${fileBase()}.${result.ext}`, 'My one-line drawing');
    if (out === 'failed' || out === 'unsupported') {
      modules.exp.downloadBlob(result.blob, `${fileBase()}.${result.ext}`);
      toast('Saved to your downloads.');
    }
  });
  // Post on X: a phone hands the video itself to the share sheet (pick X there); a desktop opens
  // X's composer (it cannot take a file) and saves the video to attach. shareToX opens that tab
  // synchronously, inside this click, so popup blockers allow it: nothing may be awaited first.
  $('filmShareX').addEventListener('click', async () => {
    if (!result) return;
    const res = result, exp = modules.exp;
    const out = await shareToX(() => res.blob, {
      filename: `${fileBase()}.${res.ext}`, kind: 'video', mime: res.mimeType,
      download: exp.downloadBlob, canShare: exp.canShareFiles,
    });
    if (out === 'intent') {
      $('filmXNote').hidden = false;
      toast('Video saved. Attach it to your post on X.');
    } else if (out === 'blocked' || out === 'saved') {
      // no X tab could open inside that click (popup blocked, or the share sheet failed after
      // it): the video is saved, and a fresh tap on the toast opens the post
      $('filmXNote').hidden = false;
      toast('Video saved. Open X to post it.', { action: { label: 'Open X', run: () => openXIntent('video') } });
    }
  });
  const close = () => { abort?.abort(); stopPreview(); clearResult(); dlg.close(); };
  $('filmClose').addEventListener('click', close);
  dlg.querySelector('[data-close]').addEventListener('click', close);
  dlg.addEventListener('cancel', e => {
    // Escape while filming stops the take instead of silently closing
    if (abort) { e.preventDefault(); abort.abort(); return; }
    stopPreview(); clearResult();
  });
  dlg.addEventListener('close', () => { stopPreview(); stageInUse = false; releaseStageLater(); });

  return { open };
}
