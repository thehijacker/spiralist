// WebGL2 renderer: paper + one continuous line, lit like a real sheet on a desk.
//
//   sheet pass     instanced round-capped segments (distance field), MAX-blended so the line
//                  never darkens where consecutive segments overlap; drawn incrementally so
//                  playback / filming only draws the new part of the line each frame. Two targets
//                  (MRT): pigment, and the surface the medium leaves (groove depth, raised
//                  material, sheen, pen time). A fractional index also draws the pen's partial
//                  segment up to the interpolated head, so playback advances continuously.
//   wet media      (brush.wetness > 0) a sheet-space simulation on a fixed grid (js/wetsim.js):
//                  water, suspended and deposited pigment, paper moisture. It advances with the
//                  drawing's pacing time, a fixed number of steps over the whole drawing, so any
//                  render(upTo) is a pure, incremental function of progress.
//   glow pass      (neon) pigment mip -> separable Gaussian at quarter resolution.
//   composite      lit paper (tooth relief), the medium's relief (grooves, raised material),
//                  pigment + simulated bleed, specular per material (graphite sheen, wax gloss,
//                  metal flake glints, wet highlights), glow -> canvas.
//
// Layout is given in fractions of the paper WIDTH: { cx, cy, r } (circle centre and radius).
// The render target is normally the whole paper; for very large exports it can be a strip of
// it (setPaperSize + setOrigin), with identical output because every texture is in paper space
// (the wet simulation too: it runs once per sheet, whatever the strip).

import {
  VERT_FULL, FRAG_PAPER_TILE, FRAG_PAPER_PHYS, VERT_STROKE, FRAG_STROKE, FRAG_COMPOSITE, FRAG_BLUR,
  TILES_ACROSS, TILE_SIZE, SURF_UNIT_U, MATERIALS,
} from './shaders.js';
import { STRIDE, pacingTable } from './spiral.js';
import { hexToRgb, BRUSHES, PAPERS, LOOKS, brushById, paperById } from './materials.js';
import { brushWet } from './brushes.js';
import { paperPhysics } from './papers.js';
import { WetSim, WET_GRID, STEPS_DRAW, STEPS_SETTLE, FRAG_WET_STEP, wetParams, wetMobile, poolGrow, dyeSheen, fibreHair, cockleHeight, feedDeficit } from './wetsim.js';

const COMPLETION_STATUS_KHR = 0x91B1;

const BYTES = STRIDE * 4;
const DEG = Math.PI / 180;
// The sheet width every physical size in the shaders is calibrated on (setSheetMm's default).
const REF_SHEET_MM = 210;
// The default key light: soft window light from the upper left (the look every still was tuned
// under). Azimuth is the direction TOWARD the light on the sheet (x right, y down), radians.
const LIGHT0 = { azimuth: Math.atan2(-0.65, -0.55), elevation: 40 * DEG, intensity: 1, warmth: 0 };
const PAPER_LIGHT0 = Math.hypot(0.55, 0.65);       // papers.js relief gain under LIGHT0
const cot = a => Math.cos(a) / Math.sin(a);

/**
 * Signed curvature of the line at every point, in 1 / circle units (turning toward +y of the sheet
 * from +x is positive): the turning angle between the two segments at a point over their mean
 * length, lightly smoothed so one uneven point does not flicker. Ends copy their neighbour.
 */
export function curvatures(g) {
  const n = g.n, d = g.data, k = new Float32Array(n);
  for (let i = 1; i < n - 1; i++) {
    const a = (i - 1) * STRIDE, b = i * STRIDE, c = (i + 1) * STRIDE;
    const ax = d[b] - d[a], ay = d[b + 1] - d[a + 1], bx = d[c] - d[b], by = d[c + 1] - d[b + 1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    k[i] = la > 1e-9 && lb > 1e-9 ? Math.atan2(ax * by - ay * bx, ax * bx + ay * by) / (0.5 * (la + lb)) : 0;
  }
  if (n > 2) { k[0] = k[1]; k[n - 1] = k[n - 2]; }
  const o = Float32Array.from(k);
  for (let i = 1; i < n - 1; i++) o[i] = 0.25 * k[i - 1] + 0.5 * k[i] + 0.25 * k[i + 1];
  return o;
}

export function webgl2Available() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    const ok = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch { return false; }
}

export class Renderer {
  /**
   * @param canvas HTMLCanvasElement | OffscreenCanvas
   * @param opts { onLost?: () => void, onRestored?: () => void, warmup?: boolean, block?: boolean }
   *   warmup (default false; the app's stage turns it on): after the first render, compile the
   *   other media's programs in the background where the browser can do that off this thread
   *   (see _warmup). Exports, films and the chips draw one medium and do not need it.
   *   block (default true): a render compiles what it needs on the spot, waiting for it. With
   *   block: false (the app's stage and chips) a render never waits for a compile where the
   *   browser compiles in parallel: it draws nothing and returns 'pending' (the canvas keeps its
   *   last image) until pending() is false; call it again on a later frame.
   *   lowMemory (default false; phones, chips): the wet grid in half floats (~40 MB, not ~70).
   *   keepCanvas (default false; the chips): a canvas already big enough is not resized (that
   *   waits for all of the context's queued GPU work); the image is then its bottom-left
   *   width x height, i.e. rows canvas.height - height .. canvas.height from the top.
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.block = opts.block !== false;
    this.s = {
      width: 0, height: 0,          // render target (canvas) size, px
      paperW: 0, paperH: 0,         // full paper size, px (defaults to the target size)
      ox: 0, oy: 0,                 // target's top-left on the paper
      fullPaper: false,             // true once setPaperSize was called explicitly
      paper: null, brush: null, ink: '#000000', cover: false, photoColor: false,
      geom: null, layout: { cx: 0.5, cy: 0.5, r: 0.42 }, seed: 1, transparent: false,
      pacing: 'natural',
      light: { ...LIGHT0, view: [0, 0, 1] },
      time: null,                   // seconds, once setTime is called (neon flicker, glints)
      sheetMm: REF_SHEET_MM,        // the sheet's physical width (setSheetMm)
    };
    this.lost = false;
    this.stats = { wetSteps: 0, wetMs: 0 };
    if (canvas.addEventListener) {
      canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.lost = true; opts.onLost?.(); });
      canvas.addEventListener('webglcontextrestored', () => { this.lost = false; this._init(); this._reapply(); opts.onRestored?.(); });
    }
    this._init();
  }

  _init() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: true, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.floatRT = !!gl.getExtension('EXT_color_buffer_float');
    this.floatLinear = !!gl.getExtension('OES_texture_float_linear');
    // compiles on the driver's own threads: status queries then wait only for that one program
    this.parallel = !!gl.getExtension('KHR_parallel_shader_compile');
    this._warmed = false;
    this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0], gl.getParameter(gl.MAX_VIEWPORT_DIMS)[1]);
    // (started here, waited for on first use: a non-blocking renderer never waits at all)
    this.progs = {
      tile: this._program(VERT_FULL, FRAG_PAPER_TILE, true),
      blur: this._program(VERT_FULL, FRAG_BLUR, true),
    };
    // Framebuffer layouts found complete in this context: asking again waits for every piece of
    // GPU work queued before the question (0.1-0.8 s during a tool switch), so each is asked once.
    this.fbOk = new Set();
    // The stroke and composite programs are specialised per medium and compiled on first use (see
    // _strokeProg / _compProg). (A dev tool may still set progs.comp to force one composite.)
    this.strokeProgs = new Map();
    this.compProgs = new Map();
    this.emptyVao = gl.createVertexArray();
    this.strokeVao = gl.createVertexArray();
    this.pointBuf = gl.createBuffer();
    this.colorBuf = gl.createBuffer();
    this.paceBuf = gl.createBuffer();
    this.feedBuf = gl.createBuffer();   // the pen's ink supply per point (wetsim.js feedDeficit)
    this.uploaded = 0;          // points in the GPU buffer
    this.hasColors = false;
    this.paperKey = null;
    this.tileKey = null;        // the paper the tile texture holds (drawn when its program is ready)
    this.tileTex = null;
    this.pig = null; this.surf = null; this.sheetFbo = null; this.glowA = null; this.glowB = null;
    this.drawn = 0;             // whole segments currently in the sheet targets
    this.lastUpTo = -1;         // the head (fractional index) last drawn
    this.dirty = true;          // the sheet targets must be redrawn from scratch
    this.gen = 0;               // bumped when what the line looks like changes (every view redraws)
    this.viewGen = -1;          // the generation the current view's targets were drawn at
    this.sheetTex = null;       // renderToTexture's output (a texture of a lost context is dead)
    this.rectView = null;       // renderToTexture({ rect }): its own targets, drawn in the same sheet
    this.sim = null;            // WetSim, created for the first wet medium
    this.simDirty = true;       // injection map / schedule out of date
    this.simOff = false;        // this device cannot run it (falls back to dry rendering)
    this._makeTile();
    this._probeWet();
  }

  /**
   * Settle the wet grid's formats now, on a tiny grid, while nothing is queued: which float
   * formats this device renders to is only known by asking, and later (the first wet tool, often
   * mid-switch) the question would wait behind whatever the GPU is busy with.
   */
  _probeWet() {
    if (this.simOff || this.gl.isContextLost()) return;
    try {
      this.sim = new WetSim(this.gl, { vertFull: VERT_FULL, floatRT: this.floatRT, floatLinear: this.floatLinear, half: !!this.opts.lowMemory });
      if (!this.sim.alloc(8, 8)) { this.simOff = true; this.sim = null; return; }
      this.sim.free();
    } catch (e) { console.warn('Spiralist: wet media simulation unavailable', e); this.simOff = true; this.sim = null; }
  }

  _reapply() {
    const s = this.s;
    this.paperKey = null;
    this.gen++;
    if (s.width && s.height) this._allocTargets(s.width, s.height);
    if (s.paper) this.setPaper(s.paper, s.seed);
    if (s.geom) this.setGeometry(s.geom);
    this.dirty = true; this.simDirty = true;
  }

  // ---------------------------------------------------------------------------------- setup
  _shader(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  }

  /**
   * Compile and link. lazy = true (the per-medium programs) leaves the status check to the first
   * use (_ready) where the browser compiles in parallel (KHR_parallel_shader_compile): asking for
   * a status blocks this thread until the driver is done, which a background warm-up must not do.
   */
  _program(vs, fs, lazy = false) {
    const gl = this.gl;
    const p = gl.createProgram();
    const v = this._shader(gl.VERTEX_SHADER, vs), f = this._shader(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    p._u = new Map();
    p._src = [[v, vs], [f, fs]];
    if (lazy && this.parallel) { p._pending = true; return p; }
    return this._ready(p);
  }

  /** Throw (with the shader log) if p failed to build; once per program. */
  _ready(p) {
    const gl = this.gl;
    if (p._src) {
      if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
        for (const [sh, src] of p._src) {
          if (gl.getShaderParameter(sh, gl.COMPILE_STATUS)) continue;
          const log = gl.getShaderInfoLog(sh);
          console.error(log + '\n' + src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));
          throw new Error('Shader compile failed: ' + log);
        }
        throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
      }
      p._src = null;
    }
    p._pending = false;
    return p;
  }

  /**
   * The stroke program for a medium (default: the current one). The brush's shader id is a
   * compile-time constant, so the GPU compiler drops every other medium's branch as dead code: one
   * program holding all twelve media took ~6 s to compile on D3D11 (ANGLE, the Windows default),
   * one medium 0.15-1 s, and each is only compiled when the medium is first drawn (or warmed up in
   * the background, _warmup). (uBrush then has no location, and setting it is a no-op.)
   */
  _strokeProg(brush = this.s.brush, lazy = false) {
    const id = (brush?.shader ?? 0) | 0;
    let p = this.strokeProgs.get(id);
    if (!p) {
      p = this._program(VERT_STROKE, FRAG_STROKE.replace('uniform int uBrush;', `const int uBrush = ${id};`), lazy);
      this.strokeProgs.set(id, p);
    }
    return lazy ? p : this._ready(p);
  }

  /**
   * The composite program for a medium's material, with or without the wet layer, and with the
   * chalkboard's eraser haze and the blueprint grid only for the papers that have them (the haze
   * alone was over half the composite's ~2-3.5 s compile). Same reasons as _strokeProg.
   */
  _compKey(wetOn, brush, paper) {
    const m = (MATERIALS[brush?.material] ?? MATERIALS.ink) | 0;
    return `${m}|${wetOn ? 1 : 0}|${+((paper?.smudge || 0) > 0)}|${+((paper?.grid || 0) > 0)}`;
  }

  _compProg(wetOn, brush = this.s.brush, paper = this.s.paper, lazy = false) {
    if (this.progs.comp) return this.progs.comp;
    const m = (MATERIALS[brush?.material] ?? MATERIALS.ink) | 0, w = wetOn ? 1 : 0;
    const smudge = (paper?.smudge || 0) > 0, grid = (paper?.grid || 0) > 0;
    const key = this._compKey(wetOn, brush, paper);
    let p = this.compProgs.get(key);
    if (!p) {
      let src = FRAG_COMPOSITE.replace('uniform int uMaterial;', `const int uMaterial = ${m};`)
        .replace('uniform int uSimOn;', `const int uSimOn = ${w};`);
      if (!smudge) src = src.replace('uniform float uSmudge;', 'const float uSmudge = 0.0;');
      if (!grid) src = src.replace('uniform float uGrid;', 'const float uGrid = 0.0;');
      p = this._program(VERT_FULL, src, lazy);
      this.compProgs.set(key, p);
    }
    return lazy ? p : this._ready(p);
  }

  /** The paper's physical map (wet media only). */
  _physProg(lazy = false) {
    const p = this.progs.phys || (this.progs.phys = this._program(VERT_FULL, FRAG_PAPER_PHYS, lazy));
    return lazy ? p : this._ready(p);
  }

  /** The wet simulation's step (the renderer owns it, so it is started early and outlives a WetSim). */
  _wetProg(lazy = false) {
    const p = this.progs.wet || (this.progs.wet = this._program(VERT_FULL, FRAG_WET_STEP, lazy));
    return lazy ? p : this._ready(p);
  }

  /** Is p still compiling? Only a lazily started program on a parallel-compiling browser can be. */
  _busy(p) {
    if (!p || !p._pending) return false;
    if (!this.gl.getProgramParameter(p, COMPLETION_STATUS_KHR) && !this.gl.isContextLost()) return true;
    this._ready(p);                 // done: check it built (throws with the log if not)
    return false;
  }

  /**
   * Would drawing (brush, paper) now wait for a shader compile? Starts every program that needs
   * (on the driver's own threads where the browser compiles in parallel) and answers at once.
   * Always false without KHR_parallel_shader_compile: there asking IS the compile, so programs
   * are built on first use as before.
   */
  pending(brush = this.s.brush, paper = this.s.paper, start = true) {
    if (!this.parallel || this.lost || !brush || !paper) return false;
    // start = false only looks: a program not made yet counts as pending, and is not started
    // (a caller with many styles to draw starts a few at a time rather than flood the compiler)
    if (!start && !this._made(brush, paper)) return true;
    const need = [this.progs.tile, this._strokeProg(brush, true), this._compProg(false, brush, paper, true)];
    if (brush.glow) need.push(this.progs.blur);
    if (brushWet(brush) && !this.simOff) need.push(this._compProg(true, brush, paper, true), this._physProg(true), this._wetProg(true));
    let busy = false;
    for (const p of need) if (this._busy(p)) busy = true;     // (no early out: each one is started)
    return busy;
  }

  /** Have (brush, paper)'s programs been made (built or compiling)? */
  _made(brush, paper) {
    if (!this.strokeProgs.has((brush?.shader ?? 0) | 0)) return false;
    if (this.progs.comp) return true;
    if (!this.compProgs.has(this._compKey(false, brush, paper))) return false;
    if (!brushWet(brush) || this.simOff) return true;
    return !!(this.progs.phys && this.progs.wet && this.compProgs.has(this._compKey(true, brush, paper)));
  }

  /**
   * Where the browser compiles in parallel, start every medium's programs in the background once
   * the first sheet is on screen (the current style first), so switching tools never waits for a
   * compile. Without the extension a compile would block, so programs are then only built when
   * first drawn.
   */
  _warmup() {
    if (this._warmed || !this.parallel || this.lost) return;
    this._warmed = true;
    // the combinations the app shows: every tool on this paper (and dark-paper tools on black),
    // this tool on every paper, and every Look
    const pairs = [[this.s.brush, this.s.paper]];
    for (const b of BRUSHES) pairs.push([b, this.s.paper], [b, b.prefersDark ? paperById('black') : this.s.paper]);
    for (const pp of PAPERS) pairs.push([this.s.brush, pp]);
    for (const l of LOOKS) pairs.push([brushById(l.brush), paperById(l.paper)]);
    const jobs = [() => this._physProg(true), () => this._wetProg(true)];
    for (const [b, pp] of pairs) {
      if (!b || !pp) continue;
      jobs.push(() => this._strokeProg(b, true));
      jobs.push(() => this._compProg(false, b, pp, true));
      if (brushWet(b)) jobs.push(() => this._compProg(true, b, pp, true));
    }
    // Unhurried: one new program every 80 ms, after a second. Creating one is cheap here (the
    // compile runs on the driver's threads), but those threads are shared by every context of the
    // page: a burst of dozens would queue in front of what the user asks for next (the film's
    // scene, a chip, the tool just picked). Programs already made are skipped at once.
    const next = () => {
      if (this.lost || this.gl.isContextLost()) return;
      const n0 = this.strokeProgs.size + this.compProgs.size;
      while (jobs.length && this.strokeProgs.size + this.compProgs.size === n0) jobs.shift()();
      if (jobs.length) setTimeout(next, 80);
    };
    setTimeout(next, 1000);
  }

  _u(p, name) {
    let loc = p._u.get(name);
    if (loc === undefined) { loc = this.gl.getUniformLocation(p, name); p._u.set(name, loc); }
    return loc;
  }

  _tex(w, h, { internal, format, type, filter, mips = false, wrap }) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const key = `tex:${internal}`;
    const ok = this.fbOk.has(key) || gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    if (ok) this.fbOk.add(key);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex: t, fbo, w, h, ok };
  }

  _freeTarget(t) {
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }

  _makeTile() {
    const gl = this.gl;
    const base = { filter: gl.LINEAR, mips: true, wrap: gl.REPEAT };
    let t = null;
    if (this.floatRT) {
      t = this._tex(TILE_SIZE, TILE_SIZE, { ...base, internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT });
      if (!t.ok) { this._freeTarget(t); t = null; }
    }
    if (!t) t = this._tex(TILE_SIZE, TILE_SIZE, { ...base, internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE });
    this.tileTex = t;
  }

  _allocTargets(w, h) {
    const gl = this.gl;
    // (the view's output texture too: it is the old size, and a sheet-sized one is a lot of memory)
    for (const t of [this.pig, this.surf, this.glowA, this.glowB, this.sheetTex]) this._freeTarget(t);
    this.sheetTex = null;
    if (this.sheetFbo) gl.deleteFramebuffer(this.sheetFbo);
    const lin = { format: gl.RGBA, filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE };
    this.pig = this._tex(w, h, { ...lin, internal: gl.RGBA8, type: gl.UNSIGNED_BYTE });
    // The surface target carries the pen time (for the wet layer), which wants more than 8 bits.
    const mrt = (surf, key) => {
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pig.tex, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, surf.tex, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      const ok = this.fbOk.has(key) || gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      if (ok) this.fbOk.add(key);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!ok) gl.deleteFramebuffer(fbo);
      return ok ? fbo : null;
    };
    this.surf = null; this.sheetFbo = null;
    if (this.floatRT) {
      this.surf = this._tex(w, h, { ...lin, internal: gl.RGBA16F, type: gl.HALF_FLOAT });
      this.sheetFbo = this.surf.ok ? mrt(this.surf, 'mrt:f16') : null;
      if (!this.sheetFbo) { this._freeTarget(this.surf); this.surf = null; }
    }
    if (!this.surf) {
      this.surf = this._tex(w, h, { ...lin, internal: gl.RGBA8, type: gl.UNSIGNED_BYTE });
      this.sheetFbo = mrt(this.surf, 'mrt:8');
    }
    this.pigMips = false;
    const gw = Math.max(1, Math.ceil(w / 4)), gh = Math.max(1, Math.ceil(h / 4));
    this.glowA = this._tex(gw, gh, { ...lin, internal: gl.RGBA8, type: gl.UNSIGNED_BYTE });
    this.glowB = this._tex(gw, gh, { ...lin, internal: gl.RGBA8, type: gl.UNSIGNED_BYTE });
    this.dirty = true;
  }

  // ---------------------------------------------------------------------------------- state
  /** Render target (canvas) size in pixels; also the paper size unless setPaperSize was used. */
  setSize(width, height) {
    const w = Math.max(1, Math.min(this.maxSize, Math.round(width)));
    const h = Math.max(1, Math.min(this.maxSize, Math.round(height)));
    if (!this.s.fullPaper) this._paperDims(w, h);
    if (w === this.s.width && h === this.s.height && this.pig) return;
    this.s.width = w; this.s.height = h;
    if (!this.opts.keepCanvas) { this.canvas.width = w; this.canvas.height = h; }
    else if (this.canvas.width < w || this.canvas.height < h) {
      // (only ever grows, so chips of a few sizes settle on one canvas)
      this.canvas.width = Math.max(this.canvas.width, w); this.canvas.height = Math.max(this.canvas.height, h);
    }
    this._allocTargets(w, h);
  }

  _paperDims(w, h) {
    const s = this.s;
    if (s.paperW === w && s.paperH === h) return;
    // the wet grid follows the sheet's aspect, not its pixel size
    if (!s.paperW || Math.round(WET_GRID * h / w) !== Math.round(WET_GRID * s.paperH / s.paperW)) this.simDirty = true;
    s.paperW = w; s.paperH = h;
    this.gridH = Math.max(1, Math.round(WET_GRID * h / w));
    this.dirty = true;
  }

  /** Full paper size in px when the target is only part of it (strip rendering). */
  setPaperSize(width, height) {
    this.s.fullPaper = true;
    this._paperDims(width, height);
  }

  /** Top-left of the render target on the paper, px. */
  setOrigin(x, y) {
    if (this.s.ox === x && this.s.oy === y) return;
    this.s.ox = x; this.s.oy = y;
    this.dirty = true;          // (the wet simulation is in sheet space and stays)
  }

  setLayout(layout) {
    const l = this.s.layout;
    if (l.cx === layout.cx && l.cy === layout.cy && l.r === layout.r) return;
    this.s.layout = { ...layout };
    this.dirty = true; this.simDirty = true; this.gen++;
  }

  setPaper(paper, seed = 1) {
    this.s.paper = paper; this.s.seed = seed;
    const key = paper.id + ':' + seed;
    if (key === this.paperKey) return;
    this.paperKey = key;
    this.dirty = true;     // brushes read the grain
    this.simDirty = true;  // and so does the sheet's physical map
    this.gen++;
    // the tile now, unless a non-blocking renderer would wait for its program: then on the
    // first render after it is ready (_drawTile)
    if (!(!this.block && this._busy(this.progs.tile))) this._drawTile();
  }

  /** Draw the paper tile for the current paper, if it does not hold it yet. */
  _drawTile() {
    const paper = this.s.paper;
    if (!paper || this.tileKey === this.paperKey) return;
    const seed = this.s.seed;
    const gl = this.gl, p = this._ready(this.progs.tile), t = this.tileTex;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, TILE_SIZE, TILE_SIZE);
    gl.disable(gl.BLEND);
    gl.useProgram(p);
    gl.uniform1f(this._u(p, 'uSeed'), seed);
    gl.uniform1f(this._u(p, 'uTooth'), paper.tooth);
    gl.uniform1f(this._u(p, 'uToothCells'), paper.toothCells);
    gl.uniform1f(this._u(p, 'uBumps'), paper.bumps);
    gl.uniform1f(this._u(p, 'uBumpCells'), paper.bumpCells || 1);
    gl.uniform1f(this._u(p, 'uFibers'), paper.fibers);
    gl.uniform1f(this._u(p, 'uSpecks'), paper.specks);
    gl.uniform1f(this._u(p, 'uLaid'), paper.laid || 0);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.tileKey = this.paperKey;
  }

  /** brush: BRUSHES entry, ink: '#rrggbb', cover: bool, photoColor: bool */
  setStyle({ brush, ink, cover, photoColor }) {
    const s = this.s;
    if (s.brush === brush && s.ink === ink && s.cover === cover && s.photoColor === !!photoColor) return;
    if (s.brush !== brush || s.photoColor !== !!photoColor) this.simDirty = true;
    // a dry medium does not need the wet grid: give its GPU memory back
    if (s.brush !== brush && !brushWet(brush)) this.freeSim();
    s.brush = brush; s.ink = ink; s.cover = cover; s.photoColor = !!photoColor;
    this.dirty = true; this.gen++;
  }

  /**
   * Free the wet simulation's grid (about 70 MB of GPU memory at 1024 cells in float32). The next
   * wet render allocates it again and runs it from the start. For a renderer that shows a dry
   * medium or sits idle (the chips once drawn, the film stage between films).
   */
  freeSim() {
    if (!this.sim || this.lost || this.gl.isContextLost()) return;
    this.sim.free();
    this.simDirty = true;
  }

  setTransparent(on) { this.s.transparent = !!on; }

  /**
   * The key light. Either { azimuth, elevation } in RADIANS (azimuth = direction toward the light
   * on the sheet, x right / y down, so the default upper-left window is about -2.27; elevation
   * above the sheet, default 40 degrees) or a unit direction toward the light ([x, y, z] or
   * {x, y, z}, same axes, z up). Also: intensity (1), warmth (-1 cool .. 0 neutral .. 1 warm),
   * view (direction toward the camera, default straight above: [0, 0, 1]), and optionally eye:
   * the camera's position [x, y, z] in sheet widths (x, y across / down the sheet from its top-left
   * corner, z height above it). With eye every pixel sees the camera from its own angle, so a wet
   * glint or a gold flake flash is a local highlight that travels as the camera moves (with view
   * alone a flat wet film is lit all at once or not at all). eye overrides view for the specular.
   * Only the composite changes: calling this every frame is cheap. setLight() restores the default.
   */
  setLight(o) {
    o = o || {};
    const L = { ...LIGHT0, view: [0, 0, 1] };
    const vec = Array.isArray(o) ? o : (Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z) ? [o.x, o.y, o.z] : null);
    if (Number.isFinite(o.azimuth)) L.azimuth = +o.azimuth;
    if (Number.isFinite(o.elevation)) L.elevation = +o.elevation;
    if (vec && !(Number.isFinite(o.azimuth) && Number.isFinite(o.elevation))) {
      const n = Math.hypot(vec[0], vec[1], vec[2]) || 1;
      L.azimuth = Math.atan2(vec[1], vec[0]);
      L.elevation = Math.asin(Math.max(-1, Math.min(1, vec[2] / n)));
    }
    L.elevation = Math.max(5 * DEG, Math.min(89 * DEG, L.elevation));
    if (Number.isFinite(o.intensity)) L.intensity = Math.max(0, o.intensity);
    if (Number.isFinite(o.warmth)) L.warmth = Math.max(-1, Math.min(1, o.warmth));
    const v = o.view;
    if (v && v.length === 3) { const n = Math.hypot(v[0], v[1], v[2]) || 1; L.view = [v[0] / n, v[1] / n, Math.max(0.05, v[2] / n)]; }
    const e = o.eye;
    L.eye = e && e.length === 3 && e.every(Number.isFinite) && e[2] > 0 ? [+e[0], +e[1], +e[2]] : null;
    this.s.light = L;
  }

  /**
   * The sheet's physical width in mm (default 210: today's look exactly). Paper grain, tooth, felt
   * marks, flocs and cockle, the fibres, a charcoal's grit, a crayon's crumbs, chalk powder, the
   * feathering hairs and the wet simulation's transport all keep their real millimetre size, so a
   * 1 m sheet shows grain five times finer (relative to the sheet) than an A4 one, not the same
   * grain blown up. The line's own width is the geometry's (the Realistic generators size it from
   * the tool's real width). Redraws everything on change.
   */
  setSheetMm(mm) {
    mm = Number.isFinite(+mm) && +mm > 0 ? Math.max(20, Math.min(3000, +mm)) : REF_SHEET_MM;
    if (mm === this.s.sheetMm) return;
    this.s.sheetMm = mm;
    this.dirty = true; this.simDirty = true; this.gen++;
    if (this.sim) this.sim.physKey = null;
  }

  /** Physical scale: 1 on the 210 mm reference sheet, 0.21 on a 1 m sheet (texture sizes / sheet). */
  get physK() { return REF_SHEET_MM / (this.s.sheetMm || REF_SHEET_MM); }

  /** Scene time in seconds (neon flicker); null turns it off (stills). Composite only. */
  setTime(seconds) { this.s.time = Number.isFinite(seconds) ? +seconds : null; }

  /**
   * Which pacing times the drawing ('natural' | 'steady' | 'rings', spiral.js). The wet
   * simulation advances by pacing time, so a film should pass the pacing it plays with.
   */
  setPacing(pacing = 'natural') {
    if (pacing === this.s.pacing) return;
    this.s.pacing = pacing;
    if (this.s.geom) this._uploadPace();
  }

  /** geom from buildSpiral / buildMaze / buildWander / buildContour; opts { pacing } */
  setGeometry(geom, opts = {}) {
    const gl = this.gl;
    this.s.geom = geom;
    if (opts.pacing) this.s.pacing = opts.pacing;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
    gl.bufferData(gl.ARRAY_BUFFER, geom.data, gl.STATIC_DRAW);
    this.hasColors = !!geom.colors;
    if (geom.colors) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuf);
      gl.bufferData(gl.ARRAY_BUFFER, geom.colors, gl.STATIC_DRAW);
    }
    // how far the pen's feed has fallen behind along the line (a function of the geometry only)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.feedBuf);
    gl.bufferData(gl.ARRAY_BUFFER, feedDeficit(geom, geom.technique === 'wave' ? 0.4 : 0.65), gl.STATIC_DRAW);
    this.uploaded = geom.n;
    this.simClockSrc = null;      // (a clock is in this geometry's point indices)
    this._uploadPace();
  }

  /**
   * The wet simulation's clock. By default its STEPS_DRAW steps are spread over the drawing by
   * pen time, so each stretch of line gets steps in proportion to how long the hand spends on it.
   * A film that lingers on part of the drawing (its macro opening shows the first turns, ~1% of
   * the line, for a second and a half) passes its own clock, so the fresh ink there has the time
   * to soak in, bleed and start to dry on screen, as it would under a real camera.
   *   clock = { at: point indices (fractional, increasing), v: clock time 0..1 at each, mix: 0..1 }
   * The simulation then runs on mix * v + (1 - mix) * pen time; null = pen time. It stays a pure
   * function of drawing progress (incremental == fresh). Set it after setGeometry / setPacing.
   */
  setSimClock(clock) {
    this.simClockSrc = clock && clock.at?.length > 1 ? clock : null;
    this.simClock = null; this.simClockInv = null;
    this.simDirty = true;
  }

  /** Build the clock's lookup tables (sim time at pen time u, and back) from the current pace. */
  _buildSimClock() {
    const c = this.simClockSrc;
    this.simClock = null; this.simClockInv = null;
    if (!c || !this.pace) return;
    const mix = Math.max(0, Math.min(1, c.mix ?? 1));
    const us = [0], vs = [0];
    for (let j = 0; j < c.at.length; j++) {
      if (!Number.isFinite(c.at[j])) continue;
      const u = this._timeAt(c.at[j]), v = mix * Math.max(0, Math.min(1, c.v[j])) + (1 - mix) * u;
      // monotone in both: a sample that steps back is lifted to its predecessor
      us.push(Math.max(us[us.length - 1], u)); vs.push(Math.max(vs[vs.length - 1], v));
    }
    us.push(1); vs.push(1);
    const table = (xs, ys, M = 2048) => {
      const out = new Float64Array(M + 1);
      let s = 0;
      for (let k = 0; k <= M; k++) {
        const x = k / M;
        while (s < xs.length - 2 && xs[s + 1] < x) s++;
        const x0 = xs[s], x1 = xs[s + 1];
        out[k] = x1 > x0 ? ys[s] + (ys[s + 1] - ys[s]) * Math.max(0, Math.min(1, (x - x0) / (x1 - x0))) : ys[s + 1];
      }
      out[0] = 0; out[M] = 1;
      return out;
    };
    this.simClock = table(us, vs);
    this.simClockInv = table(vs, us);
  }

  _lut(T, x) {
    if (!T) return x;
    const M = T.length - 1, p = Math.max(0, Math.min(1, x)) * M, i = Math.min(M - 1, Math.floor(p));
    return T[i] + (T[i + 1] - T[i]) * (p - i);
  }

  /** Pacing time of every point, normalised to 0..1 (the pen time the shaders see). */
  _uploadPace() {
    const g = this.s.geom, n = g.n;
    let tn;
    try {
      const t = pacingTable(g, this.s.pacing);
      const T = t[n - 1];
      tn = new Float32Array(n);
      if (T > 0) for (let i = 0; i < n; i++) tn[i] = t[i] / T;
      else for (let i = 0; i < n; i++) tn[i] = n > 1 ? i / (n - 1) : 1;
    } catch {
      tn = new Float32Array(n);
      for (let i = 0; i < n; i++) tn[i] = n > 1 ? i / (n - 1) : 1;
    }
    if (n) tn[n - 1] = 1;
    this.pace = tn;
    // interleaved with the line's signed curvature at every point (Stroke.curv)
    const kc = curvatures(g);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.paceBuf);
    // one extra point so the last instance's (i, i+1) pair stays inside the buffer
    const buf = new Float32Array(2 * (n + 1));
    for (let i = 0; i < n; i++) { buf[2 * i] = tn[i]; buf[2 * i + 1] = kc[i]; }
    buf[2 * n] = 1; buf[2 * n + 1] = n ? kc[n - 1] : 0;
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);
    this.dirty = true; this.simDirty = true; this.gen++;
  }

  get segments() { return Math.max(0, (this.s.geom?.n || 0) - 1); }

  /** Pen time (0..1) at a fractional point index. */
  _timeAt(fi) {
    const t = this.pace, n = t?.length || 0;
    if (!n) return 0;
    if (!(fi < n - 1)) return 1;
    const i = Math.max(0, Math.floor(fi)), k = Math.max(0, Math.min(1, fi - i));
    return t[i] + (t[i + 1] - t[i]) * k;
  }

  // ---------------------------------------------------------------------------------- drawing
  _grainUniforms(p, W = this.s.paperW) {
    const gl = this.gl;
    // (on a bigger sheet every physical texture covers fewer of its px: physK < 1)
    const k = this.physK;
    const tilePx = W / TILES_ACROSS * k;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tileTex.tex);
    gl.uniform1i(this._u(p, 'uPaperTex'), 1);
    gl.uniform1f(this._u(p, 'uTilePx'), tilePx);
    gl.uniform1f(this._u(p, 'uTileLod'), Math.log2(TILE_SIZE / tilePx));
    gl.uniform1f(this._u(p, 'uPaperPx'), W);
    gl.uniform1f(this._u(p, 'uU'), W / 1000 * k);
    gl.uniform1f(this._u(p, 'uPhysPx'), W * k);
  }

  _bindSegments(i0) {
    const gl = this.gl;
    gl.bindVertexArray(this.strokeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
    const a = i0 * BYTES, b = (i0 + 1) * BYTES;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, BYTES, a); gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, BYTES, a + 16); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, BYTES, b); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, BYTES, b + 16); gl.vertexAttribDivisor(3, 1);
    if (this.hasColors) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuf);
      gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, true, 4, i0 * 4); gl.vertexAttribDivisor(4, 1);
    } else {
      gl.disableVertexAttribArray(4);
      gl.vertexAttrib4f(4, 0, 0, 0, 1);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.paceBuf);
    // (time, curvature) of points i and i+1: 4 floats from point i, stepping one point per instance
    gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 4, gl.FLOAT, false, 8, i0 * 8); gl.vertexAttribDivisor(5, 1);
    // the feed's deficit at points i and i+1 (Stroke.feed)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.feedBuf);
    gl.enableVertexAttribArray(6); gl.vertexAttribPointer(6, 2, gl.FLOAT, false, 4, i0 * 4); gl.vertexAttribDivisor(6, 1);
  }

  /**
   * Stroke uniforms shared by the sheet and inject passes. `W` = full paper width in this pass's
   * pixels (output px, or grid cells for the inject pass).
   */
  _strokeUniforms(p, { W, res, origin, pass }) {
    const gl = this.gl, s = this.s, brush = s.brush, wet = brushWet(brush);
    gl.useProgram(p);
    gl.uniform2f(this._u(p, 'uRes'), res[0], res[1]);
    gl.uniform2f(this._u(p, 'uOrigin'), origin[0], origin[1]);
    gl.uniform2f(this._u(p, 'uCenter'), s.layout.cx * W, s.layout.cy * W);
    gl.uniform1f(this._u(p, 'uRadius'), s.layout.r * W);
    gl.uniform1f(this._u(p, 'uMinW'), 1.0);
    gl.uniform1f(this._u(p, 'uSpread'), brush.spread || 1);
    gl.uniform1i(this._u(p, 'uBrush'), brush.shader);
    gl.uniform3fv(this._u(p, 'uInk'), hexToRgb(s.ink));
    gl.uniform1i(this._u(p, 'uCover'), s.cover ? 1 : 0);
    gl.uniform1i(this._u(p, 'uPhotoColor'), s.photoColor && this.hasColors ? 1 : 0);
    gl.uniform1f(this._u(p, 'uSeed'), s.seed);
    gl.uniform1f(this._u(p, 'uPaceK'), s.geom?.technique === 'wave' ? 0.4 : 0.65);
    gl.uniform1i(this._u(p, 'uPass'), pass);
    gl.uniform1f(this._u(p, 'uHeadClip'), 2.0);
    gl.uniform1f(this._u(p, 'uWetLoad'), wet ? wet.load : 0);
    gl.uniform1f(this._u(p, 'uMobile'), wet ? wetMobile(wet, paperPhysics(s.paper)) : 0);
    gl.uniform1f(this._u(p, 'uDwellK'), 0.8);
    gl.uniform1f(this._u(p, 'uPoolGrow'), wet ? poolGrow(wet, paperPhysics(s.paper)) : 0);
    // A Realistic drawing's dwell is the hand's slowness in dense passages (squiggles, scribbles: the
    // pen keeps moving at 10-30 mm/s, js/real), not a nib standing still: a moving nib does not blot.
    // Even dwell at its cap (6) is a dense zigzag, where blots read as random ink spills; the
    // passage darkens anyway where the wet line crosses itself (the simulation merges it). So a
    // Realistic line never pools (geom.real.pools = true lets a generator that marks true stops
    // with dwell opt back in).
    const realPool = s.geom?.real && !s.geom.real.pools ? 1e3 : 0;
    gl.uniform1f(this._u(p, 'uPoolAt'), wet ? wet.poolAt + realPool : 0);
    // the sheet's physics, for media that react to it in the stroke (feathering, capillary dots)
    const ph = paperPhysics(s.paper);
    gl.uniform1f(this._u(p, 'uPaperAbsorb'), ph.absorb);
    gl.uniform1f(this._u(p, 'uPaperSizing'), ph.sizing);
    gl.uniform1f(this._u(p, 'uPaperFibre'), ph.fibre);
    gl.uniform2f(this._u(p, 'uPaperGrain'), Math.cos(ph.grainDeg * DEG), Math.sin(ph.grainDeg * DEG));
    // where the line ends, in the stroke's arc-length px (geometry s is in circle units)
    const g = s.geom;
    gl.uniform1f(this._u(p, 'uLineEnd'), g && g.n ? g.data[(g.n - 1) * STRIDE + 3] * s.layout.r * W : 1e9);
    this._grainUniforms(p, W);
  }

  _drawInstances(i0, i1) {
    const gl = this.gl;
    // Chunk very long draws so a single command never monopolises the GPU.
    const CHUNK = 262144;
    for (let a = i0; a < i1; a += CHUNK) {
      const b = Math.min(i1, a + CHUNK);
      this._bindSegments(a);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b - a);
    }
  }

  /** Whole segments [i0, i1), then optionally segment i1 cut at fraction `head` (the pen). */
  _drawSegments(i0, i1, head = 0) {
    const hasHead = head > 0 && i1 < this.segments;
    if (i1 <= i0 && !hasHead) return;
    const gl = this.gl, s = this.s, p = this._strokeProg();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sheetFbo);
    gl.viewport(0, 0, s.width, s.height);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    this._strokeUniforms(p, { W: s.paperW, res: [s.width, s.height], origin: [s.ox, s.oy], pass: 0 });
    if (i1 > i0) this._drawInstances(i0, i1);
    if (hasHead) {
      gl.uniform1f(this._u(p, 'uHeadClip'), head);
      this._drawInstances(i1, i1 + 1);
    }
    gl.disable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.bindVertexArray(null);
  }

  _clearPigment() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sheetFbo);
    gl.viewport(0, 0, this.s.width, this.s.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawn = 0;
    this.lastUpTo = -1;
  }

  _glow() {
    const gl = this.gl, p = this._ready(this.progs.blur);
    gl.useProgram(p);
    gl.bindVertexArray(this.emptyVao);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this._u(p, 'uSrc'), 0);
    const gw = this.glowA.w, gh = this.glowA.h;
    const U = this.s.paperW / 1000 / 4 * this.physK;   // one paper unit in quarter-res texels
    const pass = (src, dst, down, dx, dy, radiusU) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, gw, gh);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(this._u(p, 'uDown'), down ? 1 : 0);
      const r = Math.max(0.6, radiusU * U) / 3.2;
      gl.uniform2f(this._u(p, 'uDirT'), dx * r, dy * r);          // tap step, texels
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    // radii in paper units come from the brush: glow = { amount, tight, wide }
    const cfg = this.s.brush.glow || {};
    pass(this.pig, this.glowB, true, 0, 0, 0);                    // 4x4 box downsample
    pass(this.glowB, this.glowA, false, 1, 0, cfg.tight ?? 2.0);  // tight glow
    pass(this.glowA, this.glowB, false, 0, 1, cfg.tight ?? 2.0);
    pass(this.glowB, this.glowA, false, 1, 0, cfg.wide ?? 6.0);   // wide bloom on top
    pass(this.glowA, this.glowB, false, 0, 1, cfg.wide ?? 6.0);
    return this.glowB;
  }

  // ---------------------------------------------------------------------------------- wet media
  _wetOn() {
    return !this.simOff && !!this.s.geom && this.segments > 0 && !!brushWet(this.s.brush);
  }

  /** Grid, sheet map, injection map and step schedule, rebuilt only when their inputs change. */
  _simPrepare() {
    const gl = this.gl, s = this.s;
    if (!this.sim) {
      try {
        this.sim = new WetSim(gl, { vertFull: VERT_FULL, floatRT: this.floatRT, floatLinear: this.floatLinear, half: !!this.opts.lowMemory });
      } catch (e) { console.warn('Spiralist: wet media simulation unavailable', e); this.simOff = true; return false; }
    }
    const sim = this.sim;
    sim.prog = this._wetProg();       // (the renderer's; built by now unless this renderer blocks)
    const gw = WET_GRID, gh = Math.min(this.maxSize, this.gridH || WET_GRID);
    if (!sim.alloc(gw, gh)) { this.simOff = true; return false; }
    const physKey = `${this.paperKey}|${gw}x${gh}|${s.sheetMm}`;
    if (sim.physKey !== physKey) {
      const p = this._physProg();
      const ph = paperPhysics(s.paper);
      gl.bindFramebuffer(gl.FRAMEBUFFER, sim.physFbo);
      gl.viewport(0, 0, gw, gh);
      gl.disable(gl.BLEND);
      gl.useProgram(p);
      gl.uniform2f(this._u(p, 'uGrid'), gw, gh);
      gl.uniform1f(this._u(p, 'uSeed'), s.seed);
      gl.uniform1f(this._u(p, 'uFibre'), ph.fibre);
      gl.uniform1f(this._u(p, 'uAbsorbP'), ph.absorb);
      gl.uniform2f(this._u(p, 'uGrainDir'), Math.cos(ph.grainDeg * DEG), Math.sin(ph.grainDeg * DEG));
      this._grainUniforms(p, gw);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      sim.physKey = physKey;
      this.simDirty = true;
    }
    if (this.simDirty) {
      // the liquid every stretch of the line lays down, with the pen time it arrives
      const p = this._strokeProg();
      gl.bindFramebuffer(gl.FRAMEBUFFER, sim.injFbo);
      gl.viewport(0, 0, gw, gh);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.MAX);
      gl.blendFunc(gl.ONE, gl.ONE);
      this._strokeUniforms(p, { W: gw, res: [gw, gh], origin: [0, 0], pass: 1 });
      this._drawInstances(0, this.segments);
      gl.disable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.bindVertexArray(null);
      // (the grid is fixed per sheet: on a big sheet a cell is coarser, and the transport rates per
      // cell shrink so a bleed or a wick still travels its real distance in mm)
      this.simParams = wetParams(brushWet(s.brush), paperPhysics(s.paper), this.physK);
      this._buildSimClock();
      this._simSchedule(gw, gh);
      sim.reset();
      this.simDirty = false;
    }
    return true;
  }

  /**
   * Scissor rectangle per step: the cells any liquid can have reached by then. Each step's ink
   * lands inside its segments' box; nothing moves more than one cell per step (8-neighbour
   * stencil). Outside, the grid is still clean paper and needs no work. Boxes are entered one
   * step early, which covers pen times that round across a window edge on the GPU.
   */
  _simSchedule(gw, gh) {
    const s = this.s, g = s.geom, d = g.data, n = g.n, t = this.pace;
    const N = STEPS_DRAW, NT = STEPS_DRAW + STEPS_SETTLE;
    const box = new Float32Array((N + 1) * 4);
    for (let k = 0; k <= N; k++) { box[k * 4] = box[k * 4 + 1] = Infinity; box[k * 4 + 2] = box[k * 4 + 3] = -Infinity; }
    const { cx, cy, r } = s.layout;
    const R = r * gw, spread = s.brush.spread || 1;
    // a lingering pen's pool reaches past the line (inject pass): its radius must be in the box
    const grow = poolGrow(brushWet(s.brush), paperPhysics(s.paper));
    for (let i = 0; i < n - 1; i++) {
      const k = Math.max(1, Math.min(N, Math.ceil(this._lut(this.simClock, t[i + 1]) * N - 1e-6) - 1));
      const o = k * 4;
      for (const j of [i, i + 1]) {
        const q = j * STRIDE;
        const x = cx * gw + d[q] * R, y = cy * gw + d[q + 1] * R;
        const m = d[q + 2] * R * 0.5 * Math.max(spread, 1 + grow * Math.max(0, d[q + 6] - 1)) + 3;
        if (x - m < box[o]) box[o] = x - m;
        if (y - m < box[o + 1]) box[o + 1] = y - m;
        if (x + m > box[o + 2]) box[o + 2] = x + m;
        if (y + m > box[o + 3]) box[o + 3] = y + m;
      }
    }
    const rects = new Int32Array((NT + 1) * 4);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 1; k <= NT; k++) {
      x0 -= 1; y0 -= 1; x1 += 1; y1 += 1;
      if (k <= N) {
        const o = k * 4;
        x0 = Math.min(x0, box[o]); y0 = Math.min(y0, box[o + 1]);
        x1 = Math.max(x1, box[o + 2]); y1 = Math.max(y1, box[o + 3]);
      }
      // grid rows run up (GL), the sheet's y down
      const o = k * 4;
      if (x1 < x0) { rects[o] = rects[o + 1] = rects[o + 2] = rects[o + 3] = 0; continue; }
      rects[o] = Math.max(0, Math.floor(x0));
      rects[o + 2] = Math.min(gw, Math.ceil(x1));
      rects[o + 1] = Math.max(0, Math.floor(gh - y1));
      rects[o + 3] = Math.min(gh, Math.ceil(gh - y0));
    }
    this.simRects = rects;
  }

  /** Run the simulation to step K (from scratch if K is behind it). */
  _simAdvance(K) {
    const sim = this.sim, N = STEPS_DRAW, NT = STEPS_DRAW + STEPS_SETTLE;
    K = Math.max(0, Math.min(NT, K));
    if (K < sim.k) sim.reset();
    if (K === sim.k) return;
    const t0 = performance.now();
    const R = this.simRects;
    while (sim.k < K) {
      const k = sim.k + 1;
      // (the pen-time window of step k: its share of the clock)
      const inv = this.simClockInv;
      const win = k <= N ? [k === 1 ? -1 : this._lut(inv, (k - 1) / N), this._lut(inv, k / N)] : [2, 3];
      const j = Math.max(0, k - N) / STEPS_SETTLE;
      const dryMul = 1 + 20 * j * j;               // after the drawing the sheet dries, faster and faster
      sim.step(this.simParams, win, dryMul, k === NT, R.subarray(k * 4, k * 4 + 4), this.emptyVao);
      this.stats.wetSteps++;
    }
    this.stats.wetMs += performance.now() - t0;
  }

  /**
   * Where the displayed wet state is, in steps (d), for pen position upTo and drying progress.
   * While drawing it trails the pen by one step, so no step ever holds ink the pen has not laid;
   * the ink of that last step shows through its crisp core meanwhile (pen time in the surface).
   */
  _simPos(upTo, complete, settle) {
    if (complete) return STEPS_DRAW + Math.max(0, Math.min(1, settle)) * STEPS_SETTLE;
    return Math.max(0, this._lut(this.simClock, this._timeAt(upTo)) * STEPS_DRAW - 1);
  }

  // ---------------------------------------------------------------------------------- frame
  /** Sheet targets up to the pen, then the wet state. Returns the composite's wet uniforms. */
  _prepare(upTo, opts) {
    const s = this.s;
    this._drawTile();
    const segsAll = this.segments;
    const complete = !(upTo < segsAll);
    const settle = opts?.settle ?? (upTo === Infinity ? 1 : 0);
    let segs = 0, head = 0;
    if (s.geom) {
      const u = Math.max(0, Math.min(segsAll, upTo));
      segs = Math.floor(u);
      head = complete ? 0 : u - segs;
    }
    const at = s.geom ? Math.min(segsAll, Math.max(0, upTo)) : 0;
    if (this.dirty || this.viewGen !== this.gen || segs < this.drawn || at < this.lastUpTo) {
      this._clearPigment(); this.dirty = false; this.viewGen = this.gen;
    }
    if (segs > this.drawn || head > 0) { this._drawSegments(this.drawn, segs, head); this.drawn = segs; }
    this.lastUpTo = at;
    let wet = null;
    if (this._wetOn() && this._simPrepare()) {
      const d = this._simPos(upTo, complete, settle);
      const K = Math.ceil(d - 1e-9);
      this._simAdvance(K);
      wet = { d, frac: K > 0 ? d - (K - 1) : 1 };
    }
    return wet;
  }

  _composite(target = null, wet = null) {
    const gl = this.gl, s = this.s, p = this._compProg(!!wet), paper = s.paper, brush = s.brush;
    const glow = brush.glow ? this._glow() : null;
    const photoWet = wet && s.photoColor && this.hasColors;
    if (photoWet) {
      // the simulated bleed takes its colour from the line's average colour nearby
      gl.bindTexture(gl.TEXTURE_2D, this.pig.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.pigMips = true;
    } else if (this.pigMips) {
      gl.bindTexture(gl.TEXTURE_2D, this.pig.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      this.pigMips = false;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, s.width, s.height);
    gl.disable(gl.BLEND);
    gl.useProgram(p);
    gl.bindVertexArray(this.emptyVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.pig.tex);
    gl.uniform1i(this._u(p, 'uPigment'), 0);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, (glow || this.glowA).tex);
    gl.uniform1i(this._u(p, 'uGlow'), 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.surf.tex);
    gl.uniform1i(this._u(p, 'uSurf'), 3);
    this._grainUniforms(p);
    gl.uniform2f(this._u(p, 'uRes'), s.width, s.height);
    gl.uniform2f(this._u(p, 'uOrigin'), s.ox, s.oy);
    gl.uniform1f(this._u(p, 'uGrid'), paper.grid || 0);
    gl.uniform3fv(this._u(p, 'uPaperColor'), hexToRgb(paper.color));
    gl.uniform3fv(this._u(p, 'uSpeckColor'), hexToRgb(paper.speck));
    gl.uniform1f(this._u(p, 'uRelief'), paper.relief);
    gl.uniform1f(this._u(p, 'uMottle'), paper.mottle);
    gl.uniform1f(this._u(p, 'uSmudge'), paper.smudge || 0);
    gl.uniform1f(this._u(p, 'uSpeckAmt'), paper.specks * 0.5);
    gl.uniform1i(this._u(p, 'uCover'), s.cover ? 1 : 0);
    gl.uniform1i(this._u(p, 'uGlowOn'), glow ? 1 : 0);
    gl.uniform1f(this._u(p, 'uGlowAmt'), brush.glow ? (brush.glow.amount ?? 1.0) : 0);
    gl.uniform1i(this._u(p, 'uTransparent'), s.transparent ? 1 : 0);
    gl.uniform1f(this._u(p, 'uLightInk'), brush.lightInk ?? 0.4);
    gl.uniform3fv(this._u(p, 'uInk'), hexToRgb(s.ink));
    gl.uniform1i(this._u(p, 'uPhotoColor'), s.photoColor && this.hasColors ? 1 : 0);
    gl.uniform1i(this._u(p, 'uMaterial'), MATERIALS[brush.material] ?? MATERIALS.ink);
    gl.uniform1f(this._u(p, 'uSurfU'), SURF_UNIT_U * s.paperW / 1000 * this.physK);
    gl.uniform1f(this._u(p, 'uSeed'), s.seed);
    // light
    const L = s.light;
    const ce = Math.cos(L.elevation), se = Math.sin(L.elevation);
    const gain = PAPER_LIGHT0 * cot(L.elevation) / cot(LIGHT0.elevation);
    gl.uniform2f(this._u(p, 'uPaperLight'), -Math.cos(L.azimuth) * gain, -Math.sin(L.azimuth) * gain);
    gl.uniform3f(this._u(p, 'uLightDir'), Math.cos(L.azimuth) * ce, Math.sin(L.azimuth) * ce, se);
    gl.uniform3fv(this._u(p, 'uViewDir'), L.view);
    const eye = L.eye, pw = s.paperW;
    gl.uniform4f(this._u(p, 'uEye'), eye ? eye[0] * pw : 0, eye ? eye[1] * pw : 0, eye ? eye[2] * pw : 0, eye ? 1 : 0);
    gl.uniform1f(this._u(p, 'uCotEl'), cot(L.elevation));
    const w = L.warmth, tint = w >= 0 ? [1 + 0.06 * w, 1 - 0.02 * w, 1 - 0.16 * w] : [1 + 0.1 * w, 1 + 0.01 * w, 1 - 0.08 * w];
    // A camera meters for the sheet: under a raking lamp the tooth's shaded flanks and cast shadows
    // outweigh its lit ones (the paper's relief knee is deeper on the dark side), so blank paper
    // comes out ~2% darker than under the window and a drawing reads greyer. Exposing for the paper
    // gives that back. 1 at the window light and anything higher (overhead, the film's rising
    // light), so stills and films there are unchanged.
    const gk = cot(L.elevation) / cot(LIGHT0.elevation);
    const expo = 1 + 0.021 * Math.max(0, Math.min(1, (gk - 1.5) / 2.45));
    const I = L.intensity * expo;
    gl.uniform3f(this._u(p, 'uLightCol'), tint[0] * I, tint[1] * I, tint[2] * I);
    gl.uniform1f(this._u(p, 'uTime'), s.time ?? 0);
    gl.uniform1i(this._u(p, 'uTimeOn'), s.time == null ? 0 : 1);
    // wet layer
    const sim = this.sim;
    gl.uniform1i(this._u(p, 'uSimOn'), wet ? 1 : 0);
    const bw = brushWet(brush);
    // a dye ink's metallic sheen where it dried thick (wetsim.js dyeSheen; 0 for other media)
    const ds = bw ? dyeSheen(bw, hexToRgb(s.ink), paperPhysics(paper)) : [0, 0, 0, 0];
    gl.uniform4f(this._u(p, 'uDyeSheen'), ds[0], ds[1], ds[2], s.photoColor ? 0 : ds[3]);
    if (wet) {
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, sim.stateOld); gl.uniform1i(this._u(p, 'uSimA0'), 4);
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, sim.stateNew); gl.uniform1i(this._u(p, 'uSimA1'), 5);
      gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, sim.extent); gl.uniform1i(this._u(p, 'uSimB'), 6);
      gl.uniform1f(this._u(p, 'uSimFrac'), sim.k > 0 ? wet.frac : 1);
      gl.uniform1f(this._u(p, 'uSimX'), wet.d + 1);
      gl.uniform1f(this._u(p, 'uSimN'), STEPS_DRAW);
      gl.uniform1f(this._u(p, 'uMobile'), wetMobile(bw, paperPhysics(paper)));
      gl.uniform1f(this._u(p, 'uGranD'), bw.gran * 0.35);
      gl.uniform2f(this._u(p, 'uSheetPx'), s.paperW, s.paperH);
      gl.uniform2f(this._u(p, 'uSimTexel'), 1 / sim.w, 1 / sim.h);
      gl.uniform1f(this._u(p, 'uCellU'), 1000 / (sim.w * this.physK));
      gl.uniform1f(this._u(p, 'uWetH'), 2.2);
      gl.uniform1f(this._u(p, 'uSimScale'), sim.scaleA);
      // (at most mip 2: its 4-px blocks line up with a strip export's origins, which are multiples
      // of 4, so a strip averages the same pixels as the full sheet; coarser mips would not)
      gl.uniform1f(this._u(p, 'uPigLod'), Math.min(2, Math.max(0, Math.log2(s.paperW / sim.w) + 1.5)));
      // unmoved simulated pigment follows the stroke's fine coverage (wet.sharp, brushes.js)
      gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, sim.inj); gl.uniform1i(this._u(p, 'uSimInj'), 7);
      gl.uniform1f(this._u(p, 'uSimSharp'), bw.sharp);
      // colourant the fibres drank (bleeds, stains): not cut by the surface water's hard edge
      gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, sim.soakOld); gl.uniform1i(this._u(p, 'uSimC0'), 8);
      gl.activeTexture(gl.TEXTURE9); gl.bindTexture(gl.TEXTURE_2D, sim.soakNew); gl.uniform1i(this._u(p, 'uSimC1'), 9);
      // feathering along single fibres at the output's resolution (wetsim.js WET_HAIR_GLSL)
      const phW = paperPhysics(paper), fh = fibreHair(bw, phW);
      gl.uniform1f(this._u(p, 'uHair'), fh.on && !s.photoColor ? fh.k : 0);
      gl.uniform1f(this._u(p, 'uHairN'), fh.n);
      gl.uniform1f(this._u(p, 'uHairReach'), fh.reach);
      gl.uniform2f(this._u(p, 'uHairDir'), Math.cos(phW.grainDeg * DEG), Math.sin(phW.grainDeg * DEG));
      gl.uniform1f(this._u(p, 'uCockle'), cockleHeight(bw, phW));
    } else {
      // samplers must still point at valid textures of the right kind
      for (const [unit, name] of [[4, 'uSimA0'], [5, 'uSimA1'], [6, 'uSimB'], [7, 'uSimInj'], [8, 'uSimC0'], [9, 'uSimC1']]) {
        gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, this.glowA.tex); gl.uniform1i(this._u(p, name), unit);
      }
      gl.uniform1f(this._u(p, 'uMobile'), 0);
      gl.uniform1f(this._u(p, 'uSimSharp'), 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Render the paper with the line drawn up to point index `upTo` (fractional: the partial
   * segment is drawn up to the interpolated head; Infinity = all).
   * opts.settle 0..1: drying after the drawing is complete (default 1 for upTo = Infinity, the
   * finished still, and 0 otherwise). Only wet media change with it.
   * Incremental: only new segments / simulation steps are computed unless something changed or
   * we scrubbed back.
   */
  render(upTo = Infinity, opts = {}) {
    if (this.lost || this.gl.isContextLost()) return false;
    const s = this.s;
    if (!s.paper || !s.brush || !this.pig) return false;
    if (!this.block && this.pending()) return 'pending';
    const wet = this._prepare(upTo, opts);
    this._composite(null, wet);
    if (!this._warmed && this.opts.warmup) this._warmup();
    return true;
  }

  /**
   * Same as render(), but the finished sheet goes into an offscreen, mipmapped texture in this
   * context instead of the canvas: the film camera samples it (zoom, tilt, depth of field).
   * Returns { tex, w, h, rect } or null. The texture stays valid until the next resize / destroy.
   *
   * opts.rect = [x0, y0, x1, y1] (fractions of the sheet's width / height) renders just that part
   * of the sheet at a higher texel density, for macro close-ups of the nib: opts.size = its width
   * in texels (default: this renderer's width), the height follows the rect's shape. Everything is
   * in paper space, so it is the same sheet at that spot, only finer: grain, grit, granulation and
   * the wet simulation (shared with the full sheet: interleaving both costs no extra steps). The
   * rect's own targets are kept; they redraw from scratch when the rect or its density changes
   * (off-screen segments cost only their vertices) and incrementally while it holds still.
   * The texture covers a little more than asked (a margin for the glow and relief, and an origin
   * snapped to 4 texels, so a rect panning at a fixed density samples the paper at the same points
   * and its grain does not shimmer): map it with the RETURNED rect, its true coverage.
   */
  renderToTexture(upTo = Infinity, opts = {}) {
    if (this.lost || this.gl.isContextLost()) return null;
    const s = this.s;
    if (!s.paper || !s.brush || !this.pig) return null;
    // (a non-blocking renderer's caller checks pending() first; this is the safety net)
    if (!this.block && this.pending()) return null;
    if (opts.rect) return this._renderRect(upTo, opts);
    const wet = this._prepare(upTo, opts);
    this._toTexture(wet);
    return { tex: this.sheetTex.tex, w: s.width, h: s.height, rect: [s.ox / s.paperW, s.oy / s.paperH,
      (s.ox + s.width) / s.paperW, (s.oy + s.height) / s.paperH] };
  }

  /** Composite into this view's mipmapped output texture. */
  _toTexture(wet) {
    const gl = this.gl, s = this.s;
    if (!this.sheetTex || this.sheetTex.w !== s.width || this.sheetTex.h !== s.height) {
      this._freeTarget(this.sheetTex);
      this.sheetTex = this._tex(s.width, s.height, { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE,
        filter: gl.LINEAR, mips: true, wrap: gl.CLAMP_TO_EDGE });
    }
    this._composite(this.sheetTex.fbo, wet);
    gl.bindTexture(gl.TEXTURE_2D, this.sheetTex.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Fields that belong to one view of the sheet (the canvas-sized main view, or the rect view).
  static VIEW = ['pig', 'surf', 'sheetFbo', 'glowA', 'glowB', 'pigMips', 'drawn', 'lastUpTo', 'dirty', 'viewGen', 'sheetTex'];
  static VIEW_S = ['width', 'height', 'paperW', 'paperH', 'ox', 'oy'];

  _swapView(v) {
    for (const k of Renderer.VIEW) { const t = this[k]; this[k] = v[k]; v[k] = t; }
    for (const k of Renderer.VIEW_S) { const t = this.s[k]; this.s[k] = v.s[k]; v.s[k] = t; }
  }

  _renderRect(upTo, opts) {
    const s = this.s;
    const r = opts.rect.map(Number);
    if (r.length !== 4 || !r.every(Number.isFinite)) return null;
    const x0 = Math.max(0, Math.min(r[0], r[2])), x1 = Math.min(1, Math.max(r[0], r[2]));
    const y0 = Math.max(0, Math.min(r[1], r[3])), y1 = Math.min(1, Math.max(r[1], r[3]));
    if (!(x1 - x0 > 1e-6 && y1 - y0 > 1e-6)) return null;
    const A = s.paperH / s.paperW;                        // the sheet's aspect
    const w = Math.max(16, Math.round(opts.size || s.width));
    const Wp = w / (x1 - x0), Hp = Wp * A;                // texel density: the sheet at this scale
    const h = Math.max(16, Math.round((y1 - y0) * Hp));
    // A margin around the rect: the glow blur and the relief taps read neighbouring texels, which
    // must hold the sheet, not the clamped edge. The origin sits on a multiple of 4 texels (2x2
    // derivative quads and the quarter-res glow grid line up with a full render at this density).
    const m = this._rectMargin(Wp);
    const ox = 4 * Math.floor(x0 * Wp / 4) - m, oy = 4 * Math.floor(y0 * Hp / 4) - m;
    const W = Math.min(this.maxSize, w + 2 * m + 4), H = Math.min(this.maxSize, h + 2 * m + 4);
    let v = this.rectView;
    if (!v) {
      v = this.rectView = { s: { width: 0, height: 0, paperW: 0, paperH: 0, ox: 0, oy: 0 }, pig: null, surf: null,
        sheetFbo: null, glowA: null, glowB: null, pigMips: false, drawn: 0, lastUpTo: -1, dirty: true, viewGen: -1, sheetTex: null };
    }
    this._swapView(v);
    try {
      if (!this.pig || s.width !== W || s.height !== H) {
        s.width = W; s.height = H;
        this._allocTargets(W, H);
      }
      if (s.paperW !== Wp || s.paperH !== Hp || s.ox !== ox || s.oy !== oy) {
        s.paperW = Wp; s.paperH = Hp; s.ox = ox; s.oy = oy;
        this.dirty = true;
      }
      const wet = this._prepare(upTo, opts);
      this._toTexture(wet);
      // the texture's own coverage (the asked-for rect lies inside it, m texels or more from its edges)
      return { tex: this.sheetTex.tex, w: W, h: H, rect: [ox / Wp, oy / Hp, (ox + W) / Wp, (oy + H) / Hp] };
    } finally {
      this._swapView(v);
    }
  }

  /** Texels a rect view renders beyond the rect: glow reach (same bound as export.js) + relief taps. */
  _rectMargin(Wp) {
    const g = this.s.brush?.glow;
    let px = 4;
    if (g) {
      const U = Wp / 4000;                                // one paper unit in quarter-res texels
      const reach = radiusU => 3.2308 * Math.max(0.6, radiusU * U) / 3.2 + 1;
      px = 4 * (reach(g.tight ?? 2.0) + reach(g.wide ?? 6.0)) + 8;
    }
    return 4 * Math.ceil(px / 4);
  }

  /** Free the rect view's targets (they are kept between renderToTexture({ rect }) calls). */
  releaseRect() {
    const v = this.rectView;
    if (!v) return;
    this.rectView = null;
    if (this.lost || this.gl.isContextLost()) return;
    for (const t of [v.pig, v.surf, v.glowA, v.glowB, v.sheetTex]) this._freeTarget(t);
    if (v.sheetFbo) this.gl.deleteFramebuffer(v.sheetFbo);
  }

  /**
   * Show part of the sheet on the canvas from renderToTexture images (the app's zoom loupe).
   * view = [x0, y0, x1, y1] (sheet fractions) fills the canvas; layers = up to two { tex, rect }
   * (rect = the coverage renderToTexture returned), the second drawn over the first wherever it
   * covers. One textured triangle, so a gesture can pan and zoom the last images every frame while
   * a sharp one is made. A layer rendered for exactly this view at the canvas's size (view origin
   * on a whole texel) maps each pixel onto one texel centre: the same image as a full render.
   */
  present(view, layers) {
    if (this.lost || this.gl.isContextLost() || !layers?.length) return false;
    const gl = this.gl, s = this.s;
    // (tiny, so compiled on the spot; remade after a context loss like every program)
    const p = this.progs.present || (this.progs.present = this._program(VERT_FULL, FRAG_PRESENT));
    const Wc = s.width, Hc = s.height;
    const vw = view[2] - view[0], vh = view[3] - view[1];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, Wc, Hc);
    gl.disable(gl.BLEND);
    gl.useProgram(p);
    gl.bindVertexArray(this.emptyVao);
    for (let i = 0; i < 2; i++) {
      const L = layers[Math.min(i, layers.length - 1)];
      const r = L.rect, rw = r[2] - r[0], rh = r[3] - r[1];
      // texture uv as an affine function of gl_FragCoord, worked out here in doubles: at deep zoom
      // the sheet position itself would lose the sub-texel precision in float32
      const sx = vw / (Wc * rw), bx = (view[0] - r[0]) / rw;
      const sy = vh / (Hc * rh), by = 1 - (view[3] - r[1]) / rh;
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, L.tex);
      gl.uniform1i(this._u(p, i ? 'uT1' : 'uT0'), i);
      gl.uniform4f(this._u(p, i ? 'uM1' : 'uM0'), sx, sy, bx, by);
    }
    gl.uniform1i(this._u(p, 'uTwo'), layers.length > 1 ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    return true;
  }

  /** Blank paper only (no line), e.g. before a photo is loaded. */
  renderBlank() {
    if (this.lost || !this.s.paper || !this.s.brush || !this.pig) return false;
    if (!this.block && this.pending()) return 'pending';
    this._drawTile();
    this._clearPigment();
    this.dirty = true;
    this._composite(null, null);
    return true;
  }

  destroy() {
    const gl = this.gl;
    try { this.sim?.destroy(); } catch { /* context already gone */ }
    try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* already gone */ }
    this.lost = true;
  }
}

// present(): up to two sheet images mapped onto the canvas; the second wins wherever it covers.
// uM = (uv per fragment px x, y, uv at fragment 0 x, y). Outside both, the first image's edge.
const FRAG_PRESENT = /* glsl */`#version 300 es
precision highp float;
uniform sampler2D uT0, uT1;
uniform vec4 uM0, uM1;
uniform int uTwo;
out vec4 outColor;
void main() {
  vec2 f = gl_FragCoord.xy;
  vec2 a = f * uM0.xy + uM0.zw;
  vec2 b = f * uM1.xy + uM1.zw;
  // (both sampled outside any branch: mip selection needs derivatives in uniform control flow)
  vec4 c0 = texture(uT0, a), c1 = texture(uT1, b);
  bool in1 = uTwo == 1 && all(greaterThanEqual(b, vec2(0.0))) && all(lessThanEqual(b, vec2(1.0)));
  outColor = in1 ? c1 : c0;
}`;
