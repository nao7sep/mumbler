import { contextBridge, ipcRenderer } from "electron";

import {
  APP_SHELL_CHANNELS,
  type AppBootstrap,
  type MumblerShellApi,
} from "@shared/app-shell";

const api: MumblerShellApi = {
  getBootstrap: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.getBootstrap) as Promise<AppBootstrap>,
};

contextBridge.exposeInMainWorld("mumbler", api);

