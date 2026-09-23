// Wet-media bench: shader compile time and still / film-frame costs per medium, GPU-synced.
//   node tests/shoot.mjs "/dev/wetbench.html?size=1000;brushes=fineliner,fountain;reps=3"
// Reports window.__done = { ok, report } (no image).
import { Renderer } from '../js/renderer.js';
import { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS } from '../js/tone.js';
import { buildSpiral, LINE_DEFAULTS } from '../js/spiral.js';
import { brushById, paperById, inkMode } from '../js/materials.js';
import { makeSample } from '../js/samples.js';

const q = new URLSearchParams(location.search);

// mode=compile: compile time of each program as it is, and of the stroke program with parts cut
// out (cut=a,b: GLSL snippets replaced by 0.0), to find what the driver's compiler chokes on
async function compileBench() {
  const S = await import('../js/shaders.js');
  const { FRAG_WET_STEP } = await import('../js/wetsim.js');
  const gl = document.createElement('canvas').getContext('webgl2');
  // (the driver's own compile runs at link time or at the first draw: time compile + link + draw)
  const px = new Uint8Array(4);
  const time = (vs, fs) => {
    const t = performance.now();
    const mk = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(p));
    gl.useProgram(p);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const ms = performance.now() - t;
    gl.deleteProgram(p);
    return +ms.toFixed(0);
  };
  const report = {};
  const salt = s => s.replace('precision highp float;', 'precision highp float;\n// ' + Math.random());   // defeat caches
  report.stroke = time(S.VERT_STROKE, salt(S.FRAG_STROKE));
  // one program per medium: the brush id a compile-time constant, so every other branch is dead code
  for (const id of (q.get('ids') || '').split(',').filter(Boolean)) {
    report['stroke brush ' + id] = time(S.VERT_STROKE, salt(S.FRAG_STROKE.replace('uniform int uBrush;', `const int uBrush = ${id};`)));
  }
  report.composite = time(S.VERT_FULL, salt(S.FRAG_COMPOSITE));
  for (const [m, w] of [[1, 0], [1, 1], [2, 0], [5, 0]]) {
    report[`composite material ${m} wet ${w}`] = time(S.VERT_FULL, salt(S.FRAG_COMPOSITE
      .replace('uniform int uMaterial;', `const int uMaterial = ${m};`).replace('uniform int uSimOn;', `const int uSimOn = ${w};`)));
    report[`composite material ${m} wet ${w} plain paper`] = time(S.VERT_FULL, salt(S.FRAG_COMPOSITE
      .replace('uniform int uMaterial;', `const int uMaterial = ${m};`).replace('uniform int uSimOn;', `const int uSimOn = ${w};`)
      .replace('uniform float uSmudge;', 'const float uSmudge = 0.0;').replace('uniform float uGrid;', 'const float uGrid = 0.0;')));
  }
  report.wetStep = time(S.VERT_FULL, salt(FRAG_WET_STEP));
  for (const cut of (q.get('cut') || '').split('|').filter(Boolean)) {
    report['stroke without ' + cut] = time(S.VERT_STROKE, salt(S.FRAG_STROKE.split(cut).join('0.0')));
  }
  window.__done = { ok: true, report };
}

async function run() {
  await new Promise(r => setTimeout(r, 0));            // let the page finish loading first
  if (q.get('mode') === 'compile') return compileBench();
  const size = +(q.get('size') || 1000), reps = +(q.get('reps') || 3);
  const report = { size };
  let t = performance.now();
  const r = new Renderer(document.createElement('canvas'));
  const gl = r.gl, px = new Uint8Array(4);
  const sync = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
  sync();
  report.constructMs = +(performance.now() - t).toFixed(1);
  const src = await makeSample(q.get('img') || 'bust', 1024);
  const raster = rasterize(src, CROP_DEFAULTS);
  const tone = processTone(raster, TONE_DEFAULTS, {});
  const field = buildField(raster, tone.L, { rings: +(q.get('rings') || 56) });
  const geom = buildSpiral(field, { ...LINE_DEFAULTS, rings: +(q.get('rings') || 56) }, {});
  report.segments = geom.n - 1;
  report.brushes = [];
  for (const id of (q.get('brushes') || 'fineliner,fountain,brush,marker,watercolour').split(',')) {
    const brush = brushById(id), paper = paperById(q.get('paper') || (id === 'watercolour' || id === 'brush' ? 'coldpress' : 'sketch'));
    const ink = brush.inks[0][0], mode = inkMode(brush, ink, paper);
    r.setSize(size, size); r.setLayout({ cx: 0.5, cy: 0.5, r: 0.42 }); r.setPaper(paper, 1);
    r.setStyle({ brush, ink, cover: mode.cover, photoColor: false }); r.setGeometry(geom); r.setLight();
    sync();
    t = performance.now(); r.render(Infinity); sync();
    const first = performance.now() - t;
    const still = [];
    for (let i = 0; i < reps; i++) {
      r.dirty = true; r.simDirty = true; sync();
      t = performance.now(); r.render(Infinity); sync(); still.push(performance.now() - t);
    }
    // film-like incremental frames at the drawing's middle
    const frames = [];
    r.render(0.3 * (geom.n - 1), { settle: 0 }); sync();
    for (let i = 1; i <= 30; i++) {
      t = performance.now(); r.render((0.3 + i * 0.004) * (geom.n - 1), { settle: 0 }); sync(); frames.push(performance.now() - t);
    }
    const med = a => +a.slice().sort((x, y) => x - y)[a.length >> 1].toFixed(2);
    report.brushes.push({ id, paper: paper.id, firstMs: +first.toFixed(1), stillMs: med(still), frameMs: med(frames), wetSteps: r.stats.wetSteps });
  }
  window.__done = { ok: true, report };
}
run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
