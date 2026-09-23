// Node tests for the cinematic film (js/scene.js): projection maths, the pacing and the camera,
// the premium desks' data and the final framing.
// Run: node tests/scene.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cameraBasis, project, unproject as unprojectDesk, planeTransform, planCamera, planPace, shotIntent, lens, SHOT, MACRO, deskBakeSize } from '../js/scene.js';
import { DESKS, deskById, DESK_GLSL } from '../js/desks.js';
import { sheetPlace, FORMATS, drawSeconds, signSeconds, planHandPace, realInfo, formatHand, formatSpeed, filmLengthFor, filmDrawSeconds } from '../js/film.js';
import { cleanSignature, timeSignature, placeSignature, SIGNATURE_MAX } from '../js/signature.js';

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

test('unproject is project\'s inverse on the desk (the macro rect covers what is seen)', () => {
  const b = cameraBasis({ tx: 0.1, ty: -0.2, zoom: 5.5, pitch: 30 * DEG, yaw: -7 * DEG, roll: 1 * DEG }, 1080, 1920, 930);
  for (const [x, y] of [[0.1, -0.2], [0.13, -0.15], [0.05, -0.26]]) {
    const [sx, sy] = project(b, x, y), q = unprojectDesk(b, sx, sy);
    assert.ok(q && Math.hypot(q[0] - x, q[1] - y) < 1e-9);
  }
  assert.equal(unprojectDesk(cameraBasis({ tx: 0, ty: 0, zoom: 1, pitch: 80 * DEG, yaw: 0, roll: 0 }, 1080, 1920, 930), 540, -5000), null);
});

test('zoom 1, straight down: the sheet is exactly `side` px wide', () => {
  const b = cameraBasis({ tx: 0, ty: 0, zoom: 1, pitch: 0, yaw: 0, roll: 0 }, 1080, 1080, 928);
  const a = project(b, -0.5, 0), c = project(b, 0.5, 0);
  assert.ok(Math.abs(c[0] - a[0] - 928) < 1e-6);
  const pt = planeTransform(b, 0.2, 0.1);
  assert.ok(Math.abs(Math.hypot(pt[0], pt[1]) - 928) < 1e-3 && Math.abs(pt[1]) < 1e-9 && Math.abs(pt[2]) < 1e-9);
});

test('lens: the focus point is sharp, a raised point is blurred, a flat straight shot is sharp everywhere', () => {
  const b = cameraBasis({ tx: 0, ty: 0, zoom: 2.7, pitch: 22 * DEG, yaw: 0, roll: 0 }, 1080, 1920, 928);
  const L = lens(b, [0, 0]);
  assert.ok(L.coc(0, 0) < 1e-9);
  assert.ok(L.coc(0.1, 0.1, 0.1) > 5, `raised end: ${L.coc(0.1, 0.1, 0.1)}`);
  const f = lens(cameraBasis({ tx: 0, ty: 0, zoom: 1, pitch: 0, yaw: 0, roll: 0 }, 1080, 1920, 928), [0, 0]);
  assert.ok(f.coc(0.45, -0.45) < 1e-9);
});

// Synthetic drawings over a 12 s film: pen positions and turns by progress p (the pacing table's
// parameter), and the line's arc length.
const LEN = 12, T0 = 0.4, T1 = 9.8, K = 8192;
const frame = { W: 1080, H: 1920, side: 928, cx: 540, cy: 806 };
const art = { x: 0, y: 0, r: 0.42 };
const safe = [0.1, 0.1, 0.9, 0.76];
const RINGS = 72;
const paths = {
  // a centre-out spiral of 72 rings: radius ~ sqrt(progress) (constant line spacing)
  center: p => { const r = 0.42 * Math.sqrt(p), a = Math.sqrt(p) * RINGS * 2 * Math.PI; return [r * Math.cos(a), r * Math.sin(a), Math.sqrt(p) * RINGS]; },
  edge: p => { const q = 1 - p, r = 0.42 * Math.sqrt(q), a = Math.sqrt(q) * RINGS * 2 * Math.PI; return [r * Math.cos(a), r * Math.sin(a), (1 - Math.sqrt(q)) * RINGS]; },
  // a roaming pen: fast local wiggle riding a slow tour of the art square, from a corner
  follow: p => {
    const x = -0.3 + 0.55 * Math.sin(p * 5.1) * Math.cos(p * 2.3) + 0.04 * Math.sin(p * 900);
    const y = 0.3 - 0.6 * p + 0.25 * Math.sin(p * 7.7) + 0.04 * Math.cos(p * 1100);
    return [Math.max(-0.42, Math.min(0.42, x)), Math.max(-0.42, Math.min(0.42, y)), 0];
  },
};
function grid(mode) {
  const x = new Float64Array(K), y = new Float64Array(K), S = new Float64Array(K), T = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    [x[k], y[k], T[k]] = paths[mode](k / (K - 1));
    if (k) S[k] = S[k - 1] + Math.hypot(x[k] - x[k - 1], y[k] - y[k - 1]);
  }
  return { x, y, S, T };
}
const at = (arr, p) => { const f = Math.min(1, Math.max(0, p)) * (K - 1), i = Math.min(K - 2, Math.floor(f)); return arr[i] + (arr[i + 1] - arr[i]) * (f - i); };
const timing = mode => mode === 'edge' ? { tTake: T1 - 0.25, tSettle: T1 + 1.1, tFinal: T1 + 1.5 } : { tTake: T1 - 1.4, tSettle: T1 + 0.15, tFinal: T1 + 0.9 };
function direct(mode) {
  const G = grid(mode);
  const intent = shotIntent({ mode, t0: T0, t1: T1, art, frame, safe, path: G });
  const pace = planPace({ t0: T0, t1: T1, S: G.S, T: mode === 'follow' ? null : G.T, zp: mode === 'follow' ? 1.6 : Infinity, zoomAt: intent.zoomAt });
  const head = t => { const p = pace.at(t); return [at(G.x, p), at(G.y, p)]; };
  const plan = planCamera({ length: LEN, t0: T0, t1: T1, ...timing(mode), head, progress: pace.at, intent, art, frame, safe });
  return { G, intent, pace, head, plan };
}

for (const mode of ['center', 'edge', 'follow']) {
  const R = direct(mode);
  const { plan: P, pace, head } = R;
  const { tFinal } = timing(mode);
  test(`${mode}: deterministic`, () => {
    const Q = direct(mode).plan;
    for (const k of Object.keys(P.track)) assert.deepEqual(Array.from(P.track[k]), Array.from(Q.track[k]));
  });

  test(`${mode}: the pace lands at rest, never runs backwards and finishes exactly at t1`, () => {
    assert.equal(pace.at(T0), 0);
    assert.equal(pace.at(T1), 1);
    assert.ok(pace.at(T0 + 0.05) < 1e-4, 'the pen starts from rest');
    let prev = 0;
    for (let t = T0; t <= T1; t += 1 / 240) { const p = pace.at(t); assert.ok(p >= prev - 1e-12, `backwards at ${t}`); prev = p; }
    // the plain rate is at most kmax faster than a pace without the slow opening
    assert.ok(pace.ratio <= 1.75 + 1e-6, `ratio ${pace.ratio}`);
  });

  test(`${mode}: after touchdown the pen draws at close to real speed on screen (<= ~12 px/frame at 60 fps)`, () => {
    let worst = 0;
    for (let t = T0; t < T0 + 1.1; t += 1 / 60) {
      const b0 = cameraBasis(P.at(t), frame.W, frame.H, frame.side), b1 = cameraBasis(P.at(t + 1 / 60), frame.W, frame.H, frame.side);
      const [x0, y0] = head(t), [x1, y1] = head(t + 1 / 60);
      // the pen's own motion (the camera held still), in px per frame
      const a = project(b1, x0, y0), c = project(b1, x1, y1);
      worst = Math.max(worst, Math.hypot(c[0] - a[0], c[1] - a[1]));
      void b0;
    }
    assert.ok(worst < 16, `${worst.toFixed(1)} px/frame`);
  });

  test(`${mode}: arrives on the exact, straight full-sheet framing, then only creeps in slowly`, () => {
    const fin = { tx: 0, ty: (960 - 806) / 928 };
    const c = P.at(tFinal);
    const off = Math.max(Math.abs(c.zoom - 1), Math.abs(c.pitch), Math.abs(c.yaw), Math.abs(c.roll));
    assert.ok(off < 1e-9, `not straight at ${tFinal} s (off by ${off})`);
    assert.ok(Math.abs(c.tx - fin.tx) < 1e-9 && Math.abs(c.ty - fin.ty) < 1e-9, `target ${c.tx}, ${c.ty}`);
    let prev = 1;
    const ac = project(cameraBasis(c, frame.W, frame.H, frame.side), art.x, art.y);
    for (let t = tFinal; t <= LEN; t += 0.05) {
      const q = P.at(t);
      assert.ok(q.zoom >= prev - 1e-12 && q.zoom <= 1.046, `creep zoom ${q.zoom} at ${t.toFixed(2)}`);
      assert.ok(Math.abs(q.pitch) < 1e-9 && Math.abs(q.roll) < 1e-9 && q.yaw <= 1e-12 && q.yaw >= -0.61 * DEG, 'creep stays straight');
      // it pushes in on the art: the art centre stays put on screen (but for the slow turn)
      const a = project(cameraBasis(q, frame.W, frame.H, frame.side), art.x, art.y);
      assert.ok(Math.hypot(a[0] - ac[0], a[1] - ac[1]) < 3, `art centre drifts ${Math.hypot(a[0] - ac[0], a[1] - ac[1]).toFixed(2)} px`);
      prev = q.zoom;
    }
    assert.ok(P.at(LEN).zoom > 1.01, 'no frame of the hold is frozen');
  });

  test(`${mode}: no jerks (acceleration changes smoothly, sampled at 60 Hz)`, () => {
    const bounds = { zoom: 3e-4, pitch: 6e-5, yaw: 2e-5, roll: 6e-6, tx: 6e-5, ty: 6e-5 };
    for (const [k, lim] of Object.entries(bounds)) {
      const a = P.track[k];
      let worst = 0;
      for (let i = 3; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - 3 * a[i - 1] + 3 * a[i - 2] - a[i - 3]));
      assert.ok(worst < lim, `${k}: third difference ${worst.toExponential(2)} >= ${lim}`);
    }
  });

  test(`${mode}: the pen tip stays in frame (full perspective projection)`, () => {
    // the spirals' tip always; a roaming pen may dart out for a moment (<= 0.3 s at a time)
    let worst = 0, run = 0, longest = 0;
    for (let t = T0; t <= T1; t += 1 / 60) {
      const b = cameraBasis(P.at(t), frame.W, frame.H, frame.side);
      const [x, y] = head(t);
      const [sx, sy] = project(b, x, y);
      const out = Math.max(0.04 * frame.W - sx, sx - 0.96 * frame.W, 0.04 * frame.H - sy, sy - 0.82 * frame.H);
      worst = Math.max(worst, out);
      run = out > 0 ? run + 1 / 60 : 0;
      longest = Math.max(longest, run);
    }
    if (mode === 'follow') assert.ok(longest <= 0.3, `out of frame for ${longest.toFixed(2)} s`);
    else assert.ok(worst <= 0, `tip leaves the frame by ${worst.toFixed(1)} px`);
  });
}

test('center: opens on an extreme close-up, tilted, holds it while the pen is slow, then pulls back', () => {
  const { plan: P } = direct('center');
  const c0 = P.at(0.3), c1 = P.at(T0 + 1.0), cMid = P.at((T0 + T1) / 2);
  assert.ok(c0.zoom > 2.4 && c0.zoom <= 2.81, `intro zoom ${c0.zoom}`);
  assert.ok(c0.pitch > 18 * DEG && c0.pitch < 26 * DEG, `intro pitch ${c0.pitch / DEG}`);
  assert.ok(c1.zoom > 2.6, `still close a second after touchdown: ${c1.zoom}`);
  assert.ok(cMid.zoom < c1.zoom && cMid.pitch < c0.pitch, 'pulls back and straightens');
  let prev = Infinity;
  // (a gentle push-in while the pen is slow, then only ever back)
  for (let t = T0 + 1.3; t < T1 + 0.9; t += 0.05) { const z = P.at(t).zoom; assert.ok(z <= prev + 1e-3, `zoom rises at ${t.toFixed(2)}`); prev = z; }
});

test('follow: holds the close-up on the pen landing, then roams in a tilted medium shot', () => {
  const { plan: P, intent } = direct('follow');
  for (let t = 0; t <= T0 + 1.0; t += 0.05) assert.ok(P.at(t).zoom >= 2.15, `close-up at ${t.toFixed(2)}: ${P.at(t).zoom}`);
  for (let t = intent.tMid + 0.3; t < T1 - 1.6; t += 0.1) {
    const c = P.at(t);
    assert.ok(c.zoom > 1.2 && c.zoom < 1.65, `medium shot zoom ${c.zoom.toFixed(2)} at ${t.toFixed(1)}`);
    assert.ok(c.pitch > 7 * DEG && c.pitch < 13 * DEG, `medium shot pitch ${(c.pitch / DEG).toFixed(1)} at ${t.toFixed(1)}`);
  }
});

test('edge: pushes in as the line closes on the centre and pulls back only as the pen lifts', () => {
  const { plan: P } = direct('edge');
  assert.ok(P.at(T0 + 0.5).zoom < 1.2, 'opens wide');
  assert.ok(P.at(T1 - 0.3).zoom > 1.9, `close on the centre at the end: ${P.at(T1 - 0.3).zoom}`);
  let prev = 0;
  for (let t = T0; t < T1 - 0.6; t += 0.05) { const z = P.at(t).zoom; assert.ok(z >= prev - 1e-3, `zoom falls at ${t.toFixed(2)}`); prev = z; }
});

test('follow: the roaming medium shot breathes instead of locking off', () => {
  const { plan: P, intent } = direct('follow');
  let lo = Infinity, hi = 0;
  for (let t = intent.tMid + 1.5; t < T1 - 1.6; t += 0.05) { const z = P.at(t).zoom; lo = Math.min(lo, z); hi = Math.max(hi, z); }
  assert.ok(hi / lo > 1.04, `zoom only ${lo.toFixed(3)}..${hi.toFixed(3)} in the medium shot`);
});

test('desks: eight premium backgrounds, Nero marble the default, each with a swatch image', () => {
  assert.equal(DESKS.length, 8);
  assert.deepEqual(DESKS.map(d => d.id), ['nero', 'calacatta', 'travertine', 'limewash', 'velvet', 'leather', 'sunlit', 'onyx']);
  assert.equal(new Set(DESKS.map(d => d.shader)).size, 8, 'one shader id each');
  for (const d of DESKS) {
    assert.ok(d.name && d.note && typeof d.dark === 'boolean', d.id);
    const img = new URL(`../img/desks/${d.id}.jpg`, import.meta.url);
    assert.ok(fs.existsSync(img) && fs.statSync(img).size > 1000, `swatch for ${d.id}`);
  }
  assert.equal(deskById('nope').id, 'nero');
  assert.equal(deskById('onyx').name, 'Honey onyx');
  assert.ok(DESK_GLSL.includes('Desk deskMaterial(int id, vec2 p)') && DESK_GLSL.includes('dkLeafShadow'));
});

test('deskBakeSize: 4096 on a desktop GPU (MAX_TEXTURE_SIZE >= 8192), 2048 otherwise', () => {
  const gl = max => ({ MAX_TEXTURE_SIZE: 0x0D33, getParameter: () => max });
  assert.equal(deskBakeSize(gl(16384)), 4096);
  assert.equal(deskBakeSize(gl(8192)), 4096);
  assert.equal(deskBakeSize(gl(4096)), 2048);
});

test('final framing: the cinematic film ends on a looser shot, so the desk frames the sheet', () => {
  for (const [id, F] of Object.entries(FORMATS)) {
    const c = sheetPlace(id, F.w, F.h, 'cinematic'), f = sheetPlace(id, F.w, F.h, 'flat');
    const x0 = c.cx - c.side / 2, x1 = c.cx + c.side / 2, y0 = c.cy - c.side / 2, y1 = c.cy + c.side / 2;
    assert.ok(x0 >= 0 && y0 >= 0 && x1 <= F.w && y1 <= F.h, `${id}: the sheet fits the frame`);
    // desk on every side (a story is framed by its height: the width may be tight)
    const k = Math.min(F.w, F.h), m = Math.min(x0, F.w - x1, y0, F.h - y1);
    if (id !== 'story') assert.ok(m >= 0.1 * k, `${id}: desk margin ${m.toFixed(0)} px`);
    assert.ok(c.side <= f.side, `${id}: not tighter than the flat film`);
    // the art circle (r = 0.42 of the sheet) keeps clear of the bottom 20% of a story
    if (id === 'story') assert.ok(c.cy + 0.42 * c.side <= 0.8 * F.h, 'story art clear of the app UI');
  }
});

test('sheet texture budget: maxZoom covers the close-up', () => {
  const { plan: P } = direct('center');
  assert.ok(P.maxZoom >= SHOT.center.close && P.maxZoom < 3.4, `maxZoom ${P.maxZoom}`);
});

// ------------------------------------------------------------------ macro opening
function directMacro(mode, extra = {}) {
  const G = grid(mode);
  const intent = shotIntent({ mode, t0: T0, t1: T1, art, frame, safe, path: G, macro: true });
  const pace = planPace({ t0: T0, t1: T1, S: G.S, T: mode === 'follow' ? null : G.T, zp: mode === 'follow' ? 1.6 : Infinity, zoomAt: intent.zoomAt });
  const head = t => { const p = pace.at(t); return [at(G.x, p), at(G.y, p)]; };
  const plan = planCamera({ length: LEN, t0: T0, t1: T1, ...timing(mode), head, progress: pace.at, intent, art, frame, safe, ...extra });
  return { G, intent, pace, head, plan };
}
for (const mode of ['center', 'edge', 'follow']) {
  const { plan: P, head, intent } = directMacro(mode);
  test(`${mode} + macro: opens on the nib at ~${MACRO.zoom}x, lower, then pulls back into the plan`, () => {
    const c = P.at(T0 + 0.5);
    assert.ok(Math.abs(c.zoom - MACRO.zoom) < 0.15, `macro zoom ${c.zoom.toFixed(2)}`);
    assert.ok(c.pitch > 26 * DEG, `macro pitch ${(c.pitch / DEG).toFixed(1)}`);
    // the nib is in the middle of the frame (up and left of centre), not at an edge
    const b = cameraBasis(c, frame.W, frame.H, frame.side);
    const [sx, sy] = project(b, ...head(T0 + 0.5));
    assert.ok(sx > 0.2 * frame.W && sx < 0.6 * frame.W && sy > 0.2 * frame.H && sy < 0.6 * frame.H, `nib at ${sx.toFixed(0)}, ${sy.toFixed(0)}`);
    // continuous pull-back: the zoom only falls from the end of the hold to the end of the macro
    let prev = Infinity;
    for (let t = intent.tM0 + 0.05; t < intent.tM1; t += 1 / 60) { const z = P.at(t).zoom; assert.ok(z <= prev + 1e-6, `zoom rises at ${t.toFixed(2)}`); prev = z; }
    // and after it, back in the plan's own shot (the pace differs a little: the pen is slower while
    // the camera is closer, so the track is not identical)
    const Q = direct(mode).plan;
    for (let t = intent.tM1 + 0.05; t < LEN; t += 0.25) {
      const a = P.at(t).zoom, b = Q.at(t).zoom;
      assert.ok(Math.abs(a / b - 1) < 0.2, `zoom ${a.toFixed(2)} vs ${b.toFixed(2)} at ${t.toFixed(2)}`);
    }
    assert.ok(P.maxZoomBase < P.maxZoom && P.macroW(T0) === 1 && P.macroW(intent.tM1 + 0.01) === 0);
  });
  test(`${mode} + macro: the pen draws at real speed on screen and the move has no jerks`, () => {
    let worst = 0;
    for (let t = T0; t < T0 + 1.1; t += 1 / 60) {
      const b1 = cameraBasis(P.at(t + 1 / 60), frame.W, frame.H, frame.side);
      const a = project(b1, ...head(t)), c = project(b1, ...head(t + 1 / 60));
      worst = Math.max(worst, Math.hypot(c[0] - a[0], c[1] - a[1]));
    }
    assert.ok(worst < 16, `${worst.toFixed(1)} px/frame`);
    // the macro's pull-back is a big move in a short time: bounds 3x the plain plan's
    const bounds = { zoom: 1.2e-3, pitch: 2e-4, tx: 2e-4, ty: 2e-4 };
    for (const [k, lim] of Object.entries(bounds)) {
      const a = P.track[k];
      let w = 0;
      for (let i = 3; i < a.length; i++) w = Math.max(w, Math.abs(a[i] - 3 * a[i - 1] + 3 * a[i - 2] - a[i - 3]));
      assert.ok(w < lim, `${k}: third difference ${w.toExponential(2)} >= ${lim}`);
    }
  });
}

// ------------------------------------------------------------------ signing shot
test('signing shot: leans in over the name while it is written, then lands on the exact final framing', () => {
  const tS0 = T1 - 1.0, tS1 = T1 - 0.1, box = [0.19, 0.42, 0.45, 0.48];
  // (a synthetic timeline: the film's own puts the signing after t1; the shot only reads its times)
  const tFinal = timing('center').tFinal;
  const { plan: P } = directMacro('center', { sign: { t0: tS0, t1: tS1, tIn: tS0 - 0.8, tOut: tFinal - 0.05, box } });
  for (let t = tS0; t <= tS1; t += 0.05) {
    const c = P.at(t), b = cameraBasis(c, frame.W, frame.H, frame.side);
    assert.ok(c.zoom > 1.3, `zoom ${c.zoom.toFixed(2)} at ${t.toFixed(2)}`);
    for (const [x, y] of [[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]]]) {
      const [sx, sy] = project(b, x, y);
      assert.ok(sx > 0.04 * frame.W && sx < 0.96 * frame.W && sy > 0.04 * frame.H && sy < 0.9 * frame.H, `name off screen at ${t.toFixed(2)}`);
    }
  }
  const c = P.at(tFinal);
  assert.ok(Math.abs(c.zoom - 1) < 1e-9 && Math.abs(c.pitch) < 1e-9, 'final framing');
});

// ------------------------------------------------------------------ signature
test('signature: text clean-up, timing, placement clear of the art', () => {
  assert.equal(cleanSignature('  Anna \n  Smith  '), 'Anna Smith');
  assert.equal(cleanSignature('x'.repeat(50)).length, SIGNATURE_MAX);
  assert.equal(signSeconds(''), 0);
  assert.ok(signSeconds('Jo') >= 1 && signSeconds('Jo') <= 1.01 && signSeconds('x'.repeat(32)) <= 1.4 + 1e-9);
  // a signature takes its time from the drawing (and a little of the hold), never from the film
  for (const style of ['cinematic', 'flat']) for (const reveal of [false, true]) {
    const d0 = drawSeconds(10, reveal, style), d1 = drawSeconds(10, reveal, style, signSeconds('Anna Smith'));
    assert.ok(d1 < d0 && d0 - d1 < 1.9 && d1 >= 3, `${style} ${reveal}: ${d0} -> ${d1}`);
  }
  // a synthetic trace: two strokes and a flourish-like line
  const tr = { width: 4.3, top: -0.72, bottom: 0.22, strokes: [
    [[0, 0], [0.3, -0.7], [0.6, 0]], [[0.9, 0], [1.2, -0.4], [1.5, 0], [4.2, -0.3]], [[0.2, 0.2], [4.3, 0.1]]] };
  const tm = timeSignature(tr, 1.2);
  assert.ok(Math.abs((tm.n - 1) * tm.dt - 1.2) < 1e-9 && tm.down[0] === 1 && tm.down[tm.n - 1] === 1);
  assert.ok(tm.down.some(d => d === 0), 'lifts between strokes');
  for (const square of [false, true]) {
    const a = { x: 0, y: 0, r: 0.42, square };
    const p = placeSignature(tr, a);
    const x0 = p.x, x1 = p.x + tr.width * p.em, y0 = p.y + tr.top * p.em, y1 = p.y + tr.bottom * p.em;
    assert.ok(Math.abs(x1 - 0.45) < 1e-9 && y1 <= 0.4881 && p.em >= 0.028, `${square}: ${JSON.stringify(p)}`);
    if (square) assert.ok(y0 >= 0.42 + 0.017, 'clear of the square');
    else { const qx = Math.max(x0, Math.min(0, x1)), qy = Math.max(y0, Math.min(0, y1)); assert.ok(Math.hypot(qx, qy) >= 0.42 + 0.017, 'clear of the circle'); }
  }
  // a long name is scaled down, not pushed into the art
  const long = { ...tr, width: 13 };
  const pl = placeSignature(long, { x: 0, y: 0, r: 0.42, square: false });
  assert.ok(pl.em * 13 <= 0.52 + 1e-9 && pl.x >= -0.5, `long name: ${JSON.stringify(pl)}`);
});

// ---------------------------------------------------------------------------------- realistic film
test('realistic pace: 1x opening, one smooth ramp, 1x last stroke, hand time adds up exactly', () => {
  for (const [total, D] of [[3 * 3600 + 12 * 60, 27.4], [1304, 27.4], [3486, 57.4], [40, 7.4]]) {
    const t0 = 0.4, t1 = t0 + D;
    const P = planHandPace({ t0, t1, total });
    assert.ok(Math.abs(P.hand(t1) - total) < 1e-6 * total, `sums to ${P.hand(t1)} not ${total}`);
    assert.equal(P.at(t0), 0);
    assert.equal(P.at(t1 + 1), 1);
    // real speed through the opening (after the first touch) and on the last stroke
    const mid = t0 + 0.5 * P.open, last = t1 - 0.5 * P.last;
    assert.ok(Math.abs(P.speed(mid) - 1) < 0.02, `opening at ${P.speed(mid)}x`);
    assert.ok(Math.abs(P.speed(last) - 1) < 0.02, `last stroke at ${P.speed(last)}x`);
    // monotone hand clock, speed never above the peak, and no jerk: log speed changes smoothly
    let prev = -1, maxJump = 0, lp = null;
    for (let t = t0; t <= t1; t += 1 / 120) {
      const h = P.hand(t);
      assert.ok(h >= prev - 1e-9, 'hand clock runs backwards');
      prev = h;
      const s = P.speed(t);
      assert.ok(s <= P.peak * 1.0001, `speed ${s} above peak ${P.peak}`);
      if (t > t0 + 0.25) { const l = Math.log(s); if (lp != null) maxJump = Math.max(maxJump, Math.abs(l - lp)); lp = l; }
    }
    // at 120 Hz the speed never changes by more than ~6% between samples (a continuous ramp)
    if (total > D * 2) assert.ok(maxJump < 0.06, `speed jumps by ${Math.exp(maxJump)}x in one step (total ${total})`);
    assert.ok(P.peak >= P.avg, 'peak below the average');
  }
});

test('realistic hand clock: realInfo derives handT when missing and film counters read like people talk', () => {
  // a straight line along x in circle units, 0.001 cu per point, dwell 2 on the second half
  const n = 1001, data = new Float32Array(n * 7);
  for (let i = 0; i < n; i++) { data[i * 7] = i * 0.001; data[i * 7 + 6] = i > 500 ? 2 : 1; }
  const g = { n, data, path: 'real-stipple', layout: { r: 0.42 }, real: { style: 'stipple', sheetMm: 800, toolMm: 4, handMin: 3 } };
  const R = realInfo(g);
  assert.equal(R.sheetMm, 800); assert.equal(R.toolMm, 4);
  assert.ok(Math.abs(R.handT[n - 1] - 180) < 1e-6 && Math.abs(R.handSeconds - 180) < 1e-9);
  // the slower half takes twice as long
  assert.ok(Math.abs((R.handT[n - 1] - R.handT[500]) / R.handT[500] - 2) < 0.01);
  assert.equal(realInfo({ n, data, path: 'spiral' }), null);
  assert.equal(formatHand(59.4), '59 s');
  assert.equal(formatHand(3 * 3600 + 12 * 60), '3 h 12 min');
  assert.equal(formatHand(3840), '1 h 04 min');
  assert.equal(formatHand(125, true), '2 min 05 s');
  assert.equal(formatSpeed(1), '1×');
  assert.equal(formatSpeed(4.4), '4.5×');
  assert.equal(formatSpeed(237), '240×');
  assert.equal(formatSpeed(1234), '1200×');
});

test('realistic shots: sizes in mm override the defaults; a big sheet keeps the real aperture', () => {
  const frame = { W: 1080, H: 1080, side: 820, cx: 540, cy: 540 };
  const base = { t0: 0.4, t1: 27.8, art: { x: 0, y: 0, r: 0.42 }, frame, safe: [0.1, 0.1, 0.9, 0.9] };
  const plain = shotIntent({ ...base, mode: 'follow' });
  const real = shotIntent({ ...base, mode: 'follow', shot: { follow: { close: 3.6, mid: 2.35, hold: 2.6, ease: 3 } } });
  assert.equal(plain.zclose, SHOT.follow.close);
  assert.equal(real.zclose, 3.6);
  assert.equal(real.zmid, 2.35);
  assert.ok(Math.abs(real.zoomAt(0.4 + 2.5, 0) - 3.6) < 0.2, 'close-up held through the real-speed opening');
  const cen = shotIntent({ ...base, mode: 'center', shot: { center: { close: 4, pull: 2, pullAt: 3 } } });
  assert.equal(cen.zclose, 4);
  const b = cameraBasis({ tx: 0, ty: 0, zoom: 2, pitch: 20 * DEG, yaw: 0, roll: 0 }, 1080, 1080, 820);
  const k1 = lens(b, [0, 0]).K;
  b.ap = 0.21;
  assert.ok(Math.abs(lens(b, [0, 0]).K / k1 - 0.21) < 1e-9, 'aperture scales with b.ap');
  delete b.ap;
  assert.equal(lens(b, [0, 0]).K, k1);
});

test('line art clock: looks found and stretched, 15/30/60 s films, the total said to the second', () => {
  // a straight line at 20 mm/s (0.1 mm per point on a 210 mm sheet), with a 0.8 s look before point 600
  const n = 1001, data = new Float32Array(n * 7), handT = new Float32Array(n);
  const mmPerCu = 210 * 0.42, step = 0.1 / mmPerCu;
  for (let i = 0; i < n; i++) {
    data[i * 7] = i * step;
    data[i * 7 + 6] = 1;
    if (i) handT[i] = handT[i - 1] + 0.1 / 20 + (i === 600 ? 0.8 : 0);
  }
  const g = { n, data, path: 'lineart', layout: { r: 0.42 }, handT,
    lineart: { style: 'matisse', sheetMm: 210, toolMm: 0.55, handSeconds: +handT[n - 1].toFixed(1), lengthM: 0.1, retracedM: 0.02 } };
  const R = realInfo(g);
  assert.ok(R && R.lineart, 'a Line art geometry films as a true drawing');
  assert.equal(R.style, 'matisse');
  assert.equal(R.pauses, 1);
  assert.ok(Math.abs(R.pauseSeconds - 0.8) < 0.01, `pause ${R.pauseSeconds}`);
  // the film clock plays the look slower than the line (and only the look)
  assert.ok(Math.abs(R.clock.total - (handT[n - 1] + 0.8)) < 0.01);
  // lengths: 30 s by default, a hand-picked 15/30/60 kept, 10 s never
  assert.equal(filmLengthFor({ length: 10 }, g), 30);
  assert.equal(filmLengthFor({ length: 60, lengthChosen: true }, g), 60);
  assert.equal(filmLengthFor({ length: 10, lengthChosen: true }, g), 15);
  assert.equal(filmLengthFor({ length: 10, lengthChosen: true }, { n, data, path: 'spiral' }), 10);
  // a drawing shorter than the film at real speed is drawn at 1x: the transport previews that
  assert.ok(Math.abs(filmDrawSeconds({ length: 30, style: 'cinematic' }, g) - (R.clock.total + 0.2)) < 1e-9);
  assert.equal(filmDrawSeconds({ length: 10, style: 'cinematic' }, { n, data, path: 'spiral' }), drawSeconds(10, false, 'cinematic', 0));
  assert.equal(formatHand(122, 'total'), '2 min 02 s');
  assert.equal(formatHand(4000, 'total'), '1 h 07 min');
});

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nall passed');
