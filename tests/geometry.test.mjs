// Node tests for the pure engine: tone processing + spiral geometry.
// Run: node tests/geometry.test.mjs
import assert from 'node:assert/strict';
import { rasterFromRGBA, processTone, buildField, levels, boxBlur, boxRadiusForSigma, sampleField, TONE_DEFAULTS, coverageTarget } from '../js/tone.js';
import { buildMaze, growMaze } from '../js/maze.js';
import { buildWander, buildContour } from '../js/freeline.js';
import { buildSpiral, indexAt, headAt, progressAt, pacingTable, previewStroke, STRIDE, LINE_DEFAULTS, MAX_POINTS, printedLength } from '../js/spiral.js';

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ', name); }
  catch (e) { failures++; console.log('FAIL ', name, '\n     ', e.message); }
}

// Synthetic photo: dark disc on a light-grey gradient, with a transparent corner.
function synthRGBA(G, kind = 'disc') {
  const px = new Uint8ClampedArray(G * G * 4);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    const i = (y * G + x) * 4;
    const u = x / G, v = y / G;
    let l = 200 - 120 * u;
    if (kind === 'disc' && (u - 0.5) ** 2 + (v - 0.45) ** 2 < 0.04) l = 20;
    if (kind === 'flat') l = 128;
    if (kind === 'gradient') l = 30 + 200 * Math.hypot(u - 0.5, v - 0.5) / 0.71;
    px[i] = px[i + 1] = px[i + 2] = l;
    px[i + 3] = (kind === 'disc' && u > 0.9 && v > 0.9) ? 0 : 255;
  }
  return px;
}

const G = 512;
const raster = rasterFromRGBA(synthRGBA(G), G);

test('raster: transparent pixels composite to white and leave the mask', () => {
  const i = (G - 2) * G + (G - 2);
  assert.equal(raster.luma[i], 1);
  assert.equal(raster.mask[i], 0);
  // centre pixel is inside the circle and opaque
  assert.equal(raster.mask[(G / 2) * G + G / 2], 1);
});

test('levels: flat photo is not stretched', () => {
  const flat = rasterFromRGBA(synthRGBA(64, 'flat'), 64);
  assert.deepEqual(levels(flat.luma, flat.mask), [0, 1]);
});

test('levels: stretches a real range', () => {
  const [lo, hi] = levels(raster.luma, raster.mask);
  assert.ok(lo < 0.15 && hi > 0.7, `lo=${lo} hi=${hi}`);
});

test('boxBlur preserves the mean and constant fields', () => {
  const a = new Float32Array(64 * 64).fill(0.3);
  boxBlur(a, 64, 3);
  for (const v of a) assert.ok(Math.abs(v - 0.3) < 1e-5);
  const b = new Float32Array(64 * 64); b[32 * 64 + 32] = 1;
  boxBlur(b, 64, 2);
  const sum = b.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - 1) < 1e-4, `sum=${sum}`);
  assert.equal(boxRadiusForSigma(0.3), 0);
  assert.ok(boxRadiusForSigma(5) >= 4);
});

test('processTone: output in [0,1], dark disc stays darker than background', () => {
  const { L } = processTone(raster, TONE_DEFAULTS);
  let min = 1, max = 0;
  for (const v of L) { min = Math.min(min, v); max = Math.max(max, v); }
  assert.ok(min >= 0 && max <= 1);
  const disc = L[Math.round(0.45 * G) * G + G / 2];
  const bg = L[Math.round(0.8 * G) * G + Math.round(0.3 * G)];
  assert.ok(disc < bg - 0.3, `disc=${disc} bg=${bg}`);
});

test('processTone (manual): brightness up and darkness down both lighten', () => {
  const manual = { ...TONE_DEFAULTS, auto: false, detail: 0 };
  const base = processTone(raster, manual).L;
  const bright = processTone(raster, { ...manual, brightness: 0.5 }).L;
  const lighter = processTone(raster, { ...manual, darkness: -0.6 }).L;
  const i = Math.round(0.8 * G) * G + Math.round(0.5 * G);
  assert.ok(bright[i] > base[i]);
  assert.ok(lighter[i] > base[i]);
});

test('processTone (auto): hits the ink-coverage target for both polarities', () => {
  const grad = rasterFromRGBA(synthRGBA(256, 'gradient'), 256);
  for (const flip of [false, true]) {
    for (const darkness of [-1, 0, 1]) {
      const { stats } = processTone(grad, { ...TONE_DEFAULTS, darkness }, { flip });
      const target = coverageTarget(darkness);
      assert.ok(Math.abs(stats.coverage - target) < 0.02, `flip=${flip} d=${darkness}: ${stats.coverage} vs ${target}`);
    }
  }
});

test('processTone: a flat photo is flagged', () => {
  const flat = rasterFromRGBA(synthRGBA(64, 'flat'), 64);
  assert.equal(processTone(flat, TONE_DEFAULTS).stats.flat, true);
  assert.equal(processTone(raster, TONE_DEFAULTS).stats.flat, false);
});

const L0 = processTone(raster, TONE_DEFAULTS);
const field = buildField(raster, L0.L, { rings: 60 });

test('field: darkness is 1-lightness, flip inverts', () => {
  const f2 = buildField(raster, L0.L, { rings: 60, flip: true });
  const i = (G / 2) * G + G / 2;
  assert.ok(Math.abs(field.D[i] + f2.D[i] - 1) < 1e-4);
  assert.ok(sampleField(field, 0, -0.1) > 0.6, 'disc centre should be dark');
  assert.equal(sampleField(field, 5, 5), 0, 'outside the grid is blank paper');
});

function segStats(g) {
  let maxSeg = 0, maxR = 0, sBad = 0;
  for (let i = 0; i < g.n; i++) {
    const o = i * STRIDE;
    const r = Math.hypot(g.data[o], g.data[o + 1]);
    maxR = Math.max(maxR, r + g.data[o + 2] / 2);
    if (i) {
      const p = o - STRIDE;
      maxSeg = Math.max(maxSeg, Math.hypot(g.data[o] - g.data[p], g.data[o + 1] - g.data[p + 1]));
      if (g.data[o + 3] < g.data[p + 3] - 1e-6) sBad++;
    }
  }
  return { maxSeg, maxR, sBad };
}

// Ring clearance: for points at the same angle on neighbouring rings, the stroke edges must not touch.
function minRingGap(g) {
  const bins = 720;
  const byTurn = new Map(); // key: ringIndex*bins+angleBin -> {r, w}
  let minGap = Infinity;
  for (let i = 0; i < g.n; i++) {
    const o = i * STRIDE;
    const x = g.data[o], y = g.data[o + 1], w = g.data[o + 2], t = g.data[o + 5];
    const ang = ((Math.atan2(y, x) / (2 * Math.PI)) + 1) % 1;
    const bin = Math.floor(ang * bins);
    const ring = Math.round(t + 0.5 - ang);   // turns count from theta = pi; same angle on consecutive turns differs by 1
    const key = ring * bins + bin;
    const r = Math.hypot(x, y);
    const cur = byTurn.get(key);
    // keep the extreme outward excursion for this ring/bin and inward for the next
    if (!cur) byTurn.set(key, { rMax: r + w / 2, rMin: r - w / 2 });
    else { cur.rMax = Math.max(cur.rMax, r + w / 2); cur.rMin = Math.min(cur.rMin, r - w / 2); }
  }
  for (const [key, v] of byTurn) {
    const ring = Math.floor(key / bins), bin = key % bins;
    if (ring < 3) continue;           // the settling centre is allowed to be tight
    const next = byTurn.get((ring + 1) * bins + bin);
    if (next) minGap = Math.min(minGap, next.rMin - v.rMax);
  }
  return minGap;
}

for (const technique of ['thickness', 'wave', 'both']) {
  test(`spiral(${technique}): continuous, monotone length, inside the circle, rings never touch`, () => {
    const t0 = performance.now();
    const g = buildSpiral(field, { ...LINE_DEFAULTS, technique, wobble: 0.5 });
    const ms = performance.now() - t0;
    const st = segStats(g);
    assert.ok(g.n > 1000 && g.n <= MAX_POINTS + 16, `n=${g.n}`);
    assert.ok(st.maxSeg < g.spacing * 0.5, `max segment ${st.maxSeg} vs spacing ${g.spacing}`);
    assert.equal(st.sBad, 0, 'arc length must be monotone');
    assert.ok(st.maxR <= 1 + g.spacing, `maxR=${st.maxR}`);
    assert.ok(Math.abs(g.turns - (g.rings - 0.5)) < 0.01, `turns=${g.turns}`);   // starts half a turn out
    const gap = minRingGap(g);
    assert.ok(gap > -1e-4, `rings touch: gap=${gap} (spacing ${g.spacing})`);
    console.log(`      n=${g.n} length=${g.length.toFixed(1)} ${ms.toFixed(0)}ms gap=${(gap / g.spacing).toFixed(3)}d printed=${printedLength(g).toFixed(1)}m`);
  });
}

test('spiral: 200-ring wave stays under the point budget', () => {
  const g = buildSpiral(field, { ...LINE_DEFAULTS, technique: 'wave', rings: 200, frequency: 3 });
  assert.ok(g.n <= MAX_POINTS + 16, `n=${g.n}`);
  assert.ok(segStats(g).maxSeg < g.spacing * 0.5);
});

test('spiral: dark areas are thicker than light areas (thickness)', () => {
  const g = buildSpiral(field, { ...LINE_DEFAULTS, technique: 'thickness', softEdge: 0.01 });
  let dark = 0, light = 0, nd = 0, nl = 0;
  for (let i = 0; i < g.n; i++) {
    const o = i * STRIDE;
    if (g.data[o + 4] > 0.7) { dark += g.data[o + 2]; nd++; }
    if (g.data[o + 4] < 0.3) { light += g.data[o + 2]; nl++; }
  }
  assert.ok(nd > 0 && nl > 0);
  assert.ok(dark / nd > 2 * (light / nl));
});

test('spiral: start at edge reverses order, keeps length', () => {
  const a = buildSpiral(field, { ...LINE_DEFAULTS, start: 'center', wobble: 0 });
  const b = buildSpiral(field, { ...LINE_DEFAULTS, start: 'edge', wobble: 0 });
  assert.equal(a.n, b.n);
  assert.ok(Math.abs(a.length - b.length) < 1e-3 * a.length);
  const rFirst = Math.hypot(b.data[0], b.data[1]);
  assert.ok(rFirst > 0.95, `edge start r=${rFirst}`);
  assert.equal(b.data[3], 0);
});

test('spiral: ccw mirrors cw', () => {
  const a = buildSpiral(field, { ...LINE_DEFAULTS, wobble: 0 });
  const b = buildSpiral(buildField(raster, L0.L, { rings: 60 }), { ...LINE_DEFAULTS, wobble: 0, direction: 'ccw' });
  assert.equal(a.n, b.n);
  const k = Math.floor(a.n / 2) * STRIDE;
  assert.ok(Math.abs(a.data[k] - b.data[k]) < 1e-6);
  assert.ok(Math.abs(a.data[k + 1] + b.data[k + 1]) < 1e-6);
});

test('indexAt / progressAt / headAt: monotone, inverse, within range for all pacings', () => {
  const g = buildSpiral(field, { ...LINE_DEFAULTS, technique: 'wave' });
  for (const pacing of ['natural', 'steady', 'rings']) {
    let prev = -1;
    for (let k = 0; k <= 100; k++) {
      const fi = indexAt(g, k / 100, pacing);
      assert.ok(fi >= prev - 1e-9, `${pacing} not monotone at ${k}`);
      assert.ok(fi >= 0 && fi <= g.n - 1);
      const back = progressAt(g, fi, pacing);
      assert.ok(Math.abs(back - k / 100) < 1e-3, `${pacing} inverse at ${k}: ${back}`);
      prev = fi;
    }
    assert.equal(indexAt(g, 0, pacing), 0);
    assert.equal(indexAt(g, 1, pacing), g.n - 1);
    assert.equal(pacingTable(g, pacing).length, g.n);
  }
  const h = headAt(g, g.n - 1);
  assert.ok(Math.hypot(h.x, h.y) > 0.9);
  // 'rings' pacing at 50% should be about half the radius
  const he = headAt(g, indexAt(g, 0.5, 'rings'));
  assert.ok(Math.abs(Math.hypot(he.x, he.y) - 0.5) < 0.05, 'rings pacing radius');
  // for a plain spiral (no wave) equal path length means radius ~ sqrt(f)
  const gt = buildSpiral(field, { ...LINE_DEFAULTS, technique: 'thickness', wobble: 0 });
  const hp = headAt(gt, indexAt(gt, 0.5, 'steady'));
  assert.ok(Math.abs(Math.hypot(hp.x, hp.y) - Math.SQRT1_2) < 0.03, 'steady pacing radius');
});

test('previewStroke: valid geometry for brush chips', () => {
  for (const technique of ['thickness', 'wave']) {
    const g = previewStroke({ technique });
    assert.ok(g.n > 100);
    assert.equal(g.data.length, g.n * STRIDE);
    assert.ok(segStats(g).maxSeg < 0.05);
  }
});

test('wobble never makes rings touch, even at maximum', () => {
  for (const technique of ['thickness', 'wave', 'both']) {
    for (const rings of [24, 72, 150]) {
      const f = buildField(raster, L0.L, { rings });
      const g = buildSpiral(f, { ...LINE_DEFAULTS, technique, rings, wobble: 1, weight: 1, amplitude: 1, edgeFade: 0 });
      const gap = minRingGap(g);
      assert.ok(gap > -1e-5, `${technique} rings=${rings} gap=${(gap / g.spacing).toFixed(3)}d`);
    }
  }
});

test('colour from photo fills RGBA per point', () => {
  const g = buildSpiral(field, { ...LINE_DEFAULTS }, { colorFromPhoto: true });
  assert.ok(g.colors && g.colors.length === g.n * 4);
  assert.equal(g.colors[3], 255);
});

// ------------------------------------------------------------------ maze
function minNonLocalDistance(g, skip) {
  // spatial hash of centre-line points; compare points further apart along the line than `skip`
  const cell = g.spacing;
  const map = new Map();
  let min = Infinity;
  for (let i = 0; i < g.n; i++) {
    const o = i * STRIDE, x = g.data[o], y = g.data[o + 1], s = g.data[o + 3];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const list = map.get((cx + dx) * 100003 + (cy + dy));
      if (!list) continue;
      for (const j of list) {
        const p = j * STRIDE;
        if (s - g.data[p + 3] <= skip) continue;
        min = Math.min(min, Math.hypot(x - g.data[p], y - g.data[p + 1]));
      }
    }
    const k = cx * 100003 + cy;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(i);
  }
  return min;
}

for (const shape of ['square', 'circle']) {
  test(`maze(${shape}): one continuous non-crossing line inside the frame, starting at the chosen point`, () => {
    const t0 = performance.now();
    const g = buildMaze(field, { ...LINE_DEFAULTS, rings: 48, wobble: 0 }, { shape, x: 0.3, y: -0.2, seed: 7 });
    const ms = performance.now() - t0;
    const st = segStats(g);
    assert.equal(g.path, 'maze');
    assert.ok(st.maxSeg < g.spacing * 0.5, `max segment ${st.maxSeg}`);
    assert.equal(st.sBad, 0);
    const d0 = Math.hypot(g.data[0] - 0.3, g.data[1] + 0.2);
    assert.ok(d0 < g.spacing * 3, `starts ${d0} away from the chosen point`);
    let maxR = 0, maxAbs = 0;
    for (let i = 0; i < g.n; i++) {
      const x = g.data[i * STRIDE], y = g.data[i * STRIDE + 1];
      maxR = Math.max(maxR, Math.hypot(x, y)); maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(y));
    }
    if (shape === 'circle') assert.ok(maxR <= 1, `maxR ${maxR}`); else assert.ok(maxAbs <= 1, `maxAbs ${maxAbs}`);
    const md = minNonLocalDistance(g, g.spacing * 3);
    assert.ok(md > g.spacing * 0.7, `lines come within ${(md / g.spacing).toFixed(2)} spacings`);
    for (let i = 1; i < g.n; i++) assert.ok(g.data[i * STRIDE + 5] >= g.data[(i - 1) * STRIDE + 5] - 1e-6, 'order key monotone');
    console.log(`      n=${g.n} length=${g.length.toFixed(1)} ${ms.toFixed(0)}ms minDist=${(md / g.spacing).toFixed(2)}h`);
  });
}

test('maze: spanning tree covers every included cell exactly once', () => {
  const t = growMaze(field, { cells: 40, shape: 'circle', x: 0, y: 0, flow: 0.8, seed: 3 });
  let edges = 0, inside = 0;
  for (let k = 0; k < t.n * t.n; k++) {
    if (!t.inside[k]) continue;
    inside++;
    const o = t.open[k];
    edges += (o & 1 ? 1 : 0) + (o & 2 ? 1 : 0) + (o & 4 ? 1 : 0) + (o & 8 ? 1 : 0);
    assert.ok(o !== 0, 'every cell is connected');
  }
  assert.equal(edges / 2, inside - 1, 'a tree has cells-1 edges');
});

test('maze: deterministic per seed, different across seeds', () => {
  const a = buildMaze(field, { ...LINE_DEFAULTS, rings: 30 }, { seed: 5 });
  const b = buildMaze(field, { ...LINE_DEFAULTS, rings: 30 }, { seed: 5 });
  const c = buildMaze(field, { ...LINE_DEFAULTS, rings: 30 }, { seed: 6 });
  assert.equal(a.n, b.n);
  assert.deepEqual(Array.from(a.data.subarray(0, 700)), Array.from(b.data.subarray(0, 700)));
  assert.notDeepEqual(Array.from(a.data.subarray(0, 700)), Array.from(c.data.subarray(0, 700)));
});

test('maze: wave + wobble keep lines apart, 160 corridors stay under budget', () => {
  const g = buildMaze(field, { ...LINE_DEFAULTS, rings: 40, technique: 'wave', wobble: 1, amplitude: 1 }, { seed: 2 });
  const md = minNonLocalDistance(g, g.spacing * 3);
  assert.ok(md > g.spacing * 0.3, `min ${md / g.spacing}`);
  const big = buildMaze(field, { ...LINE_DEFAULTS, rings: 160 }, { seed: 2 });
  assert.ok(big.n <= MAX_POINTS + 16, `n=${big.n}`);
});

// ------------------------------------------------------------------ free lines (wander, contour)
function countCrossings(g, stepSkip = 3) {
  // segment intersection test over a spatial hash of segments (centre line)
  const cell = g.spacing * 1.5;
  const map = new Map();
  let crossings = 0;
  const seg = i => [g.data[i * STRIDE], g.data[i * STRIDE + 1], g.data[(i + 1) * STRIDE], g.data[(i + 1) * STRIDE + 1]];
  const inter = (a, b) => {
    const d = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const p1 = [a[0], a[1]], p2 = [a[2], a[3]], q1 = [b[0], b[1]], q2 = [b[2], b[3]];
    return d(p1, p2, q1) * d(p1, p2, q2) < 0 && d(q1, q2, p1) * d(q1, q2, p2) < 0;
  };
  for (let i = 0; i < g.n - 1; i++) {
    const s = seg(i);
    const cx = Math.floor((s[0] + s[2]) / 2 / cell), cy = Math.floor((s[1] + s[3]) / 2 / cell);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const list = map.get((cx + dx) * 100003 + (cy + dy));
      if (!list) continue;
      for (const j of list) if (i - j > stepSkip && inter(s, seg(j))) crossings++;
    }
    const k = cx * 100003 + cy;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(i);
  }
  return crossings;
}

for (const shape of ['square', 'circle']) {
  test(`wander(${shape}): continuous, inside the frame, starts at the chosen point, tidy`, () => {
    const t0 = performance.now();
    const g = buildWander(field, { ...LINE_DEFAULTS, rings: 60, wobble: 0 }, { shape, x: -0.3, y: 0.25, seed: 4 });
    const ms = performance.now() - t0;
    const st = segStats(g);
    assert.equal(g.path, 'wander');
    assert.ok(g.n > 2000 && g.n <= MAX_POINTS, `n=${g.n}`);
    assert.ok(st.maxSeg < g.spacing, `max segment ${st.maxSeg}`);
    assert.equal(st.sBad, 0);
    assert.ok(Math.hypot(g.data[0] + 0.3, g.data[1] - 0.25) < g.spacing * 2, 'starts at the chosen point');
    for (let i = 0; i < g.n; i++) {
      const x = g.data[i * STRIDE], y = g.data[i * STRIDE + 1];
      const out = shape === 'circle' ? Math.hypot(x, y) > 1.001 : Math.max(Math.abs(x), Math.abs(y)) > 1.001;
      assert.ok(!out, `point ${i} outside the frame (${x}, ${y})`);
    }
    const cr = countCrossings(g);
    assert.ok(cr <= g.n * 0.002, `${cr} crossings`);
    console.log(`      n=${g.n} length=${g.length.toFixed(1)} ${ms.toFixed(0)}ms crossings=${cr}`);
  });
}

test('wander: darker areas get more line (packing follows tone)', () => {
  const g = buildWander(field, { ...LINE_DEFAULTS, rings: 60 }, { seed: 1 });
  // line length per area near the dark disc vs in the light gradient corner
  let dark = 0, light = 0;
  for (let i = 1; i < g.n; i++) {
    const o = i * STRIDE, x = g.data[o], y = g.data[o + 1];
    const ds = g.data[o + 3] - g.data[o - STRIDE + 3];
    if (Math.hypot(x, y + 0.1) < 0.25) dark += ds;
    if (x > 0.55 && x < 0.95 && y > 0.4 && y < 0.8) light += ds;
  }
  const areaDark = Math.PI * 0.25 * 0.25, areaLight = 0.4 * 0.4;
  assert.ok(dark / areaDark > 2 * light / areaLight, `dark ${(dark / areaDark).toFixed(1)} vs light ${(light / areaLight).toFixed(1)}`);
});

test('wander + contour: deterministic per seed', () => {
  const a = buildWander(field, { ...LINE_DEFAULTS, rings: 40 }, { seed: 9 });
  const b = buildWander(field, { ...LINE_DEFAULTS, rings: 40 }, { seed: 9 });
  assert.equal(a.n, b.n);
  assert.deepEqual(Array.from(a.data.subarray(0, 500)), Array.from(b.data.subarray(0, 500)));
  const c = buildContour(field, { ...LINE_DEFAULTS, rings: 60 }, { seed: 9 });
  const d = buildContour(field, { ...LINE_DEFAULTS, rings: 60 }, { seed: 9 });
  assert.equal(c.n, d.n);
});

for (const shape of ['square', 'circle']) {
  test(`contour(${shape}): one continuous line of outlines inside the frame`, () => {
    const t0 = performance.now();
    const g = buildContour(field, { ...LINE_DEFAULTS, rings: 70 }, { shape, x: 0.1, y: -0.1, seed: 2 });
    const ms = performance.now() - t0;
    const st = segStats(g);
    assert.equal(g.path, 'contour');
    assert.ok(g.n > 200, `n=${g.n}`);
    assert.ok(st.maxSeg < g.spacing, `max segment ${st.maxSeg}`);
    assert.equal(st.sBad, 0);
    assert.ok(g.outlines >= 1, `outlines=${g.outlines}`);
    for (let i = 0; i < g.n; i++) {
      const x = g.data[i * STRIDE], y = g.data[i * STRIDE + 1];
      const out = shape === 'circle' ? Math.hypot(x, y) > 1.001 : Math.max(Math.abs(x), Math.abs(y)) > 1.001;
      assert.ok(!out, `outside the frame at ${i}`);
    }
    console.log(`      n=${g.n} length=${g.length.toFixed(1)} ${ms.toFixed(0)}ms outlines=${g.outlines} levels=${g.levels}`);
  });
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
