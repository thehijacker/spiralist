// Line art: the stroke contract between the line extractor (lines.js) and the path planner.
//
// A stroke is one visible contour the drawing should contain:
//   points   Float32Array [x0, y0, x1, y1, ...] in sheet fractions (0..1, y down) of the square
//            art frame (the crop circle's bounding square)
//   closed   true when the last point joins the first (an iris, a closed eye)
//   saliency 0..1, how much the drawing needs it (1 = the outline or a landmark feature)
//   kind     one of KINDS
//   dark     0..1, how dark the photo is along it (for pen pressure / line weight)
// features = { face: { box: {x, y, w, h}, landmarks: Float32Array(478 * 2) } | null,
//              dark: { w, h, data: Float32Array } }   (darkness grid for optional hatching)

export const KINDS = Object.freeze(['outline', 'jaw', 'hair', 'brow', 'eye', 'iris', 'nose', 'lips', 'ear', 'detail', 'other']);
const KIND_SET = new Set(KINDS);

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Build a stroke; `points` may be a Float32Array, a flat number array or an array of [x, y]. */
export function makeStroke(points, { closed = false, saliency = 0.5, kind = 'other', dark = 0.5 } = {}) {
  let flat;
  if (points instanceof Float32Array) flat = points;
  else if (points.length && Array.isArray(points[0])) {
    flat = new Float32Array(points.length * 2);
    points.forEach((p, i) => { flat[i * 2] = p[0]; flat[i * 2 + 1] = p[1]; });
  } else flat = Float32Array.from(points);
  return { points: flat, closed: !!closed, saliency: clamp01(+saliency || 0), kind: KIND_SET.has(kind) ? kind : 'other', dark: clamp01(+dark || 0) };
}

/** Total length of a stroke in frame fractions. */
export function strokeLength(s) {
  const p = s.points;
  let L = 0;
  for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  if (s.closed && p.length >= 4) L += Math.hypot(p[0] - p[p.length - 2], p[1] - p[p.length - 1]);
  return L;
}

/** Check a stroke list against the contract. Returns { ok, errors: [string] }. */
export function validateStrokes(strokes) {
  const errors = [];
  if (!Array.isArray(strokes)) return { ok: false, errors: ['strokes is not an array'] };
  strokes.forEach((s, i) => {
    if (!s || !(s.points instanceof Float32Array)) { errors.push(`#${i}: points must be a Float32Array`); return; }
    if (s.points.length < 4 || s.points.length % 2) errors.push(`#${i}: needs >= 2 points and an even length`);
    for (let k = 0; k < s.points.length; k++) {
      const v = s.points[k];
      if (!Number.isFinite(v) || v < -0.01 || v > 1.01) { errors.push(`#${i}: point value ${v} out of 0..1`); break; }
    }
    if (typeof s.closed !== 'boolean') errors.push(`#${i}: closed must be boolean`);
    if (!(s.saliency >= 0 && s.saliency <= 1)) errors.push(`#${i}: saliency out of 0..1`);
    if (!(s.dark >= 0 && s.dark <= 1)) errors.push(`#${i}: dark out of 0..1`);
    if (!KIND_SET.has(s.kind)) errors.push(`#${i}: unknown kind '${s.kind}'`);
  });
  return { ok: errors.length === 0, errors };
}

/** Colours per kind for debug drawings. */
export const KIND_COLORS = Object.freeze({
  outline: '#1f2937', jaw: '#7c3aed', hair: '#b45309', brow: '#0e7490', eye: '#2563eb', iris: '#0891b2',
  nose: '#dc2626', lips: '#db2777', ear: '#16a34a', detail: '#6b7280', other: '#a8a29e',
});
