// Realistic mode contract (js/real/index.js), no browser: every style x a pen and a stick on its auto
// sheet builds one line of constant real width, a monotone hand clock (geom.handT) that is also every
// pacing table, and geom.real with the shared fields. Prints build times per style at the defaults.
//   node tests/real.test.mjs
import { REAL_STYLES, buildReal, autoSheet, sheetFit, realFieldRings, indexAtHand, formatHand, LAYOUT_R } from '../js/real/index.js';
import { STRIDE, MAX_POINTS, indexAt } from '../js/spiral.js';

const G = 512;
const D = new Float32Array(G * G);
// a face-ish test card: dark ring (hair), mid oval (face), two dark eyes, a light background ramp
for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
  const u = x / G * 2 - 1, v = y / G * 2 - 1;
  const r = Math.hypot(u / 0.62, v / 0.8);
  let d = 0.15 + 0.2 * (x / G);
  if (r < 1) d = 0.35 + 0.15 * v;
  if (r > 0.85 && r < 1.05 && v < 0.2) d = 0.85;
  if (Math.hypot(u + 0.25, v + 0.12) < 0.09 || Math.hypot(u - 0.25, v + 0.12) < 0.09) d = 0.95;
  D[y * G + x] = d;
}
const field = rings => ({ G, D, rgb: null, raster: null, rings });

const fails = [];
const rows = [];
for (const s of REAL_STYLES) {
  for (const [tool, toolMm] of [['fineliner', 0.4], ['charcoal', 4]]) {
    const sheetMm = autoSheet(s.id, toolMm);
    const fit = sheetFit(s.id, toolMm, sheetMm);
    const opts = { toolMm, sheetMm, tool, preset: 'detailed' };
    const rings = realFieldRings(s.id, opts);
    buildReal(s.id, field(rings), opts);   // warm the JIT, as a second build in the app would be
    const t0 = performance.now();
    const g = buildReal(s.id, field(rings), opts);
    const ms = performance.now() - t0;
    const w = toolMm / (LAYOUT_R * sheetMm);
    let wMin = Infinity, wMax = -Infinity;
    for (let i = 0; i < g.n; i++) { const v = g.data[i * STRIDE + 2]; wMin = Math.min(wMin, v); wMax = Math.max(wMax, v); }
    const tag = `${s.letter} ${s.id} ${tool} ${toolMm} mm on ${sheetMm} mm`;
    if (Math.abs(wMin - w) > w * 0.02 || Math.abs(wMax - w) > w * 0.02) fails.push(`${tag}: width ${wMin}..${wMax} != ${w}`);
    if (!fit.ok) fails.push(`${tag}: auto sheet does not fit`);
    if (!(g.handT instanceof Float32Array) || g.handT.length !== g.n) fails.push(`${tag}: handT missing`);
    let mono = true;
    for (let i = 1; i < g.n; i++) if (!(g.handT[i] >= g.handT[i - 1])) { mono = false; break; }
    if (!mono) fails.push(`${tag}: handT not monotone`);
    for (const k of ['style', 'preset', 'toolMm', 'sheetMm', 'lengthM', 'handSeconds']) if (g.real[k] == null) fails.push(`${tag}: real.${k} missing`);
    if (g.n >= MAX_POINTS) fails.push(`${tag}: ${g.n} points`);
    // the stage and film pace by pacingTable: it must be the hand clock
    const half = g.handT[g.n - 1] / 2;
    const a = indexAt(g, 0.5, 'natural'), b = indexAtHand(g, half);
    if (Math.abs(a - b) > 1.5) fails.push(`${tag}: pacing ${a} != hand ${b}`);
    rows.push(`${tag.padEnd(44)} ${g.real.lengthM.toFixed(1).padStart(6)} m  ${formatHand(g.real.handSeconds).padStart(10)}  ${String(g.n).padStart(7)} pts  ${ms.toFixed(0).padStart(5)} ms`);
  }
}
// the Save dialog's SVG of a realistic drawing is a real-size plotter file: sheet in mm, one path,
// stroke = the tool, whatever kind the dialog asked for
try {
  const { buildSVG, svgStats } = await import('../js/export.js');
  const opts = { toolMm: 4, sheetMm: 1000, tool: 'charcoal', preset: 'detailed' };
  const g = buildReal('engrave', field(realFieldRings('engrave', opts)), opts);
  const svg = buildSVG(g, { mode: 'outline', ink: '#1b1715', sizeMm: 200, layout: { cx: 0.5, cy: 0.5, r: 0.42 } });
  const st = svgStats(svg);
  const ok = /width="1000mm" height="1000mm"/.test(svg) && /stroke-width="4"/.test(svg) && st.paths === 1 && !/fill="#/.test(svg.split('<path')[1]);
  rows.push(`SVG engrave 4 mm on 1 m: ${st.paths} path, ${st.nodes} nodes, ${(st.bytes / 1e3).toFixed(0)} kB ${ok ? 'real size' : 'WRONG'}`);
  if (!ok) fails.push('realistic SVG is not a real-size single stroke');
} catch (e) { fails.push('SVG check: ' + e.message); }
console.log(rows.join('\n'));
console.log(fails.length ? 'FAIL\n' + fails.join('\n') : 'PASS');
process.exit(fails.length ? 1 : 0);
