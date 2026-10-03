import { BrowserWindow, nativeTheme } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_SHELL_EVENTS } from "@shared/app-shell";
import { RECORDS_WINDOW_MIN_HEIGHT, RECORDS_WINDOW_MIN_WIDTH } from "@shared/layout";
import type { ApplicationRuntime } from "./core/app-runtime";
import { serializeError } from "./core/logger";
import { windowBackground } from "./core/theme";
import { loadRendererPage } from "./window";
import { configureWindowMinimum } from "./window-minimum";
import { createWindowWithUsablePersistedBounds } from "./window-state-recovery";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The records window shows records.sqlite3. It is a durable secondary window
// with its own placement (window-conventions, Placement), and there is only
// ever one: opening it again brings it forward.
let recordsWindow: BrowserWindow | null = null;

export function buildRecordsWindowOptions(title: string): Electron.BrowserWindowConstructorOptions {
  return {
    name: "records",
    windowStatePersistence: {
      bounds: true,
      displayMode: process.platform === "win32",
    },
    title,
    width: 1240,
    height: 820,
    minWidth: RECORDS_WINDOW_MIN_WIDTH,
    minHeight: RECORDS_WINDOW_MIN_HEIGHT,
    show: false,
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

// Tells the records window, when it is open, that a record was stored.
export function notifyRecordsChanged(): void {
  if (recordsWindow !== null && !recordsWindow.isDestroyed()) {
    recordsWindow.webContents.send(APP_SHELL_EVENTS.recordsChanged);
  }
}

export async function openRecordsWindow(runtime: ApplicationRuntime): Promise<void> {
  if (recordsWindow !== null && !recordsWindow.isDestroyed()) {
    if (recordsWindow.isMinimized()) recordsWindow.restore();
    recordsWindow.show();
    recordsWindow.focus();
    return;
  }

  const options = buildRecordsWindowOptions(runtime.translator().t("records.title"));
  const window = createWindowWithUsablePersistedBounds("records", () => new BrowserWindow(options));
  recordsWindow = window;
  window.once("closed", () => {
    if (recordsWindow === window) recordsWindow = null;
  });
  configureWindowMinimum(window, () => ({ width: RECORDS_WINDOW_MIN_WIDTH, height: RECORDS_WINDOW_MIN_HEIGHT }),
    (error) => void runtime.currentLogger().warn("window.minimum", "Window minimum could not be updated.", {
      window: "records",
      error: serializeError(error),
    }));
  window.once("ready-to-show", () => {
    window.show();
  });

  try {
    await loadRendererPage(window, runtime, "records.html");
  } catch (error: unknown) {
    window.destroy();
    throw error;
  }
}
