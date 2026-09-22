// Download / Save dialog: PNG (2K / 4K / 8K, paper or transparent) or SVG (single stroke,
// filled outline, plotter fill), plus copy-to-clipboard. Choices are remembered; Ctrl+S reuses them.

import { bindSeg, toast, announce } from './ui.js';

export function createDownloadDialog(app) {
  const $ = id => document.getElementById(id);
  const dlg = $('dlDialog');
  const d = app.prefs.download;
  let exp = null;
  let busy = false;

  const load = async () => (exp ||= await import('./export.js'));

  const segs = {
    format: bindSeg(dlg.querySelector('[data-dl="format"]'), d.format, v => { d.format = v; save(); refresh(); }),
    size: bindSeg(dlg.querySelector('[data-dl="size"]'), String(d.size), v => { d.size = +v; save(); refresh(); }),
    background: bindSeg(dlg.querySelector('[data-dl="background"]'), d.background, v => { d.background = v; save(); refresh(); }),
    svgMode: bindSeg(dlg.querySelector('[data-dl="svgMode"]'), d.svgMode, v => { d.svgMode = v; save(); refresh(); }),
  };
  const svgPaper = $('dlSvgPaper');
  svgPaper.checked = !!d.svgPaper;
  svgPaper.addEventListener('change', () => { d.svgPaper = svgPaper.checked; save(); refresh(); });
  const save = () => app.persist();

  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  const baseName = () => ['spiralist', slug(app.photo?.name || 'drawing') || 'drawing', slug(app.renderState().brush.name)];

  function svgModeFor(tech) {
    // single stroke only makes sense for the constant-width wave; width techniques get an outline
    if (d.svgMode === 'stroke' && tech !== 'wave') return 'outline';
    return d.svgMode;
  }

  function refresh() {
    const st = app.renderState();
    const max = exp ? exp.maxExportSize() : 4096;
    for (const b of dlg.querySelectorAll('[data-dl="size"] [role="radio"]')) {
      b.disabled = +b.dataset.v > max;
      b.hidden = +b.dataset.v > max && +b.dataset.v > 4096;
    }
    if (d.size > max) { d.size = max >= 4096 ? 4096 : 2048; segs.size.set(String(d.size)); }
    const isPng = d.format === 'png';
    dlg.querySelector('.dl-png').hidden = !isPng;
    dlg.querySelector('.dl-svg').hidden = isPng;
    $('dlCopy').hidden = !isPng || !exp || typeof ClipboardItem === 'undefined';
    const cm = (d.size / 300 * 2.54).toFixed(0);
    $('dlSizeNote').textContent = `${d.size} × ${d.size} px · prints ${cm} × ${cm} cm at 300 dpi`;
    $('dlBgNote').hidden = !(d.background === 'transparent' && st.cover);
    const tech = st.geom?.technique;
    const mode = svgModeFor(tech);
    segs.svgMode.set(mode);
    const strokeBtn = dlg.querySelector('[data-dl="svgMode"] [data-v="stroke"]');
    strokeBtn.disabled = tech !== 'wave';
    strokeBtn.title = tech !== 'wave' ? 'Switch the line to Wave for a single constant-width stroke' : '';
    const pen = st.geom?.penWidth ? (st.geom.penWidth * 84).toFixed(2) : null;
    $('dlSvgNote').textContent = mode === 'stroke'
      ? `One single stroke${pen ? `, ${pen} mm wide` : ''}, 200 × 200 mm — ready for a pen plotter.`
      : mode === 'plotter'
        ? 'One single stroke that zig-zags to fill the line’s width with a 0.3 mm pen — for plotters.'
        : 'One filled outline of the whole line — for laser, vinyl or print. Brush texture and paper aren’t included.';
    $('dlGo').querySelector('span').textContent = isPng ? 'Download PNG' : 'Download SVG';
    $('dlStat').textContent = '';
  }

  async function open() {
    await load();
    refresh();
    dlg.showModal();
    $('dlGo').focus();
  }

  async function run() {
    if (busy) return;
    await load();
    const st = app.renderState();
    if (!st.geom) return;
    busy = true;
    const btn = $('dlGo');
    const label = btn.querySelector('span');
    const was = label.textContent;
    btn.disabled = true;
    try {
      if (d.format === 'png') {
        const transparent = d.background === 'transparent';
        label.textContent = 'Rendering…';
        const blob = await exp.exportPNG(st, {
          size: d.size, transparent,
          onProgress: p => { label.textContent = `Rendering… ${Math.round(p * 100)}%`; },
        });
        const name = exp.fileName([...baseName(), String(d.size), ...(transparent ? ['transparent'] : [])], 'png');
        exp.downloadBlob(blob, name);
        toast(`Saved ${name}`);
        announce(`Saved ${name}`);
      } else {
        const mode = svgModeFor(st.geom.technique);
        const svg = exp.buildSVG(st.geom, { mode, ink: st.photoColor ? '#1c1b19' : st.ink, paper: d.svgPaper ? st.paper.color : null, sizeMm: 200, layout: st.layout });
        const stats = exp.svgStats(svg);
        const blob = new Blob([svg], { type: 'image/svg+xml' });
        const name = exp.fileName([...baseName(), mode], 'svg');
        exp.downloadBlob(blob, name);
        $('dlStat').textContent = `${stats.paths} path · ${stats.nodes.toLocaleString()} points · ${(stats.bytes / 1e6).toFixed(1)} MB`;
        toast(`Saved ${name}`);
        announce(`Saved ${name}`);
      }
      if (dlg.open) dlg.close();
    } catch (e) {
      console.error(e);
      if (d.format === 'png' && d.size > 2048) {
        toast(`That size was too big for this device — try ${d.size === 8192 ? '4K' : '2K'}.`, { error: true });
      } else {
        toast('Saving failed. Please try again.', { error: true });
      }
    } finally {
      busy = false;
      btn.disabled = false;
      label.textContent = was;
    }
  }

  $('dlGo').addEventListener('click', run);
  $('dlCopy').addEventListener('click', async () => {
    if (!exp) return;   // loaded when the dialog opened; no await before the clipboard call
    const st = app.renderState();
    // ClipboardItem must be created synchronously inside the click (Safari), fed a promise.
    const ok = await exp.copyPNG(exp.exportPNG(st, { size: 2048, transparent: false }));
    toast(ok ? 'Copied the drawing to the clipboard.' : 'This browser blocked copying — use Download instead.', { error: !ok });
  });

  return {
    open,
    async quick() { await load(); refresh(); run(); },
  };
}
