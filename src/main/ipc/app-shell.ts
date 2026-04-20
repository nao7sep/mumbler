import { BrowserWindow, ipcMain } from "electron";

import {
  APP_SHELL_CHANNELS,
  type CardTrim,
  type PendingImportReviewItem,
  type RendererErrorReport,
  type SaveConflictResolution,
  type SettingsDraft,
} from "@shared/app-shell";

import type { ApplicationRuntime } from "../core/app-runtime";

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`Invalid IPC parameter: ${name} must be a string.`);
  }
}

function assertStringArray(value: unknown, name: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid IPC parameter: ${name} must be a string array.`);
  }
}

function assertCardTrim(value: unknown): asserts value is CardTrim {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid IPC parameter: trim must be an object.");
  }

  const obj = value as Record<string, unknown>;
  if (obj.frontMarkerSec !== null && typeof obj.frontMarkerSec !== "number") {
    throw new Error("Invalid IPC parameter: trim.frontMarkerSec must be number or null.");
  }
  if (obj.backMarkerSec !== null && typeof obj.backMarkerSec !== "number") {
    throw new Error("Invalid IPC parameter: trim.backMarkerSec must be number or null.");
  }
}

export function registerAppShellIpc(runtime: ApplicationRuntime): void {
  ipcMain.handle(APP_SHELL_CHANNELS.getSnapshot, () => runtime.getSnapshot());
  ipcMain.handle(APP_SHELL_CHANNELS.getSettingsDraft, () => runtime.getSettingsDraft());

  ipcMain.handle(APP_SHELL_CHANNELS.openImportDialog, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null) {
      throw new Error("Import dialog requires an active window.");
    }

    return runtime.openImportDialog(window);
  });

  ipcMain.handle(APP_SHELL_CHANNELS.importDroppedPaths, (_event, paths: string[]) => {
    assertStringArray(paths, "paths");
    return runtime.importDroppedPaths(paths);
  });

  ipcMain.handle(
    APP_SHELL_CHANNELS.updatePendingImportDrafts,
    (_event, items: PendingImportReviewItem[]) => runtime.updatePendingImportDrafts(items),
  );

  ipcMain.handle(
    APP_SHELL_CHANNELS.confirmPendingImports,
    (_event, items: PendingImportReviewItem[]) => runtime.confirmPendingImports(items),
  );

  ipcMain.handle(APP_SHELL_CHANNELS.selectCard, (_event, cardId: string | null) => {
    if (cardId !== null) assertString(cardId, "cardId");
    return runtime.selectCard(cardId);
  });

  ipcMain.handle(APP_SHELL_CHANNELS.duplicateCard, (_event, cardId: string) => {
    assertString(cardId, "cardId");
    return runtime.duplicateCard(cardId);
  });

  ipcMain.handle(
    APP_SHELL_CHANNELS.updateCardTrim,
    (_event, cardId: string, trim: CardTrim) => {
      assertString(cardId, "cardId");
      assertCardTrim(trim);
      return runtime.updateCardTrim(cardId, trim);
    },
  );

  ipcMain.handle(APP_SHELL_CHANNELS.updateCardLanguage, (_event, cardId: string, language: string) => {
    assertString(cardId, "cardId");
    assertString(language, "language");
    return runtime.updateCardLanguage(cardId, language);
  });

  ipcMain.handle(APP_SHELL_CHANNELS.getCardMediaSource, (_event, cardId: string) => {
    assertString(cardId, "cardId");
    return runtime.getCardMediaSource(cardId);
  });

  ipcMain.handle(APP_SHELL_CHANNELS.transcribeCard, (_event, cardId: string) => {
    assertString(cardId, "cardId");
    return runtime.transcribeCard(cardId);
  });

  ipcMain.handle(APP_SHELL_CHANNELS.retryCard, (_event, cardId: string) => {
    assertString(cardId, "cardId");
    return runtime.retryCard(cardId);
  });

  ipcMain.handle(APP_SHELL_CHANNELS.pickOutputDirectory, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null) {
      throw new Error("Choose output directory requires an active window.");
    }

    return runtime.pickOutputDirectory(window);
  });

  ipcMain.handle(APP_SHELL_CHANNELS.saveSettingsDraft, (_event, draft: SettingsDraft) =>
    runtime.saveSettingsDraft(draft),
  );

  ipcMain.handle(APP_SHELL_CHANNELS.chooseOutputDirectory, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null) {
      throw new Error("Choose output directory requires an active window.");
    }

    return runtime.chooseOutputDirectory(window);
  });

  ipcMain.handle(
    APP_SHELL_CHANNELS.saveCard,
    (_event, cardId: string, resolution?: SaveConflictResolution) => {
      assertString(cardId, "cardId");
      return runtime.saveCard(cardId, resolution);
    },
  );

  ipcMain.handle(APP_SHELL_CHANNELS.removeCard, (_event, cardId: string) => {
    assertString(cardId, "cardId");
    return runtime.removeCard(cardId);
  });

  ipcMain.handle(APP_SHELL_CHANNELS.reportRendererError, (_event, report: RendererErrorReport) =>
    runtime.reportRendererError(report),
  );

  ipcMain.handle(APP_SHELL_CHANNELS.dismissAppWideError, () => runtime.dismissAppWideError());
  ipcMain.handle(APP_SHELL_CHANNELS.resetState, () => runtime.resetState());
}
