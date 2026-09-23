// A handwritten signature (name, @handle or #tag) that the pen writes in the sheet's corner at the
// end of the timelapse.
//
// The film does not paste a picture of the name: it writes it, with the same tool and the same
// renderer as the drawing, so a fountain-pen signature pools and dries, a pencil one catches the
// paper's tooth, a gold one glints. For that the name has to become pen strokes:
//   1. the name is set in a handwriting face (Caveat Bold) into a mask,
//   2. the mask is thinned to its centre line (Zhang-Suen) and short skeleton spurs are pruned,
//   3. the centre line is walked the way a hand writes: glyph groups left to right, each traced as
//      one stroke as long as it can go on without lifting (straightest continuation first), short
//      dead ends retraced, i-dots and bars once the letters around them are done, and a quick
//      underline flourish last,
//   4. the walk is timed like handwriting (slower in tight turns and where a stroke starts and
//      ends, quick hops between strokes) and resampled at even time steps.
// Coordinates are in em (the font size): x to the right from the start of the ink, y down with the
// baseline at 0. Traces are cached per text.

export const SIGNATURE_FONT = 'Caveat';
export const SIGNATURE_MAX = 32;

let fontReady = null;
/** Load the handwriting face before tracing (falls back to a cursive system font). */
export function ensureSignatureFont() {
  if (!fontReady) {
    fontReady = (typeof document !== 'undefined' && document.fonts?.load
      ? document.fonts.load(`700 96px "${SIGNATURE_FONT}"`) : Promise.resolve())
      .then(() => { TRACES.clear(); })          // traces made with the fallback face are stale
      .catch(() => {});
  }
  return fontReady;
}

/** Is the handwriting face loaded (a trace made now uses it)? */
export function signatureFontLoaded() {
  try { return typeof document !== 'undefined' && !!document.fonts?.check(`700 96px "${SIGNATURE_FONT}"`); } catch { return false; }
}

/**
 * The signature as it will be written: one line, at most SIGNATURE_MAX characters, without control
 * characters or pictographs (a pen cannot write a colour emoji; its outline thins to a blob).
 */
export function cleanSignature(text) {
  return String(text || '').replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f‍︎️]|\p{Extended_Pictographic}/gu, '')
    .replace(/ {2,}/g, ' ').trim().slice(0, SIGNATURE_MAX);
}

const FONT_STACK = `"${SIGNATURE_FONT}", "Segoe Script", "Bradley Hand", "Brush Script MT", cursive`;

function canvas2d(w, h) {
  let c = null;
  try { c = new OffscreenCanvas(w, h); } catch { c = null; }
  if (!c) { c = document.createElement('canvas'); c.width = w; c.height = h; }
  return { c, g: c.getContext('2d', { willReadFrequently: true }) };
}

/**
 * The name set in the handwriting face, as a 2D picture (the dialog can show it; the film writes
 * it with traceSignature instead).
 * @returns { canvas, width, height, baseline, ink: [x0, x1] } or null
 */
export function renderSignature(text, { color = '#17171a', height = 120, slant = -0.08 } = {}) {
  const t = cleanSignature(text);
  if (!t) return null;
  const font = `700 ${height}px ${FONT_STACK}`;
  const probe = canvas2d(8, 8).g;
  probe.font = font;
  const w0 = probe.measureText(t).width;
  const pad = Math.ceil(height * 0.4);
  const { c, g } = canvas2d(Math.ceil(w0 + pad * 2), Math.ceil(height * 1.7 + pad));
  const baseline = Math.round(pad + height * 1.05);
  g.font = font;
  g.fillStyle = color;
  g.setTransform(1, 0, Math.tan(slant), 1, -Math.tan(slant) * baseline, 0);
  g.fillText(t, pad, baseline);
  return { canvas: c, width: c.width, height: c.height, baseline, ink: [pad, pad + w0] };
}

// ------------------------------------------------------------------------------------ thinning
// Zhang-Suen thinning of a binary mask (1 = ink) with a zero border, in place, inside [x0, x1) x
// [y0, y1). Leaves an 8-connected centre line one or two pixels wide.
function thin(m, W, x0, y0, x1, y1) {
  const del = [];
  for (let changed = true; changed;) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0, i = y * W + x0; x < x1; x++, i++) {
          if (!m[i]) continue;
          const p2 = m[i - W], p3 = m[i - W + 1], p4 = m[i + 1], p5 = m[i + W + 1];
          const p6 = m[i + W], p7 = m[i + W - 1], p8 = m[i - 1], p9 = m[i - W - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (A !== 1) continue;
          if (pass === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
          del.push(i);
        }
      }
      for (const i of del) m[i] = 0;
      if (del.length) changed = true;
    }
  }
  // staircase clean-up: a pixel whose two neighbours already touch each other diagonally is
  // redundant (it only makes a corner two pixels thick, and a junction out of every step)
  for (let y = y0; y < y1; y++) {
    for (let x = x0, i = y * W + x0; x < x1; x++, i++) {
      if (!m[i]) continue;
      const n = m[i - W], e = m[i + 1], s = m[i + W], w = m[i - 1];
      if ((n && e && !m[i + W - 1] && !s && !w) || (e && s && !m[i - W - 1] && !n && !w)
        || (s && w && !m[i - W + 1] && !n && !e) || (w && n && !m[i + W + 1] && !s && !e)) m[i] = 0;
    }
  }
}

const OFF = W => [-W - 1, -W, -W + 1, 1, W + 1, W, W - 1, -1];

// Remove skeleton spurs: dead-end branches shorter than `len` px that end at a junction.
function prune(m, W, x0, y0, x1, y1, len) {
  const off = OFF(W);
  const deg = i => { let d = 0; for (const o of off) d += m[i + o]; return d; };
  for (let round = 0; round < 2; round++) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0, i = y * W + x0; x < x1; x++, i++) {
        if (!m[i] || deg(i) !== 1) continue;
        const chain = [i];
        let prev = -1, cur = i, hitJunction = false;
        while (chain.length <= len) {
          let next = -1;
          for (const o of off) { const j = cur + o; if (m[j] && j !== prev && !chain.includes(j)) { next = j; break; } }
          if (next < 0) break;
          if (deg(next) >= 3) { hitJunction = true; break; }
          chain.push(next); prev = cur; cur = next;
        }
        if (hitJunction && chain.length <= len) for (const j of chain) m[j] = 0;
      }
    }
  }
}

// ------------------------------------------------------------------------------------ walking
// Split the skeleton into components; walk each as pen strokes. Returns strokes as arrays of
// pixel indices (in walking order), grouped by component.
function walkComponents(m, W, x0, y0, x1, y1, retraceMax) {
  const off = OFF(W);
  const seen = new Uint8Array(m.length);
  const comps = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0, i = y * W + x0; x < x1; x++, i++) {
      if (!m[i] || seen[i]) continue;
      const px = [];
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const c = stack.pop();
        px.push(c);
        for (const o of off) { const j = c + o; if (m[j] && !seen[j]) { seen[j] = 1; stack.push(j); } }
      }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of px) { const X = p % W, Y = (p / W) | 0; minX = Math.min(minX, X); maxX = Math.max(maxX, X); minY = Math.min(minY, Y); maxY = Math.max(maxY, Y); }
      comps.push({ px, minX, maxX, minY, maxY });
    }
  }
  const vis = new Uint8Array(m.length);
  const deg = i => { let d = 0; for (const o of off) d += m[i + o]; return d; };
  const xy = i => [i % W, (i / W) | 0];
  for (const comp of comps) {
    // start at the leftmost end (a stroke's free end), else the leftmost pixel
    let start = -1, best = Infinity;
    for (const p of comp.px) {
      const [X, Y] = xy(p);
      const k = X + (deg(p) === 1 ? 0 : 1e4) + Y * 1e-3;
      if (k < best) { best = k; start = p; }
    }
    const strokes = [];
    let stroke = [start];
    vis[start] = 1;
    let left = comp.px.length - 1;
    const path = [start];                  // the DFS stack: the way back for retracing
    let cur = start;
    const dirOf = () => {
      const n = stroke.length;
      if (n < 2) return null;
      const a = xy(stroke[Math.max(0, n - 5)]), b = xy(stroke[n - 1]);
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return d > 0 ? [(b[0] - a[0]) / d, (b[1] - a[1]) / d] : null;
    };
    while (left > 0) {
      // the unvisited neighbour that best continues the line
      const dir = dirOf();
      let next = -1, bestK = -Infinity;
      for (const o of off) {
        const j = cur + o;
        if (!m[j] || vis[j]) continue;
        const [dx, dy] = [((j % W) - (cur % W)), (((j / W) | 0) - ((cur / W) | 0))];
        const l = Math.hypot(dx, dy);
        const k = dir ? (dx * dir[0] + dy * dir[1]) / l : -dx * 0.01 + (l > 1 ? -0.001 : 0);
        if (k > bestK) { bestK = k; next = j; }
      }
      if (next >= 0) {
        vis[next] = 1; left--;
        stroke.push(next); path.push(next); cur = next;
        continue;
      }
      // dead end: back along the way we came to the nearest pixel with somewhere new to go
      let k = path.length - 1;
      const hasNew = p => off.some(o => m[p + o] && !vis[p + o]);
      while (k >= 0 && !hasNew(path[k])) k--;
      if (k < 0) break;
      const back = path.length - 1 - k;
      if (back <= retraceMax) {
        // a short way back: the pen retraces it without lifting (as in the stem of a d)
        for (let q = path.length - 2; q >= k; q--) stroke.push(path[q]);
      } else {
        strokes.push(stroke);
        stroke = [path[k]];
      }
      path.length = k + 1;
      cur = path[k];
    }
    strokes.push(stroke);
    comp.strokes = strokes.filter(s => s.length > 0);
  }
  return comps;
}

// Gaussian smoothing of a pixel chain (the skeleton's staircase), ends held.
function smoothChain(pts, sigma) {
  const n = pts.length;
  if (n < 3) return pts;
  const R = Math.ceil(sigma * 2.5), out = [];
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0, ws = 0;
    // near the ends the window shrinks symmetrically, so an end stays where the stroke ends
    const r = Math.min(R, i, n - 1 - i);
    for (let k = -r; k <= r; k++) {
      const w = Math.exp(-0.5 * (k / sigma) ** 2);
      sx += pts[i + k][0] * w; sy += pts[i + k][1] * w; ws += w;
    }
    out.push([sx / ws, sy / ws]);
  }
  return out;
}

const TRACES = new Map();

/**
 * The name as pen strokes.
 * @returns { text, strokes: [[[x, y], ...], ...] in em (baseline y = 0, x = 0 where the ink starts),
 *            width, top, bottom (ink extent in em, flourish included), thickness (the face's stroke
 *            width in em), font: the face that was used } or null
 */
export function traceSignature(text, { flourish = true } = {}) {
  const t = cleanSignature(text);
  if (!t) return null;
  const key = `${t}|${flourish ? 1 : 0}`;
  if (TRACES.has(key)) return TRACES.get(key);
  const EM = 150, slant = -0.07;
  const font = `700 ${EM}px ${FONT_STACK}`;
  const probe = canvas2d(8, 8).g;
  probe.font = font;
  const tw = probe.measureText(t).width;
  const pad = Math.ceil(EM * 0.45);
  const W = Math.ceil(tw + 2 * pad + EM * 0.3), H = Math.ceil(EM * 1.9);
  const base = Math.round(pad + EM * 0.95);
  const { g } = canvas2d(W, H);
  g.font = font;
  g.fillStyle = '#000';
  g.setTransform(1, 0, Math.tan(slant), 1, -Math.tan(slant) * base, 0);
  g.fillText(t, pad, base);
  const px = g.getImageData(0, 0, W, H).data;
  const m = new Uint8Array(W * H);
  let area = 0, bx0 = W, by0 = H, bx1 = 0, by1 = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (px[i * 4 + 3] >= 120) {
        m[i] = 1; area++;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
      }
    }
  }
  if (!area) { TRACES.set(key, null); return null; }
  const X0 = Math.max(1, bx0 - 1), Y0 = Math.max(1, by0 - 1), X1 = Math.min(W - 1, bx1 + 2), Y1 = Math.min(H - 1, by1 + 2);
  thin(m, W, X0, Y0, X1, Y1);
  let skel = 0;
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) skel += m[y * W + x];
  const thick = skel ? area / skel : EM * 0.1;           // mean stroke width, px
  prune(m, W, X0, Y0, X1, Y1, Math.round(thick * 0.9));
  const comps = walkComponents(m, W, X0, Y0, X1, Y1, Math.round(EM * 0.3));
  // Writing order: letter groups left to right; small marks (i and j dots, accents, bars) right
  // after the group they sit on, the way a hand goes back to dot an i.
  const big = comps.filter(c => (c.maxX - c.minX) + (c.maxY - c.minY) > EM * 0.22).sort((a, b) => a.minX - b.minX);
  const small = comps.filter(c => !big.includes(c));
  const order = [];
  for (const c of big) order.push(c);
  for (const s of small.sort((a, b) => a.minX - b.minX)) {
    const cx = 0.5 * (s.minX + s.maxX);
    let at = -1;
    for (let k = 0; k < order.length; k++) if (big.includes(order[k]) && order[k].minX <= cx) at = k;
    // after that group and any marks already placed behind it
    let k = at + 1;
    while (k < order.length && !big.includes(order[k])) k++;
    order.splice(at < 0 ? 0 : k, 0, s);
  }
  const ox = bx0, oy = base;
  const strokes = [];
  for (const c of order) {
    for (const s of c.strokes) {
      const pts = s.map(i => [(i % W) + 0.5, ((i / W) | 0) + 0.5]);
      const sm = smoothChain(pts, 2.2);
      const out = [];
      for (const [x, y] of sm) {
        const p = [(x - ox) / EM, (y - oy) / EM];
        const q = out[out.length - 1];
        if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.004) out.push(p);
      }
      let len = 0;
      for (let k = 1; k < out.length; k++) len += Math.hypot(out[k][0] - out[k - 1][0], out[k][1] - out[k - 1][1]);
      if (out.length && len < 0.04) {
        // a dot (full stop, i-dot) thins to a pixel: the pen makes it as a short tick
        const cx = out.reduce((a, p) => a + p[0], 0) / out.length, cy = out.reduce((a, p) => a + p[1], 0) / out.length;
        out.length = 0;
        for (let k = 0; k <= 4; k++) out.push([cx - 0.02 + 0.01 * k, cy + 0.008 - 0.004 * k]);
      }
      if (out.length) strokes.push(out);
    }
  }
  let width = (bx1 + 1 - ox) / EM, top = (by0 - oy) / EM, bottom = (by1 + 1 - oy) / EM;
  if (flourish && width > 0.6) {
    // a quick underline flick from under the start to just past the end, rising at its tail
    const a = [width * 0.06, 0.2], c = [width * 0.55, 0.12], e = [width * 1.04, 0.05];
    const f = [];
    for (let k = 0; k <= 48; k++) {
      const u = k / 48, v = 1 - u;
      f.push([v * v * a[0] + 2 * u * v * c[0] + u * u * e[0], v * v * a[1] + 2 * u * v * c[1] + u * u * e[1] - 0.05 * u ** 6]);
    }
    strokes.push(f);
    width = Math.max(width, e[0]);
    bottom = Math.max(bottom, 0.22);
  }
  const res = { text: t, strokes, width, top, bottom, thickness: thick / EM,
    font: signatureFontLoaded() ? SIGNATURE_FONT : 'fallback' };
  TRACES.set(key, res);
  return res;
}

/**
 * Time a traced signature like a hand writing it, and resample it at even time steps.
 * @param tr       traceSignature()
 * @param seconds  how long the writing takes
 * @param o        { samples: per second (1200), hop: seconds a lift costs at least (0.05) }
 * @returns { n, dt, x, y (em), down (1 on the paper, 0 in the air), along (em from the stroke's
 *            start, -1 in the air), left (em to the stroke's end), speed (em/s), stroke (index) }
 */
export function timeSignature(tr, seconds, { samples = 1200, hop = 0.05 } = {}) {
  // 1. each stroke as arc length with a relative speed per point: slower in tight turns (the
  // hand steers), easing out of the start and into the end
  const segs = [];
  let prev = null;
  tr.strokes.forEach((s, si) => {
    const n = s.length;
    const L = new Float64Array(n);
    for (let i = 1; i < n; i++) L[i] = L[i - 1] + Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1]);
    const len = L[n - 1];
    if (prev) segs.push({ kind: 'hop', from: prev, to: s[0], len: Math.hypot(s[0][0] - prev[0], s[0][1] - prev[1]) });
    const v = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = s[Math.max(0, i - 3)], b = s[i], c = s[Math.min(n - 1, i + 3)];
      const ux = b[0] - a[0], uy = b[1] - a[1], wx = c[0] - b[0], wy = c[1] - b[1];
      const lu = Math.hypot(ux, uy), lw = Math.hypot(wx, wy);
      const turn = lu > 1e-6 && lw > 1e-6 ? Math.acos(Math.max(-1, Math.min(1, (ux * wx + uy * wy) / (lu * lw)))) : 0;
      const k = turn / Math.max(1e-3, 0.5 * (lu + lw));          // curvature, 1/em
      const ends = Math.min(1, 0.35 + L[i] / 0.12) * Math.min(1, 0.45 + (len - L[i]) / 0.1);
      v[i] = ends / (1 + 0.06 * k);
    }
    segs.push({ kind: 'stroke', pts: s, L, v, len, index: si });
    prev = s[n - 1];
  });
  // 2. time of each part at unit speed (em/s), then scaled to the requested length
  let T = 0;
  for (const g of segs) {
    if (g.kind === 'hop') { g.t = hop / 1 + g.len / 2.4; }
    else {
      let t = 0;
      g.tt = new Float64Array(g.pts.length);
      for (let i = 1; i < g.pts.length; i++) { t += (g.L[i] - g.L[i - 1]) / Math.max(0.05, 0.5 * (g.v[i] + g.v[i - 1])); g.tt[i] = t; }
      g.t = t;
    }
    g.t0 = T; T += g.t;
  }
  const scale = seconds / Math.max(1e-6, T);            // unit-time -> seconds
  const n = Math.max(2, Math.ceil(seconds * samples) + 1), dt = seconds / (n - 1);
  const out = { n, dt, seconds, x: new Float32Array(n), y: new Float32Array(n), down: new Float32Array(n),
    along: new Float32Array(n), left: new Float32Array(n), speed: new Float32Array(n), stroke: new Int16Array(n) };
  let gi = 0;
  for (let k = 0; k < n; k++) {
    const tu = k * dt / scale;
    while (gi < segs.length - 1 && tu > segs[gi].t0 + segs[gi].t) gi++;
    const g = segs[gi];
    const u = Math.max(0, Math.min(g.t, tu - g.t0));
    if (g.kind === 'hop') {
      const e = g.t > 0 ? u / g.t : 1, s = e * e * (3 - 2 * e);
      out.x[k] = g.from[0] + (g.to[0] - g.from[0]) * s;
      out.y[k] = g.from[1] + (g.to[1] - g.from[1]) * s;
      out.down[k] = 0; out.along[k] = -1; out.left[k] = -1; out.stroke[k] = -1;
      out.speed[k] = g.len / Math.max(1e-6, g.t * scale);
    } else {
      // arc position at unit time u (binary search in the stroke's own clock)
      let lo = 0, hi = g.pts.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (g.tt[mid] < u) lo = mid; else hi = mid; }
      const f = g.tt[hi] > g.tt[lo] ? (u - g.tt[lo]) / (g.tt[hi] - g.tt[lo]) : 0;
      const a = g.pts[lo], b = g.pts[hi];
      out.x[k] = a[0] + (b[0] - a[0]) * f;
      out.y[k] = a[1] + (b[1] - a[1]) * f;
      const L = g.L[lo] + (g.L[hi] - g.L[lo]) * f;
      out.down[k] = 1; out.along[k] = L; out.left[k] = g.len - L; out.stroke[k] = g.index;
      out.speed[k] = (0.5 * (g.v[lo] + g.v[hi])) / scale;
    }
  }
  return out;
}

/**
 * Where the signature goes on the sheet: right-aligned near the lower-right corner, baseline near
 * the bottom edge, clear of the art (a circle, or a square, of radius art.r about (art.x, art.y);
 * world units, sheet 1 wide centred on the origin, y down), shrunk for long names.
 * @returns { em (size of the em, sheet widths), x (world x of the ink's start), y (baseline) }
 */
export function placeSignature(tr, art, { right = 0.45, baseline = 0.465, em = 0.065, minEm = 0.028, maxWidth = 0.52, gap = 0.018 } = {}) {
  // the lowest the ink may reach: the sheet's edge, less a margin
  const bottomMax = 0.5 - 0.012;
  const clearAt = (e, b) => {
    const x0 = right - tr.width * e, x1 = right, y0 = b + tr.top * e, y1 = b + tr.bottom * e;
    if (y1 > bottomMax + 1e-9) return false;
    if (art.square) return y0 >= art.y + art.r + gap || x0 >= art.x + art.r + gap;
    const qx = Math.max(x0, Math.min(art.x, x1)), qy = Math.max(y0, Math.min(art.y, y1));
    return Math.hypot(qx - art.x, qy - art.y) >= art.r + gap;
  };
  // the baseline: where asked, else a little higher (a deep descender or flourish) or lower (the
  // art reaches down close to it), before the name is shrunk
  const baseFor = e => {
    const hi = Math.min(baseline, bottomMax - tr.bottom * e);
    for (let b = hi; b >= baseline - 0.014 - 1e-9; b -= 0.001) if (clearAt(e, b)) return b;
    for (let b = hi + 0.001; b <= bottomMax - tr.bottom * e + 1e-9; b += 0.001) if (clearAt(e, b)) return b;
    return null;
  };
  let e = Math.min(em, maxWidth / Math.max(1e-3, tr.width));
  while (e > minEm && baseFor(e) == null) e *= 0.97;
  e = Math.max(minEm, e);
  const b = baseFor(e);
  return { em: e, x: right - tr.width * e, y: b ?? Math.min(baseline, bottomMax - tr.bottom * e) };
}
