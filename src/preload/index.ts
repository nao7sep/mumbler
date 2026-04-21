import { contextBridge, ipcRenderer } from "electron";

import {
  APP_SHELL_CHANNELS,
  APP_SHELL_EVENTS,
  type AppSnapshot,
  type CardTrim,
  type ImportOperationResult,
  type MumblerShellApi,
  type PendingImportReviewItem,
  type RendererErrorReport,
  type SaveCardResult,
  type SaveConflictResolution,
  type SettingsDraft,
} from "@shared/app-shell";

const api: MumblerShellApi = {
  getSnapshot: () => ipcRenderer.invoke(APP_SHELL_CHANNELS.getSnapshot) as Promise<AppSnapshot>,
  getSettingsDraft: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.getSettingsDraft) as Promise<SettingsDraft>,
  openImportDialog: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.openImportDialog) as Promise<ImportOperationResult>,
  importDroppedPaths: (paths: string[]) =>
    ipcRenderer.invoke(
      APP_SHELL_CHANNELS.importDroppedPaths,
      paths,
    ) as Promise<ImportOperationResult>,
  updatePendingImportDrafts: (items: PendingImportReviewItem[]) =>
    ipcRenderer.invoke(
      APP_SHELL_CHANNELS.updatePendingImportDrafts,
      items,
    ) as Promise<AppSnapshot>,
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
  updateCardLanguage: (cardId: string, language: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.updateCardLanguage, cardId, language) as Promise<AppSnapshot>,
  getCardMediaSource: (cardId: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.getCardMediaSource, cardId) as Promise<string>,
  transcribeCard: (cardId: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.transcribeCard, cardId) as Promise<AppSnapshot>,
  retryCard: (cardId: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.retryCard, cardId) as Promise<AppSnapshot>,
  pickOutputDirectory: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.pickOutputDirectory) as Promise<string | null>,
  saveSettingsDraft: (draft: SettingsDraft) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.saveSettingsDraft, draft) as Promise<AppSnapshot>,
  chooseOutputDirectory: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.chooseOutputDirectory) as Promise<AppSnapshot>,
  saveCard: (cardId: string, resolution?: SaveConflictResolution) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.saveCard, cardId, resolution) as Promise<SaveCardResult>,
  removeCard: (cardId: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.removeCard, cardId) as Promise<AppSnapshot>,
  reportRendererError: (report: RendererErrorReport) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.reportRendererError, report) as Promise<AppSnapshot>,
  dismissAppWideError: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.dismissAppWideError) as Promise<AppSnapshot>,
  resetState: () => ipcRenderer.invoke(APP_SHELL_CHANNELS.resetState) as Promise<AppSnapshot>,
  onAppWideErrorChanged: (listener: () => void) => {
    const wrapped = () => {
      listener();
    };
    ipcRenderer.on(APP_SHELL_EVENTS.appWideErrorUpdated, wrapped);
    return () => {
      ipcRenderer.removeListener(APP_SHELL_EVENTS.appWideErrorUpdated, wrapped);
    };
  },
  onPipelineProgressUpdated: (listener: () => void) => {
    const wrapped = () => {
      listener();
    };
    ipcRenderer.on(APP_SHELL_EVENTS.pipelineProgressUpdated, wrapped);
    return () => {
      ipcRenderer.removeListener(APP_SHELL_EVENTS.pipelineProgressUpdated, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("mumbler", api);
