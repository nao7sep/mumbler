import { app, ipcMain } from "electron";

import {
  APP_SHELL_CHANNELS,
  type AppBootstrap,
} from "@shared/app-shell";

export function registerAppShellIpc(): void {
  ipcMain.handle(APP_SHELL_CHANNELS.getBootstrap, (): AppBootstrap => ({
    appName: app.getName(),
    appVersion: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
    shellReadyAtUtc: new Date().toISOString(),
  }));
}

