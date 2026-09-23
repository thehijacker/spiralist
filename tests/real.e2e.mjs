// Realistic mode end to end in the real app: switch modes, every style x a set of tools (broad
// tools on their auto big sheet), light and dark, desktop and --mobile, and screenshots of each.
//   node tests/real.e2e.mjs [--mobile] [--theme dark] [--styles squiggle,stipple] [--tools fineliner,charcoal]
//        [--shots stage|full|none] [--prefix rm_]
// Prints per case: build wait (ms), metres, hand time, sheet; fails on console errors, a missing
// geom.real / handT, a width that is not the tool, or an info line that does not match.
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const { chromium } = require(PW);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = k => args.includes('--' + k);
const mobile = flag('mobile');
const theme = opt('theme', 'light');
const prefix = opt('prefix', 'rm_');
const shots = opt('shots', 'full');
const styles = opt('styles', 'squiggle,stipple,scribble,engrave').split(',');
const tools = opt('tools', 'fineliner,ballpoint,pencil,charcoal,watercolour').split(',');
const W = mobile ? 390 : 1440, H = mobile ? 844 : 900, dpr = mobile ? 3 : 2;

const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: dpr, colorScheme: theme, hasTouch: mobile, isMobile: mobile });
const page = await context.newPage();
const logs = [];
page.on('console', m => { if (m.type() === 'error' && !/api\.github\.com|403/.test(m.text())) logs.push(`[error] ${m.text()}`); });
page.on('pageerror', e => logs.push('[pageerror] ' + e.message));
await page.goto('http://localhost:8830/');
await page.waitForFunction(() => window.SP && window.SP.geom && !window.SP.play.playing, null, { timeout: 60000 });
// start clean (the welcome card hides once a mode is chosen, as it would after a click)
await page.evaluate(() => { document.getElementById('welcome').hidden = true; document.body.classList.remove('welcoming'); window.dispatchEvent(new Event('resize')); });

const settle = async () => {
  await page.waitForFunction(() => !window.SP.building && window.SP.geom && window.SP.geom.real, null, { timeout: 60000 });
  await page.waitForFunction(() => !document.getElementById('sheet').classList.contains('compiling'), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);
};
const fails = [];
const t0 = Date.now();
await page.evaluate(() => window.SP.setMode('realistic'));
await settle();
console.log(`mode switch -> first realistic drawing: ${Date.now() - t0} ms`);

if (flag('flow')) {
  // undo / redo, the M key, playback paced by the hand clock, the Save dialog note, persistence
  const f = await page.evaluate(async () => {
    const SP = window.SP, out = {};
    const wait = async () => { for (let i = 0; i < 400; i++) { await new Promise(r => setTimeout(r, 50)); if (!SP.building && SP.geom?.real) return; } };
    SP.setRealStyle('scribble'); await wait();
    document.getElementById('btnUndo').click(); await wait();
    out.undoStyle = SP.doc.real.style;
    document.getElementById('btnRedo').click(); await wait();
    out.redoStyle = SP.doc.real.style;
    // playback: halfway through the transport = halfway through the hand clock (the film's easing aside)
    const g = SP.geom;
    out.paceIsHand = g._pace.get('natural') === g.handT;
    SP.play.f = 0.5; SP.invalidate('render');
    await new Promise(r => setTimeout(r, 200));
    const scrub = document.getElementById('scrub');
    scrub.value = 500; scrub.dispatchEvent(new Event('input'));
    out.tip = document.getElementById('scrubTip').textContent;
    scrub.dispatchEvent(new Event('change'));
    SP.play.f = 1;
    await SP.openDownload();
    await new Promise(r => setTimeout(r, 300));
    out.dlNote = document.getElementById('dlRealNote').hidden ? null : document.getElementById('dlRealNote').textContent;
    document.getElementById('dlDialog').close();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    await new Promise(r => setTimeout(r, 400));
    out.afterM = SP.doc.mode;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    await wait();
    out.afterMM = SP.doc.mode;
    return out;
  });
  console.log('flow:', JSON.stringify(f));
  if (f.undoStyle !== 'squiggle' || f.redoStyle !== 'scribble') fails.push('undo/redo of style');
  if (!f.paceIsHand) fails.push('pacing is not the hand clock');
  if (!/by hand/.test(f.tip)) fails.push('scrub tip: ' + f.tip);
  if (!f.dlNote || !/real-size plotter file/.test(f.dlNote)) fails.push('save dialog note: ' + f.dlNote);
  if (f.afterM !== 'artistic' || f.afterMM !== 'realistic') fails.push('M key');
  // persistence: a reload comes back in Realistic mode with the same style and draws it
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForFunction(() => window.SP && window.SP.geom && window.SP.geom.real && !window.SP.play.playing, null, { timeout: 60000 }).catch(() => {});
  const p = await page.evaluate(() => ({ mode: window.SP.doc.mode, style: window.SP.doc.real.style, real: !!window.SP.geom?.real }));
  console.log('after reload:', JSON.stringify(p));
  if (p.mode !== 'realistic' || p.style !== 'scribble' || !p.real) fails.push('reload: ' + JSON.stringify(p));
  if (shots !== 'none') await page.screenshot({ path: path.resolve(`shots/${prefix}welcome_back${mobile ? '_m' : ''}.png`) });
  await page.evaluate(() => { document.getElementById('welcome').hidden = true; document.body.classList.remove('welcoming'); });
}

for (const style of styles) {
  for (const tool of tools) {
    const r = await page.evaluate(async ({ style, tool }) => {
      const SP = window.SP;
      const t = performance.now();
      SP.setRealStyle(style);
      SP.setRealTool(tool);
      // wait for the worker build to land
      for (let i = 0; i < 600; i++) {
        await new Promise(res => setTimeout(res, 50));
        const g = SP.geom;
        if (!SP.building && g && g.real && g.real.style === style && g.real.tool === tool) break;
      }
      const g = SP.geom, d = SP.doc;
      const STRIDE = 7;
      let wMin = Infinity, wMax = -Infinity;
      for (let i = 0; i < g.n; i += 97) { const w = g.data[i * STRIDE + 2]; wMin = Math.min(wMin, w); wMax = Math.max(wMax, w); }
      return {
        wait: Math.round(performance.now() - t), style: g.real.style, tool: g.real.tool, toolMm: g.real.toolMm, sheetMm: g.real.sheetMm,
        lengthM: +g.real.lengthM.toFixed(1), hand: Math.round(g.real.handSeconds), buildMs: g.real.buildMs, waitMs: g.real.waitMs, n: g.n,
        handT: !!g.handT && g.handT.length === g.n, w: [wMin, wMax], want: d.real.toolMm / (0.42 * d.real.sheetMm),
        info: document.getElementById('realInfo').textContent, brush: d.brush, sheetAuto: d.real.sheetAuto,
      };
    }, { style, tool });
    await settle();
    const tag = `${prefix}${style}_${tool}${mobile ? '_m' : ''}${theme === 'dark' ? '_dark' : ''}`;
    console.log(`${tag.padEnd(34)} ${String(r.toolMm).padStart(4)} mm on ${String(r.sheetMm).padStart(4)} mm  ${String(r.lengthM).padStart(6)} m  ${String(Math.round(r.hand / 60)).padStart(4)} min  ${String(r.n).padStart(7)} pts  build ${r.buildMs} ms, wait ${r.waitMs} ms | ${r.info}`);
    if (r.style !== style || r.tool !== tool) fails.push(`${tag}: got ${r.style}/${r.tool}`);
    if (!r.handT) fails.push(`${tag}: no handT`);
    if (Math.abs(r.w[0] - r.want) > r.want * 0.02 || Math.abs(r.w[1] - r.want) > r.want * 0.02) fails.push(`${tag}: width ${r.w} != ${r.want}`);
    if (!/m of line/.test(r.info)) fails.push(`${tag}: info "${r.info}"`);
    if (shots === 'full') await page.screenshot({ path: path.resolve(`shots/${tag}.png`) });
    else if (shots === 'stage') await page.locator('#sheet').screenshot({ path: path.resolve(`shots/${tag}.png`) });
  }
}
// back to Artistic keeps the photo and today's look
await page.evaluate(() => window.SP.setMode('artistic'));
await page.waitForTimeout(800);
const back = await page.evaluate(() => ({ mode: window.SP.doc.mode, path: window.SP.geom?.path, brush: window.SP.doc.brush, photo: !!window.SP.photo }));
if (back.mode !== 'artistic' || back.path !== 'spiral' || !back.photo) fails.push('back to artistic: ' + JSON.stringify(back));
console.log('back to artistic:', JSON.stringify(back));
if (logs.length) { console.log(logs.slice(0, 20).join('\n')); fails.push(`${logs.length} console errors`); }
console.log(fails.length ? 'FAIL\n' + fails.join('\n') : 'PASS');
await browser.close();
process.exit(fails.length ? 1 : 0);
