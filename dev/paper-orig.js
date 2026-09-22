// Papers: data + GLSL for the tileable grain texture and the lit paper surface.
//
// The virtual sheet is 200 mm wide; 1 paper unit (U) = 1/1000 of the width = 0.2 mm.
// The grain tile (1024^2) covers 1/6 of the sheet width (~33 mm), so 1 texel ~ 0.033 mm.
// Tile channels: R = height 0..1, G = height^2 (so mips carry variance), B = specks/fibres, A = 1.

export const SHEET_MM = 200;

export const PAPERS = [
  { id: 'sketch', name: 'Sketchbook', color: '#f7f5ef', speck: '#8a8577', tooth: 0.55, toothCells: 128,
    bumps: 0, bumpCells: 1, fibers: 0.12, specks: 0.35, laid: 0, relief: 0.35, mottle: 0.018, smudge: 0, grid: 0 },
  { id: 'cream', name: 'Cream', color: '#f3ead6', speck: '#a08a64', tooth: 0.6, toothCells: 112,
    bumps: 0, bumpCells: 1, fibers: 0.25, specks: 0.5, laid: 0.35, relief: 0.4, mottle: 0.03, smudge: 0, grid: 0 },
  { id: 'coldpress', name: 'Watercolour', color: '#f6f3eb', speck: '#9a9486', tooth: 0.45, toothCells: 140,
    bumps: 1, bumpCells: 22, fibers: 0.1, specks: 0.2, laid: 0, relief: 0.9, mottle: 0.02, smudge: 0, grid: 0 },
  { id: 'kraft', name: 'Kraft', color: '#c29b6d', speck: '#6f5234', tooth: 0.6, toothCells: 120,
    bumps: 0, bumpCells: 1, fibers: 0.9, specks: 0.9, laid: 0, relief: 0.45, mottle: 0.05, smudge: 0, grid: 0 },
  { id: 'black', name: 'Black card', color: '#1b1b1d', speck: '#3a3a3d', tooth: 0.5, toothCells: 128,
    bumps: 0, bumpCells: 1, fibers: 0.15, specks: 0.3, laid: 0, relief: 0.6, mottle: 0.05, smudge: 0, grid: 0, dark: true },
  { id: 'chalkboard', name: 'Chalkboard', color: '#2c3a33', speck: '#46544c', tooth: 0.55, toothCells: 110,
    bumps: 0, bumpCells: 1, fibers: 0, specks: 0.2, laid: 0, relief: 0.5, mottle: 0.08, smudge: 0.22, grid: 0, dark: true },
  { id: 'blueprint', name: 'Blueprint', color: '#1d4a86', speck: '#2e5c99', tooth: 0.45, toothCells: 128,
    bumps: 0, bumpCells: 1, fibers: 0.2, specks: 0.2, laid: 0, relief: 0.45, mottle: 0.04, smudge: 0, grid: 1, dark: true },
];

export const paperById = id => PAPERS.find(p => p.id === id) || PAPERS[0];

// Tile generator. Uniforms: uSeed, uTooth, uToothCells, uBumps, uBumpCells, uFibers, uSpecks, uLaid.
// Everything must tile: integer lattice periods on both axes.
export const PAPER_TILE_GLSL = /* glsl */`
float hp(vec2 i, vec2 period) { return hash21(mod(i, period) + uSeed * 37.0); }
// Value noise that tiles with an integer lattice period per axis.
float vnoiseP(vec2 p, vec2 period) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hp(i, period), hp(i + vec2(1.0, 0.0), period), u.x),
             mix(hp(i + vec2(0.0, 1.0), period), hp(i + vec2(1.0, 1.0), period), u.x), u.y);
}
float fbmP(vec2 p, vec2 period) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int k = 0; k < 4; k++) {
    s += a * vnoiseP(p, period);
    n += a; a *= 0.55; p *= 2.0; period *= 2.0;
  }
  return s / n;
}
// Periodic Worley F1: soft domes for cold-press paper.
float worleyP(vec2 p, float period) {
  vec2 i = floor(p), f = fract(p);
  float d = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 c = mod(i + o, period);
    vec2 j = vec2(hash21(c + 11.0 + uSeed), hash21(c + 71.0 + uSeed));
    d = min(d, length(o + j - f));
  }
  return d;
}
// Thin elongated streaks (paper fibres).
float fibres(vec2 uv, vec2 cells, float salt) {
  float warp = vnoiseP(uv * 24.0 + salt, vec2(24.0)) * 3.0;
  float n = vnoiseP(uv * cells + vec2(salt, warp), cells);
  return smoothstep(0.78, 0.97, n);
}
vec4 paperTile(vec2 uv) {
  float tooth = fbmP(uv * uToothCells, vec2(uToothCells));
  float h = 0.5 + (tooth - 0.5) * 1.9 * uTooth;
  if (uBumps > 0.0) {
    float f1 = worleyP(uv * uBumpCells, uBumpCells);
    float dome = 1.0 - smoothstep(0.05, 0.85, f1);
    float fine = fbmP(uv * uBumpCells * 3.0, vec2(uBumpCells * 3.0));
    h += (dome - 0.55) * 0.55 * uBumps + (fine - 0.5) * 0.25 * uBumps;
  }
  float fib = 0.0;
  if (uFibers > 0.0) {
    fib = max(fibres(uv, vec2(8.0, 96.0), 3.0), fibres(uv.yx, vec2(8.0, 96.0), 9.0) * 0.8);
    fib = max(fib, fibres(uv + 0.5, vec2(13.0, 160.0), 21.0) * 0.6);
    h += fib * 0.12 * uFibers;
  }
  if (uLaid > 0.0) h += (sin(uv.y * 6.2831853 * 180.0) * 0.5) * 0.06 * uLaid;
  float speck = 0.0;
  if (uSpecks > 0.0) {
    float s = hp(floor(uv * 512.0), vec2(512.0));
    speck = smoothstep(0.9965, 0.9995, s) * uSpecks;
    speck = max(speck, fib * uFibers * 0.6);
  }
  h = clamp(h, 0.0, 1.0);
  return vec4(h, h * h, clamp(speck, 0.0, 1.0), 1.0);
}
`;

// Paper surface colour at full-paper pixel P (without ink). Also returns the relief `shade`
// (1.0 on flat paper) which the composite applies to paper and, partly, to ink.
// Uniforms: uPaperColor, uSpeckColor, uRelief, uMottle, uSmudge, uSpeckAmt, uGrid.
export const PAPER_SURFACE_GLSL = /* glsl */`
vec3 paperSurface(vec2 P, out float shade) {
  float e = max(1.0, exp2(max(0.0, -uTileLod)));
  vec3 g = grainAt(P, 0.0);
  float hx = grainAt(P + vec2(e, 0.0), 0.0).x - grainAt(P - vec2(e, 0.0), 0.0).x;
  float hy = grainAt(P + vec2(0.0, e), 0.0).x - grainAt(P - vec2(0.0, e), 0.0).x;
  float k = 3.0 * uRelief;
  vec3 n = normalize(vec3(-hx * k, -hy * k, 1.0));
  float light = dot(n, normalize(vec3(-0.55, -0.65, 1.0))) / 0.7408;   // 1.0 on flat paper
  shade = 1.0 + (light - 1.0) * 1.1 + (g.x - 0.5) * 0.12 * uRelief;

  vec2 pu = P / uPaperPx;
  float mott = (fbm2(pu * 6.0 + 5.0) - 0.5) * uMottle + (fbm2(pu * 23.0 + 1.0) - 0.5) * uMottle * 0.5;
  vec3 paper = uPaperColor * (1.0 + mott);
  paper = mix(paper, uSpeckColor, g.z * uSpeckAmt);
  if (uSmudge > 0.0) {
    float sm = smoothstep(0.35, 0.9, fbm2(pu * vec2(2.0, 5.0) + 9.0));
    paper = mix(paper, paper * 1.35 + 0.04, sm * uSmudge);
  }
  if (uGrid > 0.0) {
    // 5 mm minor / 25 mm major grid in faint white (sheet = 200 mm = 1000 U)
    float gl = 0.0;
    for (int i = 0; i < 2; i++) {
      float pitch = (i == 0 ? 25.0 : 125.0) * uU;            // px
      float wpx = (i == 0 ? 0.6 : 1.0) * uU;                 // line width px
      vec2 dd = abs(fract(P / pitch + 0.5) - 0.5) * pitch;   // px to nearest line
      float lw = max(wpx, 1.0);
      float line = 1.0 - smoothstep(lw * 0.5 - 0.5, lw * 0.5 + 0.5, min(dd.x, dd.y));
      gl = max(gl, line * min(1.0, wpx) * (i == 0 ? 0.10 : 0.18));
    }
    paper = mix(paper, vec3(0.93, 0.96, 1.0), gl * uGrid);
  }
  return paper;
}
`;
