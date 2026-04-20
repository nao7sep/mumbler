import { contextBridge, ipcRenderer } from "electron";

import {
  APP_SHELL_CHANNELS,
  type AppSnapshot,
  type CardTrim,
  type ImportOperationResult,
  type MumblerShellApi,
  type PendingImportReviewItem,
} from "@shared/app-shell";

const api: MumblerShellApi = {
  getSnapshot: () => ipcRenderer.invoke(APP_SHELL_CHANNELS.getSnapshot) as Promise<AppSnapshot>,
  openImportDialog: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.openImportDialog) as Promise<ImportOperationResult>,
  importDroppedPaths: (paths: string[]) =>
    ipcRenderer.invoke(
      APP_SHELL_CHANNELS.importDroppedPaths,
      paths,
    ) as Promise<ImportOperationResult>,
  confirmPendingImports: (items: PendingImportReviewItem[]) =>
    ipcRenderer.invoke(
      APP_SHELL_CHANNELS.confirmPendingImports,
      items,
    ) as Promise<AppSnapshot>,
  selectCard: (cardId: string | null) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.selectCard, cardId) as Promise<AppSnapshot>,
  duplicateCard: (cardId: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.duplicateCard, cardId) as Promise<AppSnapshot>,
  updateCardTrim: (cardId: string, trim: CardTrim) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.updateCardTrim, cardId, trim) as Promise<AppSnapshot>,
  getCardMediaSource: (cardId: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.getCardMediaSource, cardId) as Promise<string>,
};

contextBridge.exposeInMainWorld("mumbler", api);
