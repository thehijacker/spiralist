// Builds realistic-mode geometry off the main thread: a stipple tour or a masterpiece scribble
// takes 0.2-1.5 s, which would freeze the page (and the stage's playback) if run inline.
// Message in: { id, style, field: { G, D, rings }, opts }. Out: { id, geom } | { id, error }.

import { buildReal } from './index.js';

self.onmessage = e => {
  const { id, style, field, opts } = e.data;
  try {
    const geom = buildReal(style, field, opts);
    // the pacing tables are the hand clock again; the main thread reinstalls them (saves a copy)
    geom._pace = null;
    const transfer = [geom.data.buffer];
    if (geom.handT && geom.handT.buffer !== geom.data.buffer) transfer.push(geom.handT.buffer);
    self.postMessage({ id, geom }, transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
