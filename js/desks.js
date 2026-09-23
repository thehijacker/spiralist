// Premium desk surfaces for the cinematic timelapse: data + GLSL materials.
//
// deskMaterial(id, p) returns the surface under the sheet at desk position p (in sheet widths,
// the sheet spans roughly -0.5..0.5). Everything is procedural:
//   marble veins are contour lines of a domain-warped noise field (continuous, flowing, with
//   varying width and a soft halo, like real stone), travertine has elongated honed pores in
//   warm bands, limewash has cloudy brushed plaster, velvet has pressed pile catching the light,
//   leather has pebble grain and a stitched pad, sunlit concrete gets palm-frond shadows, and
//   honey onyx has thin translucent agate-like layers.

export const DESKS = [
  { id: 'nero', name: 'Nero marble', note: 'Black marble, white veins', shader: 0, dark: true },
  { id: 'calacatta', name: 'Calacatta', note: 'White marble, grey-gold veins', shader: 1, dark: false },
  { id: 'travertine', name: 'Travertine', note: 'Warm honed stone', shader: 2, dark: false },
  { id: 'limewash', name: 'Limewash', note: 'Soft plaster, gallery wall', shader: 3, dark: false },
  { id: 'velvet', name: 'Emerald velvet', note: 'Deep pressed velvet', shader: 4, dark: true },
  { id: 'leather', name: 'Leather blotter', note: 'Black pebbled leather', shader: 5, dark: true },
  { id: 'sunlit', name: 'Sunlit concrete', note: 'Palm shadows, warm sun', shader: 6, dark: false },
  { id: 'onyx', name: 'Honey onyx', note: 'Glowing banded stone', shader: 7, dark: false },
];

export const deskById = id => DESKS.find(d => d.id === id) || DESKS[0];

export const DESK_GLSL = /* glsl */`
vec2 dkHash(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453);
}
float dkNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dot(dkHash(i), f), dot(dkHash(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
             mix(dot(dkHash(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), dot(dkHash(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x), u.y);
}
float dkFbm(vec2 p, int oct) {
  float s = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 7; i++) { if (i >= oct) break; s += a * dkNoise(p); p = m * p; a *= 0.5; }
  return s;
}
float dkCell(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 r = o + 0.5 + 0.45 * dkHash(i + o) - f;
    d = min(d, dot(r, r));
  }
  return sqrt(d);
}
// Domain-warped field for stone: its contour lines are the veins.
float dkStone(vec2 p, float seed, float warp) {
  vec2 q = vec2(dkFbm(p + seed, 4), dkFbm(p + vec2(5.2, 1.3) + seed, 4));
  vec2 r = vec2(dkFbm(p + warp * q + vec2(1.7, 9.2), 4), dkFbm(p + warp * q + vec2(8.3, 2.8), 4));
  return dkFbm(p + warp * 0.8 * r, 5);
}
// A vein where the field crosses level; width varies along it.
float dkVein(float f, float level, float w, vec2 p) {
  float wv = w * (0.45 + 1.1 * smoothstep(-0.4, 0.5, dkFbm(p * 3.0 + level * 13.0, 3)));
  float d = abs(f - level);
  return 1.0 - smoothstep(0.0, wv, d);
}

struct Desk { vec3 albedo; float gloss; float sheen; float height; float emit; };

Desk deskMaterial(int id, vec2 p) {
  Desk d;
  d.gloss = 0.0; d.sheen = 0.0; d.height = 0.0; d.emit = 0.0;
  if (id == 0) {                 // Nero Marquina
    vec2 s = mat2(0.82, -0.57, 0.57, 0.82) * p;
    s *= vec2(0.35, 0.9);                                  // veins run long along one direction
    float f = dkStone(s, 2.0, 1.4) + s.y * 0.35;
    float cloud = dkFbm(p * 1.2 + 4.0, 4);
    vec3 base = vec3(0.02, 0.02, 0.023) * (1.0 + 0.5 * cloud);
    float v = max(dkVein(f, 0.1, 0.0045, s), dkVein(f, -0.22, 0.003, s) * 0.75);
    float halo = max(dkVein(f, 0.1, 0.035, s), dkVein(f, -0.22, 0.025, s)) * 0.07;
    d.albedo = base + vec3(0.82, 0.81, 0.78) * clamp(v + halo, 0.0, 1.0);
    d.gloss = 0.95;
  } else if (id == 1) {          // Calacatta: white marble, bold soft grey-gold veins
    vec2 s = mat2(0.8, -0.6, 0.6, 0.8) * p;
    s *= vec2(0.3, 0.75);
    float f = dkStone(s, 11.0, 1.2) + s.y * 0.3;
    vec3 base = vec3(0.94, 0.935, 0.915) + 0.02 * dkFbm(p * 2.0, 4);
    float bold = dkVein(f, 0.05, 0.035, s);
    float thin = max(dkVein(f, -0.2, 0.008, s), dkVein(f, 0.25, 0.006, s));
    float haze = dkVein(f, 0.05, 0.16, s) * 0.18 + dkVein(f, -0.2, 0.1, s) * 0.08;
    vec3 grey = vec3(0.5, 0.49, 0.47), gold = vec3(0.66, 0.55, 0.38);
    vec3 vc = mix(grey, gold, smoothstep(-0.2, 0.35, dkFbm(s * 1.5 + 3.0, 3)));
    d.albedo = mix(base, vc, clamp(bold * 0.75 + thin * 0.55 + haze, 0.0, 1.0));
    d.gloss = 0.8;
  } else if (id == 2) {          // Travertine: honed, banded, long shallow pores
    float warp = dkFbm(p * 1.5, 4) * 0.25;
    float band = dkFbm(vec2(p.x * 0.9, (p.y + warp) * 7.0), 5);
    vec3 light = vec3(0.9, 0.84, 0.74), dark = vec3(0.78, 0.69, 0.56);
    vec3 base = mix(dark, light, smoothstep(-0.35, 0.35, band));
    base *= 1.0 + 0.04 * dkFbm(p * 14.0, 3);
    // pores: stretched cells, varied size, only in some bands
    vec2 pc = vec2(p.x * 7.0, (p.y + warp) * 30.0);
    float cell = dkCell(pc + 3.0);
    float size = 0.07 + 0.16 * smoothstep(0.1, 0.6, dkNoise(pc * 0.21 + 5.0));
    float pore = (1.0 - smoothstep(size * 0.55, size, cell)) * smoothstep(-0.1, 0.25, dkFbm(vec2(p.x * 2.0, p.y * 9.0) + 9.0, 3));
    d.albedo = mix(base, vec3(0.6, 0.51, 0.39), pore * 0.75);
    d.height = -pore;
    d.gloss = 0.22;
  } else if (id == 3) {          // Limewash plaster: cloudy, brushed arcs, chalky
    float cloud = dkFbm(p * 0.8 + dkFbm(p * 0.4, 3) * 0.7, 6);
    vec2 r = p + vec2(dkFbm(p * 0.6 + 2.0, 3), dkFbm(p * 0.6 + 7.0, 3)) * 0.6;
    float brush = dkFbm(vec2(length(r - vec2(-1.2, 1.4)) * 7.0, atan(r.y - 1.4, r.x + 1.2) * 1.2), 4);
    vec3 base = vec3(0.76, 0.72, 0.67);
    d.albedo = base * (1.0 + 0.3 * cloud + 0.08 * brush) + 0.012 * dkNoise(p * 110.0);
    d.height = brush * 0.25;
  } else if (id == 4) {          // Emerald velvet: pressed pile patches catch the light
    vec2 r = mat2(0.9, -0.44, 0.44, 0.9) * p;
    float streak = dkFbm(vec2(r.x * 0.7, r.y * 5.0) + dkFbm(p * 0.8, 3) * 0.8, 5);
    float press = smoothstep(-0.3, 0.45, streak);
    float fibre = dkNoise(p * 420.0) * 0.5 + 0.5;
    vec3 base = vec3(0.012, 0.13, 0.085);
    d.albedo = base * (0.8 + 0.35 * press) * (0.92 + 0.16 * fibre);
    d.sheen = press * 0.55 * (0.8 + 0.2 * fibre);
    d.height = press * 0.08;
  } else if (id == 5) {          // Black pebbled leather blotter with stitched border
    float peb = dkCell(p * 38.0);
    float fine = dkNoise(p * 220.0);
    d.albedo = vec3(0.045, 0.04, 0.038) * (1.0 + 0.25 * fine) + 0.02 * (1.0 - peb);
    d.height = (1.0 - peb) * 0.8;
    d.gloss = 0.4;
    vec2 q = abs(p) - vec2(0.95, 0.72);
    float box = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.06;
    float seam = 1.0 - smoothstep(0.0025, 0.0055, abs(box + 0.025));
    float dash = step(0.45, fract((p.x + p.y) * 45.0));
    d.albedo = mix(d.albedo, vec3(0.42, 0.34, 0.26), seam * dash);
    d.albedo *= box > 0.0 ? 0.7 : 1.0;
  } else if (id == 6) {          // Sunlit concrete (palm shadows come from the lighting)
    float cloud = dkFbm(p * 1.3, 5);
    float agg = smoothstep(0.4, 0.55, dkNoise(p * 48.0)) * 0.05;
    float pits = (1.0 - smoothstep(0.02, 0.045, dkCell(p * 22.0 + 3.0))) * step(0.2, dkNoise(p * 5.0) + 0.3);
    d.albedo = vec3(0.7, 0.68, 0.645) * (1.0 + 0.07 * cloud) - agg - pits * 0.1;
    d.height = -pits;
    d.gloss = 0.08;
  } else {                       // Honey onyx: thin translucent layers, like agate
    vec2 s = mat2(0.96, 0.28, -0.28, 0.96) * p;
    float f = s.y * 1.6 + dkStone(s * 0.45, 21.0, 1.0) * 0.8;
    float layers = sin(f * 11.0) * 0.5 + 0.5;
    float fine = sin(f * 38.0 + dkFbm(s * 6.0, 3) * 1.5) * 0.5 + 0.5;
    float broad = smoothstep(-0.7, 0.7, sin(f * 3.0));
    vec3 amber = vec3(0.62, 0.34, 0.12), honey = vec3(0.88, 0.62, 0.3), cream = vec3(0.97, 0.9, 0.74);
    vec3 c = mix(amber, honey, broad);
    c = mix(c, cream, layers * 0.55 * broad);
    c *= 0.9 + 0.12 * fine;
    d.albedo = c;
    d.emit = 0.22 * broad * (0.6 + 0.4 * layers);
    d.gloss = 0.9;
  }
  return d;
}

// Relief only (cheap): lets the lighting shade pores, plaster, pile and grain without
// re-evaluating the whole material for every normal sample.
float deskHeight(int id, vec2 p) {
  if (id == 2) {
    float warp = dkFbm(p * 1.5, 4) * 0.25;
    vec2 pc = vec2(p.x * 7.0, (p.y + warp) * 30.0);
    float size = 0.07 + 0.16 * smoothstep(0.1, 0.6, dkNoise(pc * 0.21 + 5.0));
    return -(1.0 - smoothstep(size * 0.55, size, dkCell(pc + 3.0)));
  }
  if (id == 3) {
    vec2 r = p + vec2(dkFbm(p * 0.6 + 2.0, 3), dkFbm(p * 0.6 + 7.0, 3)) * 0.6;
    return dkFbm(vec2(length(r - vec2(-1.2, 1.4)) * 7.0, atan(r.y - 1.4, r.x + 1.2) * 1.2), 4) * 0.25;
  }
  if (id == 4) return smoothstep(-0.05, 0.25, dkFbm(p * 2.6, 4)) * 0.15;
  if (id == 5) return (1.0 - dkCell(p * 38.0)) * 0.8;
  if (id == 6) return -(1.0 - smoothstep(0.02, 0.045, dkCell(p * 22.0 + 3.0)));
  return 0.0;
}

// Sunlight through a palm frond: 1 = lit, soft penumbra; plus the shadow of a window mullion.
float dkLeafShadow(vec2 p) {
  float shade = 0.0;
  for (int k = 0; k < 2; k++) {
    float fk = float(k);
    // the frond's rib: a gentle curve across the desk
    vec2 o = k == 0 ? vec2(-1.25, -0.95) : vec2(1.35, 0.9);
    vec2 dir = normalize(k == 0 ? vec2(1.0, 0.62) : vec2(-1.0, -0.35));
    vec2 nrm = vec2(-dir.y, dir.x);
    vec2 q = p - o;
    float along = dot(q, dir);
    float bend = 0.18 * along * along;
    float across = dot(q, nrm) - bend;
    float len = k == 0 ? 1.9 : 1.2;
    if (along > 0.0 && along < len) {
      // leaflets: narrow blades angled back along the rib, on both sides
      float n = 26.0;
      float cell = fract(along * n / len);
      float side = sign(across);
      float taper = 1.0 - along / len;
      float blade = abs(across) * 1.0 - (cell - 0.15) * 0.55;
      float reach = (0.35 + 0.25 * taper) * (0.8 + 0.2 * dkNoise(vec2(floor(along * n / len), fk * 7.0 + side)));
      float leaf = (1.0 - smoothstep(reach * 0.8, reach * 1.15, abs(across))) * (1.0 - smoothstep(0.02, 0.2, abs(blade)));
      shade = max(shade, leaf);
      shade = max(shade, 1.0 - smoothstep(0.01, 0.05, abs(across)));   // the rib itself
    }
  }
  // soft penumbra: sunlight from a distant source blurs the shadow edge
  float mull = 1.0 - smoothstep(0.04, 0.16, abs(p.x * 0.9 + p.y * 0.44 - 0.95));
  return 1.0 - clamp(shade * 0.6 + mull * 0.45, 0.0, 0.7);
}
`;

// ---------------------------------------------------------------------------------- baking
// The film bakes the chosen desk once into two textures, so the camera shader only samples them:
//   albedo  RGBA8, sRGB-encoded albedo with the relief already shaded by the window light; alpha
//           holds the gloss (how mirror-like the surface is)
//   aux     RGBA8: r = sunlight mask (1 lit, leaf and mullion shadows darker; sunlit desk only),
//           g = velvet sheen, b = glow (onyx)

// ---------------------------------------------------------------------------------- baking
// The film bakes the chosen desk once into two textures, so the camera shader only samples them:
//   albedo  RGBA8, sRGB-encoded albedo with the relief already shaded by the window light; alpha
//           holds the gloss (how mirror-like the surface is)
//   aux     RGBA8: r = sunlight mask (1 lit, leaf and mullion shadows darker; sunlit desk only),
//           g = velvet sheen, b = glow (onyx). A single texel (1, 0, 0) for the desks that have
//           none of these.
// Both tile with period `period` (world units, texture (0,0) at the world origin). Inside
// |x|, |y| < inner the material is exact; beyond, it cross-fades with the next repeat so the
// seam is invisible (the camera never looks that far out).
const BAKE_VERT = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

// Desks whose aux channels vary (velvet sheen, sunlight, onyx glow); the others skip that pass.
const AUX_SHADERS = new Set([4, 6, 7]);

// One program per desk and pass: the id and pass are compile-time constants, so the driver
// compiles only the one material (a shader holding all eight takes seconds to compile on D3D).
// The relief normal and the edge cross-fade are loops over one call rather than four inlined
// copies of the material, which keeps the compiled shader (and its compile time) small.
const bakeFrag = (id, aux) => `#version 300 es
precision highp float;
layout(location = 0) out vec4 o;
const int uId = ${id};
const int uAux = ${aux ? 1 : 0};
uniform vec2 uSize;
uniform float uPeriod, uInner;
${DESK_GLSL}
vec3 toSrgb(vec3 c) { return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)); }
vec4 albedoAt(vec2 p, float e) {
  // e: half the finite-difference step for the relief normal (world units)
  Desk d = deskMaterial(uId, p);
  // relief lit by the window at the upper left (the same side the scene's key light comes from)
  vec2 g = vec2(0.0);
  for (int k = 0; k < 4; k++) {
    float sg = (k & 1) == 0 ? 1.0 : -1.0;
    vec2 off = k < 2 ? vec2(sg * e, 0.0) : vec2(0.0, sg * e);
    float h = sg * deskHeight(uId, p + off);
    if (k < 2) g.x += h; else g.y += h;
  }
  vec3 n = normalize(vec3(-g.x * 0.9, -g.y * 0.9, 1.0));
  vec3 L = normalize(vec3(-0.55, -0.65, 0.55));
  float lambert = clamp(dot(n, L) / L.z, 0.0, 1.6);
  return vec4(d.albedo * mix(1.0, lambert, 0.8), d.gloss);
}
vec4 auxAt(vec2 p) {
  Desk d = deskMaterial(uId, p);
  float sun = uId == 6 ? dkLeafShadow(p) : 1.0;
  return vec4(sun, d.sheen, d.emit, 1.0);
}
void main() {
  vec2 c = gl_FragCoord.xy / uSize;                  // texture coordinate 0..1
  vec2 w = uPeriod * (c - step(0.5, c));             // world point in [-T/2, T/2)
  vec2 b = 0.5 * smoothstep(vec2(uInner), vec2(0.5 * uPeriod), abs(w));
  vec2 sh = -sign(w) * uPeriod;                      // the same place in the neighbouring repeat
  const float e = 0.0035;       // relief slope over a fixed 7 mm-ish step, as in the approved previews
  vec4 acc = vec4(0.0);
  for (int k = 0; k < 4; k++) {
    int i = k & 1, j = k >> 1;
    float wt = (i == 0 ? 1.0 - b.x : b.x) * (j == 0 ? 1.0 - b.y : b.y);
    if (wt <= 0.0) continue;
    vec2 p = w + vec2(i == 0 ? 0.0 : sh.x, j == 0 ? 0.0 : sh.y);
    acc += wt * (uAux == 1 ? auxAt(p) : albedoAt(p, e));
  }
  o = uAux == 1 ? acc : vec4(toSrgb(acc.rgb), acc.a);
}`;

// Compiled bake programs per context and desk. Compiling is most of a bake's cost, so programs
// are kept for the context's lifetime and compiled in the background where the browser can
// (KHR_parallel_shader_compile): the page keeps running while the driver works.
const PROGRAMS = new WeakMap();

function deskPrograms(gl, shader) {
  let m = PROGRAMS.get(gl);
  if (!m) {
    PROGRAMS.set(gl, m = new Map());
    // a lost context takes its programs with it (not gl.isProgram per call: that query waits
    // for a link still running, freezing the page for the compile)
    gl.canvas?.addEventListener?.('webglcontextlost', () => { if (PROGRAMS.get(gl) === m) PROGRAMS.delete(gl); }, { once: true });
  }
  let p = m.get(shader);
  if (p && !gl.isContextLost()) return p;
  const ext = gl.getExtension('KHR_parallel_shader_compile');
  const shaders = [];
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); shaders.push(s); return s; };
  const vs = sh(gl.VERTEX_SHADER, BAKE_VERT);
  const link = aux => {
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, bakeFrag(shader, aux)));
    gl.linkProgram(prog);
    return prog;
  };
  p = { albedo: link(false), aux: AUX_SHADERS.has(shader) ? link(true) : null, ext, shaders, checked: false };
  m.set(shader, p);
  return p;
}

/** Start compiling desk `id`'s bake programs without waiting (a later bake then starts at once). */
export function warmDesk(gl, id) {
  if (!gl.isContextLost()) deskPrograms(gl, deskById(id).shader);
}

/** Are desk `id`'s bake programs compiled (or compiling with nothing to wait for)? */
export function deskCompiled(gl, id) {
  const p = PROGRAMS.get(gl)?.get(deskById(id).shader);
  return !!p && programsReady(gl, p);
}

function programsReady(gl, p) {
  if (p.checked || !p.ext) return true;
  const done = q => !q || gl.getProgramParameter(q, p.ext.COMPLETION_STATUS_KHR);
  return done(p.albedo) && done(p.aux);
}

// Blocks until linked (if still compiling), and reports a failure once.
function checkPrograms(gl, p) {
  if (p.checked) return;
  for (const q of [p.albedo, p.aux]) {
    if (q && !gl.getProgramParameter(q, gl.LINK_STATUS) && !gl.isContextLost()) {
      const log = p.shaders.map(s => gl.getShaderInfoLog(s)).filter(Boolean).join('\n') || gl.getProgramInfoLog(q);
      throw new Error('Desk shader failed: ' + log);
    }
  }
  for (const s of p.shaders) gl.deleteShader(s);
  p.shaders = [];
  p.checked = true;
}

/**
 * A desk bake that can run all at once or a few tiles at a time (so a live preview keeps its
 * frame rate while a large desk bakes). step(maxTiles) draws up to maxTiles tiles and returns
 * true once the textures are complete; `result` is then { albedo, aux, period, size, desk }.
 * `compiled` says whether step() would start drawing without waiting for the driver. Every step
 * leaves blending and scissor off and the default framebuffer bound, so it can be interleaved
 * with other rendering in the same context.
 */
export class DeskBake {
  constructor(gl, id, { size = 4096, auxSize = 1024, period = 3.2, inner = 1.35, tile = 512 } = {}) {
    this.gl = gl;
    this.desk = deskById(id);
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.size = Math.min(size, max);
    this.auxSize = Math.min(auxSize, max);
    this.period = period; this.inner = inner; this.tile = tile;
    this.progs = deskPrograms(gl, this.desk.shader);
    this.jobs = null;
    this.done = false;
    this.albedo = this.aux = this.fbo = this.vao = null;
    this.stats = { compileMs: 0, tiles: 0 };
  }

  get compiled() { return this.done || programsReady(this.gl, this.progs); }

  get progress() { return this.done ? 1 : this.jobs ? 1 - this.jobs.length / this.total : 0; }

  get result() {
    return this.done ? { albedo: this.albedo, aux: this.aux, period: this.period, size: this.size, desk: this.desk } : null;
  }

  _start() {
    const gl = this.gl, p = this.progs;
    const t0 = performance.now();
    checkPrograms(gl, p);
    this.stats.compileMs = performance.now() - t0;
    const make = (n, levels) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, n, n);
      return t;
    };
    this.albedo = make(this.size, Math.floor(Math.log2(this.size)) + 1);
    if (p.aux) this.aux = make(this.auxSize, Math.floor(Math.log2(this.auxSize)) + 1);
    else {
      // lit everywhere, no sheen, no glow
      this.aux = make(1, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 0, 0, 255]));
    }
    this.fbo = gl.createFramebuffer();
    this.vao = gl.createVertexArray();
    this.jobs = [];
    const T = this.tile;
    const add = (tex, n, prog) => {
      for (let y = 0; y < n; y += T) for (let x = 0; x < n; x += T) this.jobs.push({ tex, n, prog, x, y, w: Math.min(T, n - x), h: Math.min(T, n - y) });
    };
    add(this.albedo, this.size, p.albedo);
    if (p.aux) add(this.aux, this.auxSize, p.aux);
    this.total = this.jobs.length;
  }

  step(maxTiles = Infinity) {
    if (this.done) return true;
    const gl = this.gl;
    if (gl.isContextLost()) return false;
    if (!this.jobs) this._start();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.bindVertexArray(this.vao);
    let tex = null, prog = null;
    for (let k = 0; k < maxTiles && this.jobs.length; k++) {
      const j = this.jobs.shift();
      if (j.tex !== tex) {
        tex = j.tex;
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        gl.viewport(0, 0, j.n, j.n);
      }
      if (j.prog !== prog) {
        prog = j.prog;
        gl.useProgram(prog);
        gl.uniform1f(gl.getUniformLocation(prog, 'uPeriod'), this.period);
        gl.uniform1f(gl.getUniformLocation(prog, 'uInner'), this.inner);
        gl.uniform2f(gl.getUniformLocation(prog, 'uSize'), j.n, j.n);
      }
      gl.scissor(j.x, j.y, j.w, j.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.flush();
      this.stats.tiles++;
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (this.jobs.length) return false;
    gl.deleteFramebuffer(this.fbo); this.fbo = null;
    gl.deleteVertexArray(this.vao); this.vao = null;
    for (const t of [this.albedo, this.aux]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      const mips = t === this.albedo || this.progs.aux;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      if (mips) gl.generateMipmap(gl.TEXTURE_2D);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.done = true;
    return true;
  }

  /** Free the textures (the compiled programs stay with the context). */
  dispose() {
    const gl = this.gl;
    if (!gl.isContextLost()) {
      for (const t of [this.albedo, this.aux]) if (t) gl.deleteTexture(t);
      if (this.fbo) gl.deleteFramebuffer(this.fbo);
      if (this.vao) gl.deleteVertexArray(this.vao);
    }
    this.albedo = this.aux = this.fbo = this.vao = null;
    this.jobs = [];
    this.done = false;
  }
}

/**
 * Bake desk `id` for the film camera, all at once. Returns { albedo, aux, period, size, desk }
 * (textures owned by the caller). Rendered in tiles so a slow GPU never stalls long enough to trip
 * a driver watchdog. `stats` (optional) receives { compileMs, tiles }.
 */
export function bakeDesk(gl, id, { stats = null, ...opts } = {}) {
  const b = new DeskBake(gl, id, { tile: 1024, ...opts });
  b.step();
  if (stats) Object.assign(stats, b.stats);
  return b.result;
}
