// Ink macro bench (S, wet media): 1:1 crops of the wet media at a given sheet density, rendered with
// renderToTexture({ rect }) (the film's close-up path, identical to a crop of a full render).
//   node tests/shoot.mjs "/dev/inkmacro.html?cases=fountain:kraft,brush:sketch;dens=4000;view=420;name=before"
//   cases   brush:paper[:ink] list; dens = sheet width in px the crop stands for (4000 = a 4K export,
//   8000 = the film's macro); view = crop size, px; at = crop centre (sheet fractions); upto = drawing
//   progress (1 = finished and dry); full=1 adds the whole sheet at view px (the preview) per case;
//   light=azimuth,elevation for a raking light.
// Saves shots/ink_<name>.png and reports per-case render times.
import { Renderer } from '../js/renderer.js';
import { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS } from '../js/tone.js';
import { buildSpiral, LINE_DEFAULTS } from '../js/spiral.js';
import { brushById, paperById, inkMode } from '../js/materials.js';
import { makeSample } from '../js/samples.js';

const q = new URLSearchParams(location.search);

async function run() {
  const dens = +(q.get('dens') || 4000), view = +(q.get('view') || 420);
  const [cx, cy] = (q.get('at') || '0.45,0.42').split(',').map(Number);
  const rings = +(q.get('rings') || 64);
  const upto = +(q.get('upto') || 1);
  const full = q.get('full') === '1';
  const cases = (q.get('cases') || 'fountain:kraft,fountain:sketch,fountain:cream,brush:sketch,watercolour:coldpress').split(',');
  const src = await makeSample(q.get('img') || 'bust', 1024);
  const raster = rasterize(src, CROP_DEFAULTS);
  const tone = processTone(raster, TONE_DEFAULTS, {});
  const field = buildField(raster, tone.L, { rings });
  const geom = buildSpiral(field, { ...LINE_DEFAULTS, rings }, {});
  const w = view / dens;
  const rect = [cx - w / 2, cy - w / 2, cx + w / 2, cy + w / 2];
  // cases in a grid, `cols` across (full=1: each case's whole sheet next to its crop)
  const per = full ? 2 : 1, cols = +(q.get('cols') || 3), pad = 22;
  const rowsN = Math.ceil(cases.length / cols);
  const out = document.createElement('canvas');
  out.width = cols * per * view; out.height = rowsN * (view + pad);
  const g = out.getContext('2d');
  g.fillStyle = '#222'; g.fillRect(0, 0, out.width, out.height);
  g.font = '13px system-ui'; g.fillStyle = '#eee';
  const report = [];
  const r = new Renderer(document.createElement('canvas'));
  const gl = r.gl, one = new Uint8Array(4);
  const sync = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one); };
  const upTo = upto >= 1 ? Infinity : upto * (geom.n - 1);
  for (const [i, c] of cases.entries()) {
    const [bid, pid, inkQ] = c.split(':');
    const brush = brushById(bid), paper = paperById(pid);
    const ink = inkQ ? '#' + inkQ : brush.inks[0][0], mode = inkMode(brush, ink, paper);
    const size = full ? view : 1000;
    r.setSize(size, size); r.setLayout({ cx: 0.5, cy: 0.5, r: 0.42 }); r.setPaper(paper, 1);
    r.setStyle({ brush, ink, cover: mode.cover, photoColor: false }); r.setGeometry(geom);
    // light=azimuth,elevation (degrees): a raking light shows the relief (cockle); default = the window light
    if (q.get('light')) { const [az, el] = q.get('light').split(',').map(v => v * Math.PI / 180); r.setLight({ azimuth: az, elevation: el }); } else r.setLight();
    sync();
    let t = performance.now();
    r.render(upTo, upto >= 1 ? {} : { settle: 0 }); sync();
    const stillMs = performance.now() - t;
    const y = Math.floor(i / cols) * (view + pad), x0 = (i % cols) * per * view;
    if (full) g.drawImage(r.canvas, 0, 0, size, size, x0 + view, y + pad, view, view);
    t = performance.now();
    const res = r.renderToTexture(upTo, { ...(upto >= 1 ? {} : { settle: 0 }), rect, size: view });
    sync();
    const rectMs = performance.now() - t;
    // read the texture and place the asked-for rect (the texture has a margin) 1:1
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, res.tex, 0);
    const px = new Uint8Array(res.w * res.h * 4);
    gl.readPixels(0, 0, res.w, res.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb);
    const tc = document.createElement('canvas'); tc.width = res.w; tc.height = res.h;
    const tg = tc.getContext('2d'), im = tg.createImageData(res.w, res.h);
    for (let yy = 0; yy < res.h; yy++) im.data.set(px.subarray((res.h - 1 - yy) * res.w * 4, (res.h - yy) * res.w * 4), yy * res.w * 4);
    tg.putImageData(im, 0, 0);
    const sx = (rect[0] - res.rect[0]) / (res.rect[2] - res.rect[0]) * res.w;
    const sy = (rect[1] - res.rect[1]) / (res.rect[3] - res.rect[1]) * res.h;
    g.drawImage(tc, sx, sy, view, view, x0, y + pad, view, view);
    r.releaseRect();
    g.fillStyle = '#eee';
    g.fillText(`${brush.name} · ${paper.name} · ${dens} px sheet (1 px = ${(200 / dens).toFixed(3)} mm)`, x0 + 6, y + 15);
    report.push({ c, stillMs: +stillMs.toFixed(1), rectMs: +rectMs.toFixed(1) });
  }
  r.destroy();
  const name = 'ink_' + (q.get('name') || 'macro');
  const data = out.toDataURL('image/png');
  await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data }) });
  window.__done = { ok: true, name, report };
}
run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
