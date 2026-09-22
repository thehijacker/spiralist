// Tools lab: contact sheets and checks for js/tools.js, saved through the dev server.
//   /dev/tools.html?sheet=contact            every kind at 3 sizes on cream + black, lift, motion blur
//   /dev/tools.html?sheet=big;bg=black       400 px tools, for close inspection
//   /dev/tools.html?sheet=zoom;size=60       small sprites blown up 4x with nearest-neighbour
//   /dev/tools.html?sheet=inks               every kind in every ink its brush offers
//   /dev/tools.html?sheet=one;kind=pencil;size=600;bg=cream
//   /dev/tools.html?sheet=context            tools on the head of a real spiral render
//   /dev/tools.html?sheet=check              numeric checks (tip, length, DPR, opaque-canvas text, fades,
//                                            motion / maxBlur / seeks, caller state, tiles, bounds, perf)
//   (/dev/tools_film.html: the tools in real FilmComposer frames on an opaque canvas)
// Sets window.__done = { ok, file, ... } for tests/shoot.mjs.
import { TOOL_KINDS, drawTool, drawToolMotion, toolBounds } from '../js/tools.js';

const q = new URLSearchParams(location.search);
const INK = {
  pencil: '#2a2a2e', fineliner: '#17171a', fountain: '#141a3a', crayon: '#c8372d', ballpoint: '#1d3a8a',
  marker: '#d7263d', brush: '#0e0e0e', charcoal: '#1b1715', chalk: '#f3f0e8', neon: '#ff45e9', goldpen: '#d9b44a',
};
// ink colours that read on dark card
const INK_DARK = { ...INK, pencil: '#b9b9c2', fineliner: '#f4f1ea', fountain: '#9fb4ff', ballpoint: '#8fb0ff',
  brush: '#d8d2c4', charcoal: '#cfc6be', marker: '#1b998b', crayon: '#e8891a' };
const LINE_W = { pencil: 0.005, fineliner: 0.004, fountain: 0.006, crayon: 0.014, ballpoint: 0.004, marker: 0.02,
  brush: 0.014, charcoal: 0.014, chalk: 0.014, neon: 0.006, goldpen: 0.008 };
const BG = { cream: '#f1e6cd', black: '#1c1c1f', sketch: '#f4f3ee', kraft: '#bf9366', chalkboard: '#2c3a33' };
const kinds = (q.get('kinds') || TOOL_KINDS.join(',')).split(',');

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// real paper from the engine when it is available, a flat colour otherwise
async function paper(id, w, h) {
  const c = canvas(w, h), g = c.getContext('2d');
  g.fillStyle = BG[id] || '#eee'; g.fillRect(0, 0, w, h);
  if (q.get('flat') === '1') return c;
  try {
    const { Renderer } = await import('../js/renderer.js');
    const { paperById, brushById } = await import('../js/materials.js');
    const r = new Renderer(canvas(8, 8));
    r.setSize(w, h);
    r.setLayout({ cx: 0.5, cy: 0.5, r: 0.42 });
    r.setPaper(paperById(id), 3);
    r.setStyle({ brush: brushById('fineliner'), ink: '#000000', cover: false, photoColor: false });
    if (r.renderBlank()) g.drawImage(r.canvas, 0, 0, w, h);
    r.destroy();
  } catch (e) { console.warn('paper fallback', e.message); }
  return c;
}

// a short run of line arriving at the tip, so the sprite is seen drawing
function leadIn(g, kind, x, y, size, ink) {
  const R = size * 0.3;
  g.save();
  g.strokeStyle = ink;
  g.lineWidth = Math.max(1, LINE_W[kind] * size);
  g.lineCap = 'round';
  if (kind === 'neon') { g.shadowColor = ink; g.shadowBlur = 0.03 * size; }
  if (kind === 'chalk' || kind === 'charcoal' || kind === 'crayon') g.globalAlpha = 0.85;
  g.beginPath();
  g.arc(x - R, y, R, -1.25, 0);
  g.stroke();
  g.restore();
}

function label(g, text, x, y, color = '#222', size = 13) {
  g.save();
  g.fillStyle = color; g.font = `${size}px system-ui, sans-serif`; g.fillText(text, x, y);
  g.restore();
}

async function save(c, name, type = 'image/png') {
  const r = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data: c.toDataURL(type, 0.92) }) });
  return r.json();
}

// ------------------------------------------------------------------ sheets

async function contactSheet() {
  const colW = 300, sizes = [60, 150, 400], rowH = [120, 220, 470];
  const W = colW * kinds.length, panelH = rowH.reduce((a, b) => a + b, 0) + 40;
  const extraH = 620;
  const c = canvas(W, panelH * 2 + extraH);
  const g = c.getContext('2d');
  g.fillStyle = '#d9d5ce'; g.fillRect(0, 0, c.width, c.height);
  for (const [pi, bg] of ['cream', 'black'].entries()) {
    const y0 = pi * panelH;
    g.drawImage(await paper(bg, W, panelH), 0, y0);
    const dark = bg === 'black';
    const inks = dark ? INK_DARK : INK;
    label(g, `${bg} · sizes ${sizes.join(' / ')} px`, 12, y0 + 22, dark ? '#bbb' : '#444', 15);
    kinds.forEach((kind, i) => {
      let y = y0 + 40;
      sizes.forEach((size, si) => {
        const x = i * colW + colW * 0.22 + (si === 0 ? 40 : 0);
        const ty = y + 14;
        leadIn(g, kind, x, ty, size, inks[kind]);
        drawTool(g, kind, x, ty, size, { color: inks[kind] });
        y += rowH[si];
      });
      label(g, kind, i * colW + 12, y0 + panelH - 12, dark ? '#999' : '#555');
    });
  }
  // lift sequence and motion blur, on cream (left) and black (right)
  const y0 = panelH * 2;
  const half = W / 2;
  for (const [pi, bg] of ['cream', 'black'].entries()) {
    const x0 = pi * half;
    const pc = await paper(bg, half, extraH);
    g.drawImage(pc, x0, y0);
    const dark = bg === 'black';
    const inks = dark ? INK_DARK : INK;
    label(g, 'lift 0 / 0.5 / 1', x0 + 12, y0 + 22, dark ? '#bbb' : '#444', 15);
    const liftKinds = dark ? ['neon', 'goldpen', 'chalk'] : ['pencil', 'fountain', 'marker'];
    liftKinds.forEach((kind, ki) => {
      [0, 0.5, 1].forEach((lift, li) => {
        const x = x0 + 60 + (ki * 3 + li) * 150, y = y0 + 60;
        g.fillStyle = dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
        g.fillRect(x - 5, y, 10, 1); g.fillRect(x, y - 5, 1, 10);   // tip marker
        drawTool(g, kind, x, y, 240, { color: inks[kind], lift });
      });
    });
    label(g, 'motion blur: 14 px, 40 px (capped to 24 px), still', x0 + 12, y0 + 360, dark ? '#bbb' : '#444', 15);
    const mk = dark ? 'neon' : 'pencil';
    [14, 40, 0].forEach((travel, ti) => {
      const cx = x0 + 200 + ti * 520, cy = y0 + 410;
      // the head arrives at (cx, cy) along a gentle curve; `travel` px of it fall in the shutter
      const path = [];
      for (let k = 0; k <= 60; k++) { const t = k / 60; path.push({ x: cx - 160 * (1 - t), y: cy + 26 * (1 - t) * (1 - t) - 8 * Math.sin(t * Math.PI) }); }
      g.save(); g.strokeStyle = inks[mk]; g.lineWidth = Math.max(1, LINE_W[mk] * 200); g.lineCap = 'round';
      if (mk === 'neon') { g.shadowColor = inks[mk]; g.shadowBlur = 6; }
      g.beginPath(); path.forEach((p, k) => (k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.stroke(); g.restore();
      const shutter = [];
      let run = 0;
      for (let k = path.length - 1; k > 0 && run < travel; k--) { shutter.unshift(path[k]); run += Math.hypot(path[k].x - path[k - 1].x, path[k].y - path[k - 1].y); }
      if (travel) drawToolMotion(g, mk, shutter, 200, { color: inks[mk], maxBlur: 24 });
      else drawTool(g, mk, cx, cy, 200, { color: inks[mk] });
    });
  }
  return c;
}

async function bigSheet() {
  const bg = q.get('bg') || 'cream', size = +(q.get('size') || 400);
  const cols = +(q.get('cols') || 6), colW = Math.round(size * 0.95), rowH = Math.round(size * 1.22);
  const rows = Math.ceil(kinds.length / cols);
  const c = await paper(bg, cols * colW, rows * rowH);
  const g = c.getContext('2d');
  const dark = bg === 'black' || bg === 'chalkboard';
  const inks = dark ? INK_DARK : INK;
  kinds.forEach((kind, i) => {
    const x = (i % cols) * colW + colW * 0.3, y = Math.floor(i / cols) * rowH + size * 0.3;
    leadIn(g, kind, x, y, size, q.get('ink') || inks[kind]);
    drawTool(g, kind, x, y, size, { color: q.get('ink') || inks[kind], angle: +(q.get('angle') || 35), lift: +(q.get('lift') || 0) });
    label(g, kind, (i % cols) * colW + 10, (Math.floor(i / cols) + 1) * rowH - 10, dark ? '#999' : '#555');
  });
  return c;
}

// every kind with every ink its brush offers (materials.js), on the paper it prefers
async function inksSheet() {
  const { BRUSHES } = await import('../js/materials.js');
  const size = +(q.get('size') || 200), colW = Math.round(size * 0.62), rowH = Math.round(size * 1.0);
  const rows = BRUSHES.filter(b => kinds.includes(b.tool));
  const cols = Math.max(...rows.map(b => b.inks.length));
  const c = canvas(cols * colW + 150 + Math.round(size * 0.45), rows.length * rowH), g = c.getContext('2d');
  for (const [ri, brush] of rows.entries()) {
    const bg = brush.prefersDark ? 'black' : 'cream';
    g.drawImage(await paper(bg, c.width, rowH), 0, ri * rowH);
    label(g, brush.tool, 10, ri * rowH + 20, brush.prefersDark ? '#aaa' : '#555');
    brush.inks.forEach(([hex, name], ci) => {
      const x = 150 + ci * colW + colW * 0.12, y = ri * rowH + size * 0.12;
      drawTool(g, brush.tool, x, y, size, { color: hex });
      label(g, name, 150 + ci * colW + 4, (ri + 1) * rowH - 8, brush.prefersDark ? '#999' : '#666', 11);
    });
  }
  return c;
}

async function zoomSheet() {
  const size = +(q.get('size') || 60), k = +(q.get('scale') || 4);
  const colW = Math.round(size * 0.75), rowH = Math.round(size * 1.05);
  const small = canvas(colW * kinds.length + Math.round(size * 0.3), rowH * 2);
  const g = small.getContext('2d');
  for (const [ri, bg] of ['cream', 'black'].entries()) {
    g.drawImage(await paper(bg, small.width, rowH), 0, ri * rowH);
    const inks = bg === 'black' ? INK_DARK : INK;
    kinds.forEach((kind, i) => {
      const x = i * colW + colW * 0.3, y = ri * rowH + size * 0.1;
      leadIn(g, kind, x, y, size, inks[kind]);
      drawTool(g, kind, x, y, size, { color: inks[kind] });
    });
  }
  const c = canvas(small.width * k, small.height * k);
  const cg = c.getContext('2d');
  cg.imageSmoothingEnabled = false;
  cg.drawImage(small, 0, 0, c.width, c.height);
  return c;
}

async function oneSheet() {
  const kind = q.get('kind') || 'pencil', size = +(q.get('size') || 600), bg = q.get('bg') || 'cream';
  const W = Math.round(size * 0.8), H = Math.round(size * 1.0);
  const c = await paper(bg, W, H);
  const g = c.getContext('2d');
  const ink = q.get('ink') || (bg === 'black' ? INK_DARK : INK)[kind];
  const x = W * 0.22, y = size * 0.06;
  leadIn(g, kind, x, y, size, ink);
  drawTool(g, kind, x, y, size, { color: ink, lift: +(q.get('lift') || 0), sway: +(q.get('sway') || 0) });
  return c;
}

// tools riding the head of real engine renders
async function contextSheet() {
  const { Renderer } = await import('../js/renderer.js');
  const { rasterize, processTone, buildField, TONE_DEFAULTS, CROP_DEFAULTS } = await import('../js/tone.js');
  const { buildSpiral, LINE_DEFAULTS, indexAt, headAt } = await import('../js/spiral.js');
  const { brushById, paperById, inkMode, BRUSHES } = await import('../js/materials.js');
  const S = +(q.get('size') || 720);
  const src = canvas(1024, 1024);
  {
    const g = src.getContext('2d');
    const bgd = g.createLinearGradient(0, 0, 0, 1024); bgd.addColorStop(0, '#d8dde4'); bgd.addColorStop(1, '#7b828c');
    g.fillStyle = bgd; g.fillRect(0, 0, 1024, 1024);
    const f = g.createRadialGradient(420, 400, 40, 512, 480, 330);
    f.addColorStop(0, '#f4dcc6'); f.addColorStop(0.6, '#c49274'); f.addColorStop(1, '#5e3c2c');
    g.fillStyle = f; g.beginPath(); g.ellipse(512, 480, 250, 300, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#231a14'; g.beginPath(); g.ellipse(470, 250, 260, 120, -0.3, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#2b2f3a'; g.beginPath(); g.ellipse(512, 1100, 480, 300, 0, 0, Math.PI * 2); g.fill();
  }
  const combos = (q.get('combos') || 'pencil:sketch,fineliner:cream,crayon:kraft,neon:black,chalk:chalkboard,gold:black').split(',');
  const cols = 3, rows = Math.ceil(combos.length / cols);
  const out = canvas(cols * S, rows * S);
  const og = out.getContext('2d');
  const r = new Renderer(canvas(8, 8));
  const raster = rasterize(src, CROP_DEFAULTS);
  const layout = { cx: 0.5, cy: 0.5, r: 0.42 };
  const f = +(q.get('f') || 0.62);
  const heads = [];
  for (const [i, combo] of combos.entries()) {
    const [bid, pid] = combo.split(':');
    const brush = brushById(bid), pap = paperById(pid);
    const ink = pap.dark ? (brush.inks.find(([h]) => inkMode(brush, h, pap).flip) || brush.inks[0])[0] : brush.inks[0][0];
    const mode = inkMode(brush, ink, pap);
    const tone = processTone(raster, TONE_DEFAULTS, { flip: mode.flip });
    const field = buildField(raster, tone.L, { rings: 44, flip: mode.flip });
    const geom = buildSpiral(field, { ...LINE_DEFAULTS, rings: 44 }, {});
    const fi = indexAt(geom, f, 'natural');
    r.setSize(S, S); r.setLayout(layout); r.setPaper(pap, 1);
    r.setStyle({ brush, ink, cover: mode.cover, photoColor: false });
    r.setGeometry(geom);
    r.render(fi);
    const x = (i % cols) * S, y = Math.floor(i / cols) * S;
    og.drawImage(r.canvas, x, y);
    const h = headAt(geom, fi);
    const hx = x + S * (layout.cx + h.x * layout.r), hy = y + S * (layout.cy + h.y * layout.r);
    og.save();
    og.beginPath(); og.rect(x, y, S, S); og.clip();
    const ghost = q.get('ghost') === '1';
    drawTool(og, brush.tool, hx, hy, S * 0.22, { color: ink, alpha: ghost ? 0.35 : 1 });
    if (ghost) {
      og.fillStyle = '#00c8ff';
      og.fillRect(hx - 12, hy - 0.5, 8, 1); og.fillRect(hx + 4, hy - 0.5, 8, 1);
      og.fillRect(hx - 0.5, hy - 12, 1, 8); og.fillRect(hx - 0.5, hy + 4, 1, 8);
    }
    og.restore();
    heads.push([hx, hy]);
    label(og, `${brush.tool} on ${pap.id}`, x + 10, y + S - 10, pap.dark ? '#aaa' : '#555');
    void BRUSHES;
  }
  r.destroy();
  if (q.get('zoom')) {
    // 3x crops centred on each head, to see the tip meet the end of the line
    const z = 3, R = 60, zc = canvas(combos.length * 2 * R * z, 2 * R * z), zg = zc.getContext('2d');
    zg.imageSmoothingEnabled = false;
    heads.forEach(([hx, hy], i) => zg.drawImage(out, hx - R, hy - R, 2 * R, 2 * R, i * 2 * R * z, 0, 2 * R * z, 2 * R * z));
    return zc;
  }
  return out;
}

// ------------------------------------------------------------------ checks

function alphaData(c) { return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data; }

// the sprite's extreme point toward the tip must be the tip itself
function tipCheck(c, tx, ty, angleDeg) {
  const d = alphaData(c), w = c.width, h = c.height;
  const a = angleDeg * Math.PI / 180, dx = Math.sin(a), dy = Math.cos(a);
  let minS = Infinity, lat = 0, count = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4 + 3] < 96) continue;
    count++;
    const px = x + 0.5 - tx, py = y + 0.5 - ty;
    const s = px * dx + py * dy;
    if (s < minS) { minS = s; lat = Math.abs(-px * dy + py * dx); }
  }
  return { minS: +minS.toFixed(2), lat: +lat.toFixed(2), count };
}

// an opaque sheet, as in the app (on transparency, unpremultiplied low-alpha pixels are noise)
function sheet(w, h, color = '#e9e1cf', attrs) {
  const c = canvas(w, h), g = c.getContext('2d', attrs);
  g.fillStyle = color; g.fillRect(0, 0, w, h);
  return c;
}

function diff(a, b) {
  const da = alphaData(a), db = alphaData(b);
  let max = 0, sum = 0, at = -1, over4 = 0;
  for (let i = 0; i < da.length; i++) {
    const e = Math.abs(da[i] - db[i]);
    if (e > max) { max = e; at = i; }
    if (e > 4) over4++;
    sum += e;
  }
  const px = at >> 2;
  return { max, mean: +(sum / da.length).toFixed(4), over4, at: at < 0 ? null : [px % a.width, Math.floor(px / a.width)] };
}

async function checks() {
  const res = { tip: {}, dpr: {}, layered: {}, motionSame: {}, errors: [] };
  let ok = true;
  const fail = (m) => { ok = false; res.errors.push(m); };
  // yield first, so the page's load event is not held up by seconds of synchronous checks
  // (WebKit's software canvas is slow and the driver's page.goto waits for load)
  const tick = () => new Promise(r => setTimeout(r, 0));
  await tick();
  for (const kind of TOOL_KINDS) {
    await tick();
    // 1. tip exactly at (x, y) for two angles
    for (const angle of [35, 20]) {
      const c = canvas(700, 700), g = c.getContext('2d');
      drawTool(g, kind, 200.5, 120.5, 400, { shadow: false, effects: false, angle });
      const t = tipCheck(c, 200.5, 120.5, angle);
      res.tip[`${kind}@${angle}`] = t;
      // AA and the rounded point: the first well-covered pixel sits within ~2 px of the tip
      if (!(t.minS > -1.5 && t.minS < 2.5 && t.lat < 3)) fail(`tip ${kind}@${angle} ${JSON.stringify(t)}`);
    }
    // 2. DPR: a 2x transform must give the same device image as drawing at 2x size
    {
      const a = sheet(500, 500), ga = a.getContext('2d');
      ga.setTransform(2, 0, 0, 2, 0, 0);
      drawTool(ga, kind, 60, 40, 180, { lift: 0.3 });
      const b = sheet(500, 500), gb = b.getContext('2d');
      drawTool(gb, kind, 120, 80, 360, { lift: 0.3 });
      const dd = diff(a, b);
      res.dpr[kind] = dd;
      if (dd.mean > 0.2) fail(`dpr ${kind} ${JSON.stringify(dd)}`);
    }
    // 3. an opaque canvas (the film encoder's alpha:false context) gets exactly what a
    // transparent one gets: no LCD subpixel text (colour fringes on the lettering), and a still
    // frame matches a barely faded one (no shimmer when the film fades the tool)
    for (const lift of [0, 1]) {
      const a = sheet(700, 700, '#e9e1cf', { alpha: false }), ga = a.getContext('2d');
      drawTool(ga, kind, 200, 120, 324, { lift });
      const b = sheet(700, 700), gb = b.getContext('2d');
      drawTool(gb, kind, 200, 120, 324, { lift });
      const c = sheet(700, 700, '#e9e1cf', { alpha: false }), gc = c.getContext('2d');
      drawTool(gc, kind, 200, 120, 324, { lift, alpha: 0.997 });
      const opaque = diff(a, b), faded = diff(a, c);
      res.layered[`${kind}@${lift}`] = { opaque: opaque.max, faded: faded.max };
      if (opaque.max > 1) fail(`opaque vs transparent canvas ${kind}@${lift} ${JSON.stringify(opaque)}`);
      if (faded.max > 2) fail(`alpha 1 vs 0.997 on an opaque canvas ${kind}@${lift} ${JSON.stringify(faded)}`);
    }
    // 3b. size is the tool's length for every kind: tip to back end along the axis
    {
      const c = canvas(700, 700), g = c.getContext('2d');
      drawTool(g, kind, 100, 60, 500, { shadow: false, effects: false });
      const d = alphaData(c), a = 35 * Math.PI / 180, dx = Math.sin(a), dy = Math.cos(a);
      let far = -Infinity;
      for (let i = 3; i < d.length; i += 4) {
        if (d[i] < 96) continue;
        const p = (i - 3) / 4, x = p % 700 + 0.5 - 100, y = Math.floor(p / 700) + 0.5 - 60;
        far = Math.max(far, x * dx + y * dy);
      }
      const len = +(far / 500).toFixed(3);
      (res.length = res.length || {})[kind] = len;
      if (Math.abs(len - 1) > 0.012) fail(`length ${kind} ${len} (size is the tool length)`);
    }
    // 4. motion with every sub-position equal = the still sprite (up to 1/K rounding)
    {
      const a = sheet(500, 500, '#1c1c1f'), ga = a.getContext('2d');
      drawTool(ga, kind, 150, 100, 300, {});
      const b = sheet(500, 500, '#1c1c1f'), gb = b.getContext('2d');
      drawToolMotion(gb, kind, Array.from({ length: 6 }, () => ({ x: 150, y: 100 })), 300, {});
      const dd = diff(a, b);
      res.motionSame[kind] = dd;
      if (dd.max > 8) fail(`motion ${kind} ${JSON.stringify(dd)}`);
    }
  }
  // 4b. a moving blur keeps the tool's coverage (time average of a translated sprite) and
  // stays inside the swept area
  {
    const cover = c => { const d = alphaData(c); let s2 = 0; for (let i = 3; i < d.length; i += 4) s2 += d[i]; return s2 / 255; };
    res.motionMass = {};
    for (const kind of ['pencil', 'marker', 'neon']) {
      const a = canvas(700, 700);
      drawTool(a.getContext('2d'), kind, 150, 120, 300, { shadow: false, effects: false });
      const b = canvas(700, 700);
      const pts = Array.from({ length: 5 }, (_, i) => ({ x: 150 + i * 12, y: 120 + i * 3 }));
      drawToolMotion(b.getContext('2d'), kind, pts, 300, { shadow: false, effects: false });
      const ma = cover(a), mb = cover(b), ratio = +(mb / ma).toFixed(4);
      res.motionMass[kind] = ratio;
      if (Math.abs(ratio - 1) > 0.02) fail(`motion mass ${kind} ${ratio}`);
    }
  }
  // 5. the caller's context state is left untouched
  {
    const c = canvas(300, 300), g = c.getContext('2d');
    g.setTransform(1.5, 0, 0, 1.5, 3, 4);
    g.globalAlpha = 0.8; g.globalCompositeOperation = 'multiply';
    g.fillStyle = '#123456'; g.strokeStyle = '#654321'; g.lineWidth = 3; g.shadowBlur = 0; g.shadowColor = 'rgba(0, 0, 0, 0)';
    const snap = () => JSON.stringify([g.getTransform().toString(), g.globalAlpha, g.globalCompositeOperation, g.fillStyle,
      g.strokeStyle, g.lineWidth, g.shadowBlur, g.shadowColor, g.shadowOffsetX, g.lineCap, g.lineJoin]);
    const before = snap();
    drawTool(g, 'neon', 50, 40, 120, { lift: 0.4, sway: 0.3 });
    drawTool(g, 'pencil', 50, 40, 120, { alpha: 0.5 });
    drawToolMotion(g, 'marker', [{ x: 50, y: 40 }, { x: 60, y: 44 }, { x: 70, y: 46 }], 120, {});
    res.state = before === snap();
    if (!res.state) fail('context state changed: ' + before + ' -> ' + snap());
  }
  // 5b. ...and nothing the caller left set leaks into the sprite, on any path (still, faded,
  // motion): a glow shadow, a filter, a line dash, text direction / spacing
  {
    const setups = {
      shadow: g => { g.shadowColor = 'rgba(255,0,0,1)'; g.shadowBlur = 10; g.shadowOffsetX = 20; },
      filter: g => { if ('filter' in g) g.filter = 'blur(3px)'; },
      dash: g => { g.setLineDash([4, 4]); g.lineDashOffset = 2; g.miterLimit = 1; },
      text: g => { g.direction = 'rtl'; g.textAlign = 'right'; g.font = '40px serif'; if ('letterSpacing' in g) g.letterSpacing = '6px'; },
    };
    const draws = {
      still: g => drawTool(g, 'pencil', 100, 60, 280, {}),
      faded: g => drawTool(g, 'marker', 100, 60, 280, { alpha: 0.5 }),
      motion: g => drawToolMotion(g, 'goldpen', [{ x: 100, y: 60 }, { x: 110, y: 64 }], 280, {}),
    };
    res.inherit = {};
    for (const [dn, draw] of Object.entries(draws)) {
      const ref = sheet(400, 400); draw(ref.getContext('2d'));
      for (const [sn, set] of Object.entries(setups)) {
        const c = sheet(400, 400), g = c.getContext('2d');
        set(g); draw(g);
        const dd = diff(ref, c);
        res.inherit[`${sn}/${dn}`] = dd.max;
        if (dd.max > 1) fail(`caller ${sn} leaks into ${dn} ${JSON.stringify(dd)}`);
      }
    }
  }
  // 5c. motion: maxBlur Infinity keeps the whole trail, the default caps it, and a jump longer
  // than 6 * size (a seek) is the still tool at the last point
  {
    // horizontal extent of every touched pixel (the ends of a long trail are faint by design)
    const extent = c => {
      const d = alphaData(c), w = c.width;
      let x0 = Infinity, x1 = -Infinity;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) { const x = ((i - 3) / 4) % w; x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
      return x1 - x0;
    };
    const o = { shadow: false, effects: false };
    const pts = Array.from({ length: 6 }, (_, k) => ({ x: 150 + k * 60, y: 120 + k * 10 }));
    const a = canvas(900, 700); drawTool(a.getContext('2d'), 'fountain', 150, 120, 300, o);
    const b = canvas(900, 700); drawToolMotion(b.getContext('2d'), 'fountain', pts, 300, { ...o, maxBlur: Infinity });
    const c = canvas(900, 700); drawToolMotion(c.getContext('2d'), 'fountain', pts, 300, o);
    res.maxBlur = { still: extent(a), infinity: extent(b), capped: extent(c) };
    // the full trail adds the 300 px of horizontal travel; the default cap, 0.08 * size = 24 px
    // along the path, adds its horizontal part (23.7 px). Copies sit at the centres of their
    // time slots, so the first and last are half a slot in from the ends: N = 64 and 32 copies.
    res.maxBlur.expect = [+(300 * 63 / 64).toFixed(1), +(23.7 * 31 / 32).toFixed(1)];
    if (Math.abs(res.maxBlur.infinity - res.maxBlur.still - res.maxBlur.expect[0]) > 3) fail('maxBlur Infinity ' + JSON.stringify(res.maxBlur));
    if (Math.abs(res.maxBlur.capped - res.maxBlur.still - res.maxBlur.expect[1]) > 3) fail('maxBlur default ' + JSON.stringify(res.maxBlur));
    const s = sheet(600, 600), j = sheet(600, 600);
    drawTool(s.getContext('2d'), 'pencil', 300, 200, 200, { lift: 0.2, sway: 0.3 });
    drawToolMotion(j.getContext('2d'), 'pencil', [{ x: -1700, y: 200, lift: 0.9 }, { x: 300, y: 200, lift: 0.2, sway: 0.3 }], 200, {});
    res.seek = diff(s, j).max;
    if (res.seek > 1) fail('seek is not the still tool at the last point: ' + res.seek);
  }
  // 5d. a sprite bigger than one scratch layer is done in tiles and still fades as a whole
  {
    const a = 35 * Math.PI / 180;
    const probe = (W, x, y, size, alpha) => {
      const c = sheet(W, W, '#ffffff'), g = c.getContext('2d');
      drawTool(g, 'fineliner', x, y, size, { alpha, shadow: false });
      const d = g.getImageData(Math.round(x + Math.sin(a) * 0.66 * size), Math.round(y + Math.cos(a) * 0.66 * size), 1, 1).data;
      return d[0];
    };
    res.huge = { big03: probe(4200, 300, 200, 6000, 0.3), small03: probe(700, 30, 20, 600, 0.3), small1: probe(700, 30, 20, 600, 1) };
    if (Math.abs(res.huge.big03 - res.huge.small03) > 3 || res.huge.small03 - res.huge.small1 < 100) fail('huge sprite alpha ' + JSON.stringify(res.huge));
  }
  // 6. robustness: nothing throws on odd input
  try {
    const c = canvas(200, 200), g = c.getContext('2d');
    drawTool(g, 'nope', 10, 10, 100);
    drawTool(g, 'pencil', NaN, 10, 100);
    drawTool(g, 'pencil', 10, 10, 0);
    drawTool(g, 'pencil', 10, 10, 100, { alpha: 0 });
    drawTool(g, 'pencil', 10, 10, 100, { color: 'banana', angle: 'x', lift: 7, sway: -3 });
    drawTool(g, 'crayon', 10, 10, 100, { color: '#0af' });
    drawTool(g, 'marker', -500, -500, 100);
    drawTool(g, 'marker', 190, 190, 5000);
    drawToolMotion(g, 'pencil', [], 100);
    drawToolMotion(g, 'pencil', null, 100);
    drawToolMotion(g, 'pencil', [{ x: 1, y: 2 }, { x: NaN, y: 0 }, null], 100);
    drawToolMotion(g, 'pencil', Array.from({ length: 40 }, (_, i) => ({ x: i, y: i })), 100, { alpha: 0.5 });
    drawToolMotion(g, 'pencil', [{ x: 0, y: 0 }, { x: 590, y: 0 }], 100, { maxBlur: Infinity });
    drawToolMotion(g, 'pencil', [{ x: 0, y: 0 }, { x: 590, y: 0 }], 100, { maxBlur: NaN });
    res.robust = true;
  } catch (e) { fail('robustness: ' + e.message); res.robust = false; }
  // 7. sway is periodic, lift separates the shadow
  {
    const a = canvas(400, 400), b = canvas(400, 400);
    drawTool(a.getContext('2d'), 'fineliner', 100, 60, 280, { sway: 0 });
    drawTool(b.getContext('2d'), 'fineliner', 100, 60, 280, { sway: 1 });
    res.swayPeriodic = diff(a, b).max === 0;
    if (!res.swayPeriodic) fail('sway not periodic');
    // shadow near the tip (within 60 px, outside the sprite): it should hug the tip at lift 0
    // and slide away to the lower right as the tool lifts
    const shadowCentroid = lift => {
      const c = sheet(500, 500, '#ffffff'), g = c.getContext('2d');
      drawTool(g, 'fineliner', 150, 80, 300, { lift });
      const clean = canvas(500, 500), cg = clean.getContext('2d');
      drawTool(cg, 'fineliner', 150, 80, 300, { lift, shadow: false });
      const d = alphaData(c), m = alphaData(clean);
      let sx = 0, sy = 0, sw = 0, peak = 0;
      for (let i = 0; i < 500 * 500; i++) {
        const x = i % 500, y = Math.floor(i / 500);
        if (m[i * 4 + 3] > 0 || Math.hypot(x - 150, y - 80) > 60) continue;
        const wgt = 255 - d[i * 4];
        if (wgt < 2) continue;
        sx += x * wgt; sy += y * wgt; sw += wgt; peak = Math.max(peak, wgt);
      }
      return { dx: +(sx / sw - 150).toFixed(1), dy: +(sy / sw - 80).toFixed(1), mass: Math.round(sw), peak };
    };
    res.shadow = [0, 0.5, 1].map(shadowCentroid);
    const [s0, , s1] = res.shadow;
    if (!(s1.dx - s0.dx > 8 && s1.peak < s0.peak)) fail('lift does not separate the shadow ' + JSON.stringify(res.shadow));
  }
  // 8. bounds helper covers every painted pixel (all kinds, resting and lifted)
  {
    res.bounds = {};
    for (const kind of TOOL_KINDS) {
      for (const lift of [0, 0.8, 1]) {
        const c = canvas(900, 900), g = c.getContext('2d');
        const opts = { lift, sway: 0.25, color: INK_DARK[kind] };
        const bb = toolBounds(kind, 300, 200, 400, opts);
        drawTool(g, kind, 300, 200, 400, opts);
        const d = alphaData(c);
        let outside = 0;
        for (let y = 0; y < 900; y++) for (let x = 0; x < 900; x++) {
          if (d[(y * 900 + x) * 4 + 3] === 0) continue;
          if (x < bb.x - 1 || y < bb.y - 1 || x > bb.x + bb.w + 1 || y > bb.y + bb.h + 1) outside++;
        }
        if (lift === 1) res.bounds[kind] = { w: Math.round(bb.w), h: Math.round(bb.h), outside };
        if (outside) fail(`pixels outside toolBounds: ${kind}@${lift} ${outside}`);
      }
    }
  }
  // 9a. works off the main thread on an OffscreenCanvas (no DOM in a worker)
  if (typeof OffscreenCanvas !== 'undefined') {
    const src = `import { TOOL_KINDS, drawTool, drawToolMotion } from '${new URL('../js/tools.js', location.href)}';
      const c = new OffscreenCanvas(600, 600), g = c.getContext('2d');
      let err = null;
      try {
        for (const k of TOOL_KINDS) {
          drawTool(g, k, 100, 100, 300, { lift: 0.3, sway: 0.2 });
          drawTool(g, k, 200, 100, 300, { alpha: 0.5 });
          drawToolMotion(g, k, [{ x: 300, y: 100 }, { x: 320, y: 110 }], 300, {});
        }
      } catch (e) { err = String(e); }
      const d = g.getImageData(0, 0, 600, 600).data;
      let painted = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]) painted++;
      postMessage({ err, painted });`;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    res.worker = await new Promise(resolve => {
      const w = new Worker(url, { type: 'module' });
      const t = setTimeout(() => resolve({ err: 'timeout' }), 20000);
      w.onmessage = e => { clearTimeout(t); resolve(e.data); w.terminate(); };
      w.onerror = e => { clearTimeout(t); resolve({ err: e.message || 'worker error' }); };
    });
    if (res.worker.err || !(res.worker.painted > 10000)) fail('worker: ' + JSON.stringify(res.worker));
  }
  // 9. timing on film-sized opaque canvases like the encoder's: GPU-backed (canvas frames) and
  // willReadFrequently (the manual YUV path). Tool size 324 = 0.3 of a 1080 px wide film.
  // Each batch of frames ends with one 1-pixel readback, so the GPU work is inside the timing
  // but the GPU is not stalled after every call (a readback per call would make Chromium demote
  // the canvas to the CPU and time the transfers instead of the drawing).
  {
    const perf = {};
    for (const [mode, attrs] of [['gpu', { alpha: false }], ['cpu', { alpha: false, willReadFrequently: true }]]) {
      const g = sheet(1080, 1920, '#f1e6cd', attrs).getContext('2d');
      // warm up: first use allocates the scratch layers and compiles the canvas' GPU programs
      for (const kind of TOOL_KINDS) drawToolMotion(g, kind, [{ x: 100, y: 100 }, { x: 110, y: 104 }], 324, {});
      g.getImageData(0, 0, 1, 1);
      const time = (n, fn) => {
        const t0 = performance.now();
        for (let i = 0; i < n; i++) fn(i);
        g.getImageData(0, 0, 1, 1);
        return +((performance.now() - t0) / n).toFixed(2);
      };
      for (const kind of TOOL_KINDS) {
        const o = { color: INK[kind] };
        const p = perf[kind] = perf[kind] || {};
        p[mode + 'Still'] = time(60, i => drawTool(g, kind, 300 + i, 500 + i, 324, { ...o, sway: i / 60, lift: 0.1 }));
        p[mode + 'Faded'] = time(60, i => drawTool(g, kind, 300 + i, 500 + i, 324, { ...o, sway: i / 60, alpha: 0.8 }));
        p[mode + 'Motion6'] = time(30, i => drawToolMotion(g, kind, Array.from({ length: 6 }, (_, k) => ({ x: 300 + i + k * 3, y: 900 + k })), 324, o));
      }
    }
    res.perf = perf;
  }
  res.ok = ok;
  return res;
}

// ------------------------------------------------------------------ run

async function run() {
  const sheet = q.get('sheet') || 'contact';
  const t0 = performance.now();
  if (sheet === 'check') {
    const r = await checks();
    window.__done = { ok: r.ok, ms: Math.round(performance.now() - t0), ...r };
    document.body.textContent = JSON.stringify(r, null, 1);
    return;
  }
  const out = sheet === 'big' ? await bigSheet()
    : sheet === 'zoom' ? await zoomSheet()
      : sheet === 'inks' ? await inksSheet()
      : sheet === 'one' ? await oneSheet()
        : sheet === 'context' ? await contextSheet()
          : await contactSheet();
  const ms = performance.now() - t0;
  const res = await save(out, q.get('shot') || `tool_${sheet}`, q.get('jpg') ? 'image/jpeg' : 'image/png');
  window.__done = { ok: true, ms: Math.round(ms), w: out.width, h: out.height, ...res };
  document.body.append(out);
}

run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
