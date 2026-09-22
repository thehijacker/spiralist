// GLSL variants of a papers module for profiling by elimination (dev/paper-lab.js mode=profv and
// dev/paper-prof.js). applyVariant(keys, { surf, tile }) -> { surf, tile } with parts switched off.
// Anchors that are missing in the loaded module throw, so a stale key never silently measures
// the unmodified shader.
const rep = (s, a, b) => {
  if (!s.includes(a)) throw new Error('variant anchor missing: ' + a);
  return s.split(a).join(b);
};

const V = {
  // composite
  nocloud: g => { g.surf = g.surf.replace(/float (c[0-9]|form|drift) = cloud[A-Za-z0-9]*\([^;]*;/g, 'float $1 = 0.0;'); },
  norelief: g => { g.surf = rep(g.surf, 'float lit = ', 'float lit = 0.0 * '); },
  nohaze: g => { g.surf = rep(g.surf, 'float hz = chalkHaze(pu) * uSmudge;', 'float hz = 0.0;'); },
  noswirl: g => { g.surf = rep(g.surf, 'for (int i = 0; i < 7; i++) {', 'for (int i = 0; i < 0; i++) {'); },
  noknee: g => { g.surf = rep(g.surf, 'return mix(paper, k / shade, step(0.963, lit3));', 'return paper;'); },
  // debug view: R = third-sampling switch, G = near-hard A/B switch for specks and strands
  showmarks: g => { g.surf = rep(g.surf, '  vec4 t = vec4(mix(ta.rg, tb.rg, m), marks);',
    '  vec4 t = vec4(mix(ta.rg, tb.rg, m), marks);\n  shade = 1.0;\n' +
    '  return vec3(smoothstep(0.55, 0.59, vnoiseF(pu * 13.0 + 5.7)), smoothstep(0.47, 0.53, mv), 0.0);'); },
  // tile
  nodomes: g => { g.tile = rep(g.tile, 'if (uBumps > 0.0) {', 'if (uBumps < 0.0) {'); },
  nofibres: g => { g.tile = rep(g.tile, 'if (uFibers > 0.0) {', 'if (uFibers < 0.0) {'); },
};

export function applyVariant(keys, { surf, tile }) {
  const g = { surf, tile };
  for (const k of keys) {
    // hz<x>: another offset (realisation) for the chalkboard haze cloud, e.g. hz3.5
    if (/^hz-?[0-9.]+$/.test(k)) { g.surf = rep(g.surf, 'cloudW(pu * 2.3 + 3.0,', `cloudW(pu * 2.3 + ${(+k.slice(2)).toFixed(3)},`); continue; }
    if (!V[k]) throw new Error('unknown variant ' + k);
    V[k](g);
  }
  return g;
}
