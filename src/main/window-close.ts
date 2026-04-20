import { BrowserWindow, ipcMain } from "electron";

import { APP_SHELL_CHANNELS, APP_SHELL_EVENTS } from "@shared/app-shell";

const attachedWindows = new WeakSet<BrowserWindow>();
const approvedWindowIds = new Set<number>();

export function registerWindowCloseIpc(): void {
  ipcMain.handle(APP_SHELL_CHANNELS.respondToWindowClose, (event, shouldClose: boolean) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null || window.isDestroyed() || !shouldClose) {
      return;
    }

    approvedWindowIds.add(window.id);
    window.close();
  });
}

export function attachWindowCloseHandling(window: BrowserWindow): void {
  if (attachedWindows.has(window)) {
    return;
  }

  attachedWindows.add(window);

  window.on("close", (event) => {
    if (approvedWindowIds.has(window.id)) {
      approvedWindowIds.delete(window.id);
      return;
    }

    if (window.webContents.isDestroyed()) {
      return;
    }

    event.preventDefault();
    window.webContents.send(APP_SHELL_EVENTS.windowCloseRequested);
  });

  window.on("closed", () => {
    approvedWindowIds.delete(window.id);
  });
}
