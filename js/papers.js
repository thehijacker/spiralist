// Papers: data + GLSL for the tileable grain texture and the lit paper surface.
//
// The virtual sheet is 200 mm wide; 1 paper unit (U) = 1/1000 of the width = 0.2 mm.
// The grain tile (1024^2) covers 1/6 of the sheet width (~33 mm), so 1 texel ~ 0.033 mm.
// Tile channels:
//   R = height 0..1 (mean ~0.5, std ~0.11-0.19): brushes threshold against it, the surface lights it
//   G = R^2, so the mip chain carries the variance the current resolution cannot show
//   B = specks 0..1 (dark or light marks mixed toward `speck`)
//   A = fibre albedo, 0.5 = neutral (lighter / darker strands); linear, so mips keep the mean
//
// Look: real sheets under soft window light from the upper left. Relief is lit linearly in the
// texture's slope, and every other term is linear in a texture channel or lives at sheet scale,
// so a preview and a box-downsampled 4K export have the same mean tone.

export const SHEET_MM = 200;

// Tile knobs (tile program): tooth = height std relative to 0.13, toothCells = tooth grains per
// tile (~0.3 mm each at 110), bumps/bumpCells = cold-press domes, fibers = strand amount (from
// 0.4 up also long strands and bundles), specks = speck density (from 0.5 up also sparse ~0.5 mm
// bark specks). Surface knobs (composite): relief = light on the tooth, mottle = cloudy
// formation, smudge = chalkboard eraser haze + swirls, grid = blueprint grid.
export const PAPERS = [
  { id: 'sketch', name: 'Sketchbook', color: '#f4f4f0', speck: '#8c887e', tooth: 0.9, toothCells: 120,
    bumps: 0.4, bumpCells: 44, fibers: 0.35, specks: 0.12, relief: 0.35, mottle: 0.035, smudge: 0, grid: 0 },
  { id: 'cream', name: 'Cream', color: '#f1e6cd', speck: '#9a8260', tooth: 0.93, toothCells: 104,
    bumps: 0.55, bumpCells: 36, fibers: 0.5, specks: 0.3, relief: 0.42, mottle: 0.05, smudge: 0, grid: 0 },
  { id: 'coldpress', name: 'Watercolour', color: '#f2ebdf', speck: '#958e80', tooth: 0.5, toothCells: 110,
    bumps: 1.4, bumpCells: 22, fibers: 0.25, specks: 0.08, relief: 0.75, mottle: 0.045, smudge: 0, grid: 0 },
  { id: 'kraft', name: 'Kraft', color: '#bf9366', speck: '#4f3622', tooth: 1.04, toothCells: 120,
    bumps: 0.3, bumpCells: 30, fibers: 1.0, specks: 1.0, relief: 0.3, mottle: 0.09, smudge: 0, grid: 0 },
  { id: 'black', name: 'Black card', color: '#1c1c1f', speck: '#45454b', tooth: 0.89, toothCells: 150,
    bumps: 0, bumpCells: 1, fibers: 0.2, specks: 0.15, relief: 0.25, mottle: 0.03, smudge: 0, grid: 0, dark: true },
  { id: 'chalkboard', name: 'Chalkboard', color: '#2d3c34', speck: '#6f7d74', tooth: 0.97, toothCells: 112,
    bumps: 0, bumpCells: 1, fibers: 0, specks: 0.35, relief: 0.3, mottle: 0.09, smudge: 1.0, grid: 0, dark: true },
  { id: 'blueprint', name: 'Blueprint', color: '#1b5796', speck: '#5b8ac2', tooth: 0.78, toothCells: 128,
    bumps: 0.25, bumpCells: 40, fibers: 0.3, specks: 0.15, relief: 0.3, mottle: 0.06, smudge: 0, grid: 1, dark: true },
];

export const paperById = id => PAPERS.find(p => p.id === id) || PAPERS[0];

// Tile generator. Uniforms: uSeed, uTooth, uToothCells, uBumps, uBumpCells, uFibers, uSpecks
// (uLaid is no longer used: straight laid lines cannot survive the renderer's rotated second
// sampling of the tile). Everything tiles: integer lattice periods on both axes, and lattice
// indices are wrapped with wrapL() instead of mod().
export const PAPER_TILE_GLSL = /* glsl */`
// Integer lattice wrap. mod(x, y) compiles to x - y * floor(x * rcp(y)) on some drivers (D3D), so
// mod(110.0, 110.0) can return 110.0 instead of 0.0 and leave a seam along every tile edge.
vec2 wrapL(vec2 i, vec2 period) { return i - period * floor((i + 0.5) / period); }
// Four 8-bit random numbers per lattice cell and salt.
vec4 hp4(vec2 i, vec2 period, float salt) {
  uvec2 c = uvec2(ivec2(wrapL(i, period)) + 1024);
  uint h = hashU(c + uvec2(uint(salt) * 7919u + uint(uSeed) * 104729u, uint(salt) * 3571u));
  return vec4(uvec4(h, h >> 8u, h >> 16u, h >> 24u) & 255u) / 255.0;
}
// Periodic gradient noise, roughly -0.7..0.7 (std ~0.2).
float gnoiseP(vec2 p, vec2 period, float salt) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a0 = 6.2831853 * hp4(i, period, salt).x;
  float a1 = 6.2831853 * hp4(i + vec2(1.0, 0.0), period, salt).x;
  float a2 = 6.2831853 * hp4(i + vec2(0.0, 1.0), period, salt).x;
  float a3 = 6.2831853 * hp4(i + vec2(1.0, 1.0), period, salt).x;
  float n0 = dot(vec2(cos(a0), sin(a0)), f);
  float n1 = dot(vec2(cos(a1), sin(a1)), f - vec2(1.0, 0.0));
  float n2 = dot(vec2(cos(a2), sin(a2)), f - vec2(0.0, 1.0));
  float n3 = dot(vec2(cos(a3), sin(a3)), f - vec2(1.0, 1.0));
  return mix(mix(n0, n1, u.x), mix(n2, n3, u.x), u.y);
}
// fBm of periodic gradient noise, ~unit std. Each octave is offset by a fraction of a cell so the
// lattices never line up (aligned lattices print a faint grid into the relief lighting).
float fbmP(vec2 uv, float cells, float salt) {
  float s = 0.0, a = 1.0, n = 0.0, per = cells;
  for (int k = 0; k < 4; k++) {
    vec2 off = vec2(0.37, 0.71) * float(k + 1);
    s += a * gnoiseP(uv * per + off, vec2(per), salt + float(k));
    n += a * a; a *= 0.62; per *= 2.0;
  }
  return s / sqrt(n) * 4.6;
}
// Cold-press domes: the soft upper envelope (smooth max) of paraboloid caps on a jittered periodic
// lattice, so the sheet is packed with rounded bumps parted by narrow soft valleys. The 4x4 cells
// nearest p: every cap left out is >= 1.5 cells away, where it adds < 1% to the envelope sum
// (< 0.002 in height where the window shifts). ~unit std around 0 (negatively skewed: mostly dome
// tops, a few valleys).
float domesP(vec2 uv, float cells) {
  vec2 p = uv * cells;
  vec2 i0 = floor(p) - 2.0 + step(0.5, fract(p));
  float acc = 0.0;
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
    vec2 c = i0 + vec2(float(x), float(y));
    vec4 r = hp4(c, vec2(cells), 41.0);
    vec4 r2 = hp4(c, vec2(cells), 42.0);
    vec2 d = p - c - r.xy;
    float ang = r.z * 3.14159265;
    vec2 t = vec2(cos(ang), sin(ang));
    vec2 q = vec2(dot(d, t), dot(d, vec2(-t.y, t.x)) * mix(1.0, 1.6, r2.x));   // some are elongated
    float R = mix(0.75, 1.05, r2.y);
    float cap = mix(0.7, 1.0, r.w) * (1.0 - dot(q, q) / (R * R));
    acc += exp(3.5 * cap);
  }
  float v = (log(acc) / 3.5 - 0.661) * 3.75;
  return -2.0 + log(1.0 + exp(4.0 * (v + 2.0))) * 0.25;  // soft floor: valley junctions stay shallow
}
// Tooth grains: the same soft envelope of caps at tooth scale (3x3 taps; caps two cells away lie
// far below the envelope). Pebbly rather than wormy, like paper tooth under a loupe. ~unit std.
float pebblesP(vec2 uv, float cells) {
  vec2 p = uv * cells;
  vec2 i = floor(p);
  float acc = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = i + vec2(float(x), float(y));
    vec4 r = hp4(c, vec2(cells), 51.0);
    vec2 d = p - c - r.xy;
    float R = mix(0.6, 0.85, r.z);
    acc += exp(6.0 * mix(0.6, 1.0, r.w) * (1.0 - dot(d, d) / (R * R)));
  }
  return (log(acc) / 6.0 - 0.5) * 4.0;
}
// Scattered curved strands. cells = strand cells per tile; each cell holds up to two strands of
// half-length len (cells), width w (cells), curl (bend). Returns (coverage, signed tone: + lighter,
// - darker); light = share of lighter strands.
vec2 fibreLayer(vec2 uv, float cells, float density, float len, float w, float curl, float light, float salt) {
  vec2 p = uv * cells;
  vec2 i = floor(p);
  float cov = 0.0, tone = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = i + vec2(float(x), float(y));
    for (int k = 0; k < 2; k++) {
      vec4 r = hp4(c, vec2(cells), salt + float(k) * 2.0);
      if (r.x >= density) continue;
      vec4 r2 = hp4(c, vec2(cells), salt + float(k) * 2.0 + 1.0);
      vec2 d = p - c - r.yz;
      float ang = r.w * 3.14159265;
      vec2 t = vec2(cos(ang), sin(ang));
      float L = len * mix(0.45, 1.0, r2.x);
      float ax = dot(d, t);
      float ay = dot(d, vec2(-t.y, t.x)) - (r2.y - 0.5) * curl * ax * ax / L;
      float v = exp(-ay * ay / (w * w)) * (1.0 - smoothstep(L * 0.55, L, abs(ax)));
      v *= mix(0.5, 1.0, r2.z);
      if (v > cov) { cov = v; tone = r2.w < light ? 1.0 : -1.0; }
    }
  }
  return vec2(cov, tone);
}
// Specks: sparse elongated dots, radius small..big cells (mostly small). lobes > 0 roughens the
// outline (bark and shive fragments are never round; only worth it where specks span pixels).
float specksP(vec2 uv, float cells, float density, float small, float big, float lobes, float salt) {
  vec2 p = uv * cells;
  vec2 i = floor(p);
  float v = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = i + vec2(float(x), float(y));
    vec4 r = hp4(c, vec2(cells), salt);
    if (r.x >= density) continue;
    vec4 r2 = hp4(c, vec2(cells), salt + 1.0);
    vec2 d = p - c - r.yz;
    float ang = r2.x * 3.14159265;
    vec2 t = vec2(cos(ang), sin(ang));
    vec2 q = vec2(dot(d, t), dot(d, vec2(-t.y, t.x)) * mix(1.0, 2.4, r2.y));
    float rad = mix(small, big, r.w * r.w * r.w);
    float len = length(q);
    if (lobes > 0.0 && len < 1.5 * rad) {                 // (a lobe scales len by >= 0.75)
      float a = atan(q.y, q.x) + 6.2831853 * r2.w;
      len *= 1.0 + lobes * (0.16 * cos(3.0 * a) + 0.09 * cos(5.0 * a + 2.0));
    }
    v = max(v, (1.0 - smoothstep(rad * 0.45, rad, len)) * mix(0.4, 1.0, r2.z));
  }
  return v;
}
vec4 paperTile(vec2 uv) {
  float cells = uToothCells;
  // Tooth: pebbly grains (~0.2-0.3 mm) roughened by a warped fBm.
  float wc = max(2.0, floor(cells * 0.25));
  vec2 warp = vec2(gnoiseP(uv * wc + vec2(0.5, 0.2), vec2(wc), 21.0),
                   gnoiseP(uv * wc + vec2(0.1, 0.6), vec2(wc), 22.0));
  vec2 uw = uv + warp * (0.7 / cells);
  float h = 0.13 * uTooth * (0.8 * pebblesP(uw, cells) + 0.6 * fbmP(uw, cells, 1.0));
  if (uBumps > 0.0) {
    float bc = uBumpCells;
    vec2 bw = vec2(gnoiseP(uv * bc + 0.3, vec2(bc), 23.0), gnoiseP(uv * bc + 0.8, vec2(bc), 24.0));
    // domes plus broader, weaker swells (~2x the dome size) so the bumps are not all alike
    float bc2 = max(2.0, floor(bc * 0.5));
    h += 0.13 * uBumps * (domesP(uv + bw * (0.5 / bc), bc) + 0.5 * domesP(uv + bw * (0.5 / bc2), bc2));
  }
  float albedo = 0.0;
  if (uFibers > 0.0) {
    // fine strands everywhere; long straighter strands and fibre bundles in coarse sheets (kraft)
    float coarse = smoothstep(0.4, 1.0, uFibers);
    vec2 f1 = fibreLayer(uv, 36.0, min(1.0, 0.25 + 0.6 * uFibers), 0.85, 0.045, 0.6, 0.6, 71.0);
    vec2 f2 = vec2(0.0), f3 = vec2(0.0);
    if (coarse > 0.0) {                                   // (skipped outright where there are none)
      f2 = fibreLayer(uv, 14.0, 0.9 * coarse, 0.9, 0.03, 0.35, 0.5, 81.0);
      f3 = fibreLayer(uv, 8.0, 0.6 * coarse, 0.8, 0.028, 0.25, 0.35, 91.0);
    }
    h += 0.05 * max(f1.x, max(f2.x, f3.x));               // strands sit slightly proud
    // the long strands and bundles of coarse sheets carry more colour, so kraft's fibres still read
    // at preview size, where their width is well under a pixel
    albedo = clamp((f1.x * f1.y * 0.4 + f2.x * f2.y * mix(0.35, 0.48, coarse)
                    + f3.x * f3.y * mix(0.2, 0.42, coarse)) * uFibers, -1.0, 1.0);
  }
  float speck = uSpecks > 0.0 ? specksP(uv, 48.0, 0.07 * uSpecks, 0.035, 0.16 + 0.14 * uSpecks, 0.0, 61.0) : 0.0;
  // Speck-heavy sheets (kraft) also carry sparse bark and shive specks of ~0.3-0.8 mm, big enough to
  // read on a ~1000 px preview, where the fine specks above are sub-pixel.
  float bark = smoothstep(0.5, 1.0, uSpecks);
  if (bark > 0.0) speck = max(speck, specksP(uv, 24.0, 0.026 * bark, 0.14, 0.4, 1.0, 65.0));
  h = clamp(0.49 + h, 0.0, 1.0);                          // median ~0.505 (the tooth skews low)
  return vec4(h, h * h, speck, 0.5 + 0.5 * albedo);
}
`;

// Paper surface colour at full-paper pixel P (without ink). Also returns the relief `shade`
// (1.0 on flat paper) which the composite applies to paper and, partly, to ink.
// Uniforms: uPaperColor, uSpeckColor, uRelief, uMottle, uSmudge, uGrid (uSpeckAmt is unused: the
// tile's B channel already carries each paper's speck density and strength).
export const PAPER_SURFACE_GLSL = /* glsl */`
// The two decorrelated samplings of grainAt() (shaders.js; keep in sync), all four channels.
void paperTaps(vec2 P, float lod, out vec4 a, out vec4 b) {
  a = textureLod(uPaperTex, P / uTilePx, lod);
  b = textureLod(uPaperTex, mat2(0.7986, -0.6018, 0.6018, 0.7986) * (P / (uTilePx * 1.137)) + vec2(0.37, 0.71), lod);
}
// ... blended with grainAt's mask m (computed once, shared by the taps of the relief gradient).
vec4 paperTap(vec2 P, float lod, float m) {
  vec4 a, b;
  paperTaps(P, lod, a, b);
  return mix(a, b, m);
}
// Value noise for the sheet-scale clouds, which run 7-10 times per pixel on every frame. COMMON's
// vnoise() spends ~6 integer multiplies per corner on its hash (slower than float math on many
// mobile GPUs); this all-float hash is plenty for smooth mottling at these lattice sizes.
float hashF(vec2 p) {
  vec3 p3 = fract(p.xyx * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoiseF(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hashF(i), hashF(i + vec2(1.0, 0.0)), u.x),
             mix(hashF(i + vec2(0.0, 1.0)), hashF(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Octave-rotated value noise around 0 (rotation hides the lattice), octave k weighted w[k]. The
// clouds are what makes this shader ALU-bound, so each one keeps only the octaves that show:
// weight x noise std (~0.16) x amount has to reach a fraction of a level.
float cloudW(vec2 p, vec4 w) {
  const mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
  float s = 0.0;
  for (int k = 0; k < 4; k++) {
    if (w[k] == 0.0) break;
    s += w[k] * (vnoiseF(p) - 0.5);
    p = rot * p * 2.07 + 13.7;
  }
  return s;
}
// Box-filtered coverage of a line of width w at distance d, for a pixel footprint fw (all px):
// the integral stays constant wherever the line falls on the pixel grid, so no moire.
float lineCov(float d, float w, float fw) {
  return max(0.0, min(d + 0.5 * w, 0.5 * fw) - max(d - 0.5 * w, -0.5 * fw)) / fw;
}
// Chalkboard: cloudy eraser haze plus a few eraser swirls. A swirl is the eraser circling while
// it drifts (four offset loops), leaving a hazy band with fine streaks along the motion.
float chalkHaze(vec2 pu) {
  // (this offset of the broad haze cloud leaves the middle of a square sheet, under the drawing,
  // clear; the finer cloudiness between the patches is the formation mottle, uMottle)
  float haze = smoothstep(-0.08, 0.35, cloudW(pu * 2.3 + 3.0, vec4(0.533, 0.267, 0.133, 0.0))) * 0.55;
  float streakAA = aa(0.0035 * uPaperPx);            // streak pitch ~0.7 mm, faded below ~2 px
  // Swirls: centre (xy, hand-placed so a square sheet shows four around the drawing; the rest
  // serve tall sheets), loop radius (z), eraser pressure (w), and drift direction DIR. Radius,
  // pressure and direction are hash draws, baked here so no pixel pays for hashing them.
  const vec4 SW[7] = vec4[7](vec4(0.13, 0.19, 0.06178, 0.6029), vec4(0.86, 0.33, 0.06134, 0.706),
                             vec4(0.21, 0.83, 0.07647, 0.4596), vec4(0.71, 0.9, 0.07111, 0.5305),
                             vec4(0.5, 1.12, 0.06471, 0.7705), vec4(0.18, 1.45, 0.07348, 0.5331),
                             vec4(0.8, 1.62, 0.07977, 0.5865));
  const vec2 DIR[7] = vec2[7](vec2(-0.56502, -0.82508), vec2(-0.74948, 0.66203), vec2(0.72178, 0.69213),
                              vec2(0.50187, 0.86494), vec2(0.35449, 0.93506), vec2(-0.99618, 0.08735),
                              vec2(-0.72618, -0.68751));
  const mat2 TURN = mat2(0.6967067, 0.7173561, -0.7173561, 0.6967067);   // +0.8 rad per loop
  for (int i = 0; i < 7; i++) {
    vec2 c = SW[i].xy;
    float r0 = SW[i].z;
    if (length(pu - c) > 3.1 * r0) continue;          // beyond the reach of every loop band
    vec2 dir = DIR[i], heavy = dir;
    float sw = 0.0;
    for (int k = 0; k < 4; k++) {
      vec2 d = pu - (c + dir * (float(k) - 1.5) * r0 * 0.55);
      float rr = length(d);
      float rb = (rr - r0 * (0.9 + 0.08 * float(k))) / (r0 * 0.42);
      vec2 hk = heavy;
      heavy = TURN * heavy;
      if (abs(rb) > 2.6) continue;                    // exp(-rb^2) < 0.0012: nothing to add
      vec2 u = d / max(rr, 1e-6);                     // direction around the loop (no atan needed)
      float lead = 0.55 + 0.45 * dot(u, hk);          // heavier on one side of a loop
      // streaks follow the loop; the noise is sampled on a circle so there is no seam around it
      vec2 sp = vec2(rr * 290.0 + float(i) * 7.0 + 1.5 * u.x, 1.5 * u.y + float(k) * 3.0);
      float streak = mix(1.0, 0.7 + 0.6 * vnoiseF(sp), streakAA);
      sw = max(sw, exp(-rb * rb) * lead * streak);
    }
    haze += sw * SW[i].w;
  }
  return haze;
}
vec3 paperSurface(vec2 P, out float shade) {
  vec2 pu = P / uPaperPx;                              // sheet units (1 = sheet width)
  float lod = max(0.0, uTileLod);
  // grainAt's blend of its two samplings: the relief must match the grain the brushes read.
  float mv = vnoise(pu * 7.0 + 3.1);
  float m = smoothstep(0.25, 0.75, mv);
  vec4 ta, tb;
  paperTaps(P, lod, ta, tb);
  // Specks and strands switch between samplings almost hard instead: a 50/50 blend (69% of the
  // sheet) would show twice as many of them at half strength, and a speck field looks the same on
  // either side of a switch. They are also what an eye would catch repeating at the tile period, so
  // a third sampling (another angle, scale and offset) takes over ~36% of the sheet in patches
  // smaller than a tile, and no patch keeps one sampling across a whole period.
  vec2 uv3 = mat2(0.3256, 0.9455, -0.9455, 0.3256) * (P / (uTilePx * 1.071)) + vec2(0.61, 0.17);
  vec2 marks = mix(ta.ba, tb.ba, smoothstep(0.47, 0.53, mv));
  marks = mix(marks, textureLod(uPaperTex, uv3, lod).ba, smoothstep(0.55, 0.59, vnoiseF(pu * 13.0 + 5.7)));
  vec4 t = vec4(mix(ta.rg, tb.rg, m), marks);
  // Relief: slope of the (mip-filtered) height per full-resolution texel, along the light only
  // (the key light needs nothing else, so a central difference along it costs two taps, not four).
  // Lighting is linear in the slope, so a pixel's shade equals the average of the finer pixels
  // it covers.
  const vec2 L = vec2(0.55, 0.65);                     // key light, from the upper left
  float e = max(1.0, exp2(-uTileLod));
  vec2 dl = normalize(L) * e;
  float slope = (paperTap(P + dl, lod, m).r - paperTap(P - dl, lod, m).r) / (2.0 * e * exp2(uTileLod));
  // Soft occlusion from the fine structure only (height minus its 4x coarser mean): pits read
  // darker, while broad domes are modelled by the key light instead of turning into blotches.
  float cavity = t.r - paperTap(P, lod + 2.0, m).r;
  float lit = slope * length(L) * 2.4 + cavity * 0.25;   // key light + soft occlusion
  // Window light: a very gentle falloff away from the upper left.
  float fall = dot(pu - 0.5, vec2(-0.6, -0.8)) * 0.016;
  shade = 1.0 + clamp(lit * uRelief, -0.3, 0.3) + fall;

  // Formation: cloudy flocs from ~20 mm down to ~2.5 mm (the octave weights give the ~20 mm and
  // ~5 mm floc sizes), with a faint warm/cool drift at ~50 mm.
  float form = cloudW(pu * 9.0 + 5.0, vec4(0.533, 0.267, 0.347, 0.173));
  float drift = cloudW(pu * 4.0 + 11.0, vec4(0.533, 0.267, 0.0, 0.0));
  vec3 paper = uPaperColor * (1.0 + form * uMottle + vec3(0.25, 0.0, -0.25) * drift * uMottle);
  paper *= 1.0 + (t.a - 0.5) * 0.5;                   // strands: lighter or darker fibres
  paper = mix(paper, uSpeckColor, t.b * 0.9);
  if (uSmudge > 0.0) {
    float hz = chalkHaze(pu) * uSmudge;
    paper = mix(paper, vec3(dot(paper, vec3(0.33))) * 1.9 + vec3(0.05, 0.06, 0.055), clamp(hz * 0.22, 0.0, 0.45));
  }
  if (uGrid > 0.0) {
    // 5 mm minor / 25 mm major grid in faint white (sheet = 200 mm = 1000 U)
    float fw = 1.25;                                  // pixel footprint incl. a little lens blur
    float gl = 0.0;
    for (int i = 0; i < 2; i++) {
      float pitch = (i == 0 ? 25.0 : 125.0) * uU;
      float w = (i == 0 ? 0.55 : 1.0) * uU;
      vec2 dd = abs(fract(P / pitch + 0.5) - 0.5) * pitch;
      float c = max(lineCov(dd.x, w, fw), lineCov(dd.y, w, fw));
      gl = max(gl, c * (i == 0 ? 0.13 : 0.2));
    }
    paper = mix(paper, vec3(0.86, 0.93, 1.0), gl * uGrid);
  }
  // Satin sheen from the window on dark sheets (additive: specular does not scale with albedo).
  float dark = 1.0 - smoothstep(0.1, 0.5, dot(uPaperColor, vec3(0.2126, 0.7152, 0.0722)));
  vec2 sh = pu - vec2(0.15, 0.05);
  paper += dark * 0.02 * exp(-dot(sh, sh) * 1.8);
  // Soft knee so lit dome tops and light fibres never clip to pure white (paper * shade < 0.99).
  vec3 lit3 = paper * shade;
  vec3 k = 0.963 + 0.026 * (1.0 - exp(-max(lit3 - 0.963, 0.0) / 0.026));
  return mix(paper, k / shade, step(0.963, lit3));
}
`;
