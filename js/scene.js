// Cinematic film scene: the sheet (a mipmapped texture from Renderer.renderToTexture) lying on a
// desk, shot through a perspective camera with shallow depth of field, a warm window key light,
// a filmic tone curve, a vignette and fine static grain. It renders in the paper renderer's own
// WebGL2 context, so the sheet never leaves the GPU, into that renderer's canvas; the film
// composer copies the canvas into the encoder's 2D canvas and draws the tool sprite on top.
//
// World units: the sheet is 1 wide, centred on the origin, lying on the desk plane h = 0;
// x runs right, y down the sheet (toward the person at the desk), h up out of the desk.
// A camera is { tx, ty, zoom, pitch, yaw, roll, fx, fy } (radians): it looks at the target
// (tx, ty) from a distance set by zoom (1 = the final full-sheet framing), tilted by pitch toward
// the viewer's side of the desk, turned by yaw about the vertical and rolled about its own axis;
// (fx, fy) is the point in focus. planCamera() directs a whole film as a smooth track of these.

const DEG = Math.PI / 180;
export const FOV_SHORT = 32 * DEG;     // field of view across the frame's short side (a ~60 mm look)
const APERTURE = 0.055;                // lens aperture, sheet widths: depth of field at the close-up
const DESK_PERIOD = 2;                 // world units covered by one repeat of the desk texture
const DESK_SIZE = 2048;
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

/**
 * Direct a film: a camera track sampled at `hz`, a pure function of the inputs.
 * o = {
 *   length, t0 (pen touches down), t1 (drawing done), tSettle (the shot has arrived on the final
 *   framing, as the tool lifts away), tFinal (framing exact from here on, and held),
 *   head(t) -> [x, y] world position of the pen tip at time t,
 *   mode: 'center' (spiral from the centre) | 'edge' (spiral from the rim) | 'follow' (maze),
 *   art: { x, y, r } art circle centre and radius (world),
 *   frame: { W, H, side, cx, cy } final framing in px (sheet `side` px wide, centred at cx, cy),
 *   safe: [x0, y0, x1, y1] fractions of the frame the pen tip must stay inside,
 * }
 * Returns { hz, n, at(t) -> camera, maxZoom }.
 */
export function planCamera(o) {
  const hz = o.hz || 60;
  const n = Math.max(2, Math.ceil(o.length * hz) + 1);
  const { W, H, side, cx, cy } = o.frame;
  const fin = { tx: (W / 2 - cx) / side, ty: (H / 2 - cy) / side };   // target of the final framing
  const art = o.art;
  const mode = o.mode;
  const zmax = mode === 'follow' ? 2.6 : 2.8;
  const D = Math.max(1e-3, o.t1 - o.t0);
  // An anchored target keeps the art circle where the final framing puts it on screen, whatever
  // the zoom (so a story's drawing stays clear of the app UI at the bottom all the way through).
  const anchor = (z, k) => (k === 0 ? art.x - (art.x - fin.tx) / z : art.y - (art.y - fin.ty) / z);
  const acx = W / 2 + (art.x - fin.tx) * side, acy = H / 2 + (art.y - fin.ty) * side;
  const [sx0, sy0, sx1, sy1] = o.safe;
  // Largest zoom that keeps a point (dx, dy) world units away from screen point (ox, oy) inside
  // the safe box; 0.9 leaves room for the tilt, which magnifies the near side of the frame.
  const room = (ox, oy, dx, dy) => {
    const lx = dx > 1e-9 ? (sx1 * W - ox) / (dx * side) : dx < -1e-9 ? (sx0 * W - ox) / (dx * side) : Infinity;
    const ly = dy > 1e-9 ? (sy1 * H - oy) / (dy * side) : dy < -1e-9 ? (sy0 * H - oy) / (dy * side) : Infinity;
    return 0.9 * Math.min(lx, ly);
  };
  // smooth minimum: below both, with no corner where one takes over from the other
  const softmin = (a, b) => Math.pow(Math.pow(a, -4) + Math.pow(b, -4), -0.25);

  const hx = new Float64Array(n), hy = new Float64Array(n);
  for (let i = 0; i < n; i++) { const [x, y] = o.head(i / hz); hx[i] = x; hy[i] = y; }

  // 1. what the shot wants: zoom (log) and, when following, where to look
  const lz = new Float64Array(n), gx = new Float64Array(n), gy = new Float64Array(n);
  let reach = 0;
  for (let i = 0; i < n; i++) {
    const t = i / hz, p = clamp((t - o.t0) / D, 0, 1);
    // a slow push-in while the pen comes down: the shot is alive from its first frame
    const settle = 0.92 + 0.08 * smooth(0, o.t0 + 0.5, t);
    let z;
    if (mode === 'center') {
      // the close-up holds until the growing disc meets the safe box, then the camera pulls back
      // just fast enough to keep the whole drawing (and so the pen) in frame
      reach = Math.max(reach, Math.hypot(hx[i] - art.x, hy[i] - art.y));
      const fitR = reach > 1e-6 ? 0.9 * Math.min(acx - sx0 * W, sx1 * W - acx, acy - sy0 * H, sy1 * H - acy) / (reach * side) : Infinity;
      z = Math.max(1, softmin(zmax * settle, fitR));
    } else if (mode === 'edge') {
      // the pen circles the rim at once, so the shot opens wide and low, then tightens as the
      // line closes in on the centre (the safe box below sets how far)
      z = p > 0 ? 1.7 : 1.12 * settle;
    } else {
      z = Math.exp(Math.log(zmax) * Math.pow(1 - p, 1.5)) * (p > 0 ? 1 : settle);
      const w = smooth(0, 1, (zmax - z) / (zmax - 1)) ** 1.5;
      gx[i] = mix(hx[i], anchor(z, 0), w); gy[i] = mix(hy[i], anchor(z, 1), w);
    }
    // the final framing takes over as the drawing ends
    const e = smoother(o.t1 - Math.min(1.4, D * 0.3), o.tSettle, t);
    lz[i] = Math.log(mix(z, 1, e));
    if (mode === 'follow') { gx[i] = mix(gx[i], fin.tx, e); gy[i] = mix(gy[i], fin.ty, e); }
  }

  // 2. smooth: targets glide (look-ahead included), zoom breathes. Right after touchdown the pen
  // is still slow (the speed ramp) and the camera may follow it closely; once the drawing runs at
  // timelapse speed the windows widen, so the camera drifts instead of chasing.
  const sT = new Float64Array(n), sZ = new Float64Array(n), rZ = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const w = smooth(o.t0 + 0.4, o.t0 + 2.2, i / hz);
    sT[i] = mix(0.22, 0.7, w) * hz;
    sZ[i] = (mode === 'center' ? 0.3 : mix(0.18, 0.45, w)) * hz;
    rZ[i] = Math.ceil(sZ[i] * 1.6);
  }
  let tx = null, ty = null;
  if (mode === 'follow') { tx = gauss(gx, sT); ty = gauss(gy, sT); }
  let z = gauss(lz, sZ);

  // 3. keep the pen tip inside the safe box: where it would leave, zoom out. The limit is eroded
  // (running minimum) before smoothing so the smoothed zoom still respects it.
  if (mode !== 'center') {
    for (let pass = 0; pass < 3; pass++) {
      const cap = new Float64Array(n);
      let any = false;
      for (let i = 0; i < n; i++) {
        const zi = Math.exp(z[i]);
        let lim;
        if (tx) lim = room(W / 2, H / 2, hx[i] - tx[i], hy[i] - ty[i]);
        else lim = room(acx, acy, hx[i] - art.x, hy[i] - art.y);
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

  // 4. derived: target (anchored modes), tilt, turn, roll, focus
  const out = {
    tx: new Float64Array(n), ty: new Float64Array(n), zoom: new Float64Array(n),
    pitch: new Float64Array(n), yaw: new Float64Array(n), roll: new Float64Array(n),
    fx: new Float64Array(n), fy: new Float64Array(n),
  };
  // focus follows the pen, averaged over a lap or so: focus that tracked every ring of the tilted
  // close-up would breathe with it
  const fxS = gauss(hx, 0.35 * hz), fyS = gauss(hy, 0.35 * hz);
  for (let i = 0; i < n; i++) {
    const t = i / hz;
    const zi = Math.exp(z[i]);
    let u = clamp((zi - 1) / (zmax - 1), 0, 1);          // 1 at the close-up, 0 on the full sheet
    // a pen that roams (maze) or starts on the rim cannot be held in a close-up for long: the shot
    // still opens low over the sheet and rises to top-down over the first half of the drawing
    // (a smooth union of the two, not max(), which would put a corner in the tilt)
    if (mode !== 'center') u = 1 - (1 - u) * (1 - 0.85 * (1 - smoother(o.t0 - 0.3, o.t0 + 0.5 * D, t)));
    const uu = Math.pow(u, 0.85);
    // exact final framing: the smoothed track is already within a hair of it here
    const e = smoother(o.tSettle, o.tFinal, t);
    out.zoom[i] = mix(zi, 1, e);
    out.tx[i] = mix(tx ? tx[i] : anchor(zi, 0), fin.tx, e);
    out.ty[i] = mix(ty ? ty[i] : anchor(zi, 1), fin.ty, e);
    out.pitch[i] = mix(23 * DEG * uu, 0, e);
    out.yaw[i] = mix(uu * (-7 + 2.2 * Math.sin(t * 2 * Math.PI / 11)) * DEG, 0, e);
    out.roll[i] = mix(uu * 1.1 * DEG, 0, e);
    out.fx[i] = fxS[i]; out.fy[i] = fyS[i];
  }
  let maxZoom = 1;
  for (let i = 0; i < n; i++) maxZoom = Math.max(maxZoom, out.zoom[i] * (1 + 0.45 * Math.sin(out.pitch[i])));

  const at = t => {
    const f = clamp(t * hz, 0, n - 1), i = Math.min(n - 2, Math.floor(f)), k = f - i;
    const g = key => out[key][i] + (out[key][i + 1] - out[key][i]) * k;
    return { tx: g('tx'), ty: g('ty'), zoom: g('zoom'), pitch: g('pitch'), yaw: g('yaw'), roll: g('roll'), fx: g('fx'), fy: g('fy') };
  };
  return { hz, n, at, maxZoom, zmax, track: out };
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

// Desk texture: one repeat of a planked wooden desk top (planks along x), tileable in both axes.
const FRAG_DESK = /* glsl */`#version 300 es
precision highp float;
precision highp int;
out vec4 frag;
uniform vec2 uSize;        // texture px
uniform float uPeriod;     // world units per repeat
uniform int uDark;         // 0 pale oak, 1 walnut
uniform float uSeed;
${HASH}
// value noise with an integer lattice period, so the texture tiles
float hp(vec2 i, vec2 per) { return hashI(ivec2(mod(i, per)) + ivec2(int(uSeed) * 131, int(uSeed) * 71)); }
float pn(vec2 p, vec2 per) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hp(i, per), hp(i + vec2(1.0, 0.0), per), u.x),
             mix(hp(i + vec2(0.0, 1.0), per), hp(i + vec2(1.0, 1.0), per), u.x), u.y);
}
void main() {
  vec2 q = gl_FragCoord.xy / uSize * uPeriod;             // world units within one repeat
  float PH = uPeriod / 3.0;                                // three planks per repeat
  float k = floor(q.y / PH);
  float km = mod(k, 3.0);
  float yl = q.y - k * PH;                                 // across the plank
  float r1 = hashI(ivec2(int(km), 7)), r2 = hashI(ivec2(int(km), 19)), r3 = hashI(ivec2(int(km), 31));
  float per = uPeriod;
  float xs = q.x;
  // Plain-sawn board: the growth rings are cylinders around the log's axis, which runs along x
  // below the board surface at a depth that wanders; cut by the flat surface they show as long
  // U-shaped cathedral arches. Everything varies periodically in x so the texture tiles.
  float ph = 6.2831853 / per;
  float depth = 0.06 + 0.22 * r2 + 0.05 * sin(xs * ph + r1 * 6.28) + 0.035 * sin(2.0 * xs * ph + r3 * 6.28);
  float axisY = PH * (0.25 + 0.5 * r3) + 0.05 * sin(xs * ph + r2 * 6.28);
  float dy = yl - axisY;
  float rad = sqrt(dy * dy + depth * depth);
  // rings are not evenly spaced (good and lean years) and never perfectly round
  rad += 0.012 * pn(vec2(xs * 3.0, yl * 7.0 + km * 5.0), vec2(3.0 * per, 1e4)) + 0.004 * pn(vec2(xs * 12.0, yl * 30.0), vec2(12.0 * per, 1e4));
  float rings = rad * (70.0 + 30.0 * r1);
  float ringId = floor(rings);
  float f = fract(rings);
  float strength = 0.3 + 0.7 * hashI(ivec2(int(ringId) + 911, int(km)));
  float late = smoothstep(0.68, 0.9, f) * (1.0 - smoothstep(0.95, 1.0, f)) * strength;
  // fine fibre streaks along the grain, and pores in the latewood
  float fibre = pn(vec2(xs * 5.0, yl * 260.0 + km * 17.0), vec2(5.0 * per, 1e5));
  float pore = smoothstep(0.72, 0.92, pn(vec2(xs * 70.0, yl * 420.0 + km * 13.0), vec2(70.0 * per, 1e5)));
  float cloud = pn(vec2(xs * 0.8, yl * 1.2 + km * 2.0), vec2(0.8 * per, 1e4));
  vec3 light, dark;
  if (uDark == 1) { light = vec3(0.275, 0.195, 0.145); dark = vec3(0.145, 0.098, 0.072); }
  else { light = vec3(0.80, 0.715, 0.60); dark = vec3(0.64, 0.545, 0.43); }
  float g = clamp(0.55 * late + 0.3 * fibre + 0.25 * pore * (0.4 + late), 0.0, 1.0);
  vec3 col = mix(light, dark, g * (uDark == 1 ? 0.6 : 0.5));
  col *= 0.94 + 0.09 * cloud + 0.07 * (r1 - 0.5);         // plank-to-plank tone
  // plank seam: a dark hairline with a bevel catching the light just below it
  float seam = min(yl, PH - yl);
  col *= 1.0 - 0.55 * (1.0 - smoothstep(0.0, 0.0022, seam));
  col *= 1.0 + 0.06 * smoothstep(0.0022, 0.004, yl) * (1.0 - smoothstep(0.004, 0.008, yl));
  frag = vec4(col, 1.0);
}`;

const FRAG_SCENE = /* glsl */`#version 300 es
precision highp float;
precision highp int;
out vec4 frag;
uniform vec2 uRes;
uniform vec3 uCam, uRight, uDown, uFwd;
uniform float uFocal;
uniform sampler2D uSheet;
uniform sampler2D uDesk;
uniform float uDeskPeriod;
uniform sampler2D uPola;
uniform int uPolaOn;
uniform vec2 uPolaC, uPolaAx, uPolaHalf;
uniform sampler2D uPhoto;
uniform float uReveal;
uniform vec3 uArt;          // x, y, r (world)
uniform int uArtSquare;
uniform float uCocK, uFocus, uCocMax;
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

// shadow of the sheet on the desk: a tight contact line and a soft cast shadow
float sheetShadow(vec2 P) {
  float d0 = rectSD(P, vec2(0.5));
  float d1 = rectSD(P - uShadow, vec2(0.5));
  return (1.0 - 0.3 * uShadowAmt * (1.0 - smoothstep(0.0, 0.006, d0)))
       * (1.0 - 0.28 * uShadowAmt * (1.0 - smoothstep(-0.006, 0.03, d1)));
}
// shadow of the taped photo, on the desk or on the sheet (it lies on top of both)
float polaShadow(vec2 P) {
  if (uPolaOn == 0) return 1.0;
  vec2 l = P - uPolaC - uShadow * 1.4;
  l = vec2(dot(l, uPolaAx), dot(l, vec2(-uPolaAx.y, uPolaAx.x)));
  float dp = rectSD(l, uPolaHalf * vec2(0.84, 0.8));
  return 1.0 - 0.3 * uShadowAmt * (1.0 - smoothstep(-0.01, 0.025, dp));
}

vec3 lightAt(vec2 P) {
  vec2 q = (P - uPool) / uPoolR;
  return uAmb + uKey * (0.64 + 0.36 * exp(-dot(q, q)));
}

// scene colour (linear) at desk point P; gx, gy = its screen-space gradients (texture footprint)
vec3 shade(vec2 P, vec2 gx, vec2 gy) {
  float fp = max(max(length(gx), length(gy)), 1e-6);
  vec3 col = vec3(0.0);
  float sd = max(abs(P.x), abs(P.y)) - 0.5;
  float m = clamp(0.5 - sd / fp, 0.0, 1.0);
  if (m < 1.0) {
    col = toLin(textureGrad(uDesk, P / uDeskPeriod, gx / uDeskPeriod, gy / uDeskPeriod).rgb) * sheetShadow(P);
  }
  if (m > 0.0) {
    // texture v runs up the sheet (the renderer's framebuffer is bottom-up)
    vec2 uv = vec2(P.x + 0.5, 0.5 - P.y);
    vec3 s = toLin(textureGrad(uSheet, uv, vec2(gx.x, -gx.y), vec2(gy.x, -gy.y)).rgb);
    if (uReveal > 0.0) {
      vec2 a = (P - uArt.xy) / uArt.z;
      float inside = uArtSquare == 1 ? max(abs(a.x), abs(a.y)) : length(a);
      float mask = clamp((1.0 - inside) * uArt.z / fp + 0.5, 0.0, 1.0);
      if (mask > 0.0) {
        vec2 puv = a * 0.5 + 0.5;
        vec2 psc = vec2(0.5 / uArt.z);
        vec4 pc = textureGrad(uPhoto, puv, gx * psc, gy * psc);
        vec3 c = pc.a > 1e-3 ? toLin(pc.rgb / pc.a) : s;
        s = mix(s, c, uReveal * mask * pc.a);
      }
    }
    col = m >= 1.0 ? s : mix(col, s, m);
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
      col = mix(col, c, pc.a);
    }
  }
  return col * lightAt(P);
}

vec2 hitDesk(vec2 s, out float depth) {
  vec3 d = uFwd + uRight * ((s.x - 0.5 * uRes.x) / uFocal) + uDown * ((s.y - 0.5 * uRes.y) / uFocal);
  float t = -uCam.z / d.z;
  depth = t;
  return uCam.xy + d.xy * t;
}

void main() {
  vec2 s = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  float depth;
  vec2 P = hitDesk(s, depth);
  // footprint of one pixel on the desk (gl_FragCoord.y runs up, so dFdy is negated)
  vec2 gx = dFdx(P), gy = -dFdy(P);
  float coc = min(uCocMax, uCocK * abs(depth - uFocus) / depth);
  vec3 col;
  if (coc < 0.6) {
    col = shade(P, gx, gy);
  } else {
    // gather over the circle of confusion: taps on a golden-angle disc, each prefiltered by the
    // mip level of its share of the disc, so the blur is round and smooth (no box artefacts).
    // The pattern is the same for every pixel: a per-pixel twist would crawl as the camera moves.
    float k = max(1.0, coc * 1.8 / sqrt(float(N)));
    col = vec3(0.0);
    for (int i = 0; i < N; i++) {
      float a = float(i) * 2.39996323;
      vec2 o = vec2(cos(a), sin(a)) * sqrt((float(i) + 0.5) / float(N)) * coc;
      float dd;
      vec2 Q = hitDesk(s + o, dd);
      col += shade(Q, gx * k, gy * k);
    }
    col /= float(N);
  }
  // exposure, a gentle filmic shoulder and toe, vignette, static grain
  col *= uExposure;
  vec3 aces = col * (2.51 * col + 0.03) / (col * (2.43 * col + 0.59) + 0.14);
  col = mix(col, aces, 0.55);
  vec2 v = (s - 0.5 * uRes) / (0.5 * length(uRes));
  col *= 1.0 - 0.34 * pow(smoothstep(0.3, 1.05, length(v)), 1.4);
  vec3 outc = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  outc = outc * 0.985 + vec3(0.012, 0.009, 0.006);             // film base: blacks lift a hair, warm
  outc += (hashI(ivec2(s) + 911) - 0.5) * (2.2 / 255.0);
  frag = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`;

// ---------------------------------------------------------------------------------- scene
export class FilmScene {
  /**
   * @param gl  the paper renderer's WebGL2 context
   * @param o   { dark: bool (walnut desk), seed }
   */
  constructor(gl, o = {}) {
    this.gl = gl;
    this.dark = !!o.dark;
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    this.prog = this._program(VERT, FRAG_SCENE);
    this.deskProg = this._program(VERT, FRAG_DESK);
    this.vao = gl.createVertexArray();
    this.u = new Map();
    this.pola = null; this.photo = null;
    this._makeDesk(o.seed || 1);
    this.sheetTexSeen = null;
  }

  _program(vs, fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        const log = gl.getShaderInfoLog(s);
        throw new Error('Film scene shader failed: ' + log);
      }
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error('Film scene link failed: ' + gl.getProgramInfoLog(p));
    return p;
  }

  _loc(p, name) {
    const key = (p === this.prog ? 's:' : 'd:') + name;
    let l = this.u.get(key);
    if (l === undefined) { l = this.gl.getUniformLocation(p, name); this.u.set(key, l); }
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

  _makeDesk(seed) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, Math.log2(DESK_SIZE) + 1, gl.RGBA8, DESK_SIZE, DESK_SIZE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, DESK_SIZE, DESK_SIZE);
    gl.disable(gl.BLEND);
    const p = this.deskProg;
    gl.useProgram(p);
    gl.uniform2f(this._loc(p, 'uSize'), DESK_SIZE, DESK_SIZE);
    gl.uniform1f(this._loc(p, 'uPeriod'), DESK_PERIOD);
    gl.uniform1i(this._loc(p, 'uDark'), this.dark ? 1 : 0);
    gl.uniform1f(this._loc(p, 'uSeed'), seed % 97);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    this._filter(tex, true);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.desk = tex;
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

  /** The source photo inside the art circle's bounding square (transparent outside the art). */
  setPhoto(canvas, art) {
    if (!canvas) { this.art = art; return; }
    this.photo = this._upload(canvas, this.photo);
    this.art = art;               // { x, y, r, square }
  }

  /**
   * Draw one frame into the default framebuffer (W x H).
   * o = { sheet: {tex}, basis (cameraBasis), focus: [x, y], reveal: 0..1, light: 0..1 sweep }
   */
  render(o) {
    const gl = this.gl, p = this.prog, b = o.basis;
    const { W, H } = b;
    if (o.sheet.tex !== this.sheetTexSeen) {
      // a new sheet texture: give it the same filtering as the desk
      this.sheetTexSeen = o.sheet.tex;
      gl.bindTexture(gl.TEXTURE_2D, o.sheet.tex);
      if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.useProgram(p);
    gl.bindVertexArray(this.vao);
    const U = name => this._loc(p, name);
    gl.uniform2f(U('uRes'), W, H);
    gl.uniform3fv(U('uCam'), b.C);
    gl.uniform3fv(U('uRight'), b.r);
    gl.uniform3fv(U('uDown'), b.d);
    gl.uniform3fv(U('uFwd'), b.f);
    gl.uniform1f(U('uFocal'), b.F);
    // thin lens: blur radius (px) = K * |depth - focus| / depth, K = aperture * focal / focus
    const [fx, fy] = o.focus || [0, 0];
    const fz = project(b, fx, fy)[2];
    gl.uniform1f(U('uFocus'), fz);
    gl.uniform1f(U('uCocK'), 0.5 * APERTURE * b.F / fz);
    gl.uniform1f(U('uCocMax'), 0.022 * Math.min(W, H));
    const tex = (unit, t, name) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(U(name), unit);
    };
    tex(0, o.sheet.tex, 'uSheet');
    tex(1, this.desk, 'uDesk');
    tex(2, this.pola || this.desk, 'uPola');
    tex(3, this.photo || this.desk, 'uPhoto');
    gl.uniform1f(U('uDeskPeriod'), DESK_PERIOD);
    const pp = this.pola && this.polaPlace;
    gl.uniform1i(U('uPolaOn'), pp ? 1 : 0);
    if (pp) {
      gl.uniform2f(U('uPolaC'), pp.x, pp.y);
      gl.uniform2f(U('uPolaAx'), Math.cos(pp.rot), Math.sin(pp.rot));
      gl.uniform2f(U('uPolaHalf'), pp.hw, pp.hh);
    }
    const art = this.art || { x: 0, y: 0, r: 0.42, square: false };
    gl.uniform1f(U('uReveal'), this.photo ? clamp(o.reveal || 0, 0, 1) : 0);
    gl.uniform3f(U('uArt'), art.x, art.y, art.r);
    gl.uniform1i(U('uArtSquare'), art.square ? 1 : 0);
    // window light from the upper left; during the final hold it drifts a little (o.light)
    const sweep = o.light || 0;
    gl.uniform2f(U('uPool'), -0.55 + 0.35 * sweep, -0.7 + 0.12 * sweep);
    gl.uniform1f(U('uPoolR'), 1.25);
    const dark = this.dark;
    gl.uniform3f(U('uKey'), 1.0, 0.94, 0.85);          // warm daylight through glass
    gl.uniform3f(U('uAmb'), 0.13, 0.145, 0.17);         // cool fill from the room
    gl.uniform2f(U('uShadow'), 0.006, 0.009);
    gl.uniform1f(U('uShadowAmt'), dark ? 1.2 : 1.0);
    gl.uniform1f(U('uExposure'), 1.08);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(null);
  }

  destroy() {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;
    gl.deleteProgram(this.prog); gl.deleteProgram(this.deskProg);
    gl.deleteVertexArray(this.vao);
    for (const t of [this.desk, this.pola, this.photo]) if (t) gl.deleteTexture(t);
    this.gl = null;
  }
}
