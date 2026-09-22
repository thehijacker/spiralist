// GLSL ES 3.00 programs, assembled from the shared chunks, the brush library (brushes.js) and
// the paper library (papers.js).
//
// Coordinates:
//   P (px)  — position on the FULL paper in output pixels. A render target may be a strip of the
//             paper (large exports); uOrigin is the strip's top-left corner on the paper.
//   U       — paper unit = 1/1000 of the paper width (uU = px per U).
// Paper grain lives in a tileable 1024^2 texture covering 1/TILES_ACROSS of the paper width,
// sampled with explicit LOD. Its G channel stores h^2 so the mip chain also carries variance —
// brushes that threshold against grain widen the threshold by the variance the current
// resolution cannot show, so coverage stays statistically the same at every size.

import { BRUSH_GLSL } from './brushes.js';
import { PAPER_TILE_GLSL, PAPER_SURFACE_GLSL } from './papers.js';

export const TILES_ACROSS = 6.0;
export const TILE_SIZE = 1024;

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

// ---------------------------------------------------------------------------------------------
// Stroke pass: one instance per segment of the polyline, rendered as a round-capped capsule
// via its distance field. MAX blending merges overlapping capsules without double-darkening.
export const VERT_STROKE = /* glsl */`#version 300 es
precision highp float;
layout(location = 0) in vec4 aA;   // x, y, w, s   (point i)
layout(location = 1) in vec2 aAt;  // tone, turn
layout(location = 2) in vec4 aB;   // point i+1
layout(location = 3) in vec2 aBt;
layout(location = 4) in vec4 aCol; // photo colour of point i (normalised bytes)
uniform vec2 uRes;       // render target size px
uniform vec2 uOrigin;    // target's top-left on the paper, px
uniform vec2 uCenter;    // circle centre on the paper, px
uniform float uRadius;   // circle radius, px
uniform float uMinW;     // thinnest drawn width in px (thinner strokes fade instead)
uniform float uSpread;   // quad size multiplier for halos (charcoal, chalk dust)
flat out vec2 vP0;
flat out vec2 vP1;
flat out vec2 vW;
flat out vec2 vS;
flat out vec2 vTone;
flat out vec4 vCol;
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
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 pos = mix(p0 - t * hw, p1 + t * hw, corner.x) + n * mix(-hw, hw, corner.y);
  vPos = pos;
  vP0 = p0; vP1 = p1;
  vW = vec2(w0, w1);
  vS = vec2(aA.w, aB.w) * uRadius;
  vTone = vec2(aAt.x, aBt.x);
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
in vec2 vPos;
out vec4 frag;
uniform int uBrush;
uniform vec3 uInk;         // sRGB 0..1 ink colour
uniform int uCover;        // 0 = multiply (dark media), 1 = cover (light / opaque media)
uniform int uPhotoColor;
uniform float uMinW;
uniform float uSeed;
${COMMON}
${GRAIN}
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
  vec2 ba = vP1 - vP0;
  vec2 pa = vPos - vP0;
  float bb = dot(ba, ba);
  float h = bb > 1e-8 ? clamp(dot(pa, ba) / bb, 0.0, 1.0) : 0.0;
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
  vec3 ink = uPhotoColor == 1 ? photoInk(vCol.rgb) : uInk;
  float a = clamp(brushDeposit(uBrush, st, ink) * thin, 0.0, 1.0);
  // Pigment buffer: absorbance for dark media, premultiplied colour for cover media.
  vec3 rgb = uCover == 0 ? (1.0 - ink) * a : ink * a;
  frag = vec4(rgb, a);
}`;

// ---------------------------------------------------------------------------------------------
// Composite: paper surface (tooth relief, fibres, mottling) + pigment + optional glow.
export const FRAG_COMPOSITE = /* glsl */`#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uPigment;
uniform sampler2D uGlow;
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
${COMMON}
${GRAIN}
${PAPER_SURFACE_GLSL}
void main() {
  vec2 P = uOrigin + vec2(vUv.x, 1.0 - vUv.y) * uRes;
  vec4 pig = texture(uPigment, vUv);
  vec4 glow = uGlowOn == 1 ? texture(uGlow, vUv) * uGlowAmt : vec4(0.0);

  if (uTransparent == 1) {
    // Ink only, straight (un-premultiplied) alpha so PNG edges have no dark fringes.
    float a = clamp(max(pig.a, glow.a), 0.0, 1.0);
    vec3 pre = uCover == 0 ? (vec3(pig.a) - pig.rgb) : pig.rgb;   // premultiplied ink colour
    pre += glow.rgb;
    vec3 col = a > 1e-4 ? clamp(pre / a, 0.0, 1.0) : vec3(0.0);
    frag = vec4(col, a);
    return;
  }

  float shade;
  vec3 paper = paperSurface(P, shade);
  vec3 col = uCover == 0 ? paper * (1.0 - pig.rgb) : paper * (1.0 - pig.a) + pig.rgb;
  // Relief lights the paper fully and the ink partly (ink sits in the tooth).
  col *= mix(shade, 1.0 + (shade - 1.0) * uLightInk, pig.a);
  col += glow.rgb * (1.0 - 0.6 * pig.a);
  col += (hash21(P + 0.5) - 0.5) / 255.0;      // dither against banding
  frag = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Glow: separable Gaussian (5 taps with linear-sampling offsets) at quarter resolution.
export const FRAG_BLUR = /* glsl */`#version 300 es
precision highp float;
in vec2 vUv;
out vec4 frag;
uniform sampler2D uSrc;
uniform vec2 uDir;       // uv step per tap
uniform int uDown;       // 1 = 4x4 box downsample of a full-res source (4 bilinear taps)
uniform vec2 uSrcTexel;  // 1 / source size
void main() {
  if (uDown == 1) {
    vec2 t = uSrcTexel;
    frag = 0.25 * (texture(uSrc, vUv + vec2(-t.x, -t.y)) + texture(uSrc, vUv + vec2(t.x, -t.y)) +
                   texture(uSrc, vUv + vec2(-t.x, t.y)) + texture(uSrc, vUv + vec2(t.x, t.y)));
    return;
  }
  const float w0 = 0.2270270270, w1 = 0.3162162162, w2 = 0.0702702703;
  const float o1 = 1.3846153846, o2 = 3.2307692308;
  vec4 c = texture(uSrc, vUv) * w0;
  c += texture(uSrc, vUv + uDir * o1) * w1;
  c += texture(uSrc, vUv - uDir * o1) * w1;
  c += texture(uSrc, vUv + uDir * o2) * w2;
  c += texture(uSrc, vUv - uDir * o2) * w2;
  frag = c;
}`;
