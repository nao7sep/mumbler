import { BrowserWindow, Menu, nativeTheme } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from "@shared/layout";
import { configureWindowMinimum } from "./window-minimum";
import { isAllowedExternalUrl, openExternalUrl } from "./external-url";
import type { ApplicationRuntime } from "./core/app-runtime";
import { serializeError } from "./core/logger";
import { createWindowWithUsablePersistedBounds } from "./window-state-recovery";
import { windowBackground } from "./core/theme";
import { buildContextMenuTemplate } from "./app-menu";

export { isAllowedExternalUrl } from "./external-url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Production Content-Security-Policy (defense-in-depth on top of context
// isolation + sandbox). Applied only to the packaged build, not the dev server,
// which needs inline/eval and a websocket for HMR. Audio is served from the
// custom `mumbler-asset://` scheme, so it is allowed for media and fetch; styles
// allow 'unsafe-inline' because React and WaveSurfer inject inline styles.
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' mumbler-asset: blob:",
  "connect-src 'self' mumbler-asset:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

// The response-header transform applied in the packaged build: stamp the CSP on
// without disturbing the headers already present. Exported so the exact policy is
// verified in a unit test (the runtime path can't be exercised headlessly).
export function withContentSecurityPolicy(
  responseHeaders: Record<string, string[]> | undefined,
): Record<string, string[]> {
  return {
    ...(responseHeaders ?? {}),
    "Content-Security-Policy": [PRODUCTION_CSP],
  };
}

function openExternalIfAllowed(rawUrl: string): void {
  if (isAllowedExternalUrl(rawUrl)) {
    void openExternalUrl(rawUrl).catch((error: unknown) => {
      console.error("[mumbler] Unowned external navigation failed:", error);
    });
  }
}

// The BrowserWindow construction options. Exported as a pure helper so the
// derived minimums and the default size are verified in a unit test without
// driving a real window — the same pattern the CSP helper
// above follows. The minimums are imported from the shared layout module, never
// typed inline, so they can never disagree with the pane minimums.
export function buildWindowOptions(): Electron.BrowserWindowConstructorOptions {
  return {
    name: "main",
    windowStatePersistence: {
      bounds: true,
      displayMode: process.platform === "win32",
    },
    width: 1480,
    height: 940,
    // Derived — do not hand-edit. Sourced from @shared/layout, which sums the
    // pane minimums plus the fixed chrome.
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false,
    // The resolved theme's --bg, so the pre-paint window background does not
    // flash a different color before the page loads.
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    titleBarStyle: "default",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

export async function createMainWindow(runtime: ApplicationRuntime): Promise<BrowserWindow> {
  const options = buildWindowOptions();
  const window = createWindowWithUsablePersistedBounds("main", () => new BrowserWindow(options));
  configureWindowMinimum(window, () => ({ width: WINDOW_MIN_WIDTH, height: WINDOW_MIN_HEIGHT }),
    (error) => void runtime.currentLogger().warn("window.minimum", "Window minimum could not be updated.", {
      error: serializeError(error),
    }));

  window.once("ready-to-show", () => {
    window.show();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfAllowed(url);
    return { action: "deny" };
  });

  // The renderer is a single-page app that never legitimately navigates the
  // top-level frame. Block any attempt to replace it with other content (a stray
  // link, a redirect, injected content); a same-URL reload is left alone so dev
  // full-reloads still work, and a real external link is opened in the browser.
  window.webContents.on("will-navigate", (event, url) => {
    if (url === window.webContents.getURL()) {
      return;
    }
    event.preventDefault();
    openExternalIfAllowed(url);
  });

  window.webContents.on("context-menu", (_event, params) => {
    if (!params.isEditable && !params.selectionText) return;

    const template = buildContextMenuTemplate(runtime.translator().t, params, (word) =>
      window.webContents.replaceMisspelling(word),
    );
    Menu.buildFromTemplate(template).popup();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    // Packaged build only: enforce the CSP via a response header. (Re-registering
    // on a subsequent window replaces the single handler, which is harmless.)
    window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: withContentSecurityPolicy(details.responseHeaders) });
    });
    await window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}
