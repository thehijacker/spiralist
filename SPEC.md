# Spiralist — build spec and module contracts

A static, client-side web app: pick any photo and it is redrawn as ONE continuous spiral line on a
sheet of paper, in a chosen drawing medium, with a filmable timelapse of the drawing.
Plain ES modules, WebGL2, no framework, no backend. Photos never leave the device.

Dev server: `node dev-server.js 8830` (already running during the build; launch entry
`spiralist`). `POST /__shot {name, data:dataURL}` saves `shots/<name>.png|jpg`;
`POST /__file?name=<file>` saves a raw body to `shots/<file>`.

Headless driver: `node tests/shoot.mjs "/dev/lab.html?sheet=matrix;size=300" [--browser chromium|firefox|webkit]`
— use `;` between query params (Windows shims swallow `&`). Chromium runs on the real GPU (RTX 4070
via ANGLE D3D11). Firefox/WebKit builds come from playwright-core 1.60 (path inside tests/shoot.mjs).
Waits for `window.__done` and prints it plus console errors. Then `Read` the PNG/JPEG to look at it.

Unit tests: `node tests/geometry.test.mjs` (engine). Add your own `tests/<module>.test.mjs`.

## Ground rules for every contributor
- Edit ONLY the files your task owns. If you need a change elsewhere, describe it in your report.
- Match the existing code style: ES modules, 2-space indent, single quotes, semicolons, concise
  comments that explain *why*. No build step, no npm dependencies (vendor/mp4-muxer.mjs is vendored).
- Prefer Write/Edit for JS; bash heredocs in this environment can mangle `\n` and quotes.
- Name your shots with your module prefix (`brush_*`, `paper_*`, `sample_*`, `tool_*`, `enc_*`, `export_*`).
- Do not commit to git. Do not start/stop the dev server (it is shared).
- Verify with real renders / real files, and look at the images you produce.

## Coordinate systems
- **Circle units** (geometry): art circle radius 1, centre (0,0), y down.
- **Paper px**: full-sheet pixels of the current output. Layout `{cx, cy, r}` is in fractions of the
  paper WIDTH; default square sheet: `{cx: .5, cy: .5, r: .42}` (8% margins).
- **Paper units U** = 1/1000 of the sheet width. The virtual sheet is 200 mm wide, so 1 U = 0.2 mm.
  Every texture/brush scale is in U (or relative to stroke width) so all output sizes look alike.

## Engine (done — owned by the lead)
- `js/tone.js` — `rasterize(source, crop, G=1024)`, `processTone(raster, tone, {flip}) -> {L, stats}`,
  `buildField(raster, L, {rings, flip}) -> field`. Auto tone = centre-weighted levels inside the
  circle + gamma solved for a target mean ink coverage (`coverageTarget(darkness)` = 0.42 ± 0.2).
- `js/spiral.js` — `buildSpiral(field, line, {colorFromPhoto}) -> geom`:
  `{ n, data: Float32Array(n*7) [x, y, w, s, tone, turn, dwell], colors: Uint8Array(n*4)|null, rings,
  spacing, length, turns, technique, maxWidth, minWidth, penWidth, start, path: 'spiral' }`.
  `dwell` >= 1 where the pen lingers (tight turns, maze corners): wet media pool there and
  'natural' pacing slows there. Always index points with the exported `STRIDE` (now 7).
  Shared helpers for other path shapes: `lineWidths(line, spacing)`, `wobbleOffset(x, y, wobble, seed, out)`,
  `finishGeometry(g)`.
- `js/maze.js` — `buildMaze(field, line, maze, {colorFromPhoto}) -> geom` with `path: 'maze'`,
  `shape: 'square'|'circle'`, `startPoint`. `maze = { shape, x, y (start, circle units), flow 0..1, seed }`.
  A recursive-backtracker spanning tree grown from the chosen cell (steered along photo contours by
  `flow`); walking around the tree gives one closed, never-crossing path (line spacing = 1/rings);
  corners become quarter circles. `line.rings` = corridors across. The art square is [-1,1]^2.
  One polyline, consecutive points always joined. Pacing: `pacingTable(geom, 'natural'|'steady'|'rings')`,
  `indexAt(geom, f, pacing)`, `progressAt(geom, fi, pacing)`, `headAt(geom, fi) -> {x,y,w,tone,turn}`.
  `previewStroke({technique})` builds a 2.5-turn demo fragment for brush chips.
- `js/renderer.js` — `new Renderer(canvas, {onLost, onRestored})`:
  `setSize(w,h)` (target px) · `setPaperSize(W,H)` + `setOrigin(x,y)` (strip rendering of a bigger
  sheet) · `setLayout({cx,cy,r})` · `setPaper(paperDef, seed)` · `setStyle({brush, ink, cover, photoColor})`
  · `setGeometry(geom)` · `setTransparent(bool)` (straight-alpha ink only) · `render(upToPointIndex=Infinity)`
  (incremental; scrubbing back redraws) · `renderToTexture(upTo) -> {tex, w, h}` (the same image into a
  mipmapped texture of this context, for the film camera) · `renderBlank()` · `destroy()` · `maxSize` · `canvas`.
  Output canvas has `preserveDrawingBuffer: true`, so `drawImage(renderer.canvas, …)` and `toBlob` work any time.
- `js/shaders.js` — assembles programs from `js/brushes.js` (BRUSH_GLSL) and `js/papers.js`
  (PAPER_TILE_GLSL, PAPER_SURFACE_GLSL).
- `js/materials.js` — re-exports BRUSHES/PAPERS, `hexToRgb`, `luminance`, `contrastRatio`,
  `inkMode(brush, inkHex, paper, colorFromPhoto) -> {cover, flip, lowContrast}` (the ONLY place
  tone polarity is decided), `LOOKS`, `lookById`.

### Render state (used by export/film)
```js
const state = {
  geom,                       // from buildSpiral
  brush,                      // BRUSHES entry
  paper,                      // PAPERS entry
  ink: '#17171a',             // hex
  cover: false, photoColor: false,   // from inkMode / settings
  layout: { cx: 0.5, cy: 0.5, r: 0.42 },
  seed: 1,
  shape: 'circle',            // 'circle' | 'square' (square mazes): clip for reveals / previews
};
```
Rendering it at any size: `r.setSize(W,W); r.setLayout(state.layout); r.setPaper(state.paper, state.seed);
r.setStyle(state); r.setGeometry(state.geom); r.render(Infinity);`

## Modules built in parallel

### js/brushes.js — brush tuner
Owns `BRUSHES` data (inks as `[hex, name]`, `spread`, `lightInk`, `glow: {amount, tight, wide}`,
`forceCover`, `prefersDark`) and `BRUSH_GLSL` (`brushDeposit(int brush, Stroke st, inout vec3 ink)`).
Shader ids 0..10 are fixed (renderer passes `brush.shader`).

### js/papers.js — paper tuner
Owns `PAPERS` data and `PAPER_TILE_GLSL` (`vec4 paperTile(vec2 uv)`, must tile seamlessly) and
`PAPER_SURFACE_GLSL` (`vec3 paperSurface(vec2 P, out float shade)`). Paper ids are fixed:
sketch, cream, coldpress, kraft, black, chalkboard, blueprint.

### js/samples.js — sample images
```js
export const SAMPLES = [{ id, name, alt }]            // 4 items, first is the default demo
export async function makeSample(id, size = 1024)     // -> HTMLCanvasElement (size x size)
```
Procedural only (no downloaded assets). Must read well as a spiral (strong midtones, clear subject).

### js/tools.js — drawing tool sprites (Canvas 2D)
```js
export const TOOL_KINDS = ['pencil','fineliner','fountain','crayon','ballpoint','marker','brush',
                           'charcoal','chalk','neon','goldpen'];
export function drawTool(ctx, kind, x, y, size, opts = {})
// Tip exactly at (x, y) in ctx pixels. `size` = tool length in px (~22% of the paper width in use).
// opts: { color: '#hex' (ink colour; tints tips / crayon / marker caps), angle: deg (default 35,
//   body toward the lower right like a right hand), lift: 0..1 (hover height: 0 = touching; shadow
//   separates and softens as it lifts), alpha: 0..1, shadow: true, sway: 0..1 (micro-wobble phase) }
export function drawToolMotion(ctx, kind, points, size, opts)  // motion blur: points = [{x,y}], alpha split
```
Handsome, recognisable at 60–400 px length, crisp at any DPR, no external images.

### js/encoder.js — video encoding
```js
export async function probeVideo({ width, height, fps }) ->
  { webcodecs: { codec, hardware } | null, recorder: { mimeType, ext } | null }
export async function encodeVideo({
  width, height, fps = 30, frames,          // total frame count
  drawFrame,                                // async (index, ctx2d, canvas) => void  — paint frame `index`
  bitrate,                                  // default by size (1080x1920 ≈ 12 Mbps)
  signal,                                   // AbortSignal
  onProgress,                               // (done, total, previewCanvas) => void
  engine = 'auto',                          // 'auto' | 'webcodecs' | 'recorder'
}) -> { blob, mimeType, ext, engine, codec, width, height, fps, frames, bytes }
```
WebCodecs H.264 (avc1.640028 → 4D0028 → 42E028 via isConfigSupported) + vendored mp4-muxer
(`fastStart: 'in-memory'`), keyframe every 2 s, backpressure on `encodeQueueSize`, `frame.close()`,
no requestAnimationFrame dependency. Fallback: MediaRecorder real time (mp4 preferred, else webm),
paused while the tab is hidden. Must throw a clear `Error` with `.code` on failure
('unsupported' | 'aborted' | 'encode'). Even dimensions only.

### js/export.js — stills, vectors, sharing
```js
export async function exportPNG(state, { size, transparent = false, onProgress, signal }) -> Blob
  // Renders with its own Renderer in horizontal strips (setPaperSize/setOrigin) for large sizes,
  // encodes PNG itself (CRC32 + zlib via CompressionStream('deflate'), pHYs 300 dpi), falls back
  // to canvas.toBlob for small sizes / when CompressionStream is missing.
export function maxExportSize() -> number     // largest safe square size on this device
export function buildSVG(geom, { mode: 'stroke'|'outline'|'plotter', ink, paper: hex|null,
                                  sizeMm = 200, layout }) -> string
  // stroke: one <path> (wave technique); outline: one filled closed path (thickness);
  // plotter: single-stroke zig-zag filling the thickness band. mm units, RDP-simplified.
export function svgStats(svg) -> { paths, nodes, bytes }
export function downloadBlob(blob, filename)
export async function shareFile(blob, filename, title) -> 'shared'|'cancelled'|'unsupported'|'failed'
export function canShareFiles(type = 'video/mp4') -> boolean
export async function copyPNG(blobPromise) -> boolean  // ClipboardItem created synchronously
export function fileName(parts: string[], ext) -> 'spiralist-…'
```

## App (lead): index.html, css/app.css, js/app.js, js/film.js (timeline + frame composer),
dialogs. Visual language: Instrument Serif + Geist; tokens --desk, --chrome, --surface, --border,
--text, --text-muted, --accent (#C43D16 light / #FF7A4D dark); light + dark themes.
