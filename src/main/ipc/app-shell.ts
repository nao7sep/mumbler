import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";

import {
  APP_SHELL_CHANNELS,
  type CardTrim,
  type GenerateTarget,
  type PendingImportReviewItem,
  type RendererErrorReport,
  type SaveConflictResolution,
  type SettingsDraft,
} from "@shared/app-shell";

import type { ApplicationRuntime } from "../core/app-runtime";
import { OperationError } from "../core/operation-error";

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

function assertGenerateTarget(value: unknown): asserts value is GenerateTarget {
  if (
    value !== "transcription" &&
    value !== "structured" &&
    value !== "title" &&
    value !== "slug"
  ) {
    throw new Error("Invalid IPC parameter: target must be a card processing step.");
  }
}

export function registerAppShellIpc(runtime: ApplicationRuntime): void {
  // Single chokepoint for every IPC handler: registers it and wraps it so that
  // any failure is logged in main before it propagates back to the renderer. An
  // expected, user-facing rejection (OperationError) is traced at debug —
  // developer-only — while anything unexpected is logged at error with full
  // fidelity. The error is always rethrown so the renderer still receives the
  // rejection and can surface it to the user.
  const handle = <A extends unknown[], R>(
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: A) => R | Promise<R>,
  ): void => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<R> => {
      try {
        return await fn(event, ...(args as A));
      } catch (error: unknown) {
        const logger = runtime.currentLogger();
        if (error instanceof OperationError) {
          await logger.debug("ipc.rejected", "IPC operation rejected.", {
            channel,
            reason: error.message,
          });
        } else {
          await logger.error("ipc.failed", "Unhandled failure in IPC handler.", error, { channel });
        }
        throw error;
      }
    });
  };

  handle(APP_SHELL_CHANNELS.getSnapshot, () => runtime.getSnapshot());
  handle(APP_SHELL_CHANNELS.getSettingsDraft, () => runtime.getSettingsDraft());
  handle(APP_SHELL_CHANNELS.getDefaultPrompts, () => runtime.getDefaultPrompts());

  handle(APP_SHELL_CHANNELS.openImportDialog, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null) {
      throw new Error("Import dialog requires an active window.");
    }

    return runtime.openImportDialog(window);
  });

  handle(APP_SHELL_CHANNELS.importDroppedPaths, (_event, paths: string[]) => {
    assertStringArray(paths, "paths");
    return runtime.importDroppedPaths(paths);
  });

  handle(
    APP_SHELL_CHANNELS.updatePendingImportDrafts,
    (_event, items: PendingImportReviewItem[]) => runtime.updatePendingImportDrafts(items),
  );

  handle(
    APP_SHELL_CHANNELS.confirmPendingImports,
    (_event, items: PendingImportReviewItem[]) => runtime.confirmPendingImports(items),
  );

  handle(APP_SHELL_CHANNELS.selectCard, (_event, cardId: string | null) => {
    if (cardId !== null) assertString(cardId, "cardId");
    return runtime.selectCard(cardId);
  });

  handle(APP_SHELL_CHANNELS.duplicateCard, (_event, cardId: string) => {
    assertString(cardId, "cardId");
    return runtime.duplicateCard(cardId);
  });

  handle(APP_SHELL_CHANNELS.updateCardTrim, (_event, cardId: string, trim: CardTrim) => {
    assertString(cardId, "cardId");
    assertCardTrim(trim);
    return runtime.updateCardTrim(cardId, trim);
  });

  handle(APP_SHELL_CHANNELS.getCardMediaSource, (_event, cardId: string) => {
    assertString(cardId, "cardId");
    return runtime.getCardMediaSource(cardId);
  });

  handle(APP_SHELL_CHANNELS.generateCardStep, (_event, cardId: string, target: GenerateTarget) => {
    assertString(cardId, "cardId");
    assertGenerateTarget(target);
    return runtime.generateCardStep(cardId, target);
  });

  handle(APP_SHELL_CHANNELS.cancelCardProcessing, (_event, cardId: string) => {
    assertString(cardId, "cardId");
    return runtime.cancelCardProcessing(cardId);
  });

  handle(APP_SHELL_CHANNELS.pickOutputDirectory, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null) {
      throw new Error("Choose output directory requires an active window.");
    }

    return runtime.pickOutputDirectory(window);
  });

  handle(APP_SHELL_CHANNELS.openOutputDirectory, () => runtime.openOutputDirectory());

  handle(APP_SHELL_CHANNELS.saveSettingsDraft, (_event, draft: SettingsDraft) =>
    runtime.saveSettingsDraft(draft),
  );

  handle(APP_SHELL_CHANNELS.chooseOutputDirectory, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null) {
      throw new Error("Choose output directory requires an active window.");
    }

    return runtime.chooseOutputDirectory(window);
  });

  handle(
    APP_SHELL_CHANNELS.saveCard,
    (_event, cardId: string, resolution?: SaveConflictResolution) => {
      assertString(cardId, "cardId");
      return runtime.saveCard(cardId, resolution);
    },
  );

  handle(APP_SHELL_CHANNELS.removeCard, (_event, cardId: string) => {
    assertString(cardId, "cardId");
    return runtime.removeCard(cardId);
  });

  handle(APP_SHELL_CHANNELS.reportRendererError, (_event, report: RendererErrorReport) =>
    runtime.reportRendererError(report),
  );

  handle(APP_SHELL_CHANNELS.dismissAppWideError, () => runtime.dismissAppWideError());
  handle(APP_SHELL_CHANNELS.resetState, () => runtime.resetState());
  handle(APP_SHELL_CHANNELS.cancelPendingImports, () => runtime.cancelPendingImports());
}
