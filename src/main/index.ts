import { app, BrowserWindow } from "electron";

import { registerAppShellIpc } from "./ipc/app-shell";
import { createMainWindow } from "./window";

app.setName("Mumbler");

async function bootstrap(): Promise<void> {
  registerAppShellIpc();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}

app.whenReady().then(bootstrap);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
