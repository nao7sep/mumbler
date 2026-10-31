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
  type SaveCardOptions,
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
  subscribeSnapshot: async (listener: (snapshot: AppSnapshot) => void) => {
    const wrapped = (_event: unknown, snapshot: AppSnapshot) => listener(snapshot);
    ipcRenderer.on(APP_SHELL_EVENTS.snapshotChanged, wrapped);
    const unsubscribe = () => { ipcRenderer.removeListener(APP_SHELL_EVENTS.snapshotChanged, wrapped); };
    try {
      // Main sends the current snapshot on the event channel before it replies.
      await ipcRenderer.invoke(APP_SHELL_CHANNELS.subscribeSnapshot);
    } catch (error: unknown) {
      unsubscribe();
      throw error;
    }
    return unsubscribe;
  },
  dismissFirstRunSetup: () => ipcRenderer.invoke(APP_SHELL_CHANNELS.dismissFirstRunSetup) as Promise<void>,
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
    ) as Promise<void>,
  confirmPendingImports: (items: PendingImportReviewItem[]) =>
    ipcRenderer.invoke(
      APP_SHELL_CHANNELS.confirmPendingImports,
      items,
    ) as Promise<ConfirmImportsResult>,
  selectCard: (cardId: string | null) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.selectCard, cardId) as Promise<void>,
  duplicateCard: (cardId: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.duplicateCard, cardId) as Promise<void>,
  updateCardTrim: (cardId: string, trim: CardTrim) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.updateCardTrim, cardId, trim) as Promise<void>,
  getCardMediaSource: (cardId: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.getCardMediaSource, cardId) as Promise<string>,
  getCardWaveformPeaks: (cardId: string, requestId: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.getCardWaveformPeaks, cardId, requestId) as Promise<Float32Array | null>,
  cancelCardWaveformPeaks: (requestId: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.cancelCardWaveformPeaks, requestId) as Promise<void>,
  generateCardStep: (cardId: string, target: GenerateTarget) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.generateCardStep, cardId, target) as Promise<void>,
  cancelCardProcessing: (cardId: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.cancelCardProcessing, cardId) as Promise<void>,
  pickOutputDirectory: (directory?: string, literalDirectory?: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.pickOutputDirectory, directory, literalDirectory) as Promise<string | null>,
  pickBackupDirectory: (directory?: string, literalDirectory?: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.pickBackupDirectory, directory, literalDirectory) as Promise<string | null>,
  openOutputDirectory: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.openOutputDirectory) as Promise<void>,
  openExternal: (url: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.openExternal, url) as Promise<void>,
  saveSettingsDraft: (draft: SettingsDraft) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.saveSettingsDraft, draft) as Promise<void>,
  setGeminiApiKey: (apiKey: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.setGeminiApiKey, apiKey) as Promise<{ hasGeminiApiKey: boolean }>,
  clearGeminiApiKey: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.clearGeminiApiKey) as Promise<{ hasGeminiApiKey: boolean }>,
  saveSetupDirectory: (directory: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.saveSetupDirectory, directory) as Promise<void>,
  saveSetupRecordingsDirectory: (directory: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.saveSetupRecordingsDirectory, directory) as Promise<void>,
  saveSetupTimezone: (timezone: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.saveSetupTimezone, timezone) as Promise<void>,
  chooseOriginalsDirectory: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.chooseOriginalsDirectory) as Promise<void>,
  chooseOutputDirectory: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.chooseOutputDirectory) as Promise<void>,
  saveCard: (cardId: string, resolution?: SaveConflictResolution, options?: SaveCardOptions) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.saveCard, cardId, resolution, options) as Promise<SaveCardResult>,
  removeCard: (cardId: string) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.removeCard, cardId) as Promise<void>,
  reportRendererError: (report: RendererErrorReport) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.reportRendererError, report) as Promise<void>,
  reportRendererDiagnostic: (report: RendererErrorReport) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.reportRendererDiagnostic, report) as Promise<void>,
  dismissAppWideError: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.dismissAppWideError) as Promise<void>,
  cancelPendingImports: (ids: string[]) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.cancelPendingImports, ids) as Promise<void>,
  provisionTool: (name: ToolName) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.provisionTool, name) as Promise<void>,
  cancelToolProvision: (name: ToolName) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.cancelToolProvision, name) as Promise<void>,
  checkTools: () => ipcRenderer.invoke(APP_SHELL_CHANNELS.checkTools) as Promise<void>,
  cancelToolCheck: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.cancelToolCheck) as Promise<void>,
  saveToolSettings: (checkUpdatesAtLaunch: boolean) =>
    ipcRenderer.invoke(
      APP_SHELL_CHANNELS.saveToolSettings,
      checkUpdatesAtLaunch,
    ) as Promise<void>,
  saveLayout: (queueWidth: number) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.saveLayout, queueWidth) as Promise<void>,
  openRecordsWindow: () => ipcRenderer.invoke(APP_SHELL_CHANNELS.openRecordsWindow) as Promise<void>,
  readRecordsPage: (query: RecordsQuery) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.readRecordsPage, query) as Promise<RecordsPage>,
  readRecordDetail: (kind: RecordKind, id: number) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.readRecordDetail, kind, id) as Promise<RecordDetail | null>,
  recordsMissing: () => ipcRenderer.invoke(APP_SHELL_CHANNELS.recordsMissing) as Promise<boolean>,
  readRecordSources: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.readRecordSources) as Promise<RecordSources>,
  getRecordsListWidth: () =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.getRecordsListWidth) as Promise<number>,
  saveRecordsListWidth: (width: number) =>
    ipcRenderer.invoke(APP_SHELL_CHANNELS.saveRecordsListWidth, width) as Promise<number>,
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  onInterfaceLanguageChanged: (listener: () => void) => {
    const wrapped = () => {
      listener();
    };
    ipcRenderer.on(APP_SHELL_EVENTS.interfaceLanguageChanged, wrapped);
    return () => {
      ipcRenderer.removeListener(APP_SHELL_EVENTS.interfaceLanguageChanged, wrapped);
    };
  },
  onRecordsChanged: (listener: (missingRecords: boolean) => void) => {
    const wrapped = (_event: unknown, missingRecords: boolean) => {
      listener(missingRecords);
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
