// Cinematic film scene: the sheet (a mipmapped texture from Renderer.renderToTexture) lying on a
// premium desk (js/desks.js: marble, travertine, limewash, velvet, leather, sunlit concrete, onyx),
// shot through a perspective camera with shallow depth of field, a warm window key light, a
// filmic tone curve, a vignette and fine static grain. The desk is baked once per GL context into
// textures; the shader adds what depends on the view and on time: the polished stones' reflection
// of the window (it glides as the camera moves), velvet's grazing sheen, onyx's glow, the palm
// shadows swaying across the sunlit desk and the sheet. It renders in the paper renderer's own
// WebGL2 context, so the sheet never leaves the GPU, into that renderer's canvas; the film
// composer copies the canvas into the encoder's 2D canvas and draws the tool sprite on top.
//
// World units: the sheet is 1 wide, centred on the origin, lying on the desk plane h = 0;
// x runs right, y down the sheet (toward the person at the desk), h up out of the desk.
// A camera is { tx, ty, zoom, pitch, yaw, roll, fx, fy } (radians): it looks at the target
// (tx, ty) from a distance set by zoom (1 = the final full-sheet framing), tilted by pitch toward
// the viewer's side of the desk, turned by yaw about the vertical and rolled about its own axis;
// (fx, fy) is the point in focus.
// Direction: shotIntent() says what each kind of drawing wants from the camera, planPace() times
// the pen to the shot (slow while the camera is close, then a steady ramp to timelapse speed) and
// planCamera() turns both into one smooth track for the whole film.

import { deskById, DeskBake, warmDesk, deskCompiled } from './desks.js';

const DEG = Math.PI / 180;
export const FOV_SHORT = 32 * DEG;     // field of view across the frame's short side (a ~60 mm look)
const APERTURE = 0.055;                // lens aperture, sheet widths: depth of field at the close-up
const COC_MAX = 0.024;                 // largest blur radius, fraction of the frame's short side
const TAPS = 12;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const smoother = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };

// ---------------------------------------------------------------------------------- camera maths
/**
 * Camera basis for a frame of W x H px whose final framing shows the sheet `side` px wide.
 * Returns { C, r, d, f, F, W, H } — position, screen-right, screen-down and forward unit vectors,
 * focal length in px. Pure maths, shared by the shader uniforms and project(), so the tool sprite
 * lands exactly where the shader draws the line.
 */
export function cameraBasis(cam, W, H, side) {
  const F = (Math.min(W, H) / 2) / Math.tan(FOV_SHORT / 2);
  const dist = F / (side * Math.max(1e-3, cam.zoom));
  const sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch);
  const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw);
  const sr = Math.sin(cam.roll), cr = Math.cos(cam.roll);
  // pitch 0 looks straight down; yaw turns the whole rig about the target's vertical
  const off = [-sy * sp, cy * sp, cp];
  const r0 = [cy, sy, 0];
  const d0 = [-sy * cp, cy * cp, -sp];
  const f = [sy * sp, -cy * sp, -cp];
  const r = [r0[0] * cr + d0[0] * sr, r0[1] * cr + d0[1] * sr, r0[2] * cr + d0[2] * sr];
  const d = [d0[0] * cr - r0[0] * sr, d0[1] * cr - r0[1] * sr, d0[2] * cr - r0[2] * sr];
  const C = [cam.tx + off[0] * dist, cam.ty + off[1] * dist, off[2] * dist];
  return { C, r, d, f, F, W, H, dist };
}

/** World point (x, y, h = 0) -> [screen x, screen y (down), depth]. */
export function project(b, x, y, h = 0) {
  const qx = x - b.C[0], qy = y - b.C[1], qz = h - b.C[2];
  const z = qx * b.f[0] + qy * b.f[1] + qz * b.f[2];
  const u = qx * b.r[0] + qy * b.r[1] + qz * b.r[2];
  const v = qx * b.d[0] + qy * b.d[1] + qz * b.d[2];
  return [b.W / 2 + b.F * u / z, b.H / 2 + b.F * v / z, z];
}

/**
 * Screen point -> the desk point under it [x, y, depth] (the shader's own ray), or null above the
 * horizon.
 */
export function unproject(b, sx, sy) {
  const u = (sx - b.W / 2) / b.F, v = (sy - b.H / 2) / b.F;
  const d = [0, 1, 2].map(k => b.f[k] + b.r[k] * u + b.d[k] * v);
  if (d[2] >= -1e-6) return null;
  const t = -b.C[2] / d[2];
  return [b.C[0] + d[0] * t, b.C[1] + d[1] * t, t];
}

/**
 * The on-screen similarity (uniform scale + rotation) of the desk plane at world (x, y): the tool
 * sprite is drawn through it, so it grows with perspective and turns with yaw and roll without
 * being sheared. Returns [a, b, c, d, e, f] for ctx.setTransform (1 world unit -> px).
 */
export function planeTransform(b, x, y) {
  const e = 1e-3;
  const p = project(b, x, y), px = project(b, x + e, y), py = project(b, x, y + e);
  const a = (px[0] - p[0]) / e, bb = (px[1] - p[1]) / e, c = (py[0] - p[0]) / e, d = (py[1] - p[1]) / e;
  const s = Math.sqrt(Math.abs(a * d - bb * c));
  const th = Math.atan2(bb - c, a + d);
  return [s * Math.cos(th), s * Math.sin(th), -s * Math.sin(th), s * Math.cos(th), p[0], p[1]];
}

/**
 * The thin lens of the scene shader: blur radius (px) of a world point (x, y, height h) when the
 * camera focuses on world point `focus`. The tool sprite uses it too, so the raised end of the pen
 * is exactly as soft as the paper at that distance would be.
 */
export function lens(b, focus = [0, 0]) {
  const zf = project(b, focus[0], focus[1])[2];
  // the aperture opens up as the camera backs off (to about 2x at the full sheet), so a tilted
  // wide shot keeps a shallow, filmic focus instead of the deep one a real fixed lens would give
  const zoom = b.F / (b.dist * Math.min(b.W, b.H) * 0.86);
  const K = 0.5 * APERTURE * clamp(Math.pow(2.8 / zoom, 0.6), 1, 2) * b.F / zf;
  const max = COC_MAX * Math.min(b.W, b.H);
  const coc = (x, y, h = 0) => { const z = project(b, x, y, h)[2]; return Math.min(max, K * Math.abs(z - zf) / z); };
  return { zf, K, max, coc };
}

// ---------------------------------------------------------------------------------- direction
// Zero-phase Gaussian smoothing (edges held); sigma in samples, a number or one per sample. The
// whole track is known in advance, so the camera anticipates the pen instead of lagging behind it
// the way a causal spring would.
function gauss(src, sigma) {
  const n = src.length, out = new Float64Array(n);
  const sig = i => (typeof sigma === 'number' ? sigma : sigma[i]);
  for (let i = 0; i < n; i++) {
    const sg = sig(i);
    if (!(sg > 0.5)) { out[i] = src[i]; continue; }
    const R = Math.ceil(sg * 3), inv = -0.5 / (sg * sg);
    let s = 0, ws = 0;
    for (let k = -R; k <= R; k++) { const w = Math.exp(k * k * inv); s += src[clamp(i + k, 0, n - 1)] * w; ws += w; }
    out[i] = s / ws;
  }
  return out;
}
// running minimum over +-R samples (a number or one per sample): smoothing an eroded limit keeps
// the result under the limit
function erode(src, R) {
  const n = src.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = typeof R === 'number' ? R : R[i];
    let m = Infinity;
    for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) m = Math.min(m, src[k]);
    out[i] = m;
  }
  return out;
}
// smooth minimum: below both, with no corner where one takes over from the other
const softmin = (a, b) => Math.pow(Math.pow(a, -4) + Math.pow(b, -4), -0.25);
const lerpAt = (arr, p) => {
  const K = arr.length;
  if (K < 2) return arr[0] || 0;
  const f = clamp(p, 0, 1) * (K - 1), i = Math.min(K - 2, Math.floor(f));
  return mix(arr[i], arr[i + 1], f - i);
};

// Shot sizes (zoom 1 = the final full-sheet framing).
export const SHOT = {
  center: { close: 2.8, pull: 1.3 },
  edge: { close: 2.2 },
  // the close-up holds for `hold` s after touchdown, then eases out over `ease` s to the roaming
  // medium shot
  follow: { close: 2.3, mid: 1.45, hold: 0.8, ease: 1.7 },
};
// The macro opening: zoom, how long it holds after touchdown, how long the pull-back takes, and
// how much lower the camera looks along the paper (raking the tooth).
export const MACRO = { zoom: 5.5, hold: 0.9, ease: 1.5, pitch: 30 * DEG };

/**
 * What the director wants from each kind of drawing, before any smoothing: the zoom at time t
 * with the pen at progress p. planPace() and planCamera() both read it, so the pen is slowed
 * exactly where the camera is close.
 *   center  spiral from the centre: an extreme close-up of the first coils, pulled back just fast
 *           enough to keep the growing disc (and so the pen) in frame
 *   edge    spiral from the rim: opens on the whole rim, low and wide, and pushes in steadily as
 *           the line closes on the centre, as far as the rest of the spiral still fits
 *   follow  maze, wander, contour: a close-up on the pen landing, then an ease out to a roaming
 *           medium shot over the region being filled
 * o = { mode, t0, t1, art: { x, y, r }, frame: { W, H, side, cx, cy }, safe: [x0, y0, x1, y1],
 *       path: { x, y } world pen positions at progress k / (K - 1) (optional) }
 */
export function shotIntent(o) {
  const { W, H, side, cx, cy } = o.frame;
  const { art, mode, t0, t1 } = o;
  const D = Math.max(1e-3, t1 - t0);
  const fin = { tx: (W / 2 - cx) / side, ty: (H / 2 - cy) / side };   // target of the final framing
  const acx = W / 2 + (art.x - fin.tx) * side, acy = H / 2 + (art.y - fin.ty) * side;
  const [sx0, sy0, sx1, sy1] = o.safe;
  const half = Math.min(acx - sx0 * W, sx1 * W - acx, acy - sy0 * H, sy1 * H - acy);
  // largest zoom that keeps a disc of radius r about the art centre inside the safe box, where the
  // final framing puts the art (0.9 leaves room for the tilt, which magnifies the near side)
  const fitR = r => (r > 1e-6 ? 0.9 * half / (r * side) : Infinity);
  // centre: how far out the drawing reaches so far; edge: how far out the pen will still go
  const px = o.path?.x, py = o.path?.y, K = px ? px.length : 0;
  const reach = new Float64Array(Math.max(1, K));
  if (K) {
    let m = 0;
    if (mode === 'edge') for (let k = K - 1; k >= 0; k--) { m = Math.max(m, Math.hypot(px[k] - art.x, py[k] - art.y)); reach[k] = m; }
    else for (let k = 0; k < K; k++) { m = Math.max(m, Math.hypot(px[k] - art.x, py[k] - art.y)); reach[k] = m; }
  } else reach[0] = art.r;
  const F = SHOT.follow;
  const tHold = t0 + F.hold, tMid = tHold + F.ease;
  let zoomAt, zclose;
  if (mode === 'center') {
    zclose = SHOT.center.close;
    // A slow push-in while the pen comes down (the shot is alive from its first frame), the
    // close-up while the pen draws at real speed, then a pull-back that starts as time speeds up:
    // the fast part of the drawing is never filmed from close (at a given pace the rings turn just
    // as fast, but the pen crosses fewer pixels per frame). The disc must also always fit.
    const tPull = t0 + 1.2, pullFor = clamp(0.3 * D, 2.8, 8);
    zoomAt = (t, p) => {
      const zt = Math.exp(mix(Math.log(zclose * (0.92 + 0.08 * smooth(0, t0 + 0.5, t))), Math.log(SHOT.center.pull), smoother(tPull, tPull + pullFor, t)));
      return Math.max(1, softmin(zt, fitR(lerpAt(reach, p))));
    };
  } else if (mode === 'edge') {
    zclose = SHOT.edge.close;
    // constant rate in log zoom, held back while the rim is still to be drawn
    zoomAt = (t, p) => Math.max(1, softmin(Math.exp(Math.log(zclose) * clamp((t - t0) / D, 0, 1)), fitR(lerpAt(reach, p))));
  } else {
    zclose = F.close;
    // the roaming medium shot breathes: a slow push-in and back (+-5% over ~9 s), so the long middle
    // of a maze is never a locked-off shot even where the pen stays in one region
    const breathe = t => 1 + 0.05 * smooth(tMid, tMid + 1.5, t) * Math.sin(2 * Math.PI * (t - tMid) / 9);
    zoomAt = t => (t < tHold ? zclose * (0.95 + 0.05 * smooth(0, tHold, t))
      : Math.exp(mix(Math.log(zclose), Math.log(F.mid), smoother(tHold, tMid, t))) * breathe(t));
  }
  // The macro opening (o.macro): the film opens on the nib itself, ~5.5x the full-sheet framing (a
  // field some 45 mm across, where the paper's tooth and the ink taking to it are plain to see),
  // holds while the pen lands and lays its first millimetres at real speed, then pulls back
  // continuously into the shot above. baseZoomAt is the shot without it (planCamera blends the
  // macro over its smoothed track); zoomAt, with it, paces the pen.
  const baseZoomAt = zoomAt;
  const M = o.macro ? { ...MACRO, ...(typeof o.macro === 'object' ? o.macro : {}) } : null;
  const tM0 = t0 + (M ? M.hold : 0), tM1 = tM0 + (M ? M.ease : 0);
  const macroW = t => (M ? 1 - smoother(tM0, tM1, t) : 0);
  if (M) zoomAt = (t, p) => { const w = macroW(t), z = baseZoomAt(t, p); return w > 0 ? Math.exp(mix(Math.log(z), Math.log(M.zoom), w)) : z; };
  return { mode, zoomAt, baseZoomAt, macroW, macro: M, tM0, tM1, fitR, fin, acx, acy, t0, t1, tHold, tMid, zclose, zmid: F.mid };
}

/**
 * Pace the drawing for the camera: the pen's progress p (0..1 along the pacing table) as a function
 * of time over [t0, t1]. The pen lands at rest, draws at close to real speed while the shot is
 * tight (v0 ~ 12 px per frame at 60 fps, about 5 cm/s on an A4 sheet), then speeds up steadily —
 * doubling every 0.3 s, which reads as one continuous ramp — and slows to a stop at t1. Speed is
 * capped ON SCREEN (zoom x world speed), so the cap follows the shot; in tight shots it also
 * plateaus (vp) so a ring takes at least ~20 frames. Whatever time the slow opening costs is made
 * up by the rest of the drawing. A dense spiral cannot afford all of that in a short film (the
 * close-up alone holds a fifth of the line), so when the rest would have to run faster than
 * `kmax` x the plain timelapse rate the caps give way in order: the plateau only applies in ever
 * tighter shots, then the real-speed opening gets shorter.
 * Speeds are in final-frame sheet widths (`side`) per second, so the pace is the same at any output
 * size: the dialog preview and the encode match.
 * Spirals also cap how fast the pen turns (T given): at least `nt` frames per turn (at 60 fps)
 * while the shot is tight and `na` in any shot, since a pen that goes round in a couple of frames
 * strobes however it is blurred. At a plain timelapse pace the inner rings would turn several
 * times faster than the outer ones; these caps even that out, which is also what keeps them
 * affordable. They give way first, in steps, when the film is short.
 * o = { t0, t1, S: Float64Array world arc length of the line at progress k / (K - 1),
 *       T: Float64Array turns at the same progress (spirals; optional),
 *       zoomAt(t, p) (shotIntent), hz = 120, easeOut = 0.9, v0, slow, vp, zp, nt, na, ztp, kmax }
 * Returns { at(t) -> p, c, cFree, ratio, caps }.
 */
export function planPace(o) {
  const hz = o.hz || 120;
  const t0 = o.t0, t1 = o.t1, D = Math.max(1e-3, t1 - t0);
  const S = o.S, K = S.length;
  // world length of line per unit of progress (dark passages dwell: the pen is slower there)
  const dS = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    const a = Math.max(0, k - 1), b = Math.min(K - 1, k + 1);
    dS[k] = Math.max(1e-9, (S[b] - S[a]) * (K - 1) / Math.max(1, b - a));
  }
  const slopeS = gauss(dS, 1.5);
  let slopeT = null;
  if (o.T) {
    const T = o.T, dT = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      const a = Math.max(0, k - 1), b = Math.min(K - 1, k + 1);
      dT[k] = Math.max(1e-9, Math.abs(T[b] - T[a]) * (K - 1) / Math.max(1, b - a));
    }
    slopeT = gauss(dT, 1.5);
  }
  const n = Math.max(3, Math.ceil(D * hz) + 1), dt = D / (n - 1);
  const easeOut = Math.min(o.easeOut ?? 0.9, D / 4);
  const ease = new Float64Array(n);
  for (let i = 0; i < n; i++) ease[i] = smooth(D, D - easeOut, i * dt);
  const capRate = (i, p, L) => {
    const s = i * dt;
    let v = L.v0 * smooth(0, L.touch, s);
    if (s > L.slow) v *= Math.pow(2, (s - L.slow) / L.dbl);
    const z = o.zoomAt(t0 + s, p);
    const w = L.zp < 10 ? smooth(L.zp - 0.3, L.zp, z) : 0;
    if (w > 1e-4) v = Math.min(v, L.vp / w);
    let r = v / (z * Math.max(1e-9, lerpAt(slopeS, p)));
    if (slopeT) {
      const nf = Math.max(L.na, L.nt * smooth(L.ztp - 0.3, L.ztp, z));
      if (nf > 0) r = Math.min(r, 60 / nf / lerpAt(slopeT, p));
    }
    return r;
  };
  const run = (c, L, rates) => {
    let p = 0;
    for (let i = 0; i < n - 1; i++) {
      let r = c * ease[i];
      if (L) r = Math.min(r, capRate(i, p, L));
      else r *= smooth(0, 0.5, i * dt);          // no caps: a plain 0.5 s ease-in
      if (rates) rates[i] = r;
      p += r * dt;
    }
    return p;
  };
  const solve = L => {
    let lo = 0, hi = 2 / D;
    while (run(hi, L) < 1) { hi *= 2; if (hi > 1e4 / D) return null; }
    for (let k = 0; k < 32; k++) { const m = 0.5 * (lo + hi); if (run(m, L) < 1) lo = m; else hi = m; }
    return hi;
  };
  const cFree = solve(null);
  const kmax = o.kmax ?? 1.75;
  const L = { v0: o.v0 ?? 0.78, touch: 0.3, slow: o.slow ?? 1.1, dbl: 0.3, vp: o.vp ?? 3.2, zp: o.zp ?? 1.6,
    nt: slopeT ? (o.nt ?? 20) : 0, na: slopeT ? (o.na ?? 6) : 0, ztp: o.ztp ?? 1.6 };
  const NT = [20, 14, 10, 7, 0], NA = [6, 5, 4, 3, 0];
  let c = null, used = null;
  for (let k = 0; k < 32; k++) {
    c = solve(L);
    if (c != null && c <= kmax * cFree) { used = L; break; }
    if (L.nt > L.na) L.nt = NT[NT.indexOf(L.nt) + 1] ?? 0;
    else if (L.na > 0) { L.na = NA[NA.indexOf(L.na) + 1] ?? 0; L.nt = 0; }
    else if (L.zp < 3.2) L.zp += 0.25;
    else { L.slow *= 0.8; L.v0 *= 1.2; if (L.slow < 0.25) break; }
  }
  if (!used) c = cFree;
  const rates = new Float64Array(n);
  run(c, used, rates);
  rates[n - 1] = 0;
  // a very light smoothing of the rate (where one cap hands over to another the pace would kink),
  // shorter than the ~0.1 s a ring takes, or the turn cap would be broken inside every ring
  const sm = gauss(rates, 0.015 * hz);
  const P = new Float64Array(n);
  for (let i = 1; i < n; i++) P[i] = P[i - 1] + 0.5 * (sm[i - 1] + sm[i]) * dt;
  const tot = P[n - 1] || 1;
  for (let i = 0; i < n; i++) P[i] /= tot;
  const at = t => {
    if (t <= t0) return 0;
    if (t >= t1) return 1;
    const f = (t - t0) / dt, i = Math.min(n - 2, Math.floor(f));
    return mix(P[i], P[i + 1], f - i);
  };
  return { at, c: c / tot, cFree, ratio: c / tot / cFree, caps: used ? { ...used } : null };
}

/**
 * Direct a film: a camera track sampled at `hz`, a pure function of the inputs.
 * o = {
 *   length, t0 (pen touches down), t1 (drawing done),
 *   tTake (the final framing starts to take over), tSettle (the shot has arrived on it),
 *   tFinal (exact from here on; after it the camera creeps in slowly to the end, so no frame of
 *   the hold is frozen),
 *   head(t) -> [x, y] world position of the pen tip, progress(t) -> p (planPace),
 *   intent (shotIntent), art: { x, y, r }, frame: { W, H, side, cx, cy }, safe, hz = 60,
 *   sign (optional): { t0, t1 (the name is written), tIn (the camera starts leaning in), tOut (back
 *     on the final framing), box: [x0, y0, x1, y1] the name's ink, world },
 * }
 * Returns { hz, n, at(t) -> camera + focus fx/fy, maxZoom, zmax, track }.
 */
export function planCamera(o) {
  const hz = o.hz || 60;
  const n = Math.max(2, Math.ceil(o.length * hz) + 1);
  const { W, H, side } = o.frame;
  const I = o.intent || shotIntent(o);
  const mode = I.mode, fin = I.fin, art = o.art;
  const progress = o.progress || (t => clamp((t - o.t0) / Math.max(1e-3, o.t1 - o.t0), 0, 1));
  // An anchored target keeps the art circle where the final framing puts it on screen, whatever
  // the zoom (so a story's drawing stays clear of the app UI at the bottom all the way through).
  const anchor = (z, k) => (k === 0 ? art.x - (art.x - fin.tx) / z : art.y - (art.y - fin.ty) / z);
  const [sx0, sy0, sx1, sy1] = o.safe;
  // Largest zoom that keeps a point (dx, dy) world units away from screen point (ox, oy) inside
  // the safe box; 0.9 leaves room for the tilt.
  const room = (ox, oy, dx, dy) => {
    const lx = dx > 1e-9 ? (sx1 * W - ox) / (dx * side) : dx < -1e-9 ? (sx0 * W - ox) / (dx * side) : Infinity;
    const ly = dy > 1e-9 ? (sy1 * H - oy) / (dy * side) : dy < -1e-9 ? (sy0 * H - oy) / (dy * side) : Infinity;
    return 0.9 * Math.min(lx, ly);
  };

  const hx = new Float64Array(n), hy = new Float64Array(n);
  for (let i = 0; i < n; i++) { const [x, y] = o.head(i / hz); hx[i] = x; hy[i] = y; }

  // 1. the shot's zoom, and the final framing taking over as the drawing ends
  const lz = new Float64Array(n), eT = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / hz;
    eT[i] = smoother(o.tTake, o.tSettle, t);
    lz[i] = Math.log(mix((I.baseZoomAt || I.zoomAt)(t, progress(t)), 1, eT[i]));
  }
  const sZ = new Float64Array(n), rZ = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const w = smooth(o.t0 + 0.4, o.t0 + 2.2, i / hz);
    sZ[i] = (mode === 'follow' ? mix(0.2, 0.45, w) : 0.3) * hz;
    rZ[i] = Math.ceil(sZ[i] * 1.6);
  }
  let z = gauss(lz, sZ);
  const closeness = zi => clamp((zi - I.zmid) / (I.zclose - I.zmid), 0, 1);

  // 2. follow: where to look. Close to the pen while it lands and still moves slowly; once it runs
  // at timelapse speed, the pen's position averaged over ~1.2 s, so the camera frames the region
  // being filled and drifts instead of chasing every corridor.
  let tx = null, ty = null;
  if (mode === 'follow') {
    const sig = new Float64Array(n);
    for (let i = 0; i < n; i++) sig[i] = mix(0.25, 1.2, smooth(I.tHold, I.tMid, i / hz)) * hz;
    const gx = gauss(hx, sig), gy = gauss(hy, sig);
    // frame on the sheet: the frame stays inside it, or, when bigger, keeps all of it in view
    const m = 0.03;
    const onSheet = (v, ext) => {
      const a = -0.5 - m + ext / 2, b = 0.5 + m - ext / 2;
      return a <= b ? clamp(v, a, b) : clamp(v, b, a);
    };
    for (let i = 0; i < n; i++) {
      const zi = Math.exp(z[i]), k = zi * side, wc = smooth(0, 1, closeness(zi));
      // composition: in the close-up the tip sits up and left of centre, the pen's body across the
      // frame toward the lower right
      let x = gx[i] + 0.1 * W / k * wc, y = gy[i] + 0.07 * H / k * wc;
      x = mix(onSheet(x, W / k), x, wc);
      y = mix(onSheet(y, H / k), y, wc);
      gx[i] = mix(x, anchor(zi, 0), eT[i]);
      gy[i] = mix(y, anchor(zi, 1), eT[i]);
    }
    tx = gauss(gx, 0.3 * hz); ty = gauss(gy, 0.3 * hz);
    // The safe box applies to the pen averaged over ~0.3 s (the raw tip may dart out of frame for
    // a moment): first the target leans toward it, then, where that is not enough, the shot widens.
    const qx = gauss(hx, 0.3 * hz), qy = gauss(hy, 0.3 * hz);
    const bx0 = (sx0 + 0.03) * W, bx1 = (sx1 - 0.03) * W, by0 = (sy0 + 0.03) * H, by1 = (sy1 - 0.03) * H;
    for (let pass = 0; pass < 4; pass++) {
      const cx = new Float64Array(n), cy = new Float64Array(n);
      let any = false;
      for (let i = 0; i < n; i++) {
        const k = Math.exp(z[i]) * side;
        const sx = W / 2 + (qx[i] - tx[i]) * k, sy = H / 2 + (qy[i] - ty[i]) * k;
        const ex = sx < bx0 ? sx - bx0 : sx > bx1 ? sx - bx1 : 0;
        const ey = sy < by0 ? sy - by0 : sy > by1 ? sy - by1 : 0;
        cx[i] = ex / k * (1 - eT[i]); cy[i] = ey / k * (1 - eT[i]);
        if (ex || ey) any = true;
      }
      if (!any) break;
      const gxc = gauss(cx, 0.35 * hz), gyc = gauss(cy, 0.35 * hz);
      for (let i = 0; i < n; i++) { tx[i] += 1.4 * gxc[i]; ty[i] += 1.4 * gyc[i]; }
    }
  }

  // 3. keep the pen inside the safe box by widening the shot where it would leave. The limit is
  // eroded (running minimum) before smoothing so the smoothed zoom still respects it. Follow mode
  // limits the ~0.3 s average of the pen, the spirals the tip itself (the centre spiral's zoom is
  // already fitted to the disc).
  if (mode !== 'center') {
    const qx = mode === 'follow' ? gauss(hx, 0.3 * hz) : hx, qy = mode === 'follow' ? gauss(hy, 0.3 * hz) : hy;
    for (let pass = 0; pass < 3; pass++) {
      const cap = new Float64Array(n);
      let any = false;
      for (let i = 0; i < n; i++) {
        const zi = Math.exp(z[i]);
        const lim = tx ? room(W / 2, H / 2, qx[i] - tx[i], qy[i] - ty[i]) : room(I.acx, I.acy, qx[i] - art.x, qy[i] - art.y);
        cap[i] = Math.log(Math.max(1, Math.min(zi, lim)));
        if (cap[i] < z[i] - 1e-4) any = true;
      }
      if (!any) break;
      z = gauss(erode(cap, rZ), sZ);
    }
  }

  // a last short pass over everything that moves the frame: the time-varying windows above leave
  // a little residual wobble where they widen, and an eased hand-held move has none
  const sF = 0.16 * hz;
  z = gauss(z, sF);
  if (tx) { tx = gauss(tx, sF); ty = gauss(ty, sF); }

  // 4. the slow creep that follows the arrival on the final framing: from rest (no jolt where the
  // pull-back ends), then at a steady rate to the end of the film, pushing in on the art
  const T = Math.max(1e-3, o.length - o.tFinal);
  const creepAmt = Math.min(0.045, 0.018 * T);
  const creepN = Math.max(2, Math.ceil(T * hz) + 1), creepI = new Float64Array(creepN);
  for (let i = 1; i < creepN; i++) creepI[i] = creepI[i - 1] + smooth(0, 0.8, (i - 0.5) / hz);
  const creep = t => (t <= o.tFinal ? 0 : creepAmt * lerpAt(creepI, (t - o.tFinal) / T) / (creepI[creepN - 1] || 1));

  // 5. derived: target (anchored modes), tilt, turn, roll, focus
  const out = {
    tx: new Float64Array(n), ty: new Float64Array(n), zoom: new Float64Array(n),
    pitch: new Float64Array(n), yaw: new Float64Array(n), roll: new Float64Array(n),
    fx: new Float64Array(n), fy: new Float64Array(n),
  };
  // focus follows the pen, averaged over a lap or so: focus that tracked every ring of the tilted
  // close-up would breathe with it
  const fxS = gauss(hx, 0.35 * hz), fyS = gauss(hy, 0.35 * hz);
  const zmax = I.zclose;
  for (let i = 0; i < n; i++) {
    const t = i / hz;
    const zi = Math.exp(z[i]);
    let tilt;
    if (mode === 'center') tilt = Math.pow(clamp((zi - 1) / (zmax - 1), 0, 1), 0.85);
    // the roaming medium shot keeps about half the close-up's tilt; the edge push-in stays low
    else if (mode === 'follow') tilt = mix(0.45, 1, smooth(0, 1, closeness(zi))) * (1 - eT[i]);
    else tilt = mix(1, 0.75, smooth(o.t0, o.t1, t)) * (1 - eT[i]);
    // exact final framing: the smoothed track is already within a hair of it here
    const e = smoother(o.tSettle, o.tFinal, t);
    const cr = creep(t), zf = 1 + cr;
    out.zoom[i] = mix(zi, zf, e);
    out.tx[i] = mix(tx ? tx[i] : anchor(zi, 0), anchor(zf, 0), e);
    out.ty[i] = mix(ty ? ty[i] : anchor(zi, 1), anchor(zf, 1), e);
    out.pitch[i] = mix(23 * DEG * tilt, 0, e);
    out.yaw[i] = mix(tilt * (-7 + 2.2 * Math.sin(t * 2 * Math.PI / 11)) * DEG, -0.6 * DEG * (cr / (creepAmt || 1)), e);
    out.roll[i] = mix(tilt * 1.1 * DEG, 0, e);
    out.fx[i] = fxS[i]; out.fy[i] = fyS[i];
  }

  // 5b. the macro opening (shotIntent's o.macro), blended over the finished track: the zoom, a
  // lower camera raking the paper, and the nib placed up and left of the frame centre with the
  // pen's body across the frame toward the lower right. It looks at the art's centre for a centre
  // spiral (the first coils turn about it: following the nib would orbit), at the nib otherwise.
  let maxZoomBase = 1;
  if (I.macro) {
    const M = I.macro, k = M.zoom * side;
    const qx = gauss(hx, 0.35 * hz), qy = gauss(hy, 0.35 * hz);
    for (let i = 0; i < n; i++) {
      const w = I.macroW(i / hz);
      if (w <= 0) continue;
      const fx = mode === 'center' ? art.x : qx[i], fy = mode === 'center' ? art.y : qy[i];
      out.zoom[i] = Math.exp(mix(Math.log(out.zoom[i]), Math.log(M.zoom), w));
      out.tx[i] = mix(out.tx[i], fx + 0.1 * W / k, w);
      out.ty[i] = mix(out.ty[i], fy + 0.07 * H / k, w);
      out.pitch[i] = mix(out.pitch[i], M.pitch, w);
    }
  }

  // 6. the signing shot (o.sign): while the pen writes the name in the sheet's corner, the camera
  // leans in over that corner, tilted a little, so the name is legible as it appears, with the edge
  // of the drawing in the frame; it is back on the final framing by tOut (<= tFinal).
  if (o.sign) {
    const S = o.sign, [bx0, by0, bx1, by1] = S.box;
    const cx = 0.5 * (bx0 + bx1), cy = 0.5 * (by0 + by1), sw = Math.max(0.05, bx1 - bx0);
    const zs = clamp(0.42 * W / (sw * side), 1.35, 2.2);
    // aim a little toward the art: the corner of the drawing, being signed
    const ax = cx + (art.x - cx) * 0.18, ay = cy + (art.y - cy) * 0.12;
    const inEnd = Math.max(S.tIn + 0.3, S.t0 + 0.05), outStart = Math.max(S.t1 - 0.05, inEnd);
    const outEnd = Math.min(o.tFinal, Math.max(outStart + 0.3, S.tOut));
    for (let i = 0; i < n; i++) {
      const t = i / hz;
      const w = smoother(S.tIn, inEnd, t) * (1 - smoother(outStart, outEnd, t));
      if (w <= 0) continue;
      const push = 1 + 0.04 * smooth(S.t0, S.t1 + 0.5, t);          // a slow push while it is written
      const z0 = out.zoom[i], z = Math.exp(mix(Math.log(z0), Math.log(zs * push), w));
      // a move toward the corner, not a zoom into the middle of the sheet and a pan: the corner's
      // offset from the frame centre shrinks steadily on screen (by 1 - w) as the zoom grows
      const k = (1 - w) * z0 / z;
      out.zoom[i] = z;
      out.tx[i] = ax - (ax - out.tx[i]) * k; out.ty[i] = ay - (ay - out.ty[i]) * k;
      out.pitch[i] = mix(out.pitch[i], 10 * DEG, w);
      out.yaw[i] = mix(out.yaw[i], -3.5 * DEG, w);
      out.roll[i] = mix(out.roll[i], 0.5 * DEG, w);
    }
  }
  let maxZoom = 1;
  for (let i = 0; i < n; i++) {
    const z = out.zoom[i] * (1 + 0.45 * Math.sin(out.pitch[i]));
    maxZoom = Math.max(maxZoom, z);
    // (the sheet texture's budget: the macro is rendered at its own density, renderToTexture's rect)
    if (!I.macro || I.macroW(i / hz) < 0.02) maxZoomBase = Math.max(maxZoomBase, z);
  }

  const at = t => {
    const f = clamp(t * hz, 0, n - 1), i = Math.min(n - 2, Math.floor(f)), k = f - i;
    const g = key => out[key][i] + (out[key][i + 1] - out[key][i]) * k;
    return { tx: g('tx'), ty: g('ty'), zoom: g('zoom'), pitch: g('pitch'), yaw: g('yaw'), roll: g('roll'), fx: g('fx'), fy: g('fy') };
  };
  return { hz, n, at, maxZoom, maxZoomBase, zmax, track: out, restAt: o.tFinal,
    macroW: I.macro ? I.macroW : () => 0, tMacroEnd: I.macro ? I.tM1 : 0 };
}

// ---------------------------------------------------------------------------------- GLSL
const VERT = /* glsl */`#version 300 es
precision highp float;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HASH = /* glsl */`
uint hashU(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return v.x ^ v.y;
}
float hashI(ivec2 i) { return float(hashU(uvec2(i + 65536))) * (1.0 / 4294967295.0); }
`;

const FRAG_SCENE = /* glsl */`#version 300 es
precision highp float;
precision highp int;
out vec4 frag;
uniform vec2 uRes;
uniform vec3 uCam, uRight, uDown, uFwd;
uniform float uFocal;
uniform sampler2D uSheet;
uniform sampler2D uDesk;      // baked desk (desks.js): sRGB albedo with its relief lit, gloss in alpha
uniform sampler2D uDeskAux;   // r sunlight through the fronds, g velvet sheen, b onyx glow
uniform float uDeskPeriod;
uniform float uDeskGain;      // the desk's exposure against the sheet
uniform float uRefl;          // strength of the polished surface's reflection of the window
uniform int uSun;             // sunlit desk: the leaf shadows fall on the desk and the sheet
uniform float uTime;
uniform vec3 uWinDir, uWinU, uWinV;   // the window the polished desks reflect (direction, axes)
uniform sampler2D uPola;
uniform int uPolaOn;
uniform vec2 uPolaC, uPolaAx, uPolaHalf;
uniform sampler2D uPhoto;
uniform sampler2D uOrder;   // drawing order over the art square (0 first .. 1 last, equalised by area)
uniform vec2 uWipe;         // reveal: the photo floods in (x) and the drawing returns (y), both in drawing order
uniform vec3 uArt;          // x, y, r (world)
uniform int uArtSquare;
uniform float uHalo, uHaloLod, uHaloT;
uniform float uCocK, uFocus, uCocMax;
uniform sampler2D uMacro;   // the macro opening: part of the same sheet rendered at a higher density
uniform vec4 uMacroRect;    // its coverage, world x0, y0, x1, y1
uniform float uMacroW;      // how much it replaces the sheet texture (0 = not in use)
uniform vec2 uPool;         // centre of the window light on the desk
uniform float uPoolR;
uniform vec3 uKey, uAmb;
uniform vec2 uShadow;       // cast-shadow offset on the desk (away from the window)
uniform float uShadowAmt;
uniform float uExposure;
${HASH}
const int N = ${TAPS};
vec3 toLin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }

float rectSD(vec2 p, vec2 half_) { vec2 d = abs(p) - half_; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }

// shadow of the sheet on the desk: a tight contact line and a soft cast shadow toward the lower
// right (the paper never lies perfectly flat, so it throws a soft shadow a few mm wide)
float sheetShadow(vec2 P) {
  float d0 = rectSD(P, vec2(0.5));
  float d1 = rectSD(P - uShadow, vec2(0.5));
  return (1.0 - 0.32 * uShadowAmt * (1.0 - smoothstep(0.0, 0.005, d0)))
       * (1.0 - 0.42 * uShadowAmt * (1.0 - smoothstep(-0.03, 0.05, d1)));
}
// shadow of the taped photo, on the desk or on the sheet (it lies on top of both)
float polaShadow(vec2 P) {
  if (uPolaOn == 0) return 1.0;
  vec2 l = P - uPolaC - uShadow * 1.2;
  l = vec2(dot(l, uPolaAx), dot(l, vec2(-uPolaAx.y, uPolaAx.x)));
  float dp = rectSD(l, uPolaHalf * vec2(0.84, 0.8));
  return 1.0 - 0.3 * uShadowAmt * (1.0 - smoothstep(-0.01, 0.025, dp));
}

// Sunlight through palm fronds (sunlit desk): the baked mask, gently warped over time as the
// fronds sway (slow, smooth, a few millimetres). 1 = in the sun.
float sunAt(vec2 P, vec2 gx, vec2 gy) {
  if (uSun == 0) return 1.0;
  vec2 w = vec2(sin(uTime * 0.83 + P.y * 2.1) + 0.5 * sin(uTime * 1.37 + P.x * 3.3),
                cos(uTime * 0.71 + P.x * 1.7) + 0.5 * cos(uTime * 1.19 + P.y * 2.9));
  return textureGrad(uDeskAux, (P + 0.01 * w) / uDeskPeriod, gx / uDeskPeriod, gy / uDeskPeriod).r;
}

// the window's light pool: the sheet falls off about half a stop from its lit corner to the far
// one. In the sun the key is warm and the leaf shadows are cool (lit by the blue sky).
vec3 lightAt(vec2 P, float sun) {
  vec2 q = (P - uPool) / uPoolR;
  float pool = 0.45 + 0.55 * exp(-dot(q, q));
  if (uSun == 0) return uAmb + uKey * pool;
  return uAmb * vec3(0.92, 0.98, 1.12) + uKey * pool * mix(vec3(0.42, 0.47, 0.6), vec3(1.2, 1.06, 0.86), sun);
}

// What a polished desk mirrors: a large softbox-like window up and to the far left (the side the
// key light comes from) with a mullion cross, in a dim room. rough widens the reflection's lobe:
// the window's edges and bars soften and its brightness spreads out.
vec3 envAt(vec3 R, float rough) {
  vec3 room = vec3(0.03, 0.032, 0.036) * (0.5 + 0.8 * max(R.z, 0.0));
  float t = dot(R, uWinDir);
  if (t <= 0.05) return room;
  vec2 uv = vec2(dot(R, uWinU), dot(R, uWinV)) / t;
  float s = 0.012 + 0.7 * rough * rough;
  const vec2 A = vec2(0.46, 0.34);
  float win = (1.0 - smoothstep(A.x - s, A.x + s, abs(uv.x))) * (1.0 - smoothstep(A.y - s, A.y + s, abs(uv.y)));
  const float b = 0.016;
  float wb = max(b, s);
  float bars = min(1.0, b / s) * max(1.0 - smoothstep(wb - 0.5 * s, wb + 0.5 * s, abs(uv.x)),
                                     1.0 - smoothstep(wb - 0.5 * s, wb + 0.5 * s, abs(uv.y)));
  float spread = (A.x * A.y) / ((A.x + s) * (A.y + s));
  // brighter toward the top of the window (sky), a little warm
  vec3 L = vec3(1.0, 0.97, 0.93) * 3.2 * (1.0 + 0.25 * clamp(uv.y / A.y, -1.0, 1.0));
  return room + L * win * (1.0 - 0.92 * bars) * spread;
}

// Halation: the bright parts of the sheet (paper, neon, a gold glint) scatter a warm glow into
// their surroundings, as light does in film emulsion. From two coarse mips of the sheet, so it is
// a soft bloom a few millimetres wide that also spills a little onto the desk at the sheet's edge.
vec3 halation(vec2 P) {
  vec2 uv = clamp(vec2(P.x + 0.5, 0.5 - P.y), vec2(0.0), vec2(1.0));
  float outside = max(max(abs(P.x), abs(P.y)) - 0.5, 0.0);
  vec3 h = 0.5 * (toLin(textureLod(uSheet, uv, uHaloLod).rgb) + toLin(textureLod(uSheet, uv, uHaloLod + 2.0).rgb));
  float m = max(h.r, max(h.g, h.b));
  // a line that is itself a light (neon) blooms in its own colour even where it is thin (its mip
  // is mostly dark paper); paper and gold only where they are bright, with film's warm cast.
  // Off the sheet only a thin fringe: a wider one reads as a light box on a dark desk.
  vec3 tint = mix(vec3(1.0, 0.72, 0.5), vec3(1.0), smoothstep(0.3, 0.1, uHaloT));
  return h * smoothstep(uHaloT, 2.0 * uHaloT, m) * tint * (outside > 0.0 ? 0.6 * exp(-outside / 0.005) : 1.0);
}

// scene colour (linear) at desk point P seen along ray v; gx, gy = its screen-space gradients
// (texture footprint)
vec3 shade(vec2 P, vec2 gx, vec2 gy, vec3 v) {
  float fp = max(max(length(gx), length(gy)), 1e-6);
  vec3 col = vec3(0.0);
  float sd = max(abs(P.x), abs(P.y)) - 0.5;
  float m = clamp(0.5 - sd / fp, 0.0, 1.0);
  vec3 light = lightAt(P, sunAt(P, gx, gy));
  if (m < 1.0) {
    vec2 tu = P / uDeskPeriod, tx = gx / uDeskPeriod, ty = gy / uDeskPeriod;
    vec4 a = textureGrad(uDesk, tu, tx, ty);
    vec3 aux = textureGrad(uDeskAux, tu, tx, ty).rgb;
    vec3 alb = toLin(a.rgb) * uDeskGain;
    float cosv = clamp(-v.z, 0.0, 1.0);
    float sh = sheetShadow(P);
    // diffuse, and velvet's sheen: the pile catches the light, more at grazing angles
    col = (alb + aux.g * vec3(0.07, 0.3, 0.2) * (0.5 + 1.8 * (1.0 - cosv) * (1.0 - cosv))) * sh * light;
    // the clear coat of polished stone mirrors the window (Fresnel, F0 a little above glass for
    // the product-shot look); it glides over the stone as the camera moves
    if (a.a > 0.12) {
      float F = 0.05 + 0.95 * pow(1.0 - cosv, 5.0);
      col += uRefl * smoothstep(0.12, 0.6, a.a) * F * envAt(vec3(v.xy, -v.z), 1.0 - a.a);
    }
    // backlit onyx glows from within, whatever the light on it
    col += alb * aux.b * 1.1;
  }
  if (m > 0.0) {
    // texture v runs up the sheet (the renderer's framebuffer is bottom-up)
    vec2 uv = vec2(P.x + 0.5, 0.5 - P.y);
    vec3 s = toLin(textureGrad(uSheet, uv, vec2(gx.x, -gx.y), vec2(gy.x, -gy.y)).rgb);
    if (uMacroW > 0.0) {
      // the macro's own rendering of this spot (the very same paper and ink, finer), faded in over
      // the outer 6% of its rectangle so no seam shows where it hands over to the sheet texture
      vec2 ext = uMacroRect.zw - uMacroRect.xy;
      vec2 q = (P - uMacroRect.xy) / ext;
      vec2 eq = min(q, 1.0 - q);
      float inR = clamp(min(eq.x, eq.y) / 0.06, 0.0, 1.0);
      if (inR > 0.0) {
        vec2 sc = 1.0 / ext;
        vec3 mc = toLin(textureGrad(uMacro, vec2(q.x, 1.0 - q.y), vec2(gx.x, -gx.y) * sc, vec2(gy.x, -gy.y) * sc).rgb);
        s = mix(s, mc, inR * uMacroW);
      }
    }
    // the paper's cut edge: its thickness catches the window light on the sides that face it (a
    // hairline that separates a black card from a black desk)
    vec2 en = abs(P.x) > abs(P.y) ? vec2(sign(P.x), 0.0) : vec2(0.0, sign(P.y));
    s += 0.1 * clamp(dot(en, vec2(-0.646, -0.763)), 0.0, 1.0) * (1.0 - smoothstep(0.0, 0.0016 + fp, -sd));
    if (uWipe.x > 0.0) {
      vec2 a = (P - uArt.xy) / uArt.z;
      float inside = uArtSquare == 1 ? max(abs(a.x), abs(a.y)) : length(a);
      float mask = clamp((1.0 - inside) * uArt.z / fp + 0.5, 0.0, 1.0);
      if (mask > 0.0) {
        vec2 puv = a * 0.5 + 0.5;
        vec2 psc = vec2(0.5 / uArt.z);
        // the wipe retraces the drawing: the photo spreads in the order the line was drawn, then
        // the line comes back the same way (soft front, 8% of the area wide)
        float ord = textureLod(uOrder, puv, 0.0).r;
        const float SOFT = 0.08;
        float w = clamp((uWipe.x * (1.0 + SOFT) - ord) / SOFT, 0.0, 1.0)
                * (1.0 - clamp((uWipe.y * (1.0 + SOFT) - ord) / SOFT, 0.0, 1.0));
        if (w > 0.0) {
          vec4 pc = textureGrad(uPhoto, puv, gx * psc, gy * psc);
          vec3 c = pc.a > 1e-3 ? toLin(pc.rgb / pc.a) : s;
          s = mix(s, c, w * mask * pc.a);
        }
      }
    }
    col = mix(col, s * light, m);
  }
  if (uPolaOn == 1) {
    // the taped photo lies on top of the desk and of the sheet's corner, as in the flat film
    col *= polaShadow(P);
    vec2 l = P - uPolaC;
    vec2 ax = uPolaAx, ay = vec2(-uPolaAx.y, uPolaAx.x);
    vec2 uv = vec2(dot(l, ax), dot(l, ay)) / (2.0 * uPolaHalf) + 0.5;
    if (all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) {
      vec2 sc = 1.0 / (2.0 * uPolaHalf);
      vec4 pc = textureGrad(uPola, uv, vec2(dot(gx, ax), dot(gx, ay)) * sc, vec2(dot(gy, ax), dot(gy, ay)) * sc);
      vec3 c = pc.a > 1e-3 ? toLin(pc.rgb / pc.a) : vec3(0.0);
      col = mix(col, c * light, pc.a);
    }
  }
  return col;
}

vec2 hitDesk(vec2 s, out float depth, out vec3 dir) {
  dir = uFwd + uRight * ((s.x - 0.5 * uRes.x) / uFocal) + uDown * ((s.y - 0.5 * uRes.y) / uFocal);
  float t = -uCam.z / dir.z;
  depth = t;
  return uCam.xy + dir.xy * t;
}

void main() {
  vec2 s = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  float depth;
  vec3 dir;
  vec2 P = hitDesk(s, depth, dir);
  // footprint of one pixel on the desk (gl_FragCoord.y runs up, so dFdy is negated)
  vec2 gx = dFdx(P), gy = -dFdy(P);
  float coc = min(uCocMax, uCocK * abs(depth - uFocus) / depth);
  // In focus: one sample. Out of focus: gather over the circle of confusion, taps on a
  // golden-angle disc, each prefiltered by the mip level of its share of the disc, so the blur is
  // round and smooth (no box artefacts). The pattern is the same for every pixel: a per-pixel
  // twist would crawl as the camera moves. One loop for both, with a bound the compiler cannot
  // unroll, so shade() is compiled once rather than thirteen times (it made the program take
  // most of a second to compile on D3D).
  bool blur = coc >= 0.6;
  int n = blur ? N : 1;
  float k = blur ? max(1.0, coc * 1.8 / sqrt(float(N))) : 1.0;
  vec3 col = vec3(0.0);
  for (int i = 0; i < n; i++) {
    float a = float(i) * 2.39996323;
    vec2 o = blur ? vec2(cos(a), sin(a)) * sqrt((float(i) + 0.5) / float(N)) * coc : vec2(0.0);
    float dd;
    vec3 di;
    vec2 Q = hitDesk(s + o, dd, di);
    col += shade(Q, gx * k, gy * k, normalize(di));
  }
  col /= float(n);
  col += uHalo * halation(P) * lightAt(P, sunAt(P, gx, gy));
  // exposure, a gentle filmic shoulder and toe, vignette, static grain
  col *= uExposure;
  vec3 aces = col * (2.51 * col + 0.03) / (col * (2.43 * col + 0.59) + 0.14);
  col = mix(col, aces, 0.55);
  vec2 vg = (s - 0.5 * uRes) / (0.5 * length(uRes));
  col *= 1.0 - 0.34 * pow(smoothstep(0.3, 1.05, length(vg)), 1.4);
  vec3 outc = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  outc = outc * 0.985 + vec3(0.012, 0.009, 0.006);             // film base: blacks lift a hair, warm
  outc += (hashI(ivec2(s) + 911) - 0.5) * (2.2 / 255.0);
  frag = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`;

// ---------------------------------------------------------------------------------- desks
// How each desk sits in the shot: exposure against the sheet (the light stones are brighter than
// cream paper as baked; a real product shot keeps the subject the brightest thing in frame), how
// strongly its clear coat mirrors the window, and how dark the sheet's shadow falls on it.
const DESK_LOOK = {
  nero: { gain: 1.0, refl: 1.0, shadow: 1.0 },
  calacatta: { gain: 0.74, refl: 0.9, shadow: 1.25 },
  travertine: { gain: 0.72, refl: 0.8, shadow: 1.25 },
  limewash: { gain: 0.74, refl: 0, shadow: 1.2 },
  velvet: { gain: 1.0, refl: 0, shadow: 1.0 },
  leather: { gain: 1.0, refl: 0.9, shadow: 1.0 },
  sunlit: { gain: 0.76, refl: 0, shadow: 1.2 },
  onyx: { gain: 0.8, refl: 0.9, shadow: 1.15 },
};
// the mean colour (sRGB) and gloss of each baked desk: the stand-in while it bakes
const DESK_MEAN = {
  nero: [51, 51, 53, 242], calacatta: [244, 243, 240, 204], travertine: [235, 225, 209, 56],
  limewash: [226, 220, 213, 0], velvet: [33, 98, 80, 0], leather: [63, 60, 59, 102],
  sunlit: [217, 214, 209, 20], onyx: [222, 186, 138, 229],
};
// the window the polished desks mirror: up and to the far left, about 50 degrees high
const WIN = (() => {
  const n = v => { const l = Math.hypot(...v); return v.map(c => c / l); };
  const D = n([-0.45, -0.6, 0.9]);
  const U = n([-D[1], D[0], 0]);                    // horizontal: up x D
  const V = [D[1] * U[2] - D[2] * U[1], D[2] * U[0] - D[0] * U[2], D[0] * U[1] - D[1] * U[0]];
  return { D, U, V };
})();
// Full-size desks kept per context: only the one in use (a 4096 px desk is ~90 MB of GPU memory;
// the compiled programs stay, so going back to an earlier desk re-bakes in a fraction of a second)
const DESK_KEEP = 1;
const TILES_PER_TICK = 6;     // 512 px tiles baked per animation frame while the preview runs

/**
 * Desk texture size for this context: 4096 on desktop GPUs (MAX_TEXTURE_SIZE >= 8192), else 2048.
 * The desk spans 3.2 sheet widths per repeat, so 4096 keeps its grain crisp in the wide shots.
 */
export function deskBakeSize(gl) {
  let mobile = false;
  try {
    mobile = !!(navigator.userAgentData?.mobile || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
      || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches));
  } catch { /* no navigator (tests) */ }
  return !mobile && gl.getParameter(gl.MAX_TEXTURE_SIZE) >= 8192 ? 4096 : 2048;
}

// Everything the film keeps per GL context (the dialog's preview and the encode share one): the
// scene program, a stand-in texture per desk and the baked desks, so a new film or a restarted
// preview compiles and bakes nothing it already has.
const KITS = new WeakMap();

function compile(gl, vs, fs, ext) {
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const p = gl.createProgram();
  const a = sh(gl.VERTEX_SHADER, vs), b = sh(gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, a); gl.attachShader(p, b);
  gl.linkProgram(p);
  return { p, shaders: [a, b], ext, checked: false };
}

function kitFor(gl) {
  let k = KITS.get(gl);
  // (not gl.isProgram: that query waits for the program's link, ~0.5 s of frozen page while the
  // scene compiles. A lost context drops the kit instead, and a restored one makes a new kit.)
  if (k && !gl.isContextLost()) return k;
  const ext = gl.getExtension('KHR_parallel_shader_compile');
  k = { gl, scene: compile(gl, VERT, FRAG_SCENE, ext), vao: gl.createVertexArray(), u: new Map(),
    desks: new Map(), means: new Map(), pumping: false, tick: 0, warm: [] };
  KITS.set(gl, k);
  gl.canvas?.addEventListener?.('webglcontextlost', () => { if (KITS.get(gl) === k) KITS.delete(gl); }, { once: true });
  return k;
}

// Blocks until the scene program is linked (a no-op once it is), and reports a failure once.
function sceneProgram(k) {
  const gl = k.gl, c = k.scene;
  if (!c.checked) {
    if (!gl.getProgramParameter(c.p, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error('Film scene shader failed: ' + (c.shaders.map(s => gl.getShaderInfoLog(s)).filter(Boolean).join('\n') || gl.getProgramInfoLog(c.p)));
    }
    for (const s of c.shaders) gl.deleteShader(s);
    c.checked = true;
  }
  return c.p;
}

function meanTexture(k, id) {
  let t = k.means.get(id);
  if (t) return t;
  const gl = k.gl;
  const mk = px => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 1, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(px));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    return tex;
  };
  t = { albedo: mk(DESK_MEAN[id] || DESK_MEAN.nero), aux: mk([255, 0, 0, 255]), period: 3.2, stage: 'mean' };
  k.means.set(id, t);
  return t;
}

function deskEntry(k, id, size) {
  const key = `${id}@${size}`;
  let e = k.desks.get(key);
  if (!e) {
    e = { key, id, size, bake: new DeskBake(k.gl, id, { size }), low: null, full: null, used: 0, waiters: [] };
    k.desks.set(key, e);
  }
  e.used = ++k.tick;
  // keep the newest DESK_KEEP desks; older ones are baked again if picked again
  const full = [...k.desks.values()].filter(x => x !== e).sort((a, b) => b.used - a.used);
  for (const x of full.slice(DESK_KEEP - 1)) {
    x.bake.dispose(); x.low?.dispose();
    x.dead = true;
    k.desks.delete(x.key);
    for (const w of x.waiters.splice(0)) w(null);
  }
  return e;
}

// A quick low-resolution bake the moment the program is ready, so the preview shows the real
// material within a frame or two while the full one bakes tile by tile.
function bakeLow(k, e) {
  if (e.low || !e.bake.compiled) return;
  e.low = new DeskBake(k.gl, e.id, { size: 256, auxSize: 256, tile: 256 });
  e.low.step();
}

function finish(e) {
  e.full = e.bake.result;
  for (const w of e.waiters.splice(0)) w(e.full);
}

// Bakes pending desks a few tiles per animation frame (one desk at a time), so the live preview
// keeps running while a 4096 px desk is made.
function pump(k) {
  if (k.pumping) return;
  k.pumping = true;
  const schedule = f => (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && !document.hidden
    ? requestAnimationFrame(f) : setTimeout(f, 16));
  const tick = () => {
    k.pumping = false;
    if (k.gl.isContextLost() || KITS.get(k.gl) !== k) return;
    const pending = [...k.desks.values()].filter(e => !e.full).sort((a, b) => b.used - a.used);
    if (!pending.length) {
      // idle: compile the other desks' bake programs (warmDesks) on the driver's threads, so
      // picking one later bakes at once
      for (const id of k.warm.splice(0)) warmDesk(k.gl, id);
      return;
    }
    const e = pending[0];
    try {
      if (e.bake.compiled) {
        bakeLow(k, e);
        if (e.bake.step(TILES_PER_TICK)) finish(e);
      }
    } catch (err) { console.warn(err); for (const w of e.waiters.splice(0)) w(null); k.desks.delete(e.key); }
    k.pumping = true;
    schedule(tick);
  };
  schedule(tick);
}

/**
 * Start preparing desk `id` in this context: the scene program and the desk's bake compile in the
 * background and the desk bakes over the next frames. Resolves with the baked desk (or null when
 * it could not be made). urgent: finish the bake without waiting for animation frames (a film
 * about to be encoded).
 */
export function loadDesk(gl, id, { size = deskBakeSize(gl), urgent = false } = {}) {
  const k = kitFor(gl);
  const e = deskEntry(k, deskById(id).id, size);
  if (e.full) return Promise.resolve(e.full);
  const p = new Promise(res => e.waiters.push(res));
  if (urgent) {
    // wait for the compile without blocking, then draw every remaining tile at once
    const go = () => {
      if (gl.isContextLost()) { for (const w of e.waiters.splice(0)) w(null); return; }
      if (e.full) return;
      if (!e.bake.compiled) { setTimeout(go, 10); return; }
      try { if (e.bake.step()) finish(e); } catch (err) { console.warn(err); for (const w of e.waiters.splice(0)) w(null); }
    };
    go();
  } else pump(k);
  return p;
}

/**
 * Compile the bake programs of desks `ids` in the background once nothing else is baking, so
 * switching to any of them later skips the compile. Only where the driver compiles off
 * the main thread (KHR_parallel_shader_compile); elsewhere a compile would stall the page.
 */
export function warmDesks(gl, ids) {
  const k = kitFor(gl);
  if (!k.scene.ext) return;
  k.warm = ids.map(id => deskById(id).id).filter(id => !deskCompiled(gl, id));
  pump(k);
}

/**
 * Whether the film scene can draw in this context without waiting for the driver to finish
 * compiling its program (always true without KHR_parallel_shader_compile). A live preview skips
 * frames until then instead of freezing the page; also starts the compile if nothing has yet.
 */
export function sceneReady(gl) {
  const k = kitFor(gl), c = k.scene;
  return c.checked || !c.ext || !!gl.getProgramParameter(c.p, c.ext.COMPLETION_STATUS_KHR);
}

/** Where desk `id` is in this context: 'full' (baked), 'low' (quick stand-in bake), 'mean' or 'none'. */
export function deskStatus(gl, id, size = deskBakeSize(gl)) {
  const k = KITS.get(gl);
  const e = k?.desks.get(`${deskById(id).id}@${size}`);
  return e?.full ? 'full' : e?.low?.done ? 'low' : e ? 'mean' : 'none';
}

// ---------------------------------------------------------------------------------- scene
export class FilmScene {
  /**
   * @param gl  the paper renderer's WebGL2 context
   * @param o   { dark: bool (a dark paper: stronger halation, deeper shadow), seed, glow: bool (the
   *            medium gives light: neon), desk: id (desks.js), deskSize, wait: bool (bake the desk
   *            now if it is not ready: an encode must not start on a stand-in) }
   */
  constructor(gl, o = {}) {
    this.gl = gl;
    this.dark = !!o.dark;
    this.glow = !!o.glow;
    this.kit = kitFor(gl);
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    this.deskSize = o.deskSize || deskBakeSize(gl);
    this.setDesk(o.desk, { wait: o.wait });
    this.pola = null; this.photo = null; this.order = null;
    this.sheetTexSeen = null;
  }

  /**
   * Put the sheet on desk `id`. Without wait it switches at once: the desk shows as its mean
   * colour, then a quick low-resolution bake, then the full one, as they become ready.
   */
  setDesk(id, { wait = false } = {}) {
    this.desk = deskById(id);
    this.look = DESK_LOOK[this.desk.id] || DESK_LOOK.nero;
    this.entry = deskEntry(this.kit, this.desk.id, this.deskSize);
    if (!this.entry.full) {
      if (wait) { this.entry.bake.step(); finish(this.entry); } else loadDesk(this.gl, this.desk.id, { size: this.deskSize });
    }
  }

  /** What the desk is drawn from right now: 'full', 'low' (while the full bake runs) or 'mean'. */
  get deskStage() {
    const e = this.entry;
    return e.full ? 'full' : e.low?.done ? 'low' : 'mean';
  }

  _desk() {
    if (this.entry.dead) {
      // evicted by newer desks (a long-lived scene): ask for it again
      this.entry = deskEntry(this.kit, this.desk.id, this.deskSize);
      if (!this.entry.full) loadDesk(this.gl, this.desk.id, { size: this.deskSize });
    }
    const e = this.entry;
    if (e.full) return e.full;
    if (e.low?.done) return e.low.result;
    return meanTexture(this.kit, this.desk.id);
  }

  _loc(name) {
    const u = this.kit.u;
    let l = u.get(name);
    if (l === undefined) { l = this.gl.getUniformLocation(this.kit.scene.p, name); u.set(name, l); }
    return l;
  }

  _filter(tex, repeat) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    // the camera looks at the desk at an angle: anisotropic filtering keeps the far side crisp
    if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  }

  _upload(canvas, old) {
    const gl = this.gl;
    if (old) gl.deleteTexture(old);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // premultiplied, so mips of the transparent surround do not bleed dark fringes
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this._filter(tex, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    return tex;
  }

  /** The taped photo on the desk: canvas (transparent surround) and its world rectangle. */
  setPolaroid(canvas, place) {
    if (!canvas) { this.polaPlace = null; return; }
    this.pola = this._upload(canvas, this.pola);
    this.polaPlace = place;       // { x, y, hw, hh, rot } centre, half-size, rotation (rad)
  }

  /**
   * The reveal: the source photo inside the art's bounding square (transparent outside the art),
   * and the drawing order over the same square (grey, 0 = drawn first, equalised by area) that the
   * wipe follows.
   */
  setPhoto(canvas, art, order = null) {
    this.art = art;               // { x, y, r, square }
    if (!canvas) return;
    this.photo = this._upload(canvas, this.photo);
    if (order) this.order = this._upload(order, this.order);
  }

  /**
   * Draw one frame into the default framebuffer (W x H).
   * o = { sheet: { tex, w }, basis (cameraBasis), focus: [x, y], wipe: [in, out] (0..1 each, the
   *       reveal), light: 0..1 sweep, time: s (the fronds' sway on the sunlit desk), sun: false
   *       (no leaf shadows: the flat film's desk, where the sheet is drawn on top unlit),
   *       macro: { tex, rect: [x0, y0, x1, y1] sheet fractions, w: 0..1 } (renderToTexture's rect
   *       view: the macro opening's finer rendering of part of the sheet) }
   */
  render(o) {
    const gl = this.gl, b = o.basis;
    const { W, H } = b;
    const p = sceneProgram(this.kit);
    if (o.sheet.tex !== this.sheetTexSeen) {
      // a new sheet texture: give it the same filtering as the desk
      this.sheetTexSeen = o.sheet.tex;
      gl.bindTexture(gl.TEXTURE_2D, o.sheet.tex);
      if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    }
    const desk = this._desk();
    if (desk.albedo !== this.deskSeen) {
      this.deskSeen = desk.albedo;
      gl.bindTexture(gl.TEXTURE_2D, desk.albedo);
      if (this.aniso && desk.stage !== 'mean') gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.useProgram(p);
    gl.bindVertexArray(this.kit.vao);
    const U = name => this._loc(name);
    gl.uniform2f(U('uRes'), W, H);
    gl.uniform3fv(U('uCam'), b.C);
    gl.uniform3fv(U('uRight'), b.r);
    gl.uniform3fv(U('uDown'), b.d);
    gl.uniform3fv(U('uFwd'), b.f);
    gl.uniform1f(U('uFocal'), b.F);
    // thin lens: blur radius (px) = K * |depth - focus| / depth, K = aperture * focal / focus
    const ln = lens(b, o.focus || [0, 0]);
    gl.uniform1f(U('uFocus'), ln.zf);
    gl.uniform1f(U('uCocK'), ln.K);
    gl.uniform1f(U('uCocMax'), ln.max);
    const tex = (unit, t, name) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(U(name), unit);
    };
    tex(0, o.sheet.tex, 'uSheet');
    tex(1, desk.albedo, 'uDesk');
    tex(2, this.pola || desk.albedo, 'uPola');
    tex(3, this.photo || desk.albedo, 'uPhoto');
    tex(4, this.order || desk.albedo, 'uOrder');
    tex(5, desk.aux, 'uDeskAux');
    const mac = o.macro && o.macro.tex && o.macro.w > 0 ? o.macro : null;
    tex(6, mac ? mac.tex : desk.albedo, 'uMacro');
    if (mac && mac.tex !== this.macroTexSeen) {
      // a new macro texture: the same filtering as the sheet (unit 6 is the active one here, so
      // no other unit's binding is touched)
      this.macroTexSeen = mac.tex;
      if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    }
    gl.uniform1f(U('uMacroW'), mac ? clamp(mac.w, 0, 1) : 0);
    // renderToTexture's rect is in sheet fractions (x of the width, y of the height; the sheet is square)
    if (mac) gl.uniform4f(U('uMacroRect'), mac.rect[0] - 0.5, mac.rect[1] - 0.5, mac.rect[2] - 0.5, mac.rect[3] - 0.5);
    gl.uniform1f(U('uDeskPeriod'), desk.period);
    const look = this.look;
    gl.uniform1f(U('uDeskGain'), look.gain);
    gl.uniform1f(U('uRefl'), look.refl);
    gl.uniform1i(U('uSun'), this.desk.id === 'sunlit' && o.sun !== false ? 1 : 0);
    gl.uniform1f(U('uTime'), o.time || 0);
    gl.uniform3fv(U('uWinDir'), WIN.D);
    gl.uniform3fv(U('uWinU'), WIN.U);
    gl.uniform3fv(U('uWinV'), WIN.V);
    const pp = this.pola && this.polaPlace;
    gl.uniform1i(U('uPolaOn'), pp ? 1 : 0);
    if (pp) {
      gl.uniform2f(U('uPolaC'), pp.x, pp.y);
      gl.uniform2f(U('uPolaAx'), Math.cos(pp.rot), Math.sin(pp.rot));
      gl.uniform2f(U('uPolaHalf'), pp.hw, pp.hh);
    }
    const art = this.art || { x: 0, y: 0, r: 0.42, square: false };
    const wipe = this.photo && this.order && o.wipe ? o.wipe : [0, 0];
    gl.uniform2f(U('uWipe'), clamp(wipe[0], 0, 1), clamp(wipe[1], 0, 1));
    gl.uniform3f(U('uArt'), art.x, art.y, art.r);
    gl.uniform1i(U('uArtSquare'), art.square ? 1 : 0);
    // window light from the upper left, its pool on the sheet's upper-left third; during the final
    // hold it drifts across a little (o.light)
    const sweep = o.light || 0;
    gl.uniform2f(U('uPool'), -0.2 + 0.22 * sweep, -0.22 + 0.06 * sweep);
    gl.uniform1f(U('uPoolR'), 0.85);
    const dark = this.dark;
    // halation from mips about 1.2% of the sheet wide (a few mm); stronger on dark papers, where
    // only the line itself (gold, chalk) is bright enough to bloom, and strongest for a line that
    // is itself a light (neon), which should read as light, not as pink print
    gl.uniform1f(U('uHalo'), this.glow ? 0.9 : dark ? 0.35 : 0.12);
    gl.uniform1f(U('uHaloT'), this.glow ? 0.06 : 0.5);
    gl.uniform1f(U('uHaloLod'), Math.max(0, Math.log2((o.sheet.w || 2048) * 0.012)));
    gl.uniform3f(U('uKey'), 1.0, 0.94, 0.85);          // warm daylight through glass
    gl.uniform3f(U('uAmb'), 0.13, 0.145, 0.17);         // cool fill from the room
    gl.uniform2f(U('uShadow'), 0.012, 0.018);
    gl.uniform1f(U('uShadowAmt'), (dark ? 1.2 : 1.0) * look.shadow);
    gl.uniform1f(U('uExposure'), 1.1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
  }

  /** Frees this film's own textures; the program and the baked desks stay with the context. */
  destroy() {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;
    for (const t of [this.pola, this.photo, this.order]) if (t) gl.deleteTexture(t);
    this.pola = this.photo = this.order = null;
    this.gl = null;
  }
}
