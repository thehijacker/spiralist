// Dry media lab (pencil, charcoal, crayon, chalk, ballpoint, neon, gold): the sheets the dry media
// are tuned with, each medium drawn with its own Look's line on its own paper, like the app does.
//   node tests/shoot.mjs "/dev/dry.html?sheet=grid;size=900;each=1"
//   sheet = grid    full sheets at preview size (size=900); each=1 also saves every cell alone
//                   (<shot>_<id>) so it can be inspected 1:1; paper=<id> or alt=1 (second paper)
//           crop    1:1 crops of a big render (big=4096; crop=x,y,w sheet fractions)
//           chips   the app's tool chips (70x52 CSS px at dpr=2 by default), on sketch + a dark sheet
//           ramp    the ramp image per medium + a tone report (mean ink per column band, must fall
//                   monotonically from dark to light)
//           lights  one crop per medium under several lights (lights=az,el_az,el...; degrees)
//   brushes=pencil,charcoal,...  img=sample:bust|portrait|ramp  path=spiral|wander|contour|maze
//   light=az,el  eye=x,y,z  time=s  rings=N (overrides the Look)  shot=name  jpg=1  cols=N
//   line=key:value,... (any other line setting, e.g. line=penWidth:0.22)
import { Renderer } from '../js/renderer.js';
import { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS } from '../js/tone.js';
import { buildSpiral, LINE_DEFAULTS, previewStroke } from '../js/spiral.js';
import { buildMaze } from '../js/maze.js';
import { buildWander, buildContour } from '../js/freeline.js';
import { LOOKS, brushById, paperById, inkMode, hexToRgb, contrastRatio } from '../js/materials.js';

const q = new URLSearchParams(location.search);
const LAYOUT = { cx: 0.5, cy: 0.5, r: 0.42 };
const DRY = ['pencil', 'charcoal', 'crayon', 'chalk', 'ballpoint', 'neon', 'gold'];
const NATURAL = { pencil: 'sketch', charcoal: 'coldpress', crayon: 'kraft', chalk: 'chalkboard', ballpoint: 'cream',
  neon: 'black', gold: 'black', fineliner: 'cream', fountain: 'sketch', marker: 'sketch', brush: 'coldpress', watercolour: 'coldpress' };
const ALT = { pencil: 'cream', charcoal: 'sketch', crayon: 'sketch', chalk: 'black', ballpoint: 'sketch',
  neon: 'blueprint', gold: 'kraft', fineliner: 'sketch', fountain: 'cream', marker: 'cream', brush: 'sketch', watercolour: 'sketch' };

function rampImage(S = 1024) {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, S, 0);
  grd.addColorStop(0, '#000'); grd.addColorStop(1, '#fff');
  g.fillStyle = grd; g.fillRect(0, 0, S, S);
  return c;
}
async function loadImage(spec) {
  if (spec === 'ramp') return rampImage();
  if (spec && spec.startsWith('sample:')) {
    const { makeSample } = await import('../js/samples.js');
    return makeSample(spec.slice(7), 1024);
  }
  const img = new Image();
  img.src = spec;
  await img.decode();
  return img;
}

const lookFor = b => LOOKS.find(l => l.brush === b.id && !l.line.path) || LOOKS.find(l => l.brush === b.id) || LOOKS[0];
const geomCache = new Map();
function geometryFor(src, look, flip, pathQ = q.get('path')) {
  const path = pathQ || look.line.path || 'spiral';
  const line = { ...LINE_DEFAULTS, ...look.line };
  if (q.get('rings')) line.rings = +q.get('rings');
  if (q.get('tech')) line.technique = q.get('tech');
  // line=key:value,... overrides any other line setting (e.g. line=penWidth:0.22)
  for (const kv of (q.get('line') || '').split(',').filter(Boolean)) {
    const [k, v] = kv.split(':');
    line[k] = isNaN(+v) ? v : +v;
  }
  const key = JSON.stringify([line, path, flip]);
  if (geomCache.has(key)) return geomCache.get(key);
  const raster = rasterize(src, CROP_DEFAULTS);
  const tone = processTone(raster, TONE_DEFAULTS, { flip });
  const field = buildField(raster, tone.L, { rings: line.rings, flip });
  const free = { shape: 'square', x: +(q.get('sx') || 0), y: +(q.get('sy') || 0), seed: 1, flow: 0.85 };
  let g;
  if (path === 'wander') g = buildWander(field, line, free, {});
  else if (path === 'contour') g = buildContour(field, line, free, {});
  else if (path === 'maze') g = buildMaze(field, line, free, {});
  else g = buildSpiral(field, line, {});
  geomCache.set(key, g);
  return g;
}

function inkFor(b, p) {
  if (q.get('ink')) return q.get('ink');
  if (!p.dark) return b.inks[0][0];
  // like the app (js/app.js inkFor): the first palette ink that reads on the dark sheet, else the
  // one that stands out most
  const pap = hexToRgb(p.color);
  const ok = b.inks.find(([h]) => contrastRatio(hexToRgb(h), pap) >= 4);
  return ok ? ok[0] : b.inks.reduce((best, [h]) => (contrastRatio(hexToRgb(h), pap) > contrastRatio(hexToRgb(best), pap) ? h : best), b.inks[0][0]);
}

let renderer;
function applyLight(r) {
  const L = q.get('light');
  const eye = q.get('eye') ? q.get('eye').split(',').map(Number) : undefined;
  if (L) {
    const [az, el] = L.split(',').map(Number);
    r.setLight({ azimuth: az * Math.PI / 180, elevation: (el || 40) * Math.PI / 180, eye });
  } else r.setLight(eye ? { eye } : undefined);
  r.setTime(q.has('time') ? +q.get('time') : null);
}
function draw({ w, h = w, brush, paper, ink, geom, cover, layout = LAYOUT }) {
  if (!renderer) renderer = new Renderer(document.createElement('canvas'));
  renderer.setSize(w, h);
  renderer.setLayout(layout);
  renderer.setPaper(paper, 1);
  renderer.setStyle({ brush, ink, cover, photoColor: false });
  renderer.setGeometry(geom, { pacing: 'natural' });
  applyLight(renderer);
  renderer.render(Infinity);
  return renderer.canvas;
}
// A window of a sheet `big` px wide, rendered alone (strip rendering: setPaperSize + setOrigin),
// for macro views past the canvas limit; the same pixels a full render at that size would have.
let macroR;
function drawWindow({ big, x, y, w, brush, paper, ink, geom, cover }) {
  if (!macroR) macroR = new Renderer(document.createElement('canvas'));
  macroR.setSize(w, w);
  macroR.setPaperSize(big, big);
  macroR.setOrigin(x, y);
  macroR.setLayout(LAYOUT);
  macroR.setPaper(paper, 1);
  macroR.setStyle({ brush, ink, cover, photoColor: false });
  macroR.setGeometry(geom, { pacing: 'natural' });
  applyLight(macroR);
  macroR.render(Infinity);
  return copy(macroR.canvas);
}
function crop(src, x, y, w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(src, -x, -y);
  return c;
}
function copy(src) { return crop(src, 0, 0, src.width, src.height); }
// exact k x k box downsample
function boxDown(src, k) {
  const w = src.width, h = src.height;
  const d = copy(src).getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const W = w / k, H = h / k;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const cx = c.getContext('2d');
  const out = cx.createImageData(W, H);
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
// 8x8 block mean luminance error (what a viewer sees at print distance) and pixel-level contrast
// (std of luminance inside the ink, the grain a preview shows) of two same-size canvases
function blockDiff(a, b) {
  const w = a.width, h = a.height;
  const da = a.getContext('2d').getImageData(0, 0, w, h).data, db = b.getContext('2d').getImageData(0, 0, w, h).data;
  const L = (d, o) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];
  const B = 8;
  let sum = 0, n = 0, sa = 0, sb = 0, va = 0, vb = 0;
  for (let y = 0; y + B <= h; y += B) for (let x = 0; x + B <= w; x += B) {
    let ma = 0, mb = 0, qa = 0, qb = 0;
    for (let j = 0; j < B; j++) for (let i = 0; i < B; i++) {
      const o = ((y + j) * w + x + i) * 4, la = L(da, o), lb = L(db, o);
      ma += la; mb += lb; qa += la * la; qb += lb * lb;
    }
    ma /= 64; mb /= 64;
    sum += Math.abs(ma - mb); sa += ma; sb += mb; n++;
    va += Math.sqrt(Math.max(0, qa / 64 - ma * ma)); vb += Math.sqrt(Math.max(0, qb / 64 - mb * mb));
  }
  return { meanBlockDL: +(sum / n).toFixed(2), meanLumSmall: +(sa / n).toFixed(1), meanLumBig: +(sb / n).toFixed(1),
    texSmall: +(va / n).toFixed(2), texBig: +(vb / n).toFixed(2) };
}

function sheetCanvas(cols, rows, cw, ch = cw, label = 18) {
  const c = document.createElement('canvas');
  c.width = cols * cw; c.height = rows * (ch + label);
  const g = c.getContext('2d');
  g.fillStyle = '#d9d5ce'; g.fillRect(0, 0, c.width, c.height);
  return { c, put(img, col, row, text) {
    g.drawImage(img, col * cw, row * (ch + label), cw, ch);
    g.fillStyle = '#222'; g.font = '12px system-ui'; g.fillText(text, col * cw + 6, row * (ch + label) + ch + 13);
  } };
}
async function save(canvas, name) {
  const type = q.get('jpg') ? 'image/jpeg' : 'image/png';
  const data = canvas.toDataURL(type, 0.93);
  const r = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data }) });
  return r.json();
}

async function run() {
  const sheet = q.get('sheet') || 'grid';
  const shot = q.get('shot') || `dry_${sheet}`;
  const brushes = (q.get('brushes') || DRY.join(',')).split(',').map(brushById);
  const src = await loadImage(q.get('img') || 'sample:bust');
  const cols = +(q.get('cols') || Math.min(4, brushes.length));
  const paperOf = b => paperById(q.get('paper') || (q.get('alt') ? ALT[b.id] : NATURAL[b.id]) || 'cream');
  const t0 = performance.now();
  const report = [];
  let out;

  if (sheet === 'grid' || sheet === 'ramp') {
    const size = +(q.get('size') || 900);
    const S = sheetCanvas(cols, Math.ceil(brushes.length / cols), size);
    for (const [i, b] of brushes.entries()) {
      const p = paperOf(b), ink = inkFor(b, p), m = inkMode(b, ink, p), look = lookFor(b);
      const geom = geometryFor(src, look, m.flip);
      const t = performance.now();
      const img = copy(draw({ w: size, brush: b, paper: p, ink, geom, cover: m.cover }));
      const ms = performance.now() - t;
      S.put(img, i % cols, Math.floor(i / cols), `${b.name} · ${p.name} · ${geom.path} ${look.line.rings}`);
      if (q.get('each')) await save(img, `${shot}_${b.id}`);
      const r = { brush: b.id, paper: p.id, ms: +ms.toFixed(1) };
      if (sheet === 'ramp') {
        // mean luminance in 10 column bands across the middle third (the ramp runs dark -> light)
        const d = img.getContext('2d').getImageData(0, 0, size, size).data;
        const bands = [];
        for (let k = 0; k < 10; k++) {
          let s = 0, n = 0;
          const x0 = Math.round(size * (0.12 + 0.076 * k)), x1 = Math.round(size * (0.12 + 0.076 * (k + 1)));
          for (let y = Math.round(size * 0.4); y < size * 0.6; y++) for (let x = x0; x < x1; x++) {
            const o = (y * size + x) * 4;
            s += 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]; n++;
          }
          bands.push(+(s / n).toFixed(1));
        }
        // the sheet follows the photo's luminance either way (dark ink where it is dark, or light
        // ink where it is light on a dark sheet), so it must brighten from left to right
        let mono = true;
        for (let k = 1; k < 10; k++) if (bands[k] - bands[k - 1] < -1.5) mono = false;
        Object.assign(r, { flip: m.flip, bands, monotone: mono });
      }
      report.push(r);
    }
    out = S.c;
  } else if (sheet === 'crop') {
    const big = +(q.get('big') || 4096);
    const [cx, cy, cw] = (q.get('crop') || '0.36,0.36,0.12').split(',').map(Number);
    const cell = Math.round(cw * big);
    const S = sheetCanvas(cols, Math.ceil(brushes.length / cols), cell);
    for (const [i, b] of brushes.entries()) {
      const p = paperOf(b), ink = inkFor(b, p), m = inkMode(b, ink, p), look = lookFor(b);
      const geom = geometryFor(src, look, m.flip);
      const img = big > 4096
        ? drawWindow({ big, x: Math.round(cx * big), y: Math.round(cy * big), w: cell, brush: b, paper: p, ink, geom, cover: m.cover })
        : crop(draw({ w: big, brush: b, paper: p, ink, geom, cover: m.cover }), Math.round(cx * big), Math.round(cy * big), cell);
      S.put(img, i % cols, Math.floor(i / cols), `${b.name} · ${p.name} · ${big}px 1:1`);
      if (q.get('each')) await save(img, `${shot}_${b.id}`);
    }
    out = S.c;
  } else if (sheet === 'chips') {
    // The app's tool chips (js/app.js buildThumbs): a close-up of the outer rings of previewStroke,
    // on the current paper, or a sheet that suits the tool when none of its inks reads there.
    const dpr = +(q.get('dpr') || 2), w = Math.round(70 * dpr), h = Math.round(52 * dpr);
    const bases = (q.get('papers') || 'sketch,black').split(',').map(paperById);
    const zoom = +(q.get('zoom') || 3);
    const S = sheetCanvas(brushes.length, bases.length * 2, w * zoom, h * zoom);
    const chipPaperFor = (b, p) => {
      if (b.prefersDark && !p.dark) return paperById(b.id === 'chalk' ? 'chalkboard' : 'black');
      const pap = hexToRgb(p.color);
      const best = Math.max(...b.inks.map(([hx]) => contrastRatio(hexToRgb(hx), pap)));
      return best >= 2.2 ? p : paperById(p.dark ? 'sketch' : 'black');
    };
    bases.forEach((base, r) => ['thickness', 'wave'].forEach((tech, t) => brushes.forEach((b, c) => {
      const pp = chipPaperFor(b, base), ink = inkFor(b, pp), m = inkMode(b, ink, pp);
      const g = previewStroke({ technique: tech });
      const img = draw({ w, h, brush: b, paper: pp, ink, geom: g, cover: m.cover, layout: { cx: -0.05, cy: 1.08 * h / w, r: 1.12 } });
      // show them enlarged, pixel for pixel (nearest), so the chip's own pixels can be judged
      const z = document.createElement('canvas'); z.width = w * zoom; z.height = h * zoom;
      const zg = z.getContext('2d'); zg.imageSmoothingEnabled = false; zg.drawImage(img, 0, 0, w * zoom, h * zoom);
      S.put(z, c, r * 2 + t, `${b.name} · ${pp.name} · ${tech}`);
    })));
    out = S.c;
  } else if (sheet === 'cons') {
    // Preview vs a box-downsampled k x render at the app's preview size: the same crop of both
    // side by side (zoom=z nearest) + the 8x8 block tone error over the whole sheet (report).
    const size = +(q.get('size') || 800), k = +(q.get('k') || 4), z = +(q.get('zoom') || 3);
    const [cx, cy, cw] = (q.get('crop') || '0.36,0.36,0.12').split(',').map(Number);
    const cell = Math.round(cw * size);
    const S = sheetCanvas(2, brushes.length, cell * z);
    for (const [r, b] of brushes.entries()) {
      const p = paperOf(b), ink = inkFor(b, p), m = inkMode(b, ink, p), look = lookFor(b);
      const geom = geometryFor(src, look, m.flip);
      const small = copy(draw({ w: size, brush: b, paper: p, ink, geom, cover: m.cover }));
      const down = boxDown(draw({ w: size * k, brush: b, paper: p, ink, geom, cover: m.cover }), k);
      [small, down].forEach((im, c) => {
        const cc = crop(im, Math.round(cx * size), Math.round(cy * size), cell);
        const zz = document.createElement('canvas'); zz.width = zz.height = cell * z;
        const zg = zz.getContext('2d'); zg.imageSmoothingEnabled = false; zg.drawImage(cc, 0, 0, cell * z, cell * z);
        S.put(zz, c, r, `${b.name} · ${c ? `${size * k} boxed to ${size}` : `${size}`}`);
      });
      report.push({ brush: b.id, paper: p.id, ...blockDiff(small, down) });
    }
    out = S.c;
  } else if (sheet === 'lights') {
    const big = +(q.get('big') || 2048);
    const [cx, cy, cw] = (q.get('crop') || '0.36,0.36,0.12').split(',').map(Number);
    const cell = Math.round(cw * big);
    const lights = (q.get('lights') || '-130,40_-100,14_40,20_150,12').split('_').map(s => s.split(',').map(Number));
    const S = sheetCanvas(lights.length, brushes.length, cell);
    for (const [r, b] of brushes.entries()) {
      const p = paperOf(b), ink = inkFor(b, p), m = inkMode(b, ink, p), look = lookFor(b);
      const geom = geometryFor(src, look, m.flip);
      draw({ w: big, brush: b, paper: p, ink, geom, cover: m.cover });
      // az,el[,tilt]: tilt = degrees the camera leans from straight above toward the light's mirror
      // side (where a sheen shows; the film's camera tilts like this)
      lights.forEach(([az, el, tilt = 0], c) => {
        const A = az * Math.PI / 180, T = tilt * Math.PI / 180;
        renderer.setLight({ azimuth: A, elevation: el * Math.PI / 180, view: [-Math.cos(A) * Math.sin(T), -Math.sin(A) * Math.sin(T), Math.cos(T)] });
        renderer.render(Infinity);
        S.put(crop(renderer.canvas, Math.round(cx * big), Math.round(cy * big), cell), c, r, `${b.name} · light ${az}/${el}${tilt ? ` · cam ${tilt}` : ''}`);
      });
    }
    out = S.c;
  }
  const res = await save(out, shot);
  window.__done = { ms: performance.now() - t0, report, ...res, ok: true };
  document.body.append(out);
  out.style.maxWidth = '100%';
}

run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
