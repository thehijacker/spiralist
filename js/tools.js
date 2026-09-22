// Drawing-tool sprites: the pencil / pen / brush that rides the head of the line during
// playback and in the filmed timelapse. Canvas 2D paths and gradients only (no images), so
// they stay crisp at any size and DPR.
//
// Local frame: u runs along the tool axis from the tip (u = 0) to the back end, v across it,
// both in units of `size`; +v is the lit side. The frame puts the tip exactly on (x, y) with
// the body toward the lower right (a right hand), `angle` degrees from vertical. Light comes
// from the upper left, so the cast shadow falls to the lower right and fans away from the
// body, because the back end of a held tool is higher off the paper than its tip.
//
// Seams and end faces are drawn as half-ellipses bulging toward the tip: that is how a ring
// around a cylinder looks when its back end tilts toward the eye, and it is what makes a flat
// sprite read as a round object.

export const TOOL_KINDS = ['pencil', 'fineliner', 'fountain', 'crayon', 'ballpoint', 'marker', 'brush',
  'charcoal', 'chalk', 'neon', 'goldpen'];

const TAU = Math.PI * 2;
const HALF = Math.PI / 2;
const DEG = Math.PI / 180;
const BULGE = 0.36;                  // seam / end-face ellipse depth, relative to the radius
const SHADOW_DIR = norm(0.87, 0.49); // on the paper, away from the upper-left light
const SHADOW_SHEAR = 0.2;            // cast-shadow offset per unit of length along the body
const LIFT_OFFSET = 0.13;            // extra shadow offset at lift = 1 (units of size)
const TILE = 2048;                   // largest scratch layer side (device px): caps pooled memory

// ------------------------------------------------------------------ small math

function norm(x, y) { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; }
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// 2x3 affine matrices as [a, b, c, d, e, f] (canvas setTransform order)
function mul(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}
const apply = (M, u, v) => [M[0] * u + M[2] * v + M[4], M[1] * u + M[3] * v + M[5]];
const matScale = M => Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2])) || 1;

function getMatrix(ctx) {
  if (ctx.getTransform) {
    const t = ctx.getTransform();
    return [t.a, t.b, t.c, t.d, t.e, t.f];
  }
  return [1, 0, 0, 1, 0, 0];
}

// deterministic hash noise in [-1, 1] (no Math.random: a sprite must look the same every frame)
function hash(i) {
  let h = (i | 0) * 374761393 + 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295 * 2 - 1;
}
function wobble(u, seed) {
  return 0.5 * Math.sin(u * 41 + seed * 1.7) + 0.3 * Math.sin(u * 97 + seed * 4.3) + 0.2 * Math.sin(u * 211 + seed * 2.9);
}

// loose grains (dust) scattered around the tip: deterministic, batched into three fills
function grains(g, n, seed, u0, du, v0, dv, r0, dr, style) {
  const paths = [new Path2D(), new Path2D(), new Path2D()];
  for (let i = 0; i < n; i++) {
    const a = hash(i * seed + 1), b = hash(i * seed + 2), c = hash(i * seed + 3);
    const u = u0 + du * a, v = v0 + dv * b, r = r0 + dr * (c + 1);
    const p = paths[i % 3];
    p.moveTo(u + r, v); p.arc(u, v, r, 0, TAU);
  }
  paths.forEach((p, i) => { g.fillStyle = style(i); g.fill(p); });
}

// ------------------------------------------------------------------ colour

const WHITE = [255, 255, 255], BLACK = [0, 0, 0];

function parseColor(c, fallback) {
  if (Array.isArray(c) && c.length >= 3) return c.slice(0, 3);
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c == null ? '' : c).trim());
  if (!m) return fallback;
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, ch => ch + ch);
  const v = parseInt(h, 16);
  return [v >> 16 & 255, v >> 8 & 255, v & 255];
}
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const lit = (c, k) => mix(c, WHITE, clamp(k, 0, 1));
const dim = (c, k) => mix(c, BLACK, clamp(k, 0, 1));
const luma = c => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
const chroma = c => (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])) / 255;
function css(c, a = 1) {
  const r = Math.round(clamp(c[0], 0, 255)), g = Math.round(clamp(c[1], 0, 255)), b = Math.round(clamp(c[2], 0, 255));
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${Math.max(0, +a.toFixed(4))})`;
}

// Cylinder shading across the width, t = 0 on the shadow edge (-v) .. 1 on the lit edge (+v).
// Materials differ in specular strength / width and core-shadow depth.
const MAT = {
  matte: { spec: 0.16, width: 0.2, shade: 0.4, rim: 0.14, fall: 0.12 },
  wax: { spec: 0.3, width: 0.11, shade: 0.42, rim: 0.2, fall: 0.12 },
  satin: { spec: 0.34, width: 0.1, shade: 0.5, rim: 0.18, fall: 0.16 },
  gloss: { spec: 0.62, width: 0.05, shade: 0.56, rim: 0.22, fall: 0.2 },
  lacquer: { spec: 0.72, width: 0.035, shade: 0.6, rim: 0.26, fall: 0.22 },
};
function shadeStops(base, m) {
  const { spec, width, shade, rim, fall } = m;
  const core = dim(base, shade);
  // very dark materials show their shape through highlights, not through darkening
  const lift = luma(base) < 0.12 ? 0.08 : 0;
  return [
    [0, mix(core, lit(base, 0.35 + lift), rim)],   // bounce light on the shadow edge
    [0.1, core],
    [0.36, dim(base, shade * 0.4)],
    [0.58, lit(base, lift)],
    [0.74 - width, lit(base, spec * 0.28 + lift)],
    [0.74, lit(base, spec)],
    [0.74 + width, lit(base, spec * 0.32 + lift)],
    [0.93, lit(base, 0.07 + lift)],
    [1, dim(base, fall)],
  ];
}
// polished metal: high contrast, a dark horizon band, a hot specular
function metalStops(base, hot = 0.88) {
  return [
    [0, lit(base, 0.22)],
    [0.08, dim(base, 0.6)],
    [0.26, dim(base, 0.18)],
    [0.41, lit(base, 0.3)],
    [0.5, dim(base, 0.46)],
    [0.6, dim(base, 0.05)],
    [0.73, lit(base, hot)],
    [0.8, lit(base, 0.36)],
    [0.92, base],
    [1, dim(base, 0.34)],
  ];
}

// ------------------------------------------------------------------ paths (local units)
// Every closed outline runs the same way (tip side from -v to +v, then back along +v, across
// the back, forward along -v), so the union of all parts fills correctly with 'nonzero'.

// cylinder / truncated cone piece from u0 to u1; bf, bb = seam depth at the front / back
function sleeve(u0, u1, r0, r1 = r0, bf = BULGE, bb = BULGE) {
  const p = new Path2D();
  p.moveTo(u0, -r0);
  if (r0 > 0 && bf > 0) p.ellipse(u0, 0, bf * r0, r0, 0, -HALF, HALF, true);
  else p.lineTo(u0, r0);
  p.lineTo(u1, r1);
  if (r1 > 0 && bb > 0) p.ellipse(u1, 0, bb * r1, r1, 0, HALF, HALF * 3, false);
  else p.lineTo(u1, -r1);
  p.closePath();
  return p;
}

// cone with its apex at uA (radius = slope * (u - uA)), drawn from u0 to u1. When it starts at
// the apex the point is rounded over `round` so the extreme point is exactly (uA, 0).
function conePath(uA, slope, u1, round = 0, u0 = uA) {
  const p = new Path2D();
  if (u0 <= uA + 1e-9) {
    if (round > 0) {
      p.moveTo(uA + round, -slope * round);
      p.quadraticCurveTo(uA - round, 0, uA + round, slope * round);
    } else p.moveTo(uA, 0);
  } else {
    const r0 = slope * (u0 - uA);
    p.moveTo(u0, -r0);
    p.ellipse(u0, 0, BULGE * r0, r0, 0, -HALF, HALF, true);
  }
  const r1 = slope * (u1 - uA);
  p.lineTo(u1, r1);
  p.ellipse(u1, 0, BULGE * r1, r1, 0, HALF, HALF * 3, false);
  p.closePath();
  return p;
}

// full end-face ellipse centred at u
function endFace(u, r, b = BULGE) {
  const p = new Path2D();
  p.moveTo(u + b * r, 0);
  p.ellipse(u, 0, b * r, r, 0, 0, -TAU, true);
  return p;
}

// a seam (ring) across the body at u: open half-ellipse from -v to +v
function seam(u, r, b = BULGE) {
  const p = new Path2D();
  p.moveTo(u, -r);
  p.ellipse(u, 0, b * r, r, 0, -HALF, HALF, true);
  return p;
}

// flat pocket clip lying on top of a cap: rounded front end at u0, root at u1
function clipPath(u0, u1, w0, w1 = w0) {
  const p = new Path2D();
  p.moveTo(u0, -w0);
  p.ellipse(u0, 0, w0, w0, 0, -HALF, HALF, true);
  p.lineTo(u1, w1);
  p.lineTo(u1, -w1);
  p.closePath();
  return p;
}

// closed outline from a sampled radius profile: tip point first (the extreme), then +v side,
// a back arc, and the -v side back to the tip
function profilePath(pts, uBack, rBack, rOf = r => r, bb = BULGE) {
  const p = new Path2D();
  p.moveTo(pts[0][0], 0);
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], rOf(pts[i][1], 1, i));
  p.lineTo(uBack, rBack);
  p.ellipse(uBack, 0, bb * rBack, rBack, 0, HALF, HALF * 3, false);
  for (let i = pts.length - 1; i >= 1; i--) p.lineTo(pts[i][0], -rOf(pts[i][1], -1, i));
  p.closePath();
  return p;
}

// ------------------------------------------------------------------ the kit a tool is built with

function makeKit(g, ink, pxu) {
  const parts = [], under = [], over = [], bloom = [];
  const K = {
    g, ink, pxu,
    fine: pxu >= 140,            // enough pixels for engraving, grooves, texture
    px: n => n / pxu,            // n device pixels in local units
    parts, over,
    under,                       // paper effects below the tool (dust, light spill)
    bloom,                       // light effects above it (glow)
    shadowStrength: 1,
    // add a filled part; `detail(g)` runs clipped to the part; opt: { outline, cast }
    part(path, fill, detail, opt = {}) {
      parts.push({ path, fill, detail: detail || null, outline: opt.outline !== false, cast: opt.cast !== false });
    },
    cyl(r, stops, a = 1) {
      const gr = g.createLinearGradient(0, -r, 0, r);
      for (const [t, c, ca] of stops) gr.addColorStop(clamp(t, 0, 1), css(c, (ca == null ? 1 : ca) * a));
      return gr;
    },
    // conic shading for a cone with apex at uA: lines of equal shade converge at the apex
    cone(uA, slope, stops, rMax) {
      if (!g.createConicGradient) return K.cyl(rMax, stops);
      const gr = g.createConicGradient(-Math.PI, uA, 0);
      for (const [t, c, ca] of stops) {
        gr.addColorStop(clamp(0.5 + Math.atan((2 * t - 1) * slope) / TAU, 0, 1), css(c, ca == null ? 1 : ca));
      }
      return gr;
    },
    along(u0, u1, stops) {
      const gr = g.createLinearGradient(u0, 0, u1, 0);
      for (const [t, c, a] of stops) gr.addColorStop(clamp(t, 0, 1), css(c, a == null ? 1 : a));
      return gr;
    },
    // engraved ring: dark line with a light line just behind it
    groove(u, r, strength = 1, b = BULGE) {
      const w = Math.max(K.px(0.9), 0.0016);
      g.lineWidth = w;
      g.strokeStyle = `rgba(0,0,0,${0.45 * strength})`;
      g.stroke(seam(u, r * 1.05, b));
      g.strokeStyle = `rgba(255,255,255,${0.35 * strength})`;
      g.save(); g.translate(w * 1.1, 0); g.stroke(seam(u, r * 1.05, b)); g.restore();
    },
    line(u0, v0, u1, v1, color, w) {
      g.strokeStyle = color; g.lineWidth = w;
      g.beginPath(); g.moveTo(u0, v0); g.lineTo(u1, v1); g.stroke();
    },
    // printed lettering along the body, reading from the tip toward the back end. Set in device
    // pixels (tiny fractional font sizes under a big transform render unreliably), and only
    // when it is big enough to be lettering rather than noise.
    text(str, u, v, h, color, { weight = 600, align = 'left', spacing = 0 } = {}) {
      if (h * pxu < 5) return;
      g.save();
      g.translate(u, v);
      g.scale(1 / pxu, 1 / pxu);
      g.font = `${weight} ${(h * pxu).toFixed(2)}px "Geist", "Helvetica Neue", Arial, sans-serif`;
      g.textBaseline = 'middle';
      g.textAlign = align;
      g.fillStyle = color;
      if ('letterSpacing' in g) g.letterSpacing = `${(spacing * pxu).toFixed(2)}px`;
      g.fillText(str, 0, 0);
      g.restore();
    },
    silhouette() {
      const s = new Path2D();
      for (const p of parts) if (p.cast) s.addPath(p.path);
      return s;
    },
  };
  return K;
}

// hexagonal pencil barrel seen with one face toward the eye: three facets as a stepped
// gradient; each step is ~1 device pixel wide (gradient stops are not antialiased, so a
// thinner step would alias into dots along the slanted body)
function hexStops(base, pxu, R, ridgeLight = 0.55) {
  const tw = clamp(0.55 / (R * pxu), 0.006, 0.07);
  return [
    [0, dim(base, 0.4)], [0.18, dim(base, 0.27)], [0.25 - tw, dim(base, 0.24)],
    [0.25, dim(base, 0.42)],
    [0.25 + tw, dim(base, 0.05)], [0.45, base], [0.6, lit(base, 0.12)], [0.68, lit(base, 0.3)],
    [0.75 - tw, lit(base, 0.16)],
    [0.75, lit(base, ridgeLight)],
    [0.75 + tw, lit(base, 0.24)], [0.86, lit(base, 0.4)], [0.94, lit(base, 0.2)], [1, dim(base, 0.06)],
  ];
}
// outline of a hexagonal body whose front is cut by a cone of `slope` (apex at u = 0): the
// paint ends in scallops that reach furthest toward the tip at the middle of each face
function hexCutPath(R, slope, uBack) {
  const Rf = R * Math.cos(Math.PI / 6);
  const p = new Path2D();
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const psi = -HALF + Math.PI * i / N;
    const k = Math.round(psi / (Math.PI / 3));
    const rho = Rf / Math.cos(psi - k * Math.PI / 3);
    const u = rho / slope - BULGE * rho * Math.cos(psi);
    const v = rho * Math.sin(psi);
    if (i) p.lineTo(u, v); else p.moveTo(u, v);
  }
  p.lineTo(uBack, R);
  p.ellipse(uBack, 0, BULGE * R, R, 0, HALF, HALF * 3, false);
  p.closePath();
  return p;
}

// ------------------------------------------------------------------ the tools
// len = length in units of size (1 for every kind: `size` is the tool's length, per the
// contract), maxR = widest radius, pad = extra room around the tip for glows / dust (for bounds).

const TOOLS = {};

TOOLS.pencil = {
  ink: '#2a2a2e', len: 1, maxR: 0.046, pad: 0.03,
  build(K) {
    const g = K.g, ink = K.ink;
    const R = 0.041, slope = R / 0.19;
    const coloured = chroma(ink) > 0.12;              // a coloured ink draws a coloured pencil
    const lead = coloured ? ink : [50, 50, 56];
    const paint = coloured ? ink : [247, 190, 32];
    const wood = [234, 194, 146];
    K.part(conePath(0, slope, 0.2, 0.0035), K.cone(0, slope, shadeStops(wood, MAT.matte), R), K.fine && (() => {
      // wood grain converging on the point
      g.lineWidth = K.px(0.8);
      for (const k of [-0.62, -0.25, 0.18, 0.55]) {
        g.strokeStyle = 'rgba(150,96,50,0.22)';
        g.beginPath(); g.moveTo(0.06, 0.06 * slope * k); g.lineTo(0.2, 0.2 * slope * (k + 0.06)); g.stroke();
      }
    }));
    K.part(conePath(0, slope, 0.056, 0.0035), K.cone(0, slope, shadeStops(lead, coloured ? MAT.satin : MAT.gloss), 0.012));
    const uBody = coloured ? 0.952 : 0.846;
    K.part(hexCutPath(R, slope, uBody + 0.006), K.cyl(R, hexStops(paint, K.pxu, R)), () => {
      // foil stamp on the centre facet
      const foil = coloured ? css([236, 206, 120], 0.9) : css([38, 34, 22], 0.78);
      K.text('SPIRALIST', 0.4, 0.001, 0.022, foil, { weight: 700, spacing: 0.0022 });
      if (!coloured) K.text('HB', 0.64, 0.001, 0.022, foil, { weight: 700 });   // a graphite grade
    });
    if (!coloured) {
      const Rm = R * 1.07;
      K.part(sleeve(0.842, 0.93, Rm), K.cyl(Rm, metalStops([200, 196, 184], 0.9)), K.fine && (() => {
        for (const u of [0.858, 0.87, 0.9, 0.912]) K.groove(u, Rm, 0.9);
        // crimp band
        g.fillStyle = 'rgba(40,36,30,0.18)';
        g.beginPath(); g.moveTo(0.878, -Rm); g.lineTo(0.894, -Rm); g.lineTo(0.894, Rm); g.lineTo(0.878, Rm); g.fill();
      }));
      const Re = R * 0.98, uE = 1 - BULGE * Re;
      const pink = [236, 132, 150];
      K.part(sleeve(0.925, uE, Re), K.cyl(Re, shadeStops(pink, MAT.matte)));
      K.part(endFace(uE, Re), K.cyl(Re, [[0, dim(pink, 0.2)], [0.5, lit(pink, 0.1)], [0.8, lit(pink, 0.22)], [1, lit(pink, 0.08)]]));
    } else {
      // dipped end, as on coloured pencils
      const Rd = R * 1.01, uE = 1 - BULGE * Rd * 0.8;
      K.part(sleeve(0.948, uE, Rd, Rd), K.cyl(Rd, shadeStops(dim(paint, 0.12), MAT.gloss)), () => {
        g.lineWidth = K.px(1.1);
        g.strokeStyle = 'rgba(255,255,255,0.7)';
        g.stroke(seam(0.958, Rd * 1.05));
      });
      K.part(endFace(uE, Rd, BULGE * 0.8), K.cyl(Rd, [[0, dim(paint, 0.35)], [0.7, lit(paint, 0.15)], [1, dim(paint, 0.1)]]));
    }
  },
};

TOOLS.fineliner = {
  ink: '#17171a', len: 1, maxR: 0.043, pad: 0.02,
  build(K) {
    const g = K.g, ink = K.ink;
    const black = [30, 31, 36], steel = [170, 174, 180];
    const rf = 0.0034;
    K.part(sleeve(rf, 0.024, rf, rf, 1), K.cyl(rf, shadeStops(luma(ink) > 0.6 ? dim(ink, 0.08) : lit(ink, 0.05), MAT.satin)));
    K.part(sleeve(0.02, 0.08, 0.0056, 0.0062), K.cyl(0.0062, metalStops(steel)));
    // front cone
    const c0 = 0.076, c1 = 0.178, r0 = 0.0105, r1 = 0.031, s = (r1 - r0) / (c1 - c0), uA = c0 - r0 / s;
    K.part(conePath(uA, s, c1, 0, c0), K.cone(uA, s, shadeStops(black, MAT.gloss), r1), K.fine && (() => {
      K.groove(0.09, s * (0.09 - uA), 0.6);
    }));
    // barrel with an ink-coloured band (fineliners wear their colour on the body)
    const Rb = 0.036, Rc = 0.041, uE = 1 - BULGE * Rc;
    K.part(sleeve(0.174, 0.72, Rb), K.cyl(Rb, shadeStops(black, MAT.satin)), () => {
      if (K.fine) {
        g.fillStyle = 'rgba(255,255,255,0.05)';
        for (let u = 0.2; u < 0.34; u += 0.012) g.fillRect(u, -Rb, 0.004, 2 * Rb);   // grip ribs
      }
      K.text('SPIRALIST', 0.385, 0.002, 0.017, 'rgba(236,236,240,0.62)', { weight: 600, spacing: 0.0016 });
      K.text('0.3', 0.525, 0.002, 0.017, 'rgba(236,236,240,0.62)', { weight: 600 });
    });
    K.part(sleeve(0.58, 0.625, Rb * 1.01), K.cyl(Rb, shadeStops(ink, MAT.gloss)));
    // posted cap with a clip
    K.part(sleeve(0.7, uE, Rc), K.cyl(Rc, shadeStops(black, MAT.gloss)), () => {
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fill(clipPath(0.742, uE, 0.0085));
    });
    K.part(endFace(uE, Rc), K.cyl(Rc, [[0, dim(ink, 0.35)], [0.55, ink], [0.8, lit(ink, 0.3)], [1, dim(ink, 0.2)]]));
    K.part(clipPath(0.735, uE - 0.004, 0.0072, 0.0082), K.cyl(0.0082, metalStops([120, 124, 130], 0.8)));
  },
};

TOOLS.fountain = {
  ink: '#141a3a', len: 1, maxR: 0.045, pad: 0.02,
  build(K) {
    const g = K.g;
    const gold = [214, 170, 72], black = [24, 22, 24], lacquer = [112, 22, 38];
    // nib
    const nib = new Path2D();
    nib.moveTo(0, 0);
    nib.bezierCurveTo(0.012, 0.0045, 0.06, 0.0155, 0.1, 0.0245);
    nib.bezierCurveTo(0.118, 0.0287, 0.131, 0.0262, 0.139, 0.0232);
    nib.lineTo(0.172, 0.0232);
    nib.lineTo(0.172, -0.0232);
    nib.lineTo(0.139, -0.0232);
    nib.bezierCurveTo(0.131, -0.0262, 0.118, -0.0287, 0.1, -0.0245);
    nib.bezierCurveTo(0.06, -0.0155, 0.012, -0.0045, 0, 0);
    nib.closePath();
    K.part(nib, K.cyl(0.029, metalStops(gold, 0.85)), () => {
      const w = Math.max(K.px(1), 0.0012);
      // slit, breather hole, engraving
      K.line(0.003, 0, 0.074, 0, 'rgba(40,24,6,0.9)', w);
      K.line(0.012, 0.0014, 0.07, 0.0014, 'rgba(255,240,200,0.35)', w * 0.7);
      g.fillStyle = 'rgba(30,18,4,0.95)';
      g.beginPath(); g.ellipse(0.078, 0, 0.0046, 0.0042, 0, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(255,236,180,0.5)'; g.lineWidth = w * 0.8;
      g.beginPath(); g.ellipse(0.078, 0.0006, 0.0052, 0.0048, 0, -0.2, 2.2); g.stroke();
      if (K.fine) {
        g.strokeStyle = 'rgba(90,60,10,0.5)'; g.lineWidth = w * 0.8;
        g.beginPath(); g.moveTo(0.14, 0.0165); g.quadraticCurveTo(0.088, 0.0165, 0.088, 0); g.quadraticCurveTo(0.088, -0.0165, 0.14, -0.0165); g.stroke();
        g.beginPath(); g.moveTo(0.14, 0.009); g.quadraticCurveTo(0.104, 0.009, 0.104, 0); g.quadraticCurveTo(0.104, -0.009, 0.14, -0.009); g.stroke();
      }
      // the section shades the back of the nib
      g.fillStyle = K.along(0.13, 0.17, [[0, BLACK, 0], [1, BLACK, 0.45]]);
      g.fillRect(0.13, -0.03, 0.045, 0.06);
      // iridium tipping
      g.fillStyle = 'rgba(210,214,220,0.9)';
      g.beginPath(); g.ellipse(0.0035, 0, 0.0035, 0.0023, 0, 0, TAU); g.fill();
    });
    // grip section, gold ring, barrel, posted cap
    K.part(sleeve(0.16, 0.288, 0.0255, 0.0305), K.cyl(0.0305, shadeStops(black, MAT.lacquer)));
    K.part(sleeve(0.284, 0.3, 0.0352), K.cyl(0.0352, metalStops(gold)));
    const Rb = 0.0365, Rc = 0.0415, uE = 1 - BULGE * Rc * 0.9;
    K.part(sleeve(0.296, 0.66, Rb), K.cyl(Rb, shadeStops(lacquer, MAT.lacquer)), () => {
      if (K.fine) {
        // celluloid striations
        g.lineWidth = K.px(1.2);
        for (let i = 0; i < 5; i++) {
          const v = (-0.7 + i * 0.33) * Rb;
          g.strokeStyle = i % 2 ? 'rgba(255,170,150,0.07)' : 'rgba(0,0,0,0.12)';
          g.beginPath(); g.moveTo(0.3, v);
          g.bezierCurveTo(0.4, v + 0.006, 0.5, v - 0.006, 0.66, v + 0.002); g.stroke();
        }
      }
      // ink window: the pen shows the colour it is loaded with
      const win = new Path2D(), w = 0.0105;
      win.moveTo(0.325, -w); win.ellipse(0.325, 0, w, w, 0, -HALF, HALF, true);
      win.lineTo(0.395, w); win.ellipse(0.395, 0, w, w, 0, HALF, HALF * 3, true); win.closePath();
      g.fillStyle = K.cyl(w, [[0, dim(K.ink, 0.3)], [0.5, lit(K.ink, 0.12)], [0.75, lit(K.ink, 0.55)], [1, K.ink]]);
      g.fill(win);
      g.lineWidth = Math.max(K.px(1), 0.0014);
      g.strokeStyle = 'rgba(0,0,0,0.55)'; g.stroke(win);
    });
    K.part(sleeve(0.635, uE, Rc, Rc, BULGE, BULGE * 0.9), K.cyl(Rc, shadeStops(lacquer, MAT.lacquer)), () => {
      g.fillStyle = 'rgba(0,0,0,0.4)';
      g.fill(clipPath(0.73, uE, 0.0095));
    });
    K.part(sleeve(0.648, 0.678, Rc * 1.005), K.cyl(Rc, metalStops(gold)), K.fine && (() => {
      g.fillStyle = 'rgba(90,60,10,0.35)';
      for (let v = -0.036; v < 0.036; v += 0.006) g.fillRect(0.66, v, 0.006, 0.0022);
    }));
    K.part(endFace(uE, Rc, BULGE * 0.9), K.cyl(Rc, [[0, dim(lacquer, 0.5)], [0.6, lacquer], [0.85, lit(lacquer, 0.3)], [1, dim(lacquer, 0.3)]]), () => {
      g.fillStyle = K.cyl(0.012, metalStops(gold));
      g.beginPath(); g.ellipse(uE, 0, 0.0043, 0.012, 0, 0, TAU); g.fill();
    });
    // clip with a ball end
    K.part(clipPath(0.728, uE - 0.006, 0.0082, 0.0068), K.cyl(0.0085, metalStops(gold)));
    const ball = new Path2D();
    ball.moveTo(0.735 + 0.0095, 0); ball.ellipse(0.735, 0, 0.0095, 0.0095, 0, 0, -TAU, true);
    K.part(ball, (() => {
      const gr = g.createRadialGradient(0.732, 0.004, 0.001, 0.735, 0, 0.0095);
      gr.addColorStop(0, css(lit(gold, 0.85))); gr.addColorStop(0.5, css(gold)); gr.addColorStop(1, css(dim(gold, 0.5)));
      return gr;
    })());
  },
};

TOOLS.crayon = {
  ink: '#c8372d', len: 1, maxR: 0.052, pad: 0.02,
  build(K) {
    const g = K.g, ink = K.ink;
    // a real crayon is about 11 diameters long; the wrapper covers all but the two ends
    const R = 0.05, len = 1, uE = len - BULGE * R, w0 = 0.152, w1 = 0.9;
    const wax = ink;
    const rt = 0.0135, bf = 0.95, u0 = bf * rt, u1 = 0.1;
    const s = (R - rt) / (u1 - u0), uA = u0 - rt / s;
    K.part(sleeve(u0, u1 + 0.004, rt, R, bf), K.cone(uA, s, shadeStops(wax, MAT.wax), R), () => {
      // worn facet where the tip rubs the paper
      g.fillStyle = css(lit(wax, 0.2), 0.55);
      g.beginPath(); g.ellipse(0.016, 0.004, 0.014, 0.0095, -0.35, 0, TAU); g.fill();
    });
    K.part(sleeve(0.1, 0.16, R), K.cyl(R, shadeStops(wax, MAT.wax)));
    // printed paper wrapper
    const Rw = R * 1.02;
    const lineC = luma(ink) > 0.28 ? [22, 20, 18] : [238, 226, 196];
    K.part(sleeve(w0, w1, Rw), K.cyl(Rw, shadeStops(lit(ink, 0.04), MAT.matte)), () => {
      const w = Math.max(K.px(1), 0.0016);
      g.strokeStyle = css(lineC, 0.75);
      g.lineWidth = w;
      for (const u of [w0 + 0.016, w0 + 0.024, w1 - 0.024, w1 - 0.016]) g.stroke(seam(u, Rw));
      if (!K.fine) return;          // below this the pattern is noise; keep only the bands
      // zigzag bands
      for (const u0z of [w0 + 0.038, w1 - 0.034]) {
        g.beginPath();
        const n = 9;
        for (let i = 0; i <= n; i++) {
          const v = -Rw + 2 * Rw * i / n;
          const bulge = BULGE * Math.sqrt(Math.max(0, Rw * Rw - v * v));
          const u = u0z - bulge + (i % 2 ? 0.009 : 0);
          if (i) g.lineTo(u, v); else g.moveTo(u, v);
        }
        g.stroke();
      }
      // label oval
      const uL = 0.46;
      g.lineWidth = w * 1.1;
      g.beginPath(); g.ellipse(uL, 0, 0.1, Rw * 0.62, 0, 0, TAU); g.stroke();
      K.text('SPIRALIST', uL, 0.001, 0.021, css(lineC, 0.85), { weight: 800, align: 'center', spacing: 0.001 });
      // wrapper seam, a little paper lip on the shadow side
      K.line(w0, -Rw * 0.62, w1, -Rw * 0.62, 'rgba(0,0,0,0.12)', w);
    });
    K.part(sleeve(w1 - 0.006, uE, R), K.cyl(R, shadeStops(wax, MAT.wax)));
    K.part(endFace(uE, R), K.cyl(R, [[0, dim(wax, 0.3)], [0.55, lit(wax, 0.06)], [0.85, lit(wax, 0.2)], [1, dim(wax, 0.1)]]));
  },
};

TOOLS.ballpoint = {
  ink: '#1d3a8a', len: 1, maxR: 0.04, pad: 0.02,
  build(K) {
    const g = K.g, ink = K.ink;
    K.shadowStrength = 0.72;                       // clear plastic lets light through
    const R = 0.036, uE = 1 - BULGE * R * 0.8;
    const brass = [200, 164, 92], steel = [196, 198, 204];
    // refill inside the clear body (drawn first, seen through it)
    K.part(sleeve(0.05, 0.94, 0.0084), K.cyl(0.0084, shadeStops([236, 236, 230], MAT.satin), 0.92), () => {
      g.fillStyle = K.cyl(0.0084, shadeStops(ink, MAT.gloss), 0.95);
      g.fillRect(0.2, -0.01, 0.62, 0.02);
      g.fillStyle = K.along(0.8, 0.83, [[0, ink, 0.95], [1, ink, 0]]);
      g.fillRect(0.8, -0.01, 0.03, 0.02);
    }, { outline: false, cast: false });
    // ball and brass point
    const ball = new Path2D();
    ball.moveTo(0.0068, 0); ball.ellipse(0.0034, 0, 0.0034, 0.0034, 0, 0, -TAU, true);
    const s = (0.0088 - 0.0026) / (0.052 - 0.0042), uA = 0.0042 - 0.0026 / s;
    K.part(conePath(uA, s, 0.052, 0, 0.0042), K.cone(uA, s, metalStops(brass), 0.0088));
    K.part(ball, K.cyl(0.0034, metalStops(steel)));
    // clear front cone and hexagonal barrel
    const cs = (R * 0.93 - 0.0098) / (0.168 - 0.047), cA = 0.047 - 0.0098 / cs;
    // facet ridges as ~1 px soft lines: gradient stops are not antialiased, so a thinner step
    // would alias into dots along the slanted body
    const tw = clamp(0.55 / (R * K.pxu), 0.012, 0.09);
    // Below ~10 px of radius the two ridges and the bands between them are each a pixel or two
    // wide and stair-step into a checker along the slanted body (worst on dark paper), so they
    // fade into a plain clear-tube gradient as the pen gets small.
    const k = clamp((R * K.pxu - 3.5) / 7, 0, 1), rk = (a0, a1) => a0 + (a1 - a0) * k;
    const clear = [[0, [40, 64, 104], 0.62], [0.1, [120, 150, 190], rk(0.3, 0.4)], [0.25 - tw, [205, 222, 245], rk(0.24, 0.22)],
      [0.25, [255, 255, 255], rk(0.3, 0.85)], [0.25 + tw, [215, 230, 250], rk(0.22, 0.12)], [0.5, [220, 232, 248], rk(0.18, 0.08)],
      [0.75 - tw, [230, 240, 255], rk(0.26, 0.14)], [0.75, [255, 255, 255], rk(0.42, 0.95)], [0.75 + tw, [235, 244, 255], rk(0.4, 0.3)],
      [0.88, [240, 247, 255], rk(0.42, 0.5)], [0.95, [200, 215, 235], 0.4], [1, [60, 84, 120], 0.6]];
    K.part(conePath(cA, cs, 0.168, 0, 0.047), K.cone(cA, cs, clear, R));
    K.part(sleeve(0.162, 0.945, R), K.cyl(R, clear), K.fine && (() => {
      // the little breather hole
      g.fillStyle = 'rgba(20,30,50,0.55)';
      g.beginPath(); g.ellipse(0.3, 0.004, 0.0028, 0.0045, 0, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = K.px(0.8);
      g.beginPath(); g.ellipse(0.3, 0.0048, 0.0028, 0.0045, 0, 0.3, 2.6); g.stroke();
    }));
    // end plug in the ink colour
    const Rp = R * 0.8;
    K.part(sleeve(0.935, uE, Rp, Rp, BULGE, BULGE * 0.8), K.cyl(Rp, shadeStops(ink, MAT.gloss)), K.fine && (() => {
      g.lineWidth = K.px(1);
      for (const u of [0.95, 0.962]) { g.strokeStyle = 'rgba(0,0,0,0.35)'; g.stroke(seam(u, Rp * 1.05)); }
    }));
    K.part(endFace(uE, Rp, BULGE * 0.8), K.cyl(Rp, [[0, dim(ink, 0.35)], [0.6, lit(ink, 0.1)], [0.85, lit(ink, 0.3)], [1, dim(ink, 0.2)]]));
  },
};

TOOLS.marker = {
  ink: '#1f2a44', len: 1, maxR: 0.062, pad: 0.02,
  build(K) {
    const g = K.g, ink = K.ink;
    const R = 0.056, Rc = R * 1.08, uE = 1 - BULGE * Rc;
    const body = [238, 236, 231], grey = [196, 199, 204];
    // chisel felt nib: the working corner sits on (0, 0)
    const nib = new Path2D();
    nib.moveTo(0, 0);
    nib.lineTo(0.03, 0.0175);
    nib.lineTo(0.078, 0.019);
    nib.lineTo(0.078, -0.019);
    nib.lineTo(0.006, -0.0175);
    nib.quadraticCurveTo(0.0, -0.016, 0, 0);
    nib.closePath();
    const felt = luma(ink) > 0.75 ? dim(ink, 0.08) : ink;
    K.part(nib, K.cyl(0.019, shadeStops(felt, MAT.matte)), () => {
      // the chisel face catches the light
      g.fillStyle = css(lit(felt, 0.22), 0.8);
      g.beginPath(); g.moveTo(0, 0); g.lineTo(0.03, 0.0175); g.lineTo(0.042, 0.0175); g.lineTo(0.012, -0.004); g.closePath(); g.fill();
    });
    const c0 = 0.06, c1 = 0.168, r0 = 0.021, r1 = 0.048, s = (r1 - r0) / (c1 - c0), uA = c0 - r0 / s;
    K.part(conePath(uA, s, c1, 0, c0), K.cone(uA, s, shadeStops(grey, MAT.satin), r1));
    K.part(sleeve(0.162, 0.19, R), K.cyl(R, shadeStops(ink, MAT.gloss)));
    K.part(sleeve(0.186, 0.76, R), K.cyl(R, shadeStops(body, MAT.satin)), () => {
      // printed rings follow the curvature of the barrel like every other seam
      g.strokeStyle = css(ink, 0.85);
      g.lineWidth = 0.011; g.stroke(seam(0.345, R * 1.05));
      g.lineWidth = Math.max(0.004, K.px(1)); g.stroke(seam(0.364, R * 1.05));
      K.text('SPIRALIST', 0.405, 0.003, 0.03, css(dim(ink, 0.15), 0.9), { weight: 800, spacing: 0.002 });
      K.text('PERMANENT', 0.405, 0.028, 0.014, 'rgba(60,60,64,0.55)', { weight: 600, spacing: 0.002 });
    });
    K.part(sleeve(0.74, uE, Rc), K.cyl(Rc, shadeStops(ink, MAT.gloss)), () => {
      g.fillStyle = 'rgba(0,0,0,0.4)';
      g.fill(clipPath(0.775, uE, 0.011));
      if (K.fine) for (const u of [0.755, 0.765]) K.groove(u, Rc, 0.6);
    });
    K.part(endFace(uE, Rc), K.cyl(Rc, [[0, dim(ink, 0.4)], [0.55, ink], [0.85, lit(ink, 0.28)], [1, dim(ink, 0.2)]]));
    K.part(clipPath(0.768, uE - 0.004, 0.0095, 0.0105), K.cyl(0.0105, shadeStops(dim(ink, 0.15), MAT.gloss)));
  },
};

TOOLS.brush = {
  ink: '#0e0e0e', len: 1, maxR: 0.037, pad: 0.02,
  build(K) {
    const g = K.g, ink = K.ink;
    const hairEnd = 0.23, rb = 0.035, rf = 0.029, tb = 0.66;
    const prof = u => {
      const t = u / hairEnd;
      if (t <= tb) return rb * Math.pow(1 - Math.pow(1 - t / tb, 2), 0.85);
      const k = (t - tb) / (1 - tb);
      return rb - (rb - rf) * k * k;
    };
    const pts = [];
    for (let i = 0; i <= 40; i++) { const u = hairEnd * Math.pow(i / 40, 1.3); pts.push([u, prof(u)]); }
    // the loaded tip bends a touch toward the shadow side
    const hair = profilePath(pts, hairEnd + 0.004, rf, (r, side, i) => r * (1 + side * 0.06 * (1 - i / 40)));
    const natural = [214, 190, 150];
    const tip = luma(ink) > 0.5 ? dim(ink, 0.1) : ink;
    K.part(hair, K.along(0, hairEnd, [[0, tip], [0.42, tip], [0.66, mix(tip, natural, 0.55)], [0.82, natural], [1, dim(natural, 0.15)]]), () => {
      g.fillStyle = K.cyl(rb, [[0, BLACK, 0.45], [0.25, BLACK, 0.12], [0.55, BLACK, 0], [0.78, WHITE, 0.18], [0.9, WHITE, 0.06], [1, BLACK, 0.25]]);
      g.fillRect(0, -rb * 1.2, hairEnd + 0.01, rb * 2.4);
      if (K.fine) {
        // hair strands
        g.lineWidth = K.px(0.8);
        for (let i = 0; i < 14; i++) {
          const k = -0.85 + 1.7 * (i / 13) + 0.04 * hash(i);
          g.strokeStyle = i % 3 ? 'rgba(0,0,0,0.18)' : 'rgba(255,245,220,0.2)';
          g.beginPath();
          for (let j = 0; j <= 12; j++) {
            const u = 0.02 + (hairEnd - 0.02) * j / 12;
            const v = k * prof(u) * 0.92;
            if (j) g.lineTo(u, v); else g.moveTo(u, v);
          }
          g.stroke();
        }
      }
      // wet sheen near the tip
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.lineWidth = Math.max(K.px(1.2), 0.002);
      g.beginPath();
      for (let j = 0; j <= 10; j++) {
        const u = 0.02 + 0.1 * j / 10;
        const v = prof(u) * 0.45;
        if (j) g.lineTo(u, v); else g.moveTo(u, v);
      }
      g.stroke();
    });
    // lacquered collar
    const lac = [30, 22, 20];
    K.part(sleeve(0.222, 0.285, 0.0305, 0.0315), K.cyl(0.0315, shadeStops(lac, MAT.lacquer)), () => {
      g.lineWidth = Math.max(K.px(1.2), 0.0018);
      g.strokeStyle = 'rgba(220,180,90,0.9)';
      g.stroke(seam(0.274, 0.033));
    });
    // bamboo handle with two nodes
    const bamboo = [220, 194, 134], Rh = 0.0272;
    K.part(sleeve(0.28, 0.935, Rh), K.cyl(Rh, shadeStops(bamboo, MAT.satin)), K.fine && (() => {
      g.lineWidth = K.px(0.8);
      for (let i = 0; i < 6; i++) {
        const v = (-0.8 + i * 0.32) * Rh;
        g.strokeStyle = i % 2 ? 'rgba(120,90,40,0.16)' : 'rgba(255,250,230,0.14)';
        g.beginPath(); g.moveTo(0.29, v); g.lineTo(0.93, v + 0.001 * hash(i + 7)); g.stroke();
      }
    }));
    for (const u of [0.52, 0.78]) {
      K.part(sleeve(u - 0.008, u + 0.008, Rh * 1.1), K.cyl(Rh * 1.1, shadeStops(dim(bamboo, 0.05), MAT.satin)), () => {
        g.lineWidth = Math.max(K.px(1), 0.0015);
        g.strokeStyle = 'rgba(90,60,20,0.55)'; g.stroke(seam(u - 0.002, Rh * 1.15));
        g.strokeStyle = 'rgba(255,248,225,0.5)'; g.stroke(seam(u + 0.003, Rh * 1.15));
      });
    }
    const uE = 0.955 - BULGE * 0.026;
    K.part(sleeve(0.93, uE, 0.026), K.cyl(0.026, shadeStops(lac, MAT.lacquer)));
    K.part(endFace(uE, 0.026), K.cyl(0.026, [[0, dim(lac, 0.3)], [0.7, lit(lac, 0.25)], [1, lac]]));
    // silk hanging loop
    K.over.push(() => {
      g.strokeStyle = 'rgb(170,40,34)';
      g.lineWidth = Math.max(K.px(1.2), 0.0042);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(uE + 0.004, -0.004);
      g.bezierCurveTo(0.985, -0.022, 1.0, -0.006, 0.996, 0.004);
      g.bezierCurveTo(0.992, 0.016, 0.975, 0.014, uE + 0.004, 0.004);
      g.stroke();
    });
  },
};

TOOLS.charcoal = {
  ink: '#1b1715', len: 1, maxR: 0.036, pad: 0.06,
  build(K) {
    const g = K.g;
    const R = 0.031, len = 1;          // a vine stick: long and thin
    // irregular vine stick: noisy sides, a sanded chisel at the tip, a broken back end
    const p = new Path2D();
    p.moveTo(0, 0);
    p.quadraticCurveTo(0.004, R * 0.7, 0.024, R * 0.93);
    const N = 30;
    for (let i = 1; i <= N; i++) {
      const u = 0.024 + (len - 0.034) * i / N;
      p.lineTo(u, R * (1 + 0.08 * wobble(u, 1)));
    }
    for (const [u, v] of [[len - 0.001, R * 0.5], [len - 0.011, R * 0.12], [len - 0.004, -R * 0.3], [len - 0.019, -R * 0.93]]) p.lineTo(u, v);
    for (let i = N; i >= 1; i--) {
      const u = 0.085 + (len - 0.105) * i / N;
      p.lineTo(u, -R * (1 + 0.08 * wobble(u, 2)));
    }
    p.lineTo(0.085, -R * 0.98);
    p.closePath();
    // matte, with the faint silvery sheen of carbon; the ink picks vine, compressed or sanguine
    const coal = mix([36, 33, 32], K.ink, 0.85), sheen = mix(coal, [150, 152, 162], 0.42);
    K.part(p, K.cyl(R * 1.08, [[0, lit(coal, 0.24)], [0.12, dim(coal, 0.35)], [0.45, coal], [0.64, mix(coal, sheen, 0.5)],
      [0.75, sheen], [0.86, mix(coal, sheen, 0.45)], [0.95, dim(coal, 0.05)], [1, dim(coal, 0.25)]]), () => {
      // sanded working face: flat, velvety, a little lighter
      g.fillStyle = K.along(0, 0.085, [[0, lit(coal, 0.3)], [1, lit(coal, 0.12)]]);
      g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(0.004, R * 0.7, 0.024, R * 0.93);
      g.quadraticCurveTo(0.05, 0, 0.085, -R * 0.98); g.closePath(); g.fill();
      if (!K.fine) return;
      // the twig's fibres run along the stick
      g.lineWidth = K.px(0.8);
      for (let i = 0; i < 14; i++) {
        const v0 = (-0.88 + i * 0.135) * R, a = 0.09 + 0.06 * (hash(i) + 1), b = len - 0.03 - 0.08 * (hash(i + 3) + 1);
        g.strokeStyle = i % 2 ? 'rgba(170,170,182,0.14)' : 'rgba(0,0,0,0.3)';
        g.beginPath();
        for (let j = 0; j <= 8; j++) {
          const u = a + (b - a) * j / 8, v = v0 + 0.0012 * wobble(u * 3, i);
          if (j) g.lineTo(u, v); else g.moveTo(u, v);
        }
        g.stroke();
      }
      const sparkle = new Path2D();
      for (let i = 0; i < 90; i++) {
        const u = 0.1 + (len - 0.14) * (hash(i * 2 + 41) + 1) / 2, v = R * 0.9 * hash(i * 2 + 42), r = 0.0006 + 0.0005 * (hash(i + 7) + 1);
        sparkle.moveTo(u + r, v); sparkle.arc(u, v, r, 0, TAU);
      }
      g.fillStyle = 'rgba(200,200,212,0.2)'; g.fill(sparkle);
      // hairline cracks across the stick, where a twig would snap
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.beginPath(); g.moveTo(0.31, -R); g.quadraticCurveTo(0.302, -R * 0.2, 0.312, R * 0.35); g.stroke();
      g.beginPath(); g.moveTo(0.664, R); g.quadraticCurveTo(0.672, R * 0.1, 0.661, -R * 0.45); g.stroke();
    });
    // loose dust on the paper around the tip
    K.under.push(() => grains(g, 30, 3, 0.01, 0.045, -0.01, 0.04, 0.0007, 0.0011, i => `rgba(30,26,24,${0.3 + 0.14 * (i % 3)})`));
  },
};

TOOLS.chalk = {
  ink: '#f3f0e8', len: 1, maxR: 0.058, pad: 0.08,
  build(K) {
    const g = K.g, ink = K.ink;
    // a stick of blackboard chalk, ~9:1, tapering a little toward the writing end as they do
    const R = 0.055, Rt = 0.047, len = 1, uE = len - BULGE * R;
    const tint = luma(ink) > 0.55 ? mix(ink, [248, 246, 240], 0.3) : mix(ink, [248, 246, 240], 0.55);
    const bf = 0.72;
    const stops = [[0, lit(dim(tint, 0.25), 0.1)], [0.12, dim(tint, 0.28)], [0.4, dim(tint, 0.1)], [0.62, tint],
      [0.8, lit(tint, 0.3)], [0.93, lit(tint, 0.16)], [1, dim(tint, 0.14)]];
    K.part(sleeve(bf * Rt, uE, Rt, R, bf), K.cyl(R, stops), () => {
      // worn, powdery tip: a flat facet rubbed at the writing angle
      g.fillStyle = K.along(0, 0.08, [[0, lit(tint, 0.6), 0.85], [1, lit(tint, 0.6), 0]]);
      g.fillRect(0, -R, 0.08, 2 * R);
      g.fillStyle = css(lit(tint, 0.5), 0.6);
      g.beginPath(); g.ellipse(0.018, 0.004, 0.014, Rt * 0.72, 0, 0, TAU); g.fill();
      if (!K.fine) return;
      // chalky grain: fine pits and soft powder patches, no lines
      const pits = new Path2D(), powder = new Path2D();
      for (let i = 0; i < 330; i++) {
        const u = 0.02 + (len - 0.04) * (hash(i * 2 + 5) + 1) / 2, v = R * 0.96 * hash(i * 2 + 6);
        const r = 0.0005 + 0.0005 * (hash(i + 99) + 1);
        pits.moveTo(u + r, v); pits.arc(u, v, r, 0, TAU);
      }
      for (let i = 0; i < 56; i++) {
        const u = 0.03 + (len - 0.08) * (hash(i * 3 + 51) + 1) / 2, v = R * 0.8 * hash(i * 3 + 52);
        const r = 0.002 + 0.002 * (hash(i + 17) + 1);
        powder.moveTo(u + r, v); powder.arc(u, v, r, 0, TAU);
      }
      g.fillStyle = 'rgba(60,56,50,0.07)'; g.fill(pits);
      g.fillStyle = css(lit(tint, 0.7), 0.22); g.fill(powder);
    });
    K.part(endFace(uE, R), K.cyl(R, [[0, dim(tint, 0.2)], [0.6, tint], [0.85, lit(tint, 0.3)], [1, dim(tint, 0.1)]]), K.fine && (() => {
      g.fillStyle = 'rgba(0,0,0,0.08)';
      g.beginPath(); g.moveTo(uE + 0.004, -R); g.lineTo(uE + 0.013, -R * 0.4); g.lineTo(uE + 0.003, -R * 0.1); g.lineTo(uE - 0.004, -R * 0.6); g.fill();
    }));
    // dust: a soft powder haze and loose grains on the paper
    K.under.push(() => {
      const gr = g.createRadialGradient(0.012, -0.004, 0, 0.012, -0.004, 0.06);
      gr.addColorStop(0, css(tint, 0.26)); gr.addColorStop(0.5, css(tint, 0.08)); gr.addColorStop(1, css(tint, 0));
      g.fillStyle = gr;
      g.beginPath(); g.arc(0.012, -0.004, 0.06, 0, TAU); g.fill();
      grains(g, 34, 5, 0.01, 0.05, -0.01, 0.05, 0.0008, 0.0012, i => css(lit(tint, 0.2), 0.4 + 0.2 * (i % 3)));
    });
  },
};

TOOLS.neon = {
  ink: '#ff45e9', len: 1, maxR: 0.042, pad: 0.13,
  build(K) {
    const g = K.g, ink = K.ink;
    const glow = luma(ink) < 0.25 ? lit(ink, 0.35) : ink;       // a light pen always emits light
    const gun = [44, 48, 56], chrome = [196, 200, 208];
    K.shadowStrength = 0.85;
    // light spill on the paper around the tip
    K.under.push(() => {
      const gr = g.createRadialGradient(0.004, 0, 0, 0.004, 0, 0.12);
      gr.addColorStop(0, css(glow, 0.5)); gr.addColorStop(0.3, css(glow, 0.2)); gr.addColorStop(1, css(glow, 0));
      g.fillStyle = gr;
      g.beginPath(); g.arc(0.004, 0, 0.12, 0, TAU); g.fill();
    });
    // glass tip
    const s = 0.02 / 0.098;
    K.part(conePath(0, s, 0.1, 0.004), K.along(0, 0.1, [[0, lit(glow, 0.9)], [0.3, lit(glow, 0.45)], [0.7, glow], [1, dim(glow, 0.35)]]), () => {
      g.fillStyle = K.cone(0, s, [[0, BLACK, 0.35], [0.3, BLACK, 0.05], [0.6, WHITE, 0], [0.76, WHITE, 0.55], [0.86, WHITE, 0.08], [1, BLACK, 0.2]], 0.02);
      g.fillRect(0, -0.03, 0.11, 0.06);
    });
    K.part(sleeve(0.096, 0.126, 0.0235, 0.0245), K.cyl(0.0245, metalStops(chrome)));
    const r0 = 0.026, r1 = 0.0315, uE = 1 - BULGE * r1 * 0.9;
    K.part(sleeve(0.12, uE, r0, r1, BULGE, BULGE * 0.9), K.cyl(r1, shadeStops(gun, MAT.lacquer)), () => {
      // glowing light strip along the top and a status ring
      g.save();
      g.shadowColor = css(glow, 0.9);
      g.shadowBlur = Math.max(2, 0.02 * K.pxu);
      g.fillStyle = css(lit(glow, 0.55));
      const st = new Path2D();
      st.moveTo(0.22, -0.0034); st.ellipse(0.22, 0, 0.0034, 0.0034, 0, -HALF, HALF, true);
      st.lineTo(0.5, 0.0034); st.ellipse(0.5, 0, 0.0034, 0.0034, 0, HALF, HALF * 3, true);
      st.closePath();
      g.fill(st);
      g.lineWidth = Math.max(K.px(1.6), 0.004);
      g.strokeStyle = css(lit(glow, 0.4));
      g.stroke(seam(0.84, 0.031));
      g.restore();
      // ink-coloured reflection on the shadow edge
      g.fillStyle = K.cyl(r1, [[0, glow, 0.45], [0.12, glow, 0], [1, glow, 0]]);
      g.fillRect(0.12, -r1, 0.4, 2 * r1);
    });
    K.part(endFace(uE, r1, BULGE * 0.9), K.cyl(r1, metalStops(chrome)));
    // bloom over the glass. Plain source-over, not 'lighter': additive light would look
    // different once the sprite goes through a layer (alpha, motion blur) and the tip would
    // pulse between still and moving frames of a film.
    K.bloom.push(() => {
      const gr = g.createRadialGradient(0.012, 0, 0, 0.012, 0, 0.045);
      gr.addColorStop(0, css(lit(glow, 0.75), 0.8)); gr.addColorStop(0.18, css(lit(glow, 0.45), 0.45));
      gr.addColorStop(0.5, css(glow, 0.16)); gr.addColorStop(1, css(glow, 0));
      g.fillStyle = gr;
      g.beginPath(); g.arc(0.012, 0, 0.045, 0, TAU); g.fill();
    });
  },
};

TOOLS.goldpen = {
  ink: '#d9b44a', len: 1, maxR: 0.046, pad: 0.02,
  build(K) {
    const g = K.g, ink = K.ink;
    const metal = ink, black = [26, 26, 30];
    const rt = 0.0078;
    K.part(sleeve(rt, 0.045, rt, rt * 1.08, 1), K.cyl(rt, metalStops(metal)));
    const c0 = 0.038, c1 = 0.14, r0 = 0.0108, r1 = 0.036, s = (r1 - r0) / (c1 - c0), uA = c0 - r0 / s;
    K.part(conePath(uA, s, c1, 0, c0), K.cone(uA, s, shadeStops(black, MAT.lacquer), r1));
    const Rb = 0.04, Rc = 0.044, uE = 1 - BULGE * Rc;
    K.part(sleeve(0.136, 0.71, Rb), K.cyl(Rb, metalStops(metal, 0.8)), () => {
      // printed black band with fine metallic rules
      g.fillStyle = K.cyl(Rb, shadeStops(black, MAT.gloss));
      g.beginPath(); g.moveTo(0.36, -Rb); g.ellipse(0.36, 0, BULGE * Rb, Rb, 0, -HALF, HALF, true);
      g.lineTo(0.52, Rb); g.ellipse(0.52, 0, BULGE * Rb, Rb, 0, HALF, HALF * 3, false); g.closePath(); g.fill();
      if (K.fine) {
        g.lineWidth = K.px(1);
        g.strokeStyle = css(metal, 0.8);
        for (const u of [0.375, 0.505]) g.stroke(seam(u, Rb * 1.05));
      }
      K.text('PAINT', 0.44, 0.002, 0.024, css(lit(metal, 0.15), 0.95), { weight: 800, align: 'center', spacing: 0.003 });
    });
    K.part(sleeve(0.69, uE, Rc), K.cyl(Rc, shadeStops(black, MAT.lacquer)), () => {
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fill(clipPath(0.775, uE, 0.0105));
    });
    K.part(sleeve(0.72, 0.738, Rc * 1.005), K.cyl(Rc, metalStops(metal)));
    K.part(endFace(uE, Rc), K.cyl(Rc, [[0, dim(black, 0.2)], [0.7, lit(black, 0.2)], [1, black]]), () => {
      g.fillStyle = K.cyl(0.018, metalStops(metal));
      g.beginPath(); g.ellipse(uE, 0, BULGE * 0.018, 0.018, 0, 0, TAU); g.fill();
    });
    K.part(clipPath(0.768, uE - 0.004, 0.0085, 0.0095), K.cyl(0.0095, shadeStops(black, MAT.lacquer)));
  },
};

// ------------------------------------------------------------------ options, placement, bounds

function resolve(kind, opts = {}) {
  const def = TOOLS[kind] || TOOLS.fineliner;
  return {
    def,
    ink: parseColor(opts.color, parseColor(def.ink, [23, 23, 26])),
    angle: num(opts.angle, 35),
    lift: clamp(num(opts.lift, 0), 0, 1),
    alpha: clamp(num(opts.alpha, 1), 0, 1),
    shadow: opts.shadow !== false,
    effects: opts.effects !== false,
    sway: num(opts.sway, 0),
  };
}

// micro-wobble of the hand: a periodic phase (0 and 1 are the same pose), a couple of degrees
function swayDeg(s) {
  const p = s * TAU;
  return 1.9 * Math.sin(p) + 0.6 * Math.sin(2 * p);
}

// frame (local units -> caller user space) and the matching shadow frame
function frames(o, x, y, size) {
  const sz = size * (1 + 0.04 * o.lift);           // a lifted tool is a touch nearer the eye
  const a = (o.angle + swayDeg(o.sway)) * DEG;
  const d = [Math.sin(a), Math.cos(a)];            // along the body, toward the back end
  const n = [-Math.cos(a), Math.sin(a)];           // across, toward the lit side
  const F = [sz * d[0], sz * d[1], sz * n[0], sz * n[1], x, y];
  const e = SHADOW_DIR, off = o.lift * LIFT_OFFSET * size;
  const S = [sz * (d[0] + SHADOW_SHEAR * e[0]), sz * (d[1] + SHADOW_SHEAR * e[1]), sz * n[0], sz * n[1],
    x + off * e[0], y + off * e[1]];
  return { F, S, sz };
}

// blur radii (units of size) for the two shadow layers
const contactBlur = lift => 0.006 * (1 + 4 * lift);
const castBlur = lift => 0.024 * (1 + 1.3 * lift);

// device-space bounds [x0, y0, x1, y1] of everything a call paints
function deviceBounds(o, x, y, size, M) {
  const { def } = o;
  const { F, S, sz } = frames(o, x, y, size);
  const scale = matScale(M);
  const r = def.maxR + 0.012, p = Math.max(def.pad, 0.025 + 0.035 * o.lift);   // pad covers the AO spot
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (Mx, u, v, grow) => {
    const [px, py] = apply(Mx, u, v);
    x0 = Math.min(x0, px - grow); y0 = Math.min(y0, py - grow);
    x1 = Math.max(x1, px + grow); y1 = Math.max(y1, py + grow);
  };
  const MF = mul(M, F), MS = mul(M, S);
  const pad = 2 + 1.5 * scale;
  for (const [u, v] of [[-p, -r - p], [-p, r + p], [def.len + 0.02, -r], [def.len + 0.02, r]]) add(MF, u, v, pad);
  if (o.shadow) {
    const blur = 1.6 * castBlur(o.lift) * sz * scale + pad;
    for (const [u, v] of [[0, -r], [0, r], [def.len, -r], [def.len, r]]) add(MS, u, v, blur);
  }
  return [x0, y0, x1, y1];
}

/** Bounding box {x, y, w, h} (in the caller's user space) of what drawTool paints: for dirty rects. */
export function toolBounds(kind, x, y, size, opts = {}) {
  const o = resolve(kind, opts);
  const [x0, y0, x1, y1] = deviceBounds(o, x, y, size, [1, 0, 0, 1, 0, 0]);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ------------------------------------------------------------------ painting

// A clean drawing state (inside the caller's save/restore): a glow shadow, filter, line dash or
// text setting the caller left on its context must not leak into the sprite.
function neutral(g) {
  g.globalCompositeOperation = 'source-over';
  g.shadowColor = 'rgba(0,0,0,0)';
  g.shadowBlur = 0; g.shadowOffsetX = 0; g.shadowOffsetY = 0;
  if ('filter' in g) g.filter = 'none';
  if (g.setLineDash) g.setLineDash([]);
  g.lineDashOffset = 0;
  g.miterLimit = 10;
  g.lineJoin = 'round';
  g.lineCap = 'butt';
  if ('direction' in g) g.direction = 'ltr';
  if ('letterSpacing' in g) g.letterSpacing = '0px';
  if ('wordSpacing' in g) g.wordSpacing = '0px';
  if ('fontKerning' in g) g.fontKerning = 'auto';
  if ('fontStretch' in g) g.fontStretch = 'normal';
  if ('fontVariantCaps' in g) g.fontVariantCaps = 'normal';
  if ('textRendering' in g) g.textRendering = 'auto';
}

function paint(g, M, kind, x, y, size, o) {
  const { def } = o;
  const { F, S, sz } = frames(o, x, y, size);
  const scale = matScale(M);
  const pxu = sz * scale;
  const K = makeKit(g, o.ink, pxu);
  def.build(K);
  g.save();
  neutral(g);
  if (o.shadow) castShadow(g, M, K, def, S, sz, scale, o, x, y);
  g.setTransform(...mul(M, F));
  // dust and light spill live on the paper at the contact point: they fade as the tool lifts
  if (o.effects) for (const fn of K.under) { g.save(); g.globalAlpha *= 1 - 0.75 * o.lift; fn(g); g.restore(); }
  // outline pass: each part stroked at twice the width, then the fills cover the inner half,
  // which leaves one clean hairline around the union of the parts
  const ow = clamp(0.55 + pxu / 500, 0.7, 1.5);
  g.lineWidth = 2 * ow / pxu;
  g.strokeStyle = 'rgba(14,11,8,0.5)';
  for (const p of K.parts) if (p.outline) g.stroke(p.path);
  for (const p of K.parts) {
    g.fillStyle = p.fill;
    g.fill(p.path);
    if (p.detail) { g.save(); g.clip(p.path); p.detail(g); g.restore(); }
  }
  for (const fn of K.over) { g.save(); fn(g); g.restore(); }
  if (o.effects) for (const fn of K.bloom) { g.save(); fn(g); g.restore(); }
  g.restore();
}

// Cast shadow of the whole silhouette, drawn with the canvas shadow of a copy that sits outside
// the canvas (shadowOffset brings only the blurred shadow back); shadowBlur works everywhere,
// unlike ctx.filter. Two layers: a tight contact shadow near the tip and a soft cast shadow
// whose strength fades along the body, both separating and softening as the tool lifts.
function castShadow(g, M, K, def, S, sz, scale, o, x, y) {
  const sil = K.silhouette();
  const lift = o.lift;
  const MS = mul(M, S);
  let minX = Infinity;
  for (const [u, v] of [[0, -def.maxR], [0, def.maxR], [def.len, -def.maxR], [def.len, def.maxR]]) minX = Math.min(minX, apply(MS, u, v)[0]);
  const cw = (g.canvas && g.canvas.width) || 16384;
  const far = Math.ceil(cw - minX + 64 + sz * scale * 0.2);
  g.save();
  g.setTransform(MS[0], MS[1], MS[2], MS[3], MS[4] + far, MS[5]);
  g.shadowOffsetX = -far;
  g.shadowOffsetY = 0;
  const k = K.shadowStrength;
  const layers = [
    { blur: castBlur(lift), rgb: '38,28,16', alpha: 0.34 * (1 - 0.45 * lift) * k, stops: [[0, 1], [0.35, 0.8], [1, 0.45]] },
    { blur: contactBlur(lift), rgb: '24,18,10', alpha: 0.5 * Math.pow(1 - lift, 1.6) * k, stops: [[0, 1], [0.12, 0.55], [0.3, 0]] },
  ];
  for (const L of layers) {
    if (L.alpha < 0.002) continue;
    g.shadowBlur = L.blur * sz * scale;
    g.shadowColor = `rgba(${L.rgb},${L.alpha.toFixed(3)})`;
    // the silhouette's own alpha shapes the shadow: strongest at the tip, fading up the body
    const gr = g.createLinearGradient(0, 0, def.len, 0);
    for (const [t, a] of L.stops) gr.addColorStop(t, `rgba(0,0,0,${a})`);
    g.fillStyle = gr;
    g.fill(sil);
  }
  g.restore();
  // ambient occlusion right under the tip
  const ao = 0.4 * Math.pow(1 - lift, 2) * k;
  if (ao > 0.01) {
    g.save();
    g.setTransform(...M);
    const e = SHADOW_DIR, r = 0.02 * sz * (1 + 1.5 * lift);
    const cx = x + e[0] * 0.004 * sz, cy = y + e[1] * 0.004 * sz;
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    gr.addColorStop(0, `rgba(20,14,8,${ao.toFixed(3)})`);
    gr.addColorStop(1, 'rgba(20,14,8,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
    g.restore();
  }
}

// scratch layers (device pixels) for alpha < 1 and motion blur: 0 = result, 1 = sprite, 2 = group
const pool = [];
function scratch(i, w, h) {
  let s = pool[i];
  if (!s || s.c.width < w || s.c.height < h) {
    const W = Math.ceil(Math.max(w, s ? s.c.width : 0) / 128) * 128;
    const H = Math.ceil(Math.max(h, s ? s.c.height : 0) / 128) * 128;
    let c = null, g = null;
    if (typeof OffscreenCanvas !== 'undefined') {
      try { c = new OffscreenCanvas(W, H); g = c.getContext('2d'); } catch { g = null; }
    }
    if (!g && typeof document !== 'undefined') {
      c = document.createElement('canvas'); c.width = W; c.height = H; g = c.getContext('2d');
    }
    if (!g) return null;
    s = pool[i] = { c, g };
  }
  const g = s.g;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.imageSmoothingEnabled = true;
  // one texel more than used: bilinear copies at sub-pixel offsets may sample the rim
  g.clearRect(0, 0, Math.min(w + 2, s.c.width), Math.min(h + 2, s.c.height));
  return s;
}

// integer device box of a sprite, clipped to the target canvas; null when empty or absurd
function deviceBox(ctx, b) {
  const cw = (ctx.canvas && ctx.canvas.width) || 16384, ch = (ctx.canvas && ctx.canvas.height) || 16384;
  const x0 = Math.max(0, Math.floor(b[0])), y0 = Math.max(0, Math.floor(b[1]));
  const x1 = Math.min(cw, Math.ceil(b[2])), y1 = Math.min(ch, Math.ceil(b[3]));
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

function composite(ctx, src, box, alpha) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  neutral(ctx);
  ctx.globalAlpha = alpha;
  ctx.drawImage(src.c, 0, 0, box.w, box.h, box.x0, box.y0, box.w, box.h);
  ctx.restore();
}

// The sprite is always rasterised on a transparent layer and copied over, never straight onto
// the caller's canvas. On an opaque canvas (the film encoder's alpha:false context) Chromium and
// Firefox set text with LCD subpixel antialiasing, which puts colour fringes on the rotated
// lettering, and the parts would show through each other at alpha < 1. One path also means a
// still frame and a faded or blurred one render the lettering identically (no shimmer).
// Boxes larger than a layer are done in tiles, so a huge sprite still fades as a whole.
function paintLayered(ctx, kind, x, y, size, o, alpha) {
  const M = getMatrix(ctx);
  const box = deviceBox(ctx, deviceBounds(o, x, y, size, M));
  if (box.w <= 0 || box.h <= 0) return true;
  let acc = scratch(0, Math.min(TILE, box.w), Math.min(TILE, box.h));   // the first (usually only) tile
  if (!acc) return false;
  for (let ty = 0; ty < box.h; ty += TILE) {
    for (let tx = 0; tx < box.w; tx += TILE) {
      const t = { x0: box.x0 + tx, y0: box.y0 + ty, w: Math.min(TILE, box.w - tx), h: Math.min(TILE, box.h - ty) };
      if (tx || ty) acc = scratch(0, t.w, t.h);
      paint(acc.g, mul([1, 0, 0, 1, -t.x0, -t.y0], M), kind, x, y, size, o);
      composite(ctx, acc, t, alpha);
    }
  }
  return true;
}

/**
 * Draw one tool with its tip exactly at (x, y) (ctx user space, any transform / DPR).
 * size = tool length in px, tip to back end, for every kind.
 * opts: { color: '#hex' ink, angle: deg from vertical (35, body toward the lower right),
 *         lift: 0..1 hover height, alpha: 0..1, shadow: true, sway: 0..1 micro-wobble phase,
 *         effects: true (paper dust / light spill / glow around the tip; off for UI icons) }
 * The caller's globalAlpha multiplies alpha; its shadow, filter and composite mode are ignored.
 */
export function drawTool(ctx, kind, x, y, size, opts = {}) {
  if (!ctx || !(size > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const o = resolve(kind, opts);
  const alpha = o.alpha * (ctx.globalAlpha == null ? 1 : ctx.globalAlpha);
  if (alpha <= 0.002) return;
  if (paintLayered(ctx, kind, x, y, size, o, alpha)) return;
  // no scratch canvas can be made at all: paint directly, still faded on the caller's context
  ctx.save();
  ctx.globalAlpha = alpha;
  paint(ctx, getMatrix(ctx), kind, x, y, size, o);
  ctx.restore();
}

// keep only the last `maxLen` (user px) of travel, so a tool flying across the sheet in one
// frame still reads as a tool rather than a streak
function trimPath(pts, maxLen) {
  if (!(maxLen >= 0) || pts.length < 2) return pts;
  let acc = 0;
  for (let i = pts.length - 1; i > 0; i--) {
    const a = pts[i - 1], b = pts[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + d > maxLen) {
      const f = d > 0 ? (maxLen - acc) / d : 0;
      const cut = { ...a, x: b.x + (a.x - b.x) * f, y: b.y + (a.y - b.y) * f };
      return [cut, ...pts.slice(i)];
    }
    acc += d;
  }
  return pts;
}

/**
 * Motion blur over one frame's shutter. `points` = the tip positions across the exposure in
 * time order ([{x, y, lift?, sway?}], e.g. K head samples); the result is the time average of
 * the tool over that path (the spec's "K sub-positions at alpha 1/K", done densely).
 *
 * The tool never rotates while it moves (fixed hand angle), so it is painted once and the
 * copy is translated: the path is resampled to one copy per ~1 px of travel (a power of two,
 * up to 64), so fast strokes blur smoothly instead of strobing. Copies are summed with
 * 'lighter' at 1/8 in groups of 8, keeping 8-bit rounding to a few levels and letting fully
 * covered pixels add up to exactly opaque.
 * opts: as drawTool, plus maxBlur = longest blur trail in px (default 0.08 * size, measured back
 * from the last point; Infinity for the physically exact smear).
 * A path longer than 6 * size (a seek or a jump, not a stroke) draws the still tool at the last
 * point, with that point's lift and sway.
 */
export function drawToolMotion(ctx, kind, points, size, opts = {}) {
  let pts = (points || []).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!ctx || !pts.length || !(size > 0)) return;
  const last = pts[pts.length - 1];
  // the jump test looks at the whole path, before the blur trail is trimmed
  let travel = 0;
  for (let i = 1; i < pts.length; i++) travel += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  if (travel > 6 * size) {
    drawTool(ctx, kind, last.x, last.y, size, { ...opts, lift: num(last.lift, opts.lift), sway: num(last.sway, opts.sway) });
    return;
  }
  // Infinity is a valid maxBlur (no cap), so it is not parsed with num()
  const maxBlur = typeof opts.maxBlur === 'number' && opts.maxBlur >= 0 ? opts.maxBlur : 0.08 * size;
  pts = trimPath(pts, maxBlur);
  const avg = key => {
    let s = 0, n = 0;
    for (const p of pts) { const v = num(p[key], opts[key]); if (Number.isFinite(v)) { s += v; n++; } }
    return n ? s / n : undefined;
  };
  // sway is a phase: average it on the circle, or 0.99 and 0.01 would meet at 0.5
  let sc = 0, ss = 0;
  for (const p of pts) { const v = num(p.sway, num(opts.sway, 0)); sc += Math.cos(v * TAU); ss += Math.sin(v * TAU); }
  const o = resolve(kind, { ...opts, lift: avg('lift'), sway: Math.atan2(ss, sc) / TAU });
  const alpha = o.alpha * (ctx.globalAlpha == null ? 1 : ctx.globalAlpha);
  if (alpha <= 0.002) return;
  const M = getMatrix(ctx);
  const dev = pts.map(p => apply(M, p.x, p.y));
  let len = 0;
  for (let i = 1; i < dev.length; i++) len += Math.hypot(dev[i][0] - dev[i - 1][0], dev[i][1] - dev[i - 1][1]);
  // standing still (under half a device pixel of travel)
  if (len < 0.4) {
    drawTool(ctx, kind, last.x, last.y, size, { ...opts, lift: o.lift, sway: o.sway });
    return;
  }
  const N = Math.min(64, Math.max(8, 2 ** Math.ceil(Math.log2(len))));
  // sample the path uniformly in time (points are time samples), centred in each slot
  const off = [];
  const K = dev.length;
  for (let j = 0; j < N; j++) {
    const t = (j + 0.5) / N * (K - 1), i = Math.min(K - 2, Math.floor(t)), f = t - i;
    off.push(K === 1 ? [0, 0] : [dev[i][0] + (dev[i + 1][0] - dev[i][0]) * f - dev[0][0],
      dev[i][1] + (dev[i + 1][1] - dev[i][1]) * f - dev[0][1]]);
  }
  // the sprite, painted once at the first point
  const sb = deviceBounds(o, pts[0].x, pts[0].y, size, M);
  const sx = Math.floor(sb[0]), sy = Math.floor(sb[1]), sw = Math.ceil(sb[2]) - sx, sh = Math.ceil(sb[3]) - sy;
  let ox0 = 0, oy0 = 0, ox1 = 0, oy1 = 0;
  for (const [dx, dy] of off) { ox0 = Math.min(ox0, dx); oy0 = Math.min(oy0, dy); ox1 = Math.max(ox1, dx); oy1 = Math.max(oy1, dy); }
  const box = deviceBox(ctx, [sx + ox0 - 1, sy + oy0 - 1, sx + sw + ox1 + 1, sy + sh + oy1 + 1]);
  if (box.w <= 0 || box.h <= 0) return;
  const fits = Math.max(sw, sh, box.w, box.h) <= TILE;
  const spr = fits ? scratch(1, sw, sh) : null;
  const acc = spr && scratch(0, box.w, box.h);
  const grp = acc && scratch(2, box.w, box.h);
  if (!grp) {
    // a sprite too big for the layers (or no layers at all): the still tool at the last point,
    // which reads better than a stack of see-through copies
    drawTool(ctx, kind, last.x, last.y, size, { ...opts, lift: o.lift, sway: o.sway });
    return;
  }
  paint(spr.g, mul([1, 0, 0, 1, -sx, -sy], M), kind, pts[0].x, pts[0].y, size, o);
  const a = acc.g, gg = grp.g;
  a.globalCompositeOperation = 'lighter';
  a.globalAlpha = 8 / N;
  gg.globalCompositeOperation = 'lighter';
  gg.globalAlpha = 1 / 8;
  for (let j = 0; j < N; j += 8) {
    gg.globalCompositeOperation = 'source-over';
    gg.clearRect(0, 0, box.w, box.h);
    gg.globalCompositeOperation = 'lighter';
    for (let k = j; k < j + 8; k++) gg.drawImage(spr.c, 0, 0, sw, sh, sx - box.x0 + off[k][0], sy - box.y0 + off[k][1], sw, sh);
    if (N === 8) break;
    a.drawImage(grp.c, 0, 0, box.w, box.h, 0, 0, box.w, box.h);
  }
  composite(ctx, N === 8 ? grp : acc, box, alpha);
}
