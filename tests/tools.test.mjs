// Tool sprite checks in real browsers: runs /dev/tools.html?sheet=check (tip placement, length,
// DPR, opaque-canvas text and fades, motion coverage / maxBlur / seeks, caller state kept and
// not inherited, robustness, tiled huge sprites, sway, lift, bounds, worker, timing)
// in Chromium, Firefox and WebKit through tests/shoot.mjs. Needs the dev server (default :8830).
//   node tests/tools.test.mjs [chromium firefox webkit] [--port 8830]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const pi = args.indexOf('--port');
const port = pi >= 0 ? args.splice(pi, 2)[1] : '8830';
const browsers = args.length ? args : ['chromium', 'firefox', 'webkit'];
let failed = 0;
for (const b of browsers) {
  const r = spawnSync(process.execPath, [path.join(here, 'shoot.mjs'), '/dev/tools.html?sheet=check', '--browser', b, '--port', port],
    { encoding: 'utf8', timeout: 300000 });
  const out = r.stdout || '';
  const end = out.indexOf('\nconsole:') > 0 ? out.indexOf('\nconsole:') : out.lastIndexOf('}') + 1;
  let done = null;
  try { done = JSON.parse(out.slice(0, end)).done; } catch { /* reported below */ }
  const ok = !!(done && done.ok);
  if (!ok) failed++;
  const perf = done && done.perf ? Object.values(done.perf) : [];
  const mean = key => (perf.length ? (perf.reduce((s, p) => s + p[key], 0) / perf.length).toFixed(2) : '?');
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${b.padEnd(8)} ms per call, mean over kinds: still ${mean('gpuStill')} (cpu canvas ${mean('cpuStill')}),` +
    ` faded ${mean('gpuFaded')}, motion ${mean('gpuMotion6')} (cpu canvas ${mean('cpuMotion6')})` +
    (ok ? '' : '\n     ' + JSON.stringify(done ? (done.errors || done.error) : out.slice(0, 400))));
}
process.exit(failed ? 1 : 0);
