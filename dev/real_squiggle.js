// Lab for the realistic squiggle spiral (js/real/squiggle.js), rendered with the real renderer.
//   node tests/shoot.mjs "/dev/real_squiggle.html?shots=pen,charcoal,crop,ramp,lineup,presets"
//   shots   pen       bust + cat, 0.4 mm fineliner on cream (real_squiggle_bust_pen / _cat_pen)
//           charcoal  bust, 4 mm charcoal stick on cold-press (real_squiggle_bust_charcoal)
//           crop      1:1 crop of a 4096 px render of the bust (real_squiggle_crop4096); crop=x,y
//           ramp      a horizontal gradient + measured darkness per column (real_squiggle_ramp)
//           lineup    bust pen + cat pen + bust charcoal, labelled (real_squiggle_lineup)
//           presets   the three presets on the bust (real_squiggle_presets)
//   size=928  tool=0.4  preset=detailed  wobble=  ctool=4  crings=12 (charcoal minimum rings)
// Sets window.__done = { ok, files, report } for tests/shoot.mjs.
let Renderer;   // imported in run(): a shared module mid-edit elsewhere then fails fast, not by timeout
import { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS } from '../js/tone.js';
import { brushById, paperById, inkMode } from '../js/materials.js';
import { build, squiggleScale, PRESETS, SQUIGGLE_TONE, formatDuration } from '../js/real/squiggle.js';

const q = new URLSearchParams(location.search);
const LAYOUT = { cx: 0.5, cy: 0.5, r: 0.42 };
const SIZE = +(q.get('size') || 928);
const TOOL = +(q.get('tool') || 0.4);
const CTOOL = +(q.get('ctool') || 4);
const PRESET = q.get('preset') || 'detailed';
const extra = {};
if (q.has('wobble')) extra.wobble = +q.get('wobble');
if (q.has('gamma')) extra.toneGamma = +q.get('gamma');
if (q.has('factor')) extra.ringFactor = +q.get('factor');

const images = new Map();
async function sample(id) {
  if (!images.has(id)) {
    const { makeSample } = await import('../js/samples.js');
    images.set(id, await makeSample(id, 1024));
  }
  return images.get(id);
}

function gradient() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 1024, 0);
  grd.addColorStop(0, '#000'); grd.addColorStop(1, '#fff');
  g.fillStyle = grd; g.fillRect(0, 0, 1024, 1024);
  return c;
}

/** Tone field at the ring count the squiggle will use, then the geometry. */
function geometry(src, opts, { flip = false, tone = { ...TONE_DEFAULTS, ...SQUIGGLE_TONE } } = {}) {
  const S = squiggleScale(opts);
  const raster = rasterize(src, CROP_DEFAULTS);
  const t = processTone(raster, tone, { flip });
  const field = buildField(raster, t.L, { rings: S.rings, flip });
  build(field, opts);                        // warm (JIT), then time the real build
  return build(field, opts);
}

let renderer;
function draw(geom, { size = SIZE, brush, paper, ink }, R) {
  const r = R || (renderer ||= new Renderer(document.createElement('canvas')));
  const b = brushById(brush), p = paperById(paper);
  ink = ink || b.inks[0][0];
  const mode = inkMode(b, ink, p);
  if (!R) r.setSize(size, size);
  r.setLayout(LAYOUT);
  r.setPaper(p, 1);
  r.setStyle({ brush: b, ink, cover: mode.cover, photoColor: false });
  r.setGeometry(geom, { pacing: 'natural' });
  r.setLight();
  r.setTime(null);
  r.render(Infinity);
  const c = document.createElement('canvas');
  c.width = r.canvas.width; c.height = r.canvas.height;
  c.getContext('2d').drawImage(r.canvas, 0, 0);
  return c;
}

async function save(canvas, name) {
  const data = canvas.toDataURL('image/jpeg', 0.93);
  const r = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name: name.replace(/.jpg$/, ''), data }) });
  return (await r.json()).file || name;
}

const label = g => `${g.real.lengthM} m of line · ~${formatDuration(g.real.handSeconds)} by hand · ${g.real.rings} rings · ${g.real.points.toLocaleString('en')} pts`;

function captioned(img, title, sub, note = '') {
  const H = note ? 88 : 64;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height + H;
  const g = c.getContext('2d');
  g.fillStyle = '#e9e6df'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0);
  g.fillStyle = '#1a1a1a'; g.font = '600 20px system-ui'; g.fillText(title, 16, img.height + 26);
  g.fillStyle = '#444'; g.font = '16px system-ui'; g.fillText(sub, 16, img.height + 50);
  if (note) { g.fillStyle = '#8a3b1c'; g.fillText(note, 16, img.height + 74); }
  return c;
}

function row(cells, gap = 8) {
  const c = document.createElement('canvas');
  c.width = cells.reduce((s, x) => s + x.width, 0) + gap * (cells.length - 1);
  c.height = Math.max(...cells.map(x => x.height));
  const g = c.getContext('2d');
  g.fillStyle = '#cfcac0'; g.fillRect(0, 0, c.width, c.height);
  let x = 0;
  for (const cell of cells) { g.drawImage(cell, x, 0); x += cell.width + gap; }
  return c;
}

const PEN = { brush: 'fineliner', paper: 'cream', ink: '#17171a' };
const CHAR = { brush: 'charcoal', paper: 'coldpress' };
const penOpts = () => ({ toolMm: TOOL, preset: PRESET, ...extra });
const charOpts = () => ({ toolMm: CTOOL, preset: PRESET, minRings: +(q.get('crings') || 12), ...extra });

async function run() {
  ({ Renderer } = await import('../js/renderer.js'));
  const shots = (q.get('shots') || 'pen').split(',');
  const files = [], report = {};
  const stat = (k, g) => { report[k] = g.real; };
  const cache = {};
  const bustPen = async () => (cache.bp ||= geometry(await sample('bust'), penOpts()));
  const catPen = async () => (cache.cp ||= geometry(await sample('cat'), penOpts()));
  const bustChar = async () => (cache.bc ||= geometry(await sample('bust'), charOpts()));

  if (shots.includes('pen')) {
    const gb = await bustPen(); stat('bustPen', gb);
    files.push(await save(draw(gb, PEN), 'real_squiggle_bust_pen.jpg'));
    const gc = await catPen(); stat('catPen', gc);
    files.push(await save(draw(gc, PEN), 'real_squiggle_cat_pen.jpg'));
  }
  if (shots.includes('charcoal')) {
    const g = await bustChar(); stat('bustCharcoal', g);
    files.push(await save(draw(g, CHAR), 'real_squiggle_bust_charcoal.jpg'));
  }
  if (shots.includes('crop')) {
    // the same sheet as if rendered at 4096 px, only a 1024 px window of it (1 px = 0.05 mm)
    const g = await bustPen();
    const [fx, fy] = (q.get('crop') || '0.45,0.38').split(',').map(Number);
    const big = 4096, win = 1024;
    const R = new Renderer(document.createElement('canvas'));
    R.setPaperSize(big, big);
    R.setSize(win, win);
    R.setOrigin(Math.round(fx * big - win / 2), Math.round(fy * big - win / 2));
    const img = draw(g, PEN, R);
    files.push(await save(captioned(img, '1:1 crop of a 4096 px render (1 px = 0.05 mm of a 210 mm sheet)',
      `0.4 mm fineliner on cream · ${label(g)}`), 'real_squiggle_crop4096.jpg'));
    R.destroy();
  }
  if (shots.includes('ramp')) {
    const tone = { ...TONE_DEFAULTS, auto: false, detail: 0 };
    const g = geometry(gradient(), penOpts(), { tone });
    stat('ramp', g);
    const img = draw(g, PEN);
    // measure the rendered darkness in columns across the circle's middle band
    const W = img.width, ctx = img.getContext('2d');
    const px = ctx.getImageData(0, 0, W, W).data;
    const lum = (x, y) => { const o = (y * W + x) * 4; return 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]; };
    const bins = 18, cx = W / 2, R = LAYOUT.r * W;
    const paperL = lum(20, 20);
    const meas = [];
    for (let i = 0; i < bins; i++) {
      const x0 = Math.round(cx + R * (-0.86 + 1.72 * i / bins)), x1 = Math.round(cx + R * (-0.86 + 1.72 * (i + 1) / bins));
      let s = 0, n = 0;
      for (let y = Math.round(cx - R * 0.45); y < cx + R * 0.45; y++) for (let x = x0; x < x1; x++) { s += lum(x, y); n++; }
      const xc = -0.86 + 1.72 * (i + 0.5) / bins;
      meas.push({ D: +(1 - (xc + 1) / 2).toFixed(3), dark: +(1 - s / n / paperL).toFixed(3) });
    }
    let mono = true;
    for (let i = 1; i < bins; i++) if (meas[i].dark > meas[i - 1].dark + 0.005) mono = false;
    report.rampMeasured = meas; report.rampMonotonic = mono;
    // chart under the render
    const CH = 300;
    const c = document.createElement('canvas');
    c.width = W; c.height = W + CH;
    const gx = c.getContext('2d');
    gx.fillStyle = '#e9e6df'; gx.fillRect(0, 0, W, c.height);
    gx.drawImage(img, 0, 0);
    const ox = 70, oy = W + CH - 50, cw = W - 110, chh = CH - 90;
    gx.strokeStyle = '#999'; gx.lineWidth = 1;
    gx.strokeRect(ox, oy - chh, cw, chh);
    // y axis up to solid ink (ink over this paper), so the chart shows how much of the range is used
    const hexL = h => { const v = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const maxDark = 1 - hexL(PEN.ink) / hexL(paperById(PEN.paper).color);
    report.rampSolidInk = +maxDark.toFixed(3);
    gx.strokeStyle = '#1a1a1a'; gx.lineWidth = 2.5; gx.beginPath();
    meas.forEach((m, i) => { const X = ox + m.D * cw, Y = oy - m.dark / maxDark * chh; i ? gx.lineTo(X, Y) : gx.moveTo(X, Y); });
    gx.stroke();
    gx.fillStyle = '#1a1a1a';
    for (const m of meas) { gx.beginPath(); gx.arc(ox + m.D * cw, oy - m.dark / maxDark * chh, 4, 0, 7); gx.fill(); }
    gx.font = '600 18px system-ui';
    gx.fillText(`Rendered darkness vs photo darkness (18 columns) — ${mono ? 'monotonic' : 'NOT monotonic'}`, ox, W + 30);
    gx.font = '15px system-ui'; gx.fillStyle = '#444';
    gx.fillText('photo darkness 0 → 1', ox + cw / 2 - 60, oy + 30);
    gx.fillText('solid', 18, oy - chh + 6); gx.fillText('paper', 16, oy + 5);
    files.push(await save(c, 'real_squiggle_ramp.jpg'));
  }
  if (shots.includes('lineup')) {
    const gb = await bustPen(), gc = await catPen(), gh = await bustChar();
    stat('bustPen', gb); stat('catPen', gc); stat('bustCharcoal', gh);
    const cells = [
      captioned(draw(gb, PEN), `A · Squiggle spiral — bust, ${TOOL} mm fineliner, 21 cm sheet`, label(gb), 'Detailed preset · hand time at 4 cm/s, max 5 zigzags/s'),
      captioned(draw(gc, PEN), `A · Squiggle spiral — cat, ${TOOL} mm fineliner, 21 cm sheet`, label(gc), 'Detailed preset · hand time at 4 cm/s, max 5 zigzags/s'),
      captioned(draw(gh, CHAR), `A · Squiggle spiral — bust, ${CTOOL} mm charcoal, 21 cm sheet`, label(gh),
        `only ${gh.real.rings} rings of a ${CTOOL} mm stick fit: a face needs ~40 (a 1.6 m sheet)`),
    ];
    files.push(await save(row(cells), 'real_squiggle_lineup.jpg'));
  }
  if (shots.includes('compare')) {
    // vars=factor:5,detail:0.35~factor:4.2,detail:0.6  (tuning: one bust per variant; '~' because
    // Windows shims treat '|' as a pipe)
    const src = await sample(q.get('img') || 'bust');
    const cells = [];
    for (const v of (q.get('vars') || 'factor:5').split('~')) {
      const kv = Object.fromEntries(v.split(',').map(s => s.split(':')).map(([k, x]) => [k, +x]));
      const { detail, contrast, darkness, ...o } = kv;
      const tone = { ...TONE_DEFAULTS, ...SQUIGGLE_TONE, ...(detail != null ? { detail } : {}), ...(contrast != null ? { contrast } : {}), ...(darkness != null ? { darkness } : {}) };
      const g = geometry(src, { ...penOpts(), ...(o.factor ? { ringFactor: o.factor } : {}), ...(o.gamma ? { toneGamma: o.gamma } : {}), ...(o.wobble != null ? { wobble: o.wobble } : {}) }, { tone });
      cells.push(captioned(draw(g, PEN), v, label(g)));
    }
    files.push(await save(row(cells), 'real_squiggle_compare.jpg'));
  }
  if (shots.includes('svg')) {
    // the plotter file: one stroked path at the pen's width, in millimetres on a 210 mm sheet
    const { buildSVG, svgStats } = await import('../js/export.js');
    const g = await bustPen();
    const svg = buildSVG(g, { sizeMm: 210, layout: LAYOUT });
    await fetch('/__file?name=real_squiggle_bust.svg', { method: 'POST', body: svg });
    const penAttr = (svg.match(/stroke-width="([^"]+)"/) || [])[1];
    report.svg = { ...svgStats(svg), strokeWidth: penAttr };
  }
  if (shots.includes('charsheets')) {
    // a 4 mm stick needs room: the same bust on bigger sheets (the renderer's paper grain scales
    // with the sheet, so the tooth reads coarser than real on the big ones)
    const src = await sample('bust');
    const cells = [];
    for (const sheetMm of [210, 800, 1600]) {
      const g = geometry(src, { ...charOpts(), sheetMm });
      stat('charcoal_' + sheetMm, g);
      cells.push(captioned(draw(g, CHAR), `${CTOOL} mm charcoal on a ${sheetMm / 10} cm sheet`, label(g)));
    }
    files.push(await save(row(cells), 'real_squiggle_charcoal_sheets.jpg'));
  }
  if (shots.includes('presets')) {
    const src = await sample('bust');
    const cells = [];
    for (const id of Object.keys(PRESETS)) {
      const g = geometry(src, { ...penOpts(), preset: id });
      stat('preset_' + id, g);
      cells.push(captioned(draw(g, PEN), `${PRESETS[id].name} — ${TOOL} mm fineliner`, label(g)));
    }
    files.push(await save(row(cells), 'real_squiggle_presets.jpg'));
  }
  return { files, report };
}

run().then(r => { window.__done = { ok: true, ...r }; })
  .catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
