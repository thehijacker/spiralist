// GLSL ES 3.00 programs, assembled from the shared chunks, the brush library (brushes.js) and
// the paper library (papers.js). The wet-media simulation's own step program lives in wetsim.js.
//
// Coordinates:
//   P (px)  — position on the FULL paper in output pixels. A render target may be a strip of the
//             paper (large exports); uOrigin is the strip's top-left corner on the paper.
//   U       — paper unit = 1/1000 of the paper width (uU = px per U).
// Paper grain lives in a tileable 1024^2 texture covering 1/TILES_ACROSS of the paper width,
// sampled with explicit LOD. Its G channel stores h^2 so the mip chain also carries variance —
// brushes that threshold against grain widen the threshold by the variance the current
// resolution cannot show, so coverage stays statistically the same at every size.
//
// Surface heights (grooves, raised material) are in units of 0.05 mm = 0.25 U; slopes are taken
// per paper unit, so the relief lights the same at every output size.

import { BRUSH_GLSL } from './brushes.js';
import { PAPER_TILE_GLSL, PAPER_SURFACE_GLSL, PAPER_PHYS_GLSL, PAPER_FIBRE_GLSL } from './papers.js';
import { STEPS_SETTLE } from './wetsim.js';

export const TILES_ACROSS = 6.0;
export const TILE_SIZE = 1024;
/** Surface height unit in paper units (1.0 in the surface target = 0.05 mm). */
export const SURF_UNIT_U = 0.25;
/** Material ids for the composite's specular (BRUSHES[].material). oil = ballpoint paste (bronzes). */
export const MATERIALS = { none: 0, ink: 1, graphite: 2, wax: 3, chalk: 4, metal: 5, light: 6, oil: 7 };

const COMMON = /* glsl */`
uint hashU(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return v.x ^ v.y;
}
float hash21(vec2 p) { return float(hashU(uvec2(ivec2(floor(p)) + 65536))) * (1.0 / 4294967295.0); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm2(vec2 p) { return 0.65 * vnoise(p) + 0.35 * vnoise(p * 2.03 + 17.1); }
`;

// Paper grain lookup shared by the stroke and composite passes.
const GRAIN = /* glsl */`
uniform sampler2D uPaperTex;
uniform float uTilePx;     // output px covered by one tile
uniform float uTileLod;    // log2(TILE_SIZE / uTilePx)
uniform float uPaperPx;    // full paper width in px
uniform float uU;          // px per paper unit (paper width / 1000)
// Returns (mean height, std-dev hidden below this resolution, specks). Two decorrelated
// samplings are blended by a slow mask so the tile never visibly repeats.
vec3 grainAt(vec2 P, float lodBias) {
  float lod = max(0.0, uTileLod + lodBias);
  vec2 uv1 = P / uTilePx;
  vec2 uv2 = mat2(0.7986, -0.6018, 0.6018, 0.7986) * (P / (uTilePx * 1.137)) + vec2(0.37, 0.71);
  vec4 a = textureLod(uPaperTex, uv1, lod);
  vec4 b = textureLod(uPaperTex, uv2, lod);
  float m = smoothstep(0.25, 0.75, vnoise(P / uPaperPx * 7.0 + 3.1));
  vec4 t = mix(a, b, m);
  float v = max(0.0, t.g - t.r * t.r);
  return vec3(t.r, sqrt(v), t.b);
}
// Expected fraction of the area whose grain height exceeds threshold th (soft = edge softness).
float above(vec3 g, float th, float soft) {
  float w = soft + 1.25 * g.y;
  return smoothstep(th - w, th + w, g.x);
}
// Attenuate procedural detail whose feature size (px) falls below ~2px, instead of aliasing.
float aa(float featurePx) { return clamp(featurePx * 0.5 - 0.35, 0.0, 1.0); }
`;

// ---------------------------------------------------------------------------------------------
export const VERT_FULL = /* glsl */`#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const FRAG_PAPER_TILE = /* glsl */`#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 frag;
uniform float uSeed;
uniform float uTooth;
uniform float uToothCells;
uniform float uBumps;
uniform float uBumpCells;
uniform float uFibers;
uniform float uSpecks;
uniform float uLaid;
${COMMON}
${PAPER_TILE_GLSL}
void main() { frag = paperTile(vUv); }`;

// Physical map of the sheet on the wet-simulation grid (see paperPhys in papers.js).
export const FRAG_PAPER_PHYS = /* glsl */`#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 frag;
uniform vec2 uGrid;        // grid size, cells
uniform float uSeed;
uniform float uFibre;
uniform float uAbsorbP;
uniform vec2 uGrainDir;
${COMMON}
${GRAIN}
${PAPER_FIBRE_GLSL}
${PAPER_PHYS_GLSL}
void main() { frag = paperPhys(vec2(vUv.x, 1.0 - vUv.y) * uGrid); }`;

// ---------------------------------------------------------------------------------------------
// Stroke pass: one instance per segment of the polyline, rendered as a round-capped capsule
// via its distance field. MAX blending merges overlapping capsules without double-darkening.
// Two uses:
//   sheet pass (uPass 0): pigment + surface (MRT) at the output resolution
//   inject pass (uPass 1): the liquid each segment lays down, on the wet-simulation grid:
//     (water, pigment, 0, pen time), MAX-blended.
export const VERT_STROKE = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec4 aA;   // x, y, w, s        (point i)
layout(location = 1) in vec3 aAt;  // tone, turn, dwell (point i)
layout(location = 2) in vec4 aB;   // point i+1
layout(location = 3) in vec3 aBt;
layout(location = 4) in vec4 aCol; // photo colour of point i (normalised bytes)
layout(location = 5) in vec4 aT;   // pacing time (0..1) and curvature (1 / circle units) of points i, i+1
uniform vec2 uRes;       // render target size px
uniform vec2 uOrigin;    // target's top-left on the paper, px
uniform vec2 uCenter;    // circle centre on the paper, px
uniform float uRadius;   // circle radius, px
uniform float uMinW;     // thinnest drawn width in px (thinner strokes fade instead)
uniform float uSpread;   // quad size multiplier for halos (charcoal, chalk dust)
uniform float uPaceK;    // 'natural' pacing's ink weight (spiral.js pacingTable)
uniform int uPass;       // 1 = inject pass (the wet simulation's liquid): quads also cover the pools
uniform float uPoolGrow; // inject: pool radius / line half-width, per unit of dwell above 1
flat out vec2 vP0;
flat out vec2 vP1;
flat out vec2 vW;
flat out vec2 vS;
flat out vec2 vTone;
flat out vec4 vCol;
flat out vec2 vDwell;
flat out float vTime;
flat out vec2 vCurv;
out vec2 vPos;
void main() {
  vec2 p0 = uCenter + aA.xy * uRadius;
  vec2 p1 = uCenter + aB.xy * uRadius;
  float w0 = aA.z * uRadius, w1 = aB.z * uRadius;
  vec2 d = p1 - p0;
  float len = length(d);
  vec2 t = len > 1e-5 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-t.y, t.x);
  float hw = max(max(w0, w1), uMinW) * 0.5 * uSpread + 1.5;
  if (uPass == 1) hw = max(hw, max(max(w0, w1), uMinW) * 0.5 * (1.0 + uPoolGrow * max(max(aAt.z, aBt.z) - 1.0, 0.0)) + 1.5);
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 pos = mix(p0 - t * hw, p1 + t * hw, corner.x) + n * mix(-hw, hw, corner.y);
  vPos = pos;
  vP0 = p0; vP1 = p1;
  vW = vec2(w0, w1);
  vS = vec2(aA.w, aB.w) * uRadius;
  vTone = vec2(aAt.x, aBt.x);
  vDwell = vec2(max(aAt.z, 1.0), max(aBt.z, 1.0));
  vTime = aT.z;
  vCurv = aT.yw / uRadius;
  vCol = aCol;
  vec2 q = pos - uOrigin;
  gl_Position = vec4(q.x / uRes.x * 2.0 - 1.0, 1.0 - q.y / uRes.y * 2.0, 0.0, 1.0);
}`;

export const FRAG_STROKE = /* glsl */`#version 300 es
precision highp float;
precision highp int;
flat in vec2 vP0;
flat in vec2 vP1;
flat in vec2 vW;
flat in vec2 vS;
flat in vec2 vTone;
flat in vec4 vCol;
flat in vec2 vDwell;
flat in float vTime;
flat in vec2 vCurv;      // curvature of points i, i+1 in 1 / px
// Paper px of this fragment. Taken from gl_FragCoord, not the interpolated vPos: pixel centres are
// exact there (x + 0.5) and the origin is whole, so a strip of a big export computes bit for bit
// what a single full pass does. An interpolated varying rounds differently for every target size,
// and texture thresholds and hash cells (crayon, chalk) flip on that rounding.
uniform vec2 uRes;
uniform vec2 uOrigin;
vec2 vPos;
layout(location = 0) out vec4 frag;   // sheet: pigment        inject: water, pigment, 0, time
layout(location = 1) out vec4 surf;   // sheet: groove, raised, sheen, pen time
uniform int uBrush;
uniform vec3 uInk;         // sRGB 0..1 ink colour
uniform int uCover;        // 0 = multiply (dark media), 1 = cover (light / opaque media)
uniform int uPhotoColor;
uniform float uMinW;
uniform float uSeed;
uniform float uSpread;
uniform float uPaceK;
uniform int uPass;         // 0 = sheet, 1 = inject
uniform float uHeadClip;   // < 1: this draw is the pen's partial segment, cut at this fraction
uniform float uWetLoad;    // inject: liquid load of the medium
uniform float uMobile;     // inject: share of the pigment that travels with the liquid
uniform float uDwellK;     // inject: extra liquid per unit of dwell
uniform float uPoolGrow;   // inject: pool radius / line half-width, per unit of dwell above 1
uniform float uPoolAt;     // inject: dwell above 1 the tool needs before it floods (brushes.js wet.poolAt)
// the sheet's physical properties (papers.js paperPhysics), for media that react to the paper
// in the stroke itself (fibre feathering, capillary dots): absorbency, sizing, fibre wicking, and
// the machine direction as a unit vector (x right, y down the sheet)
uniform float uPaperAbsorb;
uniform float uPaperSizing;
uniform float uPaperFibre;
uniform vec2 uPaperGrain;
uniform float uLineEnd;    // arc length (px, like st.s) where the line ends: the pen lifts there
${COMMON}
${GRAIN}
${PAPER_FIBRE_GLSL}
${BRUSH_GLSL}

// Photo colours are pushed toward something that reads as ink on this paper.
vec3 photoInk(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 s = clamp(mix(vec3(l), c, 1.45), 0.0, 1.0);
  float ls = dot(s, vec3(0.2126, 0.7152, 0.0722));
  if (uCover == 0) { if (ls > 0.52) s *= 0.52 / ls; }
  else if (ls < 0.5) s = mix(s, vec3(1.0), (0.5 - ls) / (1.0 - ls));
  return s;
}

void main() {
  vPos = uOrigin + vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 ba = vP1 - vP0;
  vec2 pa = vPos - vP0;
  float bb = dot(ba, ba);
  float hRaw = bb > 1e-8 ? dot(pa, ba) / bb : 0.0;
  float h = clamp(hRaw, 0.0, 1.0);
  vec2 q = pa - ba * h;
  float dist = length(q);
  float side = (ba.x * pa.y - ba.y * pa.x) >= 0.0 ? 1.0 : -1.0;
  float wTrue = mix(vW.x, vW.y, h);
  float w = max(wTrue, uMinW);
  float thin = clamp(wTrue / w, 0.0, 1.0);          // hairlines fade rather than vanish
  Stroke st;
  st.hw = 0.5 * w;
  st.dist = dist;
  st.v = dist / st.hw;
  st.side = side;
  st.vs = st.v * side;
  st.s = mix(vS.x, vS.y, h);
  st.sU = st.s / uU;
  st.tone = mix(vTone.x, vTone.y, h);
  st.P = vPos;
  st.cov = clamp(st.hw - dist + 0.5, 0.0, 1.0);
  st.dwell = mix(vDwell.x, vDwell.y, h);
  // the 'natural' pacing's hand: slower where it lays ink and where it lingers (1 = cruising)
  st.speed = (1.0 - uPaceK) / (mix(1.0 - uPaceK, 1.0, st.tone) * st.dwell);
  st.time = vTime;
  st.curv = mix(vCurv.x, vCurv.y, h) * uU;          // signed, 1 / paper unit
  st.dir = bb > 1e-8 ? ba * inversesqrt(bb) : vec2(1.0, 0.0);   // along the line, paper px axes (y down)
  st.hU = 0.5 * wTrue / uU;
  vec3 ink = uPhotoColor == 1 ? photoInk(vCol.rgb) : uInk;
  vec3 ink0 = ink;                                  // (the inject pass compares the tool's tint to it)
  Surface sf;
  // Footprint: nothing a brush writes may reach the edge of its quad (hw * spread + 1.5 px), whose
  // rasterised boundary snaps differently for every target size (strips vs one pass). A hard cut
  // half a pixel inside it: 1 wherever any brush reaches (hw * spread + its 0.5 px ramp), so it only
  // bounds a term a brush forgot to (say a sheen that ignores coverage).
  float foot = dist < st.hw * uSpread + 1.0 ? 1.0 : 0.0;
  float a = clamp(brushDeposit(uBrush, st, ink, sf) * thin, 0.0, 1.0) * foot;
  float len = sqrt(bb);
  if (uPass == 1) {
    // Liquid for the wet simulation, MAX-blended like the sheet (summing the many short segments
    // inside a tight bend would flood it). A lingering pen pools instead: a blot wider than the
    // line (the nib standing still feeds it), flat-topped like a level pool, soft-edged, and round
    // about every point of the lingering stretch, so a pause grows a blob with round ends rather
    // than a darker band cut square where the dwell begins.
    // (a tool that only floods where the hand really stops needs more dwell, and the hand hesitates
    // more at some turns than at others: not every maze corner blots)
    float hes = vnoise(vec2(st.sU / 70.0, uSeed * 3.7 + 11.0));
    float dw = max(st.dwell - 1.0 - uPoolAt * (0.4 + 1.2 * hes), 0.0);
    float rP = st.hw * (1.0 + uPoolGrow * dw);
    float blob = (1.0 - smoothstep(0.75 * rP, rP + 0.5, dist)) * thin * (dist < rP + 1.0 ? 1.0 : 0.0);
    float liq = max(a, blob * min(dw, 1.0) * (1.0 + uDwellK * dw));
    // no liquid without its pen time: a time of 0 would pour a faint tail in at the first step
    liq = liq > 1e-4 ? liq : 0.0;
    // Pigment: where the tool touched (a), only the medium's mobile share travels (the rest is the
    // crisp core the composite draws); liquid beyond it (a lingering pen's blot, a loaded brush's
    // bead) is the ink itself, so all of its colour is in the simulation.
    // z: the stroke's own coverage at grid scale (the composite sharpens unmoved pigment with it)
    float pigL = min(a, liq) * uMobile + max(liq - a, 0.0);
    // a brush that thins or thickens its film here (Beer-Lambert: it tints ink to ink^dens) puts as
    // much more or less dye into the liquid, so pools and bleeds share the line's own shading
    float l0 = lum3(ink0);
    if (uCover == 0 && l0 < 0.8) pigL *= clamp(log(max(lum3(ink), 1e-3)) / log(max(l0, 1e-3)), 0.3, 2.5);
    frag = vec4(liq * uWetLoad * sf.wet, pigL, liq > 0.0 ? a : 0.0, liq > 0.0 ? vTime : 0.0);
    // second target: the earliest pass over this cell (1 - pen time, MAX-blended; wetsim.js inj2)
    surf = liq > 0.0 ? vec4(1.0 - vTime, 0.0, 0.0, 0.0) : vec4(0.0);
    return;
  }

  // The pen's partial segment is cut at the head, round like the stroke's own end: every
  // fragment it draws has exactly the value the whole segment will give it (the same varyings),
  // only fewer of them, so MAX blending later leaves no trace of where the head was.
  float clip = 1.0;
  if (uHeadClip < 1.0) {
    vec2 head = vP0 + ba * uHeadClip;
    float rH = max(mix(vW.x, vW.y, uHeadClip), uMinW) * 0.5 * uSpread;
    clip = max(clamp((uHeadClip - hRaw) * len + 0.5, 0.0, 1.0), clamp(rH - length(vPos - head) + 0.5, 0.0, 1.0));
    a *= clip;
  }
  // Pigment buffer: absorbance for dark media, premultiplied colour for cover media.
  vec3 rgb = uCover == 0 ? (1.0 - ink) * a : ink * a;
  frag = vec4(rgb, a);
  float k = thin * clip * foot;
  surf = vec4(clamp(sf.groove, 0.0, 1.0) * k, clamp(sf.raised, 0.0, 1.0) * k, clamp(sf.sheen, 0.0, 1.0) * k,
              a > 1e-3 ? vTime : 0.0);
}`;

// ---------------------------------------------------------------------------------------------
// Composite: lit paper surface (tooth relief, fibres, mottling) + surface relief of the medium
// (grooves, raised material) + pigment + the wet layer (simulated bleed, pooling, rims, wet sheen)
// + specular per material + optional glow.
export const FRAG_COMPOSITE = /* glsl */`#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uPigment;
uniform sampler2D uSurf;
uniform sampler2D uGlow;
uniform sampler2D uSimA0;   // wet state, one step back: water, suspended, deposited, moisture
uniform sampler2D uSimA1;   // wet state, newest step
uniform sampler2D uSimB;    // wet extent (x)
uniform vec2 uRes;
uniform vec2 uOrigin;
uniform vec3 uPaperColor;
uniform vec3 uSpeckColor;
uniform float uRelief;
uniform float uMottle;
uniform float uSmudge;
uniform float uSpeckAmt;
uniform float uGrid;
uniform int uCover;
uniform int uGlowOn;
uniform float uGlowAmt;
uniform int uTransparent;  // 1 = ink only, transparent paper (straight alpha)
uniform float uLightInk;   // how much the paper relief shows through the ink
uniform vec3 uInk;
uniform int uPhotoColor;
uniform float uPigLod;     // mip of the pigment that averages the ink colour over ~a sim cell
// light (renderer.setLight / setTime)
uniform vec2 uPaperLight;  // away from the light across the sheet, length = paper relief gain
uniform vec3 uLightDir;    // toward the light (x right, y down the sheet, z up), unit
uniform vec3 uViewDir;     // toward the viewer, unit
uniform vec4 uEye;         // w = 1: the camera's position (paper px, z = height above the sheet):
                           // each pixel then sees it from its own angle, so glints stay local
uniform float uCotEl;      // cot(light elevation): how strongly slopes turn into shading
uniform vec3 uLightCol;    // intensity x warmth tint (1,1,1 = the default window light)
uniform float uTime;
uniform int uTimeOn;
uniform int uMaterial;     // MATERIALS in shaders.js
uniform float uSurfU;      // px per surface-height unit (SURF_UNIT_U * uU)
uniform float uSeed;
// wet layer
uniform int uSimOn;
uniform float uSimFrac;    // blend between the two states
uniform float uSimX;       // simulation position in steps (drawing steps count 1..uSimN)
uniform float uSimN;
uniform float uMobile;
uniform float uGranD;
uniform vec2 uSheetPx;     // full paper size, px
uniform vec2 uSimTexel;    // 1 / grid size
uniform float uCellU;      // paper units per grid cell
uniform float uWetH;       // liquid height (surface units) per unit of simulated water
uniform float uSimScale;   // state textures hold value / uSimScale (8-bit fallback)
uniform sampler2D uSimInj; // the injection map: z = the stroke's coverage at grid scale
uniform sampler2D uSimC0;  // colourant caught in the fibres (x), one step back
uniform sampler2D uSimC1;  // ... newest step
uniform vec4 uDyeSheen;    // dried dye ink's metallic sheen: colour, strength (0 = none)
uniform float uSimSharp;   // 0..1: how firmly unmoved simulated pigment follows the stroke's fine shape
${COMMON}
${GRAIN}
${PAPER_SURFACE_GLSL}

// Light flickering in a gas tube: a slow breathing plus rare short dips (neon, setTime).
float flicker(float t) {
  float f = 1.0 - 0.035 * (0.5 + 0.5 * sin(6.2832 * 0.43 * t)) - 0.02 * (0.5 + 0.5 * sin(6.2832 * 1.7 * t + 1.3));
  float slot = floor(t * 9.0);
  float r = hash21(vec2(slot, 17.0));
  float dip = step(r, 0.035) * (0.5 + 0.5 * sin(3.1416 * fract(t * 9.0)));
  return f * (1.0 - 0.3 * dip);
}

// Normalised Blinn-Phong lobe: the peak narrows and brightens with n, its integral stays put.
float lobe(float nh, float n) { return (n + 2.0) / 8.0 * exp(n * log(max(nh, 1e-4))); }

// Cubic B-spline sample of a grid texture's x channel from 4 bilinear taps (C2-smooth contours).
float bsplineX(sampler2D t, vec2 uv, vec2 texel) {
  vec2 p = uv / texel - 0.5, i = floor(p), f = p - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (-f3 + 3.0 * f2 - 3.0 * f + 1.0) / 6.0, w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
  vec2 w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0, w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) * texel, h1 = (i + 1.5 + w3 / g1) * texel;
  return g0.y * (g0.x * texture(t, h0).x + g1.x * texture(t, vec2(h1.x, h0.y)).x)
       + g1.y * (g0.x * texture(t, vec2(h0.x, h1.y)).x + g1.x * texture(t, h1).x);
}
// The paper's fibre strands at P (the tile's alpha: 0.5 neutral, a strand lighter or darker),
// sampled like grainAt: a bleed's front runs on along them.
float strandAt(vec2 P) {
  float lod = max(0.0, uTileLod);
  vec2 uv1 = P / uTilePx;
  vec2 uv2 = mat2(0.7986, -0.6018, 0.6018, 0.7986) * (P / (uTilePx * 1.137)) + vec2(0.37, 0.71);
  float m = smoothstep(0.25, 0.75, vnoise(P / uPaperPx * 7.0 + 3.1));
  return mix(textureLod(uPaperTex, uv1, lod).a, textureLod(uPaperTex, uv2, lod).a, m);
}
// The same B-spline for all four channels (the wet state: its pigment and water then have smooth,
// round contours where the grid is magnified, never the bilinear field's diamonds and octagons).
vec4 bspline4(sampler2D t, vec2 uv, vec2 texel) {
  vec2 p = uv / texel - 0.5, i = floor(p), f = p - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (-f3 + 3.0 * f2 - 3.0 * f + 1.0) / 6.0, w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
  vec2 w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0, w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) * texel, h1 = (i + 1.5 + w3 / g1) * texel;
  return g0.y * (g0.x * texture(t, h0) + g1.x * texture(t, vec2(h1.x, h0.y)))
       + g1.y * (g0.x * texture(t, vec2(h0.x, h1.y)) + g1.x * texture(t, h1));
}
// Gradient of the same B-spline (x channel, per texel, texel axes) from 8 bilinear taps: the
// derivative weights pair up with equal signs just like the value weights, so each pair is one tap.
vec2 bsplineGradX(sampler2D t, vec2 uv, vec2 texel) {
  vec2 p = uv / texel - 0.5, i = floor(p), f = p - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (-f3 + 3.0 * f2 - 3.0 * f + 1.0) / 6.0, w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
  vec2 w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0, w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) * texel, h1 = (i + 1.5 + w3 / g1) * texel;
  vec2 d1 = 1.5 * f2 - 2.0 * f, d3 = 0.5 * f2;
  vec2 e1 = 0.5 + f - f2;                          // d2 + d3; d0 + d1 = -e1
  vec2 k0 = (i - 0.5 + d1 / -e1) * texel, k1 = (i + 1.5 + d3 / e1) * texel;
  float dx = e1.x * (g0.y * (texture(t, vec2(k1.x, h0.y)).x - texture(t, vec2(k0.x, h0.y)).x)
                   + g1.y * (texture(t, vec2(k1.x, h1.y)).x - texture(t, vec2(k0.x, h1.y)).x));
  float dy = e1.y * (g0.x * (texture(t, vec2(h0.x, k1.y)).x - texture(t, vec2(h0.x, k0.y)).x)
                   + g1.x * (texture(t, vec2(h1.x, k1.y)).x - texture(t, vec2(h1.x, k0.y)).x));
  return vec2(dx, dy);
}
// Bilinear sample at p (texels, centres at +0.5) from exact texel fetches, clamped at the edges.
vec4 bilerp(sampler2D t, vec2 p) {
  ivec2 hi = textureSize(t, 0) - 1;
  vec2 q = p - 0.5, f = floor(q), w = q - f;
  ivec2 b = ivec2(f);
  vec4 t00 = texelFetch(t, clamp(b, ivec2(0), hi), 0), t10 = texelFetch(t, clamp(b + ivec2(1, 0), ivec2(0), hi), 0);
  vec4 t01 = texelFetch(t, clamp(b + ivec2(0, 1), ivec2(0), hi), 0), t11 = texelFetch(t, clamp(b + ivec2(1, 1), ivec2(0), hi), 0);
  return mix(mix(t00, t10, w.x), mix(t01, t11, w.x), w.y);
}
// Relief of the medium (raised - groove, surface units) at this pixel + d px, bilinear from exact
// texel fetches: a strip of a big export and a full pass then agree to the bit.
float reliefAt(ivec2 ip, ivec2 hi, vec2 d) {
  vec2 f = floor(d), w = d - f;
  ivec2 b = ip + ivec2(f);
  vec4 t00 = texelFetch(uSurf, clamp(b, ivec2(0), hi), 0);
  vec4 t10 = texelFetch(uSurf, clamp(b + ivec2(1, 0), ivec2(0), hi), 0);
  vec4 t01 = texelFetch(uSurf, clamp(b + ivec2(0, 1), ivec2(0), hi), 0);
  vec4 t11 = texelFetch(uSurf, clamp(b + ivec2(1, 1), ivec2(0), hi), 0);
  return mix(mix(t00.g - t00.r, t10.g - t10.r, w.x), mix(t01.g - t01.r, t11.g - t11.r, w.x), w.y);
}

void main() {
  // Position from gl_FragCoord (exact pixel centres; see FRAG_STROKE), and this pixel's own texels
  // fetched, not filtered: a strip and a full pass then read identical values.
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 P = uOrigin + vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  ivec2 ip = ivec2(gl_FragCoord.xy), hiP = ivec2(uRes) - 1;
  vec4 pig = texelFetch(uPigment, ip, 0);
  vec4 sf = texelFetch(uSurf, ip, 0);
  vec4 glow = uGlowOn == 1 ? bilerp(uGlow, gl_FragCoord.xy * 0.25) * uGlowAmt : vec4(0.0);   // quarter res
  float flick = (uMaterial == 6 && uTimeOn == 1) ? flicker(uTime) : 1.0;
  glow *= flick;
  // a gas tube's bloom is the gas's own saturated colour: the white-hot core is only the tube's
  // axis, so the blurred pigment's whitened colour is put back to the ink's hue at its brightness
  if (uMaterial == 6 && uPhotoColor == 0 && uGlowOn == 1) {
    float im = max(uInk.r, max(uInk.g, uInk.b));
    glow.rgb = uInk / max(im, 1e-3) * max(glow.r, max(glow.g, glow.b));
  }

  // ---- wet layer: the simulated liquid and the pigment it moved (sheet space, bilinear)
  vec4 wet = vec4(0.0);
  float inSim = 0.0, mask = 0.0, Q = 0.0, wetK = 0.0, Qown = 0.0;
  vec3 inkQ = uInk;                               // the simulated pigment's colour
  vec2 su = vec2(P.x / uSheetPx.x, 1.0 - P.y / uSheetPx.y);
  if (uSimOn == 1) {
    wet = mix(bspline4(uSimA0, su, uSimTexel), bspline4(uSimA1, su, uSimTexel), uSimFrac) * uSimScale;
    // the wet extent is a smooth field; its 0.5 contour is where the liquid stopped, cut sharply
    // at any output size (the pigment's own bilinear tail would blur a hard watercolour edge).
    // Cubic B-spline sampling keeps that contour smooth where the grid is magnified (4K exports,
    // the film's macro rect): a bilinear field would print the cells' staircase into it. The
    // paper's tooth nudges the threshold, so the edge stops at fibres and tooth grains (ragged at
    // paper scale), not along grid cells.
    float ext = bsplineX(uSimB, su, uSimTexel);
    float fib = grainAt(P, 0.0).x - grainAt(P, 2.5).x;
    float sub = aa(uU * uCellU * 0.5);               // detail finer than a grid cell shows
    ext += clamp(fib * 2.5, -0.18, 0.18) * sub;
    float fw = max(fwidth(ext), 1e-4);
    mask = smoothstep(0.5 - fw, 0.5 + fw, ext);
    // ink laid after the displayed state is not in the simulation yet: its core shows in full
    float u = sf.a * uSimN;
    inSim = clamp(uSimX - ceil(u - 0.05), 0.0, 1.0);
    // Wet paint is optically denser than it will dry: water fills the air gaps between the
    // particles and fibres that scatter white light back once dry ("watercolour dries lighter",
    // 15-25% in value), and pigment still suspended reads deeper still. Then particles settle into
    // the valleys (granulation).
    wetK = smoothstep(0.01, 0.2, wet.x);
    // Surface pigment (suspended and settled) stops at the surface water's hard edge. What the
    // fibres drank (stains, bleeds: wetsim.js C) is not bounded by it: it fades out by itself, and
    // being dye in the capillaries between the fibres it is finely streaked with them (zero mean,
    // only where the grid is magnified). Particles settle into the pits of the tooth (granulation:
    // fine height minus its local, 4x coarser mean; zero on average, and it fades by itself where
    // the tooth is below a pixel); dye in the fibres does not granulate.
    float Qs = (wet.z + 1.15 * wet.y) * mask;
    if (uGranD > 0.0) {
      // (a fixed band of the sheet's relief, 0.6-3 paper units: the valleys particles settle in.
      // Where the pixel is coarser than 0.6 U, the fine end is the pixel itself, so a preview shows
      // the part of the band it can and exactly the mean of what a 4K render shows.)
      float pit = grainAt(P, max(0.0, log2(3.0 * uU))).x - grainAt(P, max(0.0, log2(0.6 * uU))).x;
      Qs *= max(0.0, 1.0 + uGranD * clamp(pit * 8.0, -1.0, 1.0));
    }
    // (B-spline, like the extent: the front below is a threshold, and a bilinear field would cut
    // the grid's cells into it as a dotted rim or a leopard mottle where the grid is magnified)
    float soakQ = mix(bsplineX(uSimC0, su, uSimTexel), bsplineX(uSimC1, su, uSimTexel), uSimFrac) * uSimScale;
    float fibN = clamp(fib * 3.0, -0.5, 0.5) * sub;
    // Where the colourant ran out, the bleed has a front: it stops where the damp stopped, a little
    // darker just inside (the fibres filter most where their water is thinnest: a tide line), and
    // it runs on along the paper's own fibre strands, so where the grid is magnified the front is
    // feathery, not a soft blur.
    float strand = smoothstep(0.02, 0.12, abs(strandAt(P) - 0.5)) * sub;
    float thS = 0.016 * (1.0 - 0.6 * strand) * (1.0 - 0.8 * fibN);
    soakQ *= max(0.0, 1.0 + 0.8 * fibN) * smoothstep(thS, 1.7 * thS, soakQ)
           * (1.0 + 0.3 * (1.0 - smoothstep(1.7 * thS, 4.5 * thS, soakQ)));
    // Pigment the liquid did not carry away keeps the tool's own fine shape. A grid cell is ~0.2
    // mm, so where it is magnified (4K, the film's close-ups) a line two cells wide would carry its
    // simulated share smeared a cell to either side: a pale blurred halo no real ink has. Inside
    // the cells a stroke covers, that pigment is redistributed by the stroke's fine coverage over
    // its coverage at grid scale (the inject pass keeps it in inj.z), which leaves each cell's total
    // as it was; pigment that flowed beyond the stroke (bleed, pools, blooms) and what the fibres
    // drank (soakQ) keep the simulation's own shape. At preview size (a cell ~ a pixel) the ratio
    // is ~1: nothing changes.
    if (uSimSharp > 0.0) {
      // (the coverage through the same B-spline as the pigment, so their ratio is smooth: a
      // different filter would print the grid's cells along every edge as a dotted grey rim)
      float cm = bspline4(uSimInj, su, uSimTexel).z;
      // the stroke's own share (what it laid here, at most what is here: up to its densest film);
      // the rest moved in, and keeps the simulation's shape
      // (Qa / cm is at most the densest film, so no cap is needed: a cap would lose a hairline's
      // pigment only where it is magnified, and a 4K export would come out lighter than the preview)
      // That share is laid back as a film of density Qa / cm over the stroke's own coverage (pig.a),
      // i.e. with the core, linear in coverage like the core: a preview pixel then holds exactly the
      // mean of the 4K pixels it covers (Beer-Lambert over a smeared field would not).
      float Qa = min(Qs, cm * uMobile * 1.3);
      float k = uSimSharp * smoothstep(0.01, 0.08, cm);
      Qs -= Qa * k;
      Qown = Qa * k / max(cm, 1e-4) * (1.0 + 0.3 * wetK);
    }
    Q = (Qs + soakQ) * (1.0 + 0.3 * wetK);
    inkQ = uInk;
    if (uPhotoColor == 1) {
      vec4 pl = textureLod(uPigment, uv, uPigLod);
      inkQ = pl.a > 1e-3 ? (uCover == 0 ? 1.0 - pl.rgb / pl.a : pl.rgb / pl.a) : vec3(0.5);
    }
  }
  float coreK = 1.0 - uMobile * inSim;           // share of the tool's own deposit shown crisp

  if (uTransparent == 1) {
    // Ink only, straight (un-premultiplied) alpha so PNG edges have no dark fringes: the same ink
    // as the paper render, simulated share included (bleeds, pools, the mobile share of the line).
    vec3 inkS = inkQ;
    float a;
    vec3 col;
    if (uCover == 0) {
      // The multiply path's transmittance (the core and the simulated pigment, Beer-Lambert),
      // written as the ink's own colour at the coverage that gives the same darkness over white
      // (luminance); where it is darker than the ink itself (pools, layered dye) the pixel is
      // opaque and carries that darker colour. Over white this is the paper render exactly; for
      // a dry medium it is simply colour = ink, alpha = coverage.
      vec3 inkPix = 1.0 - pig.rgb / max(pig.a, 1e-4);
      vec3 T = 1.0 - (1.0 - exp(coreK * log(max(inkPix, vec3(0.02))) + Qown * log(max(inkS, vec3(0.02))))) * pig.a;
      if (Q > 0.0) T *= exp(log(max(inkS, vec3(0.02))) * Q);
      if (wetK > 0.0) T = pow(max(T, vec3(1e-4)), vec3(1.0 + 0.18 * wetK));
      const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
      vec3 kRef = pig.a > 1e-3 ? inkPix : inkS;
      a = max(clamp((1.0 - dot(T, LW)) / max(1.0 - dot(kRef, LW), 0.05), 0.0, 1.0), glow.a);
      col = a > 1e-4 ? clamp((T - (1.0 - a)) / a, 0.0, 1.0) : vec3(0.0);
    } else {
      // cover media: the core over the sheet, the simulated pigment over that (as on paper)
      float aS = 1.0 - exp(-1.6 * Q);
      float kC = coreK + (1.0 - coreK) * (1.0 - exp(-1.6 * Qown));
      float aC = max(pig.a * kC, glow.a);
      a = 1.0 - (1.0 - aC) * (1.0 - aS);
      vec3 pre = (pig.rgb * kC + glow.rgb) * (1.0 - aS) + inkS * aS;
      col = a > 1e-4 ? clamp(pre / a, 0.0, 1.0) : vec3(0.0);
    }
    frag = vec4(col, clamp(a, 0.0, 1.0));
    return;
  }

  float shade;
  vec3 paper = paperSurface(P, shade);
  // wet paper is darker: water fills the air gaps between fibres, so less light scatters back
  if (uSimOn == 1) paper *= 1.0 - 0.1 * smoothstep(0.0, 0.5, wet.x + 0.5 * wet.w);
  vec3 col, emis = vec3(0.0);
  if (uCover == 0) {
    // Transmittance: the core keeps its linear coverage model; the share the simulation carries
    // leaves ink^(1 - mobile) behind, and the simulated pigment filters by Beer-Lambert, so a
    // fully covered, unmoved spot is ink^(1-m) * ink^m = ink, pools go darker than the ink.
    vec3 inkPix = 1.0 - pig.rgb / max(pig.a, 1e-4);
    // (plus the simulated share that stayed where the tool laid it, as a film over its coverage)
    vec3 coreAbs = (1.0 - exp(coreK * log(max(inkPix, vec3(0.02))) + Qown * log(max(inkQ, vec3(0.02))))) * pig.a;
    col = paper * (1.0 - coreAbs);
    // wax is a nearly opaque layer, not a stain: on a coloured sheet (kraft) it mostly hides the
    // paper and shows its own colour (identical to the stain on white paper)
    if (uMaterial == 3) col = mix(col, paper * (1.0 - pig.a) + inkPix * pig.a, 0.75);
    if (uSimOn == 1 && Q > 0.0) col *= exp(log(max(inkQ, vec3(0.02))) * Q);
    // Wet ink is deeper than it will dry (15-20%): the liquid fills the paper's and the pigment's
    // micro-texture, which once dry scatters white light back. (The sheet around it darkens too,
    // above.) It lightens to its dry value as the film goes.
    if (uSimOn == 1 && wetK > 0.0) col = paper * pow(max(col / max(paper, vec3(1e-3)), vec3(1e-4)), vec3(1.0 + 0.18 * wetK));
  } else if (uMaterial == 6) {
    // a light pen emits: its tube is not lit by the room (and flickers with setTime)
    col = paper * (1.0 - pig.a);
    emis = pig.rgb * flick;
  } else {
    // (a metal has no diffuse colour: all it shows is the room it mirrors, the specular below)
    // (a cover medium's simulated share that stayed put covers with the core: its own coverage)
    float kC = coreK + (1.0 - coreK) * (1.0 - exp(-1.6 * Qown));
    col = paper * (1.0 - pig.a * kC) + (uMaterial == 5 ? vec3(0.0) : pig.rgb * kC);
    if (uSimOn == 1 && Q > 0.0) col = mix(col, inkQ, 1.0 - exp(-1.6 * Q));
  }
  float inkA = clamp(max(pig.a, 1.0 - exp(-1.6 * Q)), 0.0, 1.0);
  // Relief lights the paper fully and the ink partly (ink sits in the tooth).
  float sh = mix(shade, 1.0 + (shade - 1.0) * uLightInk, inkA);
  // Pressure burnishes the tooth: under a ballpoint's ball or a hard lead the grain is flattened,
  // so the groove shows less of the paper's relief than the sheet around it (linear in the groove,
  // so previews and exports agree).
  sh = 1.0 + (sh - 1.0) * (1.0 - 0.75 * clamp(sf.r * 1.6, 0.0, 1.0));
  col *= sh; emis *= sh;

  // ---- the medium's own relief: grooves pressed into the sheet, material standing on it.
  // Diffuse is linear in the slope along the light (N.L / L.z = 1 + slope * cot(elevation)), so
  // a preview pixel shows the average of the 4K pixels it covers.
  vec2 dl = normalize(uPaperLight);
  vec2 dT = vec2(dl.x, -dl.y);                    // one px away from the light (texel rows run up)
  float slope = (reliefAt(ip, hiP, dT) - reliefAt(ip, hiP, -dT)) * 0.5 * uSurfU;   // height (px) per px
  // (+ = rising away from the light, i.e. facing it)
  col *= clamp(1.0 + slope * uCotEl, 0.55, 1.45);

  // ---- specular. Normal of the medium's surface (4 taps) and, while wet, of the liquid film.
  vec4 sx0 = texelFetch(uSurf, clamp(ip - ivec2(1, 0), ivec2(0), hiP), 0), sx1 = texelFetch(uSurf, clamp(ip + ivec2(1, 0), ivec2(0), hiP), 0);
  vec4 sy0 = texelFetch(uSurf, clamp(ip + ivec2(0, 1), ivec2(0), hiP), 0), sy1 = texelFetch(uSurf, clamp(ip - ivec2(0, 1), ivec2(0), hiP), 0);
  vec2 grad = vec2((sx1.g - sx1.r) - (sx0.g - sx0.r), (sy1.g - sy1.r) - (sy0.g - sy0.r)) * 0.5 * uSurfU;
  vec3 V = uEye.w > 0.5 ? normalize(uEye.xyz - vec3(P, 0.0)) : uViewDir;
  vec3 H = normalize(uLightDir + V);
  vec3 spec = vec3(0.0);
  float sheen = sf.b;
  if (sheen > 0.002 && uMaterial != 4 && uMaterial != 6) {
    vec3 N = normalize(vec3(-grad, 1.0));
    float nh = max(dot(N, H), 0.0);
    float lh = max(dot(uLightDir, H), 0.0);
    float fres = exp2(-9.28 * lh);                // Schlick's (1 - l.h)^5, cheaply
    if (uMaterial == 5) {
      // Metal (leaf, metallic ink) has no diffuse colour: it mirrors the room, tinted by its
      // reflectance F (the pigment holds F0, the ink colour; toward grazing it whitens). Most
      // normals mirror the dim room, a dark olive-brown for gold; where a normal bisects the light
      // and the eye it mirrors the window, which is ~13x brighter than white paper under it.
      // The leaf lies in broad, gentle undulations (~8 mm, sd 1 deg of tilt per axis) over a
      // fine roughness no output resolves (with the window's own size: sd 13 deg in half-vector
      // angle), and an eighth of it is loose flakes (Voronoi cells ~0.9 U, each tilted its own way,
      // sd 13 deg, smooth and slightly domed, so a glint is a spot that slides as the light
      // moves). Where undulations or flakes are finer than ~2 px their tilts are folded into
      // wider lobes of the same energy, so a preview pixel is the average of the 4K pixels it
      // covers. Broad areas: the stills' light (40 deg) shows ~1/6 of the mirror peak (about the
      // ink colour), a raking light next to nothing (only the dim room is left, ~1/3 of it); the
      // film's rising light (3x) and tilting camera sweep them up to the peak.
      vec3 alb = pig.rgb / max(pig.a, 1e-3);
      vec2 pw = P / uU / 40.0 + uSeed * 1.7;
      vec2 wave = (vec2(vnoise(pw), vnoise(pw + vec2(19.3, 7.1))) - 0.5) * 0.1;
      float kW = aa(40.0 * uU);
      vec2 pu = P / uU / 0.9;
      vec2 ci = floor(pu), cell = ci, dc = vec2(0.0);
      float dBest = 1e9;
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        vec2 c = ci + vec2(float(x), float(y));
        vec2 o = vec2(hash21(c + 3.7), hash21(c + 11.9));
        vec2 d = pu - c - o;
        float dd = dot(d, d);
        if (dd < dBest) { dBest = dd; cell = c; dc = d; }
      }
      vec3 fh = vec3(hash21(cell + uSeed * 7.0), hash21(cell + 91.3 + uSeed), hash21(cell + 47.9 + uSeed));
      vec2 tilt = (fh.xy - 0.5) * 0.78 + 0.12 * dc;
      float k = aa(0.9 * uU);
      float flake = mix(0.12, step(fh.z, 0.12), k);
      vec3 Ns = normalize(vec3(-grad - kW * wave, 1.0));
      vec3 Nf = normalize(vec3(-grad - kW * wave - k * tilt, 1.0));
      // lobe variances (rad^2): the leaf's roughness + undulations this size cannot show; a
      // flake's own lobe + the flake tilts this size cannot show
      float sW = 0.0005 * (1.0 - kW * kW);
      float s2 = 0.0515 + sW, s2f = 0.0128 + sW + 0.052 * (1.0 - k * k);
      float ch = acos(clamp(dot(Ns, H), -1.0, 1.0)), chf = acos(clamp(dot(Nf, H), -1.0, 1.0));
      // (a resolved flake mirrors the window itself, a disc ~9 deg across in half-vector angle
      // with the same energy as the lobes: it is either blazing or shows the room)
      float kf = mix((0.0985 / s2f) * exp(-0.5 * chf * chf / s2f), 7.7 * (1.0 - smoothstep(0.12, 0.2, chf)), k * k);
      // (a flake is only partly lifted off the leaf: half of it still follows the leaf's surface)
      float key = 2.4 * mix((0.0985 / s2) * exp(-0.5 * ch * ch / s2), kf, 0.55 * flake);
      // the room: dimmer than the sheet (walls and ceiling lit by the window, ~0.3 of white paper),
      // brighter toward the window's side, with its own furniture (a slow pattern in the
      // reflected direction, so facets tilted differently mirror different things)
      vec3 R = reflect(-V, Nf);
      float room = 0.28 + 0.1 * dot(R, uLightDir) + 0.12 * (vnoise(R.xy * 2.5 + uSeed * 3.1) - 0.5);
      float lhF = max(dot(uLightDir, normalize(uLightDir + V)), 0.0);
      vec3 F = alb + (1.0 - alb) * exp2(-9.28 * lhF);
      vec3 m = F * (max(room, 0.05) + key) * pig.a;
      // Bright metal goes through a soft shoulder like a photo of it: mostly keeping its hue (the
      // brightest channel is compressed and the others follow it), partly burning out toward a
      // pale yellow-white (each channel on its own).
      float mx = max(m.r, max(m.g, m.b));
      float fm = mx < 0.8 ? mx : 0.8 + 0.2 * (1.0 - exp((0.8 - mx) / 0.2));
      vec3 mc = mix(m, 0.8 + 0.2 * (1.0 - exp((0.8 - min(m, vec3(8.0))) / 0.2)), step(0.8, m));
      spec = mix(m * fm / max(mx, 1e-4), mc, 0.35);
    } else if (uMaterial == 2) {
      // graphite: packed lamellar flakes, a rough grey metal. The window light is an area light
      // some 40 degrees across, so it reflects as a broad sheen plus a narrower glare toward the
      // mirror angle, both growing toward grazing light (Fresnel): dense graphite reads silvery
      // grey, never black, and flashes when the light rakes across it toward the camera.
      float F = 0.16 + 0.84 * fres;
      spec = vec3(0.9, 0.93, 1.0) * F * (0.4 * lobe(nh, 4.0) + 0.5 * lobe(nh, 20.0)) * sheen;
    } else if (uMaterial == 3) {
      // wax: a smooth but not flat build-up, a soft broad gloss with a gentle core (the lamp
      // glances off the waxed tops: brighter than its F0 alone, the tops face it by the thousand)
      float F = 0.04 + 0.96 * fres;
      spec = vec3(F * (0.9 * lobe(nh, 5.0) + 0.8 * lobe(nh, 24.0)) * sheen);
    } else if (uMaterial == 7) {
      // ballpoint paste: an oily film of nearly saturated dye. A dye reflects strongly in the band
      // it absorbs (bronzing), shifted toward longer wavelengths: blue-black paste flashes red-gold
      // near the mirror angle, red paste green-gold, black a warm bronze. Sheen carries the line's
      // coverage already, so only the ink's darkness sets how strongly it bronzes.
      vec3 inkC = uPhotoColor == 1 ? 1.0 - pig.rgb / max(pig.a, 1e-3) : uInk;
      float dens = 1.0 - smoothstep(0.2, 0.55, dot(inkC, vec3(0.2126, 0.7152, 0.0722)));
      vec3 band = 1.0 - inkC;
      band /= max(max(band.r, max(band.g, band.b)), 1e-3);
      vec3 bronze = mix(vec3(1.0), mix(band * band * band, vec3(1.0, 0.55, 0.3), 0.3), dens);
      float F = 0.06 + 0.94 * fres;
      spec = bronze * F * (0.35 * lobe(nh, 10.0) + 0.65 * lobe(nh, 45.0)) * sheen * (1.0 + 1.5 * dens);
    } else {
      // dielectric films (dried ink): a faint colourless reflection, stronger toward grazing light
      float F = 0.04 + 0.96 * fres;
      spec = vec3(F * lobe(nh, 30.0) * sheen * 0.6);
    }
  }
  if (uSimOn == 1 && wet.x > 1e-3) {
    // The liquid film: a mirror-smooth surface shaped like the simulated water, a convex bead over
    // each wet line (a meniscus pinned at the line's edges, its sides at 20-30 degrees) and a
    // level puddle where it pooled. Its gradient comes from the cubic B-spline of the water depth
    // (C2: the normal turns smoothly across the bead, never with the grid's cells), steepened to
    // the bead's real contact angle (the grid smooths a 0.2-1 mm bead into a gentler hump). So
    // the window's reflection is a thin bright streak along each bead's crown or flank, sliding
    // across it as the light or the camera moves, not a veil over the whole line.
    vec2 gA = bsplineGradX(uSimA0, su, uSimTexel), gB = bsplineGradX(uSimA1, su, uSimTexel);
    vec2 gT = mix(gA, gB, uSimFrac) * uSimScale;             // per cell, texel axes (rows run up)
    vec2 gw = vec2(gT.x, -gT.y) / uCellU * uWetH * ${SURF_UNIT_U.toFixed(2)} * 4.0;
    // A thin film follows the paper's tooth, so it glistens in sparkles on the tooth tops; only a
    // deep pool levels out into a mirror. (Tooth slope per paper unit, taken over +-0.6 U; below
    // a pixel per grain its mean tilt is zero and the lobe simply widens, as a rough film's does.)
    float thick = smoothstep(0.08, 0.6, wet.x);
    vec2 dx = vec2(0.6 * uU, 0.0), dy = vec2(0.0, 0.6 * uU);
    vec2 tg = vec2(grainAt(P + dx, 0.0).x - grainAt(P - dx, 0.0).x, grainAt(P + dy, 0.0).x - grainAt(P - dy, 0.0).x) / 1.2;
    vec3 Nw = normalize(vec3(-gw - tg * 0.5 * (1.0 - thick) * aa(uU), 1.0));
    float nh = max(dot(Nw, H), 0.0);
    float lh = max(dot(uLightDir, H), 0.0);
    float F = 0.02 + 0.98 * exp2(-9.28 * lh);
    // (a film thinner than the tooth is rough and half soaked in: it barely mirrors anything)
    float film = smoothstep(0.03, 0.3, wet.x);
    // The key light is a window some 40 degrees across: the bead mirrors it as a sharp streak (its
    // brightest part) with a faint halo; the halo is kept small, or the whole line would go grey.
    spec += vec3(F * (lobe(nh, 120.0) * 0.8 + lobe(nh, 14.0) * 0.25) * film);
  }
  // Dye sheen ("bronzing"): where a dark dye ink pooled and dried thick on a sheet that kept it on
  // the surface, the dye film reflects the band it absorbs, shifted to longer wavelengths (blue-
  // black flashes a coppery bronze). Only in the simulated pools (far more dye than a stroke lays),
  // only once they have dried and the sheet has settled, and only as a narrow mirror lobe: it
  // flashes as the light or the camera sweeps past the mirror angle and is invisible otherwise, so
  // the ink never takes on a tint. Colour and strength (sizing cubed: sized sheets only) come from
  // wetsim.js dyeSheen.
  if (uDyeSheen.a > 0.0 && uCover == 0 && uSimOn == 1) {
    float pool = smoothstep(0.7, 1.5, Q) * inSim;
    float dried = (1.0 - smoothstep(0.0, 0.02, wet.x)) * (1.0 - smoothstep(0.0, 0.1, wet.w));
    float settled = smoothstep(0.5, 0.8, (uSimX - 1.0 - uSimN) / ${STEPS_SETTLE.toFixed(1)});
    vec3 Ns = normalize(vec3(-grad, 1.0));
    spec += uDyeSheen.rgb * uDyeSheen.a * lobe(max(dot(Ns, H), 0.0), 90.0) * pool * dried * settled;
  }
  // reflected light scales with the lamp; what the medium emits (neon tube, glow) does not
  if (uMaterial == 6) {
    // Neon: the tube's radiance (the pigment holds it / 2.4, dryNeon) and its bloom add up as
    // light, and the sum is exposed like a photograph of it: through a filmic shoulder per
    // channel, so a tube's axis and a dense cluster of tubes with the haze between them burn out
    // toward a pale, white-hot tint of the gas while a faint haze keeps its saturated colour. The
    // room light on the sheet lies beneath (screened). (A linear toe up to 0.55, then the
    // shoulder: the dim glow and a lone thin tube keep the gas's full hue.)
    vec3 hdr = 3.6 * (pig.rgb * flick + glow.rgb);
    vec3 T = mix(hdr, 0.55 + 0.45 * (1.0 - exp((0.55 - min(hdr, vec3(20.0))) / 0.45)), step(0.55, hdr));
    col = 1.0 - (1.0 - clamp((col + spec) * uLightCol, 0.0, 1.0)) * (1.0 - T);
  } else {
    col = (col + spec) * uLightCol + emis + glow.rgb * (1.0 - 0.6 * pig.a);
  }
  col += (hash21(P + 0.5) - 0.5) / 255.0;      // dither against banding
  frag = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Glow: separable Gaussian (5 taps with linear-sampling offsets) at quarter resolution. Taps are
// bilinear by hand from exact texel fetches (like reliefAt): hardware filtering rounds its weights
// from normalised coordinates, which differ between a strip and the full sheet.
export const FRAG_BLUR = /* glsl */`#version 300 es
precision highp float;
precision highp int;
out vec4 frag;
uniform sampler2D uSrc;
uniform vec2 uDirT;      // tap step in source texels
uniform int uDown;       // 1 = 4x4 box downsample of a full-res source (4 bilinear taps)
// Bilinear sample at texel i's centre + off texels. The offset's fraction is taken apart from the
// integer base: adding a fraction to a large coordinate first would round it differently in a
// short strip than in the full sheet.
vec4 tap(ivec2 i, vec2 off) {
  ivec2 hi = textureSize(uSrc, 0) - 1;
  vec2 f = floor(off), w = off - f;
  ivec2 b = i + ivec2(f);
  vec4 t00 = texelFetch(uSrc, clamp(b, ivec2(0), hi), 0), t10 = texelFetch(uSrc, clamp(b + ivec2(1, 0), ivec2(0), hi), 0);
  vec4 t01 = texelFetch(uSrc, clamp(b + ivec2(0, 1), ivec2(0), hi), 0), t11 = texelFetch(uSrc, clamp(b + ivec2(1, 1), ivec2(0), hi), 0);
  return mix(mix(t00, t10, w.x), mix(t01, t11, w.x), w.y);
}
void main() {
  ivec2 i = ivec2(gl_FragCoord.xy);
  if (uDown == 1) {
    // the 4x4 source block of this texel, as four bilinear taps between texel pairs
    ivec2 s = i * 4;
    const vec2 h = vec2(0.5);
    frag = 0.25 * (tap(s, h) + tap(s + ivec2(2, 0), h) + tap(s + ivec2(0, 2), h) + tap(s + ivec2(2, 2), h));
    return;
  }
  const float w0 = 0.2270270270, w1 = 0.3162162162, w2 = 0.0702702703;
  const float o1 = 1.3846153846, o2 = 3.2307692308;
  vec4 acc = tap(i, vec2(0.0)) * w0;
  acc += tap(i, uDirT * o1) * w1;
  acc += tap(i, -uDirT * o1) * w1;
  acc += tap(i, uDirT * o2) * w2;
  acc += tap(i, -uDirT * o2) * w2;
  frag = acc;
}`;
