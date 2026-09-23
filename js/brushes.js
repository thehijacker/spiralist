// Drawing media: data + the GLSL that turns a stroke fragment into pigment and surface.
//
// Each brush's GLSL branch receives a `Stroke` (see BRUSH_GLSL) and returns the pigment deposit
// a in [0,1]; it may also tint `ink` and describe the sheet's surface under the stroke in `sf`
// (grooves, raised material, sheen, liquid load; see Surface below). Everything textural is
// expressed in paper units (sU, P/uU) or relative to the stroke half-width, never in raw pixels,
// so previews, thumbnails and 8K exports read the same. Use aa(featurePx) to fade detail that
// would alias below ~2px.
//
// Physical data per medium (read by js/renderer.js and js/wetsim.js):
//   material  how the dry medium reflects light in the lit composite:
//             'ink' (dielectric film, faint sheen), 'graphite' (neutral metallic-ish sheen at
//             glancing light), 'wax' (broad soft gloss), 'chalk' (matte powder), 'metal' (coloured
//             glints from flake normals), 'light' (emissive: no surface, flickers with setTime)
//   wetness   liquid load 0..1; > 0 runs the wet simulation (bleed, pooling at dwell, coffee-ring
//             rims, granulation, blooms, wet sheen that dries). 0 = dry media, no simulation cost.
//   wet       { mobile: share of the colour that travels with the liquid (the rest is fixed where
//               the tool touched), dye: share that is dissolved dye (soaks into the fibres with the
//               water) rather than particles (settle, granulate), gran: granulation 0..1,
//               dry: drying speed x, flow: how freely the liquid spreads x, pool: how wide a blot
//               grows where the pen lingers x (dwell), poolAt: how long the tool must linger before
//               it floods (dwell above 1; felt tips only where the hand really stops, and a hand
//               hesitates more at some turns than others), layer: share of its ink an earlier pass
//               keeps where a later pass of the line covers it too (layered dye darkens), wick:
//               share of the colour the sheet drinks with the water and carries through its
//               fibres (bleed; default = dye), retard: how
//               fast that colour follows the fibres' water (0..1), stick: how readily the fibres
//               catch it x (low = long, faint bleeds), sharp: 0..1, how firmly the simulated share
//               that did not move keeps the stroke's own fine shape where the grid is magnified,
//               sheen: dried dye film's metallic sheen (dark dye inks) }
export const BRUSHES = [
  { id: 'pencil', name: 'Pencil', blurb: 'Soft graphite on the tooth', shader: 4, tool: 'pencil',
    inks: [['#2a2a2e', 'Graphite'], ['#28427a', 'Blue'], ['#8e2a2a', 'Red'], ['#2f5a3a', 'Green'], ['#5a4030', 'Sepia'], ['#eeebe3', 'White']],
    spread: 1.1, lightInk: 0.9, material: 'graphite', wetness: 0 },
  { id: 'fineliner', name: 'Pen', blurb: 'Crisp, even fineliner', shader: 0, tool: 'fineliner',
    inks: [['#17171a', 'Black'], ['#1f3a93', 'Blue'], ['#8e1b1b', 'Red'], ['#0f5132', 'Green'], ['#4a3222', 'Sepia'], ['#f4f1ea', 'White']],
    spread: 1.4, lightInk: 0.35, material: 'ink', wetness: 0 },
  { id: 'fountain', name: 'Ink', blurb: 'Fountain ink with wet edges', shader: 2, tool: 'fountain',
    inks: [['#141a3a', 'Blue-black'], ['#101012', 'Black'], ['#233fa0', 'Royal blue'], ['#3b2314', 'Sepia'], ['#7a1025', 'Crimson'], ['#0e4a4c', 'Teal']],
    spread: 2.0, lightInk: 0.4, material: 'ink', wetness: 0.5,
    wet: { mobile: 0.3, dye: 0.85, gran: 0, dry: 1.0, flow: 0.8, pool: 0.7, poolAt: 0.3, sharp: 1, sheen: 0.35, wick: 0.6, retard: 0.5 } },
  { id: 'crayon', name: 'Crayon', blurb: 'Waxy, broken edges', shader: 6, tool: 'crayon',
    inks: [['#cf3129', 'Red'], ['#1f5fa8', 'Blue'], ['#2e8a3a', 'Green'], ['#ee8a14', 'Orange'], ['#6a2a9e', 'Violet'], ['#1d1d1f', 'Black'], ['#f5f1e6', 'White']],
    spread: 1.5, lightInk: 0.85, material: 'wax', wetness: 0 },
  { id: 'ballpoint', name: 'Ballpoint', blurb: 'Everyday biro, uneven flow', shader: 1, tool: 'ballpoint',
    inks: [['#1d3a8a', 'Blue'], ['#16161a', 'Black'], ['#b3202a', 'Red'], ['#0d6b4f', 'Green']],
    spread: 2.1, lightInk: 0.45, material: 'oil', wetness: 0 },
  { id: 'marker', name: 'Marker', blurb: 'Flat, bold felt tip', shader: 7, tool: 'marker',
    inks: [['#0f8b7d', 'Teal'], ['#1f4fb0', 'Blue'], ['#d7263d', 'Red'], ['#f46036', 'Orange'], ['#7b2d8e', 'Violet'], ['#2d2a32', 'Black'], ['#f7f4ec', 'White']],
    spread: 2.0, lightInk: 0.3, material: 'ink', wetness: 0.5,
    wet: { mobile: 0.3, dye: 1.0, gran: 0, dry: 1.6, flow: 0.7, pool: 0.8, poolAt: 0.7, wick: 0.8, sharp: 1, retard: 0.85, stick: 0.5 } },
  { id: 'brush', name: 'Brush', blurb: 'Sumi ink, dry-brush streaks', shader: 3, tool: 'brush',
    inks: [['#0e0e0e', 'Sumi black'], ['#5a1a1a', 'Oxblood'], ['#1d2b53', 'Indigo'], ['#f2efe6', 'White']],
    spread: 1.4, lightInk: 0.5, material: 'ink', wetness: 0.65,
    wet: { mobile: 0.35, dye: 0.3, gran: 0.25, dry: 1.2, flow: 1.0, wick: 0.8, sharp: 1, retard: 0.75, stick: 0.8, tide: 0.6 } },
  { id: 'charcoal', name: 'Charcoal', blurb: 'Velvety, smudged halo', shader: 5, tool: 'charcoal',
    inks: [['#1b1715', 'Vine'], ['#2b2522', 'Compressed'], ['#4a2e22', 'Sanguine'], ['#efece4', 'White']],
    spread: 2.4, lightInk: 0.8, material: 'chalk', wetness: 0 },
  { id: 'chalk', name: 'Chalk', blurb: 'Dusty pastel for dark boards', shader: 8, tool: 'chalk',
    inks: [['#f3f0e8', 'White'], ['#ffd1dc', 'Pink'], ['#bfe3ff', 'Sky'], ['#fff2a8', 'Yellow'], ['#c9f2c7', 'Mint']],
    spread: 3.0, lightInk: 0.4, prefersDark: true, material: 'chalk', wetness: 0 },
  { id: 'neon', name: 'Neon', blurb: 'Glowing light-pen line', shader: 9, tool: 'neon',
    inks: [['#ff45e9', 'Pink'], ['#3cf2ff', 'Cyan'], ['#b8ff3c', 'Lime'], ['#ffb23c', 'Amber'], ['#ffffff', 'White']],
    spread: 3.0, lightInk: 0.2, glow: { amount: 0.58, tight: 2.5, wide: 9.0 }, forceCover: true, prefersDark: true,
    material: 'light', wetness: 0 },
  { id: 'gold', name: 'Gold', blurb: 'Metallic leaf with sparkle', shader: 10, tool: 'goldpen',
    inks: [['#d9b44a', 'Gold'], ['#c9ccd1', 'Silver'], ['#c57b4a', 'Copper'], ['#dca08c', 'Rose gold']],
    spread: 1, lightInk: 0.35, forceCover: true, prefersDark: true, material: 'metal', wetness: 0 },
  { id: 'watercolour', name: 'Watercolour', blurb: 'Wet washes that bloom and dry with hard edges', shader: 11, tool: 'brush',
    inks: [['#2c4f8a', 'Ultramarine'], ['#9a2a3a', 'Alizarin'], ['#3f6d3a', 'Sap green'], ['#7a4a26', 'Burnt umber'], ['#b8612a', 'Burnt sienna'], ['#33384a', "Payne's grey"]],
    spread: 1.55, lightInk: 0.7, material: 'ink', wetness: 1.0,
    wet: { mobile: 0.92, dye: 0.1, gran: 0.8, dry: 0.55, flow: 1.3, layer: 0.35 } },
];

export const brushById = id => BRUSHES.find(b => b.id === id) || BRUSHES[1];

/** Wet-media parameters with defaults (see the header); null for dry media. */
export function brushWet(b) {
  if (!b || !(b.wetness > 0)) return null;
  const w = b.wet || {};
  return { load: b.wetness, mobile: w.mobile ?? 0.3, dye: w.dye ?? 0.5, gran: w.gran ?? 0, dry: w.dry ?? 1, flow: w.flow ?? 1,
    pool: w.pool ?? 1, poolAt: w.poolAt ?? 0, layer: w.layer ?? 1, sharp: w.sharp ?? 0, wick: w.wick ?? w.dye ?? 0.5, sheen: w.sheen ?? 0,
    retard: w.retard ?? 0.6, stick: w.stick ?? 1, tide: w.tide ?? 3 };
}

// Inputs available to every brush branch:
//   st.cov   1px box-filtered coverage of the ideal stroke
//   st.dist  px distance from the centre line;  st.hw  half-width px (>= 0.5)
//   st.v     dist/hw (0 centre .. 1 edge);      st.vs  signed across coordinate (-1..1)
//   st.side  which side of the centre line (+1/-1)
//   st.s     px along the line;                 st.sU  paper units along the line
//   st.tone  darkness of the photo here (0..1), i.e. pressure
//   st.P     full-paper px position (for paper grain)
//   st.dwell how long the pen lingers here (>= 1; tight turns, maze corners, the first rings)
//   st.speed pen speed relative to cruising over empty paper (1), slower where it lays down ink
//            and where it dwells (the 'natural' pacing's own model of the hand)
//   st.time  drawing progress when the pen passed here (0..1, the renderer's pacing)
//   st.hU    true half-width in paper units (before sub-pixel strokes are widened to 1 px)
//   st.curv  signed curvature of the line here, 1 / paper unit (+ = turning from +x toward +y, i.e.
//            clockwise on the sheet; 1 / radius of the bend). Brushes swell and pool on tight bends.
//   st.dir   unit direction of travel, paper px axes (x right, y down): nib angle, drag direction
//   feedAt() how far the pen's ink feed has fallen behind on this segment, 0 (full) .. 1 (dry),
//            typically 0.15-0.35: it drains over a long, heavy run and catches up where the hand
//            slows or lingers (wetsim.js feedDeficit, integrated along the line; the varying vFeed)
// Surface written through `sf` (the renderer MAX-blends it into its surface target; all 0..1):
//   sf.groove indentation of the sheet (1 = 0.05 mm): ballpoint ball, pencil pressure, nib, grit
//   sf.raised material standing on the sheet (1 = 0.05 mm): wax, chalk powder, metal paint / leaf
//   sf.sheen  specular strength of the dry material (the brush's `material` sets the lobe/colour)
//   sf.wet    liquid load multiplier for the wet simulation (wet media only; default 1)
// Helpers: grainAt(P, lodBias) -> (height, hidden std, specks); above(g, th, soft);
//          vnoise(vec2); hash21(vec2); aa(featurePx); uU (px per paper unit); uPaperPx; uSeed.
//          Defined below: over/overV (thresholds that know the hidden spread), excess, vnA
//          (value noise that fades below 2px), tooth (paper tooth split into scales), edgeCov,
//          segFrame (arc length / across distance continued through the segment caps).
// Also read straight from the stroke pass (FRAG_STROKE in js/shaders.js), so renaming them there
// breaks the brushes: the varyings vP0, vP1, vS, vW, vPos (segFrame) and the uniform uPhotoColor.
//
// Consistency rules used throughout, so a 1000-px preview and a box-downsampled 8K export deposit
// the same amount of pigment (measured with dev/brush_lab.html?mode=cons|ladder):
//   * texture finer than ~2px is replaced by its expected value, and the spread it no longer shows
//     is carried into every threshold (over / overV);
//   * everything else is linear in the texture: multiplied-in streaks have a known mean, rims and
//     feathering only redistribute ink (zero mean), halos are rings added outside the core;
//   * anything added outside the stroke scales with the half-width, never with a fixed U or px
//     amount, because sub-pixel strokes are drawn 1px wide and faded by the renderer.
// Chip-sized strokes (far wider than any real tool) switch texture scales from paper units to a
// fraction of the width, so the 70-160px tool chips still show each medium's character.
// Measured in dev/brush_lab.html (mode=cons, ladder, ramp, detail, appchips, perf).
export const BRUSH_GLSL = /* glsl */`
struct Stroke { float cov; float dist; float hw; float v; float vs; float side; float s; float sU; float tone; vec2 P;
  float dwell; float speed; float time; float hU; float curv; vec2 dir; };
struct Surface { float groove; float raised; float sheen; float wet; };

// Logistic approximation of the normal CDF.
float ncdf(float x) { return 1.0 / (1.0 + exp(-1.702 * x)); }
// Fraction of the footprint where a quantity with resolved mean m and unresolved spread sd
// exceeds th (soft = resolved edge width).
float over(float m, float sd, float th, float soft) { return ncdf((m - th) / sqrt(sd * sd + soft * soft + 1e-6)); }
// Same, when part of the hidden spread (sdV) comes from value noise: that is a bounded bell whose
// CDF is almost exactly a smoothstep 2.236 sd wide, so the two shapes are mixed by variance share.
float overV(float m, float sdN, float sdV, float th, float soft) {
  float s2 = sdN * sdN + sdV * sdV + soft * soft + 1e-6;
  float s = sqrt(s2);
  return mix(ncdf((m - th) / s), smoothstep(th - 2.236 * s, th + 2.236 * s, m), sdV * sdV / s2);
}
// E[max(0, x - t)] for x ~ N(m, sd): expected overshoot, e.g. how far feathering reaches.
float excess(float m, float sd, float t) {
  if (sd < 1e-3) return max(0.0, m - t);
  float z = (m - t) / sd;
  return sd * 0.3989 * exp(-0.5 * z * z) + (m - t) * ncdf(z);
}
// Value noise with cells cellPx wide on screen: fades to its mean below ~2px and reports the
// spread it no longer shows (.y), sized so shown + hidden variance stays the noise's own (0.214^2).
vec2 vnA(vec2 p, float cellPx) { float k = aa(cellPx); return vec2(mix(0.5, vnoise(p), k), 0.214 * sqrt(1.0 - k * k)); }
// Paper tooth in two scales. x = height with features finer than featU paper units averaged,
// y = the spread that averaging hides, z = fine peak mask (1 on the tooth tops, 0 in the pits):
// z averages 0.5 at every output size, so 4K gains detail without changing tone.
vec3 tooth(vec2 P, float featU) {
  vec3 gc = grainAt(P, max(0.0, log2(max(1e-3, featU * uU * 0.5))));
  vec3 gf = grainAt(P, 0.0);
  // linear in the fine height, so its mean is exactly 0.5 whatever the paper's height histogram
  float sdl = sqrt(max(gc.y * gc.y - gf.y * gf.y, 1e-4));
  return vec3(gc.x, gc.y, clamp(0.5 + (gf.x - gc.x) / (2.4 * sdl), 0.0, 1.0));
}
// Coverage of a stroke of half-width h px whose edge ramp is e px wide (integral stays 2h).
float edgeCov(float h, float dist, float e) { e = clamp(e, 1.0, max(1.0, 2.0 * h)); return clamp((h - dist) / e + 0.5, 0.0, 1.0); }
float lum3(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// The segment's own frame, continued straight through its round caps.
// FRAG_STROKE draws each segment as a round-capped capsule and merges them with MAX blending. In a
// cap, st.s stops at the end point and st.dist is measured radially, so a texture or rim evaluated
// there would draw arcs, lumps and dashes over the next segment every few pixels. Here the arc
// length and the signed across distance carry on along the segment's line instead: on a straight
// run a cap then computes exactly what the next segment computes at that spot, and MAX changes
// nothing; on the gentle bends of a spiral the two differ by a fraction of a pixel. Reads the stroke
// pass's varyings (vP0, vP1, vS, vW, vPos). Returns (s px, signed distance from the line, true
// half-width px): the distance is scaled like st.dist, so it equals st.side * st.dist on the body;
// the half-width is the stroke's own, before the renderer widens sub-pixel lines to 1px, so it
// means the same paper width at every output size (st.hw does not).
vec3 segFrame(Stroke st) {
  vec2 ba = vP1 - vP0, pa = vPos - vP0;
  float bb = dot(ba, ba);
  float h = bb > 1e-8 ? dot(pa, ba) / bb : 0.0;
  float hc = clamp(h, 0.0, 1.0);
  float hwT = 0.5 * mix(vW.x, vW.y, hc);
  if (bb < 1e-8) return vec3(st.s, st.side * st.dist, hwT);
  float rad = length(pa - ba * hc);
  float z = (ba.x * pa.y - ba.y * pa.x) * inversesqrt(bb);
  return vec3(mix(vS.x, vS.y, h), z * st.dist / max(rad, 1e-6), hwT);
}

// ---- wet-media helpers (fineliner, fountain, sumi, marker, watercolour)
// The pen's feed deficit on this segment (FRAG_STROKE's vFeed: points i, i+1; it changes over
// centimetres, so the segment's mean is exact enough and needs no position along it).
float feedAt() { return clamp(0.5 * (vFeed.x + vFeed.y), 0.0, 1.0); }
// Four 8-bit hashes of an integer cell and a salt.
vec4 h4(vec2 c, float salt) {
  uint h = hashU(uvec2(ivec2(floor(c)) + 8192) + uvec2(uint(salt) * 7919u, uint(salt) * 3571u + 17u));
  return vec4(uvec4(h, h >> 8u, h >> 16u, h >> 24u) & 255u) / 255.0;
}
// Box-filtered coverage of a line of width w px at distance d px from the pixel centre (1 px
// footprint): exact for a hair of any width, so a hair finer than a pixel fades into the faint
// fringe it averages to and every output size carries the same ink.
float hairCov(float d, float w) { return max(0.0, min(d + 0.5 * w, 0.5) - max(d - 0.5 * w, -0.5)); }
// How readily this sheet lets a wet ink creep out along its fibres (0 on sized or coated sheets).
float featherPaper() {
  return clamp((uPaperAbsorb * (1.0 - uPaperSizing) - 0.07) * 3.2, 0.0, 1.0) * (0.35 + 0.65 * uPaperFibre);
}
// Feathering: ink wicking out of a wet line along the paper's own fibres. A fibre that crosses the
// line's edge (hwF px from the centre line) drinks ink and carries it outward along ITS direction
// (the sheet's fibre orientation, papers.js fibreAngle, so the hairs lean with the grain, not along
// the line's normal) up to reachU paper units, thinning toward the tip. One candidate fibre per
// 2-U cell (more on fibrous sheets), of random length and width. The across coordinate is the
// segment's straight frame, so neighbouring segments agree and MAX merges them. Returns 0..1.
float featherHairs(Stroke st, float hwF, float reachU) {
  vec2 dir = st.dir;
  float yP = dir.x * (st.P.y - vP0.y) - dir.y * (st.P.x - vP0.x);    // signed across, px
  float sgn = yP >= 0.0 ? 1.0 : -1.0;
  float outPx = abs(yP) - hwF;
  if (reachU <= 0.0 || outPx < -0.5 || outPx > reachU * uU + 1.0) return 0.0;
  vec2 pu = st.P / uU;
  float ang0 = fibreAngle(pu, uPaperGrain);           // fibres bend slowly: one angle per pixel
  const float C = 2.0;
  vec2 ci = floor(pu / C);
  // only some fibres drink, and they come in clumps (the sheet's flocs): feathering bursts out in
  // places and leaves long stretches of edge clean
  float clump = smoothstep(0.3, 0.75, vnoise(pu / 9.0 + uSeed * 5.3));
  float pF = (0.28 + 0.5 * uPaperFibre) * (0.45 + 1.1 * clump);
  float best = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = ci + vec2(float(x), float(y));
    vec4 r = h4(c, uSeed + 31.0);
    if (r.w > pF) continue;
    vec4 r2 = h4(c, uSeed + 37.0);
    vec2 cU = (c + r.xy) * C;                           // fibre centre, U
    float ang = ang0 + (r.z - 0.5) * 2.4;               // (machine-made sheets are only loosely aligned)
    vec2 tf = vec2(cos(ang), sin(ang));
    float Lh = C * (0.35 + 1.6 * r2.x * r2.x);          // half length, U: mostly short, a few long
    vec2 cp = cU * uU, dp = st.P - cp;
    float af = dot(dp, tf) / uU;                        // along the fibre, U
    if (abs(af) > Lh) continue;
    float yc = dir.x * (cp.y - vP0.y) - dir.y * (cp.x - vP0.x);
    float sphi = dir.x * tf.y - dir.y * tf.x;           // across px per px along the fibre
    if (abs(sphi) < 0.1) continue;                      // running along the edge: never leaves it
    float ae = (sgn * hwF - yc) / sphi / uU;            // where it crosses this edge, U along it
    if (abs(ae) > Lh) continue;                         // it does not reach the line
    float d = (af - ae) * sgn * sign(sphi);             // U outward along the fibre
    float reach = reachU * (0.45 + 0.55 * r2.z);        // each fibre drinks its own way
    if (d < 0.0 || d > reach) continue;
    float t = 1.0 - d / reach;
    // px from the fibre's axis; a fibre is never quite straight, so the hair curls a little
    float cf = tf.x * dp.y - tf.y * dp.x - (r2.w - 0.5) * 0.5 * d * d * uU;
    // (a hair is a trickle of dye in the capillaries between fibres: finer and fainter than the
    // line, fading toward its tip)
    float w = (0.05 + 0.09 * r2.y) * uU * (0.35 + 0.65 * t);
    best = max(best, hairCov(cf, w) * (0.15 + 0.7 * t));
  }
  return best;
}
// The pen's own start and end: where the tip lands and lifts, a round dot slightly wider than the
// line (the tip rests for a moment). Returns the dot's coverage for radius k * hw, the growth capped
// at 0.6 paper units (a pause feeds a blot of its own size, whatever the line's width).
float endDot(Stroke st, float k) {
  float dS = min(st.s, max(0.0, uLineEnd - st.s));
  float r = st.hw + min((k - 1.0) * st.hw, 0.6 * uU);
  float dd = length(vec2(max(0.0, dS - 0.35 * st.hw), st.dist));
  return clamp(r - dd + 0.5, 0.0, 1.0) * step(dS, 2.0 * r);
}
${dryGLSL()}
float brushDeposit(int brush, Stroke st, inout vec3 ink, out Surface sf) {
  sf = Surface(0.0, 0.0, 0.0, 1.0);
  float a = 0.0;
  float hw = st.hw, dist = st.dist, v = st.v, side = st.side, tone = st.tone;
  vec2 P = st.P;
  vec2 PU = P / uU;                   // paper units
  float hU = hw / uU;                 // half-width in paper units
  vec3 fr = segFrame(st);
  float sU = fr.x / uU;               // paper units along the line
  float across = fr.y / uU;           // signed distance from the centre line, paper units
  float dP = abs(fr.y);               // px from the line (rims use it; coverage keeps st.dist)
  float hUT = fr.z / uU;              // true half-width, paper units (size-independent)
  float sd0 = uSeed * 7.31;
  // Texture scales are physical (paper units) at every realistic stroke width; only strokes far
  // wider than a real tool (e.g. the zoomed-in brush chips) switch to scales relative to the
  // width, so a 160-px chip still shows streaks and ragged edges.
  if (brush == 0) {                   // fineliner: pigment ink in a fibre tip, crisp and dense
    // Pigment particles are caught by the sheet's surface at once, so the line is crisp, dense
    // and even and does not feather. Where the tip rests (the line's two ends, lingering turns)
    // the capillary feed keeps flowing: a tiny round dot, a little wider on a thirsty sheet.
    float fk = featherPaper();
    a = st.cov * 0.975;
    a = max(a, endDot(st, 1.15 + 0.2 * fk) * 0.975);
    // at a lingering turn (maze corners) the feed wets the apex: a faint round bleed outside the
    // line on thirsty sheets only, round about each lingering point (the segment's own frame is
    // radial in its caps), never a band
    float linger = min(st.dwell - 1.0, 1.0) * fk;
    if (linger > 0.0) a = max(a, clamp(hw * (1.0 + 0.3 * linger) + 0.35 * uU * linger - dist + 0.5, 0.0, 1.0) * 0.35);
    // the felt tip presses a shallow, flat-bottomed track; dried pigment ink is nearly matte
    sf.groove = 0.12 * st.cov * (0.5 + 0.5 * tone);
    sf.sheen = 0.05 * a;
  } else if (brush == 1) {            // ballpoint (dry media: see dryGLSL at the end of this file)
    a = dryBallpoint(st, ink, sf);
  } else if (brush == 2) {            // fountain pen: a dye ink film laid by a nib
    // Film thickness, as the dye's Beer-Lambert density (ink^dens; the coverage stays the stroke's
    // own, so the photo's tone still comes from the width). The feed meters ink at a steady rate:
    // where the nib goes slowly (the darks, tight bends) the film is thicker and the dye deeper, and
    // a quick light line is a thin film that shows the ink's own hue ("shading"). The feed and the
    // hand also ebb and flow along the line (independently from ring to ring: lighter and darker
    // stretches, 5-20 mm long), strokes pulled toward the writer run wetter than side strokes, and
    // where a broad stroke narrows, the bead of ink it carried is left in the narrower line: every
    // swell ends in a darker tail. (Pauses are the simulation's round pools, not a density step here,
    // which would cut a square band where the lingering starts.)
    vec2 f1 = vnA(vec2(sU / 90.0, sd0 + 11.0), 90.0 * uU);
    vec2 f2 = vnA(vec2(sU / 26.0, sd0 + 29.0), 26.0 * uU);
    float slow = clamp(1.0 / max(st.speed * st.dwell, 0.25) - 1.0, 0.0, 3.0);
    float pull = dot(st.dir, vec2(-0.35, 0.937));
    float bend = smoothstep(0.04, 0.3, abs(st.curv));
    vec2 sg = vP1 - vP0;
    float narrow = smoothstep(0.03, 0.2, (vW.x - vW.y) * inversesqrt(max(dot(sg, sg), 1e-6)));
    // The feed meters ink at a limited rate from a small reserve behind the nib: a long, heavy run
    // draws it down (the line pales over 15-25 mm) and it catches up where the hand slows or lingers
    // (st.feed, integrated along the line; centred on its typical 0.25, so the mean tone holds).
    float fed = 0.8 * (feedAt() - 0.25);
    float dens = 0.5 + 0.36 * smoothstep(0.05, 0.9, tone) + 0.05 * slow + 0.62 * (f1.x - 0.5) + 0.34 * (f2.x - 0.5)
               + 0.04 * pull + 0.2 * bend + 0.3 * narrow - fed;
    // a gently wandering edge: the nib's tipping skates over the tooth
    vec2 wob = vnA(vec2(sU / 3.0, side * 5.0 + sd0), 3.0 * uU);
    float hwF = hw + (wob.x - 0.5) * 0.22 * min(hw, uU);
    float c2 = clamp(hwF - dist + 0.5, 0.0, 1.0);
    // Coffee ring: as a broad film dries, its dye is carried to the pinned edge (Deegan flow), so a
    // line wider than ~0.5 mm dries with a darker rim 0.1-0.2 mm wide and a paler middle, the dye in
    // total unchanged. The rim is a band across the stroke, box-filtered over this pixel: where it is
    // finer than a pixel (previews) the edge pixels simply come out darker than the middle, which is
    // what a downsampled 4K render of the rim shows too.
    // (it needs the film to stand while it dries: strongest on sized sheets, weaker where the
    // paper drinks the ink at once)
    float ringK = smoothstep(1.2, 2.6, hUT) * (0.4 + 0.6 * smoothstep(0.3, 0.7, uPaperSizing));
    float rimW = clamp(0.3 * hUT, 0.5, 1.0) * uU;
    float inner = clamp(hwF - rimW - dP + 0.5, 0.0, 1.0);
    float rimShare = clamp((c2 - inner) / max(c2, 1e-3), 0.0, 1.0) * ringK;
    float dR = dens * (1.0 + 0.55 * ringK);
    float dI = dens * (1.0 - 0.55 * ringK * rimW / max(hwF - rimW, rimW));
    a = c2 * 0.975;
    // the pen lands and lifts: a small, denser blot at both ends of the line
    float dot0 = endDot(st, 1.3);
    float dotK = clamp((dot0 - c2) / max(dot0, 1e-3), 0.0, 1.0);
    a = max(a, dot0 * 0.975);
    // Feathering on thirsty, unsized sheets: hairs of ink along the fibres, longer where the line is
    // loaded (dark, slow, lingering). Only the sheet pass draws them (the wet grid is far coarser).
    // A hair keeps its paper length at every size; the renderer fades sub-pixel lines by their
    // true width (thin), so the hairs are divided by it here and keep their ink at preview size.
    // Many fine hairs per millimetre: a preview shows their average as a soft, fibrous fringe.
    // (Only for photo-coloured ink now: otherwise the composite walks the simulated ink out along
    // the sheet's own fibres (wetsim.js WET_FIBRE_GLSL), which it cannot tint from the photo.)
    float fk = featherPaper();
    float hairK = 0.0;
    if (uPass == 0 && fk > 0.0 && uCover == 0 && uPhotoColor == 1) {
      float reachU = fk * (2.0 + 3.0 * smoothstep(0.1, 0.9, tone)) * (1.0 + 0.15 * slow) * (0.8 + 0.4 * f1.x);
      reachU = min(reachU, ((uSpread - 1.0) * hw + 0.3) / uU);   // stay inside the stroke's reach
      float thin = clamp(st.hU * uU / hw, 0.05, 1.0);
      float fh = featherHairs(st, hwF, reachU) * (0.6 + 0.35 * fk);
      if (fh * thin > a * thin) { a = fh / thin; hairK = 1.0; }
    }
    if (uCover == 0) {
      // transmittances mixed over the pixel: middle, rim, blot (the pixel's own share of each)
      vec3 k0 = max(ink, vec3(1e-3));
      vec3 tI = pow(k0, vec3(clamp(dI, 0.3, 1.8)));
      vec3 tR = pow(k0, vec3(clamp(dR, 0.3, 1.8)));
      vec3 tD = pow(k0, vec3(clamp(dens + 0.3, 0.3, 1.8)));
      ink = mix(mix(tI, tR, rimShare), tD, dotK);
      if (hairK > 0.0) ink = pow(k0, vec3(clamp(0.6 * dens, 0.25, 1.8)));
    }
    // the tines spread under pressure and score two faint tracks; the dye dries nearly matte, a
    // little glossier on the rim. The wet simulation carries the liquid: as much as the film holds.
    float tines = mix(0.5, 0.5 + 0.5 * cos(3.1416 * clamp(st.v * 2.0, 0.0, 2.0)), aa(hw));
    sf.groove = 0.14 * tone * st.cov * tines;
    sf.sheen = min(a, 1.0) * (0.04 + 0.1 * rimShare) * c2;
    sf.wet = (0.45 + 0.5 * clamp(dens, 0.3, 1.5)) * (1.0 - 0.5 * fed);
  } else if (brush == 3) {            // sumi: soot in animal glue, laid by a soft hair brush
    // The brush's load along the line. The painter re-dips once in every ~150 mm of line, at a random
    // point of it (dips 30-270 mm apart, never in step from ring to ring). A freshly dipped brush
    // lands wet and black (a fuller start with a round front), the belly feeds the tip for most of
    // the way, and over the last 10-30 mm before the next dip the brush runs dry: first the hair tips
    // skip the tooth at the edges (a ragged, feathery edge), then the hairs part into lanes along the
    // stroke, then the lanes end one by one in tapering streaks. Nothing ever cuts across the stroke:
    // each lane has its own ink. Pressing (the darks) squeezes the belly, so it stays wet longer.
    // (a brush far broader than any real one, the tool chips' 20 mm band, holds more ink and dries
    // out over a longer stretch, so its chip still shows a dip or two and a gradual dry-out)
    float wS = max(1.0, hUT / 12.0);
    float SLOT = 750.0 * wS;                                           // U per dip (150 mm)
    float k0 = floor(sU / SLOT);
    float kL = sU >= (k0 + 0.1 + 0.8 * hash21(vec2(k0, sd0 + 61.0))) * SLOT ? k0 : k0 - 1.0;
    float dLast = (kL + 0.1 + 0.8 * hash21(vec2(kL, sd0 + 61.0))) * SLOT;
    float dNext = (kL + 1.1 + 0.8 * hash21(vec2(kL + 1.0, sd0 + 61.0))) * SLOT;
    float since = sU - dLast, until = dNext - sU;
    float span = (60.0 + 110.0 * hash21(vec2(kL, sd0 + 67.0))) * wS;  // the dry-out, U (12-34 mm)
    float press = smoothstep(0.3, 1.0, tone);
    float dryEnd = clamp(1.2 - 0.35 * press, 0.0, 1.0);                 // how dry it is at the dip
    float dry = clamp(1.0 - until / span, 0.0, 1.0) * dryEnd;
    float land = exp(-since / (14.0 * wS));                            // the landing's press
    // the ink's shade: the painter grinds it black for the darks and thins it to a grey wash for the
    // lights (Beer-Lambert on the ink colour; coverage and width still carry the photo's tone); a
    // fresh dip lays it deepest, a drying brush a thinner film
    float dens0 = mix(0.45, 1.0, smoothstep(0.05, 0.75, tone));
    float dens = dens0 * (1.0 - 0.2 * dry) + 0.15 * land;
    // the brush swells and eases along the line (its belly presses, the hand breathes), and its
    // edge is the uneven front of the hairs
    float wc = max(5.0, 1.2 * hUT);
    vec2 wob = vnA(vec2(sU / wc, side * 3.1 + sd0), wc * uU);
    vec2 hairs = vnA(vec2(sU / 1.3, side * 7.7 + sd0), 1.3 * uU);      // the hair tips' ragged front
    vec2 swell = vnA(vec2(sU / 45.0, sd0 + 7.3), 45.0 * uU);
    float hw0 = hw * (0.9 + 0.14 * wob.x + 0.1 * (swell.x - 0.5) * (1.0 - dry));
    float rag = (hairs.x - 0.5) * min(hw, uU);
    float hwE = hw0 + 0.12 * hw * land + rag * (0.35 + 0.5 * dry);
    // the landing's round front (the new stroke starts where the dip put the brush down)
    float sPx = since * uU;
    // (its front is only roughly round: the hairs touch down a little unevenly)
    float fJ = vnA(vec2(across / 0.9, sd0 + 13.0 + kL), 0.9 * uU).x;
    float rF = hwE * (0.85 + 0.3 * fJ);
    float edge = min(clamp(hwE - dist + 0.5, 0.0, 1.0), clamp(rF - length(vec2(max(rF - sPx, 0.0), dist)) + 0.5, 0.0, 1.0));
    // Kasure. The hairs are bundled into clumps a fraction of the stroke wide, each running dry on
    // its own; a dry hair only touches the tooth tops, the more so the drier it is. Each spot gets a
    // zero-mean score (clumps, hairs, how far the tooth stands above its surroundings) and the brush
    // covers the spots scoring above a threshold set for the share of the stroke it still reaches:
    // all of it when loaded, a quarter (a few long streaks) when spent. So the lanes open and end one
    // by one, each at its own place, tapering; the outer hairs go first. Everything is width-relative
    // across the stroke (it is the brush's own hair count), so a thin stroke simply shows fewer
    // lanes; lanes below 2 px carry their spread into the threshold (overV), so a preview holds the
    // same ink as the export. (Fixed streak lengths: a length that changed along the line would
    // squeeze the noise into dots.)
    float uA = clamp(across / max(hUT, 1e-3), -1.0, 1.0);             // -1..1 across the brush
    // (three scales of lanes: a few broad clumps that a preview still shows, finer bundles and single
    // hairs; each shorter along the line than the dry-out, so the lanes end at staggered places)
    float pC = max(0.6 * hUT, 1.3), pM = max(0.28 * hUT, 0.8), pF = max(0.12 * hUT, 0.5);
    vec2 clm = vnA(vec2(sU / 70.0 + sd0, across / pC), pC * uU);
    vec2 bun = vnA(vec2(sU / 40.0 + sd0 + 2.3, across / pM + 7.0), pM * uU);
    vec2 hr = vnA(vec2(sU / 25.0 + sd0 + 5.1, across / pF), pF * uU);
    vec4 g = dryGrain(P, 2.0, 1.5, dryMag(hUT));
    // (the hairs lead: the tooth only frays the lanes' edges, it does not break them into dots)
    float wtT = (0.01 + 0.025 * dry) * clamp(4.0 / max(hUT, 0.5), 0.3, 1.0);  // (chips: bristles lead)
    float score = 0.4 * (clm.x - 0.5) + 0.3 * (bun.x - 0.5) + 0.2 * (hr.x - 0.5)
                + wtT * clamp((g.x - g.z) / g.w, -2.5, 2.5);
    float sdV = length(vec3(0.4 * clm.y, 0.3 * bun.y, 0.2 * hr.y)), sdN = wtT * g.y / g.w;
    float sdT = sqrt(0.0133 + wtT * wtT);                                // the score's whole spread
    float outer = smoothstep(0.55, 1.0, abs(uA));
    // share of the stroke the hairs still reach -> threshold (logistic inverse of the normal CDF)
    float cov = (1.0 - 0.74 * smoothstep(0.12, 1.0, dry)) * (1.0 - 0.35 * smoothstep(0.1, 0.6, dry) * outer);
    cov = clamp(cov, 0.02, 0.995);
    float fil = overV(score, sdN, sdV, -sdT * log(cov / (1.0 - cov)) / 1.702, 0.02);
    // the tip of a hairline holds its ink longest, so the thinnest lines stay nearly whole
    float tipK = smoothstep(0.35, 1.5, hUT);
    float body = mix(1.0, fil, smoothstep(0.05, 0.3, dry) * mix(0.45, 1.0, tipK));
    a = edge * body * 0.985;
    // the spent brush's last streaks run on a little past the dip, into the fresh stroke's landing,
    // which covers their ends: the old stroke and the new overlap like a real restart
    if (sPx < 1.4 * hwE) {
      float covO = clamp((1.0 - 0.74 * smoothstep(0.12, 1.0, dryEnd)) * (1.0 - 0.35 * smoothstep(0.1, 0.6, dryEnd) * outer), 0.02, 0.995);
      float filO = overV(score, sdN, sdV, -sdT * log(covO / (1.0 - covO)) / 1.702, 0.02);
      float aO = clamp(hw0 + rag * (0.35 + 0.5 * dryEnd) - dist + 0.5, 0.0, 1.0) * mix(1.0, filO, mix(0.45, 1.0, tipK))
               * (1.0 - smoothstep(0.5 * hwE, 1.4 * hwE, sPx)) * 0.985;
      if (aO > a) { a = aO; dens = dens0 * (1.0 - 0.2 * dryEnd); }
    }
    // a loaded brush lands and lifts with a press: small round blots at the line's two ends
    a = max(a, endDot(st, 1.3) * 0.985);
    // a loaded brush leaves faint hair tracks in the film itself (resolved only on broad strokes)
    dens *= 1.0 + 0.16 * (clm.x - 0.5) * (1.0 - dry);
    // (nijimi, the grey bleed of a loaded brush into a thirsty sheet, is the simulation's: the
    // water the fibres drink carries the finest soot out and leaves it where it stops)
    if (uCover == 0) ink = pow(max(ink, vec3(1e-3)), vec3(dens));
    // soot in glue dries with a faint sheen where it lies thick; a loaded brush lays a lot of
    // liquid, a fresh dip more still, a spent one almost none (the streaks are where it ran out)
    float load = 1.0 - dry;
    sf.sheen = 0.2 * edge * body * smoothstep(0.55, 0.95, load);
    sf.wet = mix(0.15, 1.0, load * load) * mix(0.5, 1.0, body) * (1.0 + 0.5 * land);
  } else if (brush == 4) {            // pencil (dry media: see dryGLSL at the end of this file)
    a = dryPencil(st, ink, sf);
  } else if (brush == 5) {            // charcoal (dry media: see dryGLSL at the end of this file)
    a = dryCharcoal(st, ink, sf);
  } else if (brush == 6) {            // wax crayon (dry media: see dryGLSL at the end of this file)
    a = dryCrayon(st, ink, sf);
  } else if (brush == 7) {            // marker: alcohol dye through a felt nib
    // Flat, saturated, translucent dye. The felt lays it in lanes: the nib's fibres wear into
    // streaks that run along the stroke (broad bands and fine ones, a fraction of the nib wide), a
    // thicker or thinner dye film (density, not coverage: the paper is covered all the same). The
    // solvent carries dye past the nib's contact into the sheet: a soft fringe of the same hue at
    // ~60% of the core's density, fading out over 0.1-0.3 mm on a thirsty sheet and much less on a
    // sized one; and it carries dye to the edge as it flashes off, a slightly darker outline. Where
    // the nib rests (the line's two ends) it floods: a darker blot; where the hand really stops
    // along the line, the simulation's pool, smooth and darker (dye layered on dye).
    float pB = max(1.8, 0.45 * hUT), pF = max(0.7, 0.18 * hUT);
    vec2 band = vnA(vec2(sU / max(60.0, 6.0 * hUT) + sd0, across / pB), pB * uU);
    vec2 fel = vnA(vec2(sU / max(30.0, 4.0 * hUT) + sd0 + 9.0, across / pF), pF * uU);
    float dens = 1.0 + 0.6 * (band.x - 0.5) + 0.36 * (fel.x - 0.5);
    float core = edgeCov(hw, dist, 0.35 * uU) * 0.97;
    // the dye-rich outline: a band along the edge, box-filtered over the pixel (the middle gives up
    // what the rim gains, so the line's dye stays; at preview the edge pixels come out darker)
    float ringK = smoothstep(1.0, 2.2, hUT);
    float rimW = clamp(0.25 * hUT, 0.45, 0.9) * uU;
    float inner = clamp(hw - rimW - dP + 0.5, 0.0, 1.0);
    float c0 = clamp(hw - dP + 0.5, 0.0, 1.0);
    float rimShare = clamp((c0 - inner) / max(c0, 1e-3), 0.0, 1.0) * ringK;
    float dR = dens * (1.0 + 0.22 * ringK), dI = dens * (1.0 - 0.22 * ringK * rimW / max(hw - rimW, rimW));
    a = core;
    // the bleed fringe (sheet pass only: the liquid itself stays the nib's, for the simulation)
    float fringe = 0.0;
    if (uPass == 0) {
      float fwU = 0.35 + 3.2 * uPaperAbsorb * (1.0 - uPaperSizing);  // U: 0.15 mm on sized sheets .. 0.3 on kraft
      float fw = max(min(fwU * uU, (uSpread - 1.0) * hw + 0.5), 1e-3); // (inside the stroke's footprint)
      // its density falls linearly from the nib's TRUE edge to fw beyond it; box-filtered over this
      // pixel's width across the line (exact, so a preview holds the fringe a 4K render does). The
      // renderer fades a sub-pixel line by its true width (thin); the fringe has a paper width of
      // its own, so it is divided by that here and keeps its ink at preview size.
      float hwT = st.hU * uU, thin = clamp(hwT / hw, 0.05, 1.0);
      float o = dist - hwT;
      vec2 x = clamp(vec2(o - 0.5, o + 0.5), 0.0, fw);
      fringe = 0.62 * ((x.y - x.y * x.y / (2.0 * fw)) - (x.x - x.x * x.x / (2.0 * fw)));
      a = thin < 1.0 ? core + fringe / thin : min(1.0, core + fringe);
    }
    // the nib at rest where it lands and lifts: more dye per area
    float rest = endDot(st, 1.12);
    a = max(a, rest * 0.97);
    if (uCover == 0) {
      vec3 k0 = max(ink, vec3(1e-3));
      vec3 t = mix(pow(k0, vec3(dI)), pow(k0, vec3(dR)), rimShare);
      // pixels past the nib's edge carry the fringe's colour (a shade thinner), the blot a deeper one
      float fr = clamp((a - core) / max(a, 1e-3), 0.0, 1.0);
      t = mix(t, pow(k0, vec3(0.85 * dens)), fr);
      ink = mix(t, pow(k0, vec3(dens + 0.45)), rest);
    }
    // a thin, even film of solvent, fed faster than the nib moves where it pauses
    sf.sheen = 0.05 * min(a, 1.0);
    sf.wet = (0.8 + 0.2 * fel.x) * (1.0 + 0.6 * rest);
  } else if (brush == 8) {            // chalk (dry media: see dryGLSL at the end of this file)
    a = dryChalk(st, ink, sf);
  } else if (brush == 9) {            // neon (dry media: see dryGLSL at the end of this file)
    a = dryNeon(st, ink, sf);
  } else if (brush == 11) {           // watercolour: a loaded round brush laying tinted water
    // The brush decides where the water goes, how much, and how much pigment it carries. The wet
    // simulation (js/wetsim.js) then moves nearly all of the pigment (wet.mobile): it spreads,
    // runs wet into wet, pools where the brush lingers, dries to a darker rim, settles into the
    // valleys (granulation) and blooms where fresh water reaches a drying wash.
    // The load: the painter dips every ~130 mm of line. A fresh brush floods (its bead of water
    // reaches past the hairs), a spent one drags and skips over the tooth. Each dip picks up the
    // pan unevenly, so the pigment strength changes from one dip to the next.
    float cyc = sU / 650.0 + 0.45 * vnoise(vec2(sU / 230.0, sd0 + 83.0));
    float dip = floor(cyc), since = fract(cyc);
    float load = clamp(0.3 + 0.9 * smoothstep(0.0, 0.8, tone) - 0.55 * pow(since, 1.5) * (1.0 - 0.5 * tone), 0.0, 1.0);
    float conc = 0.72 + 0.56 * hash21(vec2(dip, sd0 + 91.0));
    // the hairs: a ragged, hair-driven edge and faint bristle tracks
    float rc = max(2.5, 0.6 * hUT);
    vec2 rag = vnA(vec2(sU / rc, side * 3.3 + sd0), rc * uU);
    float hwE = hw * (0.9 + 0.2 * rag.x);
    float pitch = max(1.2, 0.2 * hUT);
    vec2 bri = vnA(vec2(sU / (30.0 + 6.0 * pitch) + sd0, across / pitch), pitch * uU);
    // a spent brush only touches the tooth tops (dry-brush sparkle), its flanks first
    vec3 t = tooth(P, 1.2);
    // (the tip of a fine line is always wet: only strokes a few tooth grains wide can skip)
    float dryB = (1.0 - smoothstep(0.08, 0.45, load)) * smoothstep(1.2, 3.0, hUT);
    float skip = mix(1.0, over(t.x, t.y, 0.3 + 0.35 * smoothstep(0.3, 1.0, abs(st.vs)), 0.03), dryB);
    float body = (0.62 + 0.3 * tone) * conc;
    a = edgeCov(hwE, dist, max(0.8 * uU, 0.2 * hw)) * skip * body * (0.9 + 0.2 * bri.x);
    sf.wet = (0.35 + 0.9 * load) / conc * (0.85 + 0.3 * bri.x);
    if (uPass == 1) {
      // the bead of a loaded brush: water past the hairs, carrying the same pigment spread thinner
      float kW = 1.0 + 0.45 * load;
      float bead = edgeCov(hwE * kW, dist, max(0.8 * uU, 0.3 * hw)) * skip;
      a = max(a, bead * body / kW);
      sf.wet *= kW;
    }
  } else {                            // 10 gold (dry media: see dryGLSL at the end of this file)
    a = dryGold(st, ink, sf);
  }
  return a;
}
`;

// ------------------------------------------------------------------------------------------------
// Dry media: pencil (4), ballpoint (1), charcoal (5), wax crayon (6), chalk (8), neon (9), gold (10).
// A function declaration, so it is hoisted and BRUSH_GLSL above can splice it in before
// brushDeposit, whose branches for these media only call the functions below.
//
// Scale. A preview pixel (~0.2 mm of the 200 mm sheet) is about one tooth grain across, so a photo
// of the real sheet at that size, and a box-downsampled 4K export, still shows the grain as
// pixel-to-pixel speckle: every pixel averages its own handful of grains. The dry media therefore
// sample the tooth finer than the pixel (dryTooth) instead of replacing it by its mean; the
// thresholds carry the spread that finer sample still hides, so a few pixels together hold the same
// deposit as before and previews and exports keep the same tone. Discrete particles (dust, crumbs)
// are box-filtered with their area kept, so a preview shows specks where it used to show a haze.
function dryGLSL() {
  return /* glsl */`
// ---- dry-media helpers (pencil, ballpoint, charcoal, crayon, chalk, neon, gold)
// The tooth sampled bias mip levels finer than the pixel (see above): (height, hidden spread).
// s < 1 magnifies it by 1/s about the sheet's corner, for strokes far wider than any real tool
// (the app's tool chips draw a 20 mm band: there the grain is shown as if through a loupe).
vec2 dryTooth(vec2 P, float bias, float s) { return grainAt(P * s, log2(s) - bias).xy; }
// Loupe factor for a stroke of true half-width hUT paper units: 1 for every realistic width.
float dryMag(float hUT) { return min(1.0, 8.0 / max(hUT, 1e-3)); }
// The tooth at two scales: x = fine height (as dryTooth), y = its hidden spread, z = the local mean
// over ~featU paper units (the dome or bump the grain sits on), w = the spread of the fine height
// about that mean. Pits and peaks judged against their surroundings are small and evenly strewn,
// not the paper's big valleys.
vec4 dryGrain(vec2 P, float featU, float bias, float s) {
  vec3 f = grainAt(P * s, log2(s) - bias);
  vec3 c = grainAt(P * s, log2(s) + max(0.0, log2(0.5 * featU * uU / s)));
  return vec4(f.x, f.y, c.x, sqrt(max(c.y * c.y - f.y * f.y, 1e-4)));
}
// Value noise on a lattice turned off the pixel grid (no moire with it) and shown down to ~1 px
// cells, where vnA fades from 2 px: the particle-scale clumping of powders, which a preview keeps.
vec2 dryNoise(vec2 p, float cellPx) {
  float k = clamp(cellPx - 0.5, 0.0, 1.0);
  return vec2(mix(0.5, vnoise(mat2(0.8, -0.6, 0.6, 0.8) * p + 3.7), k), 0.214 * sqrt(1.0 - k * k));
}
// Streaks along the stroke (a stick's or a lead's worn face dragged over the tooth): value noise
// in the segment's own frame, pU paper units across and aspect times longer along, shown down to
// ~1-px cells like dryNoise (a preview keeps its drag texture, correlated along the stroke).
// Returns (value, hidden spread).
// Value noise is not stationary across its lattice: on a lattice line it has its full spread, half
// way between two it is an average of them with only ~0.71 of it. Across a stroke those lines sit
// at fixed offsets from the centre line all along it (a 0.5 mm lead is two streak cells wide), so
// thresholding the streaks against a deposit level made bands parallel to the line: dark rails at
// the edges around a paler core. The across interpolation's own spread is divided out (scaled to
// the mean spread over a cell, so tone and the hidden spread below stay as they were).
vec2 dryStreak(float sU, float across, float pU, float aspect, float salt) {
  float k = clamp(pU * uU - 0.5, 0.0, 1.0);
  // (the rows also drift slowly across the line along its length, as the tool turns in the hand,
  // so no row keeps one offset from the centre line for the whole drawing)
  float ya = across / pU + 0.37 * salt + 2.0 * vnoise(vec2(sU / (3.0 * aspect * pU) + 0.61 * salt, 7.3));
  float fa = fract(ya), wa = fa * fa * (3.0 - 2.0 * fa);
  float nrmA = 0.862 * inversesqrt(1.0 - 2.0 * wa + 2.0 * wa * wa);
  float v = 0.5 + (vnoise(vec2(sU / (aspect * pU) + salt, ya)) - 0.5) * nrmA;
  return vec2(mix(0.5, v, k), 0.214 * sqrt(1.0 - k * k));
}
vec4 dryHash4(vec2 c, float salt) {
  uint h = hashU(uvec2(ivec2(floor(c)) + 16384) + uvec2(uint(salt) * 2654435u + 7u, uint(salt) * 40503u + 101u));
  return vec4(uvec4(h, h >> 8u, h >> 16u, h >> 24u) & 255u) / 255.0;
}
// Loose particles around a stroke: charcoal and chalk dust, wax crumbs. One candidate per cell of
// cellU paper units, jittered, kept with probability dens, falling from d0 to reach half-widths
// between its centre and THIS segment (so their number scales with the line like any halo, and
// MAX blending keeps the nearest segment's verdict on a shared particle). fall > 0 lets them reach
// further below the line (dust drifts down an upright board). Sizes follow a steep power law
// (mostly tiny grains, now and then a bigger crumb: rU * 0.3..2.1 U) and each is an irregular,
// elongated lump at a random angle; box-filtered with a 0.5 px floor and their area kept (a
// preview shows faint specks, not a haze), and kept inside the stroke's footprint (hw * uSpread).
// Returns (coverage, the particle's own random 0..1 for its tone).
vec2 dryParticles(vec2 P, float hw, float cellU, float salt, float rU, float dens, float d0, float reach, float fall) {
  vec2 ci = floor(P / (uU * cellU));
  vec2 ba = vP1 - vP0;
  float bb = max(dot(ba, ba), 1e-8);
  float maxR = max(0.5, (uSpread - reach * (1.0 + fall)) * hw);
  vec2 best = vec2(0.0);
  // deep inside the stroke the medium itself covers the sheet: skip the search (the cost)
  vec2 pp = P - vP0;
  if (length(pp - ba * clamp(dot(pp, ba) / bb, 0.0, 1.0)) < 0.3 * hw) return best;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = ci + vec2(float(x), float(y));
    vec4 r = dryHash4(c, salt);
    vec2 cp = (c + 0.1 + 0.8 * r.xy) * cellU * uU;                  // centre, paper px
    vec2 pa = cp - vP0;
    // a particle belongs to the segment it lies beside (past this segment's ends it lies beside
    // the next one, maybe deep inside the stroke there)
    float hs = dot(pa, ba) / bb;
    if (hs < 0.0 || hs > 1.0) continue;
    vec2 qd = pa - ba * hs;
    if (qd.y > 0.0) qd.y /= 1.0 + fall;
    float dh = length(qd) / hw;
    float p = dens * smoothstep(0.55, 0.85, dh) * (1.0 - smoothstep(d0, reach, dh));   // at and beyond the edge
    if (r.z >= p) continue;
    vec4 r2 = dryHash4(c, salt + 3.0);
    float rad = min(rU * uU * (0.3 + 1.8 * r.w * r.w * r.w), 0.5 * maxR);
    // an irregular lump: an ellipse (aspect 1..2.2) at a random angle, its rim lobed
    vec2 d = P - cp;
    float an = 6.2832 * r2.x, ca = cos(an), sa = sin(an);
    float asp = 1.0 + 1.2 * r2.y;
    vec2 e = vec2(ca * d.x + sa * d.y, (-sa * d.x + ca * d.y) * asp);
    float th = atan(e.y, e.x);
    // lobed, with a crumbly rim (the finer lobes)
    float dl = length(e) / (1.0 + 0.14 * sin(2.0 * th + 6.2832 * r2.z) + 0.1 * sin(3.0 * th + 9.0 * r2.w)
                            + 0.07 * sin(5.0 * th + 17.0 * r2.x) + 0.05 * sin(8.0 * th + 23.0 * r2.y));
    float rr = rad * sqrt(asp);                                      // same area as the disc
    float R = max(rr, 0.5);
    float cov = clamp(R - dl + 0.5, 0.0, 1.0) * rr * rr / (R * R + 0.0833);
    if (cov > best.x) best = vec2(cov, fract(r.w * 7.13 + r.z));
  }
  return best;
}
// Grit in a stick (charcoal, chalk): tracks every pS paper units across the stroke; an 18-U stretch
// of a track holds a mark with probability p, of random length and offset. Returns
// (pale scrape, dark compressed streak), each 0..1 at resolved sizes and their means where the
// marks are finer than ~2 px (so every size carries the same ink).
vec2 dryGrit(float sU, float across, float pS, float wS, float p, float salt) {
  const float Ls = 18.0;
  float kb = floor(across / pS);
  float hb = hash21(vec2(kb, salt));
  float cS = floor(sU / Ls + hb);
  float rs = hash21(vec2(kb * 7.0 + cS, salt + 2.0));
  float loc = (sU / Ls + hb - cS) * Ls;
  // a grain bites in, ploughs 1-3 mm along the stroke (in its frame, so the mark follows the
  // line) and lifts off: tapered at both ends, its sides ragged where it skipped over the tooth
  float sl = (0.3 + 0.6 * fract(rs * 91.0)) * Ls, st0 = fract(rs * 37.0) * (Ls - sl);
  float t = (loc - st0) / sl;
  float taper = sqrt(max(0.0, sin(3.1416 * clamp(t, 0.0, 1.0)))) * step(0.0, t) * step(t, 1.0);
  float wv = wS * (0.25 + 0.75 * taper) * (0.65 + 0.7 * vnoise(vec2(sU / 0.7, kb * 5.7 + salt + 1.0)));
  float off = (kb + 0.5) * pS + (fract(rs * 13.0) - 0.5) * 0.5 * pS
            + (vnoise(vec2(sU / 1.5, kb * 3.1 + salt)) - 0.5) * 0.5 * wS;
  float mark = step(rs, p) * step(0.05, taper) * (1.0 - smoothstep(0.35 * wv, wv, abs(across - off)));
  float pale = step(fract(rs * 5.3), 0.55);
  float k = aa(2.0 * wS * uU);
  // (mean of a mark over its track: 0.6 of the stretch x 1.35 wv across, wv ~0.9 wS on average)
  float mean = p * 0.73 * wS / pS;
  return mix(vec2(0.55, 0.45) * mean, vec2(pale, 1.0 - pale) * mark, k);
}

// Pencil: graphite flakes sheared off the lead onto the tooth tops. A light touch grazes only the
// peaks (a speckled grey with the paper's pits white between); pressure pushes graphite into the
// pits and flattens the peaks. It never reaches black: graphite is a grey, metallic film whose
// packed flakes shine at glancing light (the composite's 'graphite' lobe on sf.sheen).
float dryPencil(Stroke st, inout vec3 ink, inout Surface sf) {
  vec3 fr = segFrame(st);
  float sU = fr.x / uU, across = fr.y / uU, hUT = fr.z / uU;
  float hw = st.hw, hU = hw / uU, tone = st.tone, sd0 = uSeed * 7.31;
  // pressure: the photo's darkness, wandering with the hand and easing off a little on the
  // lead's flank
  vec2 hand = vnA(vec2(sU / 40.0 + sd0 + 5.0, 1.5), 40.0 * uU);
  float press = tone * (0.92 + 0.16 * hand.x) * mix(0.93, 1.0 - 0.25 * smoothstep(0.4, 1.0, st.v), aa(hw * 2.0));
  float s = dryMag(hUT);
  // the tooth, sampled half a mip finer than the pixel: a preview shows it correlated over ~1.5 px
  vec4 g = dryGrain(st.P, 1.6, 0.5, s);
  float rel = clamp((g.x - g.z) / g.w, -2.5, 2.5);
  // The lead's worn facet drags graphite in striations along the stroke: a set ~0.25 mm apart
  // (a preview's streaky texture) and a finer one ~0.08 mm apart (the film's close-ups, 4K).
  float pc = max(1.25, 0.3 * hU), pf = max(0.4, 0.1 * hU);
  vec2 sk = dryStreak(sU, across, pc, 5.0, sd0 + 3.0);
  vec2 sk2 = dryStreak(sU, across, pf, 8.0, sd0 + 9.0);
  // graphite on the tops the lead reaches (the paper's domes too: a light touch skips their
  // valleys); pressure pushes it into the valleys and packs it (soft graphite goes a deep, dense
  // grey, never black)
  float m = 0.4 * g.x + 0.3 * sk.x + 0.3 * sk2.x;
  float dep = over(m, length(vec3(0.4 * g.y, 0.3 * sk.y, 0.3 * sk2.y)), 0.61 - 0.55 * press, 0.015);
  float fill = dep * (0.54 + 0.42 * press) + (1.0 - dep) * (0.07 + 0.72 * press * press);
  // even packed graphite keeps the facet's fine striations (zero mean, resolved only up close)
  fill *= 1.0 + 0.5 * (sk2.x - 0.5);
  // the tooth's own pits (a sigma below their surroundings) stay pale until pressure fills them:
  // small white specks strewn through the grey (linear where unresolved)
  float pit = 1.0 - over(g.x, g.y, g.z - g.w, 0.01);
  fill *= 1.0 - 0.5 * pit * (1.0 - 0.7 * press);
  // the lead's rim meets the tooth tops first: a ragged edge at the grain's own scale
  float lead = edgeCov(hw * (1.0 + 0.1 * rel * aa(hw * 2.0)), st.dist, 0.45 * uU);
  float a = lead * fill;
  // hard pressure dents the sheet under the lead; packed flakes on the flattened tops shine.
  // The lead's tip is round, so the dent is a shallow rounded trough, deepest on the centre line:
  // a flat-bottomed dent put all its slope in two walls at the rim, which the light turned into a
  // pair of dark and bright rails around a paler core (an outlined tube, not a pencil line).
  // (st.dist / hw: the drawn width, so a line widened to 1 px keeps its dent's mean depth)
  float rr = clamp(st.dist / max(hw, 1e-3), 0.0, 1.0);
  sf.groove = 0.3 * press * press * lead * (1.0 - rr * rr);
  sf.sheen = lead * dep * (0.2 + 0.8 * press * press);
  // burnished graphite: where it is packed hard, patches of the sheet turn silvery. Graphite only:
  // coloured leads and photo colours are wax-bound and never shine so.
  float chroma = max(ink.r, max(ink.g, ink.b)) - min(ink.r, min(ink.g, ink.b));
  if (uPhotoColor == 0 && chroma < 0.06 && lum3(ink) < 0.5) {
    vec2 bur = vnA(st.P / uU / 40.0 + sd0 + 21.0, 40.0 * uU);
    ink = mix(ink, vec3(0.44, 0.45, 0.49), 0.35 * dep * press * smoothstep(0.52, 0.8, bur.x));
  }
  return a;
}

// Charcoal: coarse, loosely bound carbon. The stick's face breaks off on the tooth tops (speckled,
// the paper's pits white between); pressure crushes it into the pits too, a deep, velvety black
// that is completely matte (no sf.sheen: the composite's 'chalk' material has no lobe). Its contact
// edge is broken and crumbly, not soft. Grit in the stick ploughs pale scrapes along the stroke
// and harder bits press dark compressed streaks; loose dust falls around the line as a faint veil
// caught on the tooth tops and as scattered specks.
float dryCharcoal(Stroke st, inout vec3 ink, inout Surface sf) {
  vec3 fr = segFrame(st);
  float sU = fr.x / uU, across = fr.y / uU, hUT = fr.z / uU;
  float hw = st.hw, dist = st.dist, hU = hw / uU, tone = st.tone, sd0 = uSeed * 7.31;
  float s = dryMag(hUT);
  // the stick's broken edge wanders at two scales along each side
  float rc = max(2.5, 0.6 * hU);
  vec2 rag = vnA(vec2(sU / rc, st.side * 5.0 + sd0), rc * uU);
  vec2 rag2 = vnA(vec2(sU / (0.3 * rc), st.side * 7.0 + sd0 + 2.0), 0.3 * rc * uU);
  float hwE = hw * (0.88 + 0.2 * rag.x + 0.12 * (rag2.x - 0.5));
  vec4 g = dryGrain(st.P, 2.4, 1.2, s);
  // The rim breaks along the tooth: toward the edge the stick only grazes, so only the peaks take
  // carbon and the valleys stay paper (the threshold climbs from a sigma below the local mean
  // inside to two above at the rim). A smooth edge plus a soft halo read as an airbrushed tube.
  float edgeT = smoothstep(0.62, 1.1, dist / max(hwE, 1e-3));
  float peaks = over(g.x, g.y, g.z + (2.2 * edgeT - 1.0) * g.w, 0.02);
  float core = edgeCov(hwE * 1.1, dist, 0.5 * uU) * mix(1.0, peaks, edgeT);
  // Carbon is a neutral, faintly cool black: the vine and compressed blacks (near-neutral, dark)
  // lose the warm cast that read brown-olive over a cream sheet. Sanguine and white keep theirs.
  if (uPhotoColor == 0) {
    float chroma = max(ink.r, max(ink.g, ink.b)) - min(ink.r, min(ink.g, ink.b));
    if (chroma < 0.06 && lum3(ink) < 0.25) ink = mix(ink, vec3(lum3(ink)) * vec3(0.96, 0.99, 1.06), 0.85);
  }
  // pressure: the photo's darkness, lighter toward the stick's flank (its mean where unresolved)
  float press = tone * mix(0.85, 1.0 - 0.5 * smoothstep(0.4, 1.0, st.v), aa(hw * 2.0));
  float body = 0.0;
  vec2 gr = vec2(0.0);
  float bite = smoothstep(0.3, 0.8, tone);
  if (core > 0.0) {                   // (the halo quad around it only takes dust: skip the cost)
    // The carbon breaks off on the tooth peaks (the paper decides where), in drag streaks where
    // the stick's face is uneven, with a little clumping of its own particles (~0.25 mm)
    vec2 cl = dryNoise(st.P * s / (1.3 * uU) + sd0 + 31.0, 1.3 * uU / s);
    vec2 fp = dryNoise(st.P * s / (0.25 * uU) + sd0 + 17.0, 0.25 * uU / s);    // its finest grains
    vec2 sk = dryStreak(sU, across, max(0.9, 0.25 * hU), 5.0, sd0 + 6.0);
    float m = 0.56 * g.x + 0.1 * cl.x + 0.2 * sk.x + 0.14 * fp.x;
    float dep = overV(m, 0.56 * g.y, length(vec3(0.1 * cl.y, 0.2 * sk.y, 0.14 * fp.y)), 0.7 - 0.62 * press, 0.02);
    body = dep * (0.6 + 0.38 * press) + (1.0 - dep) * (0.05 + 0.55 * press * press);
    // the pits (a sigma below their surroundings) hold out longest: white specks in the black
    float pit = 1.0 - over(g.x, g.y, g.z - g.w, 0.01);
    body *= 1.0 - 0.6 * pit * (1.0 - 0.6 * press);
    // grit, only where the stick bites (a light touch glides over it)
    gr = dryGrit(sU, across, max(0.8, 0.12 * hU), 0.24, 0.24, sd0 + 71.0);
    body = body * (1.0 - 0.75 * bite * gr.x) + (1.0 - body) * 0.6 * bite * gr.y;
  }
  float a = core * body;
  // The dust falls where the stick's flank rubbed: a right hand tilts the stick toward the lower
  // right of the sheet (paper px: y down), so that side of every stroke gets a sparse veil and the
  // crumbs, the other side almost none. A halo even on both sides read as airbrush glow.
  vec2 nrm = vec2(-st.dir.y, st.dir.x) * (fr.y >= 0.0 ? 1.0 : -1.0);
  float flank = smoothstep(-0.3, 0.6, dot(nrm, vec2(0.6, 0.8)));
  // dust: a thin veil on the tooth tops beside the stroke, clouded, denser where it is dark ...
  float hW = (0.5 + 0.5 * flank) * hw;
  float ring = max(0.0, edgeCov(hwE + 0.5 * hW, dist, hW) - core);
  float mc = max(6.0, 1.2 * hU);
  if (ring > 0.0) {
    vec2 sm = vnA(st.P / uU / mc + sd0 + 37.0, mc * uU);
    a += ring * (0.02 + 0.13 * tone * tone) * mix(0.15, 0.7, flank) * (0.2 + 1.6 * sm.x)
       * (0.2 + 1.6 * over(g.x, g.y, g.z + 0.5 * g.w, 0.02));
  }
  // ... and loose specks strewn beside it: flat, irregular crumbs of the stick, as black and
  // matte as the stroke itself (they lie on the sheet: no relief of their own)
  vec2 pt = dryParticles(st.P, hw, 1.3, sd0 + 5.0, 0.3, (0.03 + 0.14 * tone) * mix(0.2, 1.0, flank), 1.0, uSpread - 0.4, 0.0);
  a = max(a, pt.x * (0.62 + 0.3 * pt.y));
  // powder stands on the sheet; the scrapes are dented into it (shallow: they read under a raking
  // light, not as a lit gutter)
  sf.raised = 0.14 * core * body;
  sf.groove = 0.22 * gr.x * bite * core;
  return clamp(a, 0.0, 1.0);
}

// Wax crayon: pigment in paraffin. The wax only catches the tooth tops, so the paper shows in the
// pits even under pressure; it builds up in a layer that stands proud of the sheet with a broad,
// soft gloss (sf.raised, sf.sheen: the composite's 'wax' lobe, which also lets the wax hide a
// coloured sheet like the semi-opaque layer it is). The worn tip leaves a ragged, lumpy edge and
// striations; at a light touch a thin stroke skips into waxy dashes; where the line turns hard or
// the tip lingers, crumbs of wax break off beside it.
float dryCrayon(Stroke st, inout vec3 ink, inout Surface sf) {
  vec3 fr = segFrame(st);
  float sU = fr.x / uU, across = fr.y / uU, hUT = fr.z / uU;
  float hw = st.hw, dist = st.dist, hU = hw / uU, tone = st.tone, sd0 = uSeed * 7.31;
  float s = dryMag(hUT);
  vec4 g = dryGrain(st.P, 2.0, 1.0, s);
  // the worn tip drags the wax in striations along the stroke (~0.3 mm apart, and a finer set)
  float pc = max(1.4, 0.25 * hU), pf = max(0.5, 0.09 * hU);
  vec2 sk = dryStreak(sU, across, pc, 6.0, sd0 + 4.0);
  vec2 sk2 = dryStreak(sU, across, pf, 5.0, sd0 + 11.0);
  float rc = max(1.8, 0.45 * hU);
  vec2 rag = vnA(vec2(sU / rc, st.side * 4.0 + sd0), rc * uU);
  vec2 rag2 = vnA(vec2(sU / (4.0 * rc), st.side * 9.0 + sd0), 4.0 * rc * uU);
  float hwE = hw * (0.84 + 0.2 * rag.x + 0.12 * rag2.x);
  float edge = clamp(hwE - dist + 0.5, 0.0, 1.0);
  // skipping: a light touch lifts the crayon off the sheet in places, and a thin stroke breaks
  // into dashes of wax with only a faint trace between (the one line stays readable)
  float Ld = max(4.0, 1.5 * hU);
  vec2 dash = vnA(vec2(sU / Ld + sd0 + 9.0, 2.5), Ld * uU);
  float thinK = 1.0 - smoothstep(0.8, 3.0, hUT);
  float touch = mix(0.25, 1.0, overV(dash.x, 0.0, dash.y, thinK * (0.62 - 0.6 * tone), 0.03));
  // A broad tip spreads the same hand force over more paper (a 4 mm stick has some 16x the contact
  // of a sharpened point), so it presses less per area and rides the tooth tops: the paper's pits
  // show through as a fine white speckle, the way a real crayon's side stroke looks. Only strokes
  // wider than ~2.5 mm feel it.
  float broad = smoothstep(6.0, 14.0, hUT);
  float press = tone * touch * (1.0 - 0.4 * broad);
  // Wax on the tooth tops and raised fibres it reaches, dragged into striations; pressure smears
  // it down into the valleys (a heavy hand leaves a nearly solid, waxy layer), and the tooth's
  // own pits stay paper longest.
  // Skip over the tooth is crayon's signature at every width and pressure: the wax film is too
  // stiff to follow the paper down, so the tooth decides most of where it lands (a larger weight
  // than the striations) and the valleys below the tops the tip rides stay paper, a heavy hand
  // only lowering that line a little. (Most of the skip goes through this one threshold, whose
  // hidden spread keeps previews and exports on the same tone; a second, correlated threshold
  // multiplied in would not average the same.)
  float m = 0.55 * g.x + 0.27 * sk.x + 0.18 * sk2.x;
  float wax = overV(m, 0.55 * g.y, length(vec2(0.27 * sk.y, 0.18 * sk2.y)), 0.66 - 0.42 * press, 0.02);
  float pit = 1.0 - over(g.x, g.y, g.z - (0.55 + 0.45 * press) * g.w, 0.02);
  // (the layer is thicker along the striations the tip drags: zero mean, shown up close)
  wax *= (1.0 - 0.5 * pit) * (1.0 + 0.3 * (sk.x - 0.5) + 0.5 * (sk2.x - 0.5));
  wax *= mix(1.0 - 0.25 * 0.225, 1.0 - 0.25 * smoothstep(0.55, 1.0, st.v), aa(hw * 2.0));
  float a = edge * min(wax * (0.66 + 0.34 * touch), 0.97);
  // crumbs: where the line turns hard (a maze corner, a wander's hairpin) or the tip lingers,
  // flakes of wax break off at its side; now and then anywhere
  float turnK = clamp(abs(st.curv) * hUT * 1.5 + 0.6 * (st.dwell - 1.0), 0.0, 1.0);
  vec2 cr = dryParticles(st.P, hw, 1.4, sd0 + 61.0, 0.6, (0.03 + 0.35 * turnK) * (0.4 + 0.6 * tone), 0.8, uSpread - 0.3, 0.0);
  float crumb = cr.x * (0.75 + 0.2 * cr.y);
  a = max(a, crumb);
  // The wax film is thin and follows the tooth it sits on (the paper's own relief lights it), so
  // it casts no bevel grain by grain: only the stroke as a whole stands a little proud (a bevel at
  // the wax/paper boundary, its ragged edge), a crumb more. It shines where pressure smeared it
  // flat.
  // (the wax thins out toward its ragged edge over ~0.1 mm instead of stepping up within a pixel:
  // up close a one-texel step read as a cut-paper outline; at preview size it is the same step)
  // Crayon wax is a matte film tens of microns thick: it stands barely proud of the sheet and has
  // only a faint satin where pressure smeared it flat. A thick bevel and a broad gloss made it
  // read as icing or extruded gel under the loupe.
  float edgeR = clamp((hwE - dist) / max(1.0, 0.5 * uU) + 0.5, 0.0, 1.0);
  sf.raised = 0.07 * edgeR * edge * (0.4 + 0.6 * press) + 0.25 * crumb;
  sf.sheen = a * (0.04 + 0.1 * press);
  return a;
}

// Chalk: soft calcium carbonate powder on a board. The stick's face drags powder off in streaks
// along the stroke, caught on the board's tooth (a broken, streaky line with the dark board
// showing through, more solid under pressure), a thin layer that lets the board glimmer through,
// crumbling at the edge; it sheds dust finer than any pixel: a haze around the stroke that drifts
// below it (the board stands upright). A powder layer is utterly matte and too thin to cast
// bevels.
float dryChalk(Stroke st, inout vec3 ink, inout Surface sf) {
  vec3 fr = segFrame(st);
  float sU = fr.x / uU, across = fr.y / uU, hUT = fr.z / uU;
  float hw = st.hw, dist = st.dist, hU = hw / uU, tone = st.tone, sd0 = uSeed * 7.31;
  float s = dryMag(hUT);
  vec4 g = dryGrain(st.P, 2.0, 1.5, s);
  // a crumbly edge at two scales
  float rc = max(2.0, 0.5 * hU);
  vec2 rag = vnA(vec2(sU / rc, st.side * 4.0 + sd0), rc * uU);
  vec2 rag2 = vnA(vec2(sU / (0.3 * rc), st.side * 6.0 + sd0 + 1.0), 0.3 * rc * uU);
  float hwE = hw * (0.86 + 0.24 * rag.x + 0.12 * (rag2.x - 0.5));
  float edge = clamp(hwE - dist + 0.5, 0.0, 1.0);
  float body = 0.0;
  if (edge > 0.0) {                   // (the wide dust quad around it only takes dust: skip the cost)
    // The stick's face scrapes powder off along the stroke: drag streaks 4-6x longer than they
    // are wide, at two scales (the stick's worn ridges, ~0.25 mm apart, and its finest grit,
    // ~0.07 mm), in the segment's own frame so they follow the line. Where they are finer than
    // the pixel their spread goes into the threshold (overV) and a preview keeps the tone.
    float ps = max(1.2, 0.3 * hU), pf = max(0.35, 0.09 * hU);
    vec2 sk = vnA(vec2(sU / (5.0 * ps) + sd0, across / ps), ps * uU);
    vec2 fg = vnA(vec2(sU / (6.0 * pf) + sd0 + 13.0, across / pf + 7.0), pf * uU);
    float press = tone * mix(0.85, 1.0 - 0.5 * smoothstep(0.4, 1.0, st.v), aa(hw * 2.0));
    // (the board's tooth only nudges it: its valleys would print as a web of dark lines), and
    // the powder's own grit (~0.06 mm) breaks the streaks' soft edges into specks
    vec2 gr = dryNoise(st.P * s / (0.3 * uU) + sd0 + 51.0, 0.3 * uU / s);
    float m = 0.2 * g.x + 0.47 * sk.x + 0.33 * fg.x + 0.16 * (gr.x - 0.5);
    float dep = overV(m, 0.2 * g.y, length(vec3(0.47 * sk.y, 0.33 * fg.y, 0.16 * gr.y)), 0.64 - 0.4 * press, 0.03);
    // Powder is not paint: a thin layer lets the board through, thicker where the stick pressed
    // and where a streak piled it (opacity ~0.5-0.9, linear in the streaks so it averages out).
    float thick = clamp(0.62 + 0.22 * press + 0.3 * (sk.x - 0.5) + 0.2 * (fg.x - 0.5), 0.35, 0.95);
    // a little powder is ground into the board even between the streaks
    body = edge * (dep * thick + (1.0 - dep) * 0.12 * press);
  }
  // dust haze drifting down: distance to the line with its lower side stretched (x1.55, which
  // keeps it inside the stroke's footprint, spread 3) and its upper side shrunk, so the haze
  // hangs below the stroke
  vec2 ba = vP1 - vP0, pa = st.P - vP0;
  vec2 qv = pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  float dDown = length(vec2(qv.x, qv.y > 0.0 ? qv.y / 1.55 : qv.y * 1.3));
  // (the haze covers the line too, so the union of the segments' capsules has no seams)
  float hW = 0.75 * hw;
  float ring = edgeCov(hwE + 0.5 * hW, dDown, hW);
  float dc = max(3.5, 0.8 * hU);
  float haze = 0.0;
  if (ring > 0.0) {
    // The dust is finer than any pixel (chalk grains are microns): a haze, clouded where the
    // stick shed more, caught a little more on the board's tooth tops, streaked down the board.
    vec2 du = vnA(st.P / uU / dc + sd0 + 57.0, dc * uU);
    vec2 dv = vnA(vec2(st.P.x / uU / 1.2, st.P.y / uU / 6.0) + sd0 + 3.0, 1.2 * uU);
    haze = ring * (0.05 + 0.1 * tone) * (0.3 + 1.4 * du.x) * (0.75 + 0.5 * dv.x) * (0.7 + 0.6 * g.x);
  }
  float a = body + haze * (1.0 - body);
  // A powder layer is ~0.02 mm thick: it casts no bevels grain by grain. Only the stroke as a
  // whole stands a hair proud (its smooth envelope), which a raking light just picks out.
  sf.raised = 0.08 * edge * (0.5 + 0.5 * tone);
  return clamp(a, 0.0, 1.0);
}

// Ballpoint: an oily, dye-laden paste rolled out by a 0.7 mm ball. The ball is pressed into the
// sheet, a rounded groove (it reads under a raking light, and the composite burnishes the tooth
// flat in it); the flow is uneven (the paste loads and starves along the line), light pressure
// misses the pits, and on fast strokes the ball skids, leaving a thinner broken trace. Excess
// paste gathers into blobs (gloops) where the pen touches down, where it lingers, and now and then
// anywhere. Dense dark paste dries with a bronze sheen (the composite's 'oil' material).
float dryBallpoint(Stroke st, inout vec3 ink, inout Surface sf) {
  vec3 fr = segFrame(st);
  float sU = fr.x / uU, across = fr.y / uU, hUT = fr.z / uU;
  float hw = st.hw, hU = hw / uU, tone = st.tone, sd0 = uSeed * 7.31;
  // Ballpoint paste is nearly saturated dye: a firmly drawn 0.2 mm line lets through only ~30% of
  // the light (a 1-px preview line keeps that density too, the renderer fades it by its true
  // width). A light hand lays a thinner film, paler (how biro drawings are shaded). The flow
  // drifts along the line (the ball loads and starves), zero mean.
  vec2 flow = vnA(vec2(sU / 16.0, sd0 + 3.0), 16.0 * uU);
  float dens = 0.66 + 0.31 * smoothstep(0.0, 0.8, tone) + 0.1 * (flow.x - 0.5);
  // Skips: on a fast stroke over the lights the ball slides instead of rolling and leaves a short,
  // clean gap (0.4-1 mm) with only a trace of paste in its groove. One chance per 8-U stretch of
  // line, none where the hand slows down for the darks (that is where the ball is loaded).
  float fast = smoothstep(0.55, 1.0, st.speed) * (1.0 - smoothstep(0.25, 0.65, tone));
  float cS = floor(sU / 8.0);
  float rs = hash21(vec2(cS, sd0 + 23.0));
  float loc = sU - cS * 8.0, g0 = fract(rs * 37.1) * 2.5, gl = 2.0 + 3.0 * fract(rs * 71.3);
  float gap = step(rs, 0.12 * fast) * smoothstep(g0, g0 + 0.5, loc) * (1.0 - smoothstep(g0 + gl - 0.5, g0 + gl, loc));
  // the ball bridges the deepest pits of a rough sheet (small pale specks, zero mean: the pits
  // lose what the tops gain)
  vec3 t = tooth(st.P, 1.0);
  float bite = 1.0 + 0.12 * (1.0 - tone) * (t.z - 0.5) * 2.0;
  // a wide stroke is the ball's passes side by side: faint tracks along it (zero mean)
  float pitch = max(1.25, 0.35 * hU);
  float track = 1.0 + 0.05 * cos(6.2832 * across / pitch) * aa(pitch * uU * 0.5);
  float body = st.cov * min(dens * bite * track, 0.985) * (1.0 - 0.85 * gap);
  // Gloops: paste that gathered on the ball's rim is dropped as a dark blob 1.6-2x the line's
  // width, where the pen touches down, where it lingers (a maze corner, the tight first turns) and
  // now and then along the line (one in twelve 30-U stretches, ~7 cm of line: more read as dirt
  // speckling a dense drawing, not as a pen's occasional blob). A dot is round about a point, so it
  // is measured in the clamped frame (st.sU, radial st.vs): a cap then sees the distance along the
  // path to its end point plus the radius, never less than the true distance, so dots stay round
  // even where a wave turns sharply. The paste is thicker there: deeper colour (Beer-Lambert).
  // (chip-sized strokes, far wider than a ball: a gloop is a modest bulge on the band, grow = the
  // share of the width a gloop adds, and the stretches scale with the band)
  float hG = max(hUT, 0.5 / uU);                                        // (a sub-pixel line: 1 px)
  float grow = mix(0.12, 1.0, dryMag(hUT));
  float Lc = 30.0 * max(1.0, hG / 1.5);
  float cell = floor(st.sU / Lc);
  float r = hash21(vec2(cell, sd0 + 17.0));
  float ds = st.sU - cell * Lc - (4.0 + fract(r * 91.7) * 22.0) * Lc / 30.0;
  float rU = (1.0 + (0.6 + 0.4 * fract(r * 13.1)) * grow) * hG;
  float blob = step(r, 0.085) * clamp((rU - length(vec2(ds, st.vs * hU))) * uU + 0.5, 0.0, 1.0);
  float bS = clamp(((1.0 + 0.8 * grow) * hG - length(vec2(st.sU - 1.4 * hG, st.vs * hU))) * uU + 0.5, 0.0, 1.0);
  blob = max(blob, bS);
  // where the hand lingers (a maze corner, the tight first rings; a wave's crests only a little)
  // the ball keeps feeding: the line swells and darkens
  float dw = smoothstep(0.15, 1.0, st.dwell - 1.0);
  float swell = clamp(hw * (1.0 + 0.35 * grow * dw) - st.dist + 0.5, 0.0, 1.0) * dw;
  float a = max(max(body, 0.985 * blob), 0.985 * swell);
  ink = pow(max(ink, vec3(1e-3)), vec3(1.0 + 0.45 * max(blob, 0.6 * swell)));
  blob = max(blob, 0.6 * swell);
  // the ball's groove: its round profile (its mean pi/4 where unresolved), deeper with pressure
  // (a skipped stretch is still pressed); blobs stand proud and stay glossy, the film dries to a
  // satin whose dye bronzes near the mirror angle where it lies thick (the slow, heavy strokes of
  // the darks, the gloops; the composite's 'oil' material)
  float ball = mix(0.785, sqrt(max(0.0, 1.0 - st.v * st.v)), aa(hw * 2.0));
  sf.groove = 0.42 * ball * st.cov * (0.45 + 0.55 * tone);
  sf.raised = 0.35 * blob;
  sf.sheen = body * (0.15 + 0.6 * tone) + 0.4 * blob;
  return a;
}

// Gold: metallic leaf / ink. A metal has no diffuse colour of its own: what it shows is the room
// it mirrors, so its look is the composite's ('metal' material: dark olive-brown off the mirror
// angle, flashing as the film's light sweeps and its camera tilts). Here only where the metal lies
// and how it stands: the pigment holds its reflectance (the ink colour; a transparent export shows
// just that), with a crisp edge. The film is thin and flat, gently domed where a wide bead of ink
// lies, and its edge lifts a little off the size: a thin lip whose relief the composite lights on
// the side facing the light and shades on the other.
float dryGold(Stroke st, inout vec3 ink, inout Surface sf) {
  vec3 fr = segFrame(st);
  float hw = st.hw, v = st.v, hUT = fr.z / uU, sd0 = uSeed * 7.31;
  float k = aa(hw * 1.5);
  float nz = sqrt(max(0.0, 1.0 - v * v));
  // the lip: a ridge just inside the edge (its mean where unresolved)
  float lip = mix(0.14, smoothstep(0.72, 0.9, v) * (1.0 - smoothstep(0.9, 1.0, v)), aa(hw * 0.4));
  sf.raised = st.cov * (0.2 + 0.25 * mix(0.785, nz, k) + 0.25 * lip);
  sf.sheen = st.cov;
  // Chip-sized strokes (the tool chips' 20 mm band) are far wider than the facets the composite
  // draws in paper units: there the crinkles are shown through a loupe as a patchwork of brighter
  // and duller leaf.
  float s = dryMag(hUT);
  if (s < 0.999) {
    vec2 f = vnA(st.P * s / uU / 3.0 + sd0, 3.0 * uU / s);
    ink *= mix(1.0, 0.55 + 0.9 * f.x, (1.0 - s) * aa(3.0 * uU / s));
  }
  return st.cov;
}

// Neon: a lit gas tube. What the pigment holds is the tube's radiance (the composite scales it up,
// adds the bloom and exposes the sum through a filmic shoulder, 'light' material): the gas glows
// in its own saturated colour, brightest along the tube's axis where the discharge is densest (a
// longer path through the gas), and the axis itself burns white-hot. Radiance is linear, so a
// tube finer than a pixel carries its cross-section's mean (the white core included) and the
// renderer's fade by true width keeps its energy: the whitening survives at preview size.
// Tubes, not bands: they sit a little inside the line so neighbours keep dark seams. The bloom
// is the composite's glow (brush.glow, paper units) and the tube flickers with renderer.setTime.
float dryNeon(Stroke st, inout vec3 ink, inout Surface sf) {
  float hwT = st.hw * 0.86;
  float vT = st.dist / hwT;
  float k = aa(hwT * 2.0);
  // gas: colour x path length (mean pi/4 across); core: white, a third of the width (mean 0.18)
  float gas = mix(0.785, sqrt(max(0.0, 1.0 - vT * vT)), k);
  float core = mix(0.18, 1.0 - smoothstep(0.0, 0.35, vT), k);
  // brighter where the photo is brighter, so the picture reads even with the constant-width wave
  float lum = 0.3 + 0.7 * st.tone;
  vec3 rad = (ink * gas + vec3(1.2 * core) * (0.4 + 0.6 * st.tone)) * lum;
  float cov = clamp(hwT - st.dist + 0.5, 0.0, 1.0);
  // The glass and the lens's halation: a tight glow of the gas's own saturated colour hugging the
  // tube, falling off over ~0.15 mm (paper units, so every size shows the same halo; kept inside
  // the stroke's footprint). MAX blending merges it with the neighbours' like a tube's own light.
  float dU = max(0.0, st.dist - hwT) / uU;
  float reach = ((uSpread - 0.86) * st.hw - 0.5) / uU;
  float halo = 0.42 * exp(-dU / 0.75) * (1.0 - smoothstep(0.5 * reach, reach, dU)) * lum * (1.0 - cov);
  rad = rad * cov + ink * halo;
  // (stored as radiance / 2.4, so the brightest core still fits the pigment's 8 bits)
  float m = max(rad.r, max(rad.g, rad.b));
  ink = rad / max(m, 1e-4);
  return min(m / 2.4, 1.0);
}
`;
}
