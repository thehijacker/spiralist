// Profiling shim for dev/paper-lab-prof.html: re-exports js/papers.js with parts of the GLSL
// switched off by ?v=a,b,c (keys in dev/paper-variants.js). mode=profv on paper-lab.html
// compares several variants in one page and is the better tool; this one checks a variant's look.
// ('?real' keeps the page's import map, which points /js/papers.js at this file, from looping)
import * as base from '../js/papers.js?real';
import { applyVariant } from './paper-variants.js';

const keys = (new URLSearchParams(location.search).get('v') || '').split(',').filter(Boolean);
const g = applyVariant(keys, { surf: base.PAPER_SURFACE_GLSL, tile: base.PAPER_TILE_GLSL });

export const { PAPERS, paperById, SHEET_MM } = base;
export const PAPER_TILE_GLSL = g.tile;
export const PAPER_SURFACE_GLSL = g.surf;
