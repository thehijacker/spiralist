// Node tests for the cinematic camera (js/scene.js): projection maths and the film director.
// Run: node tests/scene.test.mjs
import assert from 'node:assert/strict';
import { cameraBasis, project, planeTransform, planCamera } from '../js/scene.js';

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ', name); }
  catch (e) { failures++; console.log('FAIL ', name, '\n     ', e.message); }
}
const DEG = Math.PI / 180;

// The shader casts a ray per pixel: d = f + r (sx - W/2) / F + d (sy - H/2) / F, hit h = 0.
function unproject(b, sx, sy) {
  const d = [0, 1, 2].map(k => b.f[k] + b.r[k] * (sx - b.W / 2) / b.F + b.d[k] * (sy - b.H / 2) / b.F);
  const t = -b.C[2] / d[2];
  return [b.C[0] + d[0] * t, b.C[1] + d[1] * t, t];
}

test('project and the shader ray agree (tip lands where the line is drawn)', () => {
  const cams = [
    { tx: 0, ty: 0.1, zoom: 1, pitch: 0, yaw: 0, roll: 0 },
    { tx: -0.2, ty: 0.15, zoom: 2.7, pitch: 23 * DEG, yaw: -7 * DEG, roll: 1.1 * DEG },
    { tx: 0.1, ty: -0.3, zoom: 1.6, pitch: 12 * DEG, yaw: 5 * DEG, roll: -0.5 * DEG },
  ];
  for (const cam of cams) {
    const b = cameraBasis(cam, 1080, 1920, 930);
    for (const [x, y] of [[0, 0], [0.3, -0.2], [-0.45, 0.4], [cam.tx, cam.ty]]) {
      const [sx, sy, z] = project(b, x, y);
      const [px, py, t] = unproject(b, sx, sy);
      assert.ok(Math.hypot(px - x, py - y) < 1e-9, `round trip off by ${Math.hypot(px - x, py - y)}`);
      assert.ok(Math.abs(t - z) < 1e-9, 'depth differs');
    }
    // the target is always at the frame centre
    const [cx, cy] = project(b, cam.tx, cam.ty);
    assert.ok(Math.hypot(cx - 540, cy - 960) < 1e-6);
  }
});

test('zoom 1, straight down: the sheet is exactly `side` px wide', () => {
  const b = cameraBasis({ tx: 0, ty: 0, zoom: 1, pitch: 0, yaw: 0, roll: 0 }, 1080, 1080, 928);
  const a = project(b, -0.5, 0), c = project(b, 0.5, 0);
  assert.ok(Math.abs(c[0] - a[0] - 928) < 1e-6);
  const pt = planeTransform(b, 0.2, 0.1);
  assert.ok(Math.abs(Math.hypot(pt[0], pt[1]) - 928) < 1e-3 && Math.abs(pt[1]) < 1e-9 && Math.abs(pt[2]) < 1e-9);
});

// Synthetic pens over a 10 s film: t0 = 0.6, t1 = 7.85
const T0 = 0.6, T1 = 7.85, LEN = 10;
const frame = { W: 1080, H: 1920, side: 928, cx: 540, cy: 806 };
const art = { x: 0, y: 0, r: 0.42 };
const safe = [0.1, 0.1, 0.9, 0.76];
const ramp = t => { const u = Math.min(1, Math.max(0, (t - T0) / (T1 - T0))); return u * u * (3 - 2 * u); };
const heads = {
  // centre-out spiral: radius ~ sqrt(progress), 60 turns
  center: t => { const p = ramp(t), r = 0.42 * Math.sqrt(p), a = p * 60 * 2 * Math.PI; return [r * Math.cos(a), r * Math.sin(a)]; },
  edge: t => { const p = ramp(t), r = 0.42 * Math.sqrt(1 - p), a = p * 60 * 2 * Math.PI; return [r * Math.cos(a), r * Math.sin(a)]; },
  // a roaming pen: fast local wiggle riding a slow tour of the art square, from a corner
  follow: t => {
    const p = ramp(t);
    const x = -0.3 + 0.55 * Math.sin(p * 5.1) * Math.cos(p * 2.3) + 0.04 * Math.sin(p * 900);
    const y = 0.3 - 0.6 * p + 0.25 * Math.sin(p * 7.7) + 0.04 * Math.cos(p * 1100);
    return [Math.max(-0.42, Math.min(0.42, x)), Math.max(-0.42, Math.min(0.42, y))];
  },
};
const plan = mode => planCamera({ length: LEN, t0: T0, t1: T1, tSettle: T1 + 0.15, tFinal: T1 + 0.95, head: heads[mode], mode, art, frame, safe });

for (const mode of ['center', 'edge', 'follow']) {
  const P = plan(mode);
  test(`${mode}: deterministic`, () => {
    const Q = plan(mode);
    for (const k of Object.keys(P.track)) assert.deepEqual(Array.from(P.track[k]), Array.from(Q.track[k]));
  });

  test(`${mode}: ends on the exact, straight full-sheet framing and holds it`, () => {
    for (let t = T1 + 0.95; t <= LEN; t += 0.1) {
      const c = P.at(t);
      const off = Math.max(Math.abs(c.zoom - 1), Math.abs(c.pitch), Math.abs(c.yaw), Math.abs(c.roll));
      assert.ok(off < 1e-9, `not straight at ${t.toFixed(2)} s (off by ${off})`);
      assert.ok(Math.abs(c.tx - 0) < 1e-9 && Math.abs(c.ty - (960 - 806) / 928) < 1e-9, `target ${c.tx}, ${c.ty}`);
    }
  });

  test(`${mode}: no jerks (acceleration changes smoothly, sampled at 60 Hz)`, () => {
    const hz = P.hz;
    // largest change of acceleration per sample, per channel, against generous bounds
    const bounds = { zoom: 2e-4, pitch: 5e-5, yaw: 2e-5, roll: 5e-6, tx: 5e-5, ty: 5e-5 };
    for (const [k, lim] of Object.entries(bounds)) {
      const a = P.track[k];
      let worst = 0;
      for (let i = 3; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - 3 * a[i - 1] + 3 * a[i - 2] - a[i - 3]));
      assert.ok(worst < lim, `${k}: third difference ${worst.toExponential(2)} >= ${lim} (${hz} Hz)`);
    }
  });

  test(`${mode}: the pen tip stays in frame (full perspective projection)`, () => {
    let worst = 0;
    for (let t = 0; t <= LEN; t += 1 / 60) {
      const b = cameraBasis(P.at(t), frame.W, frame.H, frame.side);
      const [x, y] = heads[mode](t);
      const [sx, sy] = project(b, x, y);
      const out = Math.max(0.04 * frame.W - sx, sx - 0.96 * frame.W, 0.04 * frame.H - sy, sy - 0.82 * frame.H);
      worst = Math.max(worst, out);
    }
    assert.ok(worst <= 0, `tip leaves the frame by ${worst.toFixed(1)} px`);
  });
}

test('center: opens on an extreme close-up, tilted, and pulls back as the drawing grows', () => {
  const P = plan('center');
  const c0 = P.at(0.3), c1 = P.at(T0 + 0.3), cMid = P.at((T0 + T1) / 2);
  assert.ok(c0.zoom > 2.4 && c0.zoom <= 2.81, `intro zoom ${c0.zoom}`);
  assert.ok(c0.pitch > 18 * DEG && c0.pitch < 26 * DEG, `intro pitch ${c0.pitch / DEG}`);
  assert.ok(c1.zoom > 2.4, `still close just after touchdown: ${c1.zoom}`);
  assert.ok(cMid.zoom < c1.zoom && cMid.pitch < c0.pitch, 'pulls back and straightens');
  let prev = Infinity;
  for (let t = T0 + 0.5; t < T1 + 1.0; t += 0.05) { const z = P.at(t).zoom; assert.ok(z <= prev + 1e-3, `zoom rises at ${t.toFixed(2)}`); prev = z; }
});

test('sheet texture budget: maxZoom covers the close-up', () => {
  const P = plan('center');
  assert.ok(P.maxZoom >= 2.8 && P.maxZoom < 3.4, `maxZoom ${P.maxZoom}`);
});

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nall passed');
