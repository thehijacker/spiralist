// Tools in the real film pipeline: js/film.js FilmComposer draws story frames (1080 x 1920) on an
// opaque 2D canvas, exactly as js/encoder.js does ({alpha: false}), with the tool riding the head.
//   /dev/tools_film.html?combos=marker:cream,pencil:sketch,crayon:kraft,chalk:chalkboard
// For each combo it composes the frames around one moment of the drawing (the film fades the tool
// to 0.72..1 with the pen's speed) plus touch-down and lift-off frames, then saves
// shots/tool_film.png: 1:1 crops around the tool, one row per combo. It also composes one frame on
// an opaque and on a transparent canvas and requires them to match: LCD subpixel text (colour
// fringes on the lettering) would only appear on the opaque one. Sets window.__done.
import { FilmComposer } from '../js/film.js';
import { headAt } from '../js/spiral.js';
import * as tools from '../js/tools.js';

const q = new URLSearchParams(location.search);

function canvas(w, h, attrs) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, g: c.getContext('2d', attrs) };
}

async function state(bid, pid) {
  const { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS } = await import('../js/tone.js');
  const { buildSpiral, LINE_DEFAULTS } = await import('../js/spiral.js');
  const { brushById, paperById, inkMode } = await import('../js/materials.js');
  const { makeSample, SAMPLES } = await import('../js/samples.js');
  const brush = brushById(bid), paper = paperById(pid);
  const ink = paper.dark ? (brush.inks.find(([h]) => inkMode(brush, h, paper).flip) || brush.inks[0])[0] : brush.inks[0][0];
  const mode = inkMode(brush, ink, paper);
  const raster = rasterize(await makeSample(SAMPLES[0].id, 1024), CROP_DEFAULTS);
  const tone = processTone(raster, TONE_DEFAULTS, { flip: mode.flip });
  const field = buildField(raster, tone.L, { rings: 40, flip: mode.flip });
  const geom = buildSpiral(field, { ...LINE_DEFAULTS, rings: 40 }, {});
  return { geom, brush, paper, ink, cover: mode.cover, photoColor: false, layout: { cx: 0.5, cy: 0.5, r: 0.42 }, seed: 1 };
}

// where the composer puts the tool's tip in frame i (mirrors FilmComposer.draw: INTRO 0.6 s,
// LIFT 0.45 s; the tool slides in from and out to the lower right)
function toolTip(film, st, i) {
  const INTRO = 0.6, LIFT = 0.45, sec = i / film.fps, size = film.side * 0.3;
  const ease = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  const at = f => { const h = headAt(st.geom, f); return film._toFrame(h.x, h.y); };
  if (sec < INTRO) { const k = ease(sec / INTRO), [x, y] = at(0); return [x + (1 - k) * size * 0.9, y + (1 - k) * size * 0.7]; }
  if (sec < INTRO + film.D) return at(film.pen[i]);
  const k = ease(Math.min(1, (sec - INTRO - film.D) / LIFT)), [x, y] = at(st.geom.n - 1);
  return [x + k * size * 0.9, y + k * size * 0.7];
}

async function run() {
  const combos = (q.get('combos') || 'marker:cream,pencil:sketch,crayon:kraft,chalk:chalkboard').split(',');
  const W = 1080, H = 1920, crop = 420;
  // touch-down, two consecutive drawing frames, lift-off
  const frameIdx = f => [Math.round(f.fps * 0.4), Math.round(f.frames * 0.45), Math.round(f.frames * 0.45) + 1,
    Math.round(f.fps * (0.6 + f.D + 0.15))];
  const out = canvas(crop * 4, crop * combos.length);
  const report = {};
  for (const [ri, combo] of combos.entries()) {
    const [bid, pid] = combo.split(':');
    const st = await state(bid, pid);
    const film = new FilmComposer({ W, H, format: 'story', length: 10, fps: 30, showTool: true, polaroid: false,
      reveal: false, pacing: 'natural', state: st, tools });
    film.prepare();
    const frame = canvas(W, H, { alpha: false });
    const r = report[combo] = { frames: [] };
    for (const [ci, i] of frameIdx(film).entries()) {
      film.draw(i, frame.g);
      const [tx, ty] = toolTip(film, st, i);
      const x0 = Math.round(Math.min(W - crop, Math.max(0, tx - crop * 0.22)));
      const y0 = Math.round(Math.min(H - crop, Math.max(0, ty - crop * 0.12)));
      out.g.drawImage(frame.c, x0, y0, crop, crop, ci * crop, ri * crop, crop, crop);
      r.frames.push(i);
    }
    // the same frame composed on a transparent canvas must match the opaque one exactly
    const i = frameIdx(film)[1];
    const clear = canvas(W, H);
    film.draw(i, frame.g);
    film.draw(i, clear.g);
    const a = frame.g.getImageData(0, 0, W, H).data, b = clear.g.getImageData(0, 0, W, H).data;
    let max = 0, over2 = 0;
    for (let k = 0; k < a.length; k++) { if ((k & 3) === 3) continue; const e = Math.abs(a[k] - b[k]); if (e > max) max = e; if (e > 2) over2++; }
    r.opaqueVsTransparent = { max, over2 };
    film.destroy();
  }
  const res = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name: q.get('shot') || 'tool_film', data: out.c.toDataURL('image/png') }) }).then(x => x.json());
  const ok = Object.values(report).every(r => r.opaqueVsTransparent.max <= 2);
  window.__done = { ok, report, ...res };
}

run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
