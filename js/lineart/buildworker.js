// Line art builds (js/lineart/styles.js buildStyled) off the main thread. index.js posts
// { id, styleId, lines: { strokes, features, engine }, opts } and gets { id, ok, geom } back.
// The pacing Map crosses as a structured clone (handT stays one array).
import { buildStyled } from './styles.js';

self.onmessage = e => {
  const { id, styleId, lines, opts } = e.data;
  try {
    const t0 = performance.now();
    const geom = buildStyled(styleId, lines, opts);
    geom.lineart.workerMs = Math.round(performance.now() - t0);
    const transfer = [geom.data.buffer, geom.handT.buffer, geom.lineart.seg.buffer, geom.lineart.stroke.buffer];
    // _pace holds handT three times; rebuilt on arrival instead of cloned
    geom._pace = null;
    self.postMessage({ id, ok: true, geom }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.stack || err) });
  }
};
