// Timelapse: timeline maths, the frame composers and the Film dialog (setup -> filming -> result).
//
// Timeline for a film of length L seconds:
//   0 .. INTRO            the tool glides in and touches down at the start of the line
//   INTRO .. +D           the drawing (D = drawSeconds(L)), eased in and out
//   .. +LIFT              the tool lifts and leaves
//   .. +HOLD              the finished drawing holds
//   .. +REVEAL (optional) the photo fades in inside the circle and back out
// The transport on the stage previews exactly the D seconds of drawing with the same easing.
//
// Two styles share that timeline:
//   flat       the whole sheet from straight above on a plain desk (the original film)
//   cinematic  a perspective shot of the sheet on a wooden desk (js/scene.js): it opens on an
//              extreme close-up of the pen touching down, pulls back (or follows the pen through a
//              maze) with tilt, a slow turn and a focus pull, and settles on a straight full-sheet
//              reveal. The camera is planned for the whole film up front as a function of time, so
//              the dialog's live preview (any frame rate) and the encode show the same shot.
// Everything is a pure function of the frame's time: frames can be drawn in any order.

import { Renderer } from './renderer.js';
import { indexAt, headAt } from './spiral.js';
import { hexToRgb, luminance } from './materials.js';
import { toast, announce, bindSeg, reducedMotion } from './ui.js';

export const FPS = 30;
export const FPS_CHOICES = [30, 60];
export const STYLES = ['cinematic', 'flat'];
const INTRO = 0.6, LIFT = 0.45, HOLD = 1.7, REVEAL = 2.4;
const TRACK_HZ = 60;           // pen / camera tracks are sampled at this rate, then interpolated
const TOOL_LEN = 0.3;          // tool length in sheet widths (the flat film's 30% of the sheet)
const TOOL_ANGLE = 35;         // resting hand angle, degrees from vertical (body toward lower right)
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

export function drawSeconds(length, reveal = false) {
  return Math.max(3, length - INTRO - LIFT - HOLD - (reveal ? REVEAL : 0));
}

// Smoothstep ramp integrated: S(x) = x^3 - x^4 / 2, S(1) = 0.5.
const S = x => x * x * x - 0.5 * x * x * x * x;
/**
 * Pen progress (0..1, fed to the pacing table) after fraction u of the drawing time D:
 * the pen accelerates over the first easeIn seconds (0.5) and settles over the last easeOut
 * (0.6). The cinematic film uses a long ease-in as a speed ramp: the pen starts at close to real
 * speed in the close-up and time speeds up as the camera pulls back.
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
const easeInOut = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const smooth = (a, b, x) => easeInOut((x - a) / (b - a));

/**
 * The key light for renderer.setLight (feature-detected, new): from the upper left (the window,
 * where the scene's light and the tool shadows come from), swinging 55 degrees toward the top as
 * sweep goes 0 -> 1. One value that reads right whichever form the renderer takes: a unit
 * direction [x, y, z] (paper space, y down, z toward the viewer) that also carries x/y/z,
 * azimuth/elevation (radians) and sweep, and is its azimuth when used as a number.
 */
function lightAt(sweep) {
  const az = (-135 + 55 * sweep) * DEG, el = 40 * DEG;
  const d = [Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el)];
  return Object.assign(d, { x: d[0], y: d[1], z: d[2], azimuth: az, elevation: el, sweep, valueOf: () => az });
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

// ---------------------------------------------------------------------------------- composer
/**
 * Composes timelapse frames. All geometry of the frame scales with the output size, so the same
 * composer drives the small live preview and the full-size encode.
 */
export class FilmComposer {
  /**
   * @param o { W, H, format, length, fps, style: 'flat'|'cinematic', showTool, polaroid, reveal,
   *            pacing, state, drawPhoto(ctx,cx,cy,R), tools (tools.js), sceneLib (scene.js) }
   * Cinematic needs sceneLib and a renderer with renderToTexture; otherwise it films flat.
   */
  constructor(o) {
    Object.assign(this, o);
    this.fps = o.fps || FPS;
    this.style = o.style === 'cinematic' && o.sceneLib ? 'cinematic' : 'flat';
    this.frames = Math.round(this.length * this.fps);
    this.D = drawSeconds(this.length, this.reveal);
    this.t0 = INTRO;
    this.t1 = INTRO + this.D;
    this.ease = this.style === 'cinematic' ? [1.7, 0.9] : [0.5, 0.6];
    this.restAt = this.t1 + LIFT + 0.5;           // the cinematic camera is still from here on
    const { W, H } = this;
    const k = Math.min(W, H);
    // sheet placement per format (keeps the art clear of the bottom ~20% where apps put UI);
    // in the cinematic film this is the final framing the camera settles on
    let side, cx, cy;
    if (this.format === 'story') { side = W * 0.86; cx = W / 2; cy = H * 0.42; }
    else if (this.format === 'portrait') { side = Math.min(W, H) * 0.84; cx = W / 2; cy = H * 0.48; }
    else if (this.format === 'wide') { side = H * 0.86; cx = W * 0.42; cy = H / 2; }
    else { side = k * 0.86; cx = W / 2; cy = H / 2; }
    this.side = Math.round(side / 2) * 2;
    this.px = Math.round(cx - this.side / 2);
    this.py = Math.round(cy - this.side / 2);
    this.state = o.state;
    this.stats = { frames: 0, ms: 0 };
  }

  prepare() {
    const s = this.state;
    this.penTrack = this._penTrack();
    this.pen = new Float64Array(this.frames);     // per-frame pen index (the tools lab reads it)
    for (let i = 0; i < this.frames; i++) this.pen[i] = this._fi(i / this.fps);
    this.canvas = document.createElement('canvas');
    this.renderer = new Renderer(this.canvas);
    if (this.style === 'cinematic' && typeof this.renderer.renderToTexture !== 'function') this.style = 'flat';
    const r = this.renderer;
    r.setLayout(s.layout);
    r.setPaper(s.paper, s.seed);
    r.setStyle(s);
    if (this.style === 'cinematic') this._prepareCinematic();
    else {
      r.setSize(this.side, this.side);
      this.bg = this._background();
    }
    r.setGeometry(s.geom);
  }

  destroy() {
    try { this.scene?.destroy(); } catch { /* context already gone */ }
    this.renderer?.destroy();
    if (this.bg) { this.bg.width = this.bg.height = 0; }
    this.renderer = null; this.scene = null;
  }

  /** The preview loops: forget cached frames so the next draw starts clean. */
  rewind() {
    this.sheetKey = null;
    if (this.style === 'flat') this.renderer?.render(0);
  }

  // ---------------------------------------------------------------- timeline & pen
  /** Fractional point index of the pen at time t (s). */
  _fi(t) {
    const { geom } = this.state;
    const u = (t - this.t0) / this.D;
    return u <= 0 ? 0 : u >= 1 ? geom.n - 1 : indexAt(geom, drawProgress(u, this.D, ...this.ease), this.pacing);
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
      const h = headAt(geom, this._fi(i / TRACK_HZ));
      [x[i], y[i]] = this._world(h.x, h.y);
      tone[i] = h.tone;
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

  /** Tool pose at time t: tip (world), lift, alpha, hand angle (deg), sway phase. */
  toolPose(t) {
    const { geom } = this.state;
    const a = TOOL_ANGLE * DEG;
    const body = [Math.sin(a), Math.cos(a)];            // from the tip toward the back end
    const across = [-Math.cos(a), Math.sin(a)];
    let x, y, lift, alpha = 1;
    const at = fi => { const h = headAt(geom, fi); return this._world(h.x, h.y); };
    // pressure: dark passages press down, pale ones barely touch (the shadow closes in / opens)
    const bob = 0.12 * Math.pow(1 - clamp(this._track('tone', t), 0, 1), 1.5);
    if (t < this.t0) {
      // glides in along a shallow arc and decelerates onto the paper
      const k = clamp(t / this.t0, 0, 1), e = 1 - Math.pow(1 - k, 3);
      [x, y] = at(0);
      const off = (1 - e) * TOOL_LEN * 1.05;
      x += body[0] * off + across[0] * off * 0.25 * Math.sin(Math.PI * e);
      y += body[1] * off + across[1] * off * 0.25 * Math.sin(Math.PI * e);
      lift = Math.max(bob * e, Math.pow(1 - e, 1.4));
      alpha = smooth(0, 0.35, k);
    } else if (t < this.t1) {
      [x, y] = at(this._fi(t));
      lift = bob;
    } else {
      // lifts straight up first, then leaves toward the lower right, accelerating
      const k = clamp((t - this.t1) / LIFT, 0, 1), e = k * k;
      [x, y] = at(geom.n - 1);
      x += body[0] * e * TOOL_LEN * 1.3;
      y += body[1] * e * TOOL_LEN * 1.3;
      lift = Math.min(1, bob + (1 - bob) * smooth(0, 0.6, k));
      alpha = 1 - smooth(0.55, 1, k);
    }
    // the body leans into the direction of travel (the hand leads, the tip follows)
    const v = this._track('vx', t) * across[0] + this._track('vy', t) * across[1];
    const lean = -7 * Math.tanh(v / 2.2);
    return { x, y, lift, alpha, angle: TOOL_ANGLE + lean, sway: (t * 0.31) % 1 };
  }

  /**
   * The tool with a hint of motion blur: its tip is sampled over the end of the frame's shutter
   * and tools.drawToolMotion averages the sprite along that path, which softens its edges in the
   * direction of travel. Only a hint: a pen sliding sideways by its own width within the blur
   * turns into a see-through ghost and the tip stops reading as attached to the line.
   * view = { toCtx(x, y) -> [cx, cy] (world -> ctx space), size (tool length in ctx units) }.
   */
  _drawTool(g, t, view) {
    if (!this.showTool || !this.tools) return;
    const pose = this.toolPose(t);
    if (pose.alpha <= 0.01) return;
    const s = this.state;
    const opts = { color: s.photoColor ? '#8a5a44' : s.ink, lift: pose.lift, alpha: pose.alpha, angle: pose.angle, sway: pose.sway };
    try {
      const K = 4, shutter = 0.2 / this.fps;
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
    const r = t - (this.t1 + LIFT + HOLD);
    return r < 0 ? 0 : r < 0.6 ? easeInOut(r / 0.6) : r < 1.8 ? 1 : easeInOut(1 - (r - 1.8) / 0.6);
  }

  draw(i, g) {
    const t0 = performance.now();
    if (this.style === 'cinematic') this._drawCinematic(i, g);
    else this._drawFlat(i, g);
    this.stats.frames++; this.stats.ms += performance.now() - t0;
  }

  // ---------------------------------------------------------------- flat
  /** Desk + sheet shadow + taped photo, painted once. */
  _background() {
    const { W, H, side, px, py, state } = this;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const dark = luminance(hexToRgb(state.paper.color)) < 0.2;
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
    // tape strip
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
    const fi = this._fi(t);
    const done = t >= this.t1;
    const { settle } = this._hooks(t);
    this.renderer.render(done ? Infinity : fi, { settle });
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
    this._drawTool(g, t, { toCtx: (x, y) => [px + (x + 0.5) * side, py + (y + 0.5) * side], size: side * TOOL_LEN });
  }

  // ---------------------------------------------------------------- cinematic
  _prepareCinematic() {
    const { W, H, side, px, py, state: s, sceneLib: lib } = this;
    const { geom } = s;
    const [ax, ay] = this._world(0, 0);
    // spirals grow from the centre (or close in from the rim); every other path (maze, wander,
    // contour) starts where the user pointed and roams, so the camera follows it
    const spiral = !geom.path || geom.path === 'spiral';
    const mode = !spiral ? 'follow' : geom.start === 'edge' ? 'edge' : 'center';
    this.plan = lib.planCamera({
      // the shot arrives on the straight full sheet while the pen lifts away, then holds it (at
      // least ~1.2 s even in a 10 s film: a still end frame also lets the encoder sharpen it)
      length: this.length, t0: this.t0, t1: this.t1, tSettle: this.t1 + 0.15, tFinal: this.restAt,
      head: t => [this._track('x', t), this._track('y', t)],
      mode, art: { x: ax, y: ay, r: s.layout.r },
      frame: { W, H, side, cx: px + side / 2, cy: py + side / 2 },
      safe: SAFE[this.format] || SAFE.square,
    });
    // Sheet resolution: about one texel per output pixel at the closest point of the shot, so the
    // close-up is crisp without rendering texels nobody sees.
    const r = this.renderer;
    const want = this.plan.maxZoom * side * 1.08;
    const sheetPx = clamp(Math.ceil(want / 64) * 64, 512, Math.min(3072, r.maxSize || 3072));
    r.setSize(sheetPx, sheetPx);
    // renderToTexture never draws to the canvas: it becomes the film frame
    this.canvas.width = W; this.canvas.height = H;
    this.sheetPx = sheetPx;
    // dark and mid papers (black card, chalkboard, blueprint, kraft) lie on walnut, light ones on oak
    const dark = luminance(hexToRgb(s.paper.color)) < 0.45;
    this.scene = new lib.FilmScene(r.gl, { dark, seed: s.seed });
    if (this.polaroid && this.drawPhoto && this.format !== 'square') {
      const pl = this._polaroidPlace();
      const k = Math.min(1024, Math.max(128, Math.round(pl.size * 1.6)));
      // canvas covers the frame (-0.56..0.56 x -0.56..0.7 of the photo size) plus the tape
      const x0 = -0.6, x1 = 0.6, y0 = -0.66, y1 = 0.74;
      const c = document.createElement('canvas');
      c.width = Math.round(k * (x1 - x0)); c.height = Math.round(k * (y1 - y0));
      const g = c.getContext('2d');
      g.translate(-x0 * k, -y0 * k);
      this._paintPolaroid(g, k);
      const rot = pl.rot * DEG, sw = pl.size / side;
      const ocx = 0, ocy = (y0 + y1) / 2 * sw;     // canvas centre relative to the photo centre
      this.scene.setPolaroid(c, {
        x: (pl.cx - px) / side - 0.5 + (ocx * Math.cos(rot) - ocy * Math.sin(rot)),
        y: (pl.cy - py) / side - 0.5 + (ocx * Math.sin(rot) + ocy * Math.cos(rot)),
        hw: (x1 - x0) / 2 * sw, hh: (y1 - y0) / 2 * sw, rot,
      });
      c.width = c.height = 0;
    }
    const art = { x: ax, y: ay, r: s.layout.r, square: s.shape === 'square' };
    if (this.reveal && this.drawPhoto) {
      const S = clamp(Math.round(2 * s.layout.r * sheetPx), 256, 2048);
      const c = document.createElement('canvas');
      c.width = c.height = S;
      const g = c.getContext('2d');
      g.beginPath();
      if (art.square) g.rect(0, 0, S, S); else g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
      g.clip();
      this.drawPhoto(g, S / 2, S / 2, S / 2);
      this.scene.setPhoto(c, art);
      c.width = c.height = 0;
    } else this.scene.setPhoto(null, art);
    this.sheetKey = null;
  }

  // Optional renderer features (feature-detected): a moving light for gold / wet-ink glints,
  // time for neon flicker, and ink that settles (dries) once the pen has passed: settle is 0 while
  // drawing and rises to 1 over the hold, so wet ink dries on camera.
  _hooks(t) {
    const r = this.renderer;
    const settle = smooth(this.t1, this.t1 + LIFT + HOLD, t);
    const sweep = smooth(this.t1 + LIFT, this.length, t);
    let key = settle.toFixed(3);
    if (typeof r.setTime === 'function') { r.setTime(t); key += `|${t}`; }
    if (typeof r.setLight === 'function') { r.setLight(lightAt(sweep)); key += `|${sweep.toFixed(4)}`; }
    return { settle, sweep, key };
  }

  _sheet(t) {
    const upTo = t >= this.t1 ? Infinity : this._fi(t);
    const { settle, sweep, key } = this._hooks(t);
    // a finished, unchanging sheet is not rendered again (most of the hold, without the hooks)
    const k = `${upTo}|${key}`;
    if (k !== this.sheetKey || !this.sheet) {
      this.sheet = this.renderer.renderToTexture(upTo, { settle });
      this.sheetKey = k;
    }
    return { sheet: this.sheet, sweep };
  }

  _drawCinematic(i, g) {
    const { W, H, side, sceneLib: lib } = this;
    const t = i / this.fps;
    const { sheet, sweep } = this._sheet(t);
    if (!sheet) throw Object.assign(new Error('The graphics context was lost'), { code: 'encode' });
    const cam = this.plan.at(t);
    const basis = lib.cameraBasis(cam, W, H, side);
    this.scene.render({ sheet, basis, focus: [cam.fx, cam.fy], reveal: this._reveal(t), light: sweep });
    g.drawImage(this.canvas, 0, 0, W, H);
    // The tool is drawn in the desk plane's local frame at its tip: it scales with the perspective
    // and turns with the camera, and its shadow falls away from the window like the sheet's. The
    // context gets the rotation only and the size carries the scale, because tools.js pads its
    // layers in user units.
    if (this.showTool && this.tools) {
      const p = this.toolPose(t);
      const [a, b] = lib.planeTransform(basis, p.x, p.y);
      const sc = Math.hypot(a, b), ca = a / sc, sa = b / sc;
      g.save();
      g.setTransform(ca, sa, -sa, ca, 0, 0);
      this._drawTool(g, t, {
        toCtx: (x, y) => { const q = lib.project(basis, x, y); return [ca * q[0] + sa * q[1], -sa * q[0] + ca * q[1]]; },
        size: TOOL_LEN * sc,
      });
      g.restore();
    }
  }

  /**
   * Extra encodeVideo options: the cinematic film asks for a keyframe on the frame where the camera
   * comes to rest, so the final reveal starts from a clean picture. Encoders that barely refine a
   * still image after motion (Firefox's Media Foundation H.264) otherwise keep the move's softness,
   * and even stale blocks, for the whole hold; more bitrate does not cure that (measured).
   * `keyFrames` (frame indices) is ignored by an encoder that does not support it.
   */
  encodeHints() {
    return this.style === 'cinematic' ? { keyFrames: [Math.ceil(this.restAt * this.fps)] } : {};
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
export function createFilmDialog(app) {
  const $ = id => document.getElementById(id);
  const dlg = $('filmDialog');
  const f = app.prefs.film;
  if (!STYLES.includes(f.style)) f.style = 'cinematic';
  if (!FPS_CHOICES.includes(+f.fps)) f.fps = f.style === 'cinematic' ? 60 : 30;
  const previewCanvas = $('filmPreview');
  const video = $('filmVideo');
  let preview = null, previewRaf = 0, previewStart = 0;
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

  const segs = {
    format: bindSeg(dlg.querySelector('[data-film="format"]'), f.format, v => { f.format = v; app.persist(); reprobe(); }),
    length: bindSeg(dlg.querySelector('[data-film="length"]'), String(f.length), v => { f.length = +v; app.persist(); refresh(); app.refreshTransport(); }),
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
  for (const key of ['showTool', 'polaroid', 'reveal']) {
    const el = dlg.querySelector(`[data-film="${key}"]`);
    el.checked = !!f[key];
    el.addEventListener('change', () => { f[key] = el.checked; app.persist(); refresh(); app.refreshTransport(); });
  }

  function currentFormat() { return FORMATS[f.format] || FORMATS.square; }
  const fps = () => (FPS_CHOICES.includes(+f.fps) ? +f.fps : FPS);

  function filmGeometry(side) {
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

  function composerFor(W, H, { live = false } = {}) {
    const fmt = currentFormat();
    return new FilmComposer({
      W, H, format: f.format, length: f.length, showTool: f.showTool, polaroid: f.polaroid, reveal: f.reveal,
      pacing: app.prefs.pacing, state: snapshotState(fmt.w === W ? Math.min(W, H) * 0.86 : Math.min(fmt.w, fmt.h) * 0.86),
      drawPhoto: app.photo ? (g, cx, cy, R) => app.drawPhotoInCircle(g, cx, cy, R) : null,
      tools: modules?.tools, sceneLib: modules?.scene, style: f.style,
      // the camera is planned in seconds, so a 30 fps preview shows the same shot as the film
      fps: live ? 30 : fps(),
    });
  }

  function summary() {
    const fmt = currentFormat();
    const rate = fps();
    const mbps = (fmt.w * fmt.h >= 1920 * 1080 ? 12 : fmt.h === 1350 ? 9 : 8) * Math.pow(rate / 30, 0.6);
    // a moving camera changes every pixel of every frame, so it uses nearly all of its bitrate
    const mb = Math.round(mbps * f.length / 8 * (f.style === 'cinematic' ? 0.92 : 0.7));
    const engine = modules?.probe;
    const container = engine?.webcodecs ? 'MP4' : engine?.recorder ? engine.recorder.ext.toUpperCase() : null;
    $('filmSummary').textContent = container
      ? `${container} · ${fmt.w} × ${fmt.h} · ${rate} fps · about ${Math.max(1, mb)} MB`
      : `${fmt.w} × ${fmt.h} · ${rate} fps`;
    $('filmGoLabel').textContent = `Film ${f.length}-second video`;
    const note = $('filmEngineNote');
    if (engine && !engine.webcodecs && engine.recorder) note.textContent = `This browser records in real time — filming takes ${f.length} s. Keep this tab open.`;
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
      preview = composerFor(W, H, { live: true });
      preview.prepare();
    } catch (e) { console.warn(e); preview = null; return; }
    previewStart = performance.now();
    const g = previewCanvas.getContext('2d');
    let lastFrame = -1;
    const loop = now => {
      previewRaf = requestAnimationFrame(loop);
      const t = ((now - previewStart) / 1000) % preview.length;
      const i = Math.floor(t * preview.fps);
      if (i === lastFrame) return;
      if (i < lastFrame) preview.rewind();
      lastFrame = i;
      try { preview.draw(i, g); } catch (e) { console.warn(e); cancelAnimationFrame(previewRaf); }
    };
    if (reducedMotion()) preview.draw(Math.round(preview.frames * 0.6), g);
    else previewRaf = requestAnimationFrame(loop);
  }
  function stopPreview() {
    cancelAnimationFrame(previewRaf);
    preview?.destroy();
    preview = null;
  }

  function refresh() {
    segs.pacing.set(app.prefs.pacing);
    segs.start.set(app.doc.line.start);
    segs.style.set(f.style);
    segs.fps.set(String(fps()));
    summary();
    const fmt = currentFormat();
    filmGeometry(Math.min(fmt.w, fmt.h) * 0.86);
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
    app.pause();
    clearResult();
    showView('setup');
    dlg.showModal();
    await loadModules();
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
    abort = new AbortController();
    let wake = null;
    try { wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
    const composer = composerFor(W, H);
    composer.tools = tools;
    const t0 = performance.now();
    let lastUi = 0;
    const g2 = previewCanvas.getContext('2d');
    try {
      composer.prepare();
      const prepMs = performance.now() - t0;
      const res = await encoder.encodeVideo({
        width: W, height: H, fps: composer.fps, frames: composer.frames, signal: abort.signal,
        ...composer.encodeHints(),
        drawFrame: (i, ctx) => composer.draw(i, ctx),
        onProgress: (done, total, canvas) => {
          const now = performance.now();
          if (now - lastUi < 100 && done < total) return;
          lastUi = now;
          const pct = Math.round(done / total * 100);
          $('filmBar').style.width = `${pct}%`;
          $('filmPct').textContent = `Filming… ${pct}%`;
          const el = (now - t0) / 1000;
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
      };
      result = res;
      showResult(res, W, H);
    } catch (e) {
      if (e?.code === 'aborted' || abort.signal.aborted) {
        toast('Filming stopped.');
        showView('setup'); startPreview();
      } else if (scaleDown === 1) {
        console.warn('film failed, retrying smaller', e);
        toast('That was too much for this device — trying a smaller video.');
        composer.destroy();
        return go(2 / 3);
      } else {
        console.error(e);
        toast('Filming stopped — this device ran out of video memory. Try Square or a shorter length.', { error: true });
        showView('setup'); startPreview();
      }
    } finally {
      composer.destroy();
      try { await wake?.release(); } catch { /* ignore */ }
      abort = null;
    }
  }

  function fileBase() {
    const name = (app.photo?.name || 'drawing').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'drawing';
    return `spiralist-${name}-${app.lookName().toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${f.length}s`;
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
  const close = () => { abort?.abort(); stopPreview(); clearResult(); dlg.close(); };
  $('filmClose').addEventListener('click', close);
  dlg.querySelector('[data-close]').addEventListener('click', close);
  dlg.addEventListener('cancel', e => {
    // Escape while filming stops the take instead of silently closing
    if (abort) { e.preventDefault(); abort.abort(); return; }
    stopPreview(); clearResult();
  });
  dlg.addEventListener('close', () => { stopPreview(); });

  return { open };
}
