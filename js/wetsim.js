// Wet media: liquid, suspended pigment and deposited pigment on a sheet-space grid (GPU).
//
// The grid has a FIXED size relative to the sheet (WET_GRID cells across its width, ~1 paper unit
// = 0.2 mm per cell), whatever the output resolution, so the preview, a 4K strip export and every
// film frame see the same simulation, only upsampled differently.
//
// State per cell, two ping-ponged pairs of textures written together (MRT):
//   A = (W surface water, S suspended pigment, P deposited pigment, M moisture held by the fibres)
//   B = (E wet extent: 1 once liquid has stood here or soaked through; kept forever, it draws the
//        dry edge, f the wet edge's pull (coffee ring), age of the wet film, D colourant carried
//        in the fibres' water)
// plus two static inputs:
//   inj  = the liquid each stretch of line lays down: (water, pigment, the stroke's coverage, pen
//          time), drawn once per geometry by the renderer's stroke program (uPass 1), MAX-blended,
//          so it holds the LATEST pass over each cell; inj2.x = 1 - pen time of the EARLIEST pass
//          (same draw, second target), so a cell two passes of the line cover gets ink from both
//          (layering). A step takes the cells whose pen time falls in its window, so the
//          simulation is a pure function of drawing progress.
//   phys = the sheet (papers.js paperPhys): height, conductance, fibre orientation.
//
// One step (FRAG_WET_STEP), per cell and its 8 neighbours:
//   1. surface water flows down the depth gradient; conductance follows the formation, and the
//      fibres (faster along them: feathering, anisotropic bleed). Onto dry paper it only advances
//      once it is deep enough to break the sizing (a pinned, hard edge); into damp paper it runs
//      freely (wet-into-wet). Suspended pigment rides along with the water it is in.
//   2. this step's ink is added (injection window).
//   3. water flowing back into a drying area lifts settled pigment (blooms / backruns).
//   4. the sheet drinks standing water until saturated (fast on unsized, thirsty sheets, hardly at
//      all on sized ones); dissolved dye and the finest particles go in with it (D).
//   5. evaporation, faster at the wet front where the film is thin and open to the air: the
//      interior refills the front and carries pigment with it, so rims dry dark (coffee ring).
//   6. particles settle out of thin water, preferring the valleys of the sheet (granulation);
//      a cell that runs dry leaves all its pigment behind.
//   7. capillarity: the water in the fibres wicks on through the sheet (faster along the fibres),
//      carrying its colourant, which lags behind the water (the fibres filter and stain) and is
//      caught along the way: bleed, nijimi's grey halo with its darker front, marker bleed and
//      the fuzzy edge of ink on cheap paper. The fibres dry; what they held is left in them.
// Every flux between two cells is computed identically from both sides, so water and pigment are
// conserved (apart from evaporation and absorption, which remove water only).
//
// Schedule (renderer): STEPS_DRAW steps spread over the drawing by pacing time, then STEPS_SETTLE
// steps of accelerating drying, the last of which dries everything (settle = 1 is the still).

export const WET_GRID = 1024;
export const STEPS_DRAW = 240;
export const STEPS_SETTLE = 60;

export const FRAG_WET_STEP = /* glsl */`#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
layout(location = 2) out vec4 oSoak;
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uC;       // x: colourant caught in the fibres (never moves again)
uniform sampler2D uInj;
uniform sampler2D uPhys;
uniform vec2 uWin;          // injection window (t0, t1] in pen time
uniform float uDiff;        // surface water conductance per step
uniform float uPin;         // water depth needed to wet dry paper (sizing)
uniform float uAbsorb;      // share of standing water the sheet drinks per step (dry sheet)
uniform float uCap;         // moisture gained per unit of water drunk (thin sheets fill fast)
uniform float uWick;        // capillary spreading of the moisture through the fibres
uniform float uCapF;        // capillary pull of liquid into dry fibres (unsized paper: feathering)
uniform float uAniso;       // how much faster liquid moves along the fibres
uniform float uEvap;        // evaporation, depth per step
uniform float uFront;       // extra evaporation at the wet front
uniform float uRing;        // outward capillary flow that carries pigment to a pinned edge
uniform float uSettle;      // particle settling per step
uniform float uGran;        // valley preference of settling
uniform float uLift;        // re-wetting lifts settled pigment
uniform float uDye;         // share of the pigment that is dissolved dye
uniform float uMix;         // pigment spreading through standing water (diffusion, currents)
uniform float uMDry;        // fibre drying per step
uniform float uDryMul;      // settle phase: drying speeds up
uniform float uFinal;       // 1 = dry everything now
uniform float uScaleA;      // RGBA8 fallback: state values are stored / uScaleA
uniform float uWickS;       // share of the suspended colourant the sheet drinks with the water
uniform float uFilter;      // share of the fibres' colourant they catch per step (stain, filter)
uniform float uTide;        // how much more they catch where their water is thinnest (the bleed's front)
uniform float uRetard;      // colourant speed through the fibres relative to their water (< 1)
uniform sampler2D uInj2;    // x: 1 - pen time of the EARLIEST pass over this cell (0 = none)
uniform float uLayer;       // share of its ink an earlier pass lays where a later pass also goes
uniform float uLayerDt;     // pen time between two passes for them to count as separate passes

const ivec2 OFF[8] = ivec2[8](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1),
                              ivec2(1, 1), ivec2(-1, -1), ivec2(1, -1), ivec2(-1, 1));
const float WT[8] = float[8](1.0, 1.0, 1.0, 1.0, 0.5, 0.5, 0.5, 0.5);
// each offset's direction as a doubled angle on the sheet (texel rows run up, the sheet's y down)
const vec2 E2[8] = vec2[8](vec2(1.0, 0.0), vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(-1.0, 0.0),
                           vec2(0.0, -1.0), vec2(0.0, -1.0), vec2(0.0, 1.0), vec2(0.0, 1.0));

vec4 stateAt(ivec2 p) { return texelFetch(uA, p, 0) * uScaleA; }

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 hi = textureSize(uA, 0) - 1;
  vec4 c = stateAt(p);
  vec4 ph = texelFetch(uPhys, p, 0);
  float condC = ph.y * 2.0;
  vec2 oC = ph.zw * 2.0 - 1.0;
  float concC = c.y / max(c.x, 1e-4);
  vec4 bC = texelFetch(uB, p, 0);
  // the outward flow takes a few steps to establish: until then a fresh stretch of stroke only
  // merges with the stretch laid a step before (their shared end is not a real edge)
  float settled = smoothstep(3.0 / 64.0, 10.0 / 64.0, bC.z);
  float dW = 0.0, dS = 0.0, dM = 0.0, dD = 0.0, inflow = 0.0, dryN = 0.0, fSum = 0.0;
  float concD = bC.w / max(c.w, 0.02);             // colourant per unit of the fibres' water
  for (int i = 0; i < 8; i++) {
    ivec2 q = clamp(p + OFF[i], ivec2(0), hi);
    vec4 n = stateAt(q);
    vec4 pn = texelFetch(uPhys, q, 0);
    vec4 bN = texelFetch(uB, q, 0);
    float fN = bN.y;
    float cond = 0.5 * (condC + pn.y * 2.0);
    float an = 1.0 + uAniso * dot(E2[i], 0.5 * (oC + pn.zw * 2.0 - 1.0));
    float g = WT[i] * cond * an;
    // surface water, down the depth gradient. The pinning gate depends only on the pair (source
    // depth, wetness of the receiving cell), so both cells compute the same flux. Paper that is
    // only damp inside (wicked moisture) lowers the gate a little, not like a wet surface.
    float dw = n.x - c.x;
    bool fromN = dw > 0.0;
    float src = fromN ? n.x : c.x;
    float rcv = fromN ? c.x + 0.35 * c.w : n.x + 0.35 * n.w;
    float gate = mix(smoothstep(0.8 * uPin, 1.2 * uPin, src), 1.0, smoothstep(0.02, 0.3, rcv));
    // + capillary pull into the fibres themselves, ungated and strongly along them (feathering)
    float f = (uDiff * g * gate + uCapF * WT[i] * min(cond * cond * an * an, 8.0)) * dw;
    dW += f;
    dS += f * (fromN ? n.y / max(n.x, 1e-4) : concC);
    inflow += max(f, 0.0);
    // where two wet cells touch, their pigment evens out (Brownian drift and small currents in
    // the pool), in proportion to the thinner film between them
    float film = min(c.x, n.x);
    dS += uMix * g * film * (n.y / max(n.x, 1e-4) - concC) * step(1e-3, film);
    // Deegan flow: a pinned film loses water fastest at its edge, and the interior streams
    // outward to replace it, carrying pigment. f (B.y) is the edge's pull, strongest at the rim
    // and fading a few cells inward; pigment drifts down its gradient between wet cells.
    float J = uRing * WT[i] * (bC.y - fN) * step(1e-3, film) * settled;
    dS += J > 0.0 ? J * n.y : J * c.y;
    fSum += WT[i] * fN;
    // moisture wicks through the fibres (capillary: strongly along them), and the colourant it
    // holds goes with it, lagging behind the water (retardation: the fibres slow and catch it)
    float fM = min(uWick * g * an, 0.07) * (n.w - c.w);
    dM += fM;
    dD += fM * (fM > 0.0 ? bN.w / max(n.w, 0.02) : concD) * uRetard;
    dryN += 1.0 - smoothstep(0.004, 0.03, n.x);
  }
  float W = max(0.0, c.x + dW);
  float S = max(0.0, c.y + dS);
  float P = c.z;
  float M = clamp(c.w + dM, 0.0, 1.0);
  float D = max(0.0, bC.w + dD);

  // this step's ink
  vec4 inj = texelFetch(uInj, p, 0);
  if (inj.w > uWin.x && inj.w <= uWin.y) { W += inj.x; S += inj.y; }
  // An earlier pass of the line over the same cells (touching rings, a corridor beside a corridor)
  // lays its own ink at its own time: the ink map above keeps only the latest pass, so without this
  // the first pass's liquid would be missing there. Layered passes add up (darker seams, glazes).
  float tE = 1.0 - texelFetch(uInj2, p, 0).x;
  if (uLayer > 0.0 && tE < 1.0 && inj.w - tE > uLayerDt && tE > uWin.x && tE <= uWin.y) {
    W += inj.x * uLayer; S += inj.y * uLayer;
  }

  // water flooding back into a drying wash picks settled particles up again (dye has stained
  // the fibres and stays): the pale heart and dark, frilled edge of a bloom
  float lift = uLift * P * clamp(inflow * 8.0, 0.0, 1.0) * smoothstep(0.02, 0.2, W) * smoothstep(0.05, 0.4, M);
  P -= lift; S += lift;

  // the sheet drinks the standing water until it is saturated; dissolved dye and the finest
  // particles go in with it, into the fibres' water (D), and travel on from there
  float drink = min(W, uAbsorb * W * (1.0 - M));
  float take = drink > 0.0 ? S * uWickS * drink / max(W, 1e-4) : 0.0;
  W -= drink; M = min(1.0, M + drink * uCap);
  S -= take; D += take;

  // evaporation. The water film thins nearly evenly (the flow above keeps a pinned film level),
  // a little faster at the exposed edge; the edge's extra loss is what drives the Deegan flow.
  float edge = dryN / 8.0 * step(1e-3, W);
  W = max(0.0, W - uEvap * uDryMul * (0.35 + W) * (1.0 + uFront * edge));

  // particles settle out of thin water, first into the sheet's valleys (granulation)
  float valley = clamp((0.5 - ph.x) * 2.5, -1.0, 1.0);
  float settle = min(S, S * uSettle * uDryMul * max(0.0, 1.0 + uGran * valley) / (1.0 + 3.0 * W));
  S -= settle; P += settle;

  // a cell that has run dry keeps whatever pigment was in it
  if (W < 2e-3 || uFinal > 0.5) { P += S; S = 0.0; W = 0.0; }
  M = max(0.0, M - uMDry * uDryMul * (0.2 + M));
  if (uFinal > 0.5) M = 0.0;
  // the fibres catch part of the colourant their water carries (dye stains, soot is filtered),
  // most where that water is thin (the edge of the damp zone: a bleed dries with a fuller front);
  // fibres that dry out keep all of it
  float thinM = 1.0 - smoothstep(0.03, 0.25, M);
  float catchD = D * clamp(uFilter * uDryMul * (1.0 + uTide * thinM) + 1.0 - smoothstep(0.004, 0.03, M), 0.0, 1.0);
  D -= catchD;
  float soakP = texelFetch(uC, p, 0).x * uScaleA + catchD;

  oA = vec4(W, S, P, M) / uScaleA;
  oSoak = vec4(soakP, 0.0, 0.0, 0.0) / uScaleA;
  // the edge's pull for the next step: exposure here, or what reaches in from the rim (a decaying
  // average of the neighbours, which spreads in round contours rather than the grid's diamonds)
  float f = W > 1e-3 ? max(edge, 0.97 * fSum / 6.0) : 0.0;
  float age = W > 1e-3 ? min(1.0, bC.z + 1.0 / 64.0) : 0.0;
  // the extent: where water has stood on the sheet (its hard edge); what soaked in is in C
  oB = vec4(max(bC.x, smoothstep(0.004, 0.04, W)), f, age, D);
}`;

/**
 * Simulation parameters (per step) for a medium on a paper.
 * wet = brushWet(brush) (brushes.js), phys = paperPhysics(paper) (papers.js).
 */
export function wetParams(wet, phys) {
  const { absorb, sizing, fibre, capacity } = phys;
  return {
    // flow has to outrun evaporation by far, or a pinned edge dries before the interior can refill
    // it and the rims come out pale instead of dark
    uDiff: 0.055 * wet.flow,
    uPin: 0.15 + 0.7 * sizing,
    uCapF: 0.04 * absorb * (1 - sizing) * wet.flow,
    // sizing keeps the water standing on the sheet (it evaporates rather than soaking in), which
    // is what lets rims and pools form; an unsized sheet drinks it within a few steps (bleed,
    // soft stains). Sizing works on the surface and in the bulk: its effect compounds.
    // (a step is about a second of the hand's time: sketch paper drinks a stroke in a few steps,
    // a gelatin-sized watercolour sheet lets it stand for most of a minute)
    uAbsorb: 1.6 * absorb * Math.pow(1 - sizing, 3) + 0.003,
    uCap: 1 / (0.35 + 1.6 * capacity),
    // the water the sheet drank wicks on through its fibres (Lucas-Washburn: fast in open, thirsty
    // sheets), carrying what it dissolved; the fibres catch that colourant as it goes, most
    // quickly on a sized sheet (short, crisp stains) and least on an open one (long bleeds)
    uWick: 0.02 + 0.2 * absorb * (1 - 0.6 * sizing),
    uWickS: wet.wick ?? wet.dye,
    uFilter: (0.004 + 0.1 * Math.pow(sizing, 1.5)) * (wet.stick ?? 1),
    uTide: wet.tide ?? 3,
    uRetard: wet.retard ?? 0.6,
    uAniso: Math.min(0.85, fibre * (0.4 + 0.6 * absorb)),
    uEvap: 0.016 * wet.dry,
    uFront: 0.3 + 0.6 * sizing,
    uRing: 0.25 * (0.3 + sizing) * wet.flow,
    uSettle: 0.006 + 0.03 * wet.gran,
    uGran: 0.6 * wet.gran,
    uLift: 0.12 * (1 - wet.dye) + 0.01,
    uDye: wet.dye,
    uMDry: 0.012 * wet.dry,
    uMix: 0.02 * wet.flow,
    // (a lingering pen's own pool spans a step or two: only passes further apart are layers)
    uLayer: wet.layer ?? 1,
    uLayerDt: 2.5 / STEPS_DRAW,
  };
}

/**
 * Share of the medium's colour that travels with the liquid (the rest is fixed where the tool
 * touched and shows as the crisp core). A property of the medium: how the paper then moves that
 * liquid (standing, bleeding through the fibres, pooling) is the simulation's job. Used by both the
 * injection and the composite. (Callers still pass the paper; it no longer scales the share.)
 */
export function wetMobile(wet) {
  return Math.max(0.05, Math.min(0.95, wet.mobile));
}

/**
 * Metallic sheen of a dye ink that dried thick: [r, g, b, strength] for the composite. A dense dye
 * film reflects the band it absorbs, shifted to longer wavelengths (anomalous dispersion), so the
 * sheen is roughly the ink's complementary hue turned toward red: blue and blue-black inks glint
 * a coppery bronze, teal pink-red, crimson green-gold; a neutral black a faint green-gold. Only
 * dark, strong inks do it, only where they pooled and dried (the composite gates it on the
 * simulated pools), and only on a sheet that keeps the dye on its surface: it grows with the
 * sizing's cube, so thirsty sketch and kraft paper show next to nothing. It is a mirror reflection
 * of the window (a narrow lobe), never a tint: seen from anywhere but near the mirror angle, the
 * ink keeps its own colour; the reflection itself is mostly white with a bronze cast.
 * rgb = the ink (0..1 sRGB), phys = paperPhysics(paper).
 */
export function dyeSheen(wet, rgb, phys) {
  const k = wet.sheen ?? 0;
  if (!(k > 0)) return [0, 0, 0, 0];
  const [r, g, b] = rgb, mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let col, kind = 1;
  if (mx - mn < 0.04) col = [0.62, 0.66, 0.36];                // neutral black: green-gold
  else {
    let h = mx === r ? ((g - b) / (mx - mn)) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
    h = (h * 60 + 360) % 360;
    const hs = ((h + 180 - 40) % 360 + 360) % 360;           // complement, turned toward red
    const f = n => { const kk = (n + hs / 60) % 6; return 1 - 0.7 * Math.max(0, Math.min(kk, 4 - kk, 1)); };
    col = [f(5), f(3), f(1)];                                  // HSV -> RGB, s 0.7, v 1
    if (h > 15 && h < 75) kind = 0.2;                          // browns and ochres hardly sheen
  }
  const dark = 1 - Math.min(1, Math.max(0, (lum - 0.12) / 0.25));
  const tint = col.map(c => 0.7 + 0.3 * c);                   // mostly the window's own white
  return [tint[0], tint[1], tint[2], 0.12 * k * kind * dark * phys.sizing ** 3];
}

/**
 * How far a pool spreads where the pen lingers: its radius over the line's half-width, per unit
 * of dwell above 1 (the inject pass draws a soft round blot that wide). Thin liquids on thirsty
 * paper blot widest; the medium scales it with wet.pool.
 */
export function poolGrow(wet, phys) {
  return (wet.pool ?? 1) * 0.9 * (0.6 + 0.8 * phys.absorb) * (0.5 + 0.5 * wet.flow);
}

/**
 * GPU ping-pong for the wet simulation. The renderer owns the context and the programs'
 * compilation (the built step program as `prog`, or a program(vs, fs) callback), draws the
 * injection map into `inj` and the sheet's physical map into `phys`, and calls step() in order.
 */
export class WetSim {
  constructor(gl, { prog, program, vertFull, floatRT, floatLinear, half = false }) {
    this.gl = gl;
    // a program handed in (or set later, before step()) belongs to the caller: it outlives this
    // simulation. With neither, the simulation can be allocated (formats settled) but not stepped.
    this.ownProg = !prog && !!program;
    this.prog = prog || (program ? program(vertFull, FRAG_WET_STEP) : null);
    // Deposits grow by ~1e-3 of their value per step, which half floats round more coarsely, so
    // the state is 32-bit where it can still be filtered, 16-bit otherwise, 8-bit (scaled) last.
    // half: 16-bit anyway, for half the memory (phones, chips): measured on the four wet media at
    // 2400 px, it differs from 32-bit by ~1 level on average (p99 5), which the eye does not see.
    this.stateFmt = floatRT && floatLinear && !half ? 'rgba32f' : floatRT ? 'rgba16f' : 'rgba8';
    this.floatRT = floatRT;
    this.w = 0; this.h = 0;
    this.k = 0;             // steps done
    this.cur = 0;           // index of the newest state
    this.A = [null, null]; this.B = [null, null]; this.C = [null, null];
    this.fbo = [null, null];
    this.inj = null; this.inj2 = null; this.phys = null;
    this.scaleA = this.stateFmt === 'rgba8' ? 4 : 1;
    this.complete = new Set();  // framebuffer layouts known complete (see _fboFor)
  }

  _tex(w, h, fmt, filter) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    const f = {
      rgba32f: [gl.RGBA32F, gl.RGBA, gl.FLOAT],
      rgba16f: [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT],
      rgba8: [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE],
      r32f: [gl.R32F, gl.RED, gl.FLOAT],
      r16f: [gl.R16F, gl.RED, gl.HALF_FLOAT],
    }[fmt];
    gl.texImage2D(gl.TEXTURE_2D, 0, f[0], w, h, 0, f[1], f[2], null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  // key: a layout already found complete in this context is not asked again. The status query
  // waits for everything queued before it (0.1-0.8 s behind other contexts' work), and the grid is
  // freed and allocated again as the user moves between dry and wet tools.
  _fboFor(key, ...texs) {
    const gl = this.gl;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    texs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers(texs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const ok = this.complete.has(key) || gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    if (ok) this.complete.add(key);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, ok };
  }

  /** (Re)allocate for a grid of w x h cells; returns false if this device cannot. */
  alloc(w, h) {
    if (w === this.w && h === this.h && this.A[0]) return true;
    this.free();
    const gl = this.gl;
    const tryFmt = fmt => {
      const lin = gl.LINEAR;
      this.A = [this._tex(w, h, fmt, lin), this._tex(w, h, fmt, lin)];
      // B's drift field needs smooth gradients: float where the state is float
      const fb = fmt === 'rgba8' ? 'rgba8' : 'rgba16f';
      this.B = [this._tex(w, h, fb, lin), this._tex(w, h, fb, lin)];
      // C: colourant caught in the fibres (stains, bleeds), kept apart from the surface deposit
      // because it is not bounded by the surface water's hard edge. One channel (x) is all it needs.
      const fc = { rgba32f: 'r32f', rgba16f: 'r16f', rgba8: 'rgba8' }[fmt];
      this.C = [this._tex(w, h, fc, lin), this._tex(w, h, fc, lin)];
      const f0 = this._fboFor(`state:${fmt}`, this.A[0], this.B[0], this.C[0]), f1 = this._fboFor(`state:${fmt}`, this.A[1], this.B[1], this.C[1]);
      this.fbo = [f0.fbo, f1.fbo];
      if (f0.ok && f1.ok) return true;
      this.free();
      return false;
    };
    let ok = tryFmt(this.stateFmt);
    if (!ok && this.stateFmt === 'rgba32f') { this.stateFmt = 'rgba16f'; ok = tryFmt('rgba16f'); }
    if (!ok && this.stateFmt !== 'rgba8') { this.stateFmt = 'rgba8'; this.scaleA = 4; ok = tryFmt('rgba8'); }
    if (!ok) return false;
    const injFmt = this.floatRT ? 'rgba16f' : 'rgba8';
    // (linear: the composite samples its coverage (z) through a B-spline; the step reads texels)
    this.inj = this._tex(w, h, injFmt, gl.LINEAR);
    // the EARLIEST pass over each cell (1 - its pen time; MAX-blended like inj): a later pass of the
    // line over the same cells (touching rings, a wash laid over a dried one) adds its ink on top
    this.inj2 = this._tex(w, h, this.floatRT ? 'r16f' : 'rgba8', gl.NEAREST);
    const fi = this._fboFor(`inj:${injFmt}`, this.inj, this.inj2);
    if (!fi.ok) { gl.deleteFramebuffer(fi.fbo); gl.deleteTexture(this.inj2); this.inj2 = null; this.injFbo = this._fboFor(`inj1:${injFmt}`, this.inj).fbo; }
    else this.injFbo = fi.fbo;
    this.phys = this._tex(w, h, 'rgba8', gl.NEAREST);
    this.physFbo = this._fboFor('phys', this.phys).fbo;
    this.w = w; this.h = h;
    this.physKey = null;
    this.reset();
    return true;
  }

  /** Back to dry, clean paper (step 0). */
  reset() {
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    for (const f of this.fbo) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.k = 0; this.cur = 0;
  }

  get stateNew() { return this.A[this.cur]; }
  get stateOld() { return this.k > 0 ? this.A[1 - this.cur] : this.A[this.cur]; }
  get extent() { return this.B[this.cur]; }
  get soakNew() { return this.C[this.cur]; }
  get soakOld() { return this.k > 0 ? this.C[1 - this.cur] : this.C[this.cur]; }

  /**
   * Run one step. p = uniforms from wetParams(); win = [t0, t1] injection window; rect = [x0, y0,
   * x1, y1] cells that can change this step (everything else is still clean paper).
   */
  step(p, win, dryMul, final, rect, emptyVao) {
    const gl = this.gl, pr = this.prog;
    const src = this.cur, dst = 1 - this.cur;
    gl.useProgram(pr);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[dst]);
    gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.BLEND);
    if (rect) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(rect[0], rect[1], Math.max(0, rect[2] - rect[0]), Math.max(0, rect[3] - rect[1]));
    }
    const U = n => gl.getUniformLocation(pr, n);
    if (!pr._set) {
      pr._loc = {};
      for (const n of ['uA', 'uB', 'uC', 'uInj', 'uInj2', 'uPhys', 'uWin', 'uDryMul', 'uFinal', 'uScaleA',
        'uDiff', 'uPin', 'uCapF', 'uAbsorb', 'uCap', 'uWick', 'uAniso', 'uEvap', 'uFront', 'uRing', 'uSettle', 'uGran', 'uLift', 'uDye', 'uMDry', 'uMix',
        'uWickS', 'uFilter', 'uTide', 'uRetard', 'uLayer', 'uLayerDt']) pr._loc[n] = U(n);
      pr._set = true;
    }
    const L = pr._loc;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.A[src]); gl.uniform1i(L.uA, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.B[src]); gl.uniform1i(L.uB, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.inj); gl.uniform1i(L.uInj, 2);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.phys); gl.uniform1i(L.uPhys, 3);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.C[src]); gl.uniform1i(L.uC, 4);
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, this.inj2 || this.inj); gl.uniform1i(L.uInj2, 5);
    if (this._lastP !== p) {
      for (const k in p) if (L[k]) gl.uniform1f(L[k], p[k]);
      gl.uniform1f(L.uScaleA, this.scaleA);
      if (!this.inj2) gl.uniform1f(L.uLayer, 0);
      this._lastP = p;
    }
    gl.uniform2f(L.uWin, win[0], win[1]);
    gl.uniform1f(L.uDryMul, dryMul);
    gl.uniform1f(L.uFinal, final ? 1 : 0);
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
    gl.activeTexture(gl.TEXTURE0);
    this.cur = dst;
    this.k++;
  }

  free() {
    const gl = this.gl;
    for (const t of [...this.A, ...this.B, ...this.C, this.inj, this.inj2, this.phys]) if (t) gl.deleteTexture(t);
    for (const f of [...this.fbo, this.injFbo, this.physFbo]) if (f) gl.deleteFramebuffer(f);
    this.A = [null, null]; this.B = [null, null]; this.C = [null, null]; this.fbo = [null, null];
    this.inj = this.inj2 = this.phys = this.injFbo = this.physFbo = null;
    this.w = this.h = 0;
  }

  destroy() {
    this.free();
    if (this.prog && this.ownProg) this.gl.deleteProgram(this.prog);
    this.prog = null;
  }
}
