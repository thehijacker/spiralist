// Stills, vectors and sharing.
//
//   exportPNG    renders the sheet with its own Renderer, in horizontal strips for large sizes,
//                and encodes the PNG itself, in parallel workers: an 8K export never holds the
//                raw image and never freezes the page.
//   buildSVG     the line as millimetre vector paths for print shops, cutters and pen plotters.
//   sharing      download, Web Share, clipboard, file names.

import { Renderer } from './renderer.js';
import { STRIDE } from './spiral.js';
import { SHEET_MM } from './materials.js';

const DEFAULT_LAYOUT = { cx: 0.5, cy: 0.5, r: 0.42 };
const STRIP_H = 512;             // strip render height; a power of two keeps pixel-centre maths exact
const SINGLE_PASS_MAX = 2048;    // at or below this the sheet renders in one pass
const DESKTOP_CAP = 8192;
const CONSTRAINED_CAP = 4096;    // phones / tablets / low-memory devices
const PRINT_DPI = 300;
const IDAT_BYTES = 1 << 20;      // main-thread encoder: ~1 MiB IDAT chunks
const BAND_BYTES = 3 << 20;      // worker encoder: ~3 MiB of scanlines per job

function exportError(code, message) {
  const e = new Error(message);
  e.code = code;
  if (code === 'aborted') e.name = 'AbortError';
  return e;
}

const nextTask = () => new Promise(res => setTimeout(res, 0));

// ============================================================================ PNG encoding
// Functions marked [worker] are also shipped to the encoder workers as source text, so they may
// only use each other, CRC and globals.

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** [worker] CRC-32 (ISO 3309) tables for slicing-by-4: ~1 GB/s in V8. */
function makeCrcTable() {
  const t = new Uint32Array(1024);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[n];
    for (let k = 1; k < 4; k++) { c = t[c & 255] ^ (c >>> 8); t[k * 256 + n] = c; }
  }
  return t;
}
const CRC = makeCrcTable();

/** [worker] Running CRC-32: start with crc = -1, finish with (crc ^ -1) >>> 0. */
function crcUpdate(crc, buf) {
  const t = CRC, n = buf.length, n4 = n & ~3;
  let i = 0;
  for (; i < n4; i += 4) {
    crc ^= buf[i] | buf[i + 1] << 8 | buf[i + 2] << 16 | buf[i + 3] << 24;
    crc = t[768 + (crc & 255)] ^ t[512 + ((crc >>> 8) & 255)] ^ t[256 + ((crc >>> 16) & 255)] ^ t[crc >>> 24];
  }
  for (; i < n; i++) crc = t[(crc ^ buf[i]) & 255] ^ (crc >>> 8);
  return crc;
}

export function crc32(buf) { return (crcUpdate(-1, buf) ^ -1) >>> 0; }

/** Adler-32 of A followed by B, from adler(A), adler(B) and B's length (zlib's adler32_combine). */
export function adler32Combine(a1, a2, len2) {
  const BASE = 65521;
  const rem = len2 % BASE;
  let s1 = a1 & 0xffff;
  let s2 = (rem * s1) % BASE;
  s1 += (a2 & 0xffff) + BASE - 1;
  s2 += (a1 >>> 16) + (a2 >>> 16) + BASE - rem;
  if (s1 >= BASE) s1 -= BASE;
  if (s1 >= BASE) s1 -= BASE;
  if (s2 >= 2 * BASE) s2 -= 2 * BASE;
  if (s2 >= BASE) s2 -= BASE;
  return ((s2 << 16) | s1) >>> 0;
}

/**
 * [worker] PNG-filter `count` rows of RGBA8 pixels into RGB (C = 3) or RGBA (C = 4) scanlines.
 * Each row gets Sub or Up, whichever leaves the smaller sum of |residual| (libpng's heuristic).
 * bottomUp: source rows are stored last-first (gl.readPixels). prevRGBA: the image row above the
 * first one (null = zeros, as for the first row of the image).
 */
function filterRows(rgba, count, W, C, bottomUp, prevRGBA) {
  const RB = W * C, stride = W * 4;
  const out = new Uint8Array(count * (RB + 1));
  let prev = new Uint8Array(RB), cur = new Uint8Array(RB);
  const pack = (src, o, dst) => {
    if (C === 4) dst.set(src.subarray(o, o + stride));
    else for (let i = o, j = 0; j < RB; i += 4, j += 3) { dst[j] = src[i]; dst[j + 1] = src[i + 1]; dst[j + 2] = src[i + 2]; }
  };
  if (prevRGBA) pack(prevRGBA, 0, prev);
  for (let k = 0; k < count; k++) {
    pack(rgba, (bottomUp ? count - 1 - k : k) * stride, cur);
    let sSub = 0, sUp = 0;
    for (let i = 0; i < RB; i++) {
      const v = cur[i];
      const a = (v - (i >= C ? cur[i - C] : 0)) & 255;
      const b = (v - prev[i]) & 255;
      sSub += a < 128 ? a : 256 - a;
      sUp += b < 128 ? b : 256 - b;
    }
    const o = k * (RB + 1) + 1;
    if (sSub <= sUp) {
      out[o - 1] = 1;
      for (let i = 0; i < C; i++) out[o + i] = cur[i];
      for (let i = C; i < RB; i++) out[o + i] = cur[i] - cur[i - C];
    } else {
      out[o - 1] = 2;
      for (let i = 0; i < RB; i++) out[o + i] = cur[i] - prev[i];
    }
    const t = prev; prev = cur; cur = t;
  }
  return out;
}

/**
 * [worker] Canonical Huffman decode table for code lengths lens[0..n), written into `t` and
 * indexed by the next `max` stream bits (deflate packs codes LSB first, so codes are reversed).
 * Entries: symbol << 4 | length, or -1 for an unused pattern.
 */
function huffTable(lens, n, t) {
  let max = 0;
  const count = new Uint16Array(16);
  for (let i = 0; i < n; i++) { count[lens[i]]++; if (lens[i] > max) max = lens[i]; }
  count[0] = 0;
  const next = new Uint16Array(16);
  for (let b = 1, code = 0; b <= 15; b++) { code = (code + count[b - 1]) << 1; next[b] = code; }
  const size = 1 << max;
  t.fill(-1, 0, size);
  for (let s = 0; s < n; s++) {
    const L = lens[s];
    if (!L) continue;
    let c = next[L]++, r = 0;
    for (let k = 0; k < L; k++) { r = (r << 1) | (c & 1); c >>= 1; }
    for (let j = r; j < size; j += 1 << L) t[j] = (s << 4) | L;
  }
  return max;
}

/**
 * [worker] Walk a raw deflate stream block by block (decoding every symbol, producing nothing)
 * and return the bit offsets of the final block's header and of the end of its data.
 */
function deflateEnds(buf) {
  const n = buf.length;
  let ip = 0, bb = 0, bc = 0;
  const fill = () => { while (bc <= 24) { bb |= (ip < n ? buf[ip] : 0) << bc; ip++; bc += 8; } };
  const bits = k => { if (bc < k) fill(); const v = bb & ((1 << k) - 1); bb >>>= k; bc -= k; return v; };
  const LEXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DEXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  const tL = new Int32Array(1 << 15), tD = new Int32Array(1 << 15), tC = new Int32Array(1 << 7);
  const decode = (t, max) => {
    if (bc < max) fill();
    const e = t[bb & ((1 << max) - 1)];
    if (e < 0) throw new Error('deflate: bad code');
    const len = e & 15;
    bb >>>= len; bc -= len;
    return e >> 4;
  };
  const lens = new Uint8Array(320);
  for (;;) {
    const at = ip * 8 - bc;
    const final = bits(1), type = bits(2);
    if (type === 0) {
      const drop = bc & 7;
      bb >>>= drop; bc -= drop;
      const len = bits(16), nlen = bits(16);
      if ((len ^ 0xffff) !== nlen) throw new Error('deflate: bad stored block');
      ip = ((ip * 8 - bc) >> 3) + len; bb = 0; bc = 0;
    } else if (type === 1 || type === 2) {
      let hlit = 288, hdist = 30;
      lens.fill(0);
      if (type === 1) {
        for (let i = 0; i < 288; i++) lens[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
        for (let i = 0; i < 30; i++) lens[288 + i] = 5;
        hlit = 288;
      } else {
        hlit = bits(5) + 257; hdist = bits(5) + 1;
        const hclen = bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[ORDER[i]] = bits(3);
        const cmax = huffTable(cl, 19, tC);
        for (let i = 0; i < hlit + hdist;) {
          const s = decode(tC, cmax);
          if (s < 16) { lens[i < hlit ? i : 288 + i - hlit] = s; i++; continue; }
          let r, v = 0;
          if (s === 16) {
            if (!i) throw new Error('deflate: repeat with no length');
            r = 3 + bits(2);
            v = lens[i - 1 < hlit ? i - 1 : 288 + i - 1 - hlit];
          } else r = s === 17 ? 3 + bits(3) : 11 + bits(7);
          if (i + r > hlit + hdist) throw new Error('deflate: lengths overflow');
          for (; r > 0; r--, i++) lens[i < hlit ? i : 288 + i - hlit] = v;
        }
      }
      const lmax = huffTable(lens, hlit, tL);
      const dmax = huffTable(lens.subarray(288), hdist, tD);
      for (;;) {
        const sym = decode(tL, lmax);
        if (sym < 256) continue;
        if (sym === 256) break;
        const li = sym - 257;
        if (li > 28) throw new Error('deflate: bad length');
        if (LEXTRA[li]) bits(LEXTRA[li]);
        if (!dmax) throw new Error('deflate: no distance codes');
        const ds = decode(tD, dmax);
        if (ds > 29) throw new Error('deflate: bad distance');
        if (DEXTRA[ds]) bits(DEXTRA[ds]);
      }
    } else throw new Error('deflate: bad block type');
    if (final) {
      const end = ip * 8 - bc;
      if (end > n * 8) throw new Error('deflate: truncated');
      return { finalBit: at, endBit: end };
    }
    if (ip - (bc >> 3) > n) throw new Error('deflate: truncated');
  }
}

/**
 * [worker] Turn a complete raw deflate stream into a byte-aligned, non-final piece of a longer
 * one (what parallel gzip does with sync flushes): clear the final block's BFINAL bit and append
 * an empty stored block (3 header bits, byte alignment, LEN 0000 / NLEN FFFF).
 */
function syncFlushPart(raw) {
  const { finalBit, endBit } = deflateEnds(raw);
  const used = (endBit + 7) >> 3;
  if (used !== raw.length) throw new Error('deflate: unexpected trailing bytes');
  const free = used * 8 - endBit;
  const tail = free >= 3 ? [0, 0, 255, 255] : [0, 0, 0, 255, 255];
  const out = new Uint8Array(used + tail.length);
  out.set(raw);
  out.set(tail, used);
  if (endBit & 7) out[used - 1] &= (1 << (endBit & 7)) - 1;    // padding bits become the stored header
  out[finalBit >> 3] &= ~(1 << (finalBit & 7));
  return out;
}

/** [worker] One PNG IDAT chunk around `data`. */
function idatChunk(data) {
  const out = new Uint8Array(data.length + 12);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out[4] = 73; out[5] = 68; out[6] = 65; out[7] = 84;          // 'IDAT'
  out.set(data, 8);
  dv.setUint32(8 + data.length, (crcUpdate(-1, out.subarray(4, 8 + data.length)) ^ -1) >>> 0);
  return out;
}

/**
 * [worker] Encode one band of rows: filter, deflate at CompressionStream's full quality, strip
 * the zlib wrapper (keeping its Adler-32) and make the piece concatenable.
 * -> { chunk: IDAT chunk bytes, adler: Adler-32 of the band's scanlines, len: their byte count }
 */
async function encodeBand({ px, prev, W, rows, C, bottomUp }) {
  if (!(rows > 0) || !(W > 0) || px.byteLength < rows * W * 4 || (prev && prev.byteLength < W * 4)) {
    throw new Error('encodeBand: pixel buffer does not match the band size');
  }
  const lines = filterRows(new Uint8Array(px), rows, W, C, bottomUp, prev ? new Uint8Array(prev) : null);
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(lines).catch(() => {});
  writer.close().catch(() => {});
  const z = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  if ((z[0] & 15) !== 8 || (z[1] & 32)) throw new Error('deflate: unexpected zlib header');
  const n = z.length;
  const adler = ((z[n - 4] << 24) | (z[n - 3] << 16) | (z[n - 2] << 8) | z[n - 1]) >>> 0;
  return { chunk: idatChunk(syncFlushPart(z.subarray(2, n - 4))), adler, len: lines.length };
}

const WORKER_SOURCE = () => [makeCrcTable, crcUpdate, filterRows, huffTable, deflateEnds, syncFlushPart, idatChunk, encodeBand]
  .map(f => f.toString()).join('\n') + `
const CRC = makeCrcTable();
self.onmessage = async e => {
  const id = e.data.id;
  try {
    const r = await encodeBand(e.data);
    self.postMessage({ id, chunk: r.chunk, adler: r.adler, len: r.len }, [r.chunk.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
`;

const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0) & 255);

/** One PNG chunk (length, type, data..., CRC over type + data) from one or more data parts. */
function pngChunk(type, parts, total) {
  if (!Array.isArray(parts)) parts = [parts];
  if (total === undefined) total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(12 + total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, total);
  out.set(ascii(type), 4);
  let o = 8;
  for (const p of parts) { out.set(p, o); o += p.length; }
  dv.setUint32(8 + total, crc32(out.subarray(4, 8 + total)));
  return out;
}

function physData(dpi) {
  const ppm = Math.round(dpi / 0.0254);     // 300 dpi -> 11811 px/m
  const d = new Uint8Array(9), dv = new DataView(d.buffer);
  dv.setUint32(0, ppm); dv.setUint32(4, ppm); d[8] = 1;   // unit: metre
  return d;
}

/** Signature + header chunks: IHDR (8-bit RGB or RGBA), sRGB, pHYs 300 dpi, tEXt Software. */
function pngHead(width, height, alpha, dpi = PRINT_DPI) {
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;          // bit depth, colour type; compression/filter/interlace 0
  return [
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('sRGB', new Uint8Array([0])),        // the renderer works in sRGB (perceptual intent)
    pngChunk('pHYs', physData(dpi)),
    pngChunk('tEXt', ascii('Software\0Spiralist')),
  ];
}

/**
 * Assembles bands encoded anywhere (workers, or encodeBand on this thread) into one PNG:
 * zlib header, the bands' sync-flushed deflate pieces in order, a final empty stored block and
 * the Adler-32 of all scanlines combined from the bands'.
 */
export class PNGAssembler {
  constructor(width, height, { alpha = false, dpi = PRINT_DPI } = {}) {
    this.parts = [...pngHead(width, height, alpha, dpi), pngChunk('IDAT', new Uint8Array([0x78, 0x9c]))];
    this.bands = [];
    this.expected = height * (width * (alpha ? 4 : 3) + 1);
  }
  set(index, band) { this.bands[index] = band; }
  finish() {
    let adler = 1, len = 0;
    for (let i = 0; i < this.bands.length; i++) {
      const b = this.bands[i];
      if (!b) throw exportError('encode', `PNG band ${i} is missing`);
      this.parts.push(b.chunk);
      adler = adler32Combine(adler, b.adler, b.len);
      len += b.len;
    }
    if (len !== this.expected) throw exportError('encode', `PNG has ${len} of ${this.expected} scanline bytes`);
    const tail = new Uint8Array(9);
    tail.set([1, 0, 0, 255, 255]);                    // final empty stored block
    new DataView(tail.buffer).setUint32(5, adler);
    this.parts.push(pngChunk('IDAT', tail), pngChunk('IEND', new Uint8Array(0)));
    const blob = new Blob(this.parts, { type: 'image/png' });
    this.parts = this.bands = null;
    return blob;
  }
}

/** Pool of encoder workers (blob-URL module-free scripts); jobs are queued in order. */
class BandPool {
  constructor(size) {
    this.url = URL.createObjectURL(new Blob([WORKER_SOURCE()], { type: 'text/javascript' }));
    this.size = size;
    this.idle = []; this.all = []; this.queue = []; this.jobs = new Map(); this.seq = 0; this.error = null;
    for (let i = 0; i < size; i++) {
      const w = new Worker(this.url);
      w.onmessage = e => this._done(w, e.data);
      w.onerror = e => { e.preventDefault?.(); this._fail(exportError('worker', 'PNG worker failed: ' + (e.message || 'load error'))); };
      this.all.push(w); this.idle.push(w);
    }
  }
  run(msg, transfer) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.jobs.set(id, { resolve, reject });
      this.queue.push({ msg: { ...msg, id }, transfer });
      this._pump();
    });
  }
  _pump() {
    while (this.idle.length && this.queue.length) {
      const { msg, transfer } = this.queue.shift();
      this.idle.pop().postMessage(msg, transfer);
    }
  }
  _done(w, data) {
    const job = this.jobs.get(data.id);
    this.jobs.delete(data.id);
    this.idle.push(w);
    this._pump();
    if (!job) return;
    if (data.error) job.reject(exportError('worker', data.error));
    else job.resolve(data);
  }
  _fail(err) {
    this.error = this.error || err;
    for (const j of this.jobs.values()) j.reject(this.error);
    this.jobs.clear();
    this.queue = [];
  }
  terminate(err) {
    for (const w of this.all) w.terminate();
    this.all = []; this.idle = [];
    URL.revokeObjectURL(this.url);
    this._fail(err || exportError('aborted', 'Export cancelled'));
  }
}

function workerCount() {
  const cores = globalThis.navigator?.hardwareConcurrency || 4;
  return Math.max(1, Math.min(cores - 1, constrainedDevice() ? 2 : 6));
}

function workersUsable() {
  return typeof Worker !== 'undefined' && typeof CompressionStream !== 'undefined' && typeof Blob !== 'undefined' &&
    typeof URL?.createObjectURL === 'function';
}

/**
 * Streaming PNG writer on the calling thread (fallback when workers are unavailable, and for
 * tests): same filtering, CompressionStream('deflate') as one zlib stream.
 */
export class PNGEncoder {
  constructor(width, height, { alpha = false, dpi = PRINT_DPI } = {}) {
    if (typeof CompressionStream === 'undefined') throw exportError('unsupported', 'CompressionStream is not available');
    this.width = width; this.height = height;
    this.channels = alpha ? 4 : 3;
    this.last = null;                               // RGBA of the previous image row
    this.rows = 0;
    this.parts = pngHead(width, height, alpha, dpi);
    const cs = new CompressionStream('deflate');
    this.writer = cs.writable.getWriter();
    this.pump = this._collect(cs.readable.getReader());
    this.pump.catch(() => {});                      // surfaced by finish()
  }

  async _collect(reader) {
    let pend = [], bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pend.push(value); bytes += value.length;
      if (bytes >= IDAT_BYTES) { this.parts.push(pngChunk('IDAT', pend, bytes)); pend = []; bytes = 0; }
    }
    if (bytes) this.parts.push(pngChunk('IDAT', pend, bytes));
  }

  /** Append `count` RGBA8 rows (bottomUp: stored last-first, as gl.readPixels returns them). */
  async addRows(rgba, count, bottomUp = false) {
    const W = this.width, stride = W * 4;
    if (this.rows + count > this.height) throw exportError('encode', 'too many rows');
    const lines = filterRows(rgba, count, W, this.channels, bottomUp, this.last);
    const lastRow = bottomUp ? 0 : count - 1;
    this.last = rgba.slice(lastRow * stride, lastRow * stride + stride);
    this.rows += count;
    await this.writer.write(lines);
  }

  async finish() {
    if (this.rows !== this.height) throw exportError('encode', `PNG has ${this.rows} of ${this.height} rows`);
    await this.writer.close();
    await this.pump;
    this.parts.push(pngChunk('IEND', new Uint8Array(0)));
    const blob = new Blob(this.parts, { type: 'image/png' });
    this.parts = null;
    return blob;
  }

  abort() { this.writer.abort().catch(() => {}); }
}

/** Insert pHYs (print resolution) after IHDR of a PNG produced elsewhere (canvas.toBlob). */
async function withPhys(blob, dpi = PRINT_DPI) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  const ihdrEnd = 8 + 12 + dv.getUint32(8);
  for (let o = 8; o + 8 <= buf.length;) {
    const len = dv.getUint32(o), type = String.fromCharCode(...buf.subarray(o + 4, o + 8));
    if (type === 'pHYs') return blob;
    if (type === 'IDAT' || type === 'IEND') break;
    o += 12 + len;
  }
  return new Blob([buf.subarray(0, ihdrEnd), pngChunk('pHYs', physData(dpi)), buf.subarray(ihdrEnd)], { type: 'image/png' });
}

/** Last resort without CompressionStream: assemble strips on a 2D canvas and let it encode. */
class CanvasPNG {
  constructor(width, height) {
    this.canvas = makeCanvas(width, height);
    this.ctx = this.canvas.getContext('2d');
    this.width = width;
    this.y = 0;
  }
  async addRows(rgba, count, bottomUp = false) {
    const W = this.width, stride = W * 4;
    const img = this.ctx.createImageData(W, count);
    for (let k = 0; k < count; k++) {
      const src = (bottomUp ? count - 1 - k : k) * stride;
      img.data.set(rgba.subarray(src, src + stride), k * stride);
    }
    this.ctx.putImageData(img, 0, this.y);     // straight alpha in, as ImageData expects
    this.y += count;
  }
  async finish() {
    const c = this.canvas;
    const blob = c.convertToBlob ? await c.convertToBlob({ type: 'image/png' })
      : await new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(exportError('encode', 'toBlob failed'))), 'image/png'));
    c.width = c.height = 1;
    return withPhys(blob);
  }
  abort() { this.canvas.width = this.canvas.height = 1; }
}

function makeCanvas(w = 1, h = 1) {
  if (typeof document !== 'undefined') return Object.assign(document.createElement('canvas'), { width: w, height: h });
  return new OffscreenCanvas(w, h);
}

// ============================================================================ PNG export
/** Widest stroke half-width in circle units, from the geometry itself (covers any source). */
function maxHalfWidth(geom) {
  if (!geom) return 0;
  let m = 0;
  const d = geom.data;
  for (let i = 2; i < d.length; i += STRIDE) if (d[i] > m) m = d[i];
  return m / 2;
}

/**
 * Rows a strip must render beyond the rows it keeps, so that every kept pixel sees exactly what
 * a single full-sheet pass would. Stroke pixels only depend on their own position; the glow
 * blur is the only neighbourhood operation (4x4 downsample + two separable 5-tap passes), but we
 * keep the spec's conservative bound: stroke half-width x spread + glow reach + 4 px.
 */
function haloPx(state, S) {
  const r = (state.layout || DEFAULT_LAYOUT).r;
  const brush = state.brush || {};
  const stroke = (maxHalfWidth(state.geom) * r * S) * (brush.spread || 1) + 1.5;
  let glow = 0;
  if (brush.glow) {
    const reach = radiusU => 3.2308 * Math.max(0.6, radiusU * S / 4000) / 3.2 + 1;  // quarter texels per pass
    glow = 4 * (reach(brush.glow.tight ?? 2.0) + reach(brush.glow.wide ?? 6.0)) + 4;
  }
  return Math.ceil(stroke + glow + 4);
}

const up4 = v => Math.ceil(v / 4) * 4;

/**
 * Render `state` (see SPEC "Render state") to a PNG Blob of size x size pixels.
 *   transparent  ink only on a transparent sheet (straight alpha, RGBA); otherwise RGB with paper
 *   onProgress   (fraction 0..1, rowsDone, rowsTotal)
 *   signal       AbortSignal; rejects with an Error { code: 'aborted', name: 'AbortError' }
 * Dev knobs: strip (force strip rendering, this render height), encoder: 'auto' | 'workers' |
 * 'png' (this thread) | 'canvas', workers (pool size), stats (filled with timings).
 * Errors carry .code: 'aborted' | 'lost' | 'unsupported' | 'encode'.
 */
export async function exportPNG(state, opts = {}) {
  if (opts.signal?.aborted) throw exportError('aborted', 'Export cancelled');
  const encoder = opts.encoder || 'auto';
  let mode = encoder;
  if (mode === 'auto') mode = workersUsable() ? 'workers' : typeof CompressionStream !== 'undefined' ? 'png' : 'canvas';
  try {
    return await renderAndEncode(state, opts, mode);
  } catch (e) {
    // Workers that cannot start (a strict CSP, an old engine) must not cost the user the export.
    if (encoder === 'auto' && mode === 'workers' && e.code === 'worker') {
      console.warn('Spiralist: PNG workers unavailable, encoding on the main thread.', e.message);
      return renderAndEncode(state, opts, typeof CompressionStream !== 'undefined' ? 'png' : 'canvas');
    }
    throw e;
  }
}

async function renderAndEncode(state, { size, transparent = false, onProgress, signal, strip, workers, stats } = {}, mode) {
  const mark = stats?.trace ? what => stats.trace.push([Math.round(performance.now()), what]) : () => {};
  mark('start');
  const canvas = makeCanvas();
  let r;
  try { r = new Renderer(canvas); }
  catch (e) { throw exportError('unsupported', e.message || 'WebGL2 is not available'); }
  let pool = null, enc = null;
  const onAbort = () => pool?.terminate(exportError('aborted', 'Export cancelled'));
  signal?.addEventListener('abort', onAbort);
  try {
    const S = Math.max(16, Math.min(r.maxSize, Math.round(size) || 1024));
    const strips = !!strip || S > SINGLE_PASS_MAX;
    // Strips render H rows and keep the middle `core`. H is a power of two so every pixel centre's
    // paper position (and the dither hashed from it) is computed exactly as in a single pass, and
    // origins stay multiples of 4 so the quarter-res glow grid lines up with the full sheet's.
    const margin = strips ? up4(haloPx(state, S)) : 0;
    let H = S;
    if (strips) {
      H = 2 ** Math.round(Math.log2(Math.max(64, strip || STRIP_H)));
      while (H - 2 * margin < H / 4) H *= 2;       // wide halos: taller strips, not thin slivers
    }
    const core = strips ? H - 2 * margin : S;

    r.setPaperSize(S, S);
    r.setSize(S, H);
    const gl = r.gl;
    // Browsers may silently hand back a smaller drawing buffer than the canvas asks for
    // (Chrome caps a whole 8192^2 sheet at 5760^2), which is why big sheets go in strips.
    if (r.canvas.width !== S || r.canvas.height !== H || gl.drawingBufferWidth !== S || gl.drawingBufferHeight !== H) {
      throw exportError('unsupported', `cannot allocate a ${S} x ${H} render target`);
    }
    mark('renderer');
    r.setLayout(state.layout || DEFAULT_LAYOUT);
    r.setPaper(state.paper, state.seed ?? 1);
    r.setStyle(state);
    r.setTransparent(transparent);
    // Realistic mode: the paper keeps its real millimetre grain on a big sheet, under the chosen
    // light (both absent in Artistic mode: today's virtual sheet and window light)
    if (state.sheetMm && typeof r.setSheetMm === 'function') r.setSheetMm(state.sheetMm);
    if (state.light) r.setLight(state.light);
    if (state.geom) r.setGeometry(state.geom);
    mark('setup');

    const C = transparent ? 4 : 3;
    const stride = S * 4;
    let asm = null, bandRows = 0, band = 0, prevRow = null, rowsDone = 0, waited = 0;
    let inFlight = 0, peakInFlight = 0, outBytes = 0;     // pixel bytes handed to workers, PNG bytes back
    const pending = [];
    if (mode === 'workers') {
      try { pool = new BandPool(workers || workerCount()); }
      catch (e) { throw exportError('worker', 'PNG workers cannot start: ' + (e.message || e)); }
      asm = new PNGAssembler(S, S, { alpha: transparent });
      bandRows = Math.max(16, Math.min(core, Math.floor(BAND_BYTES / (S * C + 1))));
    } else {
      enc = mode === 'canvas' ? new CanvasPNG(S, S) : new PNGEncoder(S, S, { alpha: transparent });
    }
    const shared = mode === 'workers' ? null : new Uint8Array(S * core * 4);
    let renderMs = 0, encodeMs = 0, count = 0;

    for (let y0 = 0; y0 < S; y0 += core) {
      if (signal?.aborted) throw exportError('aborted', 'Export cancelled');
      const t0 = performance.now();
      const rows = Math.min(core, S - y0);
      r.setOrigin(0, y0 - margin);
      if (!r.render(Infinity) || gl.isContextLost()) throw exportError('lost', 'The graphics context was lost during export');
      // GL rows are bottom-up: kept target rows [margin, margin + rows) sit at GL y = H - margin - rows.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
      const px = shared ? shared.subarray(0, S * rows * 4) : new Uint8Array(S * rows * 4);
      gl.readPixels(0, H - margin - rows, S, rows, gl.RGBA, gl.UNSIGNED_BYTE, px);
      if (gl.isContextLost()) throw exportError('lost', 'The graphics context was lost during export');
      const t1 = performance.now();
      renderMs += t1 - t0; count++;
      mark('strip ' + count);

      if (pool) {
        // Bands of this strip, top to bottom. Paper rows [a, b) of the strip are buffer rows
        // [rows - b, rows - a) (bottom-up); the row above a band seeds its Up filter.
        for (let a = 0; a < rows; a += bandRows) {
          const b = Math.min(rows, a + bandRows), n = b - a;
          const slice = px.slice((rows - b) * stride, (rows - a) * stride);
          const above = a === 0 ? prevRow : px.slice((rows - a) * stride, (rows - a + 1) * stride);
          const index = band++;
          const bytes = slice.byteLength + (above ? above.byteLength : 0);
          inFlight += bytes; peakInFlight = Math.max(peakInFlight, inFlight);
          const job = pool.run({ px: slice.buffer, prev: above ? above.buffer : null, W: S, rows: n, C, bottomUp: true },
            above ? [slice.buffer, above.buffer] : [slice.buffer]).then(res => {
            asm.set(index, res);
            inFlight -= bytes; outBytes += res.chunk.byteLength;
            rowsDone += n;
            onProgress?.(rowsDone / S, rowsDone, S);
          });
          job.catch(() => {});
          pending.push(job);
        }
        prevRow = px.slice(0, stride);                // this strip's last paper row
        // Keep at most two bands per worker waiting, so memory stays bounded at 8K.
        while (pending.length - waited > pool.size * 2) await pending[waited++];
      } else {
        await enc.addRows(px, rows, true);
        encodeMs += performance.now() - t1;
        onProgress?.((y0 + rows) / S, y0 + rows, S);
      }
      if (y0 + rows < S) await nextTask();       // let the page paint progress between strips
    }
    r.destroy();                                  // free the GPU while the last bands encode
    mark('rendered');
    const t2 = performance.now();
    let blob;
    if (pool) {
      await Promise.all(pending);
      mark('bands');
      if (signal?.aborted) throw exportError('aborted', 'Export cancelled');
      blob = asm.finish();
      mark('blob');
    } else {
      blob = await enc.finish();
      enc = null;
    }
    if (stats) {
      Object.assign(stats, { size: S, core, margin, strips: count, mode, renderMs,
        encodeMs: encodeMs + performance.now() - t2, workers: pool?.size || 0, bands: band,
        stripMB: S * H * 4 / 1048576, peakInFlightMB: peakInFlight / 1048576, outMB: outBytes / 1048576 });
    }
    return blob;
  } catch (e) {
    enc?.abort();
    if (signal?.aborted) throw exportError('aborted', 'Export cancelled');
    if (e.code) throw e;
    throw exportError('encode', e.message || String(e));
  } finally {
    signal?.removeEventListener('abort', onAbort);
    pool?.terminate();
    r.destroy();
    canvas.width = canvas.height = 1;
  }
}

// ============================================================================ size limits
let maxSizeCache = 0;

/** True on phones/tablets and low-memory devices, where one big canvas can kill the tab. */
function constrainedDevice() {
  const nav = globalThis.navigator;
  if (!nav) return false;
  if (nav.userAgentData?.mobile) return true;
  const ua = nav.userAgent || '';
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)) return true;
  if (/Macintosh/.test(ua) && nav.maxTouchPoints > 1) return true;    // iPadOS asks for desktop sites
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory < 4) return true;
  return false;
}

/** Largest safe square export on this device, px. */
export function maxExportSize() {
  if (maxSizeCache) return maxSizeCache;
  let gpu = CONSTRAINED_CAP;
  try {
    const gl = makeCanvas().getContext('webgl2');
    if (gl) {
      const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
      gpu = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), vp[0], vp[1]);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { /* keep the conservative default */ }
  // Without CompressionStream the fallback assembles the whole sheet on one 2D canvas.
  const cap = constrainedDevice() || typeof CompressionStream === 'undefined' ? CONSTRAINED_CAP : DESKTOP_CAP;
  maxSizeCache = Math.max(1024, Math.min(gpu, cap));
  return maxSizeCache;
}

// ============================================================================ SVG
// 1 user unit = 1 mm. Coordinates are quantised to 0.01 mm and written as relative moves between
// quantised absolute positions, so rounding never accumulates along a path of 100k+ nodes.
const Q = 100;               // quanta per mm
const RDP_EPS = 0.02;        // mm
const RDP_WINDOW = 256;      // points per Douglas-Peucker window (bounds the worst case on spirals)

function fmtQ(q) {
  if (q === 0) return '0';
  const neg = q < 0;
  if (neg) q = -q;
  const i = Math.floor(q / Q), f = q - i * Q;
  let s;
  if (!f) s = String(i);
  else s = (i ? String(i) : '') + '.' + (f < 10 ? '0' + f : f % 10 ? String(f) : String(f / 10));
  return neg ? '-' + s : s;
}
// A number needs a separator before it unless it starts with '-'.
const sp = q => (q < 0 ? '' : ' ');

/** Path data writer: one absolute M, then relative l (implicitly repeated) and a commands. */
class PathWriter {
  constructor() {
    this.out = [];
    this.qx = 0; this.qy = 0;      // current point, quantised
    this.inL = false;              // inside an 'l' run: further pairs repeat it implicitly
    this.fresh = false;            // last thing written was a line break
    this.nodes = 0;
  }
  _emit(s) {
    this.out.push(s);
    this.fresh = false;
    if (++this.nodes % 48 === 0) { this.out.push('\n'); this.fresh = true; }
  }
  move(x, y) {
    this.qx = Math.round(x * Q); this.qy = Math.round(y * Q);
    this._emit('M' + fmtQ(this.qx) + ' ' + fmtQ(this.qy));
    this.inL = false;
  }
  lineTo(x, y) {
    const nx = Math.round(x * Q), ny = Math.round(y * Q);
    const dx = nx - this.qx, dy = ny - this.qy;
    if (!dx && !dy) return false;
    const head = !this.inL ? 'l' : this.fresh ? '' : sp(dx);
    this.qx = nx; this.qy = ny; this.inL = true;
    this._emit(head + fmtQ(dx) + sp(dy) + fmtQ(dy));
    return true;
  }
  /**
   * Half-circle cap to (x, y); sweep 0/1. The radius written is at most half the quantised
   * chord, so SVG's out-of-range rule scales it to exactly a semicircle on that chord (a radius
   * rounded above half the chord would select the shallow minor arc instead).
   */
  capTo(x, y, sweep) {
    const nx = Math.round(x * Q), ny = Math.round(y * Q);
    const dx = nx - this.qx, dy = ny - this.qy;
    if (!dx && !dy) return false;
    const rq = Math.max(1, Math.floor(Math.hypot(dx, dy) / 2));
    this.qx = nx; this.qy = ny; this.inL = false;
    this._emit('a' + fmtQ(rq) + ' ' + fmtQ(rq) + ' 0 0 ' + sweep + ' ' + fmtQ(dx) + sp(dy) + fmtQ(dy));
    return true;
  }
  close() { this.out.push('z'); this.inL = false; }
  toString() { return this.out.join(''); }
}

/** Douglas-Peucker in fixed windows; returns the kept indices (always first and last). */
export function simplifyIndices(X, Y, eps = RDP_EPS, win = RDP_WINDOW) {
  const n = X.length;
  if (n <= 2) return Uint32Array.from({ length: n }, (_, i) => i);
  const keep = new Uint8Array(n);
  const eps2 = eps * eps;
  const stack = [];
  for (let a0 = 0; a0 < n - 1; a0 += win) {
    const b0 = Math.min(n - 1, a0 + win);
    keep[a0] = 1; keep[b0] = 1;
    stack.push(a0, b0);
    while (stack.length) {
      const b = stack.pop(), a = stack.pop();
      if (b - a < 2) continue;
      const ax = X[a], ay = Y[a], dx = X[b] - ax, dy = Y[b] - ay, L2 = dx * dx + dy * dy;
      let best = -1, bi = -1;
      for (let i = a + 1; i < b; i++) {
        const px = X[i] - ax, py = Y[i] - ay;
        let t = L2 > 0 ? (px * dx + py * dy) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - t * dx, ey = py - t * dy, d2 = ex * ex + ey * ey;
        if (d2 > best) { best = d2; bi = i; }
      }
      if (best > eps2) { keep[bi] = 1; stack.push(a, bi, bi, b); }
    }
  }
  let m = 0;
  for (let i = 0; i < n; i++) m += keep[i];
  const idx = new Uint32Array(m);
  for (let i = 0, k = 0; i < n; i++) if (keep[i]) idx[k++] = i;
  return idx;
}

/** Geometry -> millimetre arrays (float64) + unit normals from central differences. */
function toMillimetres(geom, sizeMm, layout) {
  const { n, data } = geom;
  const R = layout.r * sizeMm, cx = layout.cx * sizeMm, cy = layout.cy * sizeMm;
  const X = new Float64Array(n), Y = new Float64Array(n), W = new Float64Array(n);
  for (let i = 0, o = 0; i < n; i++, o += STRIDE) {
    X[i] = cx + data[o] * R; Y[i] = cy + data[o + 1] * R; W[i] = Math.max(0, data[o + 2] * R);
  }
  const NX = new Float64Array(n), NY = new Float64Array(n);
  let lx = 0, ly = -1;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const tx = X[b] - X[a], ty = Y[b] - Y[a], L = Math.hypot(tx, ty);
    if (L > 1e-12) { lx = -ty / L; ly = tx / L; }
    NX[i] = lx; NY[i] = ly;
  }
  return { n, X, Y, W, NX, NY, R };
}

function polylineD(X, Y, idx) {
  const p = new PathWriter();
  p.move(X[idx[0]], Y[idx[0]]);
  for (let k = 1; k < idx.length; k++) p.lineTo(X[idx[k]], Y[idx[k]]);
  if (p.nodes === 1) p.lineTo(X[idx[0]] + 0.01, Y[idx[0]]);   // keep a visible dot
  return p;
}

const JOIN_TOL = 0.005;      // mm: joins / disc bulges whose one-point offset would be off by more get arcs

/**
 * Filled outline of the renderer's line. FRAG_STROKE draws each segment as a trapezoid (width
 * interpolated along it) with a half disc at each end, so at every inner vertex i the union
 * holds a disc of radius h = w/2: the front half of segment i-1's cap plus the back half of
 * segment i's. Each side of the outline is a chain of the trapezoid edges; at each vertex it
 * adds the part of that disc that sticks out:
 *   - on the outer side of a turn: the round join;
 *   - on a taper: the disc bulges past the straight edge to a thinner neighbour. The incoming
 *     edge enters the disc 2*phi before its end (phi = the edge's slope against the centreline)
 *     and the outgoing edge leaves it 2*phi after its start (inscribed-angle theorem), so the
 *     envelope is: incoming edge up to Y, arc Y -> X, outgoing edge from X ("trim form");
 *   - where that cannot be trimmed exactly (inner side of a turn, or a hard tone edge where a
 *     disc swallows its neighbour's whole edge) the side runs out along the disc and back
 *     through the pivot ("spoke form"). Every piece is then a positively wound part of a
 *     trapezoid or a disc sector, so 'nonzero' fills exactly their union, overlaps included.
 * Gentle vertices (almost all of a smooth spiral) keep a single bisector point.
 * Repeated points are one vertex: the shader draws a zero-length segment as a full disc of its
 * first point's width, and the caps either side may have other widths.
 */
function outlineD(m) {
  const { n, X, Y, W } = m;
  // vertices = runs of coincident points: position, cap radius of the incoming segment (hIn),
  // of the outgoing one (hOut), and the full disc drawn by zero-length segments (hD, 0 if none)
  const PX = [], PY = [], hIn = [], hOut = [], hD = [], multi = [];
  for (let i = 0; i < n;) {
    let j = i, d = 0;
    while (j + 1 < n && Math.hypot(X[j + 1] - X[i], Y[j + 1] - Y[i]) < 1e-6) { d = Math.max(d, W[j] / 2); j++; }
    PX.push(X[i]); PY.push(Y[i]); hIn.push(W[i] / 2); hOut.push(W[j] / 2); hD.push(d); multi.push(j > i);
    i = j + 1;
  }
  const V = PX.length;
  // segment r joins vertex r to r + 1: unit normal (-t.y, t.x) and length
  const SX = new Float64Array(Math.max(1, V - 1)), SY = new Float64Array(Math.max(1, V - 1));
  const SL = new Float64Array(Math.max(1, V - 1));
  for (let r = 0; r < V - 1; r++) {
    const dx = PX[r + 1] - PX[r], dy = PY[r + 1] - PY[r], L = Math.hypot(dx, dy);
    SX[r] = -dy / L; SY[r] = dx / L; SL[r] = L;
  }
  if (V === 1) { SX[0] = 0; SY[0] = -1; }            // a lone dot: the caps make its circle
  const HALF_PI = Math.PI / 2;
  // Per inner vertex: turn, taper slopes (> 0 where the neighbour is thinner, so this disc bulges
  // past that edge), whether one offset point is enough, and whether the disc swallows a whole
  // edge (a chord longer than the edge: hard tone edges). The same for both sides.
  const TH = new Float64Array(V), PIN = new Float64Array(V), POUT = new Float64Array(V);
  const GENTLE = new Uint8Array(V), SWI = new Uint8Array(V), SWO = new Uint8Array(V);
  for (let r = 1; r < V - 1; r++) {
    const th = Math.atan2(SX[r - 1] * SY[r] - SY[r - 1] * SX[r], SX[r - 1] * SX[r] + SY[r - 1] * SY[r]);
    TH[r] = th;                                      // coincident runs need the turn too
    if (multi[r]) continue;
    const h = hIn[r], dIn = h - hOut[r - 1], dOut = h - hIn[r + 1];
    const pin = Math.max(0, Math.atan2(dIn, SL[r - 1])), pout = Math.max(0, Math.atan2(dOut, SL[r]));
    PIN[r] = pin; POUT[r] = pout;
    // A bisector point sits h|th|/2 along the disc from each edge's true end; on a steep edge
    // (either way) that tilts the edge by as much times the sine of its slope.
    const steep = Math.max(Math.abs(dIn) / Math.hypot(SL[r - 1], dIn), Math.abs(dOut) / Math.hypot(SL[r], dOut));
    GENTLE[r] = h * th * th / 8 <= JOIN_TOL && h * Math.abs(th) / 2 * steep <= JOIN_TOL &&
      h * (1 - Math.cos(pin)) <= JOIN_TOL && h * (1 - Math.cos(pout)) <= JOIN_TOL ? 1 : 0;
    if (GENTLE[r]) continue;
    SWI[r] = pin > 0 && 2 * h * Math.sin(pin) >= Math.hypot(SL[r - 1], dIn) - 1e-9 ? 1 : 0;
    SWO[r] = pout > 0 && 2 * h * Math.sin(pout) >= Math.hypot(SL[r], dOut) - 1e-9 ? 1 : 0;
  }
  const side = s => {
    const xs = [], ys = [];
    const put = (x, y) => { xs.push(x); ys.push(y); };
    // Angles on vertex r's discs in "forward" units for this side: 0 = s * (n0 = normal of the
    // incoming segment), positive = the way the pen travels (a rotation by -s).
    let px = 0, py = 0, ax = 0, ay = 0, cur = 0;       // the current vertex, its pivot and n0
    const at = (a, h) => {
      const c = Math.cos(a), sn = Math.sin(a);
      put(px + h * (s * ax * c + ay * sn), py + h * (s * ay * c - ax * sn));
    };
    const arc = (a, b, h) => {        // from a to b inclusive (b >= a), chord error <= JOIN_TOL
      const k = Math.max(1, Math.ceil((b - a) / (2 * Math.acos(Math.max(-1, 1 - JOIN_TOL / Math.max(h, JOIN_TOL))))));
      for (let t = 0; t <= k; t++) at(a + (b - a) * t / k, h);
    };
    // a positively wound sector loop at the vertex: pivot -> arc -> pivot
    const sector = (a, b, h) => { put(px, py); arc(a, b, h); put(px, py); };
    // is this vertex's circle point at angle a inside vertex k's disc?
    const within = (a, k) => {
      const c = Math.cos(a), sn = Math.sin(a), h = hIn[cur];
      return Math.hypot(px + h * (s * ax * c + ay * sn) - PX[k], py + h * (s * ay * c - ax * sn) - PY[k]) <= hIn[k];
    };
    // where this vertex's circle meets vertex k's on this side of the travel direction (dir = +1:
    // towards k, -1: coming from k), in forward units; null if the circles do not cross
    const meet = (k, dir) => {
      const h = hIn[cur], hk = hIn[k];
      let ux = PX[k] - px, uy = PY[k] - py;
      const d = Math.hypot(ux, uy);
      if (!(d > 0) || d >= h + hk || d + hk <= h || d + h <= hk) return null;
      ux /= d; uy /= d;
      const along = (h * h - hk * hk + d * d) / (2 * d), off = Math.sqrt(Math.max(0, h * h - along * along));
      const zx = ux * along - s * dir * uy * off, zy = uy * along + s * dir * ux * off;
      // cos a = s (z . n0) / h, sin a = (z . t0) / h with t0 = (ay, -ax)
      return Math.atan2(zx * ay - zy * ax, s * (zx * ax + zy * ay));
    };
    for (let r = 0; r < V; r++) {
      px = PX[r]; py = PY[r]; cur = r;
      if (r === 0 || r === V - 1) {
        // end caps are half discs (added with the closing arcs); a zero-length run adds a disc
        if (V === 1) {                // every point coincides: only the zero-length discs are drawn
          put(px + s * SX[0] * hD[0], py + s * SY[0] * hD[0]);
          break;
        }
        const j = r === 0 ? 0 : V - 2, h = r === 0 ? hOut[r] : hIn[r];
        ax = SX[j]; ay = SY[j];
        const ex = px + s * ax * h, ey = py + s * ay * h;
        put(ex, ey);
        if (hD[r] > 0) { sector(-HALF_PI, HALF_PI, hD[r]); put(ex, ey); }
        continue;
      }
      ax = SX[r - 1]; ay = SY[r - 1];
      const bx = SX[r], by = SY[r];
      const tau = -s * TH[r];                                         // the outgoing edge starts here
      if (multi[r]) {
        // coincident points: the incoming edge's end, the zero-length segments' full disc (this
        // side's half), then the outgoing segment's back cap where it is wider than that disc
        at(0, hIn[r]);
        if (hD[r] > 0) sector(-HALF_PI, HALF_PI, hD[r]); else put(px, py);
        if (hOut[r] > hD[r]) arc(tau - HALF_PI, tau, hOut[r]); else at(tau, hOut[r]);
        continue;
      }
      const h = hIn[r];
      if (GENTLE[r]) {
        let mx = ax + bx, my = ay + by;
        const L = Math.hypot(mx, my) || 1;
        put(px + s * h * mx / L, py + s * h * my / L);
        continue;
      }
      const swallowIn = SWI[r], swallowOut = SWO[r];
      const yA = -2 * PIN[r], xA = tau + 2 * POUT[r];
      // Renderer coverage in these units: front half of the incoming segment's cap [0, pi], back
      // half of the outgoing one's [tau - pi, tau]; on the inner side (tau < 0) the wedge (tau, 0)
      // between them is open, but narrower than 2 JOIN_TOL it may be filled.
      const thinWedge = tau < 0 && -tau * h <= 2 * JOIN_TOL;
      if ((tau >= 0 || thinWedge) && !swallowIn && !swallowOut && yA >= tau - Math.PI && xA <= Math.PI) {
        // trim form: Y lies on the incoming edge, X on the outgoing one
        if (tau >= 0) arc(yA, xA, h);
        else {                          // across the thin wedge from the incoming end to the outgoing start
          if (yA < 0) arc(yA, 0, h); else at(0, h);
          if (xA > tau) arc(tau, xA, h); else at(tau, h);
        }
        continue;
      }
      // spoke form: incoming edge's end -> front sector [0, fEnd] -> pivot -> back sector [bStart, tau].
      // Where the disc swallows an edge its outline part can run on past its neighbours, so this
      // side's whole quarter goes in (the other side adds its own)...
      let fEnd = swallowOut ? HALF_PI : Math.min(Math.PI, Math.max(0, xA));
      let bStart = swallowIn ? tau - HALF_PI : Math.max(tau - Math.PI, Math.min(tau, yA));
      // ...except along a run of such discs: the quarter may stop where the next disc's circle
      // comes out of it when that disc spans this pivot and lays down its own quarter the same
      // way. What is left out lies under the edge between the two or inside the neighbour's
      // quarter, which is covered by the same argument further down the run. (Stopping at any
      // neighbour without these conditions leaves the lens between the two pivots open.)
      if (swallowOut && SWO[r + 1] && SL[r] <= hIn[r + 1] && within(HALF_PI, r + 1)) {
        const z = meet(r + 1, 1);
        if (z !== null) fEnd = Math.min(HALF_PI, Math.max(0, z));
      }
      if (swallowIn && SWI[r - 1] && SL[r - 1] <= hIn[r - 1] && within(tau - HALF_PI, r - 1)) {
        let z = meet(r - 1, -1);
        if (z !== null) {
          if (z > tau) z -= 2 * Math.PI;
          bStart = Math.max(tau - HALF_PI, Math.min(tau, z));
        }
      }
      if (fEnd > 0) arc(0, fEnd, h); else at(0, h);
      put(px, py);
      if (bStart < tau) arc(bStart, tau, h); else at(tau, h);
    }
    const XA = Float64Array.from(xs), YA = Float64Array.from(ys);
    return { X: XA, Y: YA, idx: simplifyIndices(XA, YA) };
  };
  const Ls = side(1), Rs = side(-1);
  const p = new PathWriter();
  p.move(Ls.X[0], Ls.Y[0]);
  for (let k = 1; k < Ls.idx.length; k++) p.lineTo(Ls.X[Ls.idx[k]], Ls.Y[Ls.idx[k]]);
  // With n = (-t.y, t.x) in y-down space, going left -> right around the end bulges forward
  // with sweep 0, and right -> left around the start bulges backward with sweep 0 too.
  const rl = Rs.X.length - 1;
  p.capTo(Rs.X[rl], Rs.Y[rl], 0);
  for (let k = Rs.idx.length - 2; k >= 0; k--) p.lineTo(Rs.X[Rs.idx[k]], Rs.Y[Rs.idx[k]]);
  p.capTo(Ls.X[0], Ls.Y[0], 0);
  p.close();
  return p;
}

/**
 * Pen-plotter fill: one stroke that sweeps each point's width band with a pen of `pen` mm, as a
 * meander: straight across the band along the local normal, along the band's edge for PITCH,
 * back across, along the other edge, and so on (period 1.6 x pen, two crossings). Crossings are
 * parallel and PITCH = 0.8 pen apart, so neighbours overlap by a fifth of the pen everywhere
 * and the edge runs trace the rim; only shallow scallops (0.2 pen deep) remain where a crossing
 * meets the rim. (A triangle wave of the same period leaves teeth reaching 3/8 into the band.)
 * The spacing is measured on the band's outer edge: the phase also advances by |turn| x
 * amplitude, so the outside of bends and wave peaks never fans open.
 * Sampled at every geometry vertex and at both ends of every crossing: between samples the
 * polyline is exact before simplification.
 */
function plotterD(m, pen) {
  const { n, X, Y, W, NX, NY } = m;
  const pitch = 0.8 * pen;
  const amp = w => Math.max(0, w / 2 - pen / 2);    // pen centre's reach from the centreline
  const ZX = [], ZY = [];
  const put = (x, y, nx, ny, a) => { ZX.push(x + nx * a); ZY.push(y + ny * a); };
  let edge = 1;                                      // which rim the pen is running along
  let phase = 0, next = pitch;                       // outer-edge length so far, next crossing
  put(X[0], Y[0], NX[0], NY[0], amp(W[0]));
  for (let i = 0; i < n - 1; i++) {
    const dx = X[i + 1] - X[i], dy = Y[i + 1] - Y[i];
    const turn = Math.abs(Math.atan2(NX[i] * NY[i + 1] - NY[i] * NX[i + 1], NX[i] * NX[i + 1] + NY[i] * NY[i + 1]));
    const step = Math.hypot(dx, dy) + turn * Math.max(amp(W[i]), amp(W[i + 1]));
    for (; step > 0 && next <= phase + step; next += pitch) {
      const t = (next - phase) / step;
      let nx = NX[i] + (NX[i + 1] - NX[i]) * t, ny = NY[i] + (NY[i + 1] - NY[i]) * t;
      const L = Math.hypot(nx, ny) || 1;
      nx /= L; ny /= L;
      const x = X[i] + dx * t, y = Y[i] + dy * t, a = amp(W[i] + (W[i + 1] - W[i]) * t);
      put(x, y, nx, ny, edge * a);
      edge = -edge;
      put(x, y, nx, ny, edge * a);
    }
    phase += step;
    put(X[i + 1], Y[i + 1], NX[i + 1], NY[i + 1], edge * amp(W[i + 1]));
  }
  const ZXa = Float64Array.from(ZX), ZYa = Float64Array.from(ZY);
  return polylineD(ZXa, ZYa, simplifyIndices(ZXa, ZYa));
}

const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const cssColor = (hex, fallback) => (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(hex)) ? String(hex).toLowerCase() : fallback);
const mm = v => +v.toFixed(3);

/**
 * The line as an SVG document in millimetres.
 *   mode 'stroke'   centreline of any technique, one stroked path (the pen width of the geometry)
 *        'outline'  one filled closed path tracing the varying width (thickness)
 *        'plotter'  one stroked path sweeping back and forth to fill the width band with a
 *                   `penMm` pen (0.3 mm)
 * Any path shape in the spiral geometry format (geom.path: spiral, maze, wander, contour); the
 * <desc> and layer name say which.
 * Default mode: 'stroke' for wave geometry, 'outline' otherwise.
 */
export function buildSVG(geom, { mode, ink = '#17171a', paper = null, sizeMm = SHEET_MM, layout = DEFAULT_LAYOUT, penMm } = {}) {
  if (!geom || geom.n < 2) throw new Error('buildSVG: no line to export');
  // A realistic drawing IS a plotter file: the real sheet in mm, one path, the real pen width
  // (whatever kind the dialog asks for, an outline or a fill would misstate the pen)
  const real = geom.real && geom.real.toolMm > 0 && geom.real.sheetMm > 0 ? geom.real : null;
  if (real) { mode = 'stroke'; sizeMm = real.sheetMm; penMm = real.toolMm; }
  // the Save dialog names the file right after this call with the kind it asked for; remember the
  // real sheet so fileName says what the file is ('...-real-594mm.svg', not '-outline.svg')
  lastRealSvg = real ? { sheetMm: real.sheetMm, at: Date.now() } : null;
  mode = mode || (geom.technique === 'wave' ? 'stroke' : 'outline');
  if (!['stroke', 'outline', 'plotter'].includes(mode)) throw new Error('buildSVG: unknown mode ' + mode);
  const S = Math.max(1, +sizeMm || SHEET_MM);
  const L = { ...DEFAULT_LAYOUT, ...layout };
  const m = toMillimetres(geom, S, L);
  const color = cssColor(ink, '#000000');

  let d, attrs, pen = null;
  if (mode === 'outline') {
    d = outlineD(m);
    attrs = `fill="${color}" fill-rule="nonzero" stroke="none"`;
  } else {
    pen = mode === 'plotter' ? (penMm || 0.3)
      : (penMm || (geom.penWidth ?? geom.minWidth ?? 0.002) * m.R);
    pen = Math.max(0.01, pen);
    d = mode === 'plotter' ? plotterD(m, pen) : polylineD(m.X, m.Y, simplifyIndices(m.X, m.Y));
    attrs = `fill="none" stroke="${color}" stroke-width="${mm(pen)}" stroke-linecap="round" stroke-linejoin="round"`;
  }

  const lengthM = (geom.length || 0) * m.R / 1000;
  const kind = geom.path || 'spiral';
  const what = real ? `line, ${String(real.name || real.style || 'drawing').toLowerCase()} for a ${mm(real.toolMm)} mm pen (about ${Math.max(1, Math.round((real.handSeconds || 0) / 60))} min by hand)`
    : kind === 'spiral' ? `spiral of ${Math.round(geom.turns ?? geom.rings ?? 0)} turns`
    : kind === 'maze' ? `line winding through a ${geom.shape === 'circle' ? 'round' : 'square'} maze ${Math.round(geom.rings ?? 0)} corridors across`
    : kind === 'wander' ? 'line wandering across the picture'
    : kind === 'contour' ? 'line tracing the outlines of the picture'
    : 'line';
  const how = mode === 'outline' ? 'filled outline of the varying line width'
    : mode === 'plotter' ? `single pen stroke (${mm(pen)} mm pen) sweeping back and forth across the line width`
    : `centreline, ${mm(pen)} mm pen`;
  const paperHex = paper ? cssColor(paper, null) : null;
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" `,
    `xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" version="1.1" `,
    `width="${mm(S)}mm" height="${mm(S)}mm" viewBox="0 0 ${mm(S)} ${mm(S)}">\n`,
    `<title>Spiralist: one continuous line</title>\n`,
    `<desc>${esc(`A single unbroken ${what}, ${lengthM.toFixed(1)} m of line on a ${mm(S)} mm sheet. ` +
      `Drawn as a ${how}. 1 unit = 1 mm. Made with Spiralist.`)}</desc>\n`,
  ];
  if (paperHex) {
    out.push(`<g inkscape:groupmode="layer" inkscape:label="Paper" id="paper" sodipodi:insensitive="true">\n`,
      `<rect x="0" y="0" width="${mm(S)}" height="${mm(S)}" fill="${paperHex}"/>\n</g>\n`);
  }
  const [layer, layerId] = kind === 'spiral' ? ['Spiral', 'spiral'] : kind === 'maze' ? ['Maze', 'maze'] : ['Line', 'drawing'];
  out.push(`<g inkscape:groupmode="layer" inkscape:label="${layer}" id="${layerId}">\n`,
    `<path id="line" ${attrs} d="`, d.toString(), `"/>\n</g>\n</svg>\n`);
  return out.join('');
}

const NUMS_PER = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7, Z: 0 };

/** { paths, nodes, bytes } of an SVG string (nodes = path vertices incl. arc end points). */
export function svgStats(svg) {
  const paths = (svg.match(/<path\b/g) || []).length;
  let nodes = 0;
  for (const m of svg.matchAll(/\sd="([^"]*)"/g)) {
    const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
    let per = 2, count = 0, tok;
    while ((tok = re.exec(m[1]))) {
      if (tok[1]) {
        if (per && count) nodes += Math.floor(count / per);
        per = NUMS_PER[tok[1].toUpperCase()]; count = 0;
      } else count++;
    }
    if (per && count) nodes += Math.floor(count / per);
  }
  const bytes = new TextEncoder().encode(svg).length;
  return { paths, nodes, bytes };
}

// ============================================================================ sharing
const EXT_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', gif: 'image/gif', json: 'application/json' };
const typeFor = name => EXT_TYPES[String(name).split('.').pop().toLowerCase()] || '';
const baseType = type => String(type || '').split(';')[0].trim().toLowerCase();   // drop ;codecs=...
const extFor = type => Object.keys(EXT_TYPES).find(k => EXT_TYPES[k] === baseType(type)) || 'bin';

/** Save a Blob through the browser's download flow. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);       // Firefox only follows attached links
  a.click();
  a.remove();
  // Safari and Firefox read the URL after click() returns; revoke well afterwards.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Can this browser share files of `type` through the system share sheet? */
export function canShareFiles(type = 'video/mp4') {
  const nav = globalThis.navigator;
  if (!nav?.share || !nav.canShare || typeof File === 'undefined') return false;
  try { return nav.canShare({ files: [new File([new Uint8Array(1)], 'spiralist.' + extFor(type), { type: baseType(type) })] }); }
  catch { return false; }
}

/**
 * Share a file via the Web Share API. Must be called from a user gesture (transient activation
 * lasts ~5 s in Chromium), so start it from the click, not after a long export.
 * -> 'shared' | 'cancelled' | 'unsupported' | 'failed'
 */
export async function shareFile(blob, filename, title) {
  const nav = globalThis.navigator;
  if (!nav?.share || !nav.canShare || typeof File === 'undefined') return 'unsupported';
  let data;
  try {
    data = { files: [new File([blob], filename, { type: baseType(blob.type) || typeFor(filename) })] };
    if (title) data.title = title;
    if (!nav.canShare(data)) return 'unsupported';
  } catch { return 'unsupported'; }
  try {
    await nav.share(data);
    return 'shared';
  } catch (e) {
    return e?.name === 'AbortError' ? 'cancelled' : 'failed';
  }
}

/**
 * Copy a PNG to the clipboard. The ClipboardItem is created synchronously from the promise so
 * Safari still sees the user gesture while the PNG is being rendered.
 */
export async function copyPNG(blobPromise) {
  const clip = globalThis.navigator?.clipboard;
  const png = Promise.resolve(blobPromise).then(b => (b.type === 'image/png' ? b : new Blob([b], { type: 'image/png' })));
  png.catch(() => {});
  if (!clip?.write || typeof ClipboardItem === 'undefined') return false;
  let item;
  try { item = new ClipboardItem({ 'image/png': png }); }
  catch {
    try { item = new ClipboardItem({ 'image/png': await png }); }   // engines that want a Blob, not a promise
    catch { return false; }
  }
  try { await clip.write([item]); return true; }
  catch { return false; }
}

const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

/** 'spiralist-portrait-pencil-4096.png' from ['Portrait', 'Pencil', 4096] and 'png'. */
let lastRealSvg = null;
export function fileName(parts = [], ext = '') {
  parts = [].concat(parts);
  // a realistic SVG was just built: its kind is always a real-size single stroke (see buildSVG)
  if (lastRealSvg && String(ext).replace(/^\.+/, '').toLowerCase() === 'svg' && Date.now() - lastRealSvg.at < 5000
    && ['stroke', 'outline', 'plotter'].includes(parts[parts.length - 1])) {
    parts = [...parts.slice(0, -1), 'real', `${Math.round(lastRealSvg.sheetMm)}mm`];
  }
  const slug = s => String(s ?? '').normalize('NFKD').replace(COMBINING_MARKS, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const bits = [].concat(parts).map(slug).filter(Boolean);
  if (bits[0] === 'spiralist') bits.shift();
  const base = ['spiralist', ...bits].join('-').slice(0, 96).replace(/-+$/, '');
  const e = String(ext || '').replace(/^\.+/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return e ? `${base}.${e}` : base;
}

// Internals exposed for tests/export.test.mjs (pure, no DOM).
export const _png = { filterRows, deflateEnds, syncFlushPart, encodeBand, WORKER_SOURCE };
