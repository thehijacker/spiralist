// WebGL2 renderer: paper + one continuous line.
//
//   pigment pass   instanced round-capped segments (distance field), MAX-blended so the line
//                  never darkens where consecutive segments overlap; drawn incrementally so
//                  playback / filming only draws the new part of the line each frame.
//   glow pass      (neon) pigment mip -> separable Gaussian at quarter resolution.
//   composite      paper surface with relief lighting + pigment + glow -> canvas.
//
// Layout is given in fractions of the paper WIDTH: { cx, cy, r } (circle centre and radius).
// The render target is normally the whole paper; for very large exports it can be a strip of
// it (setPaperSize + setOrigin), with identical output because every texture is in paper space.

import { VERT_FULL, FRAG_PAPER_TILE, VERT_STROKE, FRAG_STROKE, FRAG_COMPOSITE, FRAG_BLUR, TILES_ACROSS, TILE_SIZE } from './shaders.js';
import { STRIDE } from './spiral.js';
import { hexToRgb } from './materials.js';

const BYTES = STRIDE * 4;

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
   * @param opts { onLost?: () => void, onRestored?: () => void }
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.s = {
      width: 0, height: 0,          // render target (canvas) size, px
      paperW: 0, paperH: 0,         // full paper size, px (defaults to the target size)
      ox: 0, oy: 0,                 // target's top-left on the paper
      fullPaper: false,             // true once setPaperSize was called explicitly
      paper: null, brush: null, ink: '#000000', cover: false, photoColor: false,
      geom: null, layout: { cx: 0.5, cy: 0.5, r: 0.42 }, seed: 1, transparent: false,
    };
    this.lost = false;
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
    this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0], gl.getParameter(gl.MAX_VIEWPORT_DIMS)[1]);
    this.progs = {
      tile: this._program(VERT_FULL, FRAG_PAPER_TILE),
      stroke: this._program(VERT_STROKE, FRAG_STROKE),
      comp: this._program(VERT_FULL, FRAG_COMPOSITE),
      blur: this._program(VERT_FULL, FRAG_BLUR),
    };
    this.emptyVao = gl.createVertexArray();
    this.strokeVao = gl.createVertexArray();
    this.pointBuf = gl.createBuffer();
    this.colorBuf = gl.createBuffer();
    this.uploaded = 0;          // points in the GPU buffer
    this.hasColors = false;
    this.paperKey = null;
    this.tileTex = null;
    this.pig = null; this.glowA = null; this.glowB = null;
    this.drawn = 0;             // segments currently in the pigment buffer
    this.dirty = true;
    this._makeTile();
  }

  _reapply() {
    const s = this.s;
    this.paperKey = null;
    if (s.width && s.height) this._allocTargets(s.width, s.height);
    if (s.paper) this.setPaper(s.paper, s.seed);
    if (s.geom) this.setGeometry(s.geom);
    this.dirty = true;
  }

  // ---------------------------------------------------------------------------------- setup
  _shader(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(sh);
      const lines = src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
      console.error(log + '\n' + lines);
      throw new Error('Shader compile failed: ' + log);
    }
    return sh;
  }

  _program(vs, fs) {
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, this._shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, this._shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
    }
    p._u = new Map();
    return p;
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
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex: t, fbo, w, h, ok: status === gl.FRAMEBUFFER_COMPLETE };
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
    this._freeTarget(this.pig); this._freeTarget(this.glowA); this._freeTarget(this.glowB);
    this.pig = this._tex(w, h, { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE });
    const gw = Math.max(1, Math.ceil(w / 4)), gh = Math.max(1, Math.ceil(h / 4));
    this.glowA = this._tex(gw, gh, { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE });
    this.glowB = this._tex(gw, gh, { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE });
    this.dirty = true;
  }

  // ---------------------------------------------------------------------------------- state
  /** Render target (canvas) size in pixels; also the paper size unless setPaperSize was used. */
  setSize(width, height) {
    const w = Math.max(1, Math.min(this.maxSize, Math.round(width)));
    const h = Math.max(1, Math.min(this.maxSize, Math.round(height)));
    if (!this.s.fullPaper) { this.s.paperW = w; this.s.paperH = h; }
    if (w === this.s.width && h === this.s.height && this.pig) return;
    this.s.width = w; this.s.height = h;
    this.canvas.width = w; this.canvas.height = h;
    this._allocTargets(w, h);
  }

  /** Full paper size in px when the target is only part of it (strip rendering). */
  setPaperSize(width, height) {
    this.s.fullPaper = true;
    if (this.s.paperW === width && this.s.paperH === height) return;
    this.s.paperW = width; this.s.paperH = height;
    this.dirty = true;
  }

  /** Top-left of the render target on the paper, px. */
  setOrigin(x, y) {
    if (this.s.ox === x && this.s.oy === y) return;
    this.s.ox = x; this.s.oy = y;
    this.dirty = true;
  }

  setLayout(layout) {
    const l = this.s.layout;
    if (l.cx === layout.cx && l.cy === layout.cy && l.r === layout.r) return;
    this.s.layout = { ...layout };
    this.dirty = true;
  }

  setPaper(paper, seed = 1) {
    this.s.paper = paper; this.s.seed = seed;
    const key = paper.id + ':' + seed;
    if (key === this.paperKey) return;
    this.paperKey = key;
    const gl = this.gl, p = this.progs.tile, t = this.tileTex;
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
    this.dirty = true;     // brushes read the grain
  }

  /** brush: BRUSHES entry, ink: '#rrggbb', cover: bool, photoColor: bool */
  setStyle({ brush, ink, cover, photoColor }) {
    const s = this.s;
    if (s.brush === brush && s.ink === ink && s.cover === cover && s.photoColor === !!photoColor) return;
    s.brush = brush; s.ink = ink; s.cover = cover; s.photoColor = !!photoColor;
    this.dirty = true;
  }

  setTransparent(on) { this.s.transparent = !!on; }

  setGeometry(geom) {
    const gl = this.gl;
    this.s.geom = geom;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
    gl.bufferData(gl.ARRAY_BUFFER, geom.data, gl.STATIC_DRAW);
    this.hasColors = !!geom.colors;
    if (geom.colors) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuf);
      gl.bufferData(gl.ARRAY_BUFFER, geom.colors, gl.STATIC_DRAW);
    }
    this.uploaded = geom.n;
    this.dirty = true;
  }

  get segments() { return Math.max(0, (this.s.geom?.n || 0) - 1); }

  // ---------------------------------------------------------------------------------- drawing
  _grainUniforms(p) {
    const gl = this.gl, W = this.s.paperW;
    const tilePx = W / TILES_ACROSS;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tileTex.tex);
    gl.uniform1i(this._u(p, 'uPaperTex'), 1);
    gl.uniform1f(this._u(p, 'uTilePx'), tilePx);
    gl.uniform1f(this._u(p, 'uTileLod'), Math.log2(TILE_SIZE / tilePx));
    gl.uniform1f(this._u(p, 'uPaperPx'), W);
    gl.uniform1f(this._u(p, 'uU'), W / 1000);
  }

  _bindSegments(i0) {
    const gl = this.gl;
    gl.bindVertexArray(this.strokeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
    const a = i0 * BYTES, b = (i0 + 1) * BYTES;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, BYTES, a); gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, BYTES, a + 16); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, BYTES, b); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 2, gl.FLOAT, false, BYTES, b + 16); gl.vertexAttribDivisor(3, 1);
    if (this.hasColors) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuf);
      gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 4, gl.UNSIGNED_BYTE, true, 4, i0 * 4); gl.vertexAttribDivisor(4, 1);
    } else {
      gl.disableVertexAttribArray(4);
      gl.vertexAttrib4f(4, 0, 0, 0, 1);
    }
  }

  _drawSegments(i0, i1) {
    if (i1 <= i0) return;
    const gl = this.gl, s = this.s, p = this.progs.stroke;
    const W = s.width, H = s.height, PW = s.paperW, brush = s.brush;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pig.fbo);
    gl.viewport(0, 0, W, H);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(p);
    gl.uniform2f(this._u(p, 'uRes'), W, H);
    gl.uniform2f(this._u(p, 'uOrigin'), s.ox, s.oy);
    gl.uniform2f(this._u(p, 'uCenter'), s.layout.cx * PW, s.layout.cy * PW);
    gl.uniform1f(this._u(p, 'uRadius'), s.layout.r * PW);
    gl.uniform1f(this._u(p, 'uMinW'), 1.0);
    gl.uniform1f(this._u(p, 'uSpread'), brush.spread || 1);
    gl.uniform1i(this._u(p, 'uBrush'), brush.shader);
    gl.uniform3fv(this._u(p, 'uInk'), hexToRgb(s.ink));
    gl.uniform1i(this._u(p, 'uCover'), s.cover ? 1 : 0);
    gl.uniform1i(this._u(p, 'uPhotoColor'), s.photoColor && this.hasColors ? 1 : 0);
    gl.uniform1f(this._u(p, 'uSeed'), s.seed);
    this._grainUniforms(p);
    // Chunk very long draws so a single command never monopolises the GPU.
    const CHUNK = 262144;
    for (let a = i0; a < i1; a += CHUNK) {
      const b = Math.min(i1, a + CHUNK);
      this._bindSegments(a);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b - a);
    }
    gl.disable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.bindVertexArray(null);
  }

  _clearPigment() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pig.fbo);
    gl.viewport(0, 0, this.s.width, this.s.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawn = 0;
  }

  _glow() {
    const gl = this.gl, p = this.progs.blur;
    gl.useProgram(p);
    gl.bindVertexArray(this.emptyVao);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this._u(p, 'uSrc'), 0);
    const gw = this.glowA.w, gh = this.glowA.h;
    const U = this.s.paperW / 1000 / 4;           // one paper unit in quarter-res texels
    const pass = (src, dst, down, dx, dy, radiusU) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, gw, gh);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(this._u(p, 'uDown'), down ? 1 : 0);
      gl.uniform2f(this._u(p, 'uSrcTexel'), 1 / src.w, 1 / src.h);
      const r = Math.max(0.6, radiusU * U) / 3.2;
      gl.uniform2f(this._u(p, 'uDir'), dx * r / gw, dy * r / gh);
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

  _composite(target = null) {
    const gl = this.gl, s = this.s, p = this.progs.comp, paper = s.paper, brush = s.brush;
    const glow = brush.glow ? this._glow() : null;
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
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Render the paper with the line drawn up to point index `upTo` (fractional ok; Infinity = all).
   * Incremental: only new segments are rasterised unless something changed or we scrubbed back.
   */
  render(upTo = Infinity) {
    if (this.lost || this.gl.isContextLost()) return false;
    const s = this.s;
    if (!s.paper || !s.brush || !this.pig) return false;
    const segs = s.geom ? Math.max(0, Math.min(this.segments, Math.floor(upTo))) : 0;
    if (this.dirty || segs < this.drawn) { this._clearPigment(); this.dirty = false; }
    if (segs > this.drawn) { this._drawSegments(this.drawn, segs); this.drawn = segs; }
    this._composite();
    return true;
  }

  /**
   * Same as render(), but the finished sheet goes into an offscreen, mipmapped texture in this
   * context instead of the canvas — the film camera samples it (zoom, tilt, depth of field).
   * Returns { tex, w, h } or null. The texture stays valid until the next resize / destroy.
   */
  renderToTexture(upTo = Infinity) {
    if (this.lost || this.gl.isContextLost()) return null;
    const s = this.s, gl = this.gl;
    if (!s.paper || !s.brush || !this.pig) return null;
    if (!this.sheetTex || this.sheetTex.w !== s.width || this.sheetTex.h !== s.height) {
      this._freeTarget(this.sheetTex);
      this.sheetTex = this._tex(s.width, s.height, { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE,
        filter: gl.LINEAR, mips: true, wrap: gl.CLAMP_TO_EDGE });
    }
    const segs = s.geom ? Math.max(0, Math.min(this.segments, Math.floor(upTo))) : 0;
    if (this.dirty || segs < this.drawn) { this._clearPigment(); this.dirty = false; }
    if (segs > this.drawn) { this._drawSegments(this.drawn, segs); this.drawn = segs; }
    this._composite(this.sheetTex.fbo);
    gl.bindTexture(gl.TEXTURE_2D, this.sheetTex.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex: this.sheetTex.tex, w: s.width, h: s.height };
  }

  /** Blank paper only (no line), e.g. before a photo is loaded. */
  renderBlank() {
    if (this.lost || !this.s.paper || !this.s.brush || !this.pig) return false;
    this._clearPigment();
    this.dirty = true;
    this._composite();
    return true;
  }

  destroy() {
    const gl = this.gl;
    try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* already gone */ }
    this.lost = true;
  }
}
