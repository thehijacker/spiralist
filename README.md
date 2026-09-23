<p align="center">
  <a href="https://winchxyz.github.io/spiralist/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/banner-dark.png">
      <img src="docs/banner-light.png" alt="Spiralist. Any photo. One line." width="100%">
    </picture>
  </a>
</p>

<p align="center">
  <b>Spiralist redraws any photo as one continuous line, in pen, pencil, ink or paint on paper that looks real.<br>
  Then it films the line being drawn.</b>
</p>

<p align="center">
  <a href="https://winchxyz.github.io/spiralist/"><img alt="Open the live site" src="https://img.shields.io/badge/Open_the_live_site-c2410c?style=for-the-badge"></a>
  <a href="https://github.com/winchxyz/spiralist/stargazers"><img alt="Star on GitHub" src="https://img.shields.io/github/stars/winchxyz/spiralist?style=for-the-badge&logo=github&label=Star&color=1d1b18"></a>
  <a href="https://x.com/winchxyz"><img alt="@winchxyz on X" src="https://img.shields.io/badge/@winchxyz-000000?style=for-the-badge&logo=x&logoColor=white"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-6f685c?style=for-the-badge"></a>
</p>

<p align="center">
  <a href="https://winchxyz.github.io/spiralist/">
    <img src="docs/hero.gif" width="600" alt="A film made in Spiralist: a fountain pen nib starts a spiral in close-up, the camera pulls back as the portrait fills in, and the finished sheet lies on a black marble desk.">
  </a>
  <br>
  <sub>A 10-second film straight out of the app, played 1.3× faster here. Fountain pen on cream paper, Nero marble desk.</sub>
</p>

Everything runs in your browser. Your photo is never uploaded, and after the first visit the site
works offline.

## What it does

- **Four paths for the line.** Spiral, Wander, Contour and Maze. The line never lifts off the
  paper, and Wander and Maze start wherever you tap.
- **Twelve drawing media that behave like the real thing.** Fountain ink and watercolour soak into
  the paper, bleed along its fibres and dry with darker edges. Charcoal and crayon catch the
  paper's tooth. Graphite shines at a low light, and gold flashes as the light moves.
- **Realistic mode.** Four one-line styles drawn with one pen at its real width, on a sheet of a
  real size. You could draw the result by hand, and the app tells you how long it would take.
- **A loupe.** Zoom in until you see the paper's fibres, with a scale bar in millimetres.
- **Cinematic films.** A macro of the nib touching the paper, a slow pull back, and the finished
  sheet on one of eight desks. Sign it with your name, then share it or post it on X.
- **Exports.** PNG up to 8K, SVG in real millimetres for pen plotters, or straight to the clipboard.

## The app

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/app-desktop-dark.png">
    <img src="docs/app-desktop-light.png" alt="Spiralist on a desktop: a spiral portrait of a plaster bust in the middle, and the Looks panel on the right with a thumbnail of the photo in every look." width="100%">
  </picture>
</p>

<table>
  <tr>
    <td width="36%" valign="top">
      <img src="docs/app-mobile.png" alt="Spiralist on a phone in Realistic mode: a squiggle spiral portrait with a 5 cm scale bar, the caption '21 × 21 cm · 0.4 mm fineliner · ~58 min by hand', and the four style cards below." width="100%">
      <br><sub>On a phone, in Realistic mode.</sub>
    </td>
    <td width="64%" valign="top">
      <img src="docs/loupe.jpg" alt="The loupe at 9×: fountain pen ink on textured cream paper, darker where it pooled, with a 2 mm scale bar." width="100%">
      <br><sub>The loupe at 9×. Fountain ink sitting in the paper's tooth; the bar is 2 mm.</sub>
    </td>
  </tr>
</table>

## Twelve media

Each tool has its own inks and its own way of meeting the paper. The same photo and the same spiral
look completely different in each one.

<p align="center">
  <img src="docs/media.jpg" alt="A grid of twelve spiral portraits of the same bust: fineliner, pencil, fountain pen, ballpoint, wax crayon, marker, sumi brush, watercolour, charcoal, chalk, neon and gold, each on its own paper." width="100%">
</p>

- **Wet media** (fountain pen, watercolour, sumi brush, marker) run on a small fluid simulation on
  the paper: water and pigment spread, wick along the fibres, pool where the pen slows down and dry
  with darker rims. Very wet paper buckles a little.
- **Dry media** (pencil, charcoal, crayon, chalk) are shaped by the paper's surface: they only
  touch the high points of the grain, so the valleys stay pale.
- **Papers**: sketchbook, cream, cold-press watercolour, kraft, black card, chalkboard and
  blueprint. The grain in the preview matches the grain in a 4K print.

## Realistic mode

The Artistic mode makes the line thicker where the photo is dark. Realistic mode doesn't: it gives
you **one pen at its real width** and a **sheet of a real size**, and the only way to make a dark
area is to draw more line there. That is exactly what a person with a pen would have to do.

<p align="center">
  <img src="docs/realistic.gif" width="600" alt="A stipple tour being drawn with a 0.4 mm fineliner: the pen travels region by region around the face in its real order while a counter in the corner reads the hours of drawing, ending on '2 h 36 min of drawing in 10 s'.">
  <br>
  <sub>The pen follows the real line in its real order, and the counter shows the time a hand would need.<br>A flat film on Nero marble; the GIF skips its first three seconds, where the pen lands at real speed.</sub>
</p>

<p align="center">
  <img src="docs/realistic.jpg" alt="The four Realistic styles with a 0.4 mm fineliner on a 21 cm sheet: A Squiggle spiral (58 min by hand), B Stipple tour (2 h 36 min), C Scribble (25 min) and D Flow engraving (23 min)." width="100%">
</p>

- **Four styles**: A Squiggle spiral, B Stipple tour, C Scribble and D Flow engraving.
- **Real tool sizes**: fineliners from 0.3 to 0.8 mm, ballpoint, fountain pen, pencil, gold paint
  pen, marker, sumi and watercolour brushes, a 4 mm charcoal stick, wax crayon and 5 mm chalk.
- **Sheets that fit the tool.** A 4 mm charcoal stick can't draw a face on A4, so the app picks a
  sheet big enough, up to 2 m across. You can also pick one yourself.
- **Honest numbers**: metres of line and hours by hand for every drawing, plus Window, Raking and
  Overhead light.
- **Never cut short.** A fine pen on a big sheet can need more line than one drawing holds
  (1.4 million points). The line is then drawn with fewer points where it runs straight. If that
  is still not enough, the drawing gets less detail (fewer rings, dots or bands, bigger loops, or
  a Masterpiece drawn as Detailed), and the app tells you. How much line a sheet needs depends on
  the photo: a very dark one can lower detail even on a sheet the tool is offered, and the sheet
  list marks those sizes ("less detail with this photo"). The whole photo is always drawn.
- **The SVG is a real plotter file**: one path, the sheet's real size in millimetres, and the
  stroke as wide as the pen.

## Films

<p align="center">
  <img src="docs/desks.jpg" alt="Eight final frames from cinematic films, one per desk: Nero marble, Calacatta, Travertine, Limewash, Emerald velvet, Leather blotter, Sunlit concrete and Honey onyx, each with a different tool resting below the sheet." width="100%">
</p>

- **Cinematic or flat.** Cinematic films open on a macro of the nib, pull back with depth of field and
  a moving light, and end on the whole sheet on a desk.
- **Eight desks**: Nero marble, Calacatta, Travertine, Limewash, Emerald velvet, Leather blotter,
  Sunlit concrete and Honey onyx.
- **Sign it**: type your name or @handle and the pen signs the corner at the end, in the same ink.
- **Realistic films** show the true drawing, sped up: the pen moves at a believable hand speed
  with a clock in the corner, and nothing is faded in or revealed.
- 9:16, 4:5, 1:1 or 16:9, 10 to 60 seconds, 30 or 60 fps, saved as an H.264 MP4. On a phone you can
  share it straight to your apps. **Post on X** shares the video on phones, and on desktop it opens a
  post and saves the video for you to attach.

Full-quality MP4s of the films above are on the [Releases page](https://github.com/winchxyz/spiralist/releases).

## How it works

1. **Photo to tone.** The photo is turned into a map of light and dark, with automatic levels
   so the face reads well. You can crop, rotate and adjust it.
2. **Tone to one line.** A path generator walks that map and lays down a single line. The
   spiral widens in the dark areas. The Realistic styles keep the width fixed and pack the line
   tighter instead: denser zigzags, a closer tour, more loops or more engraved lines.
3. **Line to marks on paper.** The line is drawn with WebGL 2 as a physical mark: the paper has a
   height map and fibres, each medium has its own rules for how it meets them, and wet media run a
   small simulation of water and pigment on a grid over the sheet.
4. **Marks to film.** A film is rendered frame by frame, not recorded from the screen. A virtual
   camera and light move over the desk, and the frames are encoded to MP4 in the browser.

In Realistic mode, each style also works out how fast a hand would move along its line (slower in
tight curves and dense patches). That clock drives the playback, the film's counter and the
"by hand" estimate.

## Run locally

It's a static site with no build step and no dependencies to install:

```bash
git clone https://github.com/winchxyz/spiralist.git
cd spiralist
node dev-server.js 8830
```

Then open <http://localhost:8830>. You need a browser with WebGL 2 (current Chrome, Edge, Safari
or Firefox). Films use WebCodecs where the browser has it and fall back to MediaRecorder.

### Keyboard

| Key | Does |
|---|---|
| `M` | switch between Artistic and Realistic |
| `1`–`9` | pick a look (Artistic) |
| `1`–`4` | pick style A–D (Realistic) |
| `[` `]` | fewer or more rings (Artistic), less or more detail (Realistic) |

## Tech

- Vanilla JavaScript ES modules. No framework, no bundler, no build step.
- WebGL 2 for the drawing, the paper and the wet-media simulation; a Web Worker builds the
  Realistic lines.
- WebCodecs and a vendored MP4 muxer for the films.
- Runs entirely in the browser, and a service worker keeps it working offline. The photo never
  leaves your device.

### Code map

| Path | What |
|---|---|
| `js/tone.js` | photo → tone map (levels, detail, auto midtones) |
| `js/spiral.js`, `js/freeline.js`, `js/maze.js` | tone → one line: spiral, wander and contour, maze |
| `js/real/` | Realistic mode: the four styles (`squiggle`, `stipple`, `scribble`, `engrave`), sheet sizes and hand time (`index.js`), and the worker that builds them (`builder.js`, `worker.js`) |
| `js/renderer.js`, `js/shaders.js`, `js/brushes.js`, `js/papers.js` | the WebGL 2 renderer, the media and the papers |
| `js/wetsim.js` | the wet media simulation (water, pigment, fibres, buckling) |
| `js/loupe.js` | the zoom loupe |
| `js/film.js`, `js/scene.js`, `js/desks.js`, `js/signature.js`, `js/encoder.js` | film timeline, camera and desks, signature, video encoding |
| `js/export.js`, `js/download.js`, `js/share.js` | PNG and SVG export, sharing to X |
| `js/materials.js` | looks and the Realistic tools at their real sizes |
| `js/app.js` | the app itself |
| `js/tools.js`, `js/samples.js` | pen sprites and the built-in sample photos |
| `dev/`, `tests/` | visual labs and tests |

### Tests

```bash
node tests/geometry.test.mjs
node tests/brush.test.mjs
node tests/papers.test.mjs
node tests/scene.test.mjs
node tests/export.test.mjs
node tests/real.test.mjs
```

The browser tests (`tests/intake.e2e.mjs`, `tests/film.e2e.mjs`, `tests/film.dialog.e2e.mjs`,
`tests/real.e2e.mjs`, `tests/loupe.e2e.mjs`, `tests/app-shot.mjs`) drive the running dev server
with Playwright. The visual labs live in `dev/`.

## Credits

Made by [@winchxyz](https://x.com/winchxyz) with [Claude Code](https://claude.com/claude-code).

## License

MIT, see [LICENSE](LICENSE). `vendor/mp4-muxer.mjs` is © Vanilagy (MIT).
