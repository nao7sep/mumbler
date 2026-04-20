import { BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WINDOW_BACKGROUND = "#f8f9fb";
const __dirname = dirname(fileURLToPath(import.meta.url));

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

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}
