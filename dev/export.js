// Export lab: verifies js/export.js in a real browser and saves the files for inspection.
//   node tests/shoot.mjs "/dev/export.html?t=strips"      (';' between params on the command line;
//   in Git Bash prefix MSYS_NO_PATHCONV=1 so the path is not rewritten)
//   ?t=strips    forced strips (render height 256) vs one full pass, every brush, 2048; seam rates
//   ?t=seams     production strip plan vs a full pass at 4096; two strip plans against each other at 8192
//   ?t=shift     least-squares sub-pixel shift of strips vs full pass + x40 difference maps
//   ?t=fragcoord hand-made strips vs one pass (brushes=, layer=pig, margin=, strip=): lists differing px
//   ?t=big       2048/4096/8192 (?sizes=) exports: timing, in-flight memory; files -> shots/export_*.png
//   ?t=jank      longest main-thread stall during an export (?size=, ?warm=0 for a cold page)
//   ?t=alpha     transparent exports: exact decode, straight-alpha fringe check; files -> shots/
//   ?t=transp    transparent export over the paper's colour vs the paper export (wet media too)
//   ?t=svg       SVG outline/stroke/plotter rasterised by the browser vs the WebGL line (+ zig-zag stress,
//                hard tone edges, maze); ?cases=hard_outline,maze_plotter picks some
//   ?t=abort     cancel mid-export, pre-aborted signal, 20 exports in a row (context leaks warn)
//   ?t=api       main-thread + canvas-fallback encoders, maxExportSize, share probes
//   ?t=fallback  workers that cannot start / that fail every job still export identical pixels
//   ?t=probe     largest single WebGL drawing buffer the browser grants
//   ?t=quick     small cross-browser subset (--browser firefox | webkit)
// Sets window.__done = { ok, report }.
import { Renderer } from '../js/renderer.js';
import { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS } from '../js/tone.js';
import { buildSpiral, LINE_DEFAULTS, STRIDE } from '../js/spiral.js';
import { buildMaze, MAZE_DEFAULTS } from '../js/maze.js';
import { BRUSHES, brushById, paperById, inkMode, hexToRgb } from '../js/materials.js';
import { exportPNG, maxExportSize, buildSVG, svgStats, fileName, canShareFiles, crc32 } from '../js/export.js';

const q = new URLSearchParams(location.search);
const LAYOUT = { cx: 0.5, cy: 0.5, r: 0.42 };
const logEl = document.getElementById('log');
const log = (...a) => { const s = a.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join(' '); logEl.textContent += '\n' + s; console.log(s); };

// ------------------------------------------------------------------ test photo
function portrait(S = 1024) {
  const c = Object.assign(document.createElement('canvas'), { width: S, height: S });
  const g = c.getContext('2d');
  const u = S / 100;
  const bg = g.createLinearGradient(0, 0, 0, S);
  bg.addColorStop(0, '#c9ced6'); bg.addColorStop(1, '#8d939c');
  g.fillStyle = bg; g.fillRect(0, 0, S, S);
  g.fillStyle = '#2b2f3a'; g.beginPath(); g.ellipse(50 * u, 108 * u, 46 * u, 30 * u, 0, 0, 7); g.fill();
  g.fillStyle = '#b98a6e'; g.fillRect(42 * u, 62 * u, 16 * u, 18 * u);
  g.fillStyle = '#231a14'; g.beginPath(); g.ellipse(50 * u, 40 * u, 27 * u, 31 * u, 0, 0, 7); g.fill();
  const face = g.createRadialGradient(42 * u, 40 * u, 4 * u, 50 * u, 46 * u, 30 * u);
  face.addColorStop(0, '#f1cfb4'); face.addColorStop(0.6, '#d7a988'); face.addColorStop(1, '#8f624a');
  g.fillStyle = face; g.beginPath(); g.ellipse(50 * u, 47 * u, 20 * u, 26 * u, 0, 0, 7); g.fill();
  g.fillStyle = '#231a14'; g.beginPath(); g.ellipse(46 * u, 25 * u, 22 * u, 10 * u, -0.3, 0, 7); g.fill();
  for (const s of [-1, 1]) {
    g.fillStyle = '#fbf6f1'; g.beginPath(); g.ellipse((50 + s * 9) * u, 43 * u, 4.2 * u, 2.1 * u, 0, 0, 7); g.fill();
    g.fillStyle = '#1d140f'; g.beginPath(); g.arc((50 + s * 9) * u, 43 * u, 1.9 * u, 0, 7); g.fill();
  }
  g.fillStyle = '#9c4a44'; g.beginPath(); g.ellipse(50 * u, 62 * u, 6 * u, 2.2 * u, 0, 0, 7); g.fill();
  return c;
}

/** Hard-edged test card: a checkerboard of near-black / light squares over a soft gradient. */
function checker(S = 1024) {
  const c = Object.assign(document.createElement('canvas'), { width: S, height: S });
  const g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, S, S);
  bg.addColorStop(0, '#e8e8e8'); bg.addColorStop(1, '#8a8a8a');
  g.fillStyle = bg; g.fillRect(0, 0, S, S);
  g.fillStyle = '#141414';
  const k = S / 8;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if ((x + y) & 1) g.fillRect(x * k, y * k, k, k);
  return c;
}

const photos = { portrait: portrait(), checker: checker() };
const geomCache = new Map();
function makeState({ brush = 'fineliner', paper = 'cream', ink, tech = 'thickness', rings = 64, photoColor = false, line = {}, src = 'portrait', maze = null } = {}) {
  const b = brushById(brush), p = paperById(paper);
  ink = ink || (p.dark ? (b.inks.find(([h]) => inkMode(b, h, p).flip) || b.inks[0])[0] : b.inks[0][0]);
  const mode = inkMode(b, ink, p, photoColor);
  const key = [src, tech, rings, mode.flip, photoColor, JSON.stringify(line), JSON.stringify(maze)].join('|');
  if (!geomCache.has(key)) {
    const raster = rasterize(photos[src], CROP_DEFAULTS);
    const tone = processTone(raster, TONE_DEFAULTS, { flip: mode.flip });
    const field = buildField(raster, tone.L, { rings, flip: mode.flip });
    const L = { ...LINE_DEFAULTS, technique: tech, rings, ...line };
    geomCache.set(key, maze ? buildMaze(field, L, { ...MAZE_DEFAULTS, ...maze }, { colorFromPhoto: photoColor })
      : buildSpiral(field, L, { colorFromPhoto: photoColor }));
  }
  return { geom: geomCache.get(key), brush: b, paper: p, ink, cover: mode.cover, photoColor, layout: LAYOUT, seed: 1 };
}
// A brush on the paper it is meant for.
const paperFor = b => (b.id === 'chalk' ? 'chalkboard' : b.prefersDark ? 'black' : b.id === 'crayon' ? 'kraft' : 'cream');

// ------------------------------------------------------------------ reference + decoding
/** Single full-sheet pass, like the app preview. Returns bottom-up RGBA (gl.readPixels order). */
function reference(state, S, transparent = false) {
  const r = new Renderer(document.createElement('canvas'));
  r.setSize(S, S);
  const gl = r.gl;
  if (gl.drawingBufferWidth !== S || gl.drawingBufferHeight !== S) { r.destroy(); throw new Error(`reference buffer ${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`); }
  r.setLayout(state.layout); r.setPaper(state.paper, state.seed); r.setStyle(state); r.setTransparent(transparent);
  r.setGeometry(state.geom);
  r.render(Infinity);
  const px = new Uint8Array(S * S * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
  r.destroy();
  return px;
}

/** Streaming PNG decoder (exact, straight alpha): verifies CRCs, calls onRow(y, bytes, channels). */
async function decodeRows(blob, onRow) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (sig.some((b, i) => buf[i] !== b)) throw new Error('bad signature');
  let o = 8, w = 0, h = 0, ct = 0, phys = null, badCrc = 0;
  const idat = [], types = [];
  while (o < buf.length) {
    const len = dv.getUint32(o), type = String.fromCharCode(...buf.subarray(o + 4, o + 8));
    types.push(type);
    if (crc32(buf.subarray(o + 4, o + 8 + len)) !== dv.getUint32(o + 8 + len)) badCrc++;
    if (type === 'IHDR') { w = dv.getUint32(o + 8); h = dv.getUint32(o + 12); ct = buf[o + 17]; }
    if (type === 'pHYs') phys = [dv.getUint32(o + 8), dv.getUint32(o + 12), buf[o + 16]];
    if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const C = ct === 6 ? 4 : 3, RB = w * C;
  const reader = new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  let prev = new Uint8Array(RB), cur = new Uint8Array(RB);
  const row = new Uint8Array(RB + 1);
  let fill = 0, y = 0;
  const filters = [0, 0, 0, 0, 0];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (let p = 0; p < value.length;) {
      const take = Math.min(RB + 1 - fill, value.length - p);
      row.set(value.subarray(p, p + take), fill);
      fill += take; p += take;
      if (fill < RB + 1) continue;
      const f = row[0];
      filters[f]++;
      for (let i = 0; i < RB; i++) {
        const a = i >= C ? cur[i - C] : 0, b = prev[i], c = i >= C ? prev[i - C] : 0;
        let pred = 0;
        if (f === 1) pred = a; else if (f === 2) pred = b; else if (f === 3) pred = (a + b) >> 1;
        else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        cur[i] = (row[1 + i] + pred) & 255;
      }
      onRow(y++, cur, C);
      [prev, cur] = [cur, prev];
      fill = 0;
    }
  }
  return { w, h, ct, types, phys, badCrc, rows: y, filters };
}

/** Compare a decoded PNG with a bottom-up reference; per-row max diff kept for seam analysis. */
// premul: compare RGBA as premultiplied colour (rgb * a) + alpha, i.e. what a compositor sees.
// Straight colour at low alpha is quantisation noise from the 8-bit pigment buffer (x 255/a).
async function compare(blob, ref, S, { seams = 0, premul = false } = {}) {
  let max = 0, sum = 0, nDiff = 0, maxAt = null, nVals = 0;
  const rowMax = new Uint8Array(S), rowDiff = new Uint32Array(S);
  const hist = new Uint32Array(256);
  const info = await decodeRows(blob, (y, row, C) => {
    const base = (S - 1 - y) * S * 4;
    let rm = 0;
    for (let x = 0; x < S; x++) {
      let pm = 0;
      const pa = row[x * C + 3], ra = ref[base + x * 4 + 3];
      for (let c = 0; c < C; c++) {
        const d = premul && C === 4 && c < 3
          ? Math.round(Math.abs(row[x * C + c] * pa - ref[base + x * 4 + c] * ra) / 255)
          : Math.abs(row[x * C + c] - ref[base + x * 4 + c]);
        sum += d; nVals++;
        if (d > pm) pm = d;
      }
      if (pm) { nDiff++; hist[pm]++; rowDiff[y]++; }
      if (pm > max) { max = pm; maxAt = [x, y]; }
      if (pm > rm) rm = pm;
    }
    rowMax[y] = rm;
  });
  let over8 = 0;
  for (let d = 9; d < 256; d++) over8 += hist[d];
  const out = { max, mean: +(sum / nVals).toFixed(6), nDiff, over8, fracDiff: +(nDiff / (S * S)).toExponential(2), maxAt,
    hist: Object.fromEntries([...hist.entries()].filter(([, v]) => v)), rows: info.rows, ct: info.ct, badCrc: info.badCrc,
    phys: info.phys, types: info.types.filter(t => t !== 'IDAT').join(','), idats: info.types.filter(t => t === 'IDAT').length,
    filters: info.filters };
  if (seams) {
    // max diff on rows within 2 px of a strip boundary vs everywhere else
    let near = 0, far = 0, nearRows = 0, farRows = 0, nearDiff = 0, farDiff = 0;
    for (let y = 0; y < S; y++) {
      const dist = Math.min(y % seams, seams - (y % seams));
      if (dist <= 2 && y > 2) { near = Math.max(near, rowMax[y]); nearRows++; nearDiff += rowDiff[y]; }
      else { far = Math.max(far, rowMax[y]); farRows++; farDiff += rowDiff[y]; }
    }
    out.seamRowsMax = near; out.otherRowsMax = far;
    // differing pixels per row: near seams vs elsewhere (a seam artefact raises the first)
    out.seamDiffPerRow = +(nearDiff / Math.max(1, nearRows)).toFixed(2);
    out.otherDiffPerRow = +(farDiff / Math.max(1, farRows)).toFixed(2);
  }
  return out;
}

async function post(blob, name) {
  const r = await fetch('/__file?name=' + encodeURIComponent(name), { method: 'POST', body: blob });
  return (await r.json()).file;
}
async function shot(canvas, name) {
  const r = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data: canvas.toDataURL('image/png') }) });
  return (await r.json()).file;
}

function heapSampler() {
  const mem = performance.memory;
  if (!mem) return { stop: () => null };
  let peak = mem.usedJSHeapSize;
  const base = peak;
  const id = setInterval(() => { peak = Math.max(peak, performance.memory.usedJSHeapSize); }, 20);
  return { stop: () => { clearInterval(id); return { baseMB: +(base / 1048576).toFixed(0), peakMB: +(peak / 1048576).toFixed(0) }; } };
}

// ------------------------------------------------------------------ tests
const T = {};

T.strips = async () => {
  const S = +(q.get('size') || 2048), strip = +(q.get('strip') || 256);
  const ids = (q.get('brushes') || BRUSHES.map(b => b.id).join(',')).split(',');
  const rows = [];
  for (const id of ids) {
    const b = brushById(id);
    const st = makeState({ brush: id, paper: paperFor(b) });
    const ref = reference(st, S);
    const single = await exportPNG(st, { size: S });
    const stats = {};
    const striped = await exportPNG(st, { size: S, strip, stats });
    const a = await compare(single, ref, S);
    const c = await compare(striped, ref, S, { seams: stats.core });
    rows.push({ brush: id, paper: st.paper.id, single: { max: a.max, nDiff: a.nDiff }, strips: { max: c.max, mean: c.mean, nDiff: c.nDiff, over8: c.over8, seamRowsMax: c.seamRowsMax, otherRowsMax: c.otherRowsMax, seamDiffPerRow: c.seamDiffPerRow, otherDiffPerRow: c.otherDiffPerRow, maxAt: c.maxAt, hist: c.hist }, core: stats.core, margin: stats.margin, n: stats.strips });
    log(id, JSON.stringify(rows[rows.length - 1]));
  }
  // photo-colour ink and the wave technique through strips as well
  for (const opt of [{ brush: 'marker', paper: 'sketch', photoColor: true }, { brush: 'neon', paper: 'black', tech: 'wave' }]) {
    const st = makeState(opt);
    const ref = reference(st, S);
    const stats = {};
    const c = await compare(await exportPNG(st, { size: S, strip, stats }), ref, S, { seams: stats.core });
    rows.push({ brush: opt.brush + (opt.photoColor ? '+photo' : '') + (opt.tech ? '+' + opt.tech : ''), strips: { max: c.max, mean: c.mean, nDiff: c.nDiff, over8: c.over8, seamRowsMax: c.seamRowsMax, seamDiffPerRow: c.seamDiffPerRow, otherDiffPerRow: c.otherDiffPerRow } });
    log(JSON.stringify(rows[rows.length - 1]));
  }
  const worst = Math.max(...rows.map(r => r.strips.max));
  const singleWorst = Math.max(...rows.filter(r => r.single).map(r => r.single.max));
  // Single pass and strips must both be byte-identical to the reference: every pass takes the
  // paper position from gl_FragCoord and every filtered tap is an exact texel bilinear, so a strip
  // computes what the full sheet does, bit for bit (see ?t=fragcoord, which lists any difference).
  const ok = singleWorst === 0 && worst === 0;
  return { ok, size: S, strip, singleWorst, stripWorst: worst, rows };
};

T.seams = async () => {
  // 4096: production strip plan (core 512 + halo) vs one true single pass (Chrome caps a single
  // WebGL buffer at 5760^2, so 8192 cannot have a single-pass reference). 8192: two strip plans
  // with different seams (core 512 vs 1024): a seam artifact in either shows on rows that are a
  // seam in one plan only.
  const out = [];
  for (const opt of [{ brush: 'neon', paper: 'black' }, { brush: 'charcoal', paper: 'coldpress' }, { brush: 'fineliner', paper: 'cream' }]) {
    const st = makeState(opt);
    {
      const S = 4096, stats = {};
      const t0 = performance.now();
      const blob = await exportPNG(st, { size: S, stats });
      const ms = performance.now() - t0;
      const c = await compare(blob, reference(st, S), S, { seams: stats.core });
      out.push({ brush: opt.brush, S, vs: 'single pass', ms: Math.round(ms), core: stats.core, margin: stats.margin, max: c.max, mean: c.mean, over8: c.over8, seamDiffPerRow: c.seamDiffPerRow, otherDiffPerRow: c.otherDiffPerRow, hist: c.hist });
      log(JSON.stringify(out[out.length - 1]));
    }
    if (q.get('big') !== '0') {
      const S = 8192;
      const a = await exportPNG(st, { size: S });                  // core 512
      const b = await exportPNG(st, { size: S, strip: 1024 });     // core 1024
      // decode b fully into a bottom-up buffer to act as the reference for a
      const ref = new Uint8Array(S * S * 4);
      await decodeRows(b, (y, row, C) => {
        const base = (S - 1 - y) * S * 4;
        for (let x = 0; x < S; x++) { ref[base + x * 4] = row[x * C]; ref[base + x * 4 + 1] = row[x * C + 1]; ref[base + x * 4 + 2] = row[x * C + 2]; ref[base + x * 4 + 3] = 255; }
      });
      const c = await compare(a, ref, S, { seams: 512 });
      out.push({ brush: opt.brush, S, vs: 'core 1024 plan', max: c.max, mean: c.mean, over8: c.over8, seamDiffPerRow: c.seamDiffPerRow, otherDiffPerRow: c.otherDiffPerRow, hist: c.hist });
      log(JSON.stringify(out[out.length - 1]));
    }
  }
  return { ok: out.every(r => r.max === 0), out };            // strips are exact (see T.strips)
};

T.big = async () => {
  const sizes = (q.get('sizes') || '4096,8192').split(',').map(Number);
  const looks = [
    { name: 'classic', brush: 'fineliner', paper: 'cream', ink: '#17171a' },
    { name: 'neon', brush: 'neon', paper: 'black', ink: '#ff45e9', tech: 'wave', rings: 52 },
    { name: 'pencil', brush: 'pencil', paper: 'sketch', ink: '#2a2a2e', rings: 80 },
  ].filter(l => !q.get('looks') || q.get('looks').split(',').includes(l.name));
  const out = [];
  for (const S of sizes) {
    for (const look of looks) {
      const st = makeState(look);
      const heap = heapSampler();
      const stats = {};
      let progress = 0, calls = 0, monotone = true;
      const t0 = performance.now();
      const blob = await exportPNG(st, { size: S, stats, onProgress: f => { calls++; if (f < progress) monotone = false; progress = f; } });
      const ms = performance.now() - t0;
      const mem = heap.stop();
      const file = await post(blob, `export_${look.name}_${S}.png`);
      const row = { look: look.name, S, ms: Math.round(ms), renderMs: Math.round(stats.renderMs), strips: stats.strips, margin: stats.margin, workers: stats.workers, bands: stats.bands,
        MB: +(blob.size / 1048576).toFixed(1), stripMB: +stats.stripMB?.toFixed(1), peakInFlightMB: +stats.peakInFlightMB?.toFixed(1), progressCalls: calls, lastProgress: progress, monotone, heap: mem, file };
      out.push(row);
      log(JSON.stringify(row));
    }
  }
  return { ok: out.every(r => r.lastProgress === 1 && r.monotone), maxExportSize: maxExportSize(), out };
};

T.alpha = async () => {
  const S = +(q.get('size') || 2048);
  const cases = [
    { brush: 'fineliner', paper: 'cream', ink: '#17171a' },
    { brush: 'crayon', paper: 'kraft', ink: '#c8372d' },
    { brush: 'charcoal', paper: 'coldpress' },
    { brush: 'chalk', paper: 'chalkboard', ink: '#f3f0e8' },
    { brush: 'gold', paper: 'black', ink: '#d9b44a' },
    { brush: 'neon', paper: 'black', ink: '#3cf2ff' },
  ];
  const out = [];
  for (const cs of cases) {
    const st = makeState(cs);
    const ink = hexToRgb(st.ink).map(v => Math.round(v * 255));
    const stats = {};
    const blob = await exportPNG(st, { size: S, transparent: true, strip: 512, stats });
    const ref = reference(st, S, true);
    const cmp = await compare(blob, ref, S, { premul: true, seams: 512 });
    // Fringe: partly transparent pixels must carry the ink colour itself (straight alpha). A dark
    // fringe = colour pulled toward black by coverage, i.e. edge pixels systematically darker than
    // the ink. Straight-colour error is judged as the compositor sees it: |col - ink| * a.
    let edge = 0, maxPremulOff = 0, premulOff1 = 0, wLum = 0, wSum = 0, opaque = 0, clear = 0, maxOffA64 = 0;
    const inkLum = 0.2126 * ink[0] + 0.7152 * ink[1] + 0.0722 * ink[2];
    const info = await decodeRows(blob, (y, row) => {
      for (let x = 0; x < S; x++) {
        const o = x * 4, a = row[o + 3];
        if (a === 0) { clear++; continue; }
        if (a === 255) { opaque++; continue; }
        edge++;
        const off = Math.max(Math.abs(row[o] - ink[0]), Math.abs(row[o + 1] - ink[1]), Math.abs(row[o + 2] - ink[2]));
        const pOff = off * a / 255;
        if (pOff > maxPremulOff) maxPremulOff = pOff;
        if (pOff > 1.5) premulOff1++;
        if (a >= 64 && off > maxOffA64) maxOffA64 = off;
        wLum += (0.2126 * row[o] + 0.7152 * row[o + 1] + 0.0722 * row[o + 2]) * a; wSum += a;
      }
    });
    const row = { brush: cs.brush, ink: st.ink, cover: st.cover, ct: info.ct, vsSinglePassPremul: cmp.max, premulMean: cmp.mean, premulOver8: cmp.over8, seamRowsMax: cmp.seamRowsMax,
      edgePx: edge, opaquePx: opaque, clearPx: clear, maxOffInkAlpha64: maxOffA64, maxPremulOffInk: +maxPremulOff.toFixed(2), premulOffOver1_5: premulOff1,
      edgeLumWeighted: +(wLum / Math.max(1, wSum)).toFixed(2), inkLum: +inkLum.toFixed(2) };
    row.file = await post(blob, `export_alpha_${cs.brush}.png`);
    out.push(row);
    log(JSON.stringify(row));
  }
  // Media whose colour is exactly the ink (no glow / metallic sheen) must have zero fringe error.
  const flat = out.filter(r => ['fineliner', 'crayon', 'charcoal', 'chalk'].includes(r.brush));
  return { ok: out.every(r => r.ct === 6 && r.premulMean < 0.01 && r.premulOver8 <= 5e-5 * S * S) && flat.every(r => r.maxPremulOffInk <= 1.5 && Math.abs(r.edgeLumWeighted - r.inkLum) < 1), size: S, out };
};

// Transparent PNG vs the paper export: the transparent ink laid over the paper's own flat colour
// must read like the drawing on paper (8x8 block mean luminance, 0..255). Wet media carry part of
// their ink in the simulation; this catches a transparent path that leaves it out. (On a near-white
// sheet by default: over a tinted one a translucent coloured dye cannot be straight alpha exactly,
// a multiply darkens the paper's tint under it too, by (1 - paper) x ink; so each medium's darkest
// ink by default, ?ink= and ?paper= to see how far that goes.) Media with a lit material (graphite,
// wax, oil, metal) are reported but not judged: the paper render adds their sheen, which an ink-only
// file has no light for.
//   ?t=transp  (brushes=, size=, paper=, ink=)
T.transp = async () => {
  const S = +(q.get('size') || 2048);
  const ids = (q.get('brushes') || 'fineliner,fountain,brush,marker,watercolour,pencil,charcoal').split(',');
  const out = [];
  const lum = h => { const [r, g, b] = hexToRgb(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  for (const id of ids) {
    const b = brushById(id);
    const ink = q.get('ink') || (b.prefersDark ? undefined : [...b.inks].sort((x, y) => lum(x[0]) - lum(y[0]))[0][0]);
    const st = makeState({ brush: id, paper: q.get('paper') || (b.prefersDark ? paperFor(b) : 'sketch'), ink });
    const pc = hexToRgb(st.paper.color).map(v => v * 255);
    const B = 8, nb = S / B;
    const lumOf = async (blob, over) => {
      const acc = new Float64Array(nb * nb);
      await decodeRows(blob, (y, row, C) => {
        for (let x = 0; x < S; x++) {
          const o = x * C;
          let r = row[o], g = row[o + 1], bb = row[o + 2];
          if (over && C === 4) {
            const a = row[o + 3] / 255;
            r = r * a + pc[0] * (1 - a); g = g * a + pc[1] * (1 - a); bb = bb * a + pc[2] * (1 - a);
          }
          acc[(y / B | 0) * nb + (x / B | 0)] += 0.2126 * r + 0.7152 * g + 0.0722 * bb;
        }
      });
      return acc.map(v => v / (B * B));
    };
    const lp = await lumOf(await exportPNG(st, { size: S }), false);
    const lt = await lumOf(await exportPNG(st, { size: S, transparent: true }), true);
    // only blocks with ink in them (the bare sheet differs by its texture alone)
    let sum = 0, n = 0, sp = 0, stt = 0;
    const bare = 0.2126 * pc[0] + 0.7152 * pc[1] + 0.0722 * pc[2];
    for (let i = 0; i < lp.length; i++) {
      if (lt[i] > bare - 4) continue;
      sum += Math.abs(lp[i] - lt[i]); sp += lp[i]; stt += lt[i]; n++;
    }
    const row = { brush: id, paper: st.paper.id, ink: st.ink, judged: ['ink', 'chalk'].includes(b.material), inkBlocks: n,
      meanBlockDL: +(sum / Math.max(1, n)).toFixed(2), meanLumPaper: +(sp / Math.max(1, n)).toFixed(1), meanLumTransp: +(stt / Math.max(1, n)).toFixed(1) };
    out.push(row);
    log(JSON.stringify(row));
  }
  return { ok: out.every(r => !r.judged || r.meanBlockDL < 3), size: S, out };
};

/** Rasterise an SVG with the browser at S x S on white; returns the RGBA bytes + canvas. */
async function rasterSVG(svg, S) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = Object.assign(document.createElement('canvas'), { width: S, height: S });
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff'; g.fillRect(0, 0, S, S);
    g.drawImage(img, 0, 0, S, S);
    return { data: g.getImageData(0, 0, S, S).data, canvas: c };
  } finally { URL.revokeObjectURL(url); }
}

/** Overlay + crop for eyeballing: SVG coverage in red, WebGL coverage in cyan; agreement = grey. */
function overlay(covA, covB, S, crop, zoom = 1) {
  const [x0, y0, w] = crop.map(v => Math.round(v * S));
  const c = Object.assign(document.createElement('canvas'), { width: w * zoom, height: w * zoom });
  const g = c.getContext('2d');
  const img = g.createImageData(w * zoom, w * zoom);
  for (let y = 0; y < w * zoom; y++) for (let x = 0; x < w * zoom; x++) {
    const i = (y0 + Math.floor(y / zoom)) * S + x0 + Math.floor(x / zoom), o = (y * w * zoom + x) * 4;
    img.data[o] = 255 - covB[i]; img.data[o + 1] = 255 - covA[i]; img.data[o + 2] = 255 - covA[i]; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Stress geometry: a fat zig-zag with 60-150 degree turns, widths 1..7 mm, near-cusps. */
function zigzagGeom() {
  const pts = [];
  let s = 0, px = -0.8, py = -0.6;
  const corners = [[-0.8, -0.6], [-0.5, 0.3], [-0.35, -0.5], [-0.1, 0.55], [0.0, -0.2], [0.05, 0.6], [0.35, -0.55], [0.4, 0.1], [0.8, -0.3], [0.62, 0.7]];
  for (let c = 0; c < corners.length - 1; c++) {
    const [ax, ay] = corners[c], [bx, by] = corners[c + 1];
    const steps = 12 + c * 3;                      // uneven sampling, like real geometry
    for (let k = c ? 1 : 0; k <= steps; k++) {
      const t = k / steps, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
      if (pts.length) s += Math.hypot(x - px, y - py);
      const w = 0.012 + 0.07 * (0.5 + 0.5 * Math.sin(pts.length / STRIDE * 0.66));   // as before the dwell field: steep tapers
      pts.push(x, y, w, s, 1, 0, 1);               // x, y, w, s, tone, turn, dwell (STRIDE = 7)
      px = x; py = y;
    }
  }
  if (pts.length % STRIDE) throw new Error('zigzagGeom: record size is not STRIDE');
  const data = new Float32Array(pts);
  const n = data.length / STRIDE;
  return { n, data, colors: null, rings: 1, spacing: 0.1, length: s, turns: 0, technique: 'thickness', maxWidth: 0.082, minWidth: 0.012, penWidth: null, path: 'spiral', _pace: new Map() };
}

T.svg = async () => {
  const S = +(q.get('size') || 4096);
  const out = [];
  // name, mode, state options, crops [x0, y0, width] as sheet fractions (null = whole sheet)
  const EYE = [0.40, 0.36, 72 / 1024], RIM = [0.08, 0.46, 72 / 1024];
  const HARD = { src: 'checker', rings: 16, line: { weight: 0.95, hairline: 0.02 } };   // hard tone edges, wide bands
  const MAZE = { rings: 40, maze: { shape: 'square', flow: 0.8 } };
  const cases = [
    ['zigzag', 'outline', {}, [null]],
    ['thickness', 'outline', {}, [EYE, RIM]],
    ['wave', 'stroke', { tech: 'wave' }, [EYE, RIM]],
    ['wave', 'outline', { tech: 'wave' }, [EYE, RIM]],
    ['both', 'outline', { tech: 'both' }, [EYE, RIM]],
    ['hard', 'outline', HARD, [[0.30, 0.44, 96 / 1024], [0.46, 0.46, 96 / 1024]]],
    ['hard40', 'outline', { src: 'checker', rings: 40 }, [[0.30, 0.44, 72 / 1024]]],
    ['maze', 'outline', MAZE, [[0.40, 0.36, 96 / 1024]]],
    ['thickness', 'plotter', {}, [EYE, RIM]],
    ['hard', 'plotter', HARD, [[0.30, 0.44, 96 / 1024], [0.46, 0.46, 96 / 1024]]],
    ['maze', 'plotter', MAZE, [[0.40, 0.36, 96 / 1024]]],
  ];
  const only = q.get('cases')?.split(',');
  for (const [tech, mode, opt, crops] of cases) {
    if (only && !only.includes(`${tech}_${mode}`)) continue;
    const st = makeState({ brush: 'fineliner', paper: 'cream', ink: '#000000', tech: 'thickness', rings: 64, ...opt });
    if (tech === 'zigzag') st.geom = zigzagGeom();
    const t0 = performance.now();
    const svg = buildSVG(st.geom, { mode, ink: '#000000', paper: null, layout: LAYOUT });
    const buildMs = performance.now() - t0;
    const stats = svgStats(svg);
    await post(new Blob([svg], { type: 'image/svg+xml' }), `export_${mode}_${tech}.svg`);
    const t1 = performance.now();
    const R = mode === 'plotter' ? 4096 : S;       // plotter pen is 0.3 mm: rasterise finer (?size=4096 for all)
    const { data } = await rasterSVG(svg, R);
    const rasterMs = performance.now() - t1;
    // WebGL line (fineliner, transparent) at the same size: coverage from alpha
    const ref = reference(st, R, true);
    const covSvg = new Uint8Array(R * R), covGl = new Uint8Array(R * R);
    for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
      const i = y * R + x;
      covSvg[i] = 255 - data[i * 4 + 1];
      covGl[i] = ref[((R - 1 - y) * R + x) * 4 + 3];
    }
    let inter = 0, uni = 0, sumS = 0, sumG = 0, onlyS = 0, onlyG = 0;
    for (let i = 0; i < R * R; i++) {
      const a = covSvg[i] >= 128, b = covGl[i] >= 122;      // fineliner deposits ~0.95 at full coverage
      if (a && b) inter++;
      if (a || b) uni++;
      if (a && !b) onlyS++;
      if (b && !a) onlyG++;
      sumS += covSvg[i]; sumG += covGl[i];
    }
    const row = { tech, mode, nodes: stats.nodes, KiB: Math.round(stats.bytes / 1024), buildMs: Math.round(buildMs), rasterMs: Math.round(rasterMs),
      raster: R, iou: +(inter / uni).toFixed(4), onlySvg: onlyS, onlyGl: onlyG, inkRatio: +(sumS / (sumG / 0.95)).toFixed(4) };
    out.push(row);
    log(JSON.stringify(row));
    // eyeball crops: the eye region and the rim
    for (const [k, crop] of crops.entries()) {
      if (!crop) { await shot(overlay(covSvg, covGl, R, [0, 0, 1], 1), `export_svg_${mode}_${tech}`); continue; }
      const z = Math.max(1, Math.round(900 / (crop[2] * R)));      // ~900 px wide crops
      await shot(overlay(covSvg, covGl, R, crop, z), `export_svg_${mode}_${tech}_${crop === EYE ? 'eye' : crop === RIM ? 'rim' : 'crop' + k}`);
    }
  }
  // Pixel IoU of lines only 5-30 px wide is bounded by antialiased edges; tests/export.test.mjs
  // holds the exact geometric check (Euclidean, <= 0.0325 mm from the renderer's shape). The
  // plotter's 0.3 mm pen overdraws hairlines thinner than itself and leaves 0.06 mm scallops.
  const ok = out.every(r => r.iou > (r.mode === 'plotter' ? 0.9 : 0.94));
  return { ok, out };
};

T.abort = async () => {
  const st = makeState({ brush: 'pencil', paper: 'sketch' });
  const ac = new AbortController();
  let abortedAt = 0, lastF = 0;
  const t0 = performance.now();
  let err = null;
  try {
    await exportPNG(st, { size: 8192, signal: ac.signal, onProgress: f => { lastF = f; if (f >= 0.25 && !abortedAt) { abortedAt = performance.now(); ac.abort(); } } });
  } catch (e) { err = e; }
  const settleMs = performance.now() - abortedAt;
  const pre = new AbortController(); pre.abort();
  let preErr = null;
  try { await exportPNG(st, { size: 1024, signal: pre.signal }); } catch (e) { preErr = e; }
  // Twenty exports in a row: a leaked context per export would trip Chrome's
  // "Too many active WebGL contexts" warning (reported by the driver as a console warning).
  const t1 = performance.now();
  let bytes = 0;
  for (let i = 0; i < 20; i++) bytes += (await exportPNG(st, { size: 512 })).size;
  const ok = err?.code === 'aborted' && err.name === 'AbortError' && lastF < 0.5 && preErr?.code === 'aborted';
  return { ok, code: err?.code, name: err?.name, lastProgress: lastF, settleMs: Math.round(settleMs), totalMs: Math.round(performance.now() - t0), preAborted: preErr?.code, repeated20ms: Math.round(performance.now() - t1), repeatedBytes: bytes };
};

T.api = async () => {
  const st = makeState({ brush: 'crayon', paper: 'kraft', ink: '#1f5fa8' });
  const S = 1024;
  const ref = reference(st, S);
  const own = await compare(await exportPNG(st, { size: S, encoder: 'png' }), ref, S);
  const canvasBlob = await exportPNG(st, { size: S, encoder: 'canvas' });
  const viaCanvas = await compare(canvasBlob, ref, S);
  const refA = reference(st, S, true);
  const viaCanvasAlpha = await compare(await exportPNG(st, { size: S, encoder: 'canvas', transparent: true }), refA, S, { premul: true });
  const out = {
    ownEncoder: { max: own.max, phys: own.phys, chunks: own.types, filters: own.filters, idats: own.idats },
    canvasFallback: { max: viaCanvas.max, phys: viaCanvas.phys, chunks: viaCanvas.types },
    canvasFallbackAlpha: { max: viaCanvasAlpha.max, mean: viaCanvasAlpha.mean, nDiff: viaCanvasAlpha.nDiff },
    maxExportSize: maxExportSize(),
    ua: navigator.userAgent, deviceMemory: navigator.deviceMemory, mobile: navigator.userAgentData?.mobile,
    compressionStream: typeof CompressionStream !== 'undefined',
    clipboardItem: typeof ClipboardItem !== 'undefined',
    canShare: { mp4: canShareFiles('video/mp4'), webm: canShareFiles('video/webm;codecs=vp9'), png: canShareFiles('image/png'), svg: canShareFiles('image/svg+xml') },
    fileName: fileName(['spiralist', 'My Photo', 'Pencil', 4096], 'png'),
  };
  log(JSON.stringify(out));
  return { ok: own.max === 0 && viaCanvas.max === 0 && viaCanvas.phys?.[0] === 11811, ...out };
};

T.quick = async () => {
  const S = 1024;
  const res = [];
  for (const opt of [{ brush: 'pencil', paper: 'sketch' }, { brush: 'neon', paper: 'black' }]) {
    const st = makeState(opt);
    const ref = reference(st, S);
    const c = await compare(await exportPNG(st, { size: S, strip: 128 }), ref, S, { seams: 128 });
    res.push({ brush: opt.brush, max: c.max, mean: c.mean, seamRowsMax: c.seamRowsMax, phys: c.phys, badCrc: c.badCrc });
  }
  const st = makeState({ brush: 'fineliner', paper: 'cream', ink: '#1f3a93' });
  const refA = reference(st, S, true);
  const a = await compare(await exportPNG(st, { size: S, transparent: true, strip: 256 }), refA, S, { premul: true });
  res.push({ transparent: true, max: a.max, ct: a.ct });
  const fb = await compare(await exportPNG(st, { size: S, encoder: 'canvas' }), reference(st, S), S);
  res.push({ canvasFallback: true, max: fb.max, phys: fb.phys });
  log(JSON.stringify(res));
  return { ok: res.every(r => r.max <= 2), compressionStream: typeof CompressionStream !== 'undefined', maxExportSize: maxExportSize(), res };
};

T.shift = async () => {
  // Is a strip export displaced against the single pass? Least-squares fit of the difference
  // onto the reference's gradient: diff ~ dx * dI/dx + dy * dI/dy. A half-texel glow offset
  // would show as |d| ~ 0.1-0.5 px; rounding noise fits ~0. Also saves a x40 diff map.
  const S = +(q.get('size') || 2048), strip = +(q.get('strip') || 256);
  const out = [];
  for (const opt of [{ brush: 'neon', paper: 'black', tech: 'wave' }, { brush: 'neon', paper: 'black' }, { brush: 'charcoal', paper: 'coldpress' }]) {
    const st = makeState(opt);
    const ref = reference(st, S);
    const blob = await exportPNG(st, { size: S, strip });
    const L = (a, o) => 0.2126 * a[o] + 0.7152 * a[o + 1] + 0.0722 * a[o + 2];
    const refL = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) refL[y * S + x] = L(ref, ((S - 1 - y) * S + x) * 4);
    const diff = new Float32Array(S * S);
    await decodeRows(blob, (y, row) => { for (let x = 0; x < S; x++) diff[y * S + x] = L(row, x * 3) - refL[y * S + x]; });
    let sxx = 0, syy = 0, sxy = 0, sxd = 0, syd = 0, sd = 0, n = 0;
    for (let y = 1; y < S - 1; y++) for (let x = 1; x < S - 1; x++) {
      const i = y * S + x;
      const gx = (refL[i + 1] - refL[i - 1]) / 2, gy = (refL[i + S] - refL[i - S]) / 2, d = diff[i];
      sxx += gx * gx; syy += gy * gy; sxy += gx * gy; sxd += gx * d; syd += gy * d; sd += d; n++;
    }
    const det = sxx * syy - sxy * sxy;
    const dx = (sxd * syy - syd * sxy) / det, dy = (syd * sxx - sxd * sxy) / det;
    // crop of the amplified difference around the face (grey = equal)
    const cw = 512, x0 = Math.round(S * 0.3), y0 = Math.round(S * 0.3);
    const c = Object.assign(document.createElement('canvas'), { width: cw, height: cw });
    const g = c.getContext('2d'), img = g.createImageData(cw, cw);
    for (let y = 0; y < cw; y++) for (let x = 0; x < cw; x++) {
      const v = Math.max(0, Math.min(255, 128 + diff[(y0 + y) * S + x0 + x] * 40)), o = (y * cw + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v; img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const name = `export_diff_${opt.brush}_${opt.tech || 'thickness'}`;
    await shot(c, name);
    out.push({ ...opt, shiftX: +dx.toFixed(4), shiftY: +dy.toFixed(4), meanSignedDiff: +(sd / n).toFixed(4), shot: name });
    log(JSON.stringify(out[out.length - 1]));
  }
  return { ok: out.every(r => Math.abs(r.shiftX) < 0.02 && Math.abs(r.shiftY) < 0.02), size: S, strip, out };
};

T.none = async () => ({ ok: true });     // fixture page for tests/export.drive.mjs

/**
 * Strips vs one full pass, rendered by hand (no encoder). The stroke, composite and blur passes
 * take the paper position from gl_FragCoord (exact at pixel centres with whole origins), so every
 * medium but the glow's bilinear blur taps should match to the bit. Lists the differing pixels.
 */
const LAYER = q.get('layer') || 'canvas';        // 'pig': compare the pigment target instead
function renderFull(Cls, st, S) {
  const r = new Cls(document.createElement('canvas'));
  r.setSize(S, S); r.setLayout(st.layout); r.setPaper(st.paper, 1); r.setStyle(st); r.setGeometry(st.geom); r.render(Infinity);
  const px = new Uint8Array(S * S * 4);
  r.gl.bindFramebuffer(r.gl.FRAMEBUFFER, LAYER === 'pig' ? r.pig.fbo : null);
  r.gl.readPixels(0, 0, S, S, r.gl.RGBA, r.gl.UNSIGNED_BYTE, px);
  r.destroy();
  return px;                                    // bottom-up
}

function renderStrips(Cls, st, S, H, margin) {
  const r = new Cls(document.createElement('canvas'));
  r.setPaperSize(S, S); r.setSize(S, H); r.setLayout(st.layout); r.setPaper(st.paper, 1); r.setStyle(st); r.setGeometry(st.geom);
  const core = H - 2 * margin, out = new Uint8Array(S * S * 4), buf = new Uint8Array(S * core * 4);
  for (let y0 = 0; y0 < S; y0 += core) {
    const rows = Math.min(core, S - y0);
    r.setOrigin(0, y0 - margin); r.render(Infinity);
    r.gl.bindFramebuffer(r.gl.FRAMEBUFFER, LAYER === 'pig' ? r.pig.fbo : null);
    r.gl.readPixels(0, H - margin - rows, S, rows, r.gl.RGBA, r.gl.UNSIGNED_BYTE, buf);
    // strip rows (bottom-up) -> full bottom-up image: paper row y0 + k sits at full row S - 1 - (y0 + k)
    for (let k = 0; k < rows; k++) {
      const src = (rows - 1 - k) * S * 4;
      out.set(buf.subarray(src, src + S * 4), (S - 1 - (y0 + k)) * S * 4);
    }
  }
  r.destroy();
  return out;
}

T.fragcoord = async () => {
  const S = +(q.get('size') || 2048), H = +(q.get('strip') || 256), margin = +(q.get('margin') || 48);
  const opts = q.get('brushes') ? q.get('brushes').split(',').map(b => ({ brush: b, paper: paperFor(brushById(b)) }))
    : [{ brush: 'chalk', paper: 'chalkboard' }, { brush: 'charcoal', paper: 'coldpress' }, { brush: 'crayon', paper: 'kraft' }, { brush: 'pencil', paper: 'sketch' }];
  const out = [];
  for (const opt of opts) {
    const st = makeState(opt);
    const a = renderFull(Renderer, st, S), b = renderStrips(Renderer, st, S, H, margin);
    let max = 0, n = 0, big = 0;
    const where = [];
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (!d) continue;
      n++; if (d > max) max = d; if (d > 8) big++;
      if (where.length < 12 && (i & 3) === 0) {
        const px = i >> 2, x = px % S, y = S - 1 - Math.floor(px / S);     // paper px (y down)
        const core = H - 2 * margin;
        where.push({ x, y, rowInStrip: y % core, full: [...a.subarray(i, i + 4)], strip: [...b.subarray(i, i + 4)] });
      }
    }
    const row = { brush: opt.brush, max, valuesDiffering: n, over8: big, where };
    out.push(row);
    log(JSON.stringify(row));
  }
  return { ok: out.every(r => r.max <= 2), S, H, margin, out };
};

T.fallback = async () => {
  // Workers that cannot start (CSP) and workers that fail every job must both still export,
  // on the main thread, with identical pixels.
  const S = 1024, st = makeState({ brush: 'crayon', paper: 'kraft', ink: '#1f5fa8' });
  const ref = reference(st, S);
  const Real = window.Worker;
  const out = {};
  try {
    window.Worker = function () { throw new DOMException('blocked by CSP', 'SecurityError'); };
    const stats = {};
    out.cannotStart = { ...(await compare(await exportPNG(st, { size: S, stats }), ref, S)), mode: stats.mode };
    window.Worker = class extends Real {
      constructor() { super(URL.createObjectURL(new Blob(['self.onmessage = e => self.postMessage({ id: e.data.id, error: "simulated failure" });']))); }
    };
    const stats2 = {};
    out.jobsFail = { ...(await compare(await exportPNG(st, { size: S, strip: 256, stats: stats2 }), ref, S)), mode: stats2.mode };
  } finally { window.Worker = Real; }
  for (const k of Object.keys(out)) out[k] = { max: out[k].max, mode: out[k].mode, rows: out[k].rows };
  return { ok: out.cannotStart.max === 0 && out.cannotStart.mode === 'png' && out.jobsFail.max <= 2 && out.jobsFail.mode === 'png', ...out };
};

/** Main-thread responsiveness while `fn` runs: longest gap between 10 ms timer ticks. */
async function jank(fn) {
  let last = performance.now(), worst = 0, gaps = 0;
  const long = [];
  const id = setInterval(() => {
    const t = performance.now(); const g = t - last;
    if (g > worst) worst = g;
    if (g > 100) { gaps++; long.push([Math.round(last), Math.round(t)]); }
    last = t;
  }, 10);
  const t0 = performance.now();
  const res = await fn();
  clearInterval(id);
  return { res, ms: Math.round(performance.now() - t0), worstGapMs: Math.round(worst), gapsOver100ms: gaps, long, t0: Math.round(t0) };
}

T.jank = async () => {
  const S = +(q.get('size') || 4096);
  const st = makeState({ brush: 'pencil', paper: 'sketch' });
  // like the app: the preview renderer has compiled the same programs before any export
  let warmMs = 0;
  if (q.get('warm') !== '0') {
    const t = performance.now();
    const w = new Renderer(document.createElement('canvas'));
    w.setSize(256, 256); w.setLayout(st.layout); w.setPaper(st.paper, 1); w.setStyle(st); w.setGeometry(st.geom); w.render(Infinity);
    warmMs = Math.round(performance.now() - t);
    await new Promise(r => setTimeout(r, 200));
    window.__keep = w;                       // keep it alive, as the app keeps its preview
  }
  const stats = { trace: [] };
  const j = await jank(() => exportPNG(st, { size: S, stats }));
  const trace = stats.trace.map(([t, w]) => `${t - j.t0}:${w}`).join(' ');
  const gapsRel = j.long.map(([a, b]) => `${a - j.t0}-${b - j.t0}`);
  // CompressionStream alone on 48 MB of noisy bytes, one big write
  const bytes = new Uint8Array(48 << 20);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 2654435761 >>> 29) + (i & 3);
  const k = await jank(async () => {
    const cs = new CompressionStream('deflate');
    const w = cs.writable.getWriter();
    const r = new Response(cs.readable).arrayBuffer();
    await w.write(bytes); await w.close();
    return (await r).byteLength;
  });
  delete stats.trace;
  return { ok: true, S, warmMs, exportMs: j.ms, stats, exportWorstGapMs: j.worstGapMs, exportGapsOver100: j.gapsOver100ms, gapsRel, trace, csMs: k.ms, csWorstGapMs: k.worstGapMs, csOutMB: +(k.res / 1048576).toFixed(1) };
};

T.probe = async () => {
  // Largest single WebGL drawing buffer this browser hands out (what a one-pass export would need).
  const out = [];
  for (const [w, h] of [[4096, 4096], [6144, 6144], [8192, 4096], [8192, 6144], [8192, 8192], [8192, 1024], [16384, 1024]]) {
    const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const gl = c.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
    out.push({ w, h, got: gl ? [gl.drawingBufferWidth, gl.drawingBufferHeight] : null, lost: gl ? gl.isContextLost() : null });
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    await new Promise(r => setTimeout(r, 50));
  }
  return { ok: true, out };
};     // fixture page for tests/export.drive.mjs

const which = q.get('t') || 'quick';
const t0 = performance.now();
T[which]().then(report => {
  window.__done = { ok: !!report.ok, t: which, secs: +((performance.now() - t0) / 1000).toFixed(1), report };
  log('done', JSON.stringify({ ok: report.ok }));
}).catch(e => {
  console.error(e);
  window.__done = { ok: false, t: which, error: String(e && e.stack || e), code: e?.code };
});
