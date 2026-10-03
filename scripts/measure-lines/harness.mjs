// Electron main-process entry for measure-lines. It starts the app's own built
// main process in this process, keeps every window hidden, then walks the app
// module's surfaces: for each one and each theme it captures the page at
// device scale factor 2, measures every painted line in the DOM, and samples
// the line and its backdrop from the captured pixels.
//
// Started only by run.mjs, which passes MEASURE_LINES_APP (the app module),
// MEASURE_LINES_WORK (the disposable work folder) and MEASURE_LINES_OUT.

import { app, BrowserWindow, nativeTheme } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildMarkdown, sampleLine } from "./analyze.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const target = await import(pathToFileURL(process.env.MEASURE_LINES_APP).href);
const workDir = process.env.MEASURE_LINES_WORK;
const outDir = process.env.MEASURE_LINES_OUT;
const dataDir = process.env[target.dataDirEnv];

const DPR = 2;
const THEMES = ["light", "dark"];
const MAX_PAGES = 6;
const STEP_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 240_000;

app.commandLine.appendSwitch("force-device-scale-factor", String(DPR));
// Capture in sRGB, so painted pixels compare with CSS colours and each other.
app.commandLine.appendSwitch("force-color-profile", "srgb");
// Chromium profile, window-state persistence and caches go to the work folder,
// never the developer's own Electron profile.
app.setPath("userData", join(workDir, "user-data"));

// Nothing reaches the screen: every window stays hidden while it renders and
// is captured (Chromium still paints hidden windows; capturePage reads them).
for (const method of ["show", "showInactive", "focus", "moveTop"]) {
  BrowserWindow.prototype[method] = function hidden() {};
}
app.on("browser-window-created", (_event, window) => {
  window.webContents.setBackgroundThrottling(false);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check, what, timeout = STEP_TIMEOUT_MS) {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(100);
  }
}

function findWindow(name) {
  const page = target.windows[name].page;
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().endsWith(`/${page}`));
}

const measureSource = await readFile(join(here, "page-measure.js"), "utf8");

// A small driver over one window's page. Every step runs in the page and
// fails loudly, with what it was looking for, when the page does not match.
function pageDriver(window) {
  const wc = window.webContents;
  const run = (fn, ...args) => wc.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`, true);
  const find = (selector, text) => {
    const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    return [...document.querySelectorAll(selector)].find(
      (el) => visible(el) && (text === null || (el.innerText ?? "").replace(/\s+/g, " ").includes(text)),
    ) ?? null;
  };
  const finder = `const find = ${find};`;
  const driver = {
    window,
    eval: run,
    inject: (source) => wc.executeJavaScript(source, true),
    async settle() {
      await run(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await sleep(350);
    },
    async waitFor(selector, text = null) {
      await waitUntil(
        () => wc.executeJavaScript(`(() => { ${finder} return find(${JSON.stringify(selector)}, ${JSON.stringify(text)}) !== null; })()`),
        `${selector}${text ? ` containing "${text}"` : ""} in ${wc.getURL()}`,
      );
    },
    async waitForGone(selector) {
      await waitUntil(() => run((s) => document.querySelector(s) === null, selector), `${selector} to close`);
    },
    async click(selector, text = null) {
      await driver.waitFor(selector, text);
      await wc.executeJavaScript(`(() => { ${finder} find(${JSON.stringify(selector)}, ${JSON.stringify(text)}).click(); })()`);
      await driver.settle();
    },
    // Sets a React-controlled field the way typing would.
    async setValue(selector, value) {
      await driver.waitFor(selector);
      await run((s, v) => {
        const el = document.querySelector(s);
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, selector, value);
      await driver.settle();
    },
    async reload() {
      const loaded = new Promise((resolve) => wc.once("did-finish-load", resolve));
      wc.reload();
      await loaded;
      await driver.settle();
    },
  };
  return driver;
}

async function openWindow(name) {
  await waitUntil(() => findWindow(name) !== undefined, `the ${name} window`, 60_000);
  const window = findWindow(name);
  if (window.webContents.isLoading()) await new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
  const { width, height } = target.windows[name];
  window.setContentSize(width, height);
  drivers[name] = pageDriver(window);
  await drivers[name].settle();
  const viewport = await drivers[name].eval(() => [innerWidth, innerHeight]);
  if (viewport[0] !== width || viewport[1] !== height) {
    throw new Error(`The ${name} window is ${viewport.join("x")}, not ${width}x${height}; the display may be too small.`);
  }
  return drivers[name];
}

const drivers = {};

async function capture(driver) {
  const image = await driver.window.webContents.capturePage(undefined, { stayHidden: true });
  const { width, height } = image.getSize();
  return { image, bitmap: image.toBitmap(), width, height };
}

// Waits until two captures in a row match, so colour transitions started by a
// theme change have finished; content that keeps animating gives up after a
// bound and is captured as it is.
async function settleCaptures(driver) {
  let previous = (await capture(driver)).bitmap;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(150);
    const next = (await capture(driver)).bitmap;
    if (next.equals(previous)) return;
    previous = next;
  }
}

async function measureSurface(surface, records, pngs) {
  const driver = drivers[surface.window];
  for (const theme of THEMES) {
    nativeTheme.themeSource = theme;
    await driver.settle();
    await settleCaptures(driver);
    await driver.inject(measureSource);
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const shot = await capture(driver);
      const result = await driver.eval((reset) => window.__measureLines({ reset }), page === 1);
      if (result.dpr !== DPR) throw new Error(`Expected device pixel ratio ${DPR}, got ${result.dpr}.`);
      if (shot.width !== result.viewport.width * DPR) {
        throw new Error(`Capture is ${shot.width}px wide; expected ${result.viewport.width * DPR}.`);
      }
      const png = `${surface.name}.${theme}${page > 1 ? `.${page}` : ""}.png`;
      await writeFile(join(outDir, png), shot.image.toPNG());
      pngs.push(png);
      for (const line of result.lines) {
        const { geometry, ...rest } = line;
        records.push({ surface: surface.name, theme, png, ...rest, ...sampleLine(shot, line, DPR), points: geometry.points.length });
      }
      const next = result.scrollables[0];
      if (!next || !(await driver.eval((index) => window.__scrollStep(index), next.index))) break;
      await driver.settle();
    }
    await driver.eval(() => window.__resetScroll());
  }
}

// A known colour painted into the page must read back from the capture
// unchanged; otherwise pixels are not what the CSS says (a colour profile or
// channel-order problem) and nothing measured would be meaningful. The swatch
// exists only for this one capture.
async function checkCalibration(driver) {
  const swatch = [18, 107, 201];
  await driver.eval((rgb) => {
    const el = document.createElement("div");
    el.id = "measure-lines-calibration";
    el.style.cssText = `position:fixed;left:0;top:0;width:12px;height:12px;z-index:2147483647;background:rgb(${rgb})`;
    document.documentElement.appendChild(el);
  }, swatch);
  await driver.settle();
  const shot = await capture(driver);
  await driver.eval(() => document.getElementById("measure-lines-calibration").remove());
  await driver.settle();
  const i = (10 * shot.width + 10) * 4;
  const got = [shot.bitmap[i + 2], shot.bitmap[i + 1], shot.bitmap[i]];
  if (got.some((v, c) => Math.abs(v - swatch[c]) > 1)) {
    throw new Error(`Calibration failed: rgb(${swatch}) was captured as rgb(${got}).`);
  }
}

async function main() {
  await import(pathToFileURL(target.mainEntry).href);
  await app.whenReady();
  const mainWindow = await openWindow("main");
  await checkCalibration(mainWindow);
  await target.afterStart?.({ dataDir, waitUntil });

  const records = [];
  const surfaces = [];
  for (const surface of target.surfaces) {
    const driver = drivers[surface.window] ?? mainWindow;
    if (surface.fresh) await driver.reload();
    await surface.open({ ...drivers, openWindow });
    await drivers[surface.window].settle();
    const pngs = [];
    await measureSurface(surface, records, pngs);
    surfaces.push({ name: surface.name, pngs });
    await surface.leave?.({ ...drivers, openWindow });
    console.log(`[measure-lines] ${surface.name}: ${records.filter((r) => r.surface === surface.name).length} lines`);
  }

  await writeFile(join(outDir, "lines.json"), `${JSON.stringify({ app: target.appName, deviceScaleFactor: DPR, surfaces, notes: target.notes ?? [], lines: records }, null, 2)}\n`);
  await writeFile(join(outDir, "lines.md"), buildMarkdown({ records, surfaces, notes: target.notes ?? [], appName: target.appName }));
  console.log(`[measure-lines] ${records.length} lines on ${surfaces.length} surfaces.`);
}

await mkdir(outDir, { recursive: true });
const runTimer = setTimeout(() => finish({ ok: false, error: `Run did not finish within ${RUN_TIMEOUT_MS} ms.` }), RUN_TIMEOUT_MS);
main().then(
  () => finish({ ok: true }),
  (error) => finish({ ok: false, error: error instanceof Error ? error.stack : String(error) }),
);

// The outcome goes to a file the launcher reads, because the app's own quit
// path decides this process's exit code. Quitting runs the app's shutdown,
// which bounds itself; the hard exit is the last bound.
let finishing = false;
async function finish(result) {
  if (finishing) return;
  finishing = true;
  clearTimeout(runTimer);
  if (!result.ok) console.error(`[measure-lines] Failed: ${result.error}`);
  await writeFile(join(workDir, "result.json"), JSON.stringify(result)).catch(() => undefined);
  setTimeout(() => app.exit(result.ok ? 0 : 1), 20_000).unref();
  app.quit();
}
