// Physics checks for the Realistic mode (R3): real-size broad tools on big sheets, the paper's
// physical scale (renderer.setSheetMm), cockling under a raking light and the medium relief.
//   node tests/shoot.mjs "/dev/real_physics.html?shots=broad,grain,cockle,rake;tag=after"
//   shots   broad   per tool (charcoal 4, crayon 4, chalk 5, brush 3.5 mm): the whole sheet at
//                   preview size + a loupe crop (20 mm of paper at 640 px) -> rp_broad_<cm>_<tag>
//           grain   the same 20 mm loupe window of charcoal on 21, 60 and 100 cm sheets: grain,
//                   grit and tooth must keep one physical size -> rp_grain_<tag>
//           cockle  sumi brush on sketch under Window / Raking, whole sheet + crop -> rp_cockle_<tag>
//           rake    pencil, charcoal, crayon, fountain under Window vs Raking -> rp_rake_<tag>
//   sheet=600 (mm, broad)  size=928  tag=after  at=0.45,0.40 (crop centre, sheet fractions)
// Sets window.__done = { ok, files, report } for tests/shoot.mjs.
let Renderer;
import { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS } from '../js/tone.js';
import { brushById, paperById, inkMode } from '../js/materials.js';
import { build, squiggleScale, SQUIGGLE_TONE } from '../js/real/squiggle.js';
import { lightById } from '../js/papers.js';

const q = new URLSearchParams(location.search);
const LAYOUT = { cx: 0.5, cy: 0.5, r: 0.42 };
const SIZE = +(q.get('size') || 928);
const TAG = q.get('tag') || 'after';
const SHEET = +(q.get('sheet') || 600);
const [AX, AY] = (q.get('at') || '0.45,0.40').split(',').map(Number);
const CROP_MM = +(q.get('cropmm') || 20), CROP_PX = +(q.get('croppx') || 640);

const images = new Map();
async function sample(id) {
  if (!images.has(id)) {
    const { makeSample } = await import('../js/samples.js');
    images.set(id, await makeSample(id, 1024));
  }
  return images.get(id);
}

const geoCache = new Map();
async function geometry(img, opts) {
  const key = img + JSON.stringify(opts);
  if (geoCache.has(key)) return geoCache.get(key);
  const src = await sample(img);
  const S = squiggleScale(opts);
  const raster = rasterize(src, CROP_DEFAULTS);
  const t = processTone(raster, { ...TONE_DEFAULTS, ...SQUIGGLE_TONE }, { flip: false });
  const field = buildField(raster, t.L, { rings: S.rings, flip: false });
  const g = build(field, opts);
  geoCache.set(key, g);
  return g;
}

/** Render geom; crop = { mm, px, at: [fx, fy] } renders a loupe window at that texel density. */
function draw(geom, { brush, paper, ink, light = 'window', sheetMm = 210 }, crop = null) {
  const r = new Renderer(document.createElement('canvas'));
  const b = brushById(brush), p = paperById(paper);
  ink = ink || b.inks[0][0];
  const mode = inkMode(b, ink, p);
  if (crop) {
    const big = Math.round(sheetMm / crop.mm * crop.px);
    r.setPaperSize(big, big);
    r.setSize(crop.px, crop.px);
    r.setOrigin(Math.round(crop.at[0] * big - crop.px / 2), Math.round(crop.at[1] * big - crop.px / 2));
  } else r.setSize(SIZE, SIZE);
  r.setSheetMm?.(sheetMm);
  r.setLayout(LAYOUT);
  r.setPaper(p, 1);
  r.setStyle({ brush: b, ink, cover: mode.cover, photoColor: false });
  r.setGeometry(geom, { pacing: 'natural' });
  r.setLight(lightById(light));
  r.setTime(null);
  const t0 = performance.now();
  r.render(Infinity);
  const c = document.createElement('canvas');
  c.width = r.canvas.width; c.height = r.canvas.height;
  c.getContext('2d').drawImage(r.canvas, 0, 0);
  const ms = performance.now() - t0;
  r.destroy();
  c.ms = ms;
  return c;
}

async function save(canvas, name) {
  const data = canvas.toDataURL('image/jpeg', 0.92);
  const r = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data }) });
  return (await r.json()).file || name;
}

function captioned(img, title, sub = '') {
  const H = 56;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height + H;
  const g = c.getContext('2d');
  g.fillStyle = '#e9e6df'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0);
  g.fillStyle = '#1a1a1a'; g.font = '600 18px system-ui'; g.fillText(title, 12, img.height + 22);
  g.fillStyle = '#444'; g.font = '14px system-ui'; g.fillText(sub, 12, img.height + 44);
  return c;
}

function grid(cells, cols, gap = 8) {
  const w = Math.max(...cells.map(x => x.width)), h = Math.max(...cells.map(x => x.height));
  const rows = Math.ceil(cells.length / cols);
  const c = document.createElement('canvas');
  c.width = cols * w + gap * (cols - 1); c.height = rows * h + gap * (rows - 1);
  const g = c.getContext('2d');
  g.fillStyle = '#cfcac0'; g.fillRect(0, 0, c.width, c.height);
  cells.forEach((cell, i) => g.drawImage(cell, (i % cols) * (w + gap), Math.floor(i / cols) * (h + gap)));
  return c;
}

/** Scaled copy (the preview cells next to 640 px crops). */
function fit(img, px) {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, px, px);
  return c;
}

/** Luminance stats of a canvas region (mean, std) for the report. */
function lumStats(img, x0 = 0, y0 = 0, w = img.width, h = img.height) {
  const d = img.getContext('2d').getImageData(x0, y0, w, h).data;
  let s = 0, s2 = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    s += L; s2 += L * L; n++;
  }
  const m = s / n;
  return { mean: +m.toFixed(2), std: +Math.sqrt(Math.max(0, s2 / n - m * m)).toFixed(2) };
}

const TOOLS = [
  { brush: 'charcoal', paper: 'sketch', toolMm: 4, name: '4 mm charcoal stick' },
  { brush: 'crayon', paper: 'cream', toolMm: 4, name: '4 mm wax crayon' },
  { brush: 'chalk', paper: 'chalkboard', toolMm: 5, name: '5 mm chalk' },
  { brush: 'brush', paper: 'sketch', toolMm: 3.5, name: '3.5 mm sumi brush' },
];

async function run() {
  ({ Renderer } = await import('../js/renderer.js'));
  const shots = (q.get('shots') || 'broad').split(',');
  const files = [], report = { tag: TAG };
  const crop = { mm: CROP_MM, px: CROP_PX, at: [AX, AY] };

  if (shots.includes('broad')) {
    const cells = [];
    for (const T of TOOLS) {
      const g = await geometry('bust', { toolMm: T.toolMm, sheetMm: SHEET, preset: 'detailed', minRings: 12 });
      const st = { ...T, sheetMm: SHEET };
      const full = draw(g, st), loupe = draw(g, st, crop);
      report[`${T.brush}_${SHEET}`] = { lengthM: g.real.lengthM, hand: g.real.handSeconds, full: lumStats(full), crop: lumStats(loupe), ms: Math.round(loupe.ms) };
      cells.push(captioned(fit(full, CROP_PX), `${T.name} on a ${SHEET / 10} cm sheet (${TAG})`, `preview ${SIZE} px, shown at ${CROP_PX}`));
      cells.push(captioned(loupe, `loupe: ${CROP_MM} mm of paper`, `${(CROP_MM / CROP_PX * 1000).toFixed(0)} um per px`));
    }
    files.push(await save(grid(cells, 4), `rp_broad_${SHEET / 10}cm_${TAG}`));
  }
  if (shots.includes('pen')) {
    // pens at their real size on A4: the wet ones must stay lines (no flooding between rings)
    const cells = [];
    const pens = (q.get('pens') || 'fineliner,fountain,brush,watercolour').split(',');
    const pmm = +(q.get('pmm') || 0.5);
    for (const brush of pens) {
      const T = { brush, paper: q.get('ppaper') || 'cream', toolMm: pmm };
      const g = await geometry('bust', { toolMm: pmm, sheetMm: 210, preset: 'detailed' });
      const full = draw(g, { ...T, sheetMm: 210 }), loupe = draw(g, { ...T, sheetMm: 210 }, { mm: 10, px: CROP_PX, at: [AX, AY] });
      report['pen_' + brush] = { full: lumStats(full), crop: lumStats(loupe) };
      cells.push(captioned(fit(full, CROP_PX), `${brush} ${pmm} mm, A4 (${TAG})`, 'preview'));
      cells.push(captioned(loupe, 'loupe: 10 mm of paper', ''));
    }
    files.push(await save(grid(cells, 4), `rp_pen_${TAG}`));
  }
  if (shots.includes('grain')) {
    const cells = [];
    for (const T of [TOOLS[0], TOOLS[1]]) {
      for (const sheetMm of [210, 600, 1000]) {
        const g = await geometry('bust', { toolMm: T.toolMm, sheetMm, preset: 'detailed', minRings: 12 });
        const img = draw(g, { ...T, sheetMm }, crop);
        report[`grain_${T.brush}_${sheetMm}`] = lumStats(img);
        cells.push(captioned(img, `${T.name}, ${sheetMm / 10} cm sheet (${TAG})`, `loupe ${CROP_MM} mm window`));
      }
    }
    files.push(await save(grid(cells, 3), `rp_grain_${TAG}`));
  }
  if (shots.includes('cockle')) {
    const cells = [];
    const sheetMm = +(q.get('csheet') || 420);
    const T = { brush: q.get('cbrush') || 'brush', paper: q.get('cpaper') || 'sketch', toolMm: +(q.get('ctool') || 3.5) };
    const g = await geometry('bust', { toolMm: T.toolMm, sheetMm, preset: 'detailed', minRings: 12 });
    const ccrop = { mm: 60, px: CROP_PX, at: [AX, AY] };
    for (const light of ['window', 'raking']) {
      const full = draw(g, { ...T, sheetMm, light });
      const loupe = draw(g, { ...T, sheetMm, light }, ccrop);
      report[`cockle_${light}`] = { full: lumStats(full), crop: lumStats(loupe) };
      cells.push(captioned(fit(full, CROP_PX), `${T.brush} ${T.toolMm} mm, ${sheetMm / 10} cm, ${light} (${TAG})`, 'whole sheet'));
      cells.push(captioned(loupe, `loupe: 60 mm of paper, ${light}`, ''));
    }
    files.push(await save(grid(cells, 4), `rp_cockle_${TAG}`));
  }
  if (shots.includes('marks')) {
    // the marks up close, one physical window each: a 0.5 mm pencil (3 mm of paper), a 4 mm
    // charcoal stick and a 4 mm wax crayon (20 mm), all on their tools' real sheets
    const cells = [];
    const sets = [
      { brush: 'pencil', paper: 'sketch', toolMm: 0.5, sheetMm: 210, mm: +(q.get('pencilmm') || 3) },
      { brush: 'charcoal', paper: 'coldpress', toolMm: 4, sheetMm: 1000, mm: 20 },
      { brush: 'crayon', paper: 'cream', toolMm: 4, sheetMm: 1000, mm: 20 },
    ];
    for (const T of sets) {
      const g = await geometry('bust', { toolMm: T.toolMm, sheetMm: T.sheetMm, preset: 'detailed', minRings: 12 });
      for (const light of ['window', 'raking']) {
        const img = draw(g, { ...T, light }, { mm: T.mm, px: CROP_PX, at: [AX, AY] });
        report[`marks_${T.brush}_${light}`] = lumStats(img);
        cells.push(captioned(img, `${T.brush} ${T.toolMm} mm, ${T.sheetMm / 10} cm, ${light} (${TAG})`, `loupe ${T.mm} mm window`));
      }
    }
    files.push(await save(grid(cells, 2), `rp_marks_${TAG}`));
  }
  if (shots.includes('sheet')) {
    // the whole big sheet, dry charcoal: under a raking light it must read as one sheet of paper
    // lying on a desk (a few long, gentle waves at most), not as a quilt of equal cells
    const cells = [];
    const sheetMm = +(q.get('ssheet') || 1500);
    const T = { brush: 'charcoal', paper: q.get('spaper') || 'coldpress', toolMm: 4 };
    const g = await geometry('bust', { toolMm: T.toolMm, sheetMm, preset: 'detailed', minRings: 12 });
    for (const light of ['window', 'raking']) {
      const full = draw(g, { ...T, sheetMm, light });
      const corner = lumStats(full, 8, 8, Math.round(SIZE * 0.2), Math.round(SIZE * 0.2));
      report[`sheet_${light}`] = { paper: corner };
      cells.push(captioned(full, `charcoal 4 mm, ${sheetMm / 10} cm, ${light} (${TAG})`, `corner std ${corner.std}`));
    }
    files.push(await save(grid(cells, 2), `rp_sheet_${TAG}`));
  }
  if (shots.includes('rake')) {
    const cells = [];
    const sets = [
      { brush: 'pencil', paper: 'sketch', toolMm: 0.5 },
      { brush: 'charcoal', paper: 'sketch', toolMm: 4, sheetMm: 600 },
      { brush: 'crayon', paper: 'cream', toolMm: 4, sheetMm: 600 },
      { brush: 'fountain', paper: 'cream', toolMm: 0.5 },
    ];
    for (const T of sets) {
      const sheetMm = T.sheetMm || 210;
      const g = await geometry('bust', { toolMm: T.toolMm, sheetMm, preset: 'detailed', minRings: 12 });
      for (const light of ['window', 'raking']) {
        const full = draw(g, { ...T, sheetMm, light });
        const st = lumStats(full, Math.round(SIZE * 0.3), Math.round(SIZE * 0.25), Math.round(SIZE * 0.4), Math.round(SIZE * 0.4));
        const corner = lumStats(full, 8, 8, Math.round(SIZE * 0.1), Math.round(SIZE * 0.1));
        report[`rake_${T.brush}_${light}`] = { face: st, paper: corner };
        cells.push(captioned(fit(full, 460), `${T.brush} ${T.toolMm} mm, ${light} (${TAG})`, `face mean ${st.mean} std ${st.std}`));
      }
    }
    files.push(await save(grid(cells, 4), `rp_rake_${TAG}`));
  }
  return { files, report };
}

run().then(r => { window.__done = { ok: true, ...r }; })
  .catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
