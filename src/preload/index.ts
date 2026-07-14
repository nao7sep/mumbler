import { contextBridge, ipcRenderer, webUtils } from "electron";

import {
  APP_SHELL_CHANNELS,
  APP_SHELL_EVENTS,
  type AppSnapshot,
  type CardTrim,
  type DefaultModels,
  type GenerateTarget,
  type ImportOperationResult,
  type MumblerShellApi,
  type PendingImportReviewItem,
  type PromptTemplates,
  type RendererErrorReport,
  type SaveCardResult,
  type SaveConflictResolution,
  type SettingsDraft,
  type ToolName,
} from "@shared/app-shell";

const api: MumblerShellApi = {
  getSnapshot: () => ipcRenderer.invoke(APP_SHELL_CHANNELS.getSnapshot) as Promise<AppSnapshot>,
  getSettingsDraft: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.getSettingsDraft) as Promise<SettingsDraft>,
  getDefaultPrompts: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.getDefaultPrompts) as Promise<PromptTemplates>,
  getDefaultModels: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.getDefaultModels) as Promise<DefaultModels>,
  getDefaultTimestampPatterns: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.getDefaultTimestampPatterns) as Promise<string[]>,
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
  getCardMediaSource: (cardId: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.getCardMediaSource, cardId) as Promise<string>,
  generateCardStep: (cardId: string, target: GenerateTarget) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.generateCardStep, cardId, target) as Promise<AppSnapshot>,
  cancelCardProcessing: (cardId: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.cancelCardProcessing, cardId) as Promise<AppSnapshot>,
  pickOutputDirectory: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.pickOutputDirectory) as Promise<string | null>,
  openOutputDirectory: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.openOutputDirectory) as Promise<void>,
  saveSettingsDraft: (draft: SettingsDraft) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.saveSettingsDraft, draft) as Promise<AppSnapshot>,
  setGeminiApiKey: (apiKey: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.setGeminiApiKey, apiKey) as Promise<AppSnapshot>,
  clearGeminiApiKey: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.clearGeminiApiKey) as Promise<AppSnapshot>,
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
  cancelPendingImports: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.cancelPendingImports) as Promise<AppSnapshot>,
  provisionTool: (name: ToolName) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.provisionTool, name) as Promise<AppSnapshot>,
  checkTools: () => ipcRenderer.invoke(APP_SHELL_CHANNELS.checkTools) as Promise<AppSnapshot>,
  saveToolSettings: (checkUpdatesAtLaunch: boolean) =>
    ipcRenderer.invoke(
      APP_SHELL_CHANNELS.saveToolSettings,
      checkUpdatesAtLaunch,
    ) as Promise<AppSnapshot>,
  saveLayout: (queueWidth: number) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.saveLayout, queueWidth) as Promise<AppSnapshot>,
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
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
  onDependenciesUpdated: (listener: () => void) => {
    const wrapped = () => {
      listener();
    };
    ipcRenderer.on(APP_SHELL_EVENTS.dependenciesUpdated, wrapped);
    return () => {
      ipcRenderer.removeListener(APP_SHELL_EVENTS.dependenciesUpdated, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("mumbler", api);
