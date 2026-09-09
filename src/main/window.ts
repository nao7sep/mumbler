import { BrowserWindow, Menu, nativeTheme, screen } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from "@shared/layout";
import { configureWindowMinimum } from "./window-minimum";
import { isAllowedExternalUrl, openExternalUrl } from "./external-url";
import type { ApplicationRuntime } from "./core/app-runtime";
import { serializeError } from "./core/logger";
import {
  initializeWindowPlacement,
  configureWindowPlacement,
  resolveWindowRestoration,
} from "./window-placement";

export { isAllowedExternalUrl } from "./external-url";

// Matches the renderer `--bg` (#edf4ec in styles.css) so the pre-paint window
// background does not flash a different color before the page loads.
const WINDOW_BACKGROUND = "#edf4ec";
const __dirname = dirname(fileURLToPath(import.meta.url));
let currentPlacementFlush: (() => Promise<void>) | null = null;

export async function flushMainWindowPlacement(): Promise<void> {
  await currentPlacementFlush?.();
}

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
// derived minimums and the (deliberate, non-persisted) default size are verified
// in a unit test without driving a real window — the same pattern the CSP helper
// above follows. The minimums are imported from the shared layout module, never
// typed inline, so they can never disagree with the pane minimums.
export function buildWindowOptions(): Electron.BrowserWindowConstructorOptions {
  return {
    width: 1480,
    height: 940,
    // Derived — do not hand-edit. Sourced from @shared/layout, which sums the
    // pane minimums plus the fixed chrome.
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false,
    backgroundColor: WINDOW_BACKGROUND,
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
  // Force the light theme so the host OS paints a light native title bar on this
  // light app — a dark-mode host would otherwise give it a dark bar that fights
  // the UI (window-chrome conventions: chrome colors match the app's theme).
  nativeTheme.themeSource = "light";

  const options = buildWindowOptions();
  const window = new BrowserWindow(options);
  const reportPlacementError = (message: string, error?: unknown): void => {
    void runtime.currentLogger().warn("window.placement", message, error === undefined ? undefined : {
      error: serializeError(error),
    });
  };
  let workAreas: Electron.Rectangle[] = [];
  try {
    workAreas = screen.getAllDisplays().map((display) => display.workArea);
  } catch (error) {
    reportPlacementError("Display work areas unavailable; using opening window bounds.", error);
  }
  const savedPlacement = runtime.getWindowPlacement();
  const restoration = resolveWindowRestoration(
    savedPlacement,
    { width: options.minWidth ?? 0, height: options.minHeight ?? 0 },
    workAreas,
  );
  configureWindowMinimum(window, () => ({ width: WINDOW_MIN_WIDTH, height: WINDOW_MIN_HEIGHT }),
    (error) => reportPlacementError("Window minimum could not be updated.", error));
  const initialized = initializeWindowPlacement(window, savedPlacement, restoration,
    (error) => reportPlacementError("Window placement restoration failed; retaining useful opening geometry and mode.", error));
  const placement = configureWindowPlacement(
    window,
    initialized.initial,
    (record) => runtime.saveWindowPlacement(record),
    (error) => reportPlacementError("Window placement operation failed.", error),
    initialized.windows,
  );
  const flushThisPlacement = () => placement.flush();
  currentPlacementFlush = flushThisPlacement;

  let closeAllowed = false;
  let closePending = false;
  let systemSessionEnding = false;
  window.on("session-end", () => {
    systemSessionEnding = true;
    void placement.flush();
  });
  window.on("close", (event) => {
    if (closeAllowed || systemSessionEnding) return;
    event.preventDefault();
    if (closePending) return;
    closePending = true;
    void placement.flush().finally(() => {
      closeAllowed = true;
      if (!window.isDestroyed()) window.close();
    });
  });
  window.once("closed", () => {
    placement.dispose();
    if (currentPlacementFlush === flushThisPlacement) currentPlacementFlush = null;
  });

  window.once("ready-to-show", () => {
    window.show();
    // Windows requires a native event-loop turn between show and maximize.
    setTimeout(() => {
      if (window.isDestroyed()) return;
      placement.start();
      if (restoration.mode === "maximized") {
        try { window.maximize(); }
        catch (error) { reportPlacementError("Window could not be maximized during restoration.", error); }
      }
    }, 0);
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

    const template: Electron.MenuItemConstructorOptions[] = [];

    if (params.misspelledWord) {
      if (params.dictionarySuggestions.length > 0) {
        for (const word of params.dictionarySuggestions) {
          template.push({ label: word, click: () => window.webContents.replaceMisspelling(word) });
        }
      } else {
        template.push({ label: "No suggestions", enabled: false });
      }
      template.push({ type: "separator" });
    }

    if (params.isEditable) {
      template.push(
        { role: "undo",      enabled: params.editFlags.canUndo },
        { role: "redo",      enabled: params.editFlags.canRedo },
        { type: "separator" },
        { role: "cut",       enabled: params.editFlags.canCut },
      );
    }

    template.push({ role: "copy", enabled: params.editFlags.canCopy });

    if (params.isEditable) {
      template.push(
        { role: "paste",     enabled: params.editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll",          enabled: params.editFlags.canSelectAll },
      );
    }

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
