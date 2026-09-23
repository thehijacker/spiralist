// The stage loupe: zoom into the sheet and see the medium at its true resolution (fibres,
// feathering, pools, grit, sheen), not upscaled pixels. The whole sheet at 460-930 CSS px puts
// 0.2-0.45 mm of paper in one pixel, so most of the physics is sub-pixel at fit.
//
// View state: zoom z >= 1 (1 = the whole sheet fills the stage canvas) and the view's centre in
// sheet fractions. Rendering is progressive: while a gesture or an eased zoom is moving, the last
// images (the full sheet at canvas size, plus the last sharp close-up on top where it covers) are
// mapped onto the canvas every frame (one textured triangle: renderer.present); once it has been
// still for IDLE_MS the visible rect is rendered at full density (renderer.renderToTexture with a
// rect), on whole texels, so each pixel is exactly what a render of the sheet that large would hold.
// Where the GPU keeps up (a desktop: 4-14 ms per close-up from scratch at 1400 px), moving views are
// rendered sharp every frame as well; the frame rate decides, and the preview takes over if it drops.

const IDLE_MS = 70;           // a still view gets its sharp render this long after the last input
const LIVE_MS = 22;           // sharp renders while moving only while frames stay this quick
const TAU_MS = 75;            // eased zoom time constant
const MM_PER_PX_MIN = 0.015;  // deepest zoom: one CSS pixel shows this much paper
const NICE_MM = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Loupe {
  /**
   * sheet: the stage's sheet element (gestures, CSS size); ui: { bar, zoom, rule, mm, btnIn,
   * btnOut, btnFit, btnToggle } (all optional); sheetMm(): the sheet's real width in mm;
   * canZoom(): false while framing / picking / no photo; onChange(): a frame is needed;
   * onGesture(): a pan or pinch began (the app cancels its long-press compare);
   * announce(text): screen-reader message; reducedMotion(): no easing.
   */
  constructor(sheet, { ui = {}, sheetMm = () => 200, canZoom = () => true, onChange = () => {},
    onGesture = () => {}, announce = () => {}, reducedMotion = () => false } = {}) {
    this.sheet = sheet;
    this.ui = ui;
    this.sheetMm = sheetMm;
    this.canZoom = canZoom;
    this.onChange = onChange;
    this.onGesture = onGesture;
    this.announce = announce;
    this.reducedMotion = reducedMotion;
    this.z = 1; this.zT = 1;
    this.c = [0.5, 0.5]; this.cT = [0.5, 0.5];
    this.anchor = null;         // { a: sheet point, s: screen fraction } held fixed while easing
    this.t = 0;
    this.lastInput = 0;
    this.pointers = new Map();  // pointerId -> [clientX, clientY]
    this.moved = 0;             // px dragged since the pointer went down (tap vs pan)
    this.tap = null;            // the last touch tap, for double-tap
    this.base = null; this.baseKey = '';
    this.fine = null; this.sharpKey = '';
    this.stats = { sharp: 0, live: 0, preview: 0, sharpMs: [], previewMs: [] };
    this.live = { t: 0, was: false, ema: 0, off: 0, fails: 0 };
    this.fails = 0;             // draws in a row that could not render (lost context)
    this._said = this.describe();
    this._bind();
    this._syncUi();
  }

  // ------------------------------------------------------------------------------ view
  /** True while anything but the fitted sheet is (or is about to be) shown. */
  get active() { return this.z > 1.0005 || this.zT > 1.0005; }

  /** Sheet width in CSS px (the stage's canvas box). */
  get cssW() { return this.sheet.clientWidth || 600; }

  maxZoom() { return Math.max(4, this.sheetMm() / (MM_PER_PX_MIN * this.cssW)); }

  /** Visible part of the sheet, [x0, y0, x1, y1] in sheet fractions. */
  view(z = this.z, c = this.c) {
    const h = 0.5 / z;
    return [c[0] - h, c[1] - h, c[0] + h, c[1] + h];
  }

  _clampC(c, z) {
    const h = 0.5 / z;
    return [clamp(c[0], h, 1 - h), clamp(c[1], h, 1 - h)];
  }

  /** Screen fraction (0..1 across the sheet box) -> sheet point under it now. */
  sheetAt(s) {
    const v = this.view();
    return [v[0] + s[0] / this.z, v[1] + s[1] / this.z];
  }

  /** Client px -> screen fraction of the sheet box. */
  _frac(x, y) {
    const r = this.sheet.getBoundingClientRect();
    return [(x - r.left) / r.width, (y - r.top) / r.height];
  }

  /**
   * Zoom by `factor` keeping the sheet point under screen fraction `s` where it is (default: the
   * middle). Eased unless instant (direct manipulation) or reduced motion.
   */
  zoomBy(factor, s = [0.5, 0.5], { instant = false } = {}) {
    this.zoomTo(this.zT * factor, s, { instant });
  }

  /** Zoom to zT (1 = fit) around screen fraction s; closer only while the app allows it. */
  zoomTo(zT, s = [0.5, 0.5], { instant = false } = {}) {
    zT = clamp(zT, 1, this.maxZoom());
    if (zT > this.zT && !this.canZoom()) return;
    const a = this.sheetAt(s);
    this.zT = zT;
    this.cT = this._clampC([a[0] + (0.5 - s[0]) / zT, a[1] + (0.5 - s[1]) / zT], zT);
    this.anchor = { a, s };
    if (instant || this.reducedMotion()) this._jump();
    this._input();
  }

  /** Back to the whole sheet. */
  fit({ instant = false } = {}) {
    this.zT = 1; this.cT = [0.5, 0.5]; this.anchor = null;
    if (instant || this.reducedMotion()) this._jump();
    this._input();
  }

  /** Move the view by a drag of (dx, dy) CSS px (content follows the finger). */
  panBy(dx, dy) {
    const k = 1 / (this.cssW * this.z);
    const d = [-dx * k, -dy * k];
    this.c = this._clampC([this.c[0] + d[0], this.c[1] + d[1]], this.z);
    this.cT = this._clampC([this.cT[0] + d[0], this.cT[1] + d[1]], this.zT);
    if (this.anchor) this.anchor.a = [this.anchor.a[0] + d[0], this.anchor.a[1] + d[1]];
    this._input();
  }

  _jump() {
    this.z = this.zT; this.c = this._clampC(this.cT, this.z); this.anchor = null;
  }

  _input() {
    this.lastInput = performance.now();
    this._syncUi();
    // (said once the zoom settles, and only when it changed: a pan alone says nothing)
    clearTimeout(this._announceT);
    this._announceT = setTimeout(() => {
      const d = this.describe();
      if (d !== this._said) { this._said = d; this.announce(d); }
    }, 600);
    this.onChange();
  }

  /** Advance the eased zoom; true while it is still moving. */
  step(now) {
    const dt = Math.min(64, Math.max(0, now - (this.t || now)));
    this.t = now;
    const lz = Math.log(this.z), lt = Math.log(this.zT);
    const k = 1 - Math.exp(-dt / TAU_MS);
    let moving = false;
    if (lz !== lt) {
      const l = Math.abs(lt - lz) < 0.003 ? lt : lz + (lt - lz) * k;
      this.z = l === lt ? this.zT : Math.exp(l);
      moving = this.z !== this.zT;
    }
    if (this.anchor && moving) {
      // the anchored sheet point stays under its screen point all the way (not just at the end)
      const { a, s } = this.anchor;
      this.c = [a[0] + (0.5 - s[0]) / this.z, a[1] + (0.5 - s[1]) / this.z];
    } else {
      const dc = Math.hypot(this.cT[0] - this.c[0], this.cT[1] - this.c[1]);
      if (dc * this.cssW * this.z < 0.05) this.c = [...this.cT];
      else { this.c = [this.c[0] + (this.cT[0] - this.c[0]) * k, this.c[1] + (this.cT[1] - this.c[1]) * k]; moving = true; }
    }
    if (!moving) this.anchor = null;
    this.c = this._clampC(this.c, this.z);
    if (moving) this._syncUi();
    return moving;
  }

  /** Needs another frame: easing, a gesture, or a sharp render still to come. */
  busy(now) {
    return this.z !== this.zT || this.c[0] !== this.cT[0] || this.c[1] !== this.cT[1] ||
      (this.active && (this.pointers.size > 0 || now - this.lastInput < IDLE_MS + 40 || !this.sharpKey && this.fails < 60));
  }

  moving(now) {
    return this.z !== this.zT || this.c[0] !== this.cT[0] || this.c[1] !== this.cT[1] ||
      this.pointers.size > 0 && this.moved > 2 || now - this.lastInput < IDLE_MS;
  }

  // ------------------------------------------------------------------------------ drawing
  /**
   * Draw the zoomed view on the renderer's canvas (instead of renderer.render). upTo / opts as for
   * render(). Returns false when nothing could be drawn (a compile pending, a lost context).
   */
  draw(r, upTo, opts, now) {
    this.step(now);
    const Wc = r.s.width, Hc = r.s.height;
    const key = `${r.gen}|${upTo}|${opts?.settle ?? ''}`;
    const moving = this.moving(now);
    // Live: where the GPU keeps up (the frames stay under LIVE_MS while it runs), a moving view is
    // rendered sharp every frame too; otherwise the preview below carries the gesture.
    const L = this.live, dt = now - (L.t || now);
    L.t = now;
    if (L.was && dt > 0 && dt < 120) {
      // (smoothed: one dropped frame, often another tab's GPU work, is not a verdict; two are)
      L.ema = L.ema ? L.ema * 0.8 + dt * 0.2 : Math.min(dt, LIVE_MS);
      // (too slow: preview only for a while; after a second time, for good)
      if (L.ema > LIVE_MS) { L.off = ++L.fails > 1 ? Infinity : now + 8000; L.ema = 0; }
    }
    L.was = false;
    if (!moving || now > L.off) {
      // Sharp: the visible rect at the canvas's own density, its origin on a whole texel, so
      // pixel centres land on texel centres (no resampling at all).
      const Wp = Wc * this.z, Hp = Hc * this.z;
      const v = this.view();
      const x0 = Math.round(v[0] * Wp) / Wp, y0 = Math.round(v[1] * Hp) / Hp;
      const rect = [x0, y0, x0 + Wc / Wp, y0 + Hc / Hp];
      const sharpKey = `${key}|${rect.join(',')}|${Wc}x${Hc}`;
      if (sharpKey === this.sharpKey) return true;       // the canvas already holds it
      const t0 = performance.now();
      const t = r.renderToTexture(upTo, { ...opts, rect, size: Wc });
      if (!t) { this.fails++; return false; }       // (busy() gives up after 60 in a row)
      this.fails = 0;
      this.fine = { tex: t.tex, rect: t.rect, gen: r.gen, view: rect };
      r.present(rect, [this.fine]);
      this.sharpKey = sharpKey;
      this._stat('sharpMs', performance.now() - t0);
      this.stats.sharp++;
      if (moving) { L.was = true; this.stats.live++; }
      return true;
    }
    // Moving: the full sheet at canvas size (redrawn only when the drawing changed), with the
    // last sharp close-up over it where it still covers the view.
    const t0 = performance.now();
    const baseKey = `${key}|${Wc}x${Hc}`;
    if (baseKey !== this.baseKey || !this.base) {
      const t = r.renderToTexture(upTo, opts);
      if (!t) { this.fails++; return false; }       // (busy() gives up after 60 in a row)
      this.fails = 0;
      this.base = { tex: t.tex, rect: t.rect };
      this.baseKey = baseKey;
    }
    const layers = [this.base];
    if (this.fine && this.fine.gen === r.gen) layers.push(this.fine);
    r.present(this.view(), layers);
    this.sharpKey = '';
    this._stat('previewMs', performance.now() - t0);
    this.stats.preview++;
    return true;
  }

  _stat(k, ms) {
    const a = this.stats[k];
    a.push(ms);
    if (a.length > 600) a.shift();
  }

  /** Back at fit: free the close-up's targets and forget the images (the canvas renders normally). */
  release(r) {
    if (!this.fine && !this.base) return;
    r.releaseRect();
    this.fine = null; this.base = null; this.baseKey = ''; this.sharpKey = '';
  }

  // ------------------------------------------------------------------------------ UI
  /** mm of paper per CSS px at the current zoom. */
  mmPerPx() { return this.sheetMm() / (this.cssW * this.z); }

  describe() {
    if (!this.active) return 'Zoom reset: the whole sheet';
    return `Zoomed in ${zoomText(this.zT)}. The scale bar shows ${this._rule(this.zT).label}.`;
  }

  /** The scale bar: a round length of paper and its width in CSS px. */
  _rule(z = this.z) {
    const mmPx = this.sheetMm() / (this.cssW * z);
    let mm = NICE_MM[0];
    const most = this.cssW < 500 ? 46 : 72;           // (a phone's sheet: keep the bar compact)
    for (const n of NICE_MM) if (n / mmPx <= most) mm = n;
    return { mm, px: mm / mmPx, label: `${mm} mm` };
  }

  /** The sheet box changed size: the deepest zoom and the ruler's length in px follow it. */
  resize() {
    const m = this.maxZoom();
    if (this.zT > m) { this.zT = m; this.cT = this._clampC(this.cT, m); }
    if (this.z > m) { this.z = m; this.c = this._clampC(this.c, m); }
    this._syncUi();
  }

  _syncUi() {
    const ui = this.ui, on = this.active;
    this.sheet.classList.toggle('zoomed', on);
    if (ui.bar) ui.bar.hidden = !on;
    if (ui.btnToggle) ui.btnToggle.setAttribute('aria-pressed', String(on));
    if (!on) return;
    const rule = this._rule();
    if (ui.zoom) ui.zoom.textContent = zoomText(this.z);
    if (ui.rule) ui.rule.style.width = `${rule.px.toFixed(1)}px`;
    if (ui.mm) ui.mm.textContent = rule.label;
    if (ui.btnIn) ui.btnIn.disabled = this.zT >= this.maxZoom() - 1e-6;
  }

  _bind() {
    const el = this.sheet, ui = this.ui;
    const fromBar = e => ui.bar && e.target instanceof Element && ui.bar.contains(e.target);
    ui.btnIn?.addEventListener('click', () => this.zoomBy(2));
    ui.btnOut?.addEventListener('click', () => (this.zT / 2 <= 1.05 ? this.fit() : this.zoomBy(0.5)));
    ui.btnFit?.addEventListener('click', () => this.fit());
    ui.btnToggle?.addEventListener('click', () => (this.active ? this.fit() : this.zoomTo(6)));

    el.addEventListener('wheel', e => {
      if (!this.canZoom() || fromBar(e)) return;
      e.preventDefault();
      // a trackpad's two-finger swipe (horizontal component, no pinch) pans a zoomed sheet;
      // a wheel or a pinch (ctrlKey) zooms toward the cursor
      if (!e.ctrlKey && e.deltaX && this.active) {
        this.panBy(-e.deltaX, -e.deltaY);
        return;
      }
      const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : e.ctrlKey ? 0.01 : 0.0025;
      const f = Math.exp(-clamp(e.deltaY * unit, -1, 1));
      if (f < 1 && this.zT * f <= 1.02) this.fit();
      else this.zoomBy(f, this._frac(e.clientX, e.clientY));
    }, { passive: false });

    el.addEventListener('pointerdown', e => {
      if (!this.canZoom() || fromBar(e) || e.button > 0) return;
      this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.pointers.size === 1) { this.moved = 0; this.downAt = performance.now(); }
      if (this.pointers.size === 2) this.onGesture();
      if (this.active || this.pointers.size === 2) {
        try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      }
    });
    el.addEventListener('pointermove', e => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev[0], dy = e.clientY - prev[1];
      if (this.pointers.size === 1) {
        this.moved += Math.hypot(dx, dy);
        if (this.active && this.moved > 2) {
          if (!el.classList.contains('panning')) { el.classList.add('panning'); this.onGesture(); }
          this.panBy(dx, dy);
        }
      } else if (this.pointers.size === 2) {
        const other = [...this.pointers.entries()].find(([id]) => id !== e.pointerId)[1];
        const d0 = Math.hypot(prev[0] - other[0], prev[1] - other[1]);
        const d1 = Math.hypot(e.clientX - other[0], e.clientY - other[1]);
        const m0 = [(prev[0] + other[0]) / 2, (prev[1] + other[1]) / 2];
        const m1 = [(e.clientX + other[0]) / 2, (e.clientY + other[1]) / 2];
        this.moved += Math.hypot(dx, dy);
        if (this.active) this.panBy(m1[0] - m0[0], m1[1] - m0[1]);
        if (d0 > 4) {
          const zT = this.z * d1 / d0;
          if (zT <= 1) this.fit({ instant: true });
          else this.zoomTo(zT, this._frac(m1[0], m1[1]), { instant: true });
        }
      }
      this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
    });
    const end = e => {
      if (!this.pointers.delete(e.pointerId)) return;
      if (!this.pointers.size) {
        el.classList.remove('panning');
        // a quick touch tap twice in the same place zooms in (dblclick covers the mouse)
        if (e.type === 'pointerup' && e.pointerType === 'touch' && this.moved < 8 && performance.now() - this.downAt < 300) {
          const now = performance.now();
          const t = this.tap;
          if (t && now - t.at < 320 && Math.hypot(e.clientX - t.x, e.clientY - t.y) < 30) {
            this.tap = null;
            this._zoomStep(this._frac(e.clientX, e.clientY));
          } else this.tap = { at: now, x: e.clientX, y: e.clientY };
        }
        this._input();
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', e => {
      if (!this.canZoom() || fromBar(e) || this.lastTouch()) return;
      if (e.shiftKey) this.zoomBy(1 / 2.5, this._frac(e.clientX, e.clientY));
      else this._zoomStep(this._frac(e.clientX, e.clientY));
    });
    el.addEventListener('pointerdown', e => { this._touchAt = e.pointerType === 'touch' ? performance.now() : 0; }, true);
  }

  lastTouch() { return this._touchAt && performance.now() - this._touchAt < 800; }

  /** Double-click / double-tap: 2.5x closer, or back to fit from the deepest zoom. */
  _zoomStep(s) {
    if (this.zT >= this.maxZoom() - 1e-6) this.fit();
    else this.zoomBy(2.5, s);
  }
}

export function zoomText(z) {
  return z < 9.95 ? `${(Math.round(z * 10) / 10).toFixed(1).replace(/\.0$/, '')}×` : `${Math.round(z)}×`;
}
