// Realistic mode exports in the real app: the PNG (rendered with the real sheet size and light) and
// the SVG (a real-size plotter file). Saves shots/rm_export_<style>_<tool>.png and prints the SVG
// header.   node tests/real.export.mjs [--style squiggle] [--tool charcoal] [--size 2048] [--light raking]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const style = opt('style', 'squiggle'), tool = opt('tool', 'charcoal'), size = +opt('size', 2048), light = opt('light', 'window');
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/github|403/.test(m.text())) errors.push(m.text()); });
await page.goto('http://localhost:8830/');
await page.waitForFunction(() => window.SP && window.SP.geom && !window.SP.play.playing, null, { timeout: 60000 });
const r = await page.evaluate(async ({ style, tool, size, light }) => {
  const SP = window.SP;
  SP.setMode('realistic'); SP.setRealStyle(style); SP.setRealTool(tool);
  SP.change(d => { d.real.light = light; }, { level: 'render' });
  for (let i = 0; i < 600; i++) { await new Promise(res => setTimeout(res, 50)); if (!SP.building && SP.geom?.real?.style === style && SP.geom.real.tool === tool) break; }
  const exp = await import('/js/export.js');
  const st = SP.renderState();
  const t0 = performance.now();
  const blob = await exp.exportPNG(st, { size });
  const ms = Math.round(performance.now() - t0);
  const data = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
  const name = `rm_export_${style}_${tool}_${light}`;
  await fetch('/__shot', { method: 'POST', body: JSON.stringify({ name, data }) });
  const svg = exp.buildSVG(st.geom, { mode: 'outline', ink: st.ink, sizeMm: 200, layout: st.layout });
  return { name, ms, bytes: blob.size, sheetMm: st.sheetMm, light: st.light?.id, svgHead: svg.slice(0, 700), stats: exp.svgStats(svg) };
}, { style, tool, size, light });
console.log(JSON.stringify({ ...r, svgHead: undefined }));
console.log(r.svgHead);
if (errors.length) console.log('ERRORS\n' + errors.join('\n'));
await browser.close();
