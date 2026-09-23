// Node tests for js/papers.js data + GLSL invariants (the rendered look is checked with
// dev/paper-lab.html through tests/shoot.mjs).
// Run: node tests/papers.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAPERS, paperById, SHEET_MM, PAPER_TILE_GLSL, PAPER_SURFACE_GLSL } from '../js/papers.js';
import { LOOKS, hexToRgb, luminance, contrastRatio, inkMode, brushById } from '../js/materials.js';

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ', name); }
  catch (e) { failures++; console.log('FAIL ', name, '\n     ', e.message); }
}

const IDS = ['sketch', 'cream', 'coldpress', 'kraft', 'black', 'chalkboard', 'blueprint'];
const HEX = /^#[0-9a-f]{6}$/i;

// CIE L*a*b* (D65) from sRGB 0..1, for colour-distance checks.
function lab(rgb) {
  const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb.map(lin);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

test('paper ids are fixed and in order', () => {
  assert.deepEqual(PAPERS.map(p => p.id), IDS);
  assert.equal(SHEET_MM, 200);
});

test('colours are valid hex and never pure white (headroom for lit relief)', () => {
  for (const p of PAPERS) {
    assert.match(p.color, HEX, p.id);
    assert.match(p.speck, HEX, p.id);
    assert.notEqual(p.color.toLowerCase(), '#ffffff', p.id);
    assert.ok(Math.max(...hexToRgb(p.color)) <= 0xf6 / 255, `${p.id} ${p.color} leaves no headroom`);
  }
});

test('tile lattice periods are integers (seamless tiling)', () => {
  for (const p of PAPERS) {
    assert.ok(Number.isInteger(p.toothCells) && p.toothCells >= 8, `${p.id} toothCells ${p.toothCells}`);
    assert.ok(Number.isInteger(p.bumpCells) && p.bumpCells >= 1, `${p.id} bumpCells ${p.bumpCells}`);
  }
});

test('numeric knobs are finite and in range', () => {
  for (const p of PAPERS) {
    for (const k of ['tooth', 'bumps', 'fibers', 'specks', 'relief', 'mottle', 'smudge', 'grid']) {
      assert.ok(Number.isFinite(p[k]) && p[k] >= 0, `${p.id}.${k} = ${p[k]}`);
    }
    // tooth keeps the height std near 0.13 * tooth: brushes need ~0.1-0.2
    assert.ok(p.tooth > 0.3 && p.tooth <= 1.5, `${p.id}.tooth`);
    assert.ok(p.relief <= 1.2 && p.mottle <= 0.15, `${p.id} relief/mottle too strong`);
  }
  assert.equal(PAPERS.filter(p => p.smudge > 0).map(p => p.id).join(), 'chalkboard');
  assert.equal(PAPERS.filter(p => p.grid > 0).map(p => p.id).join(), 'blueprint');
});

test('dark flag matches the sheet luminance', () => {
  for (const p of PAPERS) assert.equal(!!p.dark, luminance(hexToRgb(p.color)) < 0.2, p.id);
});

test('papers are distinguishable by colour alone (thumbnails): dE76 >= 4', () => {
  let min = Infinity, pair = '';
  for (let i = 0; i < PAPERS.length; i++) for (let j = i + 1; j < PAPERS.length; j++) {
    const a = lab(hexToRgb(PAPERS[i].color)), b = lab(hexToRgb(PAPERS[j].color));
    const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (d < min) { min = d; pair = `${PAPERS[i].id}/${PAPERS[j].id}`; }
  }
  assert.ok(min >= 4, `closest pair ${pair} dE ${min.toFixed(2)}`);
});

test('every Look keeps a legible ink on its paper', () => {
  for (const look of LOOKS) {
    const paper = paperById(look.paper);
    const mode = inkMode(brushById(look.brush), look.ink, paper);
    assert.ok(!mode.lowContrast, `${look.id}: contrast ${contrastRatio(hexToRgb(look.ink), hexToRgb(paper.color)).toFixed(2)}`);
  }
});

test('paperById falls back to the first paper', () => {
  assert.equal(paperById('nope').id, 'sketch');
  assert.equal(paperById('kraft').id, 'kraft');
});

test('GLSL chunks define the contract functions and stay seam-safe', () => {
  assert.match(PAPER_TILE_GLSL, /vec4 paperTile\(vec2 uv\)/);
  assert.match(PAPER_SURFACE_GLSL, /vec3 paperSurface\(vec2 P, out float shade\)/);
  const code = src => src.replace(/\/\/.*$/gm, '');   // strip comments
  // mod() can return the period itself on D3D (x * rcp(y) rounding): lattice wraps use wrapL()
  assert.ok(!/\bmod\s*\(/.test(code(PAPER_TILE_GLSL)), 'tile GLSL must not use mod()');
  for (const src of [PAPER_TILE_GLSL, PAPER_SURFACE_GLSL].map(code)) {
    const count = ch => src.split(ch).length - 1;
    assert.equal(count('{'), count('}'), 'unbalanced braces');
    assert.equal(count('('), count(')'), 'unbalanced parentheses');
    assert.ok(!/\bpow\s*\(/.test(src), 'pow() is undefined for negative bases; square explicitly');
  }
});

test('surface samplings match grainAt (relief lines up with the grain brushes read)', () => {
  // paperTaps() re-reads the tile the way grainAt() in shaders.js does, so the lit relief sits
  // exactly where brushes find tooth. Compare the second sampling's transform and the blend mask.
  const shaders = readFileSync(new URL('../js/shaders.js', import.meta.url), 'utf8');
  const grain = shaders.slice(shaders.indexOf('vec3 grainAt('), shaders.indexOf('float above('));
  const uv2 = grain.match(/vec2 uv2 = (mat2\([^)]*\)) \* \(P \/ \(uTilePx \* ([0-9.]+)\)\) \+ (vec2\([^)]*\));/);
  // (the mask is in physical units since renderer.setSheetMm: P / uPhysPx in grainAt, pm in the
  // surface; both equal the sheet units on the default 210 mm sheet)
  const mask = grain.match(/float m = smoothstep\(([^,]+), ([^,]+), vnoise\(P \/ (uPaperPx|uPhysPx) \* ([0-9.]+) \+ ([0-9.]+)\)\);/);
  assert.ok(uv2 && mask, 'grainAt no longer has the expected shape: update paperTaps() and this test');
  const surf = PAPER_SURFACE_GLSL.replace(/\s+/g, ' ');
  assert.ok(surf.includes(`${uv2[1]} * (P / (uTilePx * ${uv2[2]})) + ${uv2[3]}`), 'second sampling differs from grainAt');
  const unit = mask[3] === 'uPhysPx' ? 'pm' : 'pu';
  assert.ok(surf.includes(`vnoise(${unit} * ${mask[4]} + ${mask[5]})`), 'blend mask noise differs from grainAt');
  assert.ok(surf.includes(`smoothstep(${mask[1]}, ${mask[2]}, mv)`), 'blend mask ramp differs from grainAt');
});

if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nall paper tests passed');
