// Materials: brushes + papers (re-exported), colour helpers, ink/paper polarity, and Looks.

import { BRUSHES, brushById } from './brushes.js';
import { PAPERS, paperById, SHEET_MM } from './papers.js';

export { BRUSHES, brushById, PAPERS, paperById, SHEET_MM };

export function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
}

export function rgbToHex([r, g, b]) {
  const c = x => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

/** Relative luminance (WCAG) of an sRGB triplet in 0..1. */
export function luminance([r, g, b]) {
  const lin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * How a brush + ink behaves on a paper. The single source of truth for polarity.
 *   cover: light / opaque media composite over the paper instead of multiplying into it
 *   flip:  light ink on darker paper puts MORE ink where the photo is LIGHT
 *   lowContrast: the ink will barely show on this paper
 */
export function inkMode(brush, inkHex, paper, colorFromPhoto = false) {
  const ink = hexToRgb(inkHex), pap = hexToRgb(paper.color);
  const lighter = colorFromPhoto ? !!paper.dark : luminance(ink) > luminance(pap);
  const cover = !!brush.forceCover || lighter;
  const lowContrast = !colorFromPhoto && contrastRatio(ink, pap) < 1.6;
  return { cover, flip: lighter, lowContrast };
}

/** One-click looks: complete combinations known to work together. */
export const LOOKS = [
  { id: 'classic', name: 'Classic ink', brush: 'fineliner', ink: '#17171a', paper: 'cream',
    line: { technique: 'thickness', rings: 72, weight: 0.88, hairline: 0.08, wobble: 0.1 } },
  { id: 'graphite', name: 'Soft pencil', brush: 'pencil', ink: '#2a2a2e', paper: 'sketch',
    line: { technique: 'thickness', rings: 80, weight: 0.92, hairline: 0.1, wobble: 0.18 } },
  { id: 'plotter', name: 'Plotter wave', brush: 'fineliner', ink: '#1f3a93', paper: 'sketch',
    line: { technique: 'wave', rings: 64, penWidth: 0.18, amplitude: 0.9, frequency: 1.3, wobble: 0 } },
  { id: 'crayon', name: 'Wax crayon', brush: 'crayon', ink: '#1f5fa8', paper: 'kraft',
    line: { technique: 'thickness', rings: 46, weight: 0.95, hairline: 0.14, wobble: 0.35 } },
  { id: 'sumi', name: 'Ink brush', brush: 'brush', ink: '#0e0e0e', paper: 'coldpress',
    line: { technique: 'thickness', rings: 50, weight: 0.95, hairline: 0.06, wobble: 0.3 } },
  { id: 'biro', name: 'Blue biro', brush: 'ballpoint', ink: '#1d3a8a', paper: 'cream',
    line: { technique: 'wave', rings: 60, penWidth: 0.16, amplitude: 0.9, frequency: 1.6, wobble: 0.2 } },
  { id: 'chalk', name: 'Chalkboard', brush: 'chalk', ink: '#f3f0e8', paper: 'chalkboard',
    line: { technique: 'thickness', rings: 52, weight: 0.9, hairline: 0.1, wobble: 0.3 } },
  { id: 'gold', name: 'Gold on black', brush: 'gold', ink: '#d9b44a', paper: 'black',
    line: { technique: 'thickness', rings: 64, weight: 0.88, hairline: 0.08, wobble: 0.05 } },
  { id: 'neon', name: 'Neon night', brush: 'neon', ink: '#ff45e9', paper: 'black',
    line: { technique: 'wave', rings: 52, penWidth: 0.16, amplitude: 0.9, frequency: 1.1, wobble: 0 } },
  { id: 'charcoal', name: 'Charcoal', brush: 'charcoal', ink: '#1b1715', paper: 'coldpress',
    line: { technique: 'thickness', rings: 40, weight: 0.95, hairline: 0.12, wobble: 0.3 } },
  { id: 'blueprint', name: 'Blueprint', brush: 'fineliner', ink: '#f4f1ea', paper: 'blueprint',
    line: { technique: 'wave', rings: 60, penWidth: 0.16, amplitude: 0.9, frequency: 1.4, wobble: 0.05 } },
  { id: 'marker', name: 'Marker pop', brush: 'marker', ink: '#d7263d', paper: 'sketch',
    line: { technique: 'thickness', rings: 40, weight: 0.94, hairline: 0.1, wobble: 0.15 } },
  { id: 'wander', name: 'Wandering line', brush: 'fineliner', ink: '#17171a', paper: 'cream',
    line: { path: 'wander', technique: 'thickness', rings: 64, weight: 0.6, hairline: 0.12, wobble: 0.05 }, free: { shape: 'square' } },
  { id: 'oneline', name: 'One-line portrait', brush: 'fountain', ink: '#141a3a', paper: 'sketch',
    line: { path: 'contour', technique: 'thickness', rings: 80, weight: 0.8, hairline: 0.06, wobble: 0.1 }, free: { shape: 'square' } },
  { id: 'labyrinth', name: 'Labyrinth', brush: 'fineliner', ink: '#17171a', paper: 'cream',
    line: { path: 'maze', technique: 'thickness', rings: 80, weight: 0.9, hairline: 0.1, wobble: 0.05 }, free: { shape: 'square', flow: 0.85 } },
  { id: 'goldmaze', name: 'Gold maze', brush: 'gold', ink: '#d9b44a', paper: 'black',
    line: { path: 'maze', technique: 'thickness', rings: 72, weight: 0.88, hairline: 0.1, wobble: 0.03 }, free: { shape: 'circle', flow: 0.85 } },
];

export const lookById = id => LOOKS.find(l => l.id === id) || LOOKS[0];
