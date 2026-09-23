// Node tests for js/export.js, on real geometry from js/tone.js + js/spiral.js (+ maze, freeline):
//   SVG   structure (one path, one M, relative commands, mm units, 0.01 mm quanta), stroke fidelity
//         and drift, outline fill vs the renderer's shape (nonzero winding, caps expanded; every
//         disagreeing sample within 0.0325 mm, Euclidean, of the other shape) on smooth and hard
//         tone, mazes, free lines and random polylines; plotter meander inside its band and
//         covering it; description per path kind; svgStats, fileName.
//   PNG   main-thread encoder and the parallel band encoder (deflate walker, sync-flush pieces,
//         Adler-32 combine, worker source run standalone), decoded independently by node zlib
//         and by Python/PIL.
// Run: node tests/export.test.mjs        (writes tests/out/export_*.png|svg; needs python + PIL)
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rasterFromRGBA, processTone, buildField, TONE_DEFAULTS } from '../js/tone.js';
import { buildSpiral, LINE_DEFAULTS, STRIDE } from '../js/spiral.js';
import { buildMaze, MAZE_DEFAULTS } from '../js/maze.js';
import { buildWander, buildContour, FREE_DEFAULTS } from '../js/freeline.js';
import vm from 'node:vm';
import { buildSVG, svgStats, fileName, PNGEncoder, PNGAssembler, crc32, adler32Combine, simplifyIndices, _png } from '../js/export.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ------------------------------------------------------------------ real geometry
// Synthetic "photo": dark disc (head), soft gradient background, a lighter band (collar).
function synthRGBA(G) {
  const px = new Uint8ClampedArray(G * G * 4);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    const i = (y * G + x) * 4, u = x / G, v = y / G;
    let l = 200 - 120 * u;
    const r2 = (u - 0.5) ** 2 + (v - 0.42) ** 2;
    if (r2 < 0.045) l = 30 + 160 * Math.sqrt(r2 / 0.045);
    if (v > 0.78) l = 60 + 40 * Math.sin(u * 20);
    px[i] = l; px[i + 1] = l * 0.95; px[i + 2] = l * 0.9; px[i + 3] = 255;
  }
  return px;
}
const G = 512;
const raster = rasterFromRGBA(synthRGBA(G), G);
const tone = processTone(raster, TONE_DEFAULTS);
const geoms = {};
for (const technique of ['thickness', 'wave', 'both']) {
  const rings = 60;
  const field = buildField(raster, tone.L, { rings });
  geoms[technique] = buildSpiral(field, { ...LINE_DEFAULTS, technique, rings, wobble: 0.2 });
}
const LAYOUT = { cx: 0.5, cy: 0.5, r: 0.42 };
const SIZE = 200;

// ------------------------------------------------------------------ path parsing
/** Parse path data into commands; returns { cmds: [{c, nums}], pts: [[x,y]] absolute end points }. */
function parsePath(d) {
  const re = /([MmLlAaZzHhVvCcSsQqTt])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  const cmds = [];
  let tok;
  while ((tok = re.exec(d))) {
    if (tok[1]) cmds.push({ c: tok[1], nums: [] });
    else {
      assert.ok(cmds.length, 'number before the first command');
      cmds[cmds.length - 1].nums.push(+tok[2]);
    }
  }
  const pts = [];
  const arcs = [];
  const poly = [];            // pts with arcs expanded into short chords (for fill tests)
  let x = 0, y = 0, sx = 0, sy = 0;
  for (const { c, nums } of cmds) {
    const before = pts.length;
    for (const v of nums) assert.ok(Number.isFinite(v), `non-finite number in ${c}`);
    if (c === 'M') {
      assert.ok(nums.length === 2, 'M must carry exactly one pair (later pairs would be absolute L)');
      x = nums[0]; y = nums[1]; sx = x; sy = y; pts.push([x, y]);
    } else if (c === 'l') {
      assert.ok(nums.length % 2 === 0 && nums.length > 0, 'l needs pairs');
      for (let k = 0; k < nums.length; k += 2) { x += nums[k]; y += nums[k + 1]; pts.push([x, y]); }
    } else if (c === 'a') {
      assert.ok(nums.length === 7, 'one arc per a');
      const [rx, ry, rot, large, sweep, dx, dy] = nums;
      arcs.push({ rx, ry, rot, large, sweep, from: [x, y], to: [x + dx, y + dy] });
      for (const q of arcPoints(x, y, x + dx, y + dy, rx, large, sweep)) poly.push(q);
      x += dx; y += dy; pts.push([x, y]);
      continue;
    } else if (c === 'z' || c === 'Z') {
      x = sx; y = sy;
    } else {
      assert.fail(`unexpected command ${c}`);
    }
    for (let k = before; k < pts.length; k++) poly.push(pts[k]);
  }
  return { cmds, pts, arcs, poly };
}

/** Circular SVG arc (rotation 0) -> points after the start, per SVG 1.1 F.6.5 (radius scaled up if short). */
function arcPoints(x1, y1, x2, y2, r, large, sweep, steps = 24) {
  const hx = (x1 - x2) / 2, hy = (y1 - y2) / 2;
  const lam = (hx * hx + hy * hy) / (r * r);
  if (lam > 1) r *= Math.sqrt(lam);
  const num = r * r * r * r - r * r * hy * hy - r * r * hx * hx, den = r * r * hy * hy + r * r * hx * hx;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = coef * hy, cyp = -coef * hx;
  const cx = cxp + (x1 + x2) / 2, cy = cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (hx - cxp) / r, (hy - cyp) / r);
  let dt = ang((hx - cxp) / r, (hy - cyp) / r, (-hx - cxp) / r, (-hy - cyp) / r);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const out = [];
  for (let k = 1; k <= steps; k++) out.push([cx + r * Math.cos(t1 + dt * k / steps), cy + r * Math.sin(t1 + dt * k / steps)]);
  return out;
}

function svgParts(svg) {
  const path = svg.match(/<path\b[^>]*\sd="([^"]*)"/);
  return { d: path[1], tag: svg.match(/<path\b[^>]*>/)[0] };
}

/** Centreline of the geometry in mm. */
function centreline(g) {
  const R = LAYOUT.r * SIZE, cx = LAYOUT.cx * SIZE, cy = LAYOUT.cy * SIZE;
  const X = new Float64Array(g.n), Y = new Float64Array(g.n), W = new Float64Array(g.n);
  for (let i = 0; i < g.n; i++) {
    X[i] = cx + g.data[i * STRIDE] * R; Y[i] = cy + g.data[i * STRIDE + 1] * R; W[i] = g.data[i * STRIDE + 2] * R;
  }
  return { X, Y, W, R };
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/**
 * Max distance from each point of `A` (ordered along the same path) to polyline `B`, tracking
 * a monotone pointer so the match never jumps to a neighbouring ring.
 */
function maxDeviation(AX, AY, B) {
  let j = 0, worst = 0, worstAt = 0;
  for (let i = 0; i < AX.length; i++) {
    let best = Infinity, bestJ = j;
    for (let k = Math.max(0, j - 2); k < Math.min(B.length - 1, j + 40); k++) {
      const d = segDist(AX[i], AY[i], B[k][0], B[k][1], B[k + 1][0], B[k + 1][1]);
      if (d < best) { best = d; bestJ = k; }
    }
    j = bestJ;
    if (best > worst) { worst = best; worstAt = i; }
  }
  return { worst, worstAt };
}

function shoelace(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/**
 * The renderer's shape, as FRAG_STROKE draws it: per segment a trapezoid (width interpolated
 * along it) plus a half disc at each end; a zero-length segment is a disc of its first width.
 * Segments are bucketed on a 1 mm grid, with a margin so distance queries find neighbours.
 */
function shapeIndex(X, Y, W, margin = 0.3) {
  const grid = new Map();
  for (let i = 0; i < X.length - 1; i++) {
    const r = Math.max(W[i], W[i + 1]) / 2 + margin;
    const x0 = Math.floor(Math.min(X[i], X[i + 1]) - r), x1 = Math.floor(Math.max(X[i], X[i + 1]) + r);
    const y0 = Math.floor(Math.min(Y[i], Y[i + 1]) - r), y1 = Math.floor(Math.max(Y[i], Y[i + 1]) + r);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
      const k = gx * 8192 + gy;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
  }
  const cell = (x, y) => grid.get(Math.floor(x) * 8192 + Math.floor(y)) || [];
  return {
    /** exact inside test: the shader's |p - c(h)| <= w(h)/2, h = the clamped projection */
    inside(x, y) {
      for (const i of cell(x, y)) {
        const ax = X[i], ay = Y[i], dx = X[i + 1] - ax, dy = Y[i + 1] - ay, L2 = dx * dx + dy * dy;
        let t = L2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= (W[i] + (W[i + 1] - W[i]) * t) / 2) return true;
      }
      return false;
    },
    /** Euclidean distance to the shape (0 inside): min over the convex pieces of every segment */
    distance(x, y) {
      let best = Infinity;
      for (const i of cell(x, y)) {
        const ax = X[i], ay = Y[i], dx = X[i + 1] - ax, dy = Y[i + 1] - ay, L = Math.hypot(dx, dy);
        const r0 = W[i] / 2, r1 = W[i + 1] / 2;
        if (!(L > 0)) { best = Math.min(best, Math.max(0, Math.hypot(x - ax, y - ay) - r0)); continue; }
        const tx = dx / L, ty = dy / L, u = (x - ax) * tx + (y - ay) * ty, v = Math.abs((y - ay) * tx - (x - ax) * ty);
        const seg = (px, py, qx, qy) => {
          const ex = qx - px, ey = qy - py, l2 = ex * ex + ey * ey;
          const k = l2 > 0 ? Math.max(0, Math.min(1, ((u - px) * ex + (v - py) * ey) / l2)) : 0;
          return Math.hypot(u - px - k * ex, v - py - k * ey);
        };
        const trap = u >= 0 && u <= L && v <= r0 + (r1 - r0) * u / L ? 0 : Math.min(seg(0, r0, L, r1), seg(L, 0, L, r1), seg(0, 0, 0, r0));
        const back = u <= 0 ? Math.max(0, Math.hypot(u, v) - r0) : Math.hypot(u, Math.max(0, v - r0));
        const front = u >= L ? Math.max(0, Math.hypot(u - L, v) - r1) : Math.hypot(u - L, Math.max(0, v - r1));
        best = Math.min(best, trap, back, front);
      }
      return best;
    },
  };
}

/** Edges of a closed polygon on a grid, for distance queries (edges within one cell). */
function polyIndex(pts, cell = 0.5) {
  const grid = new Map();
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    for (let gx = Math.floor(Math.min(x0, x1) / cell); gx <= Math.floor(Math.max(x0, x1) / cell); gx++) {
      for (let gy = Math.floor(Math.min(y0, y1) / cell); gy <= Math.floor(Math.max(y0, y1) / cell); gy++) {
        const k = gx * 65536 + gy;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    }
  }
  return {
    distance(x, y) {
      let best = cell;
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        for (const i of grid.get((cx + a) * 65536 + cy + b) || []) {
          const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
          best = Math.min(best, segDist(x, y, x0, y0, x1, y1));
        }
      }
      return best;
    },
  };
}

/**
 * Fill check of an outline polygon (absolute points, closed, arcs expanded) against the
 * renderer's shape, sampled every `step` mm over square windows ([x, y] or [x, y, side]).
 * Nonzero winding decides "in the SVG", the shader's own test "in the render". Each disagreeing
 * sample's error is its Euclidean distance to the shape it is missing from: the render for
 * SVG-only ink, the outline for render-only ink. (The shader's width gap |p - c| - w/2 overstates
 * that by 1/cos(slope) on steep tapers.) Returns { iou, worst (mm), worstAt, samples }.
 */
function fillCheck(pts, X, Y, W, windows, { side = 12, step = 0.02 } = {}) {
  const shape = shapeIndex(X, Y, W), poly = polyIndex(pts);
  let inter = 0, uni = 0, worst = 0, samples = 0, worstAt = null;
  for (const [wx, wy, wSide = side] of windows) {
    const edges = [];
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
      if (y0 === y1 || Math.max(y0, y1) < wy || Math.min(y0, y1) > wy + wSide) continue;
      edges.push([x0, y0, x1, y1]);
    }
    for (let r = 0; r < wSide / step; r++) {
      const y = wy + (r + 0.5) * step;
      const xs = [];
      for (const [x0, y0, x1, y1] of edges) {
        if ((y0 <= y) === (y1 <= y)) continue;
        xs.push([x0 + (y - y0) / (y1 - y0) * (x1 - x0), y1 > y0 ? 1 : -1]);
      }
      xs.sort((a, b) => a[0] - b[0]);
      let k = 0, wind = 0;
      for (let c = 0; c < wSide / step; c++) {
        const x = wx + (c + 0.5) * step;
        while (k < xs.length && xs[k][0] < x) wind += xs[k++][1];
        const inPoly = wind !== 0, inShape = shape.inside(x, y);
        samples++;
        if (inPoly && inShape) inter++;
        if (inPoly || inShape) uni++;
        if (inPoly !== inShape) {
          const err = inPoly ? shape.distance(x, y) : poly.distance(x, y);
          if (err > worst) { worst = err; worstAt = [+x.toFixed(3), +y.toFixed(3), inPoly ? 'svg-only' : 'render-only']; }
        }
      }
    }
  }
  return { iou: inter / uni, worst, worstAt, samples };
}

/** Geometry record from points in mm on the default sheet ([x, y, w] each). */
function geomFromMm(list, extra = {}) {
  const R = LAYOUT.r * SIZE, n = list.length, data = new Float32Array(n * STRIDE);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const [x, y, w] = list[i];
    if (i) s += Math.hypot(x - list[i - 1][0], y - list[i - 1][1]);
    data.set([(x - 100) / R, (y - 100) / R, w / R, s / R, 1, 0, 1], i * STRIDE);
  }
  return { n, data, colors: null, rings: 1, spacing: 0.1, length: s / R, turns: 0, technique: 'thickness', path: 'spiral', _pace: new Map(), ...extra };
}

// Error budget of the outline: 0.02 mm Douglas-Peucker + 0.0071 mm quantisation (half the
// diagonal of a 0.01 mm cell) + 0.005 mm arc chords.
const OUTLINE_TOL = 0.0325;

// ------------------------------------------------------------------ SVG tests
const svgs = {};
for (const technique of ['thickness', 'wave', 'both']) {
  for (const mode of ['stroke', 'outline', 'plotter']) {
    test(`svg ${mode} (${technique}): structure, one path, mm units, numeric sanity`, () => {
      const g = geoms[technique];
      const t0 = performance.now();
      const svg = buildSVG(g, { mode, ink: '#17171a', paper: mode === 'plotter' ? null : '#f3ead6', layout: LAYOUT });
      const ms = performance.now() - t0;
      svgs[`${mode}_${technique}`] = svg;
      assert.ok(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
      assert.equal((svg.match(/<svg\b/g) || []).length, 1);
      assert.match(svg, /<svg[^>]*\swidth="200mm"[^>]*\sheight="200mm"[^>]*\sviewBox="0 0 200 200"/);
      assert.match(svg, /<title>[^<]+<\/title>/);
      assert.match(svg, /<desc>[^<]+<\/desc>/);
      assert.match(svg, /inkscape:groupmode="layer"[^>]*inkscape:label="Spiral"/);
      assert.equal((svg.match(/<path\b/g) || []).length, 1, 'exactly one path');
      if (mode !== 'plotter') assert.match(svg, /<rect x="0" y="0" width="200" height="200" fill="#f3ead6"\/>/);
      else assert.ok(!svg.includes('<rect'), 'no paper rect when paper is null');
      const { d, tag } = svgParts(svg);
      const { cmds, pts, arcs, poly } = parsePath(d);
      assert.equal(cmds[0].c, 'M', 'path starts with M');
      assert.equal(cmds.filter(c => c.c === 'M' || c.c === 'm').length, 1, 'a single move: the pen never lifts');
      assert.ok(cmds.slice(1).every(c => c.c === 'l' || c.c === 'a' || c.c === 'z'), 'only relative commands after M');
      for (const [x, y] of pts) assert.ok(x >= -0.01 && x <= SIZE + 0.01 && y >= -0.01 && y <= SIZE + 0.01, `point off the sheet ${x},${y}`);
      // numbers carry at most 2 decimals (0.01 mm)
      assert.ok(!/\.\d{3}/.test(d), 'coordinates are quantised to 0.01 mm');
      const st = svgStats(svg);
      assert.equal(st.paths, 1);
      assert.equal(st.nodes, pts.length, 'svgStats counts every vertex');
      assert.equal(st.bytes, Buffer.byteLength(svg, 'utf8'));

      const { X, Y, W } = centreline(g);
      if (mode === 'stroke' || mode === 'plotter') {
        assert.ok(!cmds.some(c => c.c === 'z' || c.c === 'Z'), 'open path: no Z');
        assert.match(tag, /fill="none"/);
        assert.match(tag, /stroke-linecap="round"/);
        assert.match(tag, /stroke-linejoin="round"/);
        const sw = +tag.match(/stroke-width="([\d.]+)"/)[1];
        if (mode === 'plotter') assert.equal(sw, 0.3);
        else {
          const expected = (g.penWidth ?? g.minWidth) * LAYOUT.r * SIZE;
          assert.ok(Math.abs(sw - expected) < 0.001, `pen ${sw} vs ${expected}`);
        }
      }
      if (mode === 'stroke') {
        // Fidelity: every geometry point within RDP eps + quantisation of the written path.
        const dev = maxDeviation(X, Y, pts);
        assert.ok(dev.worst <= 0.02 + 0.00708 + 1e-6, `deviation ${dev.worst.toFixed(4)} mm at ${dev.worstAt}`);
        // No cumulative drift: both ends land exactly on the quantised originals.
        const q = v => Math.round(v * 100) / 100;
        const [fx, fy] = pts[0], [lx, ly] = pts[pts.length - 1];
        assert.ok(Math.abs(fx - q(X[0])) < 1e-9 && Math.abs(fy - q(Y[0])) < 1e-9, 'start point');
        assert.ok(Math.abs(lx - q(X[g.n - 1])) < 1e-6 && Math.abs(ly - q(Y[g.n - 1])) < 1e-6, `end point drifted: ${lx},${ly} vs ${q(X[g.n - 1])},${q(Y[g.n - 1])}`);
        console.log(`      n=${g.n} -> ${pts.length} nodes (${(100 * pts.length / g.n).toFixed(0)}%), ${(st.bytes / 1024).toFixed(0)} KiB, max dev ${dev.worst.toFixed(4)} mm, ${ms.toFixed(0)} ms`);
      }
      if (mode === 'outline') {
        assert.equal(cmds[cmds.length - 1].c, 'z', 'closed path');
        assert.match(tag, /fill-rule="nonzero"/);
        assert.match(tag, /stroke="none"/);
        assert.ok(arcs.length === 2, `two round caps, got ${arcs.length}`);
        // area of the filled outline vs the swept width: sum w ds (+ the two half-disc caps)
        let swept = 0;
        for (let i = 1; i < g.n; i++) swept += 0.5 * (W[i] + W[i - 1]) * Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]);
        swept += Math.PI / 8 * (W[0] ** 2 + W[g.n - 1] ** 2);
        const area = Math.abs(shoelace(pts));
        const err = Math.abs(area - swept) / swept;
        // Shoelace area is exact only without overlapping pieces (thickness: joins almost never
        // trigger). Wavy lines get round/pivot joins whose overlaps wind twice, so there the real
        // check is the fill test below.
        if (technique === 'thickness') assert.ok(err < 0.005, `outline area ${area.toFixed(1)} vs swept ${swept.toFixed(1)} mm^2 (${(err * 100).toFixed(2)}%)`);
        // hair, collar, cheek, centre, and both ends of the line (round caps)
        const windows = [[82, 62], [100, 118], [55, 100], [94, 94], [X[0] - 6, Y[0] - 6], [X[g.n - 1] - 6, Y[g.n - 1] - 6]];
        const fill = fillCheck(poly, X, Y, W, windows);
        assert.ok(fill.worst <= OUTLINE_TOL, `outline off the renderer's shape by ${fill.worst.toFixed(4)} mm at ${JSON.stringify(fill.worstAt)}`);
        console.log(`      ${pts.length} nodes, ${(st.bytes / 1024).toFixed(0)} KiB, shoelace ${(err * 100).toFixed(2)}% vs swept, fill vs render: IoU ${fill.iou.toFixed(4)}, worst ${fill.worst.toFixed(4)} mm (${fill.samples} samples), ${ms.toFixed(0)} ms`);
      }
      if (mode === 'plotter') {
        // Every vertex stays inside its band: distance to the centreline <= w/2 - pen/2 (+ eps + quantum).
        // Nearest centreline segment via a 1 mm spatial hash (rings are 1.4 mm apart).
        const grid = new Map();
        for (let i = 0; i < g.n - 1; i++) {
          const key = Math.floor(X[i]) * 4096 + Math.floor(Y[i]);
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(i);
        }
        let worst = 0, over = 0, far = 0, maxAmp = 0;
        for (let i = 0; i < g.n; i++) maxAmp = Math.max(maxAmp, W[i] / 2 - 0.15);
        for (const [x, y] of pts) {
          let best = Infinity, j = 0;
          for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
            for (const k of grid.get((Math.floor(x) + a) * 4096 + Math.floor(y) + b) || []) {
              const dd = segDist(x, y, X[k], Y[k], X[k + 1], Y[k + 1]);
              if (dd < best) { best = dd; j = k; }
            }
          }
          const allowed = Math.max(W[j], W[j + 1]) / 2 - 0.15;
          const excess = best - Math.max(0, allowed);
          if (excess > worst) worst = excess;
          if (excess > 0.03) over++;
          if (best > 0.6 * maxAmp) far++;
        }
        assert.ok(over === 0, `${over} vertices leave their band (worst ${worst.toFixed(3)} mm)`);
        // the zig-zag must actually swing out to the edges where the line is thick
        // (a line thinner than the plotter pen is a plain centreline; containment above covers it)
        if (maxAmp > 0.05) assert.ok(far > 1000, `zig-zag should reach across thick bands (${far} beyond ${(0.6 * maxAmp).toFixed(2)} mm)`);
        let travel = 0;
        for (let i = 1; i < pts.length; i++) travel += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        console.log(`      ${pts.length} nodes, ${(st.bytes / 1024).toFixed(0)} KiB, pen travel ${(travel / 1000).toFixed(1)} m, band excess ${worst.toFixed(3)} mm, ${ms.toFixed(0)} ms`);
      }
      fs.writeFileSync(path.join(OUT, `export_${mode}_${technique}.svg`), svg);
    });
  }
}

// ------------------------------------------------------------------ outline: hard edges, other paths, stress
// Hard-edged test card: an 8 x 8 checker of near-black squares over a light gradient. Its tone
// jumps make the width leap between neighbouring points, so discs swallow whole edges.
function checkerRGBA(G) {
  const px = new Uint8ClampedArray(G * G * 4);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    const i = (y * G + x) * 4, u = x / G, v = y / G;
    const l = (Math.floor(u * 8) + Math.floor(v * 8)) & 1 ? 20 : 232 - 100 * (u + v) / 2;
    px[i] = px[i + 1] = px[i + 2] = l; px[i + 3] = 255;
  }
  return px;
}
const hardRaster = rasterFromRGBA(checkerRGBA(G), G);
const hardTone = processTone(hardRaster, TONE_DEFAULTS);
// checker corners on the sheet: the circle's square [-1, 1]^2 spans 16..184 mm, squares 21 mm
const CORNERS = [[79, 79], [100, 100], [121, 79], [79, 121], [142, 100], [100, 58]].map(([x, y]) => [x - 6, y - 6]);
const ends = (X, Y) => [[X[0] - 6, Y[0] - 6], [X[X.length - 1] - 6, Y[Y.length - 1] - 6]];

function outlineCase(g, windows, opts) {
  const t0 = performance.now();
  const svg = buildSVG(g, { mode: 'outline', layout: LAYOUT });
  const ms = performance.now() - t0;
  const { poly, cmds } = parsePath(svgParts(svg).d);
  assert.equal(cmds.filter(c => c.c === 'M').length, 1, 'one subpath');
  const { X, Y, W } = centreline(g);
  const fill = fillCheck(poly, X, Y, W, [...windows, ...ends(X, Y)], opts);
  const st = svgStats(svg);
  console.log(`      n=${g.n} -> ${st.nodes} nodes, ${(st.bytes / 1024).toFixed(0)} KiB, ${ms.toFixed(0)} ms; IoU ${fill.iou.toFixed(4)}, worst ${fill.worst.toFixed(4)} mm ${JSON.stringify(fill.worstAt)}`);
  assert.ok(fill.worst <= OUTLINE_TOL, `outline off the renderer's shape by ${fill.worst.toFixed(4)} mm at ${JSON.stringify(fill.worstAt)}`);
  return svg;
}

for (const [rings, line] of [[16, { weight: 0.95, hairline: 0.02 }], [40, {}], [72, {}]]) {
  test(`svg outline on hard tone edges (${rings} rings): discs that swallow their neighbours' edges`, () => {
    const g = buildSpiral(buildField(hardRaster, hardTone.L, { rings }), { ...LINE_DEFAULTS, technique: 'thickness', rings, ...line });
    fs.writeFileSync(path.join(OUT, `export_outline_hard${rings}.svg`), outlineCase(g, CORNERS));
  });
}

for (const [name, make] of [
  ['maze square (checker)', () => buildMaze(buildField(hardRaster, hardTone.L, { rings: 40 }), { ...LINE_DEFAULTS, technique: 'thickness', rings: 40 }, { ...MAZE_DEFAULTS, shape: 'square', flow: 0.8 })],
  ['maze circle', () => buildMaze(buildField(raster, tone.L, { rings: 40 }), { ...LINE_DEFAULTS, technique: 'both', rings: 40 }, { ...MAZE_DEFAULTS, shape: 'circle', flow: 0.8 })],
  ['wander', () => buildWander(buildField(raster, tone.L, { rings: 64 }), { ...LINE_DEFAULTS, technique: 'thickness', rings: 64 }, { ...FREE_DEFAULTS })],
  ['contour', () => buildContour(buildField(raster, tone.L, { rings: 80 }), { ...LINE_DEFAULTS, technique: 'thickness', rings: 80 }, { ...FREE_DEFAULTS })],
]) {
  test(`svg outline on a ${name} path: exact against the render`, () => {
    const g = make();
    fs.writeFileSync(path.join(OUT, `export_outline_${name.split(' ')[0]}.svg`), outlineCase(g, [[40, 40], [94, 94], [130, 130], [60, 140], ...CORNERS.slice(0, 3)]));
  });
}

test('svg outline on random polylines: sharp turns, repeated points with new widths, zero widths, steep ramps', () => {
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const cases = [];
  for (let c = 0; c < 16; c++) {                     // random walks
    const pts = [];
    let x = 100, y = 100, a = rnd() * 6.28, w = 1;
    for (let i = 0; i < 40; i++) {
      pts.push([x, y, w]);
      if (rnd() < 0.08) pts.push([x, y, rnd() * 2]);            // same point, new width
      const step = rnd() < 0.3 ? 0.05 + rnd() * 0.2 : 0.3 + rnd() * 1.5;
      a += (rnd() - 0.5) * (rnd() < 0.3 ? 5.5 : 1.2);
      x += Math.cos(a) * step; y += Math.sin(a) * step;
      w = rnd() < 0.25 ? rnd() * 3 : Math.max(0, w + (rnd() - 0.5) * 0.8);
      if (rnd() < 0.05) w = 0;
    }
    cases.push(pts);
  }
  for (let c = 0; c < 8; c++) {                      // dense samples, steep smooth ramps: runs of swallowing discs
    const pts = [];
    let x = 94, y = 100, a = rnd() * 6.28, w = 0.1;
    const turn = (rnd() - 0.5) * 0.08;
    for (let i = 0; i < 150; i++) {
      const u = ((i + c * 7) % 60) / 60;
      const target = u < 0.2 ? 0.1 : u < 0.35 ? 0.1 + (u - 0.2) / 0.15 * (1.5 + rnd() * 2) : u < 0.6 ? 2.5 : u < 0.7 ? 2.5 - (u - 0.6) / 0.1 * 2.3 : 0.2;
      w += (target - w) * (0.3 + 0.6 * rnd());
      pts.push([x, y, w]);
      const step = 0.04 + rnd() * 0.12;
      a += turn + (rnd() - 0.5) * (rnd() < 0.05 ? 1.5 : 0.1);
      x += Math.cos(a) * step; y += Math.sin(a) * step;
    }
    cases.push(pts);
  }
  cases.push([[100, 100, 1.5], [100, 100, 0.4]]);                                   // a dot
  cases.push([[99, 100, 0.2], [101, 100.5, 2.5]]);                                  // one segment
  cases.push([[99, 100, 0.2], [99, 100, 2.2], [100, 101, 0.6], [101, 100, 0.3], [101, 100, 1.9], [101, 100, 0.1]]);
  cases.push([[98, 100, 0], [99, 100.2, 0], [100, 99.7, 1.2], [101, 100, 0], [102, 100, 0]]);
  let worst = 0, total = 0;
  for (const pts of cases) {
    const g = geomFromMm(pts);
    const { poly } = parsePath(svgParts(buildSVG(g, { mode: 'outline', layout: LAYOUT })).d);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y, w] of pts) { x0 = Math.min(x0, x - w); y0 = Math.min(y0, y - w); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + w); }
    const side = Math.max(x1 - x0, y1 - y0) + 0.2;
    const f = fillCheck(poly, pts.map(p => p[0]), pts.map(p => p[1]), pts.map(p => p[2]), [[x0 - 0.1, y0 - 0.1, side]]);
    total += f.samples;
    if (f.worst > worst) worst = f.worst;
    assert.ok(f.worst <= OUTLINE_TOL, `case ${cases.indexOf(pts)}: off by ${f.worst.toFixed(4)} mm at ${JSON.stringify(f.worstAt)}`);
  }
  console.log(`      ${cases.length} polylines, ${total} samples, worst ${worst.toFixed(4)} mm`);
});

/** Nearest distance from sampled ink to a stroked polyline (the plotter pen's path). */
function pathIndex(pts, cell = 0.5) {
  const grid = new Map();
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    for (let gx = Math.floor(Math.min(x0, x1) / cell); gx <= Math.floor(Math.max(x0, x1) / cell); gx++) {
      for (let gy = Math.floor(Math.min(y0, y1) / cell); gy <= Math.floor(Math.max(y0, y1) / cell); gy++) {
        const k = gx * 65536 + gy;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
    }
  }
  return (x, y) => {
    let best = cell;
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const i of grid.get((cx + a) * 65536 + cy + b) || []) best = Math.min(best, segDist(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
    }
    return best;
  };
}

test('svg plotter: the meander covers the whole band (smooth and hard tone)', () => {
  const pen = 0.3;
  for (const [name, g] of [['smooth', geoms.thickness], ['hard', buildSpiral(buildField(hardRaster, hardTone.L, { rings: 40 }), { ...LINE_DEFAULTS, technique: 'thickness', rings: 40 })]]) {
    const { pts } = parsePath(svgParts(buildSVG(g, { mode: 'plotter', layout: LAYOUT, penMm: pen })).d);
    const near = pathIndex(pts);
    const { X, Y, W } = centreline(g);
    const shape = shapeIndex(X, Y, W);
    let ink = 0, covered = 0, worst = 0, worstAt = null;
    for (const [wx, wy] of [[82, 62], [100, 118], [55, 100], [94, 94], ...CORNERS]) {
      for (let y = wy + 0.01; y < wy + 12; y += 0.02) for (let x = wx + 0.01; x < wx + 12; x += 0.02) {
        if (!shape.inside(x, y)) continue;
        ink++;
        const d = near(x, y);
        if (d <= pen / 2 + 0.005) covered++;
        if (d > worst) { worst = d; worstAt = [+x.toFixed(2), +y.toFixed(2)]; }
      }
    }
    const frac = covered / ink;
    console.log(`      ${name}: ${(frac * 100).toFixed(2)}% of ${ink} ink samples under the pen, farthest ${(worst - pen / 2).toFixed(3)} mm beyond its edge at ${JSON.stringify(worstAt)}`);
    // Only the scallops where a crossing meets the rim stay open (0.2 pen deep); a triangle wave
    // of the same period left teeth 3/8 of the band deep (83% coverage).
    assert.ok(frac >= 0.97, `${name}: coverage ${(frac * 100).toFixed(2)}%`);
    assert.ok(worst - pen / 2 <= 0.07, `${name}: ink ${(worst - pen / 2).toFixed(3)} mm beyond the pen at ${JSON.stringify(worstAt)}`);
  }
});

test('svg: description and layer name follow the path kind; ids are unique', () => {
  const field = buildField(raster, tone.L, { rings: 40 });
  const L = { ...LINE_DEFAULTS, technique: 'thickness', rings: 40 };
  for (const [g, desc, layer] of [
    [geoms.thickness, /A single unbroken spiral of 60 turns, [\d.]+ m of line on a 200 mm sheet\./, 'Spiral'],
    [buildMaze(field, L, { ...MAZE_DEFAULTS, shape: 'square' }), /A single unbroken line winding through a square maze 40 corridors across, [\d.]+ m of line/, 'Maze'],
    [buildMaze(field, L, { ...MAZE_DEFAULTS, shape: 'circle' }), /through a round maze 40 corridors across/, 'Maze'],
    [buildWander(field, L, { ...FREE_DEFAULTS }), /A single unbroken line wandering across the picture, [\d.]+ m/, 'Line'],
    [buildContour(field, L, { ...FREE_DEFAULTS }), /A single unbroken line tracing the outlines of the picture, [\d.]+ m/, 'Line'],
  ]) {
    for (const mode of ['outline', 'plotter']) {
      const svg = buildSVG(g, { mode, paper: '#ffffff' });
      assert.match(svg.match(/<desc>([^<]*)<\/desc>/)[1], desc);
      assert.match(svg, new RegExp(`inkscape:label="${layer}"`));
      const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
      assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(', ')}`);
      if (g.path !== 'spiral') assert.ok(!/spiral of/.test(svg), 'no spiral wording for other paths');
      if (mode === 'plotter') assert.match(svg, /sweeping back and forth across the line width/);
    }
  }
});

test('svg: default mode follows the technique, layout and size are honoured', () => {
  assert.match(buildSVG(geoms.wave), /fill="none"/);
  assert.match(buildSVG(geoms.thickness), /fill-rule="nonzero"/);
  const svg = buildSVG(geoms.thickness, { mode: 'stroke', sizeMm: 300, layout: { cx: 0.5, cy: 0.5, r: 0.3 } });
  assert.match(svg, /width="300mm" height="300mm" viewBox="0 0 300 300"/);
  const { pts } = parsePath(svgParts(svg).d);
  let maxR = 0;
  for (const [x, y] of pts) maxR = Math.max(maxR, Math.hypot(x - 150, y - 150));
  assert.ok(Math.abs(maxR - 90) < 1.5, `circle radius ${maxR} mm vs 90`);
  assert.throws(() => buildSVG(geoms.wave, { mode: 'bogus' }));
  // hostile colours never reach the markup
  assert.ok(!buildSVG(geoms.wave, { ink: '"/><script>' }).includes('<script>'));
});

test('svgStats: counts M/l pairs and arcs; bytes are UTF-8', () => {
  const svg = '<svg><title>Café</title><path d="M1 2l3 4 5 6a1 1 0 0 0 2 2z"/><path d="M0 0L1 1"/></svg>';
  assert.deepEqual(svgStats(svg), { paths: 2, nodes: 6, bytes: svg.length + 1 });   // é is 2 bytes
});

test('simplifyIndices: keeps ends, respects eps on a dense circle', () => {
  const n = 5000, X = new Float64Array(n), Y = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = i / (n - 1) * 20; X[i] = 50 + 40 * Math.cos(a); Y[i] = 50 + 40 * Math.sin(a); }
  const idx = simplifyIndices(X, Y, 0.02);
  assert.equal(idx[0], 0); assert.equal(idx[idx.length - 1], n - 1);
  const B = Array.from(idx, i => [X[i], Y[i]]);
  assert.ok(maxDeviation(X, Y, B).worst <= 0.02 + 1e-9);
  assert.ok(idx.length < n / 5, `kept ${idx.length}`);
});

test('fileName: slugged, prefixed, extension normalised', () => {
  assert.equal(fileName(['Portrait', 'Pencil', 4096], 'png'), 'spiralist-portrait-pencil-4096.png');
  assert.equal(fileName(['Spiralist', 'Café Olé!', ''], '.SVG'), 'spiralist-cafe-ole.svg');
  assert.equal(fileName([], 'mp4'), 'spiralist.mp4');
  assert.ok(fileName(['x'.repeat(300)], 'png').length <= 100);
});

// ------------------------------------------------------------------ PNG writer
/** Independent PNG decoder: verifies signature and every CRC, inflates, unfilters all 5 filters. */
function decodePNG(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  sig.forEach((b, i) => assert.equal(buf[i], b, 'signature'));
  let o = 8, ihdr, phys, idat = [], types = [], filters = [0, 0, 0, 0, 0];
  for (;;) {
    const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8);
    const body = buf.subarray(o + 8, o + 8 + len);
    const crc = buf.readUInt32BE(o + 8 + len);
    assert.equal(crc, zlib.crc32(buf.subarray(o + 4, o + 8 + len)), `CRC of ${type}`);
    types.push(type);
    if (type === 'IHDR') ihdr = { w: body.readUInt32BE(0), h: body.readUInt32BE(4), depth: body[8], ct: body[9], cm: body[10], fm: body[11], il: body[12] };
    if (type === 'pHYs') phys = { x: body.readUInt32BE(0), y: body.readUInt32BE(4), unit: body[8] };
    if (type === 'IDAT') idat.push(body);
    o += 12 + len;
    if (type === 'IEND') break;
  }
  assert.equal(o, buf.length, 'nothing after IEND');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const C = ihdr.ct === 6 ? 4 : 3, RB = ihdr.w * C;
  assert.equal(raw.length, ihdr.h * (RB + 1), 'inflated size');
  const px = new Uint8Array(ihdr.w * ihdr.h * C);
  for (let y = 0; y < ihdr.h; y++) {
    const f = raw[y * (RB + 1)];
    filters[f]++;
    const src = y * (RB + 1) + 1, dst = y * RB;
    for (let i = 0; i < RB; i++) {
      const a = i >= C ? px[dst + i - C] : 0, b = y ? px[dst - RB + i] : 0, c = y && i >= C ? px[dst - RB + i - C] : 0;
      let pred = 0;
      if (f === 1) pred = a; else if (f === 2) pred = b; else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + i] = (raw[src + i] + pred) & 255;
    }
  }
  return { ihdr, phys, types, px, filters, idatCount: idat.length };
}

/** Synthetic RGBA test card: gradients, noise (like paper grain), hard edges, partial alpha. */
function testCard(w, h, alpha) {
  const d = new Uint8Array(w * h * 4);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const ring = Math.hypot(x - w / 2, y - h / 2) % 23 < 6;
    d[i] = (x * 255 / w + (rnd() & 7)) & 255;
    d[i + 1] = ring ? 20 : (y * 255 / h) & 255;
    d[i + 2] = ((x ^ y) & 255);
    d[i + 3] = alpha ? (ring ? 255 : (x + y) & 255) : 255;
  }
  return d;
}

async function encodeCard(w, h, alpha, batches) {
  const card = testCard(w, h, alpha);
  const enc = new PNGEncoder(w, h, { alpha });
  // feed as bottom-up batches of varying height, like strips read back from WebGL
  let y = 0, bi = 0;
  while (y < h) {
    const rows = Math.min(batches[bi++ % batches.length], h - y);
    const strip = new Uint8Array(w * rows * 4);
    for (let k = 0; k < rows; k++) strip.set(card.subarray((y + rows - 1 - k) * w * 4, (y + rows - k) * w * 4), k * w * 4);
    await enc.addRows(strip, rows, true);
    y += rows;
  }
  const blob = await enc.finish();
  return { card, buf: Buffer.from(await blob.arrayBuffer()), type: blob.type };
}

function sameAsCard(px, card, w, h, C) {
  let bad = 0;
  for (let i = 0; i < w * h; i++) for (let c = 0; c < C; c++) if (px[i * C + c] !== card[i * 4 + c]) bad++;
  return bad;
}

for (const [w, h, alpha] of [[257, 131, false], [300, 301, true], [1, 1, false], [2048, 64, false]]) {
  test(`png ${w}x${h} ${alpha ? 'RGBA' : 'RGB'}: decodes byte-exact (node zlib), chunks + CRCs valid`, async () => {
    const { card, buf, type } = await encodeCard(w, h, alpha, [7, 1, 64, 13]);
    assert.equal(type, 'image/png');
    const dec = decodePNG(buf);
    assert.deepEqual(dec.ihdr, { w, h, depth: 8, ct: alpha ? 6 : 2, cm: 0, fm: 0, il: 0 });
    assert.deepEqual(dec.phys, { x: 11811, y: 11811, unit: 1 });
    assert.equal(dec.types[0], 'IHDR');
    assert.equal(dec.types[dec.types.length - 1], 'IEND');
    assert.ok(dec.types.indexOf('pHYs') < dec.types.indexOf('IDAT'));
    assert.equal(dec.filters[0] + dec.filters[3] + dec.filters[4], 0, 'only Sub/Up filters');
    assert.equal(sameAsCard(dec.px, card, w, h, alpha ? 4 : 3), 0, 'pixel mismatch');
    const f = path.join(OUT, `export_card_${w}x${h}_${alpha ? 'rgba' : 'rgb'}`);
    fs.writeFileSync(f + '.png', buf);
    fs.writeFileSync(f + '.raw', Buffer.from(card.buffer));
  });
}

test('png: Python/PIL decodes the same pixels and verifies the file', () => {
  const script = `
import sys, numpy as np
from PIL import Image
out = []
for stem, w, h, ch in [('export_card_257x131_rgb',257,131,3), ('export_card_300x301_rgba',300,301,4), ('export_card_2048x64_rgb',2048,64,3)]:
    p = sys.argv[1] + '/' + stem
    im = Image.open(p + '.png'); im.verify()
    im = Image.open(p + '.png'); im.load()
    raw = np.fromfile(p + '.raw', dtype=np.uint8).reshape(h, w, 4)[:, :, :ch]
    a = np.asarray(im)
    out.append(f"{stem} mode={im.mode} dpi={tuple(round(v,2) for v in im.info.get('dpi',(0,0)))} diff={int(np.abs(a.astype(int)-raw.astype(int)).max())}")
print('\\n'.join(out))
`;
  const res = execFileSync('python', ['-c', script, OUT], { encoding: 'utf8' });
  console.log('      ' + res.trim().split('\n').join('\n      '));
  const lines = res.trim().split(/\r?\n/);
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.match(line, /diff=0$/, line);
    assert.match(line, /dpi=\(300\.0\d*, 300\.0\d*\)|dpi=\(299\.99\d*, 299\.99\d*\)/, line);
  }
});

// ------------------------------------------------------------------ parallel (band) encoder
const adler32 = buf => {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
};

async function zlibOf(bytes) {
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  w.write(bytes); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

test('band encoder: sync-flushed deflate pieces concatenate into one valid zlib stream', async () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255;
  const inputs = [
    Uint8Array.from({ length: 1 << 20 }, rnd),                         // incompressible: stored blocks
    new Uint8Array(1 << 20),                                           // zeros: long matches
    Uint8Array.from({ length: 300000 }, (_, i) => 'one continuous line '.charCodeAt(i % 20) ^ (i % 997 === 0 ? 1 : 0)),
    Uint8Array.from({ length: 1 }, () => 42),
    new Uint8Array(0),                                                 // empty: a bare final block
    Uint8Array.from({ length: 70000 }, (_, i) => (i * 7) & 3),         // small alphabet: short codes
  ];
  const endBits = new Set();
  let adler = 1;
  const pieces = [new Uint8Array([0x78, 0x9c])];
  for (const inp of inputs) {
    const z = await zlibOf(inp);
    const raw = z.subarray(2, z.length - 4);
    const { finalBit, endBit } = _png.deflateEnds(raw);
    assert.ok(finalBit >= 0 && endBit > finalBit && Math.ceil(endBit / 8) === raw.length);
    endBits.add((raw.length * 8 - endBit) >= 3 ? 'fits' : 'spills');
    const part = _png.syncFlushPart(raw);
    // each piece alone + a final empty stored block must inflate to its input
    const alone = Buffer.concat([Buffer.from([0x78, 0x9c]), part, Buffer.from([1, 0, 0, 255, 255]), Buffer.alloc(4)]);
    alone.writeUInt32BE(adler32(inp), alone.length - 4);
    assert.ok(Buffer.from(zlib.inflateSync(alone)).equals(Buffer.from(inp)), `piece of ${inp.length} bytes`);
    const n = z.length, a = ((z[n - 4] << 24) | (z[n - 3] << 16) | (z[n - 2] << 8) | z[n - 1]) >>> 0;
    assert.equal(a, adler32(inp));
    adler = adler32Combine(adler, a, inp.length);
    pieces.push(part);
  }
  const tail = Buffer.alloc(9); tail.set([1, 0, 0, 255, 255]); tail.writeUInt32BE(adler, 5);
  const all = Buffer.concat([...pieces.map(p => Buffer.from(p)), tail]);
  const want = Buffer.concat(inputs.map(i => Buffer.from(i)));
  assert.ok(Buffer.from(zlib.inflateSync(all)).equals(want), 'concatenated stream');   // inflate checks Adler-32 too
  assert.equal(adler, adler32(want));
  console.log(`      ${inputs.length} pieces, ${(want.length / 1048576).toFixed(1)} MiB, end cases seen: ${[...endBits].join(', ')}`);
});

test('band encoder: every end-bit alignment case (fits / spills) on many small inputs', async () => {
  const seen = new Map();
  for (let len = 1; len <= 64; len++) {
    const inp = Uint8Array.from({ length: len }, (_, i) => (i * 37 + len) & 255);
    const raw = (await zlibOf(inp)).slice(2, -4);
    const { endBit } = _png.deflateEnds(raw);
    const free = raw.length * 8 - endBit;
    seen.set(free, (seen.get(free) || 0) + 1);
    const part = _png.syncFlushPart(raw);
    const s = Buffer.concat([Buffer.from([0x78, 0x9c]), part, Buffer.from([1, 0, 0, 255, 255]), Buffer.alloc(4)]);
    s.writeUInt32BE(adler32(inp), s.length - 4);
    assert.ok(Buffer.from(zlib.inflateSync(s)).equals(Buffer.from(inp)), `len ${len} free ${free}`);
  }
  console.log(`      free padding bits seen: ${[...seen.keys()].sort((a, b) => a - b).join(',')}`);
  assert.ok([...seen.keys()].some(f => f < 3) && [...seen.keys()].some(f => f >= 3), 'both alignment cases exercised');
});

for (const [w, h, alpha, bandRows] of [[257, 131, false, 17], [300, 301, true, 64], [2048, 200, false, 128]]) {
  test(`band encoder: ${w}x${h} ${alpha ? 'RGBA' : 'RGB'} in ${bandRows}-row bands assembles byte-exact`, async () => {
    const card = testCard(w, h, alpha);
    const C = alpha ? 4 : 3, stride = w * 4;
    const asm = new PNGAssembler(w, h, { alpha });
    // bands arrive bottom-up like readPixels strips, encoded out of order, each with the row above
    const jobs = [];
    for (let y = 0, i = 0; y < h; y += bandRows, i++) {
      const n = Math.min(bandRows, h - y);
      const px = new Uint8Array(n * stride);
      for (let k = 0; k < n; k++) px.set(card.subarray((y + n - 1 - k) * stride, (y + n - k) * stride), k * stride);
      const prev = y ? card.slice((y - 1) * stride, y * stride) : null;
      jobs.push([i, { px: px.buffer, prev: prev?.buffer || null, W: w, rows: n, C, bottomUp: true }]);
    }
    for (const [i, job] of jobs.reverse()) asm.set(i, await _png.encodeBand(job));
    const buf = Buffer.from(await asm.finish().arrayBuffer());
    const dec = decodePNG(buf);
    assert.deepEqual(dec.ihdr, { w, h, depth: 8, ct: alpha ? 6 : 2, cm: 0, fm: 0, il: 0 });
    assert.deepEqual(dec.phys, { x: 11811, y: 11811, unit: 1 });
    assert.equal(sameAsCard(dec.px, card, w, h, C), 0, 'pixel mismatch');
    assert.equal(dec.idatCount, jobs.length + 2, 'zlib header + one IDAT per band + tail');
    const f = path.join(OUT, `export_bands_${w}x${h}_${alpha ? 'rgba' : 'rgb'}`);
    fs.writeFileSync(f + '.png', buf);
    fs.writeFileSync(f + '.raw', Buffer.from(card.buffer));
  });
}

test('band encoder: Python/PIL verifies and decodes the assembled files exactly', () => {
  const script = `
import sys, numpy as np
from PIL import Image
for stem, w, h, ch in [('export_bands_257x131_rgb',257,131,3), ('export_bands_300x301_rgba',300,301,4), ('export_bands_2048x200_rgb',2048,200,3)]:
    p = sys.argv[1] + '/' + stem
    Image.open(p + '.png').verify()
    a = np.asarray(Image.open(p + '.png'))
    raw = np.fromfile(p + '.raw', dtype=np.uint8).reshape(h, w, 4)[:, :, :ch]
    print(stem, int(np.abs(a.astype(int) - raw.astype(int)).max()))
`;
  const lines = execFileSync('python', ['-c', script, OUT], { encoding: 'utf8' }).trim().split(/\r?\n/);
  console.log('      ' + lines.join('\n      '));
  assert.equal(lines.length, 3);
  for (const l of lines) assert.match(l, / 0$/, l);
});

test('band encoder: the worker source is self-contained and answers a job', async () => {
  const posted = [];
  const self = { postMessage: (m, t) => posted.push({ m, t }) };
  const ctx = vm.createContext({ self, CompressionStream, Response, Uint8Array, Uint16Array, Uint32Array, Int32Array, DataView, Error, String, Math });
  vm.runInContext(_png.WORKER_SOURCE(), ctx);
  const card = testCard(64, 8, false);
  await self.onmessage({ data: { id: 5, px: card.buffer, prev: null, W: 64, rows: 8, C: 3, bottomUp: false } });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].m.id, 5);
  assert.ok(!posted[0].m.error, posted[0].m.error);
  assert.equal(posted[0].m.len, 8 * (64 * 3 + 1));
  assert.equal(posted[0].t[0], posted[0].m.chunk.buffer, 'chunk buffer is transferred');
  await self.onmessage({ data: { id: 6, px: new ArrayBuffer(4), prev: null, W: 64, rows: 8, C: 3, bottomUp: false } });   // too short
  assert.ok(posted[1].m.error, 'a bad job reports an error instead of throwing');
});

test('adler32Combine matches a direct Adler-32', () => {
  const a = Buffer.from('Spiralist draws one line. '.repeat(5000)), b = Buffer.from('x'.repeat(70000));
  assert.equal(adler32Combine(adler32(a), adler32(b), b.length), adler32(Buffer.concat([a, b])));
  assert.equal(adler32Combine(1, adler32(b), b.length), adler32(b));
});

test('png: crc32 matches zlib on odd lengths', () => {
  for (const n of [0, 1, 3, 4, 5, 1023, 65537]) {
    const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 255;
    assert.equal(crc32(b), zlib.crc32(b), `n=${n}`);
  }
});

test('png: refuses to finish short, and too many rows', async () => {
  const enc = new PNGEncoder(4, 4);
  await enc.addRows(new Uint8Array(4 * 4 * 2), 2);
  await assert.rejects(() => enc.finish(), /rows/);
  const enc2 = new PNGEncoder(4, 2);
  await assert.rejects(() => enc2.addRows(new Uint8Array(4 * 4 * 3), 3), /too many rows/);
  enc2.abort();
});

test('png: 4096x512 RGB strip throughput (filter + deflate + CRC)', async () => {
  const w = 4096, h = 512, card = testCard(w, h, false);
  const enc = new PNGEncoder(w, 4096);
  const t0 = performance.now();
  for (let k = 0; k < 8; k++) await enc.addRows(card, h, true);
  const blob = await enc.finish();
  const ms = performance.now() - t0;
  console.log(`      4096x4096 synthetic: ${ms.toFixed(0)} ms, ${(blob.size / 1048576).toFixed(1)} MiB`);
  decodePNG(Buffer.from(await blob.arrayBuffer()));
});

for (const [name, fn] of tests) {
  try { await fn(); console.log('ok   ', name); }
  catch (e) { failures++; console.log('FAIL ', name, '\n     ', e.message); }
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
