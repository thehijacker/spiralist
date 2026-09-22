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
- **Tools**: pencil, pen, fountain ink, crayon, ballpoint, marker, brush, charcoal, chalk, neon,
  gold. Each one has its own ink colours.
- **Paper**: sketchbook, cream, cold-press watercolour, kraft, black card, chalkboard, blueprint.
  The grain matches between the preview and a 4K print.
- **Looks**: ready-made combinations, previewed on your own photo.
- **Framing and tone**: drag, zoom and rotate the photo inside the frame. Auto tone, darkness,
  contrast and detail controls. Hold *Compare* to see the original.
- **Playback**: watch or scrub the drawing with the pen riding the line, from 0.1× to 4×.
- **Film a timelapse**
  - Cinematic (close-up, pull-back, depth of field, desk, light) or flat.
  - 9:16, 4:5, 1:1 or 16:9; 10–60 seconds; 30 or 60 fps.
  - Rendered frame by frame to H.264 MP4. On phones you can share it straight to your apps.
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
| `js/film.js`, `js/scene.js`, `js/encoder.js` | timelapse timeline, cinematic camera, video encoding |
| `js/export.js`, `js/download.js` | PNG / SVG export, sharing |
| `js/app.js` | the app itself |
| `js/tools.js`, `js/samples.js` | pen sprites, built-in sample images |
| `dev/`, `tests/` | visual labs and headless tests |

## Tests

```bash
node tests/geometry.test.mjs
```

The browser tests (`tests/film.e2e.mjs`, `tests/intake.e2e.mjs`, `tests/app-shot.mjs`) drive the
running dev server with Playwright.

## License

MIT. `vendor/mp4-muxer.mjs` is © Vanilagy (MIT).
