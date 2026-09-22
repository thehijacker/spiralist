// Thumbnail scheduler: every preview (looks, tool chips, paper chips) is rendered by ONE shared
// offscreen Renderer — a context per chip would exhaust the browser's WebGL context budget — then
// copied into a plain 2D canvas. Jobs run one per idle slice; a job whose key already matches its
// canvas is skipped, and a new generation of jobs for the same canvas replaces the old one.

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
      this.renderer = new Renderer(this.canvas, {
        onLost: () => { this.lostAt = performance.now(); },
        onRestored: () => this.invalidateAll(),
      });
    } catch { this.failed = true; }
    return this.renderer;
  }

  /**
   * job: { canvas, key, width, height, render(renderer) -> boolean }
   * `render` configures the renderer (size already set) and returns false to skip drawing.
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
      while (this.queue.size && (performance.now() - t0 < 12 || deadline.timeRemaining() > 4)) {
        const [canvas, job] = this.queue.entries().next().value;
        this.queue.delete(canvas);
        if (!canvas.isConnected || canvas.dataset.key === job.key) continue;
        try {
          r.setSize(job.width, job.height);
          if (job.render(r) === false) continue;
          if (canvas.width !== job.width) canvas.width = job.width;
          if (canvas.height !== job.height) canvas.height = job.height;
          const g = canvas.getContext('2d');
          g.clearRect(0, 0, canvas.width, canvas.height);
          g.drawImage(r.canvas, 0, 0);
          canvas.dataset.key = job.key;
          canvas.parentElement?.querySelector('.skeleton')?.remove();
        } catch (e) {
          console.warn('thumbnail failed', e);
        }
        if (performance.now() - t0 > 40) break;
      }
      if (this.queue.size) idle(step);
      else this.running = false;
    };
    idle(step);
  }
}
