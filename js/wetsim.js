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
uniform sampler2D uC;       // x: colourant caught in the fibres (never moves again), y: cockle
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
  vec4 cC = texelFetch(uC, p, 0) * uScaleA;
  float soakP = cC.x + catchD;
  // Cockling (C.y): paper fibres swell as they take on water and do not shrink back evenly, so a
  // sheet that got very wet keeps a low swell there once dry, a few millimetres wide, following the
  // passages (a wash, a run of close, loaded brush lines), not each line. C.y relaxes toward the
  // wet extent (B.x, which is kept forever) through a wide stencil: a screened diffusion whose
  // equilibrium is the extent low-passed over ~3 mm (taps 1, 2 and 4 cells out along both axes:
  // ~2.4 cells^2 of spread per step, and every ripple finer than that is damped, pulled 1.2% per
  // step toward the extent). The composite lights its slope; how high it stands per medium and
  // sheet is cockleHeight() (a pen's lines hardly buckle a sheet).
  float ck1 = 0.0, ck2 = 0.0, ck4 = 0.0;
  for (int i = 0; i < 4; i++) {
    ck1 += texelFetch(uC, clamp(p + OFF[i], ivec2(0), hi), 0).y;
    ck2 += texelFetch(uC, clamp(p + 2 * OFF[i], ivec2(0), hi), 0).y;
    ck4 += texelFetch(uC, clamp(p + 4 * OFF[i], ivec2(0), hi), 0).y;
  }
  float ckA = 0.04 * cC.y + (0.12 * ck1 + 0.07 * ck2 + 0.05 * ck4) * uScaleA;
  float cockle = ckA + 0.012 * (max(bC.x, smoothstep(0.004, 0.04, W)) - ckA);

  oA = vec4(W, S, P, M) / uScaleA;
  oSoak = vec4(soakP, cockle, 0.0, 0.0) / uScaleA;
  // the edge's pull for the next step: exposure here, or what reaches in from the rim (a decaying
  // average of the neighbours, which spreads in round contours rather than the grid's diamonds)
  float f = W > 1e-3 ? max(edge, 0.97 * fSum / 6.0) : 0.0;
  float age = W > 1e-3 ? min(1.0, bC.z + 1.0 / 64.0) : 0.0;
  // the extent: where water has stood on the sheet (its hard edge); what soaked in is in C
  oB = vec4(max(bC.x, smoothstep(0.004, 0.04, W)), f, age, D);
}`;

// The composite's fibre-scale wet detail (shaders.js FRAG_COMPOSITE, wet media only): feathering
// hairs (fibreHairs) and the sheet's cockle (cockleShade, below).
// The grid's cell is ~0.2 mm; a paper fibre is ~0.03 mm wide and 0.3-1.5 mm long, so the last
// step of the liquid's travel, along single fibres out of a wet line, is walked here at the
// output's own resolution. Single fibres (uHairN per 0.5 mm cell, two candidates per cell) lie
// along the sheet's fibre orientation (papers.js fibreAngle, the same field the grid's anisotropic
// bleed uses), loosely. A fibre that touches ink anywhere along its length draws the ink along
// itself, thinning with the distance travelled (uHairReach U), and a second, shorter fibre
// branching off it where they cross carries on from there: hair-like spikes, bunched where the
// sheet's flocs are thirsty. The source is the simulated state only (the line's coverage on the
// grid once the simulation has reached it, and the colourant the fibres drank), so the hairs grow
// with the bleed, are a pure function of drawing progress, and are identical in a preview, a strip
// of an export and a film frame (sheet-space samples only). Each hair is box-filtered over the
// pixel, so a preview shows their mean as a faint fringe and holds the ink a 4K render has.
// Needs COMMON (hashU, vnoise), fibreAngle (papers.js), uU, uSeed and the composite's sim uniforms.
export const WET_FIBRE_GLSL = /* glsl */`
uniform float uCockle;      // sheet height, U, per unit of the wetness it took on (0 = flat)
uniform float uHair;        // 0 = off; how readily the sheet feathers x the medium's wick
uniform float uHairN;       // share of candidate fibres that drink
uniform float uHairReach;   // how far ink travels along a fibre, U
uniform vec2 uHairDir;      // the sheet's machine direction (unit, sheet axes)
vec4 hairH4(vec2 c, uint salt) {
  uint h = hashU(uvec2(ivec2(floor(c)) + 8192) + uvec2(salt * 7919u, salt * 3571u + 17u));
  return vec4(uvec4(h, h >> 8u, h >> 16u, h >> 24u) & 255u) / 255.0;
}
// the ink a fibre can drink at P (sheet px): the line where the simulation has already wetted the
// sheet (its extent, B.x: the pen time of the ink map is no gate here, since filtering it blends a
// future line's time with the blank paper beside it), and what the fibres already hold
// (sheet-space samples: the same in every strip)
float hairSrc(vec2 P) {
  vec2 s = vec2(P.x / uSheetPx.x, 1.0 - P.y / uSheetPx.y);
  // (explicit LOD: the grids have no mips, so this is the same sample, and a loop without
  // gradient sampling compiles as a loop instead of being unrolled 108 times)
  float laid = textureLod(uSimInj, s, 0.0).z * clamp(2.0 * textureLod(uSimB, s, 0.0).x, 0.0, 1.0);
  float c = mix(textureLod(uSimC0, s, 0.0).x, textureLod(uSimC1, s, 0.0).x, uSimFrac) * uSimScale;
  return clamp(1.4 * laid + 6.0 * c, 0.0, 1.0);
}
float hairSoak(vec2 P) {
  vec2 s = vec2(P.x / uSheetPx.x, 1.0 - P.y / uSheetPx.y);
  return clamp(6.0 * mix(textureLod(uSimC0, s, 0.0).x, textureLod(uSimC1, s, 0.0).x, uSimFrac) * uSimScale, 0.0, 1.0);
}
// box-filtered coverage of a hair w px wide whose axis is d px from the pixel centre
float hairBox(float d, float w) { return max(0.0, min(d + 0.5 * w, 0.5) - max(d - 0.5 * w, -0.5)); }
float fibreHairs(vec2 P) {
  vec2 pu = P / uU;
  float ang0 = fibreAngle(pu, uHairDir);
  const float C = 2.5;                                  // U per candidate cell
  vec2 ci = floor(pu / C);
  // fibres drink in clumps (the sheet's flocs): the spikes burst out in places, not all along
  float clump = smoothstep(0.3, 0.85, vnoise(pu / 11.0 + uSeed * 5.3));
  float pN = uHairN * (0.2 + 1.8 * clump);
  float best = 0.0, s0 = -1.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) for (int k = 0; k < 2; k++) {
    vec2 c = ci + vec2(float(x), float(y));
    vec4 r = hairH4(c, 41u + uint(k) * 13u);
    if (r.w > pN) continue;
    vec4 r2 = hairH4(c, 47u + uint(k) * 13u);
    float Lh = C * (0.4 + 0.6 * r2.x);                  // half length, U (1-2.5)
    vec2 cp = (c + r.xy) * C * uU;                      // centre, px
    float ang = ang0 + (r.z - 0.5) * 1.6;
    vec2 t = vec2(cos(ang), sin(ang));
    // the branch: a shorter fibre leaving this one at a random point, at an angle
    float bj = (r2.y - 0.5) * 1.2 * Lh;                 // junction, U along the main fibre
    float bang = ang + (r2.z > 0.5 ? 1.0 : -1.0) * (0.45 + 0.5 * r2.w);
    vec2 tb = vec2(cos(bang), sin(bang));
    vec2 jp = cp + t * bj * uU;
    float Lb = 0.45 * Lh;
    vec2 dp = P - cp, db = P - jp;
    float along = dot(dp, t) / uU, alongB = dot(db, tb) / uU;
    float wPx = (0.13 + 0.12 * r2.x) * uU;              // 25-50 um: the ink in and between the fibres
    float dM = abs(t.x * dp.y - t.y * dp.x), dB = abs(tb.x * db.y - tb.y * db.x);
    bool onM = abs(along) <= Lh && dM < 0.5 * wPx + 0.5;
    bool onB = alongB >= 0.0 && alongB <= Lb && dB < 0.4 * wPx + 0.5;
    if (!onM && !onB) continue;
    // (what the fibres here already hold: a hair only shows where it carries the ink beyond that, so
    // a fibre inside an evenly soaked halo adds nothing and the halo is not crazed with lines)
    if (s0 < 0.0) s0 = hairSoak(P);
    // the capillary walk along the main fibre: ink enters where the fibre touches ink and thins
    // over reach as it travels (six samples over its length)
    float reach = uHairReach * (0.5 + 0.5 * r2.w);
    float hM = 0.0, hJ = 0.0;
    for (int j = 0; j < 6; j++) {
      float aj = (float(j) / 5.0 * 2.0 - 1.0) * Lh;
      float s = hairSrc(cp + t * aj * uU);
      hM = max(hM, s * (1.0 - abs(along - aj) / reach));
      hJ = max(hJ, s * (1.0 - abs(bj - aj) / reach));
    }
    // (a hair narrows toward its tip as the ink runs out, and carries the dye thinner than the line)
    hM = clamp(hM - s0, 0.0, 1.0);
    if (onM) best = max(best, 0.75 * hM * hairBox(dM, wPx * (0.35 + 0.65 * hM)));
    // the branch carries on from the junction, with what reached it
    float hB = clamp(hJ - alongB / reach - s0, 0.0, 1.0);
    if (onB) best = max(best, 0.75 * hB * hairBox(dB, 0.8 * wPx * (0.35 + 0.65 * hB)));
  }
  return best;
}
// Cockling: paper that got very wet buckles. Its fibres swell across their length as they take on
// water; the soaked patch grows but the dry sheet around it holds it, so it pushes up into soft
// waves (ridges roughly along the grain, since the sheet swells most across it) some 1-3 cm
// apart, and the fibres set in that shape as they dry: the waves stay. How wet each place got is
// the simulation's C.y (the wet extent low-passed over ~3 mm, kept after drying), averaged again
// over ~1 cm here: a buckle belongs to a soaked region, a wash or a run of close, loaded brush
// lines, never to a single line. Only heavily wetted regions buckle (a threshold on that average),
// the height is uCockle (per medium and sheet, cockleHeight) and every length is in paper units,
// so the waves keep their real size on a big sheet (renderer.setSheetMm). Lit like the paper's
// relief: diffuse linear in the slope along the light, times cot(elevation): barely a shimmer
// under the window light, plain rolling waves under a raking one, flat from above. Sheet-space
// samples only (identical in a preview, a strip of an export and a film frame).
float cockleAt(vec2 s) { return textureLod(uSimC1, s, 0.0).y * uSimScale; }
// how wet the region around P (px) got: ~1 cm average of C.y, then the buckling threshold
float soakRegion(vec2 P) {
  vec2 s = vec2(P.x / uSheetPx.x, 1.0 - P.y / uSheetPx.y);
  vec2 r = 28.0 * uU / uSheetPx;                        // ~6 mm, in sheet fractions
  float w = 0.2 * cockleAt(s);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7854 + 0.39;
    w += 0.1 * cockleAt(s + vec2(cos(a), sin(a)) * r);
  }
  return smoothstep(0.1, 0.45, w);
}
// sheet height (px) at P: soft buckles where it soaked
float buckleAt(vec2 P) {
  vec2 pu = P / uU;                                     // paper units (0.21 mm)
  vec2 g = uHairDir, n = vec2(-g.y, g.x);
  // wavy ridges ~2 cm apart along the grain, broken into elongated domes ~4-6 cm long
  float warp = 30.0 * (vnoise(pu / 190.0 + 3.7 + uSeed) - 0.5) + 14.0 * (vnoise(pu / 70.0 + 9.1) - 0.5);
  float across = dot(pu, n) + warp, along = dot(pu, g);
  float lam = 95.0 * (0.85 + 0.3 * vnoise(pu / 260.0 + 1.3));
  float wave = cos(6.2832 * across / lam) * (0.55 + 0.45 * cos(6.2832 * along / 240.0 + 2.0 * vnoise(pu / 150.0 + 5.3)));
  return uCockle * uU * soakRegion(P) * (0.35 + 0.65 * wave);
}
float cockleShade(vec2 P) {
  vec2 dir = normalize(uPaperLight);                    // away from the light (paper space)
  float d = 7.0 * uU;                                   // ~1.5 mm baseline
  float slope = (buckleAt(P + dir * d) - buckleAt(P - dir * d)) / (2.0 * d);   // + = facing the light
  float x = slope * uCotEl;
  // soft limits (a steep buckle's lit flank never burns out, its far side keeps some light)
  return 1.0 + (x >= 0.0 ? 0.35 * (1.0 - exp(-x / 0.35)) : -0.4 * (1.0 - exp(x / 0.4)));
}
`;

/**
 * Fibre-scale feathering uniforms (WET_FIBRE_GLSL) for a medium on a paper: how readily the sheet
 * lets a wet line creep out along its fibres (thirsty, unsized, fibrous sheets; nothing on sized
 * or coated ones), times the share of the colour that travels with the water (wet.wick).
 * Returns { on, k, n, reach } (on = false: the composite skips the walk).
 */
export function fibreHair(wet, phys) {
  const thirst = Math.min(1, Math.max(0, (phys.absorb * (1 - phys.sizing) - 0.07) * 3.2)) * (0.35 + 0.65 * phys.fibre);
  // (dye travels with the water; soot and pigment particles are mostly filtered out near the line)
  const k = thirst * (wet.wick ?? wet.dye ?? 0.5) * (0.3 + 0.7 * (wet.dye ?? 0.5));
  // (k: the hairs' strength; a sheet that feathers at all shows them clearly at the fibre's scale)
  return { on: k > 0.03, k: Math.min(0.8, 0.25 + 1.3 * k), n: 0.15 + 0.5 * thirst, reach: 0.7 + 1.8 * thirst };
}

/**
 * The pen's ink supply along the line, per point: how far the feed has fallen behind (0 = full
 * .. 1 = dry), for the stroke pass (Stroke.feed, brushes.js). A fountain pen's feed delivers ink at
 * a limited rate and the nib holds a small reserve: a sustained demand (a broad line, drawn at
 * speed) draws the reserve down over some 15-25 mm, so a long, heavy run pales gradually; where
 * the hand slows or lingers (tight turns, maze corners, the darks' slow strokes) the feed catches
 * up and the next stretch starts rich. Integrated along the line with the 'natural' pacing's model
 * of the hand (the shader's st.speed), in circle units (1 = the art circle's radius, ~84 mm of the
 * default sheet), so it is a pure function of the geometry: the same in a preview, a strip of an
 * export and every film frame. Returns a Float32Array(n).
 */
export function feedDeficit(geom, paceK = 0.65) {
  const { n, data } = geom, out = new Float32Array(n);
  const ST = 7;                                         // spiral.js STRIDE (x, y, w, s, tone, turn, dwell)
  let wRef = 0;
  for (let i = 0; i < n; i++) wRef = Math.max(wRef, data[i * ST + 2]);
  if (!(wRef > 0) || n < 2) return out;
  // per circle unit of line: drain = demand (width x speed) against what is left; refill
  // proportional to the time spent (1 / speed) and to what is missing
  const KD = 1.6, KR = 2.4;                            // ~ 0.25 circle units (20 mm) to settle
  let D = 0;
  for (let i = 1; i < n; i++) {
    const q = i * ST, p = q - ST;
    const ds = Math.max(0, data[q + 3] - data[p + 3]);
    const w = 2 * data[q + 2] / wRef, tone = data[q + 4], dwell = Math.max(1, data[q + 6]);
    const v = (1 - paceK) / ((1 - paceK + paceK * tone) * dwell);
    // (exact for constant coefficients over the step, so the result does not depend on how finely
    // the line is sampled)
    const a = KD * w, b = KR / Math.max(v, 0.05), k = a + b;
    const Dinf = k > 0 ? a / k : 0;
    D = Dinf + (D - Dinf) * Math.exp(-k * ds);
    // what the line shows: the lag (a run paling as it goes on, a rich restart after a pause) in
    // full, the steady level only in part, so the photo's darks keep their weight
    out[i] = 0.25 + (D - Dinf) + 0.35 * (Dinf - 0.25);
  }
  return out;
}

/**
 * Cockle height (U per unit of wetness the sheet took on, WET_FIBRE_GLSL uCockle): only heavy
 * liquid loads buckle a sheet (washes, a loaded brush; a pen's line hardly), and a heavy, absorbent
 * watercolour board less than thin sketch or kraft paper.
 */
export function cockleHeight(wet, phys) {
  const heavy = Math.min(1, Math.max(0, (wet.load - 0.4) / 0.6));
  // (U of buckle height: up to ~0.8 mm on thin sketch or kraft paper under a wash, a third of
  // that on heavy cold-press board, which is why watercolourists use it)
  return 4.0 * heavy * (1.15 - 0.75 * phys.capacity);
}

/**
 * Simulation parameters (per step) for a medium on a paper.
 * wet = brushWet(brush) (brushes.js), phys = paperPhysics(paper) (papers.js).
 */
export function wetParams(wet, phys, physK = 1) {
  const { absorb, sizing, fibre, capacity } = phys;
  // physK = the renderer's physical scale (210 mm / sheet width, renderer.setSheetMm): the grid is
  // fixed per sheet, so on a big sheet a cell spans more paper. Transport is diffusive (spread ~
  // sqrt(D t)), so a rate per cell^2 scales with physK^2 for the liquid to travel the same mm; a
  // drift across the rim (Deegan flow) scales with physK. Rates per step (drinking, evaporation,
  // settling) are about time and stay. 1 = today's A4 sheet exactly.
  const k2 = physK * physK;
  const P = {
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
  if (physK !== 1) {
    P.uDiff *= k2; P.uCapF *= k2; P.uWick *= k2; P.uMix *= k2;
    P.uRing *= physK;
  }
  return P;
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
      rg32f: [gl.RG32F, gl.RG, gl.FLOAT],
      rg16f: [gl.RG16F, gl.RG, gl.HALF_FLOAT],
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
      // because it is not bounded by the surface water's hard edge (x), and the sheet's cockle (y).
      // (y: the wetness the sheet took on, for cockling)
      const fc = { rgba32f: 'rg32f', rgba16f: 'rg16f', rgba8: 'rgba8' }[fmt];
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
