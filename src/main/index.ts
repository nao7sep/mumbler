import { app, BrowserWindow } from "electron";

import { APP_SHELL_EVENTS } from "@shared/app-shell";
import { ApplicationRuntime } from "./core/app-runtime";
import { registerAppShellIpc } from "./ipc/app-shell";
import { createMainWindow } from "./window";
import { attachWindowCloseHandling, registerWindowCloseIpc } from "./window-close";

app.setName("Mumbler");

async function bootstrap(): Promise<void> {
  const runtime = await ApplicationRuntime.initialize();
  registerAppShellIpc(runtime);
  registerWindowCloseIpc();
  attachWindowCloseHandling(createMainWindow());

  const broadcastAppWideError = (): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(APP_SHELL_EVENTS.appWideErrorUpdated);
      }
    }
  };

  process.on("uncaughtException", (error) => {
    void runtime.reportMainProcessError("uncaughtException", error).then(() => {
      broadcastAppWideError();
    });
  });

  process.on("unhandledRejection", (error) => {
    void runtime.reportMainProcessError("unhandledRejection", error).then(() => {
      broadcastAppWideError();
    });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      attachWindowCloseHandling(createMainWindow());
    }
  });
}

app.whenReady().then(bootstrap);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
