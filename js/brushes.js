// Drawing media: data + the GLSL that turns a stroke fragment into pigment.
//
// Each brush's GLSL branch receives a `Stroke` (see BRUSH_GLSL) and returns the pigment deposit
// a in [0,1]; it may also tint `ink`. Everything textural is expressed in paper units (sU, P/uU)
// or relative to the stroke half-width, never in raw pixels, so previews, thumbnails and 8K
// exports read the same. Use aa(featurePx) to fade detail that would alias below ~2px.

export const BRUSHES = [
  { id: 'pencil', name: 'Pencil', blurb: 'Soft graphite on the tooth', shader: 4, tool: 'pencil',
    inks: [['#2a2a2e', 'Graphite'], ['#28427a', 'Blue'], ['#8e2a2a', 'Red'], ['#2f5a3a', 'Green'], ['#5a4030', 'Sepia'], ['#eeebe3', 'White']],
    spread: 1.1, lightInk: 0.9 },
  { id: 'fineliner', name: 'Pen', blurb: 'Crisp, even fineliner', shader: 0, tool: 'fineliner',
    inks: [['#17171a', 'Black'], ['#1f3a93', 'Blue'], ['#8e1b1b', 'Red'], ['#0f5132', 'Green'], ['#4a3222', 'Sepia'], ['#f4f1ea', 'White']],
    spread: 1, lightInk: 0.35 },
  { id: 'fountain', name: 'Ink', blurb: 'Fountain ink with wet edges', shader: 2, tool: 'fountain',
    inks: [['#141a3a', 'Blue-black'], ['#101012', 'Black'], ['#233fa0', 'Royal blue'], ['#3b2314', 'Sepia'], ['#7a1025', 'Crimson'], ['#0e4a4c', 'Teal']],
    spread: 1.3, lightInk: 0.4 },
  { id: 'crayon', name: 'Crayon', blurb: 'Waxy, broken edges', shader: 6, tool: 'crayon',
    inks: [['#cf3129', 'Red'], ['#1f5fa8', 'Blue'], ['#2e8a3a', 'Green'], ['#ee8a14', 'Orange'], ['#6a2a9e', 'Violet'], ['#1d1d1f', 'Black'], ['#f5f1e6', 'White']],
    spread: 1.15, lightInk: 0.85 },
  { id: 'ballpoint', name: 'Ballpoint', blurb: 'Everyday biro, uneven flow', shader: 1, tool: 'ballpoint',
    inks: [['#1d3a8a', 'Blue'], ['#16161a', 'Black'], ['#b3202a', 'Red'], ['#0d6b4f', 'Green']],
    spread: 1.6, lightInk: 0.45 },
  { id: 'marker', name: 'Marker', blurb: 'Flat, bold felt tip', shader: 7, tool: 'marker',
    inks: [['#0f8b7d', 'Teal'], ['#1f4fb0', 'Blue'], ['#d7263d', 'Red'], ['#f46036', 'Orange'], ['#7b2d8e', 'Violet'], ['#2d2a32', 'Black'], ['#f7f4ec', 'White']],
    spread: 1.2, lightInk: 0.3 },
  { id: 'brush', name: 'Brush', blurb: 'Sumi ink, dry-brush streaks', shader: 3, tool: 'brush',
    inks: [['#0e0e0e', 'Sumi black'], ['#5a1a1a', 'Oxblood'], ['#1d2b53', 'Indigo'], ['#f2efe6', 'White']],
    spread: 1.25, lightInk: 0.5 },
  { id: 'charcoal', name: 'Charcoal', blurb: 'Velvety, smudged halo', shader: 5, tool: 'charcoal',
    inks: [['#1b1715', 'Vine'], ['#2b2522', 'Compressed'], ['#4a2e22', 'Sanguine'], ['#efece4', 'White']],
    spread: 2.4, lightInk: 0.8 },
  { id: 'chalk', name: 'Chalk', blurb: 'Dusty pastel for dark boards', shader: 8, tool: 'chalk',
    inks: [['#f3f0e8', 'White'], ['#ffd1dc', 'Pink'], ['#bfe3ff', 'Sky'], ['#fff2a8', 'Yellow'], ['#c9f2c7', 'Mint']],
    spread: 2.2, lightInk: 0.9, prefersDark: true },
  { id: 'neon', name: 'Neon', blurb: 'Glowing light-pen line', shader: 9, tool: 'neon',
    inks: [['#ff45e9', 'Pink'], ['#3cf2ff', 'Cyan'], ['#b8ff3c', 'Lime'], ['#ffb23c', 'Amber'], ['#ffffff', 'White']],
    spread: 1, lightInk: 0.2, glow: { amount: 0.45, tight: 1.2, wide: 3.5 }, forceCover: true, prefersDark: true },
  { id: 'gold', name: 'Gold', blurb: 'Metallic leaf with sparkle', shader: 10, tool: 'goldpen',
    inks: [['#d9b44a', 'Gold'], ['#c9ccd1', 'Silver'], ['#c57b4a', 'Copper'], ['#dca08c', 'Rose gold']],
    spread: 1, lightInk: 0.35, forceCover: true, prefersDark: true },
];

export const brushById = id => BRUSHES.find(b => b.id === id) || BRUSHES[1];

// Inputs available to every brush branch:
//   st.cov   1px box-filtered coverage of the ideal stroke
//   st.dist  px distance from the centre line;  st.hw  half-width px (>= 0.5)
//   st.v     dist/hw (0 centre .. 1 edge);      st.vs  signed across coordinate (-1..1)
//   st.side  which side of the centre line (+1/-1)
//   st.s     px along the line;                 st.sU  paper units along the line
//   st.tone  darkness of the photo here (0..1), i.e. pressure
//   st.P     full-paper px position (for paper grain)
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
struct Stroke { float cov; float dist; float hw; float v; float vs; float side; float s; float sU; float tone; vec2 P; };

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

float brushDeposit(int brush, Stroke st, inout vec3 ink) {
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
  if (brush == 0) {                   // fineliner: pigment ink, crisp and dense
    a = st.cov * 0.975;
  } else if (brush == 1) {            // ballpoint: oily film from a rolling ball
    vec3 g = grainAt(P, 0.0);
    vec2 flow = vnA(vec2(sU / 16.0, sd0 + 3.0), 16.0 * uU);          // ink load drifts along the line
    vec2 gap = vnA(vec2(sU / 4.0, sd0 + 5.0), 4.0 * uU);             // the ball stops rolling
    // at light pressure the ball skips now and then, but a skipped stretch still leaves a faint
    // trace of the oily film, so the ONE line thins there instead of breaking
    float skip = mix(0.4, 1.0, overV(gap.x, 0.0, gap.y, 0.26 - 0.45 * tone, 0.03));
    float bite = 1.0 - 0.7 * (1.0 - over(g.x, g.y, 0.44 - 0.3 * tone, 0.03));  // light pressure misses the pits
    float pitch = max(1.25, 0.35 * hU);                                // ball tracks in wide strokes
    float track = 0.93 + 0.07 * cos(6.2832 * across / pitch) * aa(pitch * uU * 0.5);
    float body = st.cov * (0.72 + 0.25 * tone) * (0.8 + 0.2 * flow.x) * skip * bite * track;
    // rare gloops: a dot of excess ink on one in three 45-U stretches of line. A dot is round
    // about a point, so it is measured in the clamped frame (st.sU, radial st.vs): a cap then sees
    // the distance along the path to its end point plus the radius, never less than the true
    // distance, so dots stay round even where a wave turns sharply.
    float cell = floor(st.sU / 45.0);
    float r = hash21(vec2(cell, sd0 + 17.0));
    float ds = st.sU - cell * 45.0 - 6.0 - fract(r * 91.7) * 33.0;
    float rU = min((0.6 + 0.5 * fract(r * 13.1)) * max(1.0, 0.3 * hU), 1.55 * hU + 1.4 / uU);
    float bd = length(vec2(ds, st.vs * hU)) / rU;
    float blob = step(r, 0.33) * (1.0 - smoothstep(0.6, 1.0, bd)) * aa(rU * uU * 1.5) * (0.5 + 0.5 * tone);
    a = max(body, 0.92 * blob);
  } else if (brush == 2) {            // fountain ink: deep wet line, pooled rim, slight feathering
    // edge wander + hair-fine feathering, both 1-D along each edge (so every spike stays attached
    // to the line) and zero-mean (so the line keeps its ink at every output size)
    vec2 wob = vnA(vec2(sU / 3.0, side * 5.0 + sd0), 3.0 * uU);
    vec2 fea = vnA(vec2(sU / 0.45, side * 9.0 + sd0 + 13.0), 0.45 * uU);
    float spike = (excess(fea.x, fea.y, 0.72) - 0.0178) / 0.28;         // capillary spikes
    float grow = ((wob.x - 0.5) * 0.25 + spike * 0.9) * min(hw, uU);
    float hwF = hw + grow;
    float c2 = clamp(hwF - dist + 0.5, 0.0, 1.0);
    // coffee-ring pooling: as the line dries its dye migrates to the rim, which ends up fuller and
    // darker than the body. Where the rim is too fine to show, its mean across the width stands in
    // (rimMean), and both terms are linear in it, so previews and exports carry the same ink.
    float rimPx = max(0.55, 0.22 * hU) * uU;
    float rimMean = min(1.0, 0.5 * rimPx / max(hwF, 0.5));
    float rim = mix(rimMean, 1.0 - smoothstep(0.0, rimPx, hwF - dP), aa(rimPx * 2.0));
    vec2 flow = vnA(vec2(sU / 30.0, sd0 + 11.0), 30.0 * uU);         // nib shading along the line
    a = c2 * (0.955 + 0.045 * rim) * (0.975 + 0.025 * flow.x);
    if (lum3(ink) < 0.5) ink *= 1.0 - 0.45 * (rim - rimMean);          // denser dye at the rim
  } else if (brush == 3) {            // sumi brush: wet black in the darks, dry bristle streaks in the lights
    float wet = smoothstep(0.25, 1.0, tone);
    float pitch = max(1.2, 0.18 * hU);                                 // bristle track width, U
    float L = 20.0 + 8.0 * pitch;                                      // streak length, U
    vec2 bri = vnA(vec2(sU / L + sd0, across / pitch), pitch * uU);
    vec2 brk = vnA(vec2(sU / L + sd0 + 3.7, 5.0), L * uU);             // whole-stroke breaks along the line
    vec3 t = tooth(P, 1.8);
    // on strokes far wider than a real brush (chips) the tooth is sub-pixel: let the bristles lead
    float wt = 0.36 * clamp(3.0 / hU, 0.3, 1.0);
    float m = (0.42 * bri.x + 0.22 * brk.x + wt * t.x) / (0.64 + wt);
    float streak = overV(m, wt * t.y / (0.64 + wt), length(vec2(0.42 * bri.y, 0.22 * brk.y)) / (0.64 + wt),
                         mix(0.66, -0.3, smoothstep(0.0, 1.0, tone)), 0.035);
    // the brush never runs completely dry: a broken film keeps the ONE line readable across the
    // highlights, and the dry streaks and breaks ride on top of it. Hairlines are drawn with the
    // tip, which holds its ink longest, so they stay nearly whole; broad dry strokes open up.
    float body = mix(mix(0.66, 0.36, smoothstep(0.4, 2.0, hUT)), 1.0, streak);
    body *= 1.0 - 0.3 * (1.0 - wet) * (1.0 - t.z);                    // dry hairs skip the pits
    // the outer bristles run dry first (linear falloff; its mean where the width is unresolved)
    float fall = 0.45 * (1.0 - wet);
    body *= mix(1.0 - fall * 0.325, 1.0 - fall * smoothstep(0.35, 1.0, v), aa(hw * 2.0));
    float wc = max(5.0, hU);
    vec2 wob = vnA(vec2(sU / wc, side * 3.1 + sd0), wc * uU);
    float hwE = hw * (0.93 + 0.14 * wob.x);
    float edge = clamp(hwE - dist + 0.5, 0.0, 1.0);
    // a loaded brush bleeds a soft grey fringe into the paper: a ring just outside the edge
    float bw = 0.3 * hw;
    float ring = max(0.0, edgeCov(hwE + 0.5 * bw, dist, bw) - edge);
    a = edge * body * 0.98 + ring * 0.3 * wet * wet;
  } else if (brush == 4) {            // graphite: tooth-driven deposit, directional grain, never black
    vec3 t = tooth(P, 1.0);
    float pitch = max(0.7, 0.34 * hU);
    vec2 sk = vnA(vec2(sU / max(7.0, 2.0 * hU) + sd0, across / pitch), pitch * uU);
    float m = t.x + (sk.x - 0.5) * 0.4;
    float sd = length(vec2(t.y, 0.4 * sk.y));
    float dep = over(m, sd, 0.56 - 0.5 * tone, 0.03);
    float fill = dep * (0.52 + 0.45 * tone) + (1.0 - dep) * (0.1 + 0.3 * tone * tone);
    fill *= 1.0 - (0.5 - 0.38 * tone) * (1.0 - t.z);                  // pits stay pale; pressure packs them
    float cone = mix(0.95, 1.0 - 0.2 * smoothstep(0.5, 1.0, v), aa(hw));
    a = edgeCov(hw, dist, 0.6 * uU) * cone * fill;
    // burnished graphite: where it is packed hard, patches of the sheet catch the light and turn
    // silvery. Graphite only: coloured leads and photo colours are wax-bound and never shine so.
    float chroma = max(ink.r, max(ink.g, ink.b)) - min(ink.r, min(ink.g, ink.b));
    if (uPhotoColor == 0 && chroma < 0.06 && lum3(ink) < 0.5) {
      vec2 bur = vnA(PU / 40.0 + sd0 + 21.0, 40.0 * uU);
      ink = mix(ink, vec3(0.44, 0.45, 0.49), 0.35 * dep * tone * smoothstep(0.52, 0.8, bur.x));
    }
  } else if (brush == 5) {            // charcoal: coarse tooth, velvety core, smudged halo
    vec3 t = tooth(P, 1.8);
    float pitch = max(1.4, 0.3 * hU);
    vec2 sk = vnA(vec2(sU / max(5.0, 1.5 * hU) + sd0, across / pitch), pitch * uU);
    float rc = max(3.0, 0.8 * hU);
    vec2 rag = vnA(vec2(sU / rc, side * 5.0 + sd0), rc * uU);
    float hwE = hw * (0.86 + 0.28 * rag.x);
    float core = edgeCov(hwE, dist, max(0.9 * uU, 0.3 * hw));
    // the tooth tops take the charcoal; even a light touch leaves a veil of dust between them, so
    // a hairline stays one line where the paper dips under it
    float dep = mix(0.3, 1.0, over(t.x, t.y, 0.6 - 0.62 * tone, 0.03));
    dep *= 1.0 - (0.55 - 0.35 * tone) * (1.0 - t.z);                 // heavy pressure fills the pits
    dep *= 1.0 + 0.35 * (sk.x - 0.5);                                   // drag streaks
    dep *= mix(1.0 - 0.3 * 0.25, 1.0 - 0.3 * smoothstep(0.5, 1.0, v), aa(hw * 2.0));  // the stick's edge lays less
    float body = core * dep * (0.45 + 0.52 * tone);
    // dust smudged off the stick: a soft, clouded ring outside the stroke
    float mc = max(5.0, 1.2 * hU);
    vec2 sm = vnA(PU / mc + sd0 + 31.0, mc * uU);
    float hW = 1.2 * hw;
    float ring = max(0.0, edgeCov(hwE + 0.5 * hW, dist, hW) - core);
    a = body + ring * (0.1 + 0.18 * tone) * (0.3 + 1.4 * sm.x);
  } else if (brush == 6) {            // wax crayon: wax rides the tooth tops, ragged waxy edge
    vec3 t = tooth(P, 1.2);
    float oc = max(1.2, 0.25 * hU);
    vec2 own = vnA(PU / oc + sd0 + 41.0, oc * uU);                     // the wax's own lumpiness
    float pitch = max(1.4, 0.3 * hU);
    vec2 sk = vnA(vec2(sU / max(10.0, 2.5 * hU) + sd0, across / pitch), pitch * uU);  // worn-tip striations
    float rc = max(1.8, 0.45 * hU);
    vec2 rag = vnA(vec2(sU / rc, side * 4.0 + sd0), rc * uU);
    vec2 rag2 = vnA(vec2(sU / (4.0 * rc), side * 9.0 + sd0), 4.0 * rc * uU);
    float hwE = hw * (0.84 + 0.2 * rag.x + 0.12 * rag2.x);
    float edge = clamp(hwE - dist + 0.5, 0.0, 1.0);
    float m = 0.8 * t.x + 0.2 * own.x;
    float wax = overV(m, 0.8 * t.y, 0.2 * own.y, 0.6 - 0.32 * tone, 0.02);
    wax *= 1.0 - (0.6 - 0.3 * tone) * (1.0 - t.z);                    // the pits stay paper-white
    wax *= 1.0 + 0.3 * (sk.x - 0.5);
    wax *= mix(1.0 - 0.3 * 0.225, 1.0 - 0.3 * smoothstep(0.55, 1.0, v), aa(hw * 2.0));
    a = edge * wax * 0.97;
  } else if (brush == 7) {            // marker: flat translucent dye, darker rim, felt streaks
    float pitch = max(0.9, 0.3 * hU);
    vec2 felt = vnA(vec2(sU / max(25.0, 3.0 * hU) + sd0, across / pitch), pitch * uU);
    // dye pools at the rim as the solvent evaporates (redistributed: the mean stays 0.85)
    float rimPx = max(0.5, 0.15 * hU) * uU;
    float rimRes = 1.0 - smoothstep(0.0, rimPx, hw - dP);
    float rimMean = min(1.0, 0.5 * rimPx / hw);
    float pool = 0.85 + 0.13 * (rimRes - rimMean) * aa(rimPx * 2.0);
    a = edgeCov(hw, dist, 0.35 * uU) * pool * (1.0 + 0.12 * (felt.x - 0.5));
  } else if (brush == 8) {            // chalk: dusty broken grain, crumbly edge, faint dust halo
    vec3 t = tooth(P, 2.0);
    float cs = max(2.2, 0.28 * hU);
    vec2 cr = vnA(PU / cs + sd0 + 51.0, cs * uU);
    float rc = max(2.4, 0.5 * hU);
    vec2 rag = vnA(vec2(sU / rc, side * 4.0 + sd0), rc * uU);
    float hwE = hw * (0.86 + 0.28 * rag.x);
    float edge = clamp(hwE - dist + 0.5, 0.0, 1.0);
    float pitch = max(1.5, 0.3 * hU);
    vec2 sk = vnA(vec2(sU / max(8.0, 2.0 * hU) + sd0, across / pitch), pitch * uU);
    float m = 0.75 * t.x + 0.25 * cr.x;
    float dep = overV(m, 0.75 * t.y, 0.25 * cr.y, 0.62 - 0.38 * tone, 0.03);
    dep *= 1.0 - (0.5 - 0.25 * tone) * (1.0 - t.z);
    dep *= 1.0 + 0.4 * (sk.x - 0.5);
    dep *= mix(1.0 - 0.3 * 0.25, 1.0 - 0.3 * smoothstep(0.5, 1.0, v), aa(hw * 2.0));
    float body = edge * dep * 0.92;
    float dc = max(3.5, 0.8 * hU);
    vec2 du = vnA(PU / dc + sd0 + 57.0, dc * uU);
    float hW = hw;
    float ring = max(0.0, edgeCov(hwE + 0.5 * hW, dist, hW) - edge);
    a = body + ring * (0.07 + 0.07 * tone) * (0.3 + 1.4 * du.x);
  } else if (brush == 9) {            // neon: a lit tube with a white-hot core; glow added in the composite
    float hwT = hw * 0.86;                                              // tubes, not bands: keep dark seams
    float vT = dist / hwT;
    float k = aa(hwT * 2.0);
    float tube = mix(0.88, 0.42 + 0.58 * sqrt(max(0.0, 1.0 - vT * vT)), k);
    float core = mix(0.25, 1.0 - smoothstep(0.0, 0.5, vT), k);
    ink = mix(ink, vec3(1.0), 0.7 * core * (0.6 + 0.4 * tone));
    // brighter where the photo is brighter, so the picture reads even with the constant-width wave
    a = clamp(hwT - dist + 0.5, 0.0, 1.0) * tube * (0.35 + 0.65 * tone);
  } else {                            // 10 gold leaf: metallic ramp, facets, broad reflections, sparkle
    float k = aa(hw * 1.5);
    float nz = sqrt(max(0.0, 1.0 - v * v));
    float fs = max(4.5, 0.5 * hU);
    vec2 fac = vnA(PU / fs + sd0, fs * uU);                             // crinkled leaf facets
    vec2 fac2 = vnA(PU / (fs / 3.0) + sd0 + 3.0, fs / 3.0 * uU);
    float env = vnoise(P / uPaperPx * 3.0 + sd0);                       // room reflection across the sheet
    // brightness b: cylinder shading + facets + reflection. nz averages pi/4 across the width.
    float mb = 0.5 + 0.55 * (mix(0.785, nz, k) - 0.785) + 0.6 * (fac.x - 0.5) + 0.25 * (fac2.x - 0.5) + 0.45 * (env - 0.5);
    float sb = length(vec3(0.55 * 0.223 * (1.0 - k), 0.6 * fac.y, 0.25 * fac2.y));
    // metal: deep reflections (b = 0) up to pale highlights (b > 0.6), averaged over the spread
    // of b this size cannot show. Nearly linear in b, so previews and exports agree.
    float e1 = excess(mb, sb, 1.0);
    float B = excess(mb, sb, 0.0) - e1;                                 // E[clamp(b, 0, 1)]
    float H = excess(mb, sb, 0.6) - e1;                                 // E[clamp(b, .6, 1) - .6]
    vec3 lite = vec3(1.0, 0.97, 0.9);
    vec3 col = ink * (0.25 + 1.1 * B) + (lite - ink) * 1.6 * H;
    vec2 sp = vnA(PU / 0.8 + sd0 + 7.0, 0.8 * uU);
    float spark = overV(sp.x, 0.0, sp.y, 0.86, 0.015);
    float spec = mix(0.318, pow(nz, 14.0), k);                          // nz^14 averages 0.318 across
    col += mix(ink, lite, 0.7) * (spark * 0.6 + spec * 0.35 * (0.3 + env));
    ink = clamp(col, 0.0, 1.0);
    a = st.cov;
  }
  return a;
}
`;
