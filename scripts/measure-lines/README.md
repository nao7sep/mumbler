# measure-lines

Measures every line Mumbler paints — border sides, outlines, line-like box-shadows (no blur: a spread ring or a one-axis offset) and thin filled elements such as the splitter grip — on every seeded surface, in the light and the dark theme, and reports each line's painted contrast against what is painted beside it. It serves the line inventory in the interface-styling-conventions ("One strength per kind of line", "Each kind has a contrast target, measured where it is painted").

## Run

```sh
npm run measure:lines                      # build, then measure; output under the OS temp folder
npm run measure:lines -- --out ~/lines     # choose the output folder
```

`node scripts/measure-lines/run.mjs [--out <dir>] [--app <module.mjs>]` runs against an existing `out/` build. The output folder is printed at the end. The run takes a few minutes and shows no window. A running `npm run dev` rewrites `out/main` while it starts or rebuilds; a measurement started during that rewrite fails on the missing files, so start it once the dev build has settled (or with dev stopped).

## Output

- `<surface>.<theme>[.<page>].png` — the capture at device scale factor 2; a surface whose scroll container hides lines gets one capture per page.
- `lines.json` — one record per line: surface, theme, capture, element (class path and nearby text), kind, side, CSS width, computed colour (`computedRgba`, alpha resolved), the custom property it matches (`token.by` is `source` when the winning declaration names it, `value` when only the colour matches), the winning declaration (`source`), the painted line and the painted pixels just outside (`outer`, away from the element's box) and inside (`inner`) it, and the WCAG contrast and CIE ΔL* against each side and against the backdrop (`backdrop`: the weaker side, or the outer side when the line is the edge of its element's own fill).
- `lines.md` — the lines grouped by custom property (else by authored expression, else by colour): where each group is used, its backdrop contrast and ΔL* range per theme, and the backdrop colours it sits on; then lines per surface and what was not captured.

## How it works

- `run.mjs` (Node) seeds a disposable data folder under the OS temp folder, points the app at it through its data-directory variable (`MUMBLER_DATA_DIR`), strips every `*_API_KEY` from the environment, starts a loopback endpoint that never answers, and starts Electron on `harness.mjs`. However the run ends it stops Electron's whole process group (forced after 5 s), closes the endpoint and deletes the data folder; the run itself is bounded at 5 minutes.
- `harness.mjs` (Electron main) runs the app's built main process in-process with its real preload and renderer, a Chromium profile inside the work folder, sRGB colour and device scale factor 2. Windows never show. For each surface it reloads when asked, drives the page to the surface, then per theme sets `nativeTheme.themeSource`, captures, and measures. A calibration swatch checks that captured pixels equal CSS colours before anything is measured.
- `page-measure.js` runs in the page: it finds each line, its authored declaration and token, and the points along it that are actually visible (hit-tested; nothing painting above it), trimming rounded corners.
- `analyze.mjs` samples the capture at those points (median of five; an opaque line up to 2 device px from its layout position is found where painted) and builds `lines.md`.
- `mumbler.mjs` is everything app-specific: the build to load, window sizes, the seed (queue cards in every resting state plus one held Transcribing by the silent endpoint, two pending imports, stub ffmpeg/ffprobe answering only `-version`, a fake key, a previous launch's records), the extra records, and the surface steps. Another Electron app needs only its own module passed with `--app`.

## Limits

Hover, pressed and drag states, native menus and the dialogs listed under Notes in `lines.md` are not reached. Lines drawn by gradients, canvases (the waveform) or pseudo-elements are not detected. The stub tools and `chmod` make the seed POSIX-only.
