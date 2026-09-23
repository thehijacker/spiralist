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
    line: { technique: 'wave', rings: 60, penWidth: 0.22, amplitude: 0.9, frequency: 1.6, wobble: 0.2 } },
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

/**
 * Realistic mode's tools: real drawing instruments at their real line width (mm). `sizes` lists
 * the widths the tool comes in (first = default); `name` is what the tool is called in a shop
 * (`chip` = a shorter label where the chip is narrow).
 * Neon is left out: it is a light effect, not something a hand draws with.
 */
export const REAL_TOOLS = [
  { brush: 'fineliner', name: 'Fineliner', sizes: [0.4, 0.3, 0.5, 0.8], ink: '#17171a', paper: 'cream' },
  { brush: 'ballpoint', name: 'Ballpoint', sizes: [0.5], ink: '#1d3a8a', paper: 'cream' },
  { brush: 'fountain', name: 'Fountain pen', sizes: [0.5], label: 'F 0.5 mm', ink: '#141a3a', paper: 'sketch' },
  { brush: 'pencil', name: 'Pencil', sizes: [0.5, 0.7], ink: '#2a2a2e', paper: 'sketch' },
  { brush: 'gold', name: 'Gold paint pen', sizes: [1], ink: '#d9b44a', paper: 'black' },
  { brush: 'marker', name: 'Marker', sizes: [2], ink: '#2d2a32', paper: 'sketch' },
  { brush: 'brush', name: 'Sumi brush', sizes: [3], ink: '#0e0e0e', paper: 'coldpress' },
  { brush: 'watercolour', name: 'Watercolour brush', chip: 'Watercolour', sizes: [4], ink: '#2c4f8a', paper: 'coldpress' },
  { brush: 'charcoal', name: 'Charcoal stick', sizes: [4], ink: '#1b1715', paper: 'coldpress' },
  { brush: 'crayon', name: 'Wax crayon', sizes: [4], ink: '#1f5fa8', paper: 'kraft' },
  { brush: 'chalk', name: 'Chalk', sizes: [5], ink: '#f3f0e8', paper: 'chalkboard' },
];
export const realToolFor = brushId => REAL_TOOLS.find(t => t.brush === brushId) || REAL_TOOLS[0];

/**
 * Line art mode's tools: what continuous-line artists draw with, at real widths (mm; first =
 * default). pressure: the width follows the hand (a nib swells where it slows, a brush presses in
 * the darks); the others keep one width, like the real pen. ink = a dark ink from the tool's own
 * palette (a line artist's marker is black, not the Artistic look's teal).
 */
export const LINE_TOOLS = [
  { brush: 'fineliner', name: 'Fineliner', sizes: [0.5, 0.3, 0.8], ink: '#17171a', paper: 'cream', pressure: false },
  { brush: 'ballpoint', name: 'Ballpoint', sizes: [0.5], ink: '#1d3a8a', paper: 'cream', pressure: false },
  { brush: 'fountain', name: 'Fountain nib', chip: 'Nib', sizes: [0.55, 0.4, 0.8], ink: '#101012', paper: 'cream', pressure: true },
  { brush: 'pencil', name: 'Soft pencil', chip: 'Pencil', sizes: [0.8, 0.5], ink: '#2a2a2e', paper: 'sketch', pressure: true },
  { brush: 'brush', name: 'Sumi brush', chip: 'Brush', sizes: [1.5, 1, 2.5], ink: '#0e0e0e', paper: 'coldpress', pressure: true },
  { brush: 'marker', name: 'Marker', sizes: [1.3, 2], ink: '#2d2a32', paper: 'sketch', pressure: false },
  { brush: 'charcoal', name: 'Charcoal pencil', chip: 'Charcoal', sizes: [1.2, 2], ink: '#1b1715', paper: 'coldpress', pressure: true },
];
export const lineToolFor = brushId => LINE_TOOLS.find(t => t.brush === brushId) || LINE_TOOLS[2];
