import { BrowserWindow, Menu, nativeTheme, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from "@shared/layout";

// Matches the renderer `--bg` (#edf4ec in styles.css) so the pre-paint window
// background does not flash a different color before the page loads.
const WINDOW_BACKGROUND = "#edf4ec";
const __dirname = dirname(fileURLToPath(import.meta.url));

// Schemes the app is willing to hand to the OS via shell.openExternal. Anything
// else a renderer asks to open (file:, smb:, custom handlers, …) is ignored.
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

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

// Whether a URL may be handed to the OS browser. Exported so the allowlist is
// covered without driving a real BrowserWindow.
export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

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
    void shell.openExternal(rawUrl);
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

export function createMainWindow(): BrowserWindow {
  // Force the light theme so the host OS paints a light native title bar on this
  // light app — a dark-mode host would otherwise give it a dark bar that fights
  // the UI (window-chrome conventions: chrome colors match the app's theme).
  nativeTheme.themeSource = "light";

  const window = new BrowserWindow(buildWindowOptions());

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
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    // Packaged build only: enforce the CSP via a response header. (Re-registering
    // on a subsequent window replaces the single handler, which is harmless.)
    window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: withContentSecurityPolicy(details.responseHeaders) });
    });
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}
