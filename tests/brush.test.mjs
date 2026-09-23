// Node checks for the drawing media data (js/brushes.js). Visual / GPU checks live in
// dev/brush_lab.html (see the header of dev/brush_lab.js); this guards the contract.
// Run: node tests/brush.test.mjs
import assert from 'node:assert/strict';
import { BRUSHES, BRUSH_GLSL, brushById, brushWet } from '../js/brushes.js';
import { LOOKS, hexToRgb, luminance, inkMode, PAPERS } from '../js/materials.js';
import { FRAG_STROKE } from '../js/shaders.js';

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ', name); }
  catch (e) { failures++; console.log('FAIL ', name, '\n     ', e.message); }
}

const TOOL_KINDS = ['pencil', 'fineliner', 'fountain', 'crayon', 'ballpoint', 'marker', 'brush',
  'charcoal', 'chalk', 'neon', 'goldpen'];

test('12 brushes, shader ids 0..11 each used once (11 = watercolour)', () => {
  assert.equal(BRUSHES.length, 12);
  assert.deepEqual(BRUSHES.map(b => b.shader).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(brushById('watercolour').shader, 11);
});

test('materials are known and wet media carry their wet parameters', () => {
  const MATERIALS = ['ink', 'graphite', 'wax', 'chalk', 'metal', 'light', 'oil'];
  for (const b of BRUSHES) {
    assert.ok(MATERIALS.includes(b.material), `${b.id} material ${b.material}`);
    const w = brushWet(b);
    if (!(b.wetness > 0)) { assert.equal(w, null, `${b.id} is dry`); continue; }
    for (const k of ['load', 'mobile', 'dye', 'gran', 'dry', 'flow', 'pool', 'sharp', 'wick', 'retard', 'stick', 'sheen', 'poolAt', 'layer', 'tide']) {
      assert.ok(Number.isFinite(w[k]), `${b.id} wet.${k}`);
    }
    assert.ok(w.mobile >= 0 && w.mobile <= 1 && w.dye >= 0 && w.dye <= 1, `${b.id} shares 0..1`);
  }
  for (const id of ['fountain', 'brush', 'marker', 'watercolour']) assert.ok(brushWet(brushById(id)), `${id} is wet`);
});

test('ids unique, names and blurbs present, tool is a known sprite', () => {
  assert.equal(new Set(BRUSHES.map(b => b.id)).size, BRUSHES.length);
  for (const b of BRUSHES) {
    assert.ok(b.name && b.blurb, b.id);
    assert.ok(TOOL_KINDS.includes(b.tool), `${b.id}: tool ${b.tool}`);
  }
});

test('inks are [#rrggbb, name] pairs, unique per brush', () => {
  for (const b of BRUSHES) {
    assert.ok(b.inks.length >= 3, b.id);
    for (const [hex, name] of b.inks) {
      assert.match(hex, /^#[0-9a-f]{6}$/, `${b.id} ${hex}`);
      assert.ok(typeof name === 'string' && name.length > 0, `${b.id} ${hex} name`);
    }
    assert.equal(new Set(b.inks.map(([h]) => h)).size, b.inks.length, `${b.id} duplicate ink`);
  }
});

test('every Look uses an ink from its brush palette', () => {
  for (const l of LOOKS) {
    const b = brushById(l.brush);
    assert.equal(b.id, l.brush, `look ${l.id}: unknown brush`);
    assert.ok(b.inks.some(([h]) => h === l.ink), `look ${l.id}: ${l.ink} not in ${b.id} palette`);
  }
});

test('media that suit dark boards have a light ink that flips on black card', () => {
  const black = PAPERS.find(p => p.id === 'black');
  for (const id of ['pencil', 'fineliner', 'crayon', 'marker', 'brush', 'charcoal', 'chalk', 'neon', 'gold']) {
    const b = brushById(id);
    const light = b.inks.find(([h]) => luminance(hexToRgb(h)) > 0.25 && inkMode(b, h, black).flip);
    assert.ok(light, `${id} has no light ink for dark paper`);
  }
});

test('light media prefer dark paper and default to a light ink', () => {
  for (const b of BRUSHES.filter(x => x.prefersDark)) {
    assert.ok(luminance(hexToRgb(b.inks[0][0])) > 0.25, `${b.id} default ink is dark`);
  }
});

test('numeric fields are sane (spread covers halos, lightInk 0..1, glow radii in paper units)', () => {
  for (const b of BRUSHES) {
    assert.ok(b.spread >= 1 && b.spread <= 3, `${b.id} spread ${b.spread}`);
    assert.ok(b.lightInk >= 0 && b.lightInk <= 1, `${b.id} lightInk ${b.lightInk}`);
    if (b.glow) {
      const { amount, tight, wide } = b.glow;
      assert.ok(amount > 0 && amount <= 1, `${b.id} glow amount`);
      assert.ok(tight > 0 && wide >= tight && wide < 12, `${b.id} glow radii`);
    }
  }
  // halos drawn outside the stroke must fit the quad (spread * hw)
  assert.ok(brushById('charcoal').spread >= 2.34, 'charcoal ring reaches 2.34 hw');
  assert.ok(brushById('chalk').spread >= 2.14, 'chalk ring reaches 2.14 hw');
  assert.ok(brushById('ballpoint').spread >= 2.0, 'ballpoint gloops reach 2 hw');
});

test('GLSL keeps the Stroke / Surface / brushDeposit interface and one branch per shader id', () => {
  // the stroke pass fills these fields in this order (js/shaders.js FRAG_STROKE)
  const flat = BRUSH_GLSL.replace(/\s+/g, ' ');
  assert.ok(flat.includes('struct Stroke { float cov; float dist; float hw; float v; float vs; float side; float s; float sU; float tone; vec2 P; float dwell; float speed; float time; float hU; float curv; vec2 dir; };'), 'Stroke fields');
  assert.ok(flat.includes('struct Surface { float groove; float raised; float sheen; float wet; };'), 'Surface fields');
  assert.ok(BRUSH_GLSL.includes('float brushDeposit(int brush, Stroke st, inout vec3 ink, out Surface sf) {'));
  // 0..9 and 11 are tested by id; gold (10) is the final else
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11]) assert.ok(new RegExp(`brush == ${i}\\)`).test(BRUSH_GLSL), `branch ${i}`);
  assert.ok(!/`/.test(BRUSH_GLSL), 'no backticks inside the template');
  // GLSL pow(x, y) is undefined for x < 0: bases must be non-negative by construction
  const pow = BRUSH_GLSL.match(/pow\(([^,]+),/g) || [];
  for (const p of pow) assert.ok(!/pow\(\s*-/.test(p), `pow of a possibly negative base: ${p}`);
});

test('the stroke pass declares what the brushes read from it, before the brush code', () => {
  // segFrame() reads the stroke pass's varyings and the pencil reads uPhotoColor (see the header of
  // js/brushes.js); a rename or reorder in js/shaders.js would otherwise only fail at compile time.
  const at = FRAG_STROKE.indexOf('float brushDeposit(');
  assert.ok(at > 0, 'FRAG_STROKE includes the brush code');
  // (vPos is a plain global, set from gl_FragCoord: strips of a big export and one full pass then
  // compute the same pixels bit for bit)
  for (const decl of ['flat in vec2 vP0;', 'flat in vec2 vP1;', 'flat in vec2 vS;', 'flat in vec2 vW;',
    'vec2 vPos;', 'uniform int uPhotoColor;']) {
    const i = FRAG_STROKE.indexOf(decl);
    assert.ok(i >= 0 && i < at, `FRAG_STROKE declares "${decl}" before brushDeposit`);
  }
  assert.ok(!/\bin vec2 vPos;/.test(FRAG_STROKE), 'vPos is not an interpolated varying');
  // the continued frame replaced the derivative cap test, which left dashes at segment joints
  assert.ok(!/dFd[xy]/.test(BRUSH_GLSL), 'no screen-space derivatives in the brushes');
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
