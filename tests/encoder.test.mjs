// Encoder test: drives dev/enc.html in real browsers, then checks every produced file with
// ffprobe / ffmpeg and the raw bytes. Prints a pass/fail table; exit code 1 on any failure.
//   node tests/encoder.test.mjs                 all runs (about 5 minutes)
//   node tests/encoder.test.mjs --only chromium,firefox --fast   (skip the 15 s speed runs)
// Needs the dev server on :8830 and ffmpeg/ffprobe on PATH. Files land in shots/enc_*.
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixWebmDuration } from '../js/encoder.js';

const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'shots');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const only = opt('only', '') ? opt('only').split(',') : null;
const fast = args.includes('--fast');
const PORT = +opt('port', 8830);
const FPS = 30;
const PATCHES = ['#ff0000', '#00ff00', '#0000ff', '#808080', '#ffffff', '#000000', '#c43d16', '#17171a'];
const COLOR_TOL = 12;   // max channel error on flat patches after 4:2:0 limited-range round trip
const TRAIL_TOL = 30;   // max channel error on flat paper behind a moving dot (see trails())

const GPU_ARGS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const RUNS = [
  { id: 'chromium', browser: 'chromium', engine: 'auto', tag: 'cr', cases: 'tall,square,wide,tall60,noraf,odd,drawerr,abort,odd75,keys,flat,progthrow,sizes,hidefall' },
  { id: 'chromium-speed', browser: 'chromium', engine: 'auto', tag: 'cr', cases: 'speed,real', slow: true },
  { id: 'chromium-recorder', browser: 'chromium', engine: 'recorder', tag: 'crrec', cases: 'tall,square,hidden,hiddenstart,abort,drawerr,progthrow' },
  // Chrome's software VP9 recorder at 1080x1920 falls behind real time for a moment early on when
  // the machine is busy: 1-3 dropped frames (between 10 and 18) in 7 runs. dropTol allows 3.
  { id: 'chromium-webm', browser: 'chromium', engine: 'recorder', tag: 'crwebm', cases: 'tall', types: 'webm', dropTol: 3 },
  { id: 'edge', browser: 'chromium', channel: 'msedge', engine: 'auto', tag: 'edge', cases: 'tall,tall60,odd75' },
  { id: 'firefox', browser: 'firefox', engine: 'auto', tag: 'ff', cases: 'tall,square,tall60,noraf,odd,drawerr,abort,odd75,keys,flat,progthrow,sizes,hidefall' },
  { id: 'firefox-speed', browser: 'firefox', engine: 'auto', tag: 'ff', cases: 'speed', slow: true },
  { id: 'firefox-recorder', browser: 'firefox', engine: 'recorder', tag: 'ffrec', cases: 'tall,hidden,hiddenstart,abort' },
  { id: 'webkit', browser: 'webkit', engine: 'auto', tag: 'wk', cases: 'tall,odd,progthrow,sizes' },
];

// ------------------------------------------------------------------ browser driving
async function launch(run) {
  const L = pw[run.browser];
  const o = { headless: true };
  if (run.browser === 'chromium') o.args = GPU_ARGS;
  if (run.channel) o.channel = run.channel;
  return L.launch(o);
}

async function runPage(run) {
  let browser;
  try { browser = await launch(run); } catch (e) { return { skipped: `cannot launch: ${e.message.split('\n')[0]}` }; }
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  const q = `cases=${run.cases}&engine=${run.engine}&tag=${run.tag}` + (run.types ? `&types=${run.types}` : '');
  await page.goto(`http://localhost:${PORT}/dev/enc.html?${q}`);
  let done;
  try {
    await page.waitForFunction(() => window.__done, null, { timeout: 420000, polling: 250 });
    done = await page.evaluate(() => window.__done);
  } catch (e) { done = { ok: false, error: 'timeout: ' + e.message.split('\n')[0] }; }
  await browser.close();
  return { done, errors };
}

// Raw (unpatched) MediaRecorder WebM straight from the browser, for the Duration patch test.
async function rawWebm(run) {
  let browser;
  try { browser = await launch(run); } catch { return null; }
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/dev/enc.html?cases=none&play=0`);
  const b64 = await page.evaluate(async () => {
    const type = ['video/webm;codecs=vp9', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
    const c = document.createElement('canvas'); c.width = 320; c.height = 240;
    const g = c.getContext('2d', { alpha: false });
    const s = c.captureStream(0), tr = s.getVideoTracks()[0];
    const push = () => (tr.requestFrame ? tr.requestFrame() : s.requestFrame());
    const rec = new MediaRecorder(s, { mimeType: type });
    const parts = []; rec.ondataavailable = e => e.data.size && parts.push(e.data);
    const stopped = new Promise(r => { rec.onstop = r; });
    rec.start(250);
    for (let i = 0; i < 45; i++) {
      g.fillStyle = `rgb(${i * 5},${120},${255 - i * 5})`; g.fillRect(0, 0, 320, 240); push();
      await new Promise(r => setTimeout(r, 1000 / 30));
    }
    rec.stop(); await stopped;
    const buf = new Uint8Array(await new Blob(parts).arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  await browser.close();
  return Buffer.from(b64, 'base64');
}

// ------------------------------------------------------------------ file checks
const ff = (bin, a, o = {}) => execFileSync(bin, a, { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'], ...o });
const probeJson = (file, a) => JSON.parse(ff('ffprobe', ['-v', 'error', ...a, '-of', 'json', file]).toString());

function mp4Atoms(buf) {
  const out = [];
  for (let p = 0; p + 8 <= buf.length;) {
    let size = buf.readUInt32BE(p), hdr = 8;
    const type = buf.toString('latin1', p + 4, p + 8);
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; } else if (size === 0) size = buf.length - p;
    out.push(type);
    if (size < hdr) break;
    p += size;
  }
  return out;
}

// Walk moov -> trak -> mdia -> {mdhd, minf/stbl/stts}: every duration record in the file, in seconds.
function mp4Durations(buf) {
  const kids = (s, e) => {
    const out = {};
    for (let p = s; p + 8 <= e;) {
      const size = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
      if (size < 8) break;
      out[type] = [p, p + size];
      p += size;
    }
    return out;
  };
  const top = kids(0, buf.length);
  const moov = kids(top.moov[0] + 8, top.moov[1]);
  const full = ([s]) => ({ v: buf[s + 8], o: s + 12 });
  const u = (o, v) => (v ? Number(buf.readBigUInt64BE(o)) : buf.readUInt32BE(o));
  const mv = full(moov.mvhd), mvScale = buf.readUInt32BE(mv.o + (mv.v ? 16 : 8));
  const trak = kids(moov.trak[0] + 8, moov.trak[1]);
  const tk = full(trak.tkhd);
  const mdia = kids(trak.mdia[0] + 8, trak.mdia[1]);
  const md = full(mdia.mdhd), mdScale = buf.readUInt32BE(md.o + (md.v ? 16 : 8));
  const stbl = kids(kids(mdia.minf[0] + 8, mdia.minf[1]).stbl[0] + 8, kids(mdia.minf[0] + 8, mdia.minf[1]).stbl[1]);
  const st = stbl.stts[0] + 12, n = buf.readUInt32BE(st);
  let sum = 0;
  for (let k = 0; k < n; k++) sum += buf.readUInt32BE(st + 4 + k * 8) * buf.readUInt32BE(st + 8 + k * 8);
  const out = {
    mvhd: u(mv.o + (mv.v ? 20 : 12), mv.v) / mvScale,
    tkhd: u(tk.o + (tk.v ? 24 : 16), tk.v) / mvScale,
    mdhd: u(md.o + (md.v ? 20 : 12), md.v) / mdScale,
    stts: sum / mdScale,
  };
  // edit list (B-frame tracks): [{ length s, start s (media time shown at t = 0) }], not enumerable
  let edits = null;
  if (trak.edts) {
    const el = kids(trak.edts[0] + 8, trak.edts[1]).elst, v = buf[el[0] + 8], n = buf.readUInt32BE(el[0] + 12);
    edits = [];
    for (let k = 0, p = el[0] + 16; k < n; k++, p += v ? 20 : 12) {
      edits.push({ length: u(p, v) / mvScale, start: (v ? Number(buf.readBigInt64BE(p + 8)) : buf.readInt32BE(p + 4)) / mdScale });
    }
  }
  Object.defineProperty(out, 'edits', { value: edits });
  return out;
}

// Decode every frame's barcode (top band, 20 cells) with ffmpeg in presentation order.
function frameIds(file, W) {
  const bh = Math.round(W * 0.06);
  const raw = ff('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=${W}:${bh}:0:0,scale=200:10:flags=area`,
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  const F = 2000, ids = [];
  for (let f = 0; f + F <= raw.length; f += F) {
    const cell = k => { let s = 0; for (let y = 3; y < 7; y++) for (let x = k * 10 + 3; x < k * 10 + 7; x++) s += raw[f + y * 200 + x]; return s / 16; };
    const black = cell(0), white = cell(1), mid = (black + white) / 2;
    if (white - black < 100) { ids.push(-1); continue; }
    const bits = []; for (let k = 2; k < 19; k++) bits.push(cell(k) < mid ? 1 : 0);
    const par = bits.slice(0, 16).reduce((s, v) => s ^ v, 0);
    ids.push(par === bits[16] ? bits.slice(0, 16).reduce((s, v) => s * 2 + v, 0) : -1);
  }
  return ids;
}

function patchErrors(file, W, H, n) {
  const u = W / 100, pw2 = 10 * u, gap = (W - PATCHES.length * pw2) / (PATCHES.length + 1), py = H - 14 * u;
  const raw = ff('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n})`, '-fps_mode', 'passthrough',
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return PATCHES.map((hex, k) => {
    const x0 = Math.round(gap + k * (pw2 + gap) + pw2 * 0.3), y0 = Math.round(py + pw2 * 0.3), s = Math.round(pw2 * 0.4);
    const m = [0, 0, 0];
    for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) for (let c = 0; c < 3; c++) m[c] += raw[(y * W + x) * 3 + c];
    const want = [1, 3, 5].map(o => parseInt(hex.slice(o, o + 2), 16));
    return Math.round(Math.max(...m.map((v, c) => Math.abs(v / (s * s) - want[c]))));
  });
}

// Flat paper + one moving dot (dev/enc.js flatDot): every 6th frame, how far pixels away from the
// dot (and below the barcode band) are from the paper colour. What is there is left-over encoder
// trail: Firefox's software H.264 in 'variable' mode reached 44 levels, 'constant' + warm-up 21.
function trails(file, W, H) {
  const raw = ff('ffmpeg', ['-v', 'error', '-i', file, '-vf', "select='not(mod(n\\,6))'", '-fps_mode', 'passthrough',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const BG = [0xf3, 0xec, 0xdf], F = W * H * 3, top = Math.round(W * 0.06) + 8;
  let worst = 0, px = 0;
  for (let f = 0, i = 0; f + F <= raw.length; f += F, i += 6) {
    const cx = W / 2 + Math.cos(i / 15) * W * 0.3, cy = H / 2 + Math.sin(i / 15) * W * 0.3, r = 5 * W / 100 + 10;
    for (let y = top; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) continue;
      const o = f + (y * W + x) * 3;
      const d = Math.max(Math.abs(raw[o] - BG[0]), Math.abs(raw[o + 1] - BG[1]), Math.abs(raw[o + 2] - BG[2]));
      if (d > 4) px++;
      if (d > worst) worst = d;
    }
  }
  return { worst, px };
}

// Lowest H.264 level_idc (x10) whose MaxFS / MaxMBPS / frame-dimension limits fit (Table A-1),
// written out here on purpose rather than imported from the encoder under test.
const LEVELS = [[30, 1620, 40500], [31, 3600, 108000], [32, 5120, 216000], [40, 8192, 245760], [41, 8192, 245760],
  [42, 8704, 522240], [50, 22080, 589824], [51, 36864, 983040], [52, 36864, 2073600], [60, 139264, 4177920],
  [61, 139264, 8355840], [62, 139264, 16711680]];
function minLevel(w, h, fps) {
  const mw = Math.ceil(w / 16), mh = Math.ceil(h / 16), fs = mw * mh;
  const hit = LEVELS.find(([, maxFS, mbps]) => fs <= maxFS && fs * fps <= mbps && Math.max(mw, mh) <= Math.sqrt(8 * maxFS));
  return hit ? hit[0] : 0;
}

function checkFile(r, run) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const file = r.file;
  if (!file || !fs.existsSync(file)) { add('file saved', false, file); return checks; }
  const buf = fs.readFileSync(file);
  add('bytes match', buf.length === r.bytes, `${buf.length} B`);
  const st = probeJson(file, ['-select_streams', 'v:0', '-count_frames', '-show_entries',
    'stream=codec_name,profile,level,width,height,pix_fmt,nb_frames,nb_read_frames,r_frame_rate,has_b_frames,color_space,color_range:format=duration,format_name']);
  const s = st.streams[0] || {}, fmt = st.format || {};
  const dur = +fmt.duration;
  const lead = (r.leadInMs || 0) / 1000;
  const expectDur = r.frames / r.fps + (r.engine === 'recorder' ? lead : 0);
  add('size', s.width === r.width && s.height === r.height, `${s.width}x${s.height}`);
  // Decoding every frame must be silent: a broken avcC, bad slices or references show here.
  // (ffprobe decodes without re-muxing; 'ffmpeg -f null' would also flag its own 1/fps rounding
  // of variable-rate recorder timestamps, which is not a file problem.)
  const dec = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stderr.trim();
  add('decodes cleanly', !dec, dec ? dec.split('\n')[0].trim() : 'no decoder errors');
  add('pix_fmt yuv420p', s.pix_fmt === 'yuv420p', s.pix_fmt);
  const decoded = +s.nb_read_frames;
  if (r.engine === 'webcodecs') {
    const prof = { '64': 'High', '4D': 'Main', '42': 'Constrained Baseline' }[r.codec.slice(5, 7)];
    add('codec h264 ' + (prof || '?'), s.codec_name === 'h264' && s.profile === prof, `${s.codec_name} ${s.profile} L${s.level / 10}`);
    // The level written in the SPS must allow this frame size and macroblock rate (H.264 Table
    // A-1; a decoder may refuse a stream above its level), and the codec string must say the same.
    const lvl = minLevel(r.width, r.height, r.fps);
    add('level valid', lvl && s.level >= lvl && parseInt(r.codec.slice(9, 11), 16) === s.level,
      `stream L${s.level / 10}, needs ≥ L${lvl / 10} for ${r.width}x${r.height}@${r.fps}, codec ${r.codec}`);
    add('nb_frames', +s.nb_frames === r.frames && decoded === r.frames, `${s.nb_frames} hdr / ${decoded} decoded`);
    add('duration exact', Math.abs(dur - expectDur) < 0.0005, `${dur.toFixed(4)} s (want ${expectDur.toFixed(4)})`);
    const atoms = mp4Atoms(buf);
    add('moov before mdat', atoms.indexOf('moov') >= 0 && atoms.indexOf('moov') < atoms.indexOf('mdat'), atoms.join(' '));
    const box = mp4Durations(buf);
    add('mvhd = tkhd = mdhd = stts', Object.values(box).every(v => Math.abs(v - expectDur) < 0.0005),
      Object.entries(box).map(([k, v]) => `${k} ${v.toFixed(4)}`).join(', '));
    // B-frames: decode times start at 0 and presentation D frames later, shifted back by an edit
    // list (as ffmpeg writes x264 output); no B-frames: no edit list.
    const e = box.edits, D = r.reorderDepth;
    add('edit list', D ? e?.length === 1 && Math.abs(e[0].start - D / r.fps) < 1e-6 && Math.abs(e[0].length - expectDur) < 0.0005 : !e,
      e ? e.map(x => `show ${x.length.toFixed(4)} s from media ${(x.start * 1000).toFixed(2)} ms`).join('; ') + ` (reorder depth ${D})` : `none (reorder depth ${D})`);
    // keyframes by presentation index (with B-frames, decode order differs)
    const pk = ff('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file])
      .toString().trim().split(/\r?\n/).map(l => l.split(','));
    const keys = pk.filter(([, f]) => f.includes('K')).map(([t]) => Math.round(+t * r.fps)).sort((a, b) => a - b);
    const startPts = Math.min(...pk.map(([t]) => +t));
    add('starts at t=0', Math.abs(startPts) < 1e-6, `first pts ${startPts}` + (+s.has_b_frames ? `, B-frames (reorder depth ${r.reorderDepth})` : ', no B-frames'));
    const need = []; for (let i = 0; i < r.frames; i += 2 * r.fps) need.push(i);
    const gaps = keys.slice(1).map((k, i) => k - keys[i]);
    add('keyframe every 2 s', need.every(i => keys.includes(i)) && Math.max(0, ...gaps, r.frames - keys.at(-1)) <= 2 * r.fps,
      `keys ${keys.length > 8 ? keys.slice(0, 8).join(',') + ',…' : keys.join(',')}`);
    if (r.keyFrames) add('forced keyframes', r.keyFrames.every(i => keys.includes(i)), `asked ${r.keyFrames.join(',')}, keys ${keys.join(',')}`);
  } else {
    add('codec', /h264|vp8|vp9/.test(s.codec_name), `${s.codec_name} ${s.profile || ''} in ${fmt.format_name}`);
    // tab hide: each pause/resume holds the current frame ~1-3 slots (Firefox re-sends a frame
    // on resume, plus our repaint slot), so the file grows by up to ~0.1 s per hide
    add('duration', Number.isFinite(dur) && Math.abs(dur - expectDur) <= (r.case === 'hidden' ? 4 : 2) / r.fps, `${Number.isFinite(dur) ? dur.toFixed(3) : fmt.duration} s (want ${expectDur.toFixed(3)} = frames + ${Math.round(lead * 1000)} ms lead-in)`);
    if (r.ext === 'webm') add('webm Duration patched', r.durationPatched, `${r.durationMs} ms`);
    const atoms = r.ext === 'mp4' ? mp4Atoms(buf) : null;
    if (atoms) add('moov before mdat', atoms.indexOf('moov') >= 0 && atoms.indexOf('moov') < atoms.indexOf('mdat'), atoms.slice(0, 4).join(' ') + ' …');
  }
  // Every decoded frame carries its index: the sequence must be 0..N-1 (recorder: in order, none missing).
  const ids = frameIds(file, r.width);
  const bad = ids.filter(i => i < 0).length;
  const seen = new Set(ids.filter(i => i >= 0));
  const missing = []; for (let i = 0; i < r.frames; i++) if (!seen.has(i)) missing.push(i);
  const ordered = ids.every((v, i) => i === 0 || v >= ids[i - 1]);
  if (r.engine === 'webcodecs') {
    add('frames 0..N-1 exact', ids.length === r.frames && ids.every((v, i) => v === i), `${ids.length} decoded, ${bad} unreadable`);
  } else {
    // Real-time capture: the browser's recorder may drop a frame under load (seen: Chrome during a
    // slow hardware-encoder start, and software VP9 at 1080x1920). The timeline stays right; allow
    // up to 3 % and report them. Order must hold and nothing may be unreadable. Frames the
    // encoder skipped itself (r.dropped: drawing fell behind the wall clock on a busy machine, so
    // it jumps to the frame due now and the video keeps its length) are by design and allowed on
    // top; they are reported separately.
    const skipped = r.dropped || 0;
    const allowed = Math.max(run.dropTol || 2, Math.floor(r.frames * 0.03)) + skipped;
    add('frames in order, ≤3% dropped', missing.length <= allowed && ordered && !bad,
      `${ids.length} decoded, ${ids.length - seen.size} dup, dropped ${missing.length ? missing.length + ' (' + missing.slice(0, 6).join(',') + ')' : 'none'}` +
      (skipped ? `, ${skipped} skipped by the encoder to keep real time (${r.realtimeX}x)` : ''));
    // pacing: after the lead-in, frame times should be ~1/fps apart
    const pts = ff('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', file])
      .toString().trim().split(/\r?\n/).map(Number);
    const raw = pts.slice(1).map((t, i) => t - pts[i]);
    add('timestamps increase', raw.every(x => x > 0.004), `min step ${(Math.min(...raw) * 1000).toFixed(1)} ms`);
    const d = raw.slice(1).sort((a, b) => a - b);
    const med = d[d.length >> 1], worst = d.at(-1);
    // a tab hide holds the current frame 1-2 slots by design (see encodeRecorder)
    add('even pacing', Math.abs(med - 1 / r.fps) < 0.004 && worst < (r.case === 'hidden' ? 4 : 3 + missing.length) / r.fps, `median ${(med * 1000).toFixed(1)} ms, worst ${(worst * 1000).toFixed(0)} ms, first ${((pts[1] - pts[0]) * 1000).toFixed(0)} ms`);
  }
  if (r.case === 'hiddenstart' || r.case === 'hidefall') {
    // Started in a hidden tab, shown after shownAtMs: the export must have waited and then finished.
    add('waited for the tab, then finished', r.engine === 'recorder' && r.ms >= r.shownAtMs, `${r.engine}, ${r.ms} ms (tab shown at ${r.shownAtMs} ms)`);
    if (r.case === 'hidefall') add('fell back to the recorder', !!r.fallbackFrom, r.fallbackFrom);
  }
  if (r.case === 'flat') {
    const t = trails(file, r.width, r.height);
    add('no encoder trails', t.worst <= TRAIL_TOL, `worst ${t.worst} levels off the paper behind the dot, ${t.px} px > 4 (sampled)`);
  }
  if (r.case !== 'real' && r.case !== 'flat') {
    const mid = r.engine === 'webcodecs' ? r.frames >> 1 : ids.indexOf(r.frames >> 1);
    const errs = patchErrors(file, r.width, r.height, Math.max(0, mid));
    add('colours (ffmpeg)', Math.max(...errs) <= COLOR_TOL, `max err ${Math.max(...errs)} [${errs.join(' ')}]`);
  }
  if (r.playback) {
    const p = r.playback;
    const miss = (p.seeks || []).filter(x => x.got !== x.want);
    const seeks = !p.seeks ? '' : p.seeks.length > 3
      ? `${p.seeks.length} seeks (every frame), ${miss.length ? 'wrong: ' + miss.slice(0, 8).map(x => x.want + '→' + x.got).join(' ') : 'all exact'}`
      : `seeks ${p.seeks.map(x => x.want + '→' + x.got).join(' ')}`;
    add('plays in browser', p.ok, p.error || `dur ${p.duration} s, ${seeks}`);
    if (p.patchErr) add('colours (browser)', Math.max(...p.patchErr) <= COLOR_TOL, `max err ${Math.max(...p.patchErr)} [${p.patchErr.join(' ')}]`);
  }
  // Middle frame as PNG, to look at.
  const png = file.replace(/\.(mp4|webm)$/, '_mid.png');
  const midIdx = r.engine === 'webcodecs' ? r.frames >> 1 : Math.max(0, ids.indexOf(r.frames >> 1));
  ff('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `select=eq(n\\,${midIdx})`, '-fps_mode', 'passthrough', '-frames:v', '1', png]);
  checks.png = png;
  return checks;
}

// ------------------------------------------------------------------ main
const rows = [], failures = [], matrix = [];
const t0 = Date.now();
for (const run of RUNS) {
  if (only && !only.some(o => run.id === o || run.id.startsWith(o + '-') || run.browser === o)) continue;
  if (fast && run.slow) continue;
  process.stdout.write(`running ${run.id} … `);
  const t = Date.now();
  const { done, errors, skipped } = await runPage(run);
  console.log(skipped || `${((Date.now() - t) / 1000).toFixed(1)} s`);
  if (skipped) { rows.push([run.id, '-', '-', '-', '-', '-', 'SKIP', skipped]); continue; }
  if (!done.results) { rows.push([run.id, '-', '-', '-', '-', '-', 'FAIL', done.error]); failures.push(`${run.id}: ${done.error}`); continue; }
  const probe = done.probe['1080x1920'];
  matrix.push({ run: run.id, ua: done.ua.replace(/.*\) /, ''), webcodecs: probe.webcodecs, recorder: probe.recorder });
  for (const r of done.results) {
    let ok = r.ok, detail = '';
    const cannot = !probe.webcodecs && !probe.recorder;
    if (r.case === 'sizes') {
      // every size: a file, or 'unsupported' (never 'encode'); nothing slow to say no
      detail = r.rows.map(x => `${x.size} ${x.ok && !x.code ? `${x.engine} ${x.codec}` : x.code} ${x.ms}ms`).join(', ');
    } else if (['odd', 'drawerr', 'abort', 'progthrow'].includes(r.case)) {
      detail = r.case === 'abort' ? `code ${r.code}, stopped ${r.latencyMs} ms after abort()` : `code ${r.code}: ${r.message}`;
      if (cannot && r.case !== 'odd') { ok = r.code === 'unsupported'; detail = 'no encoder: ' + detail; }
    } else if (cannot) {
      // Nothing to encode with: the contract is a clean 'unsupported' error.
      ok = !r.ok && r.code === 'unsupported';
      detail = `expected unsupported → code ${r.code}: ${r.error}`;
    } else if (!r.ok) {
      detail = `${r.code}: ${r.error}`;
    } else {
      const checks = checkFile(r, run);
      const bad = checks.filter(c => !c.ok);
      ok = !bad.length && r.progressMonotonic && r.lastDone === r.frames;
      detail = `${checks.length} checks` + (bad.length ? ' — FAILED: ' + bad.map(c => `${c.name} (${c.detail})`).join('; ') : '');
      r.checks = checks;
      if (!(r.progressMonotonic && r.lastDone === r.frames)) detail += ' — progress callback wrong';
    }
    const size = r.width ? `${r.width}x${r.height}` : '-';
    const speed = r.encodeFps ? `${r.encodeFps} fps (${r.realtimeX}x)` : '-';
    rows.push([run.id, r.case, r.engine || '-', r.codec || '-', size, speed, ok ? 'PASS' : 'FAIL', detail]);
    if (!ok) failures.push(`${run.id}/${r.case}: ${detail}`);
    if (r.checks) for (const c of r.checks) console.log(`   ${c.ok ? 'ok  ' : 'FAIL'} ${run.id}/${r.case} ${c.name}: ${c.detail}`);
    if (r.rafMaxGapMs !== undefined) console.log(`        ui: rAF median ${r.rafMedianGapMs} ms, p95 ${r.rafP95GapMs} ms, max ${r.rafMaxGapMs} ms, long tasks ${r.longTasks ?? 'n/a'}${r.longestTaskMs ? ` (longest ${r.longestTaskMs} ms)` : ''}, draw median ${r.drawMedianMs} ms` + (r.leadInMs !== undefined ? `, lead-in ${r.leadInMs} ms` : '') + (r.acceleration ? `, ${r.acceleration}, hw ${r.hardware}, colour check ${r.colourCheck} (${r.colourCheckMs} ms) -> ${r.colourPath}${r.avcCRepaired ? ', avcC rebuilt' : ''}, per frame ${JSON.stringify(r.perFrameMs)}` : ''));
  }
  for (const e of errors) console.log(`   console error (${run.id}): ${e}`);
}

// Duration patch on raw browser WebM (Chrome VP9, Firefox VP8).
for (const run of [{ id: 'chromium', browser: 'chromium' }, { id: 'firefox', browser: 'firefox' }]) {
  if (only && !only.includes(run.id)) continue;
  const raw = await rawWebm(run);
  if (!raw) continue;
  const rawFile = path.join(SHOTS, `enc_rawwebm_${run.id}.webm`), fixFile = rawFile.replace('.webm', '_fixed.webm');
  fs.writeFileSync(rawFile, raw);
  const fixed = fixWebmDuration(new Uint8Array(raw), { frameMs: 1000 / 30 });
  fs.writeFileSync(fixFile, fixed.bytes);
  const d0 = probeJson(rawFile, ['-show_entries', 'format=duration']).format.duration;
  const d1 = +probeJson(fixFile, ['-show_entries', 'format=duration']).format.duration;
  const pts = ff('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', rawFile])
    .toString().trim().split(/\r?\n/).map(Number);
  const want = pts.at(-1) + 1 / 30;
  let decodeErr = '';
  try { ff('ffmpeg', ['-v', 'error', '-xerror', '-i', fixFile, '-f', 'null', '-']); } catch (e) { decodeErr = String(e.stderr || e.message).slice(0, 200); }
  const ok = fixed.patched && Math.abs(d1 - want) < 0.002 && !decodeErr;
  const detail = `raw duration ${d0 ?? 'N/A'} → patched ${d1.toFixed(3)} s (last frame end ${want.toFixed(3)}), +${fixed.bytes.length - raw.length} B${decodeErr ? ', decode error ' + decodeErr : ''}`;
  rows.push([`${run.id}-webm-patch`, 'raw', 'recorder', '-', '320x240', '-', ok ? 'PASS' : 'FAIL', detail]);
  if (!ok) failures.push(`${run.id}-webm-patch: ${detail}`);
  // idempotent: patching a patched file changes nothing
  const again = fixWebmDuration(fixed.bytes, { frameMs: 1000 / 30 });
  const idem = !again.patched;
  rows.push([`${run.id}-webm-patch`, 'idempotent', '-', '-', '-', '-', idem ? 'PASS' : 'FAIL', idem ? 'second patch is a no-op' : 'patched twice']);
  if (!idem) failures.push(`${run.id}-webm-patch idempotent`);
}

// ------------------------------------------------------------------ report
console.log('\nSupport matrix (1080x1920 @ 30):');
for (const m of matrix) {
  console.log(`  ${m.run.padEnd(18)} ${m.ua.padEnd(28)} webcodecs: ${m.webcodecs ? `${m.webcodecs.codec}${m.webcodecs.hardware ? ' (hw)' : ' (sw)'}` : 'none'}   recorder: ${m.recorder ? m.recorder.mimeType : 'none'}`);
}
const head = ['run', 'case', 'engine', 'codec', 'size', 'speed', 'result', 'detail'];
const w = head.map((h, i) => Math.min(i === 7 ? 200 : 40, Math.max(h.length, ...rows.map(r => String(r[i]).length))));
console.log('\n' + head.map((h, i) => h.padEnd(w[i])).join(' | '));
console.log(w.map(n => '-'.repeat(n)).join('-|-'));
for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(w[i])).join(' | '));
const pass = rows.filter(r => r[6] === 'PASS').length;
console.log(`\n${pass}/${rows.length} passed, ${rows.filter(r => r[6] === 'SKIP').length} skipped, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
if (failures.length) { console.log('\nFailures:\n  ' + failures.join('\n  ')); process.exit(1); }
