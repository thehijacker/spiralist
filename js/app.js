// Spiralist — app controller.
//
// Data flow (each layer cached by the inputs it depends on):
//   photo + crop ─ rasterize ─> raster ─ processTone(tone, flip) ─> tone ─ buildField(rings) ─> field
//   field + line ─ buildSpiral ─> geom ─ Renderer(paper, brush, ink) ─> the sheet
// "doc" is the undoable document (look, tool, ink, paper, line, tone, crop); "prefs" are sticky UI
// choices (theme, playback, film and download options). Both persist locally; the photo too.

import { Renderer, webgl2Available } from './renderer.js';
import { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS, cropDiameter } from './tone.js';
import { buildSpiral, LINE_DEFAULTS, indexAt, headAt, printedLength, previewStroke, STRIDE } from './spiral.js';
import { buildMaze } from './maze.js';
import { buildWander, buildContour, FREE_DEFAULTS } from './freeline.js';
import { BRUSHES, PAPERS, LOOKS, brushById, paperById, lookById, inkMode, hexToRgb, luminance, contrastRatio, SHEET_MM } from './materials.js';
import { decodeImage, fromDrawable, autoCrop, encodeForStorage, imageErrorMessage, makeCanvas } from './imageio.js';
import { loadSettings, saveSettings, clearSettings, savePhoto, loadPhoto, forgetPhoto } from './store.js';
import { History } from './history.js';
import { sliderRow, bindSeg, rovingGrid, setChecked, popover, toast, announce, fmtTime, reducedMotion, isTouch, paintRange } from './ui.js';
import { Thumbs } from './thumbs.js';
import { drawSeconds, drawProgress } from './film.js';
import { starCount } from './share.js';

const $ = id => document.getElementById(id);
const LAYOUT = Object.freeze({ cx: 0.5, cy: 0.5, r: 0.42 });
const CIRCLE_MM = SHEET_MM * 0.84;            // art circle diameter on the virtual sheet
const DPR = () => Math.min(window.devicePixelRatio || 1, 2);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------------------------------ state
const DEFAULT_DOC = {
  look: 'classic', brush: 'fineliner', ink: '#17171a', inkSource: 'swatch', paper: 'cream',
  line: { ...LINE_DEFAULTS, path: 'spiral' }, tone: { ...TONE_DEFAULTS }, crop: { ...CROP_DEFAULTS },
  free: { ...FREE_DEFAULTS },
};
const DEFAULT_PREFS = {
  theme: 'system', pacing: 'natural', speed: 1, showTool: true,
  film: { format: isTouch() ? 'story' : 'square', length: 15, showTool: true, polaroid: true, reveal: false },
  download: { format: 'png', size: 4096, background: 'paper', svgMode: 'stroke', svgPaper: false },
  visited: false,
};
applyLookTo(DEFAULT_DOC, lookById('classic'));

const saved = loadSettings();
let doc = mergeDoc(saved?.doc);
let prefs = mergePrefs(saved?.prefs);
let photo = null;          // { canvas, width, height, name, id, sample, alphaBox, small }
let photoSeq = 0;

function mergeDoc(d) {
  const base = structuredClone(DEFAULT_DOC);
  if (!d) return base;
  const out = { ...base, ...d, line: { ...base.line, ...d.line }, tone: { ...base.tone, ...d.tone }, crop: { ...base.crop },
    free: { ...base.free, ...(d.free || d.maze) } };
  if (!['spiral', 'wander', 'contour', 'maze'].includes(out.line.path)) out.line.path = 'spiral';
  if (!BRUSHES.some(b => b.id === out.brush)) out.brush = base.brush;
  if (!PAPERS.some(p => p.id === out.paper)) out.paper = base.paper;
  if (!/^#[0-9a-f]{6}$/i.test(out.ink)) out.ink = base.ink;
  return out;
}
function mergePrefs(p) {
  const base = structuredClone(DEFAULT_PREFS);
  if (!p) return base;
  return { ...base, ...p, film: { ...base.film, ...p.film }, download: { ...base.download, ...p.download } };
}
function persist() {
  const { crop, ...rest } = doc;   // framing belongs to the photo; it is saved with it
  saveSettings({ doc: rest, prefs });
}

function applyLookTo(d, look) {
  d.look = look.id;
  d.brush = look.brush;
  d.ink = look.ink;
  d.inkSource = 'swatch';
  d.paper = look.paper;
  // a look keeps the current path (spiral or maze) unless it is a maze look itself
  const path = look.line.path || d.line?.path || 'spiral';
  d.line = { ...LINE_DEFAULTS, ...look.line, path, direction: d.line?.direction ?? 'cw', start: d.line?.start ?? 'center', seed: d.line?.seed ?? 1 };
  if (look.free) d.free = { ...(d.free || FREE_DEFAULTS), ...look.free };
}

const brush = () => brushById(doc.brush);
/** The outline of the drawing: the spiral and circle mazes are round, square mazes square. */
const artShape = () => (doc.line.path !== 'spiral' && doc.free.shape === 'square' ? 'square' : 'circle');
function clipArt(ctx, cx, cy, R, shape = artShape()) {
  ctx.beginPath();
  if (shape === 'square') ctx.rect(cx - R, cy - R, 2 * R, 2 * R);
  else ctx.arc(cx, cy, R, 0, Math.PI * 2);
}
const paper = () => paperById(doc.paper);
const photoColor = () => doc.inkSource === 'photo';
const mode = () => inkMode(brush(), doc.ink, paper(), photoColor());
const flip = () => mode().flip !== !!doc.tone.invert;

// ------------------------------------------------------------------------------------ pipeline
const cache = {};
let geom = null;

function keyOf(...parts) { return parts.map(p => (typeof p === 'object' ? JSON.stringify(p) : String(p))).join('|'); }

/** Build (or reuse) the geometry for the current doc. draft = lower-resolution field for live gestures. */
function computeGeometry(draft = false) {
  if (!photo) return null;
  const G = draft ? 512 : 1024;
  const rk = keyOf(photo.id, doc.crop, G);
  if (cache.rk !== rk) { cache.raster = rasterize(photo.canvas, doc.crop, G); cache.rk = rk; }
  const fl = flip();
  const tk = keyOf(rk, doc.tone, fl);
  if (cache.tk !== tk) { cache.tone = processTone(cache.raster, doc.tone, { flip: fl }); cache.tk = tk; }
  const fk = keyOf(tk, doc.line.rings);
  if (cache.fk !== fk) { cache.field = buildField(cache.raster, cache.tone.L, { rings: doc.line.rings, flip: fl }); cache.fk = fk; }
  const path = doc.line.path;
  const gk = keyOf(fk, doc.line, path === 'spiral' ? '' : doc.free, photoColor(), path === 'wander' && draft);
  if (cache.gk !== gk) {
    cache.geom = buildPath(path, cache.field, doc.line, doc.free, { colorFromPhoto: photoColor(), draft });
    cache.gk = gk;
  }
  return cache.geom;
}

/** One entry point for every path shape. */
function buildPath(path, field, line, free, opts = {}) {
  if (path === 'maze') return buildMaze(field, line, free, opts);
  if (path === 'wander') return buildWander(field, line, free, opts);
  if (path === 'contour') return buildContour(field, line, free, opts);
  return buildSpiral(field, line, opts);
}

/** Everything export / film need to reproduce the current drawing. */
export function renderState(g = geom) {
  const m = mode();
  return {
    geom: g, brush: brush(), paper: paper(), ink: doc.ink, cover: m.cover, photoColor: photoColor(),
    layout: { ...LAYOUT }, seed: doc.line.seed || 1, shape: artShape(),
  };
}

// ------------------------------------------------------------------------------------ renderer
if (!webgl2Available()) {
  $('fatal').hidden = false;
  throw new Error('WebGL2 unavailable');
}
const art = $('art');
const overlay = $('overlay');
const octx = overlay.getContext('2d');
let renderer;
try {
  renderer = new Renderer(art, {
    onLost: () => toast('Graphics reset — redrawing…'),
    onRestored: () => { thumbs.invalidateAll(); refreshThumbs(); invalidate('geom'); },
  });
} catch (e) {
  console.error(e);
  $('fatal').hidden = false;
  throw e;
}
const thumbs = new Thumbs();

// ------------------------------------------------------------------------------------ playback
const play = {
  f: 1,               // drawing progress 0..1 (transport position)
  playing: false,
  demo: false,        // the one-off reveal after a photo loads
  last: 0,
  lift: 1,            // tool lift 0 (drawing) .. 1 (gone)
  scrubbing: false,
};
const drawSec = () => drawSeconds(prefs.film.length, prefs.film.reveal);

function pointIndex(f) {
  if (!geom) return 0;
  if (f >= 1) return Infinity;
  return indexAt(geom, drawProgress(f, drawSec()), prefs.pacing);
}

function setPlaying(on, { demo = false } = {}) {
  if (on && !photo) return;
  if (on && play.f >= 1) play.f = 0;
  play.playing = on;
  play.demo = on && demo;
  play.last = performance.now();
  const btn = $('btnPlay');
  btn.querySelector('use').setAttribute('href', on ? '#i-pause' : play.f >= 1 ? '#i-replay' : '#i-play');
  btn.setAttribute('aria-label', on ? 'Pause' : play.f >= 1 ? 'Replay the drawing' : 'Play the drawing');
  invalidate('render');
}

function finishDemo() {
  if (play.demo) { play.f = 1; setPlaying(false); }
}

// ------------------------------------------------------------------------------------ frame loop
const need = { geom: false, draft: false, render: false, thumbs: false, penSees: false };
let rafId = 0;

function invalidate(what = 'render') {
  if (what === 'geom') need.geom = true;
  if (what === 'draft') { need.geom = true; need.draft = true; }
  need.render = true;
  if (!rafId) rafId = requestAnimationFrame(tick);
}

let lastGeomMs = 0;
function tick(now) {
  rafId = 0;
  let busy = false;
  if (need.geom) {
    const t0 = performance.now();
    const draft = need.draft;
    need.geom = false; need.draft = false;
    const g = computeGeometry(draft);
    if (g && g !== geom) { geom = g; renderer.setGeometry(geom); }
    lastGeomMs = performance.now() - t0;
    if (!draft) { need.penSees = true; scheduleIdleWork(); }
    updateStat();
  }
  applyRendererState();

  if (play.playing) {
    const dt = Math.min(0.1, (now - play.last) / 1000);
    play.last = now;
    const dur = play.demo ? 3 : drawSec() / prefs.speed;
    play.f = Math.min(1, play.f + dt / dur);
    if (play.f >= 1) { setPlaying(false); busy = false; }
  }
  if (geom) renderer.render(pointIndex(play.f));
  else renderer.renderBlank();
  drawOverlay(now);
  updateTransport();
  const animating = play.playing || (play.lift < 1 && play.f >= 1 && prefs.showTool);
  if (animating || busy) rafId = requestAnimationFrame(tick);
  need.render = false;
}

function applyRendererState() {
  const m = mode();
  renderer.setLayout(LAYOUT);
  renderer.setPaper(paper(), 1);
  renderer.setStyle({ brush: brush(), ink: doc.ink, cover: m.cover, photoColor: photoColor() });
  $('sheet').style.background = paper().color;
}

// ------------------------------------------------------------------------------------ stage size
let sheetCss = 600;
function layoutStage() {
  const stage = $('stage');
  const w = stage.clientWidth, h = stage.clientHeight;
  const mobile = matchMedia('(max-width: 767px)').matches;
  let side;
  const welcome = !$('welcome').hidden;
  if (mobile) {
    side = Math.min(w - 32, window.innerHeight * 0.46);
  } else if (welcome) {
    // the welcome card sits below the sheet instead of covering the drawing
    const cardH = $('welcome').offsetHeight || 250;
    side = Math.min(w - 96, h - cardH - 22 - 20 - 20);
  } else {
    side = Math.min(w - 96, h - 150);
  }
  side = Math.floor(clamp(side, 220, 1100));
  sheetCss = side;
  document.documentElement.style.setProperty('--sheet', `${side}px`);
  const px = Math.round(Math.min(side * DPR(), mobile ? 2048 : 2600));
  if (renderer.s.width !== px) {
    renderer.setSize(px, px);
    sizeOverlay();
  }
  invalidate('render');
}
// The overlay extends past the sheet so the drawing tool can overhang onto the desk.
const OVER = 0.35;
function sizeOverlay() {
  const px = Math.min(2600, Math.round(sheetCss * (1 + 2 * OVER) * DPR()));
  overlay.style.inset = `${-OVER * 100}%`;
  overlay.style.width = overlay.style.height = `${(1 + 2 * OVER) * 100}%`;
  if (overlay.width !== px) { overlay.width = px; overlay.height = px; }
}
const stageObserver = new ResizeObserver(() => {
  clearTimeout(layoutStage.t);
  layoutStage.t = setTimeout(layoutStage, 60);
});
stageObserver.observe($('stage'));
stageObserver.observe($('welcome'));

// ------------------------------------------------------------------------------------ overlay
let toolModule = null;
import('./tools.js').then(m => { toolModule = m; invalidate('render'); }).catch(() => { /* tools optional */ });
let lastToolBox = null;
const view = { compare: 0, penSees: false };

function sheetToOverlay(x, y) {
  // circle units -> overlay px
  const S = overlay.width / (1 + 2 * OVER);
  const o = OVER * S;
  return [o + (LAYOUT.cx + x * LAYOUT.r) * S, o + (LAYOUT.cy + y * LAYOUT.r) * S];
}

function drawOverlay(now) {
  const W = overlay.width, S = W / (1 + 2 * OVER), o = OVER * S;
  const full = framing.active || view.compare || view.penSees;
  if (full || drawOverlay.wasFull) {
    octx.clearRect(0, 0, W, W);
    lastToolBox = null;
  } else if (lastToolBox) {
    octx.clearRect(...lastToolBox);
    lastToolBox = null;
  }
  drawOverlay.wasFull = full;
  const cx = o + LAYOUT.cx * S, cy = o + LAYOUT.cy * S, R = LAYOUT.r * S;

  if (framing.active && photo) {
    // the whole photo, faint, with the circle cut out so the live drawing shows through
    octx.save();
    octx.beginPath();
    octx.rect(0, 0, W, W);
    if (artShape() === 'square') octx.rect(cx - R, cy - R, 2 * R, 2 * R);
    else octx.arc(cx, cy, R, 0, Math.PI * 2, true);
    octx.clip('evenodd');
    octx.globalAlpha = 0.32;
    drawPhotoInCircle(octx, cx, cy, R);
    octx.restore();
    octx.save();
    octx.setLineDash([6 * DPR(), 5 * DPR()]);
    octx.lineWidth = 1.5 * DPR();
    octx.strokeStyle = 'rgba(196,61,22,.9)';
    clipArt(octx, cx, cy, R); octx.stroke();
    octx.restore();
    return;
  }
  if ((view.compare || view.penSees) && photo) {
    octx.save();
    clipArt(octx, cx, cy, R); octx.clip();
    if (view.penSees && cache.field) drawFieldInCircle(octx, cx, cy, R);
    else drawPhotoInCircle(octx, cx, cy, R);
    octx.restore();
    return;
  }

  // maze start point: crosshair while choosing, a pin that fades after a pick
  if (doc.line.path !== 'spiral' && (picking.active || picking.flash > now)) {
    const px = picking.active && picking.hover ? picking.hover : [doc.free.x, doc.free.y];
    const [mx, my] = sheetToOverlay(px[0], px[1]);
    const a = picking.active ? 1 : Math.min(1, (picking.flash - now) / 600);
    const u = S / 100;
    octx.save();
    octx.globalAlpha = a;
    octx.lineWidth = 0.45 * u;
    octx.strokeStyle = '#c43d16';
    octx.fillStyle = 'rgba(196,61,22,.18)';
    octx.beginPath(); octx.arc(mx, my, 2.6 * u, 0, Math.PI * 2); octx.fill(); octx.stroke();
    octx.beginPath();
    octx.moveTo(mx - 4.2 * u, my); octx.lineTo(mx - 1.4 * u, my); octx.moveTo(mx + 1.4 * u, my); octx.lineTo(mx + 4.2 * u, my);
    octx.moveTo(mx, my - 4.2 * u); octx.lineTo(mx, my - 1.4 * u); octx.moveTo(mx, my + 1.4 * u); octx.lineTo(mx, my + 4.2 * u);
    octx.stroke();
    octx.fillStyle = '#c43d16';
    octx.beginPath(); octx.arc(mx, my, 0.6 * u, 0, Math.PI * 2); octx.fill();
    octx.restore();
    lastToolBox = null;
    drawOverlay.wasFull = true;   // clear the whole overlay next frame
    if (!picking.active) invalidate('render');
    return;
  }

  // drawing tool riding the head of the line
  if (!toolModule || !geom || !prefs.showTool) { play.lift = 1; return; }
  const drawing = play.f < 1 && (play.playing || play.scrubbing || play.f > 0);
  if (drawing) play.lift = 0;
  else if (play.lift < 1) play.lift = Math.min(1, play.lift + 1 / 24);
  if (!drawing && play.lift >= 1) return;
  const fi = pointIndex(Math.min(play.f, 0.99999));
  const h = headAt(geom, Number.isFinite(fi) ? fi : geom.n - 1);
  const [x, y] = sheetToOverlay(h.x, h.y);
  const size = S * 0.28;
  const lift = play.lift;
  const opts = {
    color: photoColor() ? '#8a5a44' : doc.ink,
    lift, alpha: 1 - lift * lift, sway: (now / 1000) % 1000,
  };
  try {
    toolModule.drawTool(octx, brush().tool, x + lift * size * 0.25, y + lift * size * 0.2, size, opts);
  } catch (e) { console.warn(e); }
  // conservative dirty box (tool points to the lower right)
  const pad = size * 0.25;
  lastToolBox = [x - pad - size * 0.1, y - pad - size * 0.4, size * 1.5 + pad * 2, size * 1.5 + pad * 2].map(Math.round);
  lastToolBox[2] += 2; lastToolBox[3] += 2;
}

function drawPhotoInCircle(ctx, cx, cy, R) {
  const w = photo.width, h = photo.height;
  const diam = cropDiameter(w, h, doc.crop);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale((2 * R) / diam, (2 * R) / diam);
  ctx.rotate((doc.crop.rotation || 0) * Math.PI / 180);
  ctx.translate(-doc.crop.x * w, -doc.crop.y * h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(photo.canvas, 0, 0);
  ctx.restore();
}

let fieldImg = null, fieldImgKey = '';
function fieldImage(size) {
  const f = cache.field;
  const key = cache.fk + size;
  if (fieldImg && fieldImgKey === key) return fieldImg;
  const c = fieldImg && fieldImg.width === size ? fieldImg : makeCanvas(size, size);
  const g = c.getContext('2d');
  const im = g.createImageData(size, size);
  const G = f.G, pap = hexToRgb(paper().color);
  const dark = luminance(pap) < 0.3;
  for (let y = 0; y < size; y++) {
    const gy = Math.min(G - 1, Math.floor((y + 0.5) / size * G));
    for (let x = 0; x < size; x++) {
      const gx = Math.min(G - 1, Math.floor((x + 0.5) / size * G));
      const D = f.D[gy * G + gx];
      const v = dark ? 20 + D * 225 : 250 - D * 235;
      const o = (y * size + x) * 4;
      im.data[o] = im.data[o + 1] = im.data[o + 2] = v; im.data[o + 3] = 255;
    }
  }
  g.putImageData(im, 0, 0);
  fieldImg = c; fieldImgKey = key;
  return c;
}
function drawFieldInCircle(ctx, cx, cy, R) {
  ctx.drawImage(fieldImage(512), cx - R, cy - R, 2 * R, 2 * R);
}

function drawPenSees() {
  const c = $('penSees');
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  if (!cache.field) return;
  g.save();
  g.beginPath(); g.arc(c.width / 2, c.height / 2, c.width / 2, 0, Math.PI * 2); g.clip();
  g.drawImage(fieldImage(256), 0, 0, c.width, c.height);
  g.restore();
}

// ------------------------------------------------------------------------------------ transport UI
const scrub = $('scrub');
function updateTransport() {
  if (!play.scrubbing) scrub.value = Math.round(play.f * 1000);
  paintRange(scrub);
  const total = drawSec();
  $('time').textContent = `${fmtTime(play.f * total)} / ${fmtTime(total)}`;
  const ring = geom ? Math.round(headRing()) : 0;
  scrub.setAttribute('aria-valuetext', `${fmtTime(play.f * total)} of ${fmtTime(total)}${geom ? `, ring ${ring} of ${geom.rings}` : ''}`);
  const btn = $('btnPlay');
  if (!play.playing) {
    btn.querySelector('use').setAttribute('href', play.f >= 1 ? '#i-replay' : '#i-play');
    btn.setAttribute('aria-label', play.f >= 1 ? 'Replay the drawing' : 'Play the drawing');
  }
}
function headRing(f = play.f) {
  if (!geom) return 0;
  const fi = pointIndex(Math.min(f, 0.99999));
  const t = headAt(geom, Number.isFinite(fi) ? fi : geom.n - 1).turn;
  return geom.start === 'edge' ? geom.turns - t : t;
}

scrub.addEventListener('pointerdown', () => { play.scrubbing = true; finishDemo(); if (play.playing) setPlaying(false); });
scrub.addEventListener('input', () => {
  play.f = +scrub.value / 1000;
  play.scrubbing = true;
  invalidate('render');
  const tip = $('scrubTip');
  const total = drawSec();
  tip.hidden = false;
  tip.textContent = geom && geom.path !== 'spiral'
    ? `${Math.round(play.f * 100)}% drawn · ${fmtTime(play.f * total)}`
    : `Ring ${Math.round(headRing())} of ${geom?.rings ?? 0} · ${fmtTime(play.f * total)}`;
  tip.style.left = `${play.f * 100}%`;
});
const endScrub = () => { play.scrubbing = false; $('scrubTip').hidden = true; invalidate('render'); };
scrub.addEventListener('change', endScrub);
scrub.addEventListener('pointerup', endScrub);
scrub.addEventListener('blur', endScrub);
$('btnPlay').addEventListener('click', () => {
  if (play.demo) finishDemo();
  setPlaying(!play.playing);
});

// ------------------------------------------------------------------------------------ history
const history = new History({
  onChange: h => {
    $('btnUndo').disabled = !h.canUndo;
    $('btnRedo').disabled = !h.canRedo;
    $('btnUndo').title = h.canUndo ? `Undo ${h.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    $('btnRedo').title = h.canRedo ? `Redo ${h.redoLabel} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)';
  },
});
const snapshot = () => structuredClone(doc);
function commit(label) { history.commit(snapshot(), label); persist(); if (label === 'Framing') saveSession(); }
function restore(d) {
  if (!d) return;
  const cropChanged = JSON.stringify(d.crop) !== JSON.stringify(doc.crop);
  doc = d;
  syncControls();
  invalidate('geom');
  refreshThumbs(cropChanged);
  persist();
  if (cropChanged) saveSession();
}
$('btnUndo').addEventListener('click', () => { const l = history.undoLabel; restore(history.undo()); if (l) announce(`Undid ${l}`); });
$('btnRedo').addEventListener('click', () => { const l = history.redoLabel; restore(history.redo()); if (l) announce(`Redid ${l}`); });

// ------------------------------------------------------------------------------------ doc changes
/** Apply a change to the doc. level: 'geom' (needs new line) or 'render' (style only). */
function change(mutate, { label, level = 'geom', live = false, thumbs: th = false } = {}) {
  mutate(doc);
  finishDemo();
  if (live) invalidate(lastGeomMs > 34 ? 'draft' : 'geom');
  else invalidate(level);
  if (label) commit(label);
  syncControls();
  if (th) refreshThumbs();
}

// ------------------------------------------------------------------------------------ inspector: looks
const looksEl = $('looks');
function buildLooks() {
  looksEl.replaceChildren(...LOOKS.map((look, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'look';
    b.setAttribute('role', 'radio');
    b.dataset.id = look.id;
    b.title = `${look.name}${i < 9 ? ` (${i + 1})` : ''}`;
    b.innerHTML = `<span class="thumb"><canvas></canvas><span class="skeleton"></span></span><span class="name"></span>`;
    b.querySelector('.name').textContent = look.name;
    b.addEventListener('click', () => applyLook(look.id));
    return b;
  }));
  rovingGrid(looksEl);
}
function lookEdited() {
  const look = lookById(doc.look);
  if (!look) return false;
  if (doc.brush !== look.brush || doc.paper !== look.paper || doc.ink !== look.ink || doc.inkSource !== 'swatch') return true;
  return Object.entries(look.line).some(([k, v]) => doc.line[k] !== v);
}
function applyLook(id) {
  const look = lookById(id);
  const was = lookEdited() && doc.look === id;
  change(d => applyLookTo(d, look), { label: `Look: ${look.name}`, thumbs: true });
  announce(was ? `Reverted to ${look.name}` : `${look.name} look`);
}
$('lookRevert').addEventListener('click', () => applyLook(doc.look));

// ------------------------------------------------------------------------------------ inspector: tools + inks
const toolsEl = $('tools');
function buildTools() {
  toolsEl.replaceChildren(...BRUSHES.map(b => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'chip';
    el.setAttribute('role', 'radio');
    el.dataset.id = b.id;
    el.title = `${b.name} — ${b.blurb}`;
    el.innerHTML = `<span class="thumb"><canvas></canvas><span class="skeleton"></span></span><span class="name"></span>`;
    el.querySelector('.name').textContent = b.name;
    el.addEventListener('click', () => setBrush(b.id));
    return el;
  }));
  rovingGrid(toolsEl);
}
/** The ink a tool should use on the current paper: keep custom/photo/in-palette, else its default
 *  (or its first light ink on dark paper, so switching tools never makes the line vanish). */
function inkFor(b, p = paper()) {
  if (doc.inkSource !== 'swatch') return doc.ink;
  if (b.inks.some(([h]) => h === doc.ink) && !inkMode(b, doc.ink, p).lowContrast && (!p.dark || inkMode(b, doc.ink, p).flip)) return doc.ink;
  if (!p.dark && !inkMode(b, b.inks[0][0], p).lowContrast) return b.inks[0][0];
  // otherwise the palette ink that stands out most on this sheet
  const pap = hexToRgb(p.color);
  return b.inks.reduce((best, [h]) => (contrastRatio(hexToRgb(h), pap) > contrastRatio(hexToRgb(best), pap) ? h : best), b.inks[0][0]);
}
/** The paper a tool chip is shown on: the current sheet if the tool has an ink that reads on it,
 *  otherwise a sheet that suits the tool (dark boards for chalk and light media, sketchbook else). */
function chipPaperFor(b, p) {
  if (b.prefersDark && !p.dark) return paperById(b.id === 'chalk' ? 'chalkboard' : 'black');
  const pap = hexToRgb(p.color);
  const best = Math.max(...b.inks.map(([h]) => contrastRatio(hexToRgb(h), pap)));
  return best >= 2.2 ? p : paperById(p.dark ? 'sketch' : 'black');
}
function setBrush(id) {
  const b = brushById(id);
  if (b.id === doc.brush) return;
  change(d => { d.brush = b.id; d.ink = inkFor(b); }, { label: `Tool: ${b.name}`, level: 'geom', thumbs: true });
  announce(`${b.name}`);
}
const inksEl = $('inks');
function buildInks() {
  const b = brush();
  const items = b.inks.map(([hex, name]) => {
    const s = document.createElement('button');
    s.type = 'button';
    s.className = 'swatch';
    s.setAttribute('role', 'radio');
    s.style.setProperty('--c', hex);
    s.dataset.hex = hex;
    s.title = name;
    s.setAttribute('aria-label', name);
    s.addEventListener('click', () => change(d => { d.ink = hex; d.inkSource = 'swatch'; }, { label: `Ink: ${name}`, thumbs: true }));
    return s;
  });
  const ph = document.createElement('button');
  ph.type = 'button';
  ph.className = 'swatch photo';
  ph.setAttribute('role', 'radio');
  ph.dataset.src = 'photo';
  ph.title = 'Colour from the photo';
  ph.setAttribute('aria-label', 'Colour from the photo');
  ph.addEventListener('click', () => change(d => { d.inkSource = 'photo'; }, { label: 'Ink: from photo', thumbs: true }));
  const cu = document.createElement('label');
  cu.className = 'swatch custom';
  cu.setAttribute('role', 'radio');
  cu.dataset.src = 'custom';
  cu.title = 'Custom colour';
  cu.innerHTML = '<input type="color" aria-label="Custom ink colour">';
  const input = cu.querySelector('input');
  input.value = doc.ink;
  input.addEventListener('input', () => change(d => { d.ink = input.value; d.inkSource = 'custom'; }, { level: 'geom' }));
  input.addEventListener('change', () => { commit('Ink: custom'); refreshThumbs(); });
  cu.addEventListener('click', e => { if (e.target === cu) input.click(); });
  inksEl.replaceChildren(...items, ph, cu);
  rovingGrid(inksEl);
}

// ------------------------------------------------------------------------------------ inspector: papers
const papersEl = $('papers');
function buildPapers() {
  papersEl.replaceChildren(...PAPERS.map(p => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'chip';
    el.setAttribute('role', 'radio');
    el.dataset.id = p.id;
    el.title = p.name;
    el.innerHTML = `<span class="thumb" style="background:${p.color}"><canvas></canvas></span><span class="name"></span>`;
    el.querySelector('.name').textContent = p.name;
    el.addEventListener('click', () => setPaper(p.id));
    return el;
  }));
  rovingGrid(papersEl);
}
function setPaper(id) {
  const p = paperById(id);
  if (p.id === doc.paper) return;
  change(d => { d.paper = p.id; }, { label: `Paper: ${p.name}`, level: 'geom', thumbs: true });
  announce(p.name);
}

// ------------------------------------------------------------------------------------ inspector: line
const TECH_HELP = {
  thickness: 'The line swells in dark areas.',
  wave: 'One pen width; the line wiggles in dark areas. Best for pen plotters.',
  both: 'The line swells and wiggles.',
};
const spacingMm = () => (CIRCLE_MM / 2) / doc.line.rings;
const lineSliders = {};
function buildLineSliders() {
  const host = $('lineSliders'), more = $('lineMoreSliders');
  const L = LINE_DEFAULTS;
  const mk = (key, o, parent = host) => {
    const s = sliderRow({
      ...o,
      value: o.get ? o.get() : doc.line[key],
      onInput: (v, dragging) => change(d => { o.set ? o.set(d, v) : (d.line[key] = v); }, { live: dragging }),
      onCommit: () => { commit(o.label); invalidate('geom'); refreshThumbs(); },
    });
    s.key = key;
    s.get = o.get || (() => doc.line[key]);
    lineSliders[key] = s;
    parent.append(s.el);
    return s;
  };
  mk('rings', { label: 'Rings', min: 20, max: 160, step: 1, def: 72, format: v => `${v}`, valuetext: v => `${v} rings`,
    hint: 'More rings = finer detail' });
  mk('weight', { label: 'Line weight', min: 0.3, max: 1, step: 0.01, def: L.weight, format: v => `${Math.round(v * 100)}%`,
    toEdit: v => Math.round(v * 100), fromEdit: v => v / 100, hint: 'How thick the line gets in the darkest areas' });
  mk('penWidth', { label: 'Pen width', min: 0.06, max: 0.45, step: 0.005, def: L.penWidth,
    format: v => `${(v * spacingMm()).toFixed(2)} mm`, valuetext: v => `${(v * spacingMm()).toFixed(2)} millimetres`,
    toEdit: v => +(v * spacingMm()).toFixed(2), fromEdit: v => v / spacingMm() });
  mk('amplitude', { label: 'Wave height', min: 0.2, max: 1, step: 0.01, def: L.amplitude, format: v => `${Math.round(v * 100)}%`,
    toEdit: v => Math.round(v * 100), fromEdit: v => v / 100 });
  mk('frequency', { label: 'Wave density', min: 0.5, max: 3, step: 0.05, def: L.frequency, format: v => `${v.toFixed(2)}×` });
  mk('wobble', { label: 'Hand wobble', min: 0, max: 1, step: 0.01, def: L.wobble, format: v => `${Math.round(v * 100)}%`,
    toEdit: v => Math.round(v * 100), fromEdit: v => v / 100, hint: 'Makes the spiral look hand-drawn' });
  mk('hairline', { label: 'Thinnest line', min: 0.02, max: 0.3, step: 0.01, def: L.hairline, format: v => `${Math.round(v * 100)}%`,
    toEdit: v => Math.round(v * 100), fromEdit: v => v / 100, hint: 'Keeps the single line visible in light areas' }, more);
  mk('edgeFade', { label: 'Edge fade', min: 0, max: 8, step: 0.5, def: L.edgeFade, format: v => v ? `${v} rings` : 'Off',
    hint: 'Fades the drawing into a hairline at the rim' }, more);
}
const PATH_HELP = {
  spiral: 'One line spirals out from the centre of the circle.',
  wander: 'One line wanders in unexpected directions from the point you choose, packing tighter where the photo is dark.',
  contour: 'A continuous-line drawing: one line traces the outlines, gliding from shape to shape.',
  maze: 'One line winds through a maze that grows from the point you choose.',
};
const DETAIL_LABEL = { spiral: 'Rings', wander: 'Density', contour: 'Detail', maze: 'Corridors' };
function showLineControls() {
  const t = doc.line.technique;
  const path = doc.line.path;
  const free = path !== 'spiral';
  const maze = path === 'maze';
  $('mazeCtl').hidden = !free;
  $('spinRow').hidden = free;
  for (const el of document.querySelectorAll('.maze-only')) el.hidden = !maze;
  $('pathHelp').textContent = PATH_HELP[path];
  lineSliders.rings.el.querySelector('label').textContent = DETAIL_LABEL[path];
  // wave squiggles only make sense on a regular path; free lines already wander
  for (const b of document.querySelectorAll('[data-bind="technique"] [role="radio"]')) b.disabled = (path === 'wander' || path === 'contour') && b.dataset.v !== 'thickness';
  lineSliders.edgeFade.el.querySelector('label').textContent = 'Edge fade';
  // the pen always starts at the chosen point in a maze; "draw from" only means something for spirals
  for (const b of document.querySelectorAll('[data-bind="start"] [role="radio"]')) b.disabled = free;
  for (const b of document.querySelectorAll('[data-film="start"] [role="radio"]')) b.disabled = free;
  const show = { rings: 1, weight: t !== 'wave', penWidth: t !== 'thickness', amplitude: t !== 'thickness', frequency: t !== 'thickness', wobble: 1 };
  for (const [k, s] of Object.entries(lineSliders)) {
    if (k in show) s.el.hidden = !show[k];
  }
  lineSliders.hairline.el.hidden = t === 'wave';
  $('techHelp').textContent = TECH_HELP[t];
}
const PATH_NAME = { spiral: 'Spiral', wander: 'Wander', contour: 'Contour', maze: 'Maze' };
const pathSeg = bindSeg(document.querySelector('[data-bind="path"]'), doc.line.path, v => {
  change(d => {
    d.line.path = v;
    // free lines need a solid stroke; the wave technique is kept for spirals and mazes
    if ((v === 'wander' || v === 'contour') && d.line.technique !== 'thickness') d.line.technique = 'thickness';
  }, { label: PATH_NAME[v], thumbs: true });
  announce(v === 'spiral' ? 'Spiral path' : `${PATH_NAME[v]} path. Choose a start point on the sheet.`);
  if (v !== 'spiral') picking.flash = performance.now() + 1800;
  if (!reducedMotion()) { play.f = 0; setPlaying(true, { demo: true }); }
});
const shapeSeg = bindSeg(document.querySelector('[data-bind="shape"]'), doc.free.shape, v =>
  change(d => { d.free.shape = v; }, { label: `Maze: ${v}`, thumbs: true }));
$('btnNewMaze').addEventListener('click', () => change(d => { d.free.seed = ((d.free.seed || 1) % 9973) + 1; }, { label: 'New layout', thumbs: true }));
const mazeSliders = {};
{
  const s = sliderRow({
    label: 'Follow the photo', min: 0, max: 1, step: 0.01, def: 0.8, value: doc.free.flow,
    format: v => `${Math.round(v * 100)}%`, toEdit: v => Math.round(v * 100), fromEdit: v => v / 100,
    hint: 'How strongly the corridors run along the shapes in the photo',
    onInput: (v, dragging) => change(d => { d.free.flow = v; }, { live: dragging }),
    onCommit: () => { commit('Maze flow'); invalidate('geom'); refreshThumbs(); },
  });
  mazeSliders.flow = s;
  $('mazeSliders').append(s.el);
}

// choosing the maze start point on the sheet
const picking = { active: false, hover: null, flash: 0 };
function setPicking(on) {
  if (on && (!photo || framing.active)) return;
  picking.active = on;
  picking.hover = null;
  $('sheet').classList.toggle('picking', on);
  $('pickHint').hidden = !on;
  $('btnPickStart').setAttribute('aria-pressed', String(on));
  if (on) { finishDemo(); setPlaying(false); play.f = 1; announce('Click or tap the sheet where the line should start. Escape cancels.'); }
  invalidate('render');
}
function sheetPointToCircle(e) {
  const r = $('sheet').getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width - LAYOUT.cx) / LAYOUT.r;
  const y = ((e.clientY - r.top) / r.width - LAYOUT.cy) / LAYOUT.r;
  return [clamp(x, -1, 1), clamp(y, -1, 1)];
}
$('btnPickStart').addEventListener('click', () => setPicking(!picking.active));
$('sheet').addEventListener('pointermove', e => { if (picking.active) { picking.hover = sheetPointToCircle(e); invalidate('render'); } });
$('sheet').addEventListener('pointerleave', () => { if (picking.active) { picking.hover = null; invalidate('render'); } });
$('sheet').addEventListener('pointerdown', e => {
  if (!picking.active) return;
  e.preventDefault();
  e.stopPropagation();
  const [x, y] = sheetPointToCircle(e);
  setPicking(false);
  picking.flash = performance.now() + 1800;
  change(d => { d.free.x = +x.toFixed(4); d.free.y = +y.toFixed(4); }, { label: 'Start point', thumbs: true });
  // show the new maze growing from the chosen point
  if (!reducedMotion()) { play.f = 0; setPlaying(true, { demo: true }); }
}, true);
const techSeg = bindSeg(document.querySelector('[data-bind="technique"]'), doc.line.technique, v =>
  change(d => { d.line.technique = v; }, { label: `Technique: ${v}`, thumbs: true }));
const dirSeg = bindSeg(document.querySelector('[data-bind="direction"]'), doc.line.direction, v =>
  change(d => { d.line.direction = v; }, { label: 'Spin' }));
$('btnShuffle').addEventListener('click', () => change(d => { d.line.seed = ((d.line.seed || 1) % 997) + 1; }, { label: 'Shuffle wobble' }));
$('lineReset').addEventListener('click', () => {
  const look = lookById(doc.look);
  change(d => { d.line = { ...LINE_DEFAULTS, ...look.line, path: look.line.path || d.line.path, direction: d.line.direction, start: d.line.start, seed: d.line.seed }; },
    { label: 'Reset line', thumbs: true });
});

function updateStat() {
  const el = $('lineStat');
  if (!geom) { el.textContent = ''; return; }
  const m = printedLength(geom, CIRCLE_MM);
  const what = { spiral: `<b>${geom.rings}</b> rings · `, maze: `<b>${geom.rings}</b> corridors · `, contour: `<b>${geom.outlines}</b> strokes · ` }[geom.path] || '';
  el.innerHTML = `One line · ${what}<b>${m >= 10 ? m.toFixed(0) : m.toFixed(1)} m</b> long at ${(CIRCLE_MM / 10).toFixed(0)} cm`;
}

// ------------------------------------------------------------------------------------ inspector: photo
const photoSliders = {};
function buildPhotoSliders() {
  const host = $('photoSliders');
  const T = TONE_DEFAULTS;
  const mk = (key, o) => {
    const s = sliderRow({
      ...o, value: doc.tone[key],
      onInput: (v, dragging) => change(d => { d.tone[key] = v; }, { live: dragging }),
      onCommit: () => { commit(o.label); invalidate('geom'); refreshThumbs(); },
    });
    photoSliders[key] = s;
    host.append(s.el);
  };
  const pct = v => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;
  mk('darkness', { label: 'Darkness', min: -1, max: 1, step: 0.01, def: T.darkness, format: pct,
    toEdit: v => Math.round(v * 100), fromEdit: v => v / 100, hint: 'How much ink the drawing uses overall' });
  mk('contrast', { label: 'Contrast', min: -1, max: 1, step: 0.01, def: T.contrast, format: pct,
    toEdit: v => Math.round(v * 100), fromEdit: v => v / 100 });
  mk('detail', { label: 'Detail', min: 0, max: 1, step: 0.01, def: T.detail, format: v => `${Math.round(v * 100)}%`,
    toEdit: v => Math.round(v * 100), fromEdit: v => v / 100, hint: 'Local contrast: brings out features like eyes' });
  mk('brightness', { label: 'Brightness', min: -1, max: 1, step: 0.01, def: T.brightness, format: pct,
    toEdit: v => Math.round(v * 100), fromEdit: v => v / 100 });
}
const autoToggle = document.querySelector('[data-bind="auto"]');
const invertToggle = document.querySelector('[data-bind="invert"]');
autoToggle.addEventListener('change', () => change(d => { d.tone.auto = autoToggle.checked; }, { label: 'Auto tone', thumbs: true }));
invertToggle.addEventListener('change', () => change(d => { d.tone.invert = invertToggle.checked; }, { label: 'Invert tones', thumbs: true }));
$('photoReset').addEventListener('click', () => change(d => { d.tone = { ...TONE_DEFAULTS }; }, { label: 'Reset photo', thumbs: true }));

// ------------------------------------------------------------------------------------ sync UI from doc
function syncControls() {
  const b = brush(), p = paper();
  setChecked([...looksEl.children], el => el.dataset.id === doc.look);
  const edited = lookEdited();
  for (const el of looksEl.children) {
    el.querySelector('.dot')?.remove();
    if (el.dataset.id === doc.look && edited) {
      const dot = document.createElement('span'); dot.className = 'dot'; dot.title = 'Edited';
      el.querySelector('.thumb').append(dot);
    }
  }
  $('lookValue').textContent = `${lookById(doc.look).name}${edited ? ' · Edited' : ''}`;
  $('lookRevert').hidden = !edited;
  setChecked([...toolsEl.children], el => el.dataset.id === doc.brush);
  $('toolValue').textContent = b.name;
  if (inksEl.dataset.brush !== b.id) { buildInks(); inksEl.dataset.brush = b.id; }
  setChecked([...inksEl.children], el => doc.inkSource === 'photo' ? el.dataset.src === 'photo'
    : doc.inkSource === 'custom' ? el.dataset.src === 'custom' : el.dataset.hex === doc.ink);
  const custom = inksEl.querySelector('.custom');
  if (custom) {
    custom.style.background = doc.inkSource === 'custom' ? doc.ink : '';
    const inp = custom.querySelector('input');
    if (inp.value !== doc.ink) inp.value = doc.ink;
  }
  setChecked([...papersEl.children], el => el.dataset.id === doc.paper);
  $('paperValue').textContent = p.name;

  pathSeg.set(doc.line.path);
  shapeSeg.set(doc.free.shape);
  mazeSliders.flow.set(doc.free.flow);
  techSeg.set(doc.line.technique);
  dirSeg.set(doc.line.direction);
  for (const s of Object.values(lineSliders)) s.set(s.get());
  showLineControls();
  const look = lookById(doc.look);
  $('lineReset').hidden = !Object.entries(look.line).some(([k, v]) => doc.line[k] !== v);

  autoToggle.checked = !!doc.tone.auto;
  invertToggle.checked = !!doc.tone.invert;
  for (const [k, s] of Object.entries(photoSliders)) s.set(doc.tone[k]);
  photoSliders.brightness.el.hidden = !!doc.tone.auto;
  $('photoReset').hidden = JSON.stringify(doc.tone) === JSON.stringify({ ...TONE_DEFAULTS, ...{} });
  $('flipNote').hidden = !mode().flip;
  startSeg.set(doc.line.start);
  pacingSeg.set(prefs.pacing);
  updateHints();
  updateArtLabel();
}

function updateHints() {
  const b = brush(), p = paper(), m = mode();
  const th = $('toolHint'), ph = $('paperHint');
  th.hidden = ph.hidden = true;
  let hint = null;
  if (b.prefersDark && !p.dark) {
    const alt = paperById(b.id === 'chalk' ? 'chalkboard' : 'black');
    hint = { text: `${b.name} needs a dark sheet.`, label: `Use ${alt.name}`, run: () => setPaper(alt.id) };
  } else if (m.lowContrast) {
    const pap = hexToRgb(p.color);
    const [bestHex, bestName] = b.inks.reduce((a, c) => (contrastRatio(hexToRgb(c[0]), pap) > contrastRatio(hexToRgb(a[0]), pap) ? c : a));
    const what = doc.inkSource === 'custom' ? 'This' : inkName(b, doc.ink);
    if (contrastRatio(hexToRgb(bestHex), pap) >= 3) {
      hint = { text: `${what} ink won't show on ${p.name}.`, label: `Use ${bestName} ink`,
        run: () => change(d => { d.ink = bestHex; d.inkSource = 'swatch'; }, { label: `Ink: ${bestName}`, thumbs: true }) };
    } else {
      const alt = paperById(p.dark ? 'sketch' : 'black');
      hint = { text: `${b.name} won't show on ${p.name}.`, label: `Use ${alt.name}`, run: () => setPaper(alt.id) };
    }
  }
  if (!hint) return;
  // the same hint under the tools and under the papers (on phones only one tab is visible)
  for (const el of [th, ph]) {
    el.hidden = false;
    el.replaceChildren();
    const span = document.createElement('span'); span.textContent = hint.text;
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'text-btn'; btn.textContent = hint.label;
    btn.addEventListener('click', hint.run);
    el.append(span, btn);
  }
}
function inkName(b, hex) { return (b.inks.find(([h]) => h === hex) || [hex, 'This'])[1]; }

function updateArtLabel() {
  clearTimeout(updateArtLabel.t);
  updateArtLabel.t = setTimeout(() => {
    const what = photo ? (photo.sample ? `The ${photo.name} sample` : 'Your photo') : 'A blank sheet';
    art.setAttribute('aria-label', photo
      ? `${what} drawn as one spiral line with a ${brush().name.toLowerCase()} in ${photoColor() ? 'colours from the photo' : inkName(brush(), doc.ink).toLowerCase() + ' ink'} on ${paper().name} paper, ${doc.line.rings} rings.`
      : 'A blank sheet of paper');
  }, 1000);
}

// ------------------------------------------------------------------------------------ thumbnails
const previewGeoms = {};
const thumbCache = {};
function thumbField(fl, rings) {
  const rk = keyOf(photo.id, doc.crop, 512);
  if (thumbCache.rk !== rk) { thumbCache.raster = rasterize(photo.canvas, doc.crop, 512); thumbCache.rk = rk; thumbCache.tones = new Map(); thumbCache.fields = new Map(); }
  const tk = keyOf(doc.tone, fl);
  if (!thumbCache.tones.has(tk)) thumbCache.tones.set(tk, processTone(thumbCache.raster, doc.tone, { flip: fl }));
  const fk = keyOf(tk, rings);
  if (!thumbCache.fields.has(fk)) thumbCache.fields.set(fk, buildField(thumbCache.raster, thumbCache.tones.get(tk).L, { rings, flip: fl }));
  return thumbCache.fields.get(fk);
}

function refreshThumbs(photoChanged = false) {
  if (photoChanged) delete thumbCache.rk;
  const dpr = DPR();
  // looks: rendered from the user's photo
  if (photo) {
    for (const el of looksEl.children) {
      const look = lookById(el.dataset.id);
      const canvas = el.querySelector('canvas');
      const size = Math.round((canvas.clientWidth || 96) * dpr);
      const b = brushById(look.brush), p = paperById(look.paper);
      const m = inkMode(b, look.ink, p);
      const fl = m.flip !== !!doc.tone.invert;
      thumbs.add({
        canvas, key: keyOf('look', look.id, photo.id, doc.crop, doc.tone, size, look.line.path || doc.line.path, doc.free), width: size, height: size,
        render: r => {
          const rings = Math.max(18, Math.min(look.line.rings, Math.round(size * LAYOUT.r / 2.6)));
          const lineSet = { ...LINE_DEFAULTS, ...look.line, rings, start: 'center' };
          const g = buildPath(look.line.path || doc.line.path, thumbField(fl, rings), lineSet, { ...doc.free, ...look.free }, { draft: true });
          r.setLayout(LAYOUT); r.setPaper(p, 1);
          r.setStyle({ brush: b, ink: look.ink, cover: m.cover, photoColor: false });
          r.setGeometry(g); r.render(Infinity);
        },
      }, look.id === doc.look);
    }
  }
  // tool chips: a spiral fragment in each tool, on the current paper
  const p = paper();
  for (const el of toolsEl.children) {
    const b = brushById(el.dataset.id);
    const canvas = el.querySelector('canvas');
    const w = Math.round((canvas.clientWidth || 70) * dpr), h = Math.round((canvas.clientHeight || 52) * dpr);
    const pp = chipPaperFor(b, p);
    const ink = photoColor() ? b.inks[0][0] : inkFor(b, pp);
    const m = inkMode(b, ink, pp);
    const tech = doc.line.technique === 'wave' ? 'wave' : 'thickness';
    thumbs.add({
      canvas, key: keyOf('tool', b.id, pp.id, ink, tech, w, h), width: w, height: h,
      render: r => {
        const g = previewGeoms[tech] || (previewGeoms[tech] = previewStroke({ technique: tech }));
        // a close-up of the drawing: arcs of the outer rings sweeping across from a corner
        r.setLayout({ cx: -0.05, cy: 1.08 * h / w, r: 1.12 }); r.setPaper(pp, 1);
        r.setStyle({ brush: b, ink, cover: m.cover, photoColor: false });
        r.setGeometry(g); r.render(Infinity);
      },
    });
  }
  // paper chips: the sheet itself with a short stroke of the current tool when it shows
  const b = brush();
  for (const el of papersEl.children) {
    const pp = paperById(el.dataset.id);
    const canvas = el.querySelector('canvas');
    const s = Math.round((canvas.clientWidth || 64) * dpr);
    const ink = photoColor() ? b.inks[0][0] : inkFor(b, pp);
    const m = inkMode(b, ink, pp);
    thumbs.add({
      canvas, key: keyOf('paper', pp.id, b.id, ink, s), width: s, height: s,
      render: r => {
        const g = previewGeoms.fine || (previewGeoms.fine = previewStroke({ technique: 'thickness', ringsVisible: 9, turns: 2 }));
        r.setLayout({ cx: -0.1, cy: 1.1, r: 1.25 }); r.setPaper(pp, 1);
        r.setStyle({ brush: b, ink, cover: m.cover, photoColor: false });
        r.setGeometry(g);
        if (m.lowContrast || (b.prefersDark && !pp.dark)) r.renderBlank(); else r.render(Infinity);
      },
    });
  }
}

let idleTimer = 0;
function scheduleIdleWork() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (need.penSees) { need.penSees = false; drawPenSees(); }
  }, 120);
}

// ------------------------------------------------------------------------------------ photos
async function setPhoto(img, { sample = false, crop = null, demo = true, announceIt = true } = {}) {
  photo = { ...img, id: ++photoSeq, sample };
  doc.crop = crop ? { ...CROP_DEFAULTS, ...crop } : autoCrop(img);
  delete thumbCache.rk;
  $('fileName').textContent = sample ? `${img.name} (sample)` : img.name;
  geom = null;
  invalidate('geom');
  history.reset(snapshot());
  syncControls();
  refreshThumbs(true);
  if (demo && !reducedMotion()) { play.f = 0; setPlaying(true, { demo: true }); }
  else { play.f = 1; setPlaying(false); }
  if (announceIt) announce(sample ? `${img.name} sample loaded` : 'Photo loaded');
  if (img.small) toast('This photo is small, so the drawing may look soft.');
  if (!sample) saveSession();
}

async function saveSession() {
  if (!photo || photo.sample) return;
  clearTimeout(saveSession.t);
  saveSession.t = setTimeout(async () => {
    try {
      if (!photo.blob) photo.blob = await encodeForStorage(photo.canvas);
      await savePhoto({ blob: photo.blob, name: photo.name, crop: doc.crop, savedAt: Date.now() });
    } catch { /* storage is best-effort */ }
  }, 500);
}

let loading = 0;
async function openFile(file) {
  const t = setTimeout(() => { $('busy').hidden = false; toast('Reading your photo…'); }, 300);
  const my = ++loading;
  try {
    const img = await decodeImage(file);
    if (my !== loading) return;
    hideWelcome();
    await setPhoto(img);
    // flat-photo check after the first tone pass
    requestAnimationFrame(() => { if (cache.tone?.stats?.flat) toast('This photo is very flat — one with a clear subject works best.'); });
  } catch (e) {
    console.warn(e);
    toast(imageErrorMessage(e), { error: true });
    announce(imageErrorMessage(e), true);
  } finally {
    clearTimeout(t);
    $('busy').hidden = true;
  }
}

async function openSample(id, opts = {}) {
  try {
    const { makeSample, SAMPLES } = await import('./samples.js');
    const meta = SAMPLES.find(s => s.id === id) || SAMPLES[0];
    const canvas = await makeSample(meta.id, 1024);
    const img = fromDrawable(canvas, meta.name);
    await setPhoto(img, { sample: true, ...opts });
    return true;
  } catch (e) {
    console.warn('sample failed', e);
    return false;
  }
}

const fileInput = $('fileInput');
function pickFile() { fileInput.value = ''; fileInput.click(); }
fileInput.addEventListener('change', () => { if (fileInput.files[0]) openFile(fileInput.files[0]); });
for (const id of ['btnOpen', 'btnChoose', 'mOpen']) $(id).addEventListener('click', pickFile);

// drag and drop anywhere
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('dropzone').hidden = false; });
window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropzone').hidden = true; });
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('dropzone').hidden = true;
  const files = [...e.dataTransfer.files];
  const img = files.find(f => f.type.startsWith('image/')) || files[0];
  if (files.length > 1) toast('Using the first photo.');
  if (img) openFile(img);
});
window.addEventListener('paste', e => {
  if (e.target.closest?.('input, textarea')) return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.kind === 'file' && i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  const f = item.getAsFile();
  if (f) openFile(new File([f], f.name || 'pasted image.png', { type: f.type }));
});

// ------------------------------------------------------------------------------------ welcome
function hideWelcome() {
  $('welcome').hidden = true;
  document.body.classList.remove('welcoming');
  layoutStage();
  if (!prefs.visited) { prefs.visited = true; persist(); }
}
async function buildSamples() {
  let mod;
  try { mod = await import('./samples.js'); } catch { return; }
  const host = $('samples');
  for (const s of mod.SAMPLES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sample';
    b.innerHTML = '<canvas width="56" height="56" aria-hidden="true"></canvas><span></span>';
    b.querySelector('span').textContent = s.name;
    b.title = s.alt || s.name;
    b.addEventListener('click', async () => { hideWelcome(); await openSample(s.id); });
    host.append(b);
    mod.makeSample(s.id, 128).then(c => b.querySelector('canvas').getContext('2d').drawImage(c, 0, 0, 56, 56)).catch(() => {});
  }
}

// ------------------------------------------------------------------------------------ framing
const framing = { active: false, start: null, pointers: new Map(), gesture: null };
const sheet = $('sheet');
const frZoom = $('frZoom');
const ZMIN = 0.5, ZMAX = 6;
const zoomToSlider = z => Math.round(Math.log(z / ZMIN) / Math.log(ZMAX / ZMIN) * 1000);
const sliderToZoom = v => ZMIN * Math.pow(ZMAX / ZMIN, v / 1000);

function enterFraming() {
  if (!photo || framing.active) return;
  finishDemo();
  setPlaying(false);
  play.f = 1;
  framing.active = true;
  framing.start = { ...doc.crop };
  sheet.classList.add('framing');
  $('btnFrame').setAttribute('aria-pressed', 'true');
  $('frameBar').hidden = false;
  $('transport').hidden = true;
  frZoom.value = zoomToSlider(doc.crop.zoom); paintRange(frZoom);
  invalidate('render');
  announce('Framing. Drag to move the photo, scroll or pinch to zoom. Enter to finish, Escape to cancel.');
  sheet.focus?.();
}
function exitFraming(apply) {
  if (!framing.active) return;
  framing.active = false;
  sheet.classList.remove('framing', 'dragging');
  $('btnFrame').setAttribute('aria-pressed', 'false');
  $('frameBar').hidden = true;
  $('transport').hidden = false;
  if (!apply) doc.crop = framing.start;
  invalidate('geom');
  if (apply && JSON.stringify(framing.start) !== JSON.stringify(doc.crop)) { commit('Framing'); refreshThumbs(true); }
  $('btnFrame').focus();
}
function cropPan(dxPx, dyPx) {
  // screen px on the sheet -> image normalised coords (inverse of the rasterize transform)
  const Rpx = LAYOUT.r * sheetCss;
  const diam = cropDiameter(photo.width, photo.height, doc.crop);
  const k = (diam / 2) / Rpx;
  const a = -(doc.crop.rotation || 0) * Math.PI / 180;
  const ix = (dxPx * Math.cos(a) - dyPx * Math.sin(a)) * k;
  const iy = (dxPx * Math.sin(a) + dyPx * Math.cos(a)) * k;
  doc.crop.x = clamp(doc.crop.x - ix / photo.width, -0.5, 1.5);
  doc.crop.y = clamp(doc.crop.y - iy / photo.height, -0.5, 1.5);
}
function cropZoom(factor, anchorPx = null) {
  const z0 = doc.crop.zoom, z1 = clamp(z0 * factor, ZMIN, ZMAX);
  if (anchorPx) {
    // keep the photo point under the pointer fixed
    const [ax, ay] = anchorPx;
    const s = 1 - z0 / z1;
    cropPan(-ax * s, -ay * s);
  }
  doc.crop.zoom = z1;
  frZoom.value = zoomToSlider(z1); paintRange(frZoom);
}
function relToCircle(e) {
  const r = sheet.getBoundingClientRect();
  return [e.clientX - (r.left + LAYOUT.cx * r.width), e.clientY - (r.top + LAYOUT.cy * r.width)];
}
sheet.addEventListener('pointerdown', e => {
  if (!framing.active) return;
  sheet.setPointerCapture(e.pointerId);
  framing.pointers.set(e.pointerId, [e.clientX, e.clientY]);
  sheet.classList.add('dragging');
});
sheet.addEventListener('pointermove', e => {
  if (!framing.active || !framing.pointers.has(e.pointerId)) return;
  const prev = framing.pointers.get(e.pointerId);
  const pts = [...framing.pointers.values()];
  if (framing.pointers.size === 1) {
    cropPan(e.clientX - prev[0], e.clientY - prev[1]);
  } else if (framing.pointers.size === 2) {
    const other = pts.find(p => p !== prev);
    const d0 = Math.hypot(prev[0] - other[0], prev[1] - other[1]);
    const d1 = Math.hypot(e.clientX - other[0], e.clientY - other[1]);
    const a0 = Math.atan2(prev[1] - other[1], prev[0] - other[0]);
    const a1 = Math.atan2(e.clientY - other[1], e.clientX - other[0]);
    const r = sheet.getBoundingClientRect();
    const mid = [(e.clientX + other[0]) / 2 - (r.left + LAYOUT.cx * r.width), (e.clientY + other[1]) / 2 - (r.top + LAYOUT.cy * r.width)];
    if (d0 > 4) cropZoom(d1 / d0, mid);
    let rot = (doc.crop.rotation || 0) + (a1 - a0) * 180 / Math.PI;
    for (const snap of [-180, -90, 0, 90, 180]) if (Math.abs(rot - snap) < 4) rot = snap;
    doc.crop.rotation = ((rot + 540) % 360) - 180;
  }
  framing.pointers.set(e.pointerId, [e.clientX, e.clientY]);
  invalidate('draft');
});
const endPointer = e => {
  if (!framing.pointers.delete(e.pointerId)) return;
  if (!framing.pointers.size) { sheet.classList.remove('dragging'); invalidate('geom'); }
};
sheet.addEventListener('pointerup', endPointer);
sheet.addEventListener('pointercancel', endPointer);
sheet.addEventListener('wheel', e => {
  if (!framing.active) return;
  e.preventDefault();
  cropZoom(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)), relToCircle(e));
  invalidate('draft');
  clearTimeout(sheet.wheelT);
  sheet.wheelT = setTimeout(() => invalidate('geom'), 160);
}, { passive: false });
sheet.addEventListener('dblclick', () => { if (!framing.active) enterFraming(); });
frZoom.addEventListener('input', () => { doc.crop.zoom = sliderToZoom(+frZoom.value); paintRange(frZoom); invalidate('draft'); });
frZoom.addEventListener('change', () => invalidate('geom'));
$('frRotate').addEventListener('click', () => { doc.crop.rotation = (((doc.crop.rotation || 0) + 90 + 180) % 360) - 180; invalidate('geom'); });
$('frFit').addEventListener('click', () => { doc.crop = autoCrop(photo); frZoom.value = zoomToSlider(doc.crop.zoom); paintRange(frZoom); invalidate('geom'); });
$('frCancel').addEventListener('click', () => exitFraming(false));
$('frDone').addEventListener('click', () => exitFraming(true));
$('btnFrame').addEventListener('click', () => (framing.active ? exitFraming(true) : enterFraming()));
$('btnFrame2').addEventListener('click', () => enterFraming());

// ------------------------------------------------------------------------------------ compare
function setCompare(on) {
  if (!photo || framing.active) return;
  view.compare = on ? 1 : 0;
  $('btnCompare').classList.toggle('on', on);
  invalidate('render');
}
const cmp = $('btnCompare');
cmp.addEventListener('pointerdown', e => { e.preventDefault(); setCompare(true); });
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) cmp.addEventListener(ev, () => setCompare(false));
cmp.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setCompare(true); } });
cmp.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') setCompare(false); });
// long-press on the sheet compares on touch
let lpTimer = 0;
sheet.addEventListener('pointerdown', e => {
  if (framing.active || e.pointerType !== 'touch') return;
  lpTimer = setTimeout(() => setCompare(true), 450);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) sheet.addEventListener(ev, () => { clearTimeout(lpTimer); if (view.compare) setCompare(false); });
sheet.addEventListener('contextmenu', e => { if (isTouch()) e.preventDefault(); });
// tapping the sheet finishes the reveal
sheet.addEventListener('click', () => { if (play.demo) finishDemo(); });

const pen = $('penSees');
pen.addEventListener('pointerdown', e => { e.preventDefault(); view.penSees = true; invalidate('render'); });
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) pen.addEventListener(ev, () => { view.penSees = false; invalidate('render'); });

// ------------------------------------------------------------------------------------ playback menu
popover($('btnPlayMenu'), $('playMenu'));
const pacingSeg = bindSeg(document.querySelector('[data-bind="pacing"]'), prefs.pacing, v => { prefs.pacing = v; persist(); invalidate('render'); });
const startSeg = bindSeg(document.querySelector('[data-bind="start"]'), doc.line.start, v => change(d => { d.line.start = v; }, { label: 'Draw from' }));
bindSeg(document.querySelector('[data-bind="speed"]'), String(prefs.speed), v => { prefs.speed = +v; persist(); });
const showToolEl = document.querySelector('[data-bind="showTool"]');
showToolEl.checked = prefs.showTool;
showToolEl.addEventListener('change', () => { prefs.showTool = showToolEl.checked; persist(); invalidate('render'); });

// ------------------------------------------------------------------------------------ top menu, theme
const topMenu = popover($('btnMenu'), $('menu'));
function applyTheme() {
  const t = prefs.theme;
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}
bindSeg($('themeSeg'), prefs.theme, v => { prefs.theme = v; applyTheme(); persist(); });
applyTheme();
$('menu').addEventListener('click', async e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  topMenu.close();
  if (act === 'open') pickFile();
  if (act === 'shortcuts') $('keysDialog').showModal();
  if (act === 'forget') { await forgetPhoto(); toast('Your saved photo was removed from this browser.'); $('btnContinue').hidden = true; }
  if (act === 'reset') {
    if (!confirm('Reset every setting and forget the saved photo?')) return;
    clearSettings(); await forgetPhoto(); location.reload();
  }
});

// ------------------------------------------------------------------------------------ mobile tabs
const tabs = [...document.querySelectorAll('#tabs [role="tab"]')];
function selectTab(name) {
  for (const t of tabs) { const on = t.dataset.tab === name; t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; }
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.dataset.panel === name);
  refreshThumbs();
}
for (const t of tabs) t.addEventListener('click', () => selectTab(t.dataset.tab));
$('tabs').addEventListener('keydown', e => {
  const i = tabs.findIndex(t => t.getAttribute('aria-selected') === 'true');
  const j = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : -1;
  if (j >= 0) { e.preventDefault(); tabs[j].focus(); selectTab(tabs[j].dataset.tab); }
});

// ------------------------------------------------------------------------------------ dialogs
let dialogs = null;
async function loadDialogs() {
  if (!dialogs) {
    const [film, dl] = await Promise.all([import('./film.js'), import('./download.js')]);
    const ctx = {
      get doc() { return doc; }, get prefs() { return prefs; }, get photo() { return photo; },
      get geom() { return geom; }, renderState, persist, layout: LAYOUT,
      geometryWith(overrides) {
        const saveLine = doc.line;
        doc.line = { ...doc.line, ...overrides };
        try { return computeGeometry(false); } finally { doc.line = saveLine; }
      },
      drawPhotoInCircle(ctx2, cx, cy, R) { if (photo) drawPhotoInCircle(ctx2, cx, cy, R); },
      pause() { finishDemo(); setPlaying(false); },
      refreshTransport() { invalidate('render'); },
      lookName: () => lookById(doc.look).name,
      inkName: () => (photoColor() ? 'photo colours' : inkName(brush(), doc.ink)),
    };
    dialogs = { film: film.createFilmDialog(ctx), download: dl.createDownloadDialog(ctx) };
  }
  return dialogs;
}
async function openFilm() {
  if (!geom) return toast('Choose a photo first.');
  (await loadDialogs()).film.open();
}
async function openDownload(quick = false) {
  if (!geom) return toast('Choose a photo first.');
  const d = (await loadDialogs()).download;
  quick ? d.quick() : d.open();
}
$('btnFilm').addEventListener('click', openFilm);
$('mFilm').addEventListener('click', openFilm);
$('btnDownload').addEventListener('click', () => openDownload());
$('mSave').addEventListener('click', () => openDownload());

// ------------------------------------------------------------------------------------ keyboard
const typing = t => t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName) && !['range', 'checkbox', 'radio', 'button'].includes(t.type));
const onBody = t => !t || t === document.body || t === sheet || t.closest?.('.stage') && !t.closest('button, input');
window.addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  if (mod && (k === 'z' || k === 'Z')) { if (typing(e.target)) return; e.preventDefault(); (e.shiftKey ? $('btnRedo') : $('btnUndo')).click(); return; }
  if (mod && (k === 'y' || k === 'Y')) { if (typing(e.target)) return; e.preventDefault(); $('btnRedo').click(); return; }
  if (mod && (k === 'o' || k === 'O')) { e.preventDefault(); pickFile(); return; }
  if (mod && (k === 's' || k === 'S')) { e.preventDefault(); openDownload(true); return; }
  if (mod || e.altKey || typing(e.target)) return;
  if (picking.active && k === 'Escape') { e.preventDefault(); setPicking(false); return; }
  if (framing.active) {
    if (k === 'Enter') { e.preventDefault(); exitFraming(true); }
    else if (k === 'Escape') { e.preventDefault(); exitFraming(false); }
    else if (k.startsWith('Arrow')) {
      e.preventDefault();
      const step = (e.shiftKey ? 0.1 : 0.01) * LAYOUT.r * sheetCss * 2;
      cropPan(k === 'ArrowLeft' ? step : k === 'ArrowRight' ? -step : 0, k === 'ArrowUp' ? step : k === 'ArrowDown' ? -step : 0);
      invalidate('geom');
    } else if (k === '+' || k === '=') { cropZoom(1.1); invalidate('geom'); }
    else if (k === '-') { cropZoom(1 / 1.1); invalidate('geom'); }
    return;
  }
  if (k === ' ' && onBody(e.target)) { e.preventDefault(); $('btnPlay').click(); return; }
  if ((k === 'ArrowLeft' || k === 'ArrowRight') && onBody(e.target) && geom) {
    e.preventDefault(); finishDemo(); setPlaying(false);
    play.f = clamp(play.f + (k === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 5 : 1) / drawSec(), 0, 1);
    invalidate('render'); return;
  }
  if ((k === 'Home' || k === 'End') && onBody(e.target) && geom) { e.preventDefault(); finishDemo(); setPlaying(false); play.f = k === 'Home' ? 0 : 1; invalidate('render'); return; }
  if (k === '\\') { e.preventDefault(); if (!e.repeat) setCompare(true); return; }
  if (k === 'f' || k === 'F') { e.preventDefault(); enterFraming(); return; }
  if (k === 'r' || k === 'R') { e.preventDefault(); openFilm(); return; }
  if (k === '?') { e.preventDefault(); $('keysDialog').showModal(); return; }
  if (/^[1-9]$/.test(k) && LOOKS[+k - 1]) { e.preventDefault(); applyLook(LOOKS[+k - 1].id); return; }
  if (k === '[' || k === ']') {
    e.preventDefault();
    const r = clamp(doc.line.rings + (k === ']' ? 10 : -10), 20, 160);
    change(d => { d.line.rings = r; }, { label: 'Rings', thumbs: true });
    announce(`${r} rings`);
  }
});
window.addEventListener('keyup', e => { if (e.key === '\\') setCompare(false); });

// ------------------------------------------------------------------------------------ boot
async function boot() {
  buildLooks();
  buildTools();
  buildInks();
  inksEl.dataset.brush = doc.brush;
  buildPapers();
  buildLineSliders();
  buildPhotoSliders();
  selectTab('looks');
  layoutStage();
  history.reset(snapshot());
  syncControls();
  refreshThumbs();
  renderer.setLayout(LAYOUT);
  applyRendererState();
  renderer.renderBlank();

  const session = await loadPhoto();
  const welcome = $('welcome');
  welcome.hidden = false;
  document.body.classList.add('welcoming');
  buildSamples();
  layoutStage();
  if (session?.blob) {
    $('welcomeTitle').innerHTML = 'Welcome <em>back.</em>';
    $('welcomeLede').textContent = 'Your last style is ready. Continue with your photo or choose a new one.';
    const cont = $('btnContinue');
    cont.hidden = false;
    cont.addEventListener('click', async () => {
      try {
        const img = await decodeImage(session.blob, session.name);
        hideWelcome();
        await setPhoto(img, { crop: session.crop });
      } catch (e) { toast(imageErrorMessage(e), { error: true }); }
    }, { once: true });
  }
  starCount().then(n => {
    if (n == null) return;
    const el = $('starCount');
    el.textContent = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    el.hidden = false;
  });
  // the first thing a visitor sees: a sample drawing itself behind the welcome card
  const ok = await openSample('bust', { announceIt: false });
  if (!ok) { renderer.renderBlank(); }
}
boot();

// Offline support after the first visit (skipped on localhost so development never serves stale files).
if ('serviceWorker' in navigator && location.protocol === 'https:' || location.hostname === '127.0.0.1') {
  navigator.serviceWorker?.register('sw.js').catch(() => { /* sandboxed or unsupported: fine */ });
}

// debug / test hooks
window.SP = {
  get doc() { return doc; }, get prefs() { return prefs; }, get geom() { return geom; }, get photo() { return photo; },
  get toneStats() { return cache.tone?.stats; },
  play, renderer, change, applyLook, setBrush, setPaper, openSample, enterFraming, exitFraming,
  openFilm, openDownload, invalidate, renderState, history,
  async shot(name = 'app') {
    const data = art.toDataURL('image/png');
    return (await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data }) })).json();
  },
};
