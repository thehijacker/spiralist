// End-to-end: the Film dialog's Background picker, through the real UI.
//   node tests/film.dialog.e2e.mjs [--runs 3]
// Checks: 8 swatches in a radiogroup with names and a caption, Nero marble by default; the dialog's
// first preview frame and the desk's full bake are timed (median of --runs page loads); picking a
// swatch (click and arrow keys) switches the live preview at once, persists prefs.film.desk and
// survives closing and reopening; the Flat style keeps the picker and shows the desk too.
// Writes shots/dialog_desk_<id>.png (the dialog) for a look. Requires the dev server (port 8830).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = 'C:/Users/oxman/open-design/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core';
const pw = require(PW);
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const runs = +opt('runs', 3);

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

const browser = await pw.chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const logs = [];
async function boot() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('console', m => { if (['error'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => logs.push('[pageerror] ' + e.message));
  await page.goto(`http://localhost:${opt('port', 8830)}/?v=` + Date.now());
  await page.waitForFunction(() => window.SP && window.SP.geom && !window.SP.play.playing, null, { timeout: 60000 });
  return page;
}
// until the preview shows its first frame, then until the desk is fully baked
async function openTimed(page) {
  const t0 = Date.now();
  await page.evaluate(() => { window.__filmPreview = null; SP.openFilm(); });
  // 90 s: the GPU box is shared, and a busy one delayed the first preview past 30 s (a flake, not a bug)
  await page.waitForFunction(() => window.__filmPreview, null, { timeout: 90000, polling: 16 });
  const first = await page.evaluate(() => window.__filmPreview.firstFrameMs);
  await page.waitForFunction(() => window.__filmPreview.stage() === 'full', null, { timeout: 90000, polling: 16 });
  return { first, full: Date.now() - t0 };
}

// 1. cold opens (fresh page each time: the scene program and the desk are made from scratch)
const cold = [];
for (let k = 0; k < runs; k++) {
  const page = await boot();
  await page.evaluate(() => { SP.prefs.film.desk = 'nero'; SP.prefs.film.style = 'cinematic'; SP.prefs.film.format = 'square'; });
  cold.push(await openTimed(page));
  if (k < runs - 1) await page.close();
  else {
    // 2. the picker
    const info = await page.evaluate(() => {
      const g = document.querySelector('#filmDialog [data-film="desk"]');
      const b = [...g.querySelectorAll('[role="radio"]')];
      return { role: g.getAttribute('role'), label: !!g.getAttribute('aria-labelledby'), n: b.length,
        names: b.map(x => x.getAttribute('aria-label')), checked: b.filter(x => x.getAttribute('aria-checked') === 'true').map(x => x.dataset.v),
        tabbable: b.filter(x => x.tabIndex === 0).map(x => x.dataset.v), cap: document.getElementById('filmDeskCap').textContent,
        imgs: b.every(x => x.querySelector('img')?.complete && x.querySelector('img').naturalWidth > 0) };
    });
    check(info.role === 'radiogroup' && info.label, 'the picker is a labelled radiogroup');
    check(info.n === 8 && info.names.every(Boolean), `8 swatches with accessible names (${info.names.join(', ')})`);
    check(info.checked.join() === 'nero' && info.tabbable.join() === 'nero', 'Nero marble is selected and is the one tab stop');
    check(/Nero marble/.test(info.cap) && /veins/.test(info.cap), `caption: "${info.cap}"`);
    check(info.imgs, 'every swatch image loaded');
    await page.locator('#filmDialog').screenshot({ path: 'shots/dialog_desk_nero.png' });

    // 3. click a swatch: the preview's scene switches at once (stand-in colour, then a quick
    // low-resolution bake, then the full desk), without restarting the film
    await page.waitForTimeout(1500);          // (a person takes a moment to choose)
    const t0 = Date.now();
    const trail = await page.evaluate(async () => {
      document.querySelector('#filmDialog [data-film="desk"] [data-v="velvet"]').click();
      const out = [], s0 = performance.now();
      while (performance.now() - s0 < 3000) {
        const st = window.__filmPreview.stage();
        if (!out.length || out[out.length - 1].stage !== st) out.push({ ms: Math.round(performance.now() - s0), stage: st, desk: window.__filmPreview.desk() });
        if (st === 'full') break;
        await new Promise(r => requestAnimationFrame(r));
      }
      return out;
    });
    const switchMs = Date.now() - t0;
    const st = await page.evaluate(() => ({ desk: SP.prefs.film.desk, cap: document.getElementById('filmDeskCap').textContent,
      checked: document.querySelector('#filmDialog [data-film="desk"] [aria-checked="true"]').dataset.v }));
    check(st.desk === 'velvet' && st.checked === 'velvet' && /Emerald velvet/.test(st.cap), `click selects velvet (${st.cap})`);
    check(trail[0]?.desk === 'velvet' && trail[0].ms < 20, `the preview switches at once (${trail.map(x => `${x.ms} ms ${x.stage}`).join(' -> ')})`);
    check(trail[trail.length - 1]?.stage === 'full', `velvet fully baked within ${switchMs} ms`);
    await page.waitForTimeout(300);
    await page.locator('#filmDialog').screenshot({ path: 'shots/dialog_desk_velvet.png' });

    // 4. keyboard: arrows move the selection (roving tab stop)
    await page.focus('#filmDialog [data-film="desk"] [data-v="velvet"]');
    await page.keyboard.press('ArrowRight');
    const kb = await page.evaluate(() => ({ desk: SP.prefs.film.desk, focus: document.activeElement?.dataset.v }));
    check(kb.desk === 'leather' && kb.focus === 'leather', `ArrowRight moves to leather (${kb.desk}, focus ${kb.focus})`);
    await page.keyboard.press('ArrowLeft');

    // 5. persists: close, reopen (warm: the program and the desk are still in the context)
    await page.click('#filmClose');
    const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => /spiral/i.test(k)) || '{}'))?.film?.desk ?? SP.prefs.film.desk);
    const warm = await openTimed(page);
    const re = await page.evaluate(() => document.querySelector('#filmDialog [data-film="desk"] [aria-checked="true"]').dataset.v);
    check(re === 'velvet', `reopened on velvet (stored: ${persisted})`);
    console.log(`      warm reopen: first frame ${warm.first} ms, full desk ${warm.full} ms`);

    // 6. flat keeps the desk
    await page.click('#filmDialog [data-film="style"] [data-v="flat"]');
    await page.waitForFunction(() => window.__filmPreview && window.__filmPreview.stage() === 'full', null, { timeout: 30000 });
    await page.waitForTimeout(400);
    const flat = await page.evaluate(() => ({ disabled: [...document.querySelectorAll('#filmDialog [data-film="desk"] button')].some(b => b.disabled) }));
    check(!flat.disabled, 'the picker stays enabled for Flat');
    await page.locator('#filmDialog').screenshot({ path: 'shots/dialog_desk_flat.png' });
    await page.evaluate(() => { SP.prefs.film.style = 'cinematic'; SP.prefs.film.desk = 'nero'; SP.persist?.(); });
    await page.close();
  }
}
console.log(`cold open (median of ${runs}): first frame ${median(cold.map(c => c.first))} ms, desk fully baked ${median(cold.map(c => c.full))} ms  [${cold.map(c => `${c.first}/${c.full}`).join(', ')}]`);

// 7. Realistic mode ("true drawing, sped up"): the hand-time estimate and the speed-up show, the
// photo reveal and the pace / start choices go (the hand's own clock and order), the drawing clock
// can be turned off, and a long drawing defaults to 60 s until a length is picked by hand.
{
  const page = await boot();
  const hasReal = await page.evaluate(() => typeof SP.setMode === 'function');
  if (!hasReal) console.log('skip  realistic dialog: the app has no realistic mode');
  else {
    await page.evaluate(() => { SP.prefs.film.lengthChosen = false; SP.prefs.film.length = 15; SP.setMode('realistic'); SP.setRealStyle('stipple'); });
    await page.waitForFunction(() => SP.geom?.real?.style === 'stipple' && !SP.building, null, { timeout: 90000, polling: 250 });
    await openTimed(page);
    const r = await page.evaluate(() => {
      const vis = id => { const el = document.getElementById(id); return !!el && !el.hidden && el.offsetParent !== null; };
      const len = document.querySelector('#filmDialog [data-film="length"] [aria-checked="true"]')?.dataset.v;
      return { hand: document.getElementById('filmHand').textContent, handVis: vis('filmHand'), reveal: vis('filmRevealRow'),
        more: vis('filmMore'), counter: vis('filmCounterRow'), counterOn: document.querySelector('[data-film="counter"]').checked,
        len, go: document.getElementById('filmGoLabel').textContent, secs: SP.geom.real.handSeconds };
    });
    check(r.handVis && /^About .+ of drawing by hand · shown (about [\d.]+× faster|at real speed) in \d+ s$/.test(r.hand), `hand-time line: "${r.hand}"`);
    check(!r.reveal && !r.more && r.counter && r.counterOn, `reveal and pace hidden, clock shown and on (${JSON.stringify({ reveal: r.reveal, more: r.more, counter: r.counter, on: r.counterOn })})`);
    const want = r.secs >= 1800 ? '60' : '15';
    check(r.len === want && r.go.includes(`${want}-second`), `length ${r.len} s for ${Math.round(r.secs / 60)} min of drawing (${r.go})`);
    await page.click('#filmDialog [data-film="length"] [data-v="30"]');
    const picked = await page.evaluate(() => ({ len: SP.prefs.film.length, chosen: SP.prefs.film.lengthChosen, hand: document.getElementById('filmHand').textContent }));
    check(picked.len === 30 && picked.chosen && picked.hand.endsWith('in 30 s'), `a length picked by hand is kept (${picked.hand})`);
    await page.locator('#filmDialog').screenshot({ path: 'shots/rf_dialog_realistic.png' });
    // back to Artistic: everything returns
    await page.click('#filmClose');
    await page.evaluate(() => SP.setMode('artistic'));
    await page.waitForFunction(() => !SP.geom?.real && !SP.building, null, { timeout: 60000, polling: 250 });
    await openTimed(page);
    const a = await page.evaluate(() => ({ hand: !document.getElementById('filmHand').hidden, reveal: !document.getElementById('filmRevealRow').hidden,
      counter: !document.getElementById('filmCounterRow').hidden }));
    check(!a.hand && a.reveal && !a.counter, `artistic: no hand line, reveal back, no clock row (${JSON.stringify(a)})`);
    await page.evaluate(() => { SP.prefs.film.length = 15; SP.prefs.film.lengthChosen = false; SP.persist?.(); });
  }
  await page.close();
}
// Line art (doc.mode 'lineart'): the true drawing at near real speed, 15/30/60 s (no 10 s), 30 s by
// default, the hand time said to the second, the clock row shown, no reveal
{
  const page = await boot();
  const hasLine = await page.evaluate(() => typeof SP.setLineStyle === 'function');
  if (!hasLine) console.log('skip  line art dialog: the app has no Line art mode');
  else {
    await page.evaluate(() => { SP.prefs.film.lengthChosen = false; SP.prefs.film.length = 15; SP.setMode('lineart'); SP.setLineStyle('matisse'); });
    await page.waitForFunction(() => SP.geom?.path === 'lineart' && SP.geom.lineart?.style === 'matisse' && !SP.building, null, { timeout: 240000, polling: 250 });
    await openTimed(page);
    const r = await page.evaluate(() => {
      const vis = el => !!el && !el.hidden && el.offsetParent !== null;
      const lens = [...document.querySelectorAll('#filmDialog [data-film="length"] [data-v]')].filter(vis).map(b => b.dataset.v);
      const len = document.querySelector('#filmDialog [data-film="length"] [aria-checked="true"]')?.dataset.v;
      return { hand: document.getElementById('filmHand').textContent, handVis: vis(document.getElementById('filmHand')), lens, len,
        reveal: vis(document.getElementById('filmRevealRow')), counter: vis(document.getElementById('filmCounterRow')), go: document.getElementById('filmGoLabel').textContent };
    });
    check(r.lens.join(',') === '15,30,60', `lengths offered: ${r.lens.join(', ')} s`);
    check(r.len === '30' && r.go.includes('30-second'), `30 s by default (${r.go})`);
    check(r.handVis && /^(\d+ s|\d+ min \d\d s) of drawing by hand · shown (about [\d.]+× faster|at real speed) in 30 s$/.test(r.hand), `hand-time line: "${r.hand}"`);
    check(!r.reveal && r.counter, `no reveal, clock row shown (${JSON.stringify({ reveal: r.reveal, counter: r.counter })})`);
    await page.click('#filmDialog [data-film="length"] [data-v="60"]');
    const picked = await page.evaluate(() => ({ len: SP.prefs.film.length, hand: document.getElementById('filmHand').textContent }));
    check(picked.len === 60 && picked.hand.endsWith('in 60 s'), `60 s picked (${picked.hand})`);
    await page.locator('#filmDialog').screenshot({ path: 'shots/lf_dialog_lineart.png' });
    // back to Artistic: 10 s is offered again
    await page.click('#filmClose');
    await page.evaluate(() => SP.setMode('artistic'));
    await page.waitForFunction(() => SP.geom?.path !== 'lineart' && !SP.building, null, { timeout: 60000, polling: 250 });
    await openTimed(page);
    const ten = await page.evaluate(() => !document.querySelector('#filmDialog [data-film="length"] [data-v="10"]').hidden);
    check(ten, 'artistic: 10 s offered again');
    await page.evaluate(() => { SP.prefs.film.length = 15; SP.prefs.film.lengthChosen = false; SP.persist?.(); });
  }
  await page.close();
}
if (logs.length) { console.log(logs.slice(0, 20).join('\n')); failures += logs.filter(l => l.includes('pageerror')).length; }
await browser.close();
if (failures) { console.log(`\n${failures} failing`); process.exit(1); }
console.log('\nall passed');
