// Runs realistic-mode builds (js/real/index.js) in a module Worker so the page never freezes for
// a stipple tour or a masterpiece scribble; falls back to the main thread (a macrotask per job)
// where module workers are missing or fail to load.
//
//   const b = new RealBuilder();
//   const geom = await b.build(style, field, opts, { tag: 'stage', priority: true });
//   // null when a newer job with the same tag replaced this one before it started
//
// One job runs at a time; priority jobs (the stage) go before queued thumbnails. The hand clock is
// reinstalled as the geometry's pacing tables on arrival (Maps do not need to cross the thread).

import { buildReal, installHandPacing } from './index.js';

export class RealBuilder {
  constructor() {
    this.queue = [];
    this.current = null;
    this.worker = null;
    this.broken = typeof Worker === 'undefined';
    this.seq = 0;
    this.onIdle = null;
  }

  get busy() { return !!this.current || this.queue.length > 0; }

  build(style, field, opts, { tag = null, priority = false } = {}) {
    return new Promise(resolve => {
      // a newer job for the same purpose makes a queued one pointless
      if (tag) {
        for (const j of this.queue.filter(q => q.tag === tag)) j.resolve(null);
        this.queue = this.queue.filter(q => q.tag !== tag);
      }
      const job = { id: ++this.seq, style, field: { G: field.G, D: field.D, rings: field.rings, rgb: null, raster: null }, opts, tag, resolve };
      if (priority) {
        const i = this.queue.findIndex(q => !q.priority);
        job.priority = true;
        this.queue.splice(i < 0 ? this.queue.length : i, 0, job);
      } else this.queue.push(job);
      this._pump();
    });
  }

  _ensureWorker() {
    if (this.worker || this.broken) return this.worker;
    try {
      this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = e => this._done(e.data);
      this.worker.onerror = e => {
        // the module could not load here (old engine, blocked): build on the main thread instead
        e.preventDefault?.();
        console.warn('realistic builder: worker failed, building on the main thread');
        this.broken = true;
        try { this.worker.terminate(); } catch { /* gone */ }
        this.worker = null;
        const job = this.current;
        this.current = null;
        if (job) this.queue.unshift(job);
        this._pump();
      };
    } catch {
      this.broken = true;
      this.worker = null;
    }
    return this.worker;
  }

  _pump() {
    if (this.current || !this.queue.length) {
      if (!this.current && !this.queue.length) this.onIdle?.();
      return;
    }
    const job = this.current = this.queue.shift();
    job.t0 = performance.now();
    const w = this._ensureWorker();
    if (w) {
      w.postMessage({ id: job.id, style: job.style, field: job.field, opts: job.opts });
      return;
    }
    setTimeout(() => {
      if (this.current !== job) return;
      try { this._done({ id: job.id, geom: buildReal(job.style, job.field, job.opts) }); }
      catch (e) { this._done({ id: job.id, error: String(e && e.message || e) }); }
    }, 0);
  }

  _done(msg) {
    const job = this.current;
    if (!job || msg.id !== job.id) return;
    this.current = null;
    if (msg.error) {
      console.error('realistic build failed:', msg.error);
      job.resolve(null);
    } else {
      const g = msg.geom;
      installHandPacing(g);
      // wall time as the user waits for it (worker build + transfer), for the report and the UI
      g.real.waitMs = Math.round(performance.now() - job.t0);
      job.resolve(g);
    }
    this._pump();
  }
}
