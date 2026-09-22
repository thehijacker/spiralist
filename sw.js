// Offline support: after the first visit the app keeps working without a network (photos never
// needed one). Network-first for everything this site serves, so an update is picked up on the
// next load and modules from two different releases are never mixed; the cache is the fallback.
// Google Fonts are cached on first use.
const CACHE = 'spiralist-2026-09-23';
const SHELL = [
  './', './index.html', './css/app.css', './manifest.webmanifest', './icon.svg', './vendor/mp4-muxer.mjs',
  './js/app.js', './js/brushes.js', './js/download.js', './js/encoder.js', './js/export.js', './js/film.js',
  './js/freeline.js', './js/history.js', './js/imageio.js', './js/materials.js', './js/maze.js', './js/papers.js',
  './js/renderer.js', './js/samples.js', './js/scene.js', './js/share.js', './js/shaders.js', './js/spiral.js', './js/store.js',
  './js/thumbs.js', './js/tone.js', './js/tools.js', './js/ui.js',
];

self.addEventListener('install', e => {
  // add files one by one: a single missing file must not stop the rest from being cached
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const font = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== location.origin && !font) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (font) {
      const hit = await cache.match(req);
      if (hit) return hit;
    }
    try {
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
