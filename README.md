# Spiralist

Turn any photo into a drawing made of one continuous line. Then film the line being drawn.

**Live:** https://winchxyz.github.io/spiralist/

Everything runs in your browser. The photo is never uploaded anywhere, and after the first visit
the site works offline.

## What it does

- **Four ways to draw the line**
  - **Spiral**: one line spirals out from the centre and gets thicker where the photo is dark.
  - **Wander**: one line meanders all over the image, packing tighter in the shadows. It starts
    wherever you tap and never crosses itself.
  - **Contour**: a continuous-line drawing that traces the outlines of the subject and glides
    from shape to shape without lifting the pen.
  - **Maze**: one line winds through a labyrinth grown from the point you pick.
- **Tools that behave like the real thing**: pencil, pen, fountain ink, crayon, ballpoint, marker,
  sumi brush, watercolour, charcoal, chalk, neon, gold. Each one has its own ink colours.
  - Wet media are simulated on the paper: fountain ink and watercolour soak in, bleed along the
    fibres, pool where the pen pauses and dry with darker rims; the sumi brush runs dry into
    streaks; marker dye layers where passes cross.
  - Dry media catch the paper's tooth: graphite shines silver at a low light, charcoal is velvety
    and gritty, wax crayon skips over the valleys and catches the light, chalk leaves dust.
  - Ballpoint leaves a pressed groove and the odd blob; gold is real metal that flashes as the
    light moves; neon glows.
- **Paper**: sketchbook, cream, cold-press watercolour, kraft, black card, chalkboard, blueprint.
  The grain matches between the preview and a 4K print.
- **Looks**: ready-made combinations, previewed on your own photo.
- **Framing and tone**: drag, zoom and rotate the photo inside the frame. Auto tone, darkness,
  contrast and detail controls. Hold *Compare* to see the original.
- **Playback**: watch or scrub the drawing with the pen riding the line, from 0.1× to 4×.
- **Film a timelapse**
  - Cinematic or flat. Cinematic films open on a macro of the nib touching the paper, pull back
    with depth of field and moving light (wet ink glistens, graphite and gold glint), and end on
    the whole sheet on a desk.
  - Eight backgrounds: Nero marble (default), Calacatta, Travertine, Limewash, Emerald velvet,
    Leather blotter, Sunlit concrete, Honey onyx.
  - *Sign it*: type your name or @handle and the pen signs the corner at the end, in the same ink.
  - 9:16, 4:5, 1:1 or 16:9; 10–60 seconds; 30 or 60 fps.
  - Rendered frame by frame to H.264 MP4. On phones you can share it straight to your apps;
    *Post on X* shares the video (phones) or opens a post and saves the video to attach (desktop).
- **Save**
  - PNG up to 8K, on paper or transparent.
  - SVG in millimetres: single stroke for pen plotters, filled outline, or plotter fill.
  - Copy to clipboard.

## Run locally

It's a static site with no build step:

```bash
node dev-server.js 8830
```

Then open <http://localhost:8830>. You need a browser with WebGL 2 (current Chrome, Edge, Safari
or Firefox). Film uses WebCodecs where available and falls back to MediaRecorder.

## Code map

| Path | What |
|---|---|
| `js/tone.js` | photo → tone field (levels, detail, auto midtones) |
| `js/spiral.js`, `js/freeline.js`, `js/maze.js` | tone field → one continuous line (spiral / wander + contour / maze) |
| `js/renderer.js`, `js/shaders.js`, `js/brushes.js`, `js/papers.js` | WebGL2 renderer, tools and papers |
| `js/wetsim.js` | wet media simulation (water, pigment, fibres) |
| `js/film.js`, `js/scene.js`, `js/desks.js`, `js/signature.js`, `js/encoder.js` | timelapse timeline, cinematic camera and desks, signature, video encoding |
| `js/export.js`, `js/download.js`, `js/share.js` | PNG / SVG export, sharing to X |
| `js/app.js` | the app itself |
| `js/tools.js`, `js/samples.js` | pen sprites, built-in sample images |
| `dev/`, `tests/` | visual labs and headless tests |

## Tests

```bash
node tests/geometry.test.mjs
node tests/brush.test.mjs
node tests/scene.test.mjs
node tests/export.test.mjs
```

The browser tests (`tests/encoder.test.mjs`, `tests/film.e2e.mjs`, `tests/film.dialog.e2e.mjs`,
`tests/intake.e2e.mjs`, `tests/app-shot.mjs`) drive the running dev server with Playwright. The
visual labs live in `dev/` (`dev/lab.html`, `dev/export.html`, `dev/dry.html`).

## License

MIT. `vendor/mp4-muxer.mjs` is © Vanilagy (MIT).
