// Encoder lab: encodes synthetic (and real renderer) animations with js/encoder.js, saves the
// files through the dev server and reports timings, UI responsiveness and an in-browser
// playback check. Driven by tests/encoder.test.mjs (or tests/shoot.mjs):
//   /dev/enc.html?cases=tall,square,abort,odd;engine=auto;tag=cr;secs=3;play=1
//   cases: tall 1080x1920 · square 1080x1080 · wide 1920x1080 · speed (15 s tall, synthetic)
//          real (15 s tall, WebGL spiral renderer) · abort · odd · drawerr · hidden (fake tab hide)
// Every frame carries a 16-bit barcode of its index in the top band, so a decoder can prove that
// decoded frame n is drawn frame n. Sets window.__done = { ok, probe, results }.
import { encodeVideo, probeVideo, defaultBitrate } from '../js/encoder.js';

const q = new URLSearchParams(location.search);
const engine = q.get('engine') || 'auto';
const tag = q.get('tag') || 'x';
const secs = +(q.get('secs') || 3);
const fps = +(q.get('fps') || 30);
const doPlay = q.get('play') !== '0';
// types=webm forces the WebM recorder path (what Chrome < 126 and Firefox produce)
const recorderTypes = q.get('types') === 'webm' ? ['video/webm;codecs=vp9', 'video/webm'] : undefined;
const logEl = document.getElementById('log'), bar = document.getElementById('bar');
const log = (...a) => { logEl.textContent += a.join(' ') + '\n'; };

export const PATCHES = ['#ff0000', '#00ff00', '#0000ff', '#808080', '#ffffff', '#000000', '#c43d16', '#17171a'];
export const BAR_CELLS = 20;

// ------------------------------------------------------------------ frame content
// Band: [black ref][white ref][16 bits, MSB first, black = 1][even parity][white].
function drawBarcode(ctx, W, i) {
  const bh = Math.round(W * 0.06);
  const cells = [1, 0];
  for (let b = 15; b >= 0; b--) cells.push((i >> b) & 1);
  cells.push(cells.slice(2).reduce((s, v) => s ^ v, 0), 0);
  cells.forEach((v, k) => {
    ctx.fillStyle = v ? '#000' : '#fff';
    const x0 = Math.round(k * W / BAR_CELLS), x1 = Math.round((k + 1) * W / BAR_CELLS);
    ctx.fillRect(x0, 0, x1 - x0, bh);
  });
}

/** Read the barcode from RGBA pixels (w x h); returns the frame index or -1 if unreadable. */
export function readBarcode(px, w, h) {
  const bh = Math.round(w * 0.06);
  const lum = k => {
    const x0 = Math.round((k + 0.25) * w / BAR_CELLS), x1 = Math.round((k + 0.75) * w / BAR_CELLS);
    const y0 = Math.round(bh * 0.25), y1 = Math.round(bh * 0.75);
    let s = 0, n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const o = (y * w + x) * 4;
      s += 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]; n++;
    }
    return s / n;
  };
  const black = lum(0), white = lum(1);
  if (white - black < 100) return -1;
  const mid = (black + white) / 2;
  const bits = [];
  for (let k = 2; k < 19; k++) bits.push(lum(k) < mid ? 1 : 0);
  const parity = bits.slice(0, 16).reduce((s, v) => s ^ v, 0);
  if (parity !== bits[16]) return -1;
  return bits.slice(0, 16).reduce((s, v) => s * 2 + v, 0);
}

function drawSynthetic(i, ctx, c, total) {
  const W = c.width, H = c.height, u = W / 100, t = i / fps;
  ctx.fillStyle = '#f3ecdf'; ctx.fillRect(0, 0, W, H);
  drawBarcode(ctx, W, i);
  // a spiral that grows with the frame index: thin line art like the real output
  const cx = W / 2, cy = H * 0.45, R = Math.min(W, H) * 0.36;
  const turns = 14, steps = 1400, upto = Math.max(2, Math.floor(steps * (i + 1) / total));
  ctx.strokeStyle = '#17171a'; ctx.lineWidth = Math.max(1.5, u * 0.3); ctx.lineJoin = ctx.lineCap = 'round';
  ctx.beginPath();
  for (let s = 0; s < upto; s++) {
    const f = s / steps, a = f * turns * Math.PI * 2, r = f * R;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    s ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
  // moving shapes
  ctx.fillStyle = '#c43d16';
  ctx.beginPath(); ctx.arc(cx + Math.cos(t * 2) * R * 0.8, cy + Math.sin(t * 2) * R * 0.8, 5 * u, 0, Math.PI * 2); ctx.fill();
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(t * 1.3);
  ctx.fillStyle = 'rgba(31,58,147,.85)'; ctx.fillRect(-4 * u, -4 * u, 8 * u, 8 * u); ctx.restore();
  // frame number
  ctx.fillStyle = '#17171a'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = `700 ${Math.round(13 * u)}px system-ui, sans-serif`;
  ctx.fillText(String(i), W / 2, H * 0.86 - 12 * u);
  ctx.font = `${Math.round(3.2 * u)}px system-ui, sans-serif`;
  ctx.fillText(`frame ${i} / ${total}  ·  ${t.toFixed(2)} s  ·  ${W}x${H}`, W / 2, H * 0.86 - 6 * u);
  // colour patches (fixed, for colour-fidelity checks)
  const pw = 10 * u, gap = (W - PATCHES.length * pw) / (PATCHES.length + 1), py = H - 14 * u;
  PATCHES.forEach((hex, k) => { ctx.fillStyle = hex; ctx.fillRect(gap + k * (pw + gap), py, pw, pw); });
  // progress bar
  ctx.fillStyle = '#c43d16'; ctx.fillRect(0, H - 1.2 * u, W * (i + 1) / total, 1.2 * u);
}

export function patchRects(W, H) {
  const u = W / 100, pw = 10 * u, gap = (W - PATCHES.length * pw) / (PATCHES.length + 1), py = H - 14 * u;
  return PATCHES.map((hex, k) => ({ hex, x: gap + k * (pw + gap), y: py, w: pw, h: pw }));
}

// The real engine: a spiral portrait drawn progressively by the WebGL renderer, composed into
// a tall frame the way the film composer will (paper in the middle, dark desk around).
async function spiralDrawer(W, H, total) {
  const { Renderer } = await import('../js/renderer.js');
  const { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS } = await import('../js/tone.js');
  const { buildSpiral, LINE_DEFAULTS, indexAt } = await import('../js/spiral.js');
  const { brushById, paperById, inkMode } = await import('../js/materials.js');
  const src = portrait(1024);
  const brush = brushById('fineliner'), paper = paperById('cream'), ink = brush.inks[0][0];
  const mode = inkMode(brush, ink, paper);
  const raster = rasterize(src, CROP_DEFAULTS);
  const tone = processTone(raster, TONE_DEFAULTS, { flip: mode.flip });
  const field = buildField(raster, tone.L, { rings: LINE_DEFAULTS.rings, flip: mode.flip });
  const geom = buildSpiral(field, { ...LINE_DEFAULTS }, { colorFromPhoto: false });
  const r = new Renderer(document.createElement('canvas'));
  r.setSize(W, W); r.setLayout({ cx: 0.5, cy: 0.5, r: 0.42 }); r.setPaper(paper, 1);
  r.setStyle({ brush, ink, cover: mode.cover, photoColor: false }); r.setGeometry(geom);
  const top = Math.round((H - W) / 2);
  const draw = (i, ctx, c) => {
    r.render(indexAt(geom, total > 1 ? i / (total - 1) : 1));
    ctx.fillStyle = '#2a2724'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(r.canvas, 0, top);
    drawBarcode(ctx, c.width, i);
    ctx.fillStyle = '#f3ecdf'; ctx.textAlign = 'center';
    ctx.font = `${Math.round(W * 0.045)}px system-ui, sans-serif`;
    ctx.fillText('one line', W / 2, top + W + W * 0.12);
  };
  draw.points = geom.n;
  return draw;
}

function portrait(S) {
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), u = S / 100;
  const bg = g.createLinearGradient(0, 0, 0, S); bg.addColorStop(0, '#c9ced6'); bg.addColorStop(1, '#8d939c');
  g.fillStyle = bg; g.fillRect(0, 0, S, S);
  g.fillStyle = '#2b2f3a'; g.beginPath(); g.ellipse(50 * u, 108 * u, 46 * u, 30 * u, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#b98a6e'; g.fillRect(42 * u, 62 * u, 16 * u, 18 * u);
  g.fillStyle = '#231a14'; g.beginPath(); g.ellipse(50 * u, 40 * u, 27 * u, 31 * u, 0, 0, Math.PI * 2); g.fill();
  const face = g.createRadialGradient(42 * u, 40 * u, 4 * u, 50 * u, 46 * u, 30 * u);
  face.addColorStop(0, '#f1cfb4'); face.addColorStop(0.6, '#d7a988'); face.addColorStop(1, '#8f624a');
  g.fillStyle = face; g.beginPath(); g.ellipse(50 * u, 47 * u, 20 * u, 26 * u, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#231a14'; g.beginPath(); g.ellipse(46 * u, 25 * u, 22 * u, 10 * u, -0.3, 0, Math.PI * 2); g.fill();
  for (const s of [-1, 1]) {
    g.fillStyle = '#fbf6f1'; g.beginPath(); g.ellipse((50 + s * 9) * u, 43 * u, 4.2 * u, 2.1 * u, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#3d2a1f'; g.beginPath(); g.arc((50 + s * 9) * u, 43 * u, 1.9 * u, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = '#9c4a44'; g.beginPath(); g.ellipse(50 * u, 62 * u, 6 * u, 2.2 * u, 0, 0, Math.PI * 2); g.fill();
  return c;
}

// ------------------------------------------------------------------ measurement helpers
// Main-thread responsiveness while encoding: gaps between animation frames (only meaningful
// while visible) and, where supported, long tasks.
function watchUI() {
  let last = performance.now(), maxGap = 0, frames = 0, on = true;
  const gaps = [];
  const tick = t => { if (!on) return; const g = t - last; last = t; frames++; gaps.push(g); maxGap = Math.max(maxGap, g); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  let longTasks = 0, longest = 0, po = null;
  if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) po = undefined;   // Firefox: n/a
  else try {
    po = new PerformanceObserver(l => { for (const e of l.getEntries()) { longTasks++; longest = Math.max(longest, e.duration); } });
    po.observe({ type: 'longtask', buffered: false });
  } catch { po = null; }
  return () => {
    on = false; po?.disconnect();
    gaps.sort((a, b) => a - b);
    return { rafFrames: frames, rafMaxGapMs: +maxGap.toFixed(1), rafP95GapMs: +(gaps[Math.floor(gaps.length * 0.95)] || 0).toFixed(1),
      rafMedianGapMs: +(gaps[gaps.length >> 1] || 0).toFixed(1),
      longTasks: po ? longTasks : null, longestTaskMs: po ? +longest.toFixed(0) : null };
  };
}

const once = (el, ev, ms = 15000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
  el.addEventListener(ev, e => { clearTimeout(t); res(e); }, { once: true });
  el.addEventListener('error', () => { clearTimeout(t); rej(new Error('media error ' + (el.error && el.error.code) + ' ' + (el.error && el.error.message))); }, { once: true });
});

// Decode the file in this browser's own <video>: duration, seekability, and exact frames.
async function playback(blob, frames, leadS = 0, synthetic = true, tolerance = 0) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  const url = URL.createObjectURL(blob);
  v.src = url;
  const out = { canPlay: v.canPlayType(blob.type) };
  try {
    await once(v, 'loadedmetadata');
    out.duration = +v.duration.toFixed(4);
    out.videoWidth = v.videoWidth; out.videoHeight = v.videoHeight;
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    out.seeks = [];
    for (const k of [0, Math.floor(frames / 2), frames - 1]) {
      v.currentTime = (k + 0.5) / fps + (k ? leadS : 0);
      // 'seeked' can fire before the frame is presented; wait for it where the API exists
      const shown = v.requestVideoFrameCallback ? new Promise(r => { v.requestVideoFrameCallback(() => r()); setTimeout(r, 500); }) : null;
      await once(v, 'seeked');
      if (shown) await shown;
      g.drawImage(v, 0, 0);
      const got = readBarcode(g.getImageData(0, 0, c.width, Math.round(c.width * 0.07)).data, c.width, Math.round(c.width * 0.07));
      out.seeks.push({ want: k, got });
      if (k === Math.floor(frames / 2) && synthetic) {
        // browser-decoded colour of each patch centre vs what was drawn
        out.patchErr = patchRects(c.width, c.height).map(p => {
          const d = g.getImageData(Math.round(p.x + p.w * 0.3), Math.round(p.y + p.h * 0.3), Math.round(p.w * 0.4), Math.round(p.h * 0.4)).data;
          const m = [0, 1, 2].map(ch => { let s = 0; for (let o = ch; o < d.length; o += 4) s += d[o]; return s / (d.length / 4); });
          const want = [1, 3, 5].map(o => parseInt(p.hex.slice(o, o + 2), 16));
          return Math.round(Math.max(...m.map((x, ch) => Math.abs(x - want[ch]))));
        });
      }
    }
    // tolerance: the tab-hide case holds one frame per pause by design
    out.ok = Number.isFinite(v.duration) && out.seeks.every(s => s.got >= 0 && Math.abs(s.got - s.want) <= tolerance);
  } catch (e) {
    out.ok = false; out.error = String(e.message || e);
  } finally {
    URL.revokeObjectURL(url);
  }
  return out;
}

async function save(blob, name) {
  const r = await fetch('/__file?name=' + encodeURIComponent(name), { method: 'POST', body: blob });
  return (await r.json()).file;
}

function preview(canvas) {
  const img = document.createElement('canvas');
  img.width = Math.round(canvas.width / 4); img.height = Math.round(canvas.height / 4);
  img.getContext('2d').drawImage(canvas, 0, 0, img.width, img.height);
  img.className = 'preview';
  document.body.append(img);
}

// ------------------------------------------------------------------ cases
const SIZES = { noraf: [1080, 1920], tall: [1080, 1920], square: [1080, 1080], wide: [1920, 1080], speed: [1080, 1920], real: [1080, 1920], hidden: [1080, 1080] };

async function runCase(name) {
  const res = { case: name };
  if (name === 'odd') {
    try {
      await encodeVideo({ width: 1081, height: 1920, frames: 3, drawFrame: () => {}, engine });
      return { ...res, ok: false, error: 'odd size was accepted' };
    } catch (e) { return { ...res, ok: e.code === 'unsupported', code: e.code, message: e.message }; }
  }
  if (name === 'drawerr') {
    const t0 = performance.now();
    try {
      await encodeVideo({ width: 640, height: 360, frames: 30, engine,
        drawFrame: (i, ctx, c) => { if (i === 5) throw new TypeError('boom'); drawSynthetic(i, ctx, c, 30); } });
      return { ...res, ok: false, error: 'draw error was swallowed' };
    } catch (e) { return { ...res, ok: e.code === 'encode' && /Frame 5/.test(e.message), code: e.code, message: e.message, ms: Math.round(performance.now() - t0) }; }
  }
  if (name === 'abort') {
    const ctrl = new AbortController();
    let abortedAt = 0;
    const total = 300;
    try {
      await encodeVideo({ width: 1080, height: 1920, fps, frames: total, engine, signal: ctrl.signal,
        drawFrame: (i, ctx, c) => drawSynthetic(i, ctx, c, total),
        onProgress: d => { if (d === 20 && !abortedAt) { abortedAt = performance.now(); ctrl.abort(); } } });
      return { ...res, ok: false, error: 'abort ignored' };
    } catch (e) {
      const latency = performance.now() - abortedAt;
      return { ...res, ok: e.code === 'aborted' && e.name === 'AbortError' && latency < 1500, code: e.code, name: e.name, latencyMs: Math.round(latency) };
    }
  }

  const [W, H] = SIZES[name] || SIZES.tall;
  const total = name === 'speed' || name === 'real' ? 15 * fps : Math.round(secs * fps);
  let draw = (i, ctx, c) => drawSynthetic(i, ctx, c, total);
  if (name === 'real') {
    const tb = performance.now();
    draw = await spiralDrawer(W, H, total);
    res.points = draw.points; res.buildMs = Math.round(performance.now() - tb);
    await new Promise(r => setTimeout(r, 100));   // keep the geometry build out of the UI stats
  }
  if (name === 'noraf') {
    // rAF never fires (occluded window / throttled iframe): the export must not depend on it
    const orig = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 0;
    res.restore = () => { window.requestAnimationFrame = orig; };
  }
  if (name === 'hidden') {
    // Fake a tab switch 1.0 s .. 2.5 s into the recording (headless tabs are never really hidden).
    let fake = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => fake });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (fake ? 'hidden' : 'visible') });
    const flip = v => { fake = v; document.dispatchEvent(new Event('visibilitychange')); };
    setTimeout(() => flip(true), 1000); setTimeout(() => flip(false), 2500);
  }
  const drawTimes = [];
  const timedDraw = async (i, ctx, c) => { const t = performance.now(); await draw(i, ctx, c); drawTimes.push(performance.now() - t); };
  let lastCanvas = null, progressCalls = 0, lastDone = 0, monotonic = true;
  const ui = watchUI();
  const t0 = performance.now();
  let out;
  try {
    out = await encodeVideo({ width: W, height: H, fps, frames: total, engine, drawFrame: timedDraw, recorderTypes,
      onProgress: (done, tot, canvas) => { progressCalls++; if (done < lastDone || tot !== total) monotonic = false; lastDone = done; lastCanvas = canvas; bar.style.width = (100 * done / tot) + '%'; } });
  } catch (e) {
    ui();
    return { ...res, ok: false, code: e.code, error: String(e.message || e), cause: e.cause ? String(e.cause.message || e.cause) : undefined };
  } finally {
    if (name === 'hidden') { delete document.hidden; delete document.visibilityState; }
    if (res.restore) { res.restore(); delete res.restore; }
  }
  const ms = performance.now() - t0;
  const uiStats = ui();
  drawTimes.sort((a, b) => a - b);
  const file = await save(out.blob, `enc_${tag}_${name}.${out.ext}`);
  const { blob, ...meta } = out;
  Object.assign(res, meta, uiStats, {
    ok: true, ms: Math.round(ms), encodeFps: +(total / (ms / 1000)).toFixed(1), realtimeX: +((total / fps) / (ms / 1000)).toFixed(2),
    drawMedianMs: +(drawTimes[drawTimes.length >> 1] || 0).toFixed(2), progressCalls, progressMonotonic: monotonic, lastDone,
    defaultBitrate: defaultBitrate(W, H, fps), file, blobType: blob.type,
  });
  if (lastCanvas) preview(lastCanvas);
  if (doPlay) res.playback = await playback(blob, total, (out.leadInMs || 0) / 1000, name !== 'real', name === 'hidden' ? 3 : 0);
  return res;
}

async function run() {
  const known = [...Object.keys(SIZES), 'odd', 'drawerr', 'abort'];
  const cases = (q.get('cases') || 'tall,square').split(',').filter(c => known.includes(c));
  const probe = {};
  for (const [W, H] of [[1080, 1920], [1080, 1080], [1920, 1080]]) probe[`${W}x${H}`] = await probeVideo({ width: W, height: H, fps });
  log('probe', JSON.stringify(probe));
  const results = [];
  for (const c of cases) {
    log(`— ${c} (${engine})`);
    const r = await runCase(c);
    log(JSON.stringify(r));
    results.push(r);
  }
  window.__done = { ok: results.every(r => r.ok), ua: navigator.userAgent, engine, probe, results };
}

run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
