// Paper lab: inspection + measurements for js/papers.js.
//   /dev/paper-lab.html?mode=grid;size=1000            all papers, blank (line=1 draws the portrait)
//   /dev/paper-lab.html?mode=grid;size=4096;crop=.15,.15,.12   1:1 crops of a 4K sheet
//   /dev/paper-lab.html?mode=stats                     tile statistics + preview/export luminance
//   /dev/paper-lab.html?mode=seam;paper=kraft          4K crop across a tile boundary, contrast x8
//   /dev/paper-lab.html?mode=brush                     ink coverage of grain-driven brushes
//   /dev/paper-lab.html?mode=prof;size=2048            GPU ms per tile / composite
//   /dev/paper-lab.html?mode=profv;vs=@orig~@v1~base   the same, interleaved: other modules / variants
//   /dev/paper-lab.html?mode=tilediff;vs=@v1           per-texel tile difference vs another module
// seed=N reads/renders another tile seed. A/B pages load the same lab with another papers module:
// paper-lab-orig.html (before any tuning), paper-lab-v1.html (first tuning, before the review
// fixes), paper-lab-prof.html?v=... (current papers with parts switched off, dev/paper-variants.js).
// Sets window.__done = { ok, file, report } for tests/shoot.mjs.
import { Renderer } from '../js/renderer.js';
import { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS } from '../js/tone.js';
import { buildSpiral, LINE_DEFAULTS } from '../js/spiral.js';
import { PAPERS, LOOKS, brushById, paperById, inkMode } from '../js/materials.js';
import { TILES_ACROSS, TILE_SIZE } from '../js/shaders.js';

const q = new URLSearchParams(location.search);
const LAYOUT = { cx: 0.5, cy: 0.5, r: 0.42 };
const tag = (location.pathname.match(/-(orig|v1|prof).html/) || [0, 'new'])[1];

// ------------------------------------------------------------------ test portrait (as dev/lab.js)
function portrait(S = 1024) {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const u = S / 100;
  const bg = g.createLinearGradient(0, 0, 0, S);
  bg.addColorStop(0, '#c9ced6'); bg.addColorStop(1, '#8d939c');
  g.fillStyle = bg; g.fillRect(0, 0, S, S);
  g.fillStyle = '#2b2f3a';
  g.beginPath(); g.ellipse(50 * u, 108 * u, 46 * u, 30 * u, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#b98a6e'; g.fillRect(42 * u, 62 * u, 16 * u, 18 * u);
  g.fillStyle = '#231a14';
  g.beginPath(); g.ellipse(50 * u, 40 * u, 27 * u, 31 * u, 0, 0, Math.PI * 2); g.fill();
  const face = g.createRadialGradient(42 * u, 40 * u, 4 * u, 50 * u, 46 * u, 30 * u);
  face.addColorStop(0, '#f1cfb4'); face.addColorStop(0.6, '#d7a988'); face.addColorStop(1, '#8f624a');
  g.fillStyle = face;
  g.beginPath(); g.ellipse(50 * u, 47 * u, 20 * u, 26 * u, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#231a14';
  g.beginPath(); g.ellipse(46 * u, 25 * u, 22 * u, 10 * u, -0.3, 0, Math.PI * 2); g.fill();
  for (const s of [-1, 1]) {
    g.fillStyle = '#fbf6f1'; g.beginPath(); g.ellipse((50 + s * 9) * u, 43 * u, 4.2 * u, 2.1 * u, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#3d2a1f'; g.beginPath(); g.arc((50 + s * 9) * u, 43 * u, 1.9 * u, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = '#9c4a44';
  g.beginPath(); g.ellipse(50 * u, 62 * u, 6 * u, 2.2 * u, 0, 0, Math.PI * 2); g.fill();
  return c;
}

const geomCache = new Map();
function geometry({ flip, rings = 64, tech = 'thickness' }) {
  const key = [flip, rings, tech].join('|');
  if (!geomCache.has(key)) {
    const raster = rasterize(portrait(), CROP_DEFAULTS);
    const tone = processTone(raster, TONE_DEFAULTS, { flip });
    const field = buildField(raster, tone.L, { rings, flip });
    geomCache.set(key, buildSpiral(field, { ...LINE_DEFAULTS, technique: tech, rings }, {}));
  }
  return geomCache.get(key);
}

// ------------------------------------------------------------------ rendering
let R;
function renderer() {
  if (R) return R;
  const c = document.createElement('canvas');
  if (q.get('rgba8')) {
    // hide EXT_color_buffer_float so the renderer takes its RGBA8 tile fallback (as on devices
    // without float render targets)
    const get = c.getContext.bind(c);
    c.getContext = (type, attrs) => {
      const gl = get(type, attrs);
      if (gl && !gl.__rgba8) {
        const ext = gl.getExtension.bind(gl);
        gl.getExtension = name => (name === 'EXT_color_buffer_float' ? null : ext(name));
        gl.__rgba8 = true;
      }
      return gl;
    };
  }
  return (R = new Renderer(c));
}

function inkFor(brush, paper) {
  if (q.get('ink')) return q.get('ink');   // (brush=look sets it per paper)
  if (paper.dark) return (brush.inks.find(([h]) => inkMode(brush, h, paper).flip) || brush.inks[0])[0];
  return brush.inks[0][0];
}

/** Render one paper at `size`; line=false draws blank paper. Returns a 2D-canvas copy. */
function render(paper, size, { line = false, brush = brushById('fineliner'), seed = 1 } = {}) {
  const r = renderer();
  const ink = inkFor(brush, paper);
  const mode = inkMode(brush, ink, paper);
  r.setSize(size, Math.round(size * +(q.get('aspect') || 1)));   // aspect = height / width
  r.setLayout(LAYOUT);
  r.setPaper(paper, seed);
  r.setStyle({ brush, ink, cover: mode.cover, photoColor: false });
  r.setGeometry(geometry({ flip: mode.flip }));
  if (line) r.render(Infinity); else r.renderBlank();
  return copy(r.canvas);
}

function copy(src, x = 0, y = 0, w = src.width, h = src.height) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(src, -x, -y);
  return c;
}

function pixels(c) { return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data; }
const lum = (d, o) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];

/** Luminance statistics of a canvas (0..255 levels). block = size of the averaging block for 'mottle'. */
function lumStats(c, block = 8) {
  const d = pixels(c), w = c.width, h = c.height;
  let s = 0, s2 = 0, mx = 0, mn = 255, n = w * h;
  for (let o = 0; o < d.length; o += 4) {
    const l = lum(d, o); s += l; s2 += l * l;
    mx = Math.max(mx, d[o], d[o + 1], d[o + 2]); mn = Math.min(mn, l);
  }
  const mean = s / n;
  // block means: the low-frequency part of the texture (mottling) vs per-pixel grain
  const bm = [];
  for (let y = 0; y + block <= h; y += block) for (let x = 0; x + block <= w; x += block) {
    let t = 0;
    for (let j = 0; j < block; j++) for (let i = 0; i < block; i++) t += lum(d, ((y + j) * w + x + i) * 4);
    bm.push(t / (block * block));
  }
  const bmean = bm.reduce((a, b) => a + b, 0) / bm.length;
  const bstd = Math.sqrt(bm.reduce((a, b) => a + (b - bmean) ** 2, 0) / bm.length);
  const r = x => +x.toFixed(2);
  return { mean: r(mean), std: r(Math.sqrt(Math.max(0, s2 / n - mean * mean))), blockStd: r(bstd), maxChannel: mx, minLum: r(mn) };
}

function boxDown(src, k) {
  const w = src.width, h = src.height, d = pixels(src);
  const W = w / k, H = h / k;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const cx = c.getContext('2d'), out = cx.createImageData(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0;
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) {
      const o = ((y * k + j) * w + x * k + i) * 4;
      r += d[o]; g += d[o + 1]; b += d[o + 2];
    }
    const o = (y * W + x) * 4, n = k * k;
    out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n; out.data[o + 3] = 255;
  }
  cx.putImageData(out, 0, 0);
  return c;
}

// ------------------------------------------------------------------ tile readback
function readTile(paper, seed = +(q.get('seed') || 1)) {
  const r = renderer();
  r.setPaper(paper, seed);
  const gl = r.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, r.tileTex.fbo);
  const N = TILE_SIZE;
  const f = new Float32Array(N * N * 4);
  gl.readPixels(0, 0, N, N, gl.RGBA, gl.FLOAT, f);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return f;
}

function channelStats(f, ch, N) {
  let s = 0, s2 = 0, mn = 1e9, mx = -1e9;
  const n = N * N;
  for (let i = 0; i < n; i++) { const v = f[i * 4 + ch]; s += v; s2 += v * v; mn = Math.min(mn, v); mx = Math.max(mx, v); }
  const m = s / n;
  return { mean: m, std: Math.sqrt(Math.max(0, s2 / n - m * m)), min: mn, max: mx };
}

function downTile(f, N) {
  const M = N / 2, o = new Float32Array(M * M * 4);
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) for (let c = 0; c < 4; c++) {
    const a = (i, j) => f[((y * 2 + j) * N + x * 2 + i) * 4 + c];
    o[(y * M + x) * 4 + c] = 0.25 * (a(0, 0) + a(1, 0) + a(0, 1) + a(1, 1));
  }
  return o;
}

/** Seam test: mean |difference| across the wrap edge vs across ordinary neighbouring texels. */
function seamStats(f, N, ch) {
  let edgeX = 0, edgeY = 0, inX = 0, inY = 0;
  for (let i = 0; i < N; i++) {
    edgeX += Math.abs(f[(i * N + N - 1) * 4 + ch] - f[(i * N) * 4 + ch]);
    edgeY += Math.abs(f[((N - 1) * N + i) * 4 + ch] - f[i * 4 + ch]);
    for (let k = 0; k < N - 1; k++) {
      inX += Math.abs(f[(i * N + k + 1) * 4 + ch] - f[(i * N + k) * 4 + ch]);
      inY += Math.abs(f[((k + 1) * N + i) * 4 + ch] - f[(k * N + i) * 4 + ch]);
    }
  }
  const r = x => +x.toFixed(5);
  return { wrapX: r(edgeX / N), wrapY: r(edgeY / N), inX: r(inX / (N * (N - 1))), inY: r(inY / (N * (N - 1))) };
}

// GPU timer for the prof modes: time(fn) -> ms per call of fn(i). EXT_disjoint_timer_query_webgl2
// when exposed (exact GPU time, no sync overhead), else k calls per readPixels sync. Other GPU work
// (parallel agents, the desktop) only ever adds time, so the figure is the 10th percentile of n.
function gpuTimer(gl, n, k) {
  const px = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const p10 = ms => { const s = [...ms].sort((x, y) => x - y); return +s[Math.floor(0.1 * (s.length - 1))].toFixed(3); };
  const frame = () => new Promise(res => setTimeout(res, 0));
  const time = async fn => {
    // a laptop GPU clocks down when idle: keep it busy for ~300 ms first, then time back to back
    const t0 = performance.now();
    while (performance.now() - t0 < 300) { for (let j = 0; j < 4; j++) fn(j); sync(); }
    const ms = [];
    if (tq) {
      const qs = [];
      for (let i = 0; i < n; i++) {
        const qq = gl.createQuery();
        gl.beginQuery(tq.TIME_ELAPSED_EXT, qq); fn(i); gl.endQuery(tq.TIME_ELAPSED_EXT);
        qs.push(qq);
      }
      for (const qq of qs) {
        while (!gl.getQueryParameter(qq, gl.QUERY_RESULT_AVAILABLE)) await frame();
        if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) ms.push(gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(qq);
      }
      return p10(ms);
    }
    for (let i = 0; i < n; i++) {
      sync();
      const t = performance.now();
      for (let j = 0; j < k; j++) fn(i * k + j);
      sync();
      ms.push((performance.now() - t) / k);
    }
    return p10(ms);
  };
  time.kind = tq ? 'gpu-query' : 'sync';
  return time;
}

// ------------------------------------------------------------------ contact sheet
function sheet(items, cols, cw, ch, label = 18) {
  const rows = Math.ceil(items.length / cols);
  const c = document.createElement('canvas');
  c.width = cols * cw; c.height = rows * (ch + label);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.fillStyle = '#d9d5ce'; g.fillRect(0, 0, c.width, c.height);
  items.forEach(([img, text], i) => {
    const x = (i % cols) * cw, y = Math.floor(i / cols) * (ch + label);
    g.drawImage(img, x, y, cw, ch);
    g.fillStyle = '#222'; g.font = '12px system-ui'; g.fillText(text, x + 6, y + ch + 13);
  });
  return c;
}

async function save(canvas, name, type = 'image/png') {
  const data = canvas.toDataURL(type, 0.93);
  const r = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data }) });
  return r.json();
}

// ------------------------------------------------------------------ modes
const papers = (q.get('papers') || PAPERS.map(p => p.id).join(',')).split(',').map(paperById);

async function run() {
  const mode = q.get('mode') || 'grid';
  const size = +(q.get('size') || 1000);
  const t0 = performance.now();
  let out, report;

  if (mode === 'grid') {
    // blank (or drawn) sheets; crop=x,y,w takes a 1:1 window of the full render
    const crop = q.get('crop') ? q.get('crop').split(',').map(Number) : null;
    const brush = brushById(q.get('brush') || 'fineliner');
    const line = q.get('line') === '1';
    const items = [];
    report = {};
    // brush=look draws each paper with the brush + ink of the first Look that uses it
    const lookFor = p => LOOKS.find(l => l.paper === p.id);
    for (const p of papers) {
      const look = q.get('brush') === 'look' ? lookFor(p) : null;
      if (look) q.set('ink', look.ink);
      let c = render(p, size, { line, brush: look ? brushById(look.brush) : brush, seed: +(q.get('seed') || 1) });
      report[p.id] = lumStats(c);
      if (crop) c = copy(c, Math.round(crop[0] * size), Math.round(crop[1] * size), Math.round(crop[2] * size), Math.round(crop[2] * size));
      items.push([c, `${p.name} @${size}${crop ? ' crop' : ''} (${tag})`]);
    }
    const cols = +(q.get('cols') || 4), zoom = +(q.get('zoom') || 1);   // zoom: nearest-neighbour
    out = sheet(items, cols, items[0][0].width * zoom, items[0][0].height * zoom);
  } else if (mode === 'stats') {
    // Tile distribution per LOD, seamlessness, and blank-paper luminance at preview/export sizes.
    report = {};
    const sizes = (q.get('sizes') || '256,1024').split(',').map(Number);
    for (const p of papers) {
      const N = TILE_SIZE;
      let f = readTile(p);
      const rep = { seam: { R: seamStats(f, N, 0), B: seamStats(f, N, 2) } };
      let gErr = 0;
      for (let i = 0; i < N * N; i++) gErr = Math.max(gErr, Math.abs(f[i * 4 + 1] - f[i * 4] * f[i * 4]));
      rep.maxAbs_G_minus_R2 = +gErr.toFixed(4);
      rep.lod = [];
      let n = N;
      for (let lod = 0; lod <= 4; lod++) {
        const s = channelStats(f, 0, n), b = channelStats(f, 2, n);
        rep.lod.push({ lod, Rmean: +s.mean.toFixed(4), Rstd: +s.std.toFixed(4), Rmin: +s.min.toFixed(3), Rmax: +s.max.toFixed(3), Bmean: +b.mean.toFixed(4) });
        if (lod < 4) { f = downTile(f, n); n /= 2; }
      }
      // what the renderer's 50/50 blend of two decorrelated samplings leaves at LOD 0
      rep.RstdBlendedLod0 = +(rep.lod[0].Rstd / Math.SQRT2).toFixed(4);
      rep.blank = {};
      for (const s of sizes) rep.blank[s] = lumStats(render(p, s));
      if (sizes.length > 1) rep.dMeanLum = +Math.abs(rep.blank[sizes[0]].mean - rep.blank[sizes[sizes.length - 1]].mean).toFixed(2);
      if (q.get('big')) {
        // 4x export box-downsampled against the preview size
        const s = +(q.get('big'));
        const a = lumStats(render(p, s)), b = lumStats(boxDown(render(p, s * 4), 4));
        rep.boxDown = { size: s, mean: a.mean, meanFrom4x: b.mean, d: +Math.abs(a.mean - b.mean).toFixed(2) };
      }
      report[p.id] = rep;
    }
    out = sheet(papers.map(p => [render(p, 200), p.name]), 7, 200, 200);
  } else if (mode === 'calib') {
    // Tile statistics of single components (custom paper defs) to normalise their amplitudes.
    const base = { color: '#f0f0f0', speck: '#888888', tooth: 0, toothCells: 120, bumps: 0, bumpCells: 23,
      fibers: 0, specks: 0, relief: 0.5, mottle: 0, smudge: 0, grid: 0 };
    const variants = {
      tooth120: { tooth: 1 }, tooth150: { tooth: 1, toothCells: 150 }, tooth104: { tooth: 1, toothCells: 104 },
      domes23: { bumps: 1 }, fib035: { fibers: 0.35 }, fib1: { fibers: 1 }, specks1: { specks: 1 },
      ...Object.fromEntries(PAPERS.map(p => [p.id, p])),
    };
    report = {};
    const items = [];
    for (const [name, v] of Object.entries(variants)) {
      const def = { ...base, ...v, id: 'cal_' + name };
      const N = TILE_SIZE;
      let f = readTile(def), n = N;
      const rows = [];
      for (let lod = 0; lod <= 3; lod++) {
        const s = channelStats(f, 0, n), b = channelStats(f, 2, n), a = channelStats(f, 3, n);
        rows.push(`L${lod} R ${s.mean.toFixed(3)}±${s.std.toFixed(4)} [${s.min.toFixed(2)},${s.max.toFixed(2)}]` +
          (lod ? '' : ` B ${b.mean.toFixed(4)} max ${b.max.toFixed(2)} A ${a.mean.toFixed(4)}±${a.std.toFixed(4)}`));
        if (lod < 3) { f = downTile(f, n); n /= 2; }
      }
      // percentiles of R at LOD 0 (brushes threshold against this distribution)
      const f1 = readTile(def), vals = new Float32Array(N * N);
      for (let i2 = 0; i2 < N * N; i2++) vals[i2] = f1[i2 * 4];
      vals.sort();
      const pc = [1, 5, 25, 50, 75, 95, 99].map(k => vals[Math.floor(k / 100 * (N * N - 1))].toFixed(3));
      rows.push('pct 1/5/25/50/75/95/99 ' + pc.join('/'));
      report[name] = rows.join(' | ');
      // tile R as an image (contrast x2 around 0.5), top-left 256 texels
      const c = document.createElement('canvas'); c.width = c.height = 256;
      const g = c.getContext('2d'), id = g.createImageData(256, 256), f0 = readTile(def);
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
        const v2 = f0[((N - 1 - y) * N + x) * 4], o = (y * 256 + x) * 4;
        id.data[o] = id.data[o + 1] = id.data[o + 2] = Math.max(0, Math.min(255, 128 + (v2 - 0.5) * 2 * 255)); id.data[o + 3] = 255;
      }
      g.putImageData(id, 0, 0);
      items.push([c, name]);
    }
    out = sheet(items, 7, 256, 256);
  } else if (mode === 'perf') {
    // GPU cost: tile generation (new seed each time) and one blank composite at size x size.
    report = {};
    const r = renderer(), gl = r.gl, px = new Uint8Array(4);
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const N = +(q.get('n') || 12);
    for (const p of papers) {
      render(p, size); sync();                       // warm up programs and targets
      let t = performance.now();
      for (let i = 0; i < 4; i++) { r.setPaper(p, 100 + i); sync(); }
      const tileMs = (performance.now() - t) / 4;
      r.setPaper(p, 1);
      t = performance.now();
      for (let i = 0; i < N; i++) { r.renderBlank(); sync(); }
      report[p.id] = { tileMs: +tileMs.toFixed(1), compositeMs: +((performance.now() - t) / N).toFixed(2) };
    }
    out = render(papers[0], 256);
  } else if (mode === 'prof' || mode === 'profv') {
    // GPU time per pass (see gpuTimer):
    //   prof:  tile generation + blank composite per paper at size x size
    //   profv: the same for GLSL variants of the loaded papers module (vs=base~nocloud~nocloud,norelief;
    //          keys in dev/paper-variants.js), interleaved over rounds. Each variant keeps its best
    //          round, so contention that hits one round does not decide the comparison.
    report = { size };
    const r = renderer();
    const time = gpuTimer(r.gl, +(q.get('n') || 25), +(q.get('k') || 8));
    report.timer = time.kind;
    let variants = [['current', r.progs.comp, r.progs.tile]];
    if (mode === 'profv') {
      const { applyVariant } = await import('./paper-variants.js');
      const { VERT_FULL, FRAG_COMPOSITE, FRAG_PAPER_TILE } = await import('../js/shaders.js');
      const { PAPER_SURFACE_GLSL, PAPER_TILE_GLSL } = await import('../js/papers.js');
      // '@v1' / '@orig' swap in another papers module's GLSL wholesale (same uniforms)
      const other = {};
      for (const vk of (q.get('vs') || 'base').split(/[|~]/)) if (vk[0] === '@') other[vk] = await import(`./paper-${vk.slice(1)}.js`);
      variants = (q.get('vs') || 'base').split(/[|~]/).map(vk => {
        const v = vk[0] === '@' ? { surf: other[vk].PAPER_SURFACE_GLSL, tile: other[vk].PAPER_TILE_GLSL }
          : applyVariant(vk === 'base' ? [] : vk.split(','), { surf: PAPER_SURFACE_GLSL, tile: PAPER_TILE_GLSL });
        return [vk, r._program(VERT_FULL, FRAG_COMPOSITE.split(PAPER_SURFACE_GLSL).join(v.surf)),
          r._program(VERT_FULL, FRAG_PAPER_TILE.split(PAPER_TILE_GLSL).join(v.tile))];
      });
    }
    const rounds = +(q.get('rounds') || (mode === 'profv' ? 3 : 1));
    const best = {};
    for (let round = 0; round < rounds; round++) {
      for (const p of papers) {
        for (const [vk, comp, tile] of variants) {
          r.progs.comp = comp; r.progs.tile = tile; r.paperKey = null;
          render(p, size);                               // warm up programs and targets
          const tileMs = await time(i => r.setPaper(p, 1000 + i));
          r.setPaper(p, 1);
          const compositeMs = await time(() => r._composite());
          const key = mode === 'profv' ? vk + ' ' + p.id : p.id;
          const o = best[key] || (best[key] = { tileMs: Infinity, compositeMs: Infinity });
          o.tileMs = Math.min(o.tileMs, tileMs); o.compositeMs = Math.min(o.compositeMs, compositeMs);
        }
      }
    }
    Object.assign(report, best);
    out = render(papers[0], 256);
  } else if (mode === 'tilediff') {
    // Tile of the loaded papers module vs another module's (vs=@v1): per channel mean/std of both
    // and the per-texel difference, at LOD 0. R is what brushes threshold against, so a change
    // there moves ink coverage; B/A only change the paper's look.
    const { VERT_FULL, FRAG_PAPER_TILE } = await import('../js/shaders.js');
    const { PAPER_TILE_GLSL } = await import('../js/papers.js');
    const other = await import(`./paper-${(q.get('vs') || '@v1').slice(1)}.js`);
    const r = renderer();
    const mine = r.progs.tile;
    const theirs = r._program(VERT_FULL, FRAG_PAPER_TILE.split(PAPER_TILE_GLSL).join(other.PAPER_TILE_GLSL));
    const N = TILE_SIZE, f4 = x => +x.toFixed(4);
    report = {};
    for (const p of papers) {
      r.progs.tile = theirs; r.paperKey = null;
      const a = readTile(p);
      r.progs.tile = mine; r.paperKey = null;
      const b = readTile(p);
      const rep = {};
      for (const [ch, name] of [[0, 'R'], [2, 'B'], [3, 'A']]) {
        const sa = channelStats(a, ch, N), sb = channelStats(b, ch, N);
        let mx = 0, s = 0;
        for (let i = 0; i < N * N; i++) { const d = Math.abs(a[i * 4 + ch] - b[i * 4 + ch]); mx = Math.max(mx, d); s += d; }
        rep[name] = { mean: [f4(sa.mean), f4(sb.mean)], std: [f4(sa.std), f4(sb.std)], maxAbsDiff: f4(mx), meanAbsDiff: f4(s / (N * N)) };
      }
      rep.seamR = seamStats(b, N, 0); rep.seamB = seamStats(b, N, 2); rep.seamA = seamStats(b, N, 3);
      report[p.id] = rep;
    }
    r.paperKey = null;
    out = render(papers[0], 256);
  } else if (mode === 'seam') {
    // 1:1 window of a 4K sheet straddling the tile boundary (x = y = W/6), contrast-stretched so
    // any discontinuity would jump out. Also a window around a rotated-sampling region.
    const p = paperById(q.get('paper') || 'cream');
    const S = +(q.get('size') || 4096), w = +(q.get('w') || 384), gain = +(q.get('gain') || 8);
    const full = render(p, S);
    const b = Math.round(S / TILES_ACROSS);
    const win = copy(full, b - w / 2, b - w / 2, w, w);
    const d = pixels(win);
    let m = 0; for (let o = 0; o < d.length; o += 4) m += lum(d, o); m /= w * w;
    const g = win.getContext('2d'), id = g.getImageData(0, 0, w, w);
    for (let o = 0; o < id.data.length; o += 4) for (let c = 0; c < 3; c++) id.data[o + c] = 128 + (d[o + c] - m) * gain;
    g.putImageData(id, 0, 0);
    // column/row difference profile: a seam shows as a spike at the boundary index w/2
    const prof = (dx, dy) => {
      const v = [];
      for (let k = 1; k < w; k++) {
        let t = 0;
        for (let j = 0; j < w; j++) {
          const [x1, y1, x0, y0] = dx ? [k, j, k - 1, j] : [j, k, j, k - 1];
          t += Math.abs(lum(d, (y1 * w + x1) * 4) - lum(d, (y0 * w + x0) * 4));
        }
        v.push(t / w);
      }
      const at = v[w / 2 - 1];
      const others = v.filter((_, i) => Math.abs(i - (w / 2 - 1)) > 2);
      const mean = others.reduce((a, c) => a + c, 0) / others.length;
      return { atBoundary: +at.toFixed(3), meanElsewhere: +mean.toFixed(3), maxElsewhere: +Math.max(...others).toFixed(3) };
    };
    report = { paper: p.id, size: S, boundaryPx: b, cols: prof(1, 0), rows: prof(0, 1) };
    out = win;
  } else if (mode === 'brush') {
    // Mean |dL| the line adds inside the art circle, for grain-thresholded brushes.
    const list = (q.get('pairs') || 'pencil:sketch,pencil:cream,pencil:coldpress,crayon:kraft,crayon:sketch,crayon:coldpress,chalk:chalkboard,charcoal:coldpress,ballpoint:cream,brush:coldpress').split(',');
    report = {};
    const items = [];
    const crop = q.get('crop') ? q.get('crop').split(',').map(Number) : [0.36, 0.28, 0.2];
    for (const pair of list) {
      const [bid, pid] = pair.split(':');
      const brush = brushById(bid), paper = paperById(pid);
      const blank = render(paper, size, { brush });
      const drawn = render(paper, size, { brush, line: true });
      const a = pixels(blank), b = pixels(drawn);
      // pigment deposit straight from the renderer's pigment buffer (alpha = brush deposit), so the
      // number isolates how the brush reads the grain from how the paper surface is lit
      const gl = R.gl, pig = new Uint8Array(size * size * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, R.pig.fbo);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pig);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const cx = size / 2, cy = size / 2, rr = LAYOUT.r * size;
      let t = 0, n = 0, pa = 0, pa2 = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > rr * rr) continue;
        const o = (y * size + x) * 4;
        t += Math.abs(lum(b, o) - lum(a, o)); n++;
        const al = pig[((size - 1 - y) * size + x) * 4 + 3] / 255; pa += al; pa2 += al * al;
      }
      report[pair] = { dL: +(t / n).toFixed(2), pigment: +(pa / n).toFixed(4), pigmentStd: +Math.sqrt(pa2 / n - (pa / n) ** 2).toFixed(4) };
      items.push([copy(drawn, Math.round(crop[0] * size), Math.round(crop[1] * size), Math.round(crop[2] * size), Math.round(crop[2] * size)), `${pair} (${tag}) pig=${report[pair].pigment}`]);
    }
    out = sheet(items, 5, items[0][0].width, items[0][0].height);
  }
  const ms = performance.now() - t0;
  const res = await save(out, q.get('shot') || `paper_${mode}_${tag}`, q.get('jpg') ? 'image/jpeg' : 'image/png');
  window.__done = { ok: true, ms: Math.round(ms), report, ...res };
  document.body.append(out);
  out.style.maxWidth = '100%';
}

run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
