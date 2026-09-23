// Thumbnail scheduler: every preview (looks, tool chips, paper chips) is rendered by ONE shared
// offscreen Renderer — a context per chip would exhaust the browser's WebGL context budget — then
// copied into a plain 2D canvas. Jobs run one per idle slice; a job whose key already matches its
// canvas is skipped, and a new generation of jobs for the same canvas replaces the old one.
//
// The renderer never waits for a shader compile (block: false): a chip whose tool still compiles
// goes back in line with its skeleton showing, and the page keeps responding. Once the queue has
// been empty for a while the wet grid is freed, so idle chips hold no simulation memory.

import { Renderer } from './renderer.js';

export class Thumbs {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.renderer = null;
    this.queue = new Map();       // target canvas -> job
    this.running = false;
    this.failed = false;
  }

  _ensure() {
    if (this.renderer || this.failed) return this.renderer;
    try {
      // keepCanvas: chips of different sizes share one canvas (resizing a WebGL canvas waits for
      // all queued GPU work, hundreds of ms while programs compile); each is its bottom-left corner
      this.renderer = new Renderer(this.canvas, {
        block: false, keepCanvas: true, lowMemory: true,
        onLost: () => { this.lostAt = performance.now(); },
        onRestored: () => this.invalidateAll(),
      });
    } catch { this.failed = true; }
    return this.renderer;
  }

  /**
   * job: { canvas, key, width, height, needs: { brush, paper }, render(renderer) -> boolean | 'pending' }
   * `render` configures the renderer (size already set) and returns false to skip drawing.
   * `needs` (optional) lets a chip wait for its programs before it builds anything.
   * `priority` jobs jump the queue.
   */
  add(job, priority = false) {
    if (job.canvas.dataset.key === job.key) { this.queue.delete(job.canvas); return; }
    if (priority) {
      const rest = [...this.queue];
      this.queue = new Map([[job.canvas, job], ...rest.filter(([c]) => c !== job.canvas)]);
    } else {
      this.queue.set(job.canvas, job);
    }
    this._kick();
  }

  invalidateAll() {
    for (const c of document.querySelectorAll('canvas[data-key]')) delete c.dataset.key;
  }

  _kick() {
    if (this.running) return;
    this.running = true;
    const idle = window.requestIdleCallback
      ? cb => requestIdleCallback(cb, { timeout: 120 })
      : cb => setTimeout(() => cb({ timeRemaining: () => 8 }), 16);
    const step = deadline => {
      const r = this._ensure();
      if (!r) { this.running = false; return; }
      const t0 = performance.now();
      const waiting = [];
      while (this.queue.size && (performance.now() - t0 < 12 || deadline.timeRemaining() > 4)) {
        const [canvas, job] = this.queue.entries().next().value;
        this.queue.delete(canvas);
        if (!canvas.isConnected || canvas.dataset.key === job.key) continue;
        // its tool's programs are still compiling (off this thread): try again shortly. Only the
        // first few waiting chips may start compiles: the driver's compile threads are shared with
        // the stage and the film, and a flood of chips would queue in front of them.
        if (job.needs && r.pending(job.needs.brush, job.needs.paper, waiting.length < 2)) { waiting.push([canvas, job]); continue; }
        try {
          r.setSize(job.width, job.height);
          const out = job.render(r);
          if (out === 'pending') { waiting.push([canvas, job]); continue; }
          if (out === false) continue;
          if (canvas.width !== job.width) canvas.width = job.width;
          if (canvas.height !== job.height) canvas.height = job.height;
          const g = canvas.getContext('2d');
          g.clearRect(0, 0, canvas.width, canvas.height);
          g.drawImage(r.canvas, 0, r.canvas.height - job.height, job.width, job.height, 0, 0, job.width, job.height);
          canvas.dataset.key = job.key;
          canvas.parentElement?.querySelector('.skeleton')?.remove();
        } catch (e) {
          console.warn('thumbnail failed', e);
        }
        if (performance.now() - t0 > 40) break;
      }
      // back in line behind the rest (a newer job for the same canvas, added meanwhile, wins)
      for (const [c, j] of waiting) if (!this.queue.has(c)) this.queue.set(c, j);
      if (!this.queue.size) {
        this.running = false;
        // idle for a while (not between the bursts of one Look or tool switch): free the grid
        clearTimeout(this.freeTimer);
        this.freeTimer = setTimeout(() => { if (!this.running) r.freeSim(); }, 8000);
      } else if (waiting.length && waiting.length >= this.queue.size) {
        setTimeout(() => idle(step), 50);   // only compiling chips left: poll, don't spin
      } else {
        idle(step);
      }
    };
    idle(step);
  }
}
