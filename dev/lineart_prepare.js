// LineArtEngine smoke test: prepare() progress stages, lines() cache, build() in the Worker.
//   node tests/shoot.mjs "/dev/lineart_prepare.html" --timeout 300000
import { CROP_DEFAULTS } from '../js/tone.js';
import { LineArtEngine, LINE_STYLES } from '../js/lineart/index.js';

async function run() {
  const eng = new LineArtEngine();
  const stages = [];
  let last = null;
  const t0 = performance.now();
  const warm = await eng.prepare(p => {
    if (!last || last.stage !== p.stage || p.loaded === p.total) stages.push({ stage: p.stage, loaded: p.loaded, total: p.total, ms: Math.round(performance.now() - t0) });
    last = p;
  });
  const { makeSample } = await import('../js/samples.js');
  const src = await makeSample('bust', 1024);
  const t1 = performance.now();
  const a = await eng.lines(src, CROP_DEFAULTS, { detail: 0.45 });
  const firstMs = Math.round(performance.now() - t1);
  const t2 = performance.now();
  const b = await eng.lines(src, CROP_DEFAULTS, { detail: 0.45 });
  const cachedMs = Math.round(performance.now() - t2);
  const t3 = performance.now();
  await eng.lines(src, CROP_DEFAULTS, { detail: 0.7 });
  const otherDetailMs = Math.round(performance.now() - t3);
  const builds = [];
  for (const st of LINE_STYLES) {
    const g = await eng.build(st.id, a, { sheetMm: 210, seed: 3 }, { tag: null });
    builds.push({ style: g.lineart.style, lengthM: g.lineart.lengthM, handS: g.lineart.handSeconds, engine: g.lineart.engine, buildMs: g.lineart.buildMs, waitMs: g.lineart.timings.waitMs, workerMs: g.lineart.workerMs ?? null });
  }
  // a newer stage build makes the older one resolve null
  const p1 = eng.build('matisse', a, { sheetMm: 210 }), p2 = eng.build('brush', a, { sheetMm: 210 });
  const [r1, r2] = await Promise.all([p1, p2]);
  window.__done = { ok: true, warm, stages: stages.slice(0, 4).concat(stages.slice(-4)), nStages: stages.length, firstMs, cachedMs, cachedFlag: !!b.cached, otherDetailMs, timings: a.timings, builds, staleNull: r1 === null, fresh: r2 && r2.lineart.style };
}
run().catch(e => { console.error(e); window.__done = { ok: false, error: String(e && e.stack || e) }; });
