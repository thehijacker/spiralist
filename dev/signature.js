// Signature lab: how js/signature.js turns names into pen strokes.
//   node tests/shoot.mjs "/dev/signature.html?names=Anna Smith|@winchxyz|#oneline;name=sig_lab"
// Per name, three panels: the traced strokes in writing order (colour runs from blue to red along
// the writing time, hops dashed), the strokes re-drawn at a pen width over the face in grey, and a
// timing strip (pen down vs in the air). Sets window.__done for tests/shoot.mjs.
import { ensureSignatureFont, traceSignature, timeSignature, signatureFontLoaded } from '../js/signature.js';

const q = new URLSearchParams(location.search);
const names = (q.get('names') || 'Anna Smith|@winchxyz|#oneline|Jo|Émile Zola-Brontë|María José|finn.lee_2026').split('|');
const shot = q.get('name') || 'sig_lab';
const EMPX = +(q.get('em') || 110);

async function run() {
  await ensureSignatureFont();
  const rows = [];
  let W = 0;
  for (const name of names) {
    const t0 = performance.now();
    const tr = traceSignature(name);
    const ms = performance.now() - t0;
    if (!tr) continue;
    const tm = timeSignature(tr, 1.2);
    rows.push({ name, tr, tm, ms });
    W = Math.max(W, (tr.width + 0.6) * EMPX * 2 + 40);
  }
  const RH = EMPX * 1.7 + 30;
  const c = document.createElement('canvas');
  c.width = Math.ceil(W); c.height = Math.ceil(rows.length * RH);
  const g = c.getContext('2d');
  g.fillStyle = '#f7f5f0'; g.fillRect(0, 0, c.width, c.height);
  const report = [];
  rows.forEach(({ name, tr, tm, ms }, r) => {
    const oy = r * RH + EMPX * 1.05 + 14;
    const ox1 = 20 + EMPX * 0.3, ox2 = ox1 + (tr.width + 0.6) * EMPX;
    g.fillStyle = '#333'; g.font = '12px system-ui';
    g.fillText(`${name}  (${tr.font}, ${tr.strokes.length} strokes, ${ms.toFixed(0)} ms)`, 8, r * RH + 14);
    // 1. order: the samples coloured by time
    for (let k = 1; k < tm.n; k++) {
      const u = k / (tm.n - 1);
      g.strokeStyle = tm.down[k] && tm.down[k - 1] ? `hsl(${240 - 240 * u},80%,45%)` : 'rgba(0,0,0,.25)';
      g.lineWidth = tm.down[k] ? 2.2 : 1;
      g.setLineDash(tm.down[k] ? [] : [3, 3]);
      g.beginPath();
      g.moveTo(ox1 + tm.x[k - 1] * EMPX, oy + tm.y[k - 1] * EMPX);
      g.lineTo(ox1 + tm.x[k] * EMPX, oy + tm.y[k] * EMPX);
      g.stroke();
    }
    g.setLineDash([]);
    // stroke starts
    tr.strokes.forEach((s, i) => {
      g.fillStyle = '#000';
      g.beginPath(); g.arc(ox1 + s[0][0] * EMPX, oy + s[0][1] * EMPX, 2.5, 0, 7); g.fill();
      g.font = '9px system-ui'; g.fillText(String(i), ox1 + s[0][0] * EMPX + 3, oy + s[0][1] * EMPX - 3);
    });
    // 2. a pen re-draw at ~0.1 em
    g.strokeStyle = '#1b1a2e'; g.lineCap = 'round'; g.lineJoin = 'round';
    g.lineWidth = EMPX * 0.075;
    for (const s of tr.strokes) {
      g.beginPath();
      s.forEach(([x, y], i) => (i ? g.lineTo(ox2 + x * EMPX, oy + y * EMPX) : g.moveTo(ox2 + x * EMPX, oy + y * EMPX)));
      g.stroke();
    }
    // baseline
    g.strokeStyle = 'rgba(200,0,0,.25)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(ox1 - 10, oy); g.lineTo(c.width - 10, oy); g.stroke();
    const downT = tm.down.reduce((a, v) => a + v, 0) * tm.dt;
    report.push({ name, strokes: tr.strokes.length, width: +tr.width.toFixed(2), top: +tr.top.toFixed(2), bottom: +tr.bottom.toFixed(2),
      thickness: +tr.thickness.toFixed(3), ms: +ms.toFixed(1), downShare: +(downT / tm.seconds).toFixed(2) });
  });
  const data = c.toDataURL('image/png');
  const res = await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name: shot, data }) });
  window.__done = { ok: res.ok, font: signatureFontLoaded(), report };
}
run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
