import { BrowserWindow, Menu, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WINDOW_BACKGROUND = "#eef0ec";
const __dirname = dirname(fileURLToPath(import.meta.url));

// Schemes the app is willing to hand to the OS via shell.openExternal. Anything
// else a renderer asks to open (file:, smb:, custom handlers, …) is ignored.
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

function openExternalIfAllowed(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    void shell.openExternal(rawUrl);
  }
}

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
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
  });

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
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}
