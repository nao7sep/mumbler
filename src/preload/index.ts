import { contextBridge, ipcRenderer, webUtils } from "electron";

import {
  APP_SHELL_CHANNELS,
  APP_SHELL_EVENTS,
  type AppSnapshot,
  type CardTrim,
  type ConfirmImportsResult,
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
  type UnsavedDraft,
} from "@shared/app-shell";
import type { InterfaceLanguage } from "@shared/i18n/languages";
import type { RecordDetail, RecordKind, RecordSources, RecordsPage, RecordsQuery } from "@shared/records";

// What sends each part of the window's unsent edits. A quit's request is
// answered with the request identity and whether every save succeeded.
const pendingEditFlushes = new Set<() => Promise<void>>();
ipcRenderer.on(APP_SHELL_EVENTS.flushPendingEdits, (_event, request: unknown) => {
  void Promise.allSettled([...pendingEditFlushes].map((flush) => Promise.resolve().then(flush))).then((results) => {
    ipcRenderer.send(APP_SHELL_EVENTS.pendingEditsFlushed, request, results.every((result) => result.status === "fulfilled"));
  });
});

// What reports and discards each session-only draft the window holds.
const unsavedDrafts = new Set<{ report: () => UnsavedDraft[]; discard: () => void }>();
ipcRenderer.on(APP_SHELL_EVENTS.queryUnsavedDrafts, (_event, request: unknown) => {
  const drafts = [...unsavedDrafts].flatMap((owner) => owner.report());
  ipcRenderer.send(APP_SHELL_EVENTS.unsavedDraftsReported, request, drafts);
});
ipcRenderer.on(APP_SHELL_EVENTS.discardUnsavedDrafts, () => {
  for (const owner of unsavedDrafts) owner.discard();
});

const api: MumblerShellApi = {
  getInterfaceLanguage: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.getInterfaceLanguage) as Promise<InterfaceLanguage>,
  getSnapshot: () => ipcRenderer.invoke(APP_SHELL_CHANNELS.getSnapshot) as Promise<AppSnapshot>,
  getSettingsDraft: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.getSettingsDraft) as Promise<SettingsDraft>,
  getDefaultPrompts: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.getDefaultPrompts) as Promise<PromptTemplates>,
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
    ) as Promise<ConfirmImportsResult>,
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
  openExternal: (url: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.openExternal, url) as Promise<void>,
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
  reportRendererDiagnostic: (report: RendererErrorReport) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.reportRendererDiagnostic, report) as Promise<void>,
  dismissAppWideError: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.dismissAppWideError) as Promise<AppSnapshot>,
  resetState: () => ipcRenderer.invoke(APP_SHELL_CHANNELS.resetState) as Promise<AppSnapshot>,
  cancelPendingImports: (ids: string[]) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.cancelPendingImports, ids) as Promise<AppSnapshot>,
  provisionTool: (name: ToolName) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.provisionTool, name) as Promise<AppSnapshot>,
  cancelToolProvision: (name: ToolName) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.cancelToolProvision, name) as Promise<AppSnapshot>,
  checkTools: () => ipcRenderer.invoke(APP_SHELL_CHANNELS.checkTools) as Promise<AppSnapshot>,
  cancelToolCheck: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.cancelToolCheck) as Promise<AppSnapshot>,
  saveToolSettings: (checkUpdatesAtLaunch: boolean) =>
    ipcRenderer.invoke(
      APP_SHELL_CHANNELS.saveToolSettings,
      checkUpdatesAtLaunch,
    ) as Promise<AppSnapshot>,
  saveLayout: (queueWidth: number) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.saveLayout, queueWidth) as Promise<AppSnapshot>,
  openRecordsWindow: () => ipcRenderer.invoke(APP_SHELL_CHANNELS.openRecordsWindow) as Promise<void>,
  readRecordsPage: (query: RecordsQuery) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.readRecordsPage, query) as Promise<RecordsPage>,
  readRecordDetail: (kind: RecordKind, id: number) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.readRecordDetail, kind, id) as Promise<RecordDetail | null>,
  readRecordSources: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.readRecordSources) as Promise<RecordSources>,
  getRecordsListWidth: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.getRecordsListWidth) as Promise<number>,
  saveRecordsListWidth: (width: number) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.saveRecordsListWidth, width) as Promise<number>,
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
  onInterfaceLanguageChanged: (listener: () => void) => {
    const wrapped = () => {
      listener();
    };
    ipcRenderer.on(APP_SHELL_EVENTS.interfaceLanguageChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(APP_SHELL_EVENTS.interfaceLanguageChanged, wrapped);
    };
  },
  onRecordsChanged: (listener: () => void) => {
    const wrapped = () => {
      listener();
    };
    ipcRenderer.on(APP_SHELL_EVENTS.recordsChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(APP_SHELL_EVENTS.recordsChanged, wrapped);
    };
  },
  onFlushPendingEdits: (flush: () => Promise<void>) => {
    pendingEditFlushes.add(flush);
    return () => {
      pendingEditFlushes.delete(flush);
    };
  },
  onUnsavedDrafts: (report: () => UnsavedDraft[], discard: () => void) => {
    const owner = { report, discard };
    unsavedDrafts.add(owner);
    return () => {
      unsavedDrafts.delete(owner);
    };
  },
};

contextBridge.exposeInMainWorld("mumbler", api);
