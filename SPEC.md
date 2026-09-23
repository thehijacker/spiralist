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

Unit tests: `node tests/geometry.test.mjs` (engine), `tests/brush.test.mjs`, `tests/papers.test.mjs`,
`tests/scene.test.mjs`, `tests/export.test.mjs`. Browser tests: `tests/encoder.test.mjs`,
`tests/intake.e2e.mjs`, `tests/film.e2e.mjs`, `tests/film.dialog.e2e.mjs`, `tests/app-shot.mjs`.
Labs: `dev/lab.html` (physics sheets; `consistency` also compares fine texture, `wetset`),
`dev/export.html` (`t=strips|seams|transp`), `dev/dry.html` (dry media), `dev/wetbench.html`
(wet media timing and compile cost), `dev/signature.html`, `dev/deskbake.html`, `dev/desks.html`.

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
- `js/renderer.js` — `new Renderer(canvas, {onLost, onRestored, warmup, block, keepCanvas})`:
  `setSize(w,h)` (target px) · `setPaperSize(W,H)` + `setOrigin(x,y)` (strip rendering of a bigger
  sheet) · `setLayout({cx,cy,r})` · `setPaper(paperDef, seed)` · `setStyle({brush, ink, cover, photoColor})`
  · `setGeometry(geom, {pacing})` · `setPacing('natural'|'steady'|'rings')` · `setTransparent(bool)`
  (straight-alpha ink only) · `setLight({azimuth, elevation, intensity, warmth, view, eye})` ·
  `setTime(seconds|null)` · `render(upTo=Infinity, {settle})` (incremental; scrubbing back redraws) ·
  `renderToTexture(upTo, {settle, rect, size}) -> {tex, w, h, rect}` (the same image into a mipmapped
  texture of this context, for the film camera; `rect` = a sub-region at higher density, see below) ·
  `releaseRect()` · `renderBlank()` · `pending(brush?, paper?, start = true)` · `freeSim()` ·
  `setSimClock({at, v, mix} | null)` ·
  `destroy()` · `maxSize` · `canvas`.
  Output canvas has `preserveDrawingBuffer: true`, so `drawImage(renderer.canvas, …)` and `toBlob` work any time.
- `js/shaders.js` — assembles programs from `js/brushes.js` (BRUSH_GLSL) and `js/papers.js`
  (PAPER_TILE_GLSL, PAPER_SURFACE_GLSL, PAPER_PHYS_GLSL). `js/wetsim.js` — the wet-media simulation.

### Renderer: the physics core
- **Passes.** Stroke pass: one instanced capsule per segment, MAX-blended into two targets (MRT):
  pigment (RGBA8) and surface (RGBA16F: groove, raised, sheen, pen time). Wet media only: the same
  stroke program draws the liquid each segment lays down into an injection map on the wet grid, and
  `wetsim.js` steps it. Glow (neon): quarter-res separable blur. Composite: lit paper + medium relief +
  pigment + simulated wet layer + specular per material → canvas or texture.
- **Exactness.** Every pass takes the paper position from `gl_FragCoord` (exact pixel centres, whole
  origins) and every neighbourhood read is a hand-made bilinear of exact texel fetches, so a strip of an
  export and a full pass are identical to the bit (`/dev/export.html?t=strips` requires max diff 0).
  Brushes must keep every output inside their quad: the stroke pass cuts anything past
  `hw * spread + 1 px` (the quad's rasterised edge snaps differently per target size).
- **Light.** Default = the window light every still was tuned under (upper left, 40°); `setLight()`
  restores it. `view` = direction toward the camera; `eye` = camera position in sheet widths
  (x, y from the top-left corner, z above the sheet) makes the view vector per pixel, so glints are
  local. `setTime` drives neon flicker. Light and time change only the composite (cheap per frame).
- **Wet media** (`brush.wetness > 0`): a sheet-space grid of `WET_GRID` = 1024 cells across the sheet
  (~0.2 mm per cell) whatever the output size, `STEPS_DRAW` = 240 steps spread over the drawing by
  pacing time, then `STEPS_SETTLE` = 60 drying steps. `render(upTo)` shows the state at that pen
  time (a pure function of progress, incremental forward); `settle` 0..1 dries it after the drawing
  (default 1 for `upTo = Infinity`, so a still is dry; the film ramps it over the hold). `setSimClock` runs the steps
  on a film's own time (half film time, half pen time), so the macro opening's fresh ink soaks in and
  bleeds on screen; it stays a pure function of progress. State is
  RGBA32F where float targets can be filtered, else RGBA16F, else RGBA8 (scaled); if even that fails
  the medium renders dry. The film should call `setPacing` with the pacing it plays.
- **Rect view** (`renderToTexture(upTo, {rect: [x0,y0,x1,y1], size})`, sheet fractions): renders that
  part of the same sheet as if the sheet were `size / (x1-x0)` px wide (grain, grit, granulation and
  the shared wet state at that density), into its own targets that stay alive between calls (redrawn
  from scratch when the rect moves, incrementally while it holds). The texture has a margin (glow,
  relief) and an origin snapped to 4 texels: map it with the RETURNED `rect`. It matches a full render
  at that density to the bit; `releaseRect()` frees it.
- **Shader programs** are specialised per medium (stroke: the brush id; composite: material, wet
  layer, and the chalkboard / blueprint extras) and made on first use. Where the browser compiles in
  parallel (`KHR_parallel_shader_compile`) nothing on the page waits for a compile:
  `pending(brush, paper)` starts whatever that style needs and answers at once; a renderer made
  with `block: false` (the app's stage, the chips, the film stage) returns `'pending'` from
  `render()` / `renderBlank()` (and null from `renderToTexture()`) and draws nothing until it is
  false, so the caller keeps its last image and tries again next frame. `block` defaults to true
  (exports, tests, labs: compile on the spot). `warmup: true` (the app's stage only) compiles the
  other media's programs in the background, one every 80 ms, after the first render. Status
  queries that wait for the GPU (`checkFramebufferStatus`, a WebGL canvas resize, `isProgram`) are
  asked once per layout or avoided: they wait for every queued compile and froze tool switches.
  `keepCanvas: true` (the chips) never shrinks the canvas; each image is its bottom-left corner.
- **GPU memory.** The wet grid (~70 MB at 1024 cells, float32) is allocated for the first wet
  draw and freed again by `freeSim()`: automatically when a dry medium is set, by the chips after
  8 s idle, and by the film stage between films (which also drops its sheet-sized targets).
- **Budget** (RTX 4070, 128k segments): still from scratch ~2 ms dry / ~35-45 ms wet at 1100 px;
  incremental film frame ~2 ms at 2048; rect frame ~1.5-2.5 ms at 1024; one wet step ~0.07 ms.
  Measured by `/dev/lab.html?sheet=timing`.
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
Owns `BRUSHES` data (inks as `[hex, name]`, `spread` (<= 3), `lightInk`, `glow: {amount, tight, wide}`,
`forceCover`, `prefersDark`, `material` ('ink' | 'graphite' | 'wax' | 'chalk' | 'metal' | 'light' |
'oil'), `wetness`, `wet: {mobile, dye, gran, dry, flow, pool, poolAt, layer, sharp, wick, retard,
stick, tide, sheen}`) and
`BRUSH_GLSL` (`brushDeposit(int brush, Stroke st, inout vec3 ink, out Surface sf)`; the Stroke and
Surface fields are documented above BRUSH_GLSL). Shader ids 0..11 are fixed (renderer passes
`brush.shader`; 11 = watercolour). `brushWet(brush)` returns the wet parameters with defaults.
The dry media's GLSL (pencil, charcoal, crayon, chalk, ballpoint, neon, gold) lives in `dryGLSL()`
at the end of the file; `brushDeposit` calls it. Wet media state (js/wetsim.js): A (water,
suspended, deposited, fibre moisture), B (wet extent, edge pull, film age, D = colour in the
fibres' water), C (colourant caught in the fibres: bleeds and stains, drawn without the surface
water's hard edge), inj (latest pass: water, pigment, coverage, pen time) and inj2 (earliest pass,
so a later pass over earlier ink adds to it: `wet.layer`). Pooling needs dwell above
`1 + wet.poolAt`, scaled by a random hesitation per turn. Checked by `tests/brush.test.mjs`.

### js/papers.js — paper tuner
Owns `PAPERS` data and `PAPER_TILE_GLSL` (`vec4 paperTile(vec2 uv)`, must tile seamlessly) and
`PAPER_SURFACE_GLSL` (`vec3 paperSurface(vec2 P, out float shade)`). Paper ids are fixed:
sketch, cream, coldpress, kraft, black, chalkboard, blueprint. Physical properties for wet media
(`absorb`, `sizing`, `fibre`, `capacity`, `grainDeg`; `paperPhysics(paper)` fills defaults) and
`PAPER_PHYS_GLSL` (`vec4 paperPhys(vec2 P)`: height, conductance, fibre orientation on the wet grid).

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

### js/share.js — X and credits
`shareToX(getBlob, {filename, kind, download, canShare, mime}) -> 'shared' | 'cancelled' | 'intent' |
'blocked' | 'saved'` never navigates the page (the user's film would be lost): phones hand the file
to the share sheet; desktops open X's composer inside the click and save the file to attach;
'blocked' / 'saved' mean no tab could open, so the caller offers `openXIntent(kind)` from a fresh tap.

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
  keyFrames,                                // frame indices forced to keyframes (the recorder ignores it)
}) -> { blob, mimeType, ext, engine, codec, width, height, fps, frames, bytes, restarts, dropped, … }
```
`onProgress(0, total, null)` marks a restart (hardware -> software, or -> MediaRecorder);
`result.restarts` counts them. B-frame streams are written with an edit list (as ffmpeg / x264),
access-unit delimiters are stripped, and the track timescale is fps x 2^n >= 10000, so every frame
seeks exactly in Chromium, Firefox and ffmpeg. `avcLevel(w, h, fps, bitrate)`: 1080x1920 @ 60 = 4.2.
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

### js/film.js, js/scene.js, js/desks.js, js/signature.js — the film
```js
drawSeconds(length, reveal = false, style = 'cinematic', sign = 0)   // the drawing's share of a film
signSeconds(text)                                  // 1.0-1.4 s of writing, 0 when unsigned
new FilmComposer({ W, H, format, length, fps, style, showTool, polaroid, reveal, pacing, state,
  drawPhoto, tools, sceneLib, desk, renderer /* shared, not destroyed */, live, signature, macro })
  .prepare() · .ready() /* nothing would wait for a compile */ · .draw(i, ctx) · .encodeHints() · .destroy()
warmFilm(desk)                                     // start the film's context, scene compile and desk bake early
```
The dialog's preview and its encodes share one renderer (`block: false`: an encode waits for its
programs before the first frame). A cinematic film opens on a 5.5x macro of the nib
(`renderToTexture` with a rect; `scene.MACRO`), passes the camera's eye with the light, and ends on
a full-sheet shot over the chosen desk. `scene.js`: `cameraBasis`, `project`, `unproject`,
`planPace`, `planCamera({…, sign})`, `shotIntent({…, macro})`, `FilmScene(gl, {dark, seed, glow,
desk, wait}).render({sheet, basis, focus, wipe, light, time, sun, macro})`, `loadDesk`, `warmDesks`,
`sceneReady`, `deskStatus`, `deskBakeSize`. `desks.js`: `DESKS` (nero, calacatta, travertine,
limewash, velvet, leather, sunlit, onyx), `DeskBake`, `bakeDesk`. `signature.js`: `cleanSignature`,
`traceSignature`, `timeSignature`, `placeSignature` (the pen signs the corner in the same medium,
appended to the geometry with zero-width lifts, so FRAG_STROKE must deposit nothing where the true
width is 0).

## App (lead): index.html, css/app.css, js/app.js, js/film.js (timeline + frame composer),
dialogs. The stage renderer never blocks on a compile (a spinner shows if one takes a moment);
`setPacing(prefs.pacing)` follows the transport; wet ink dries on screen over 1.6 s when playback
ends; the transport previews the film's exact drawing time (style and signature included). Visual language: Instrument Serif + Geist; tokens --desk, --chrome, --surface, --border,
--text, --text-muted, --accent (#C43D16 light / #FF7A4D dark); light + dark themes.
