import { ipcMain, type BrowserWindow, type IpcMainEvent } from "electron";
import { APP_SHELL_EVENTS, type UnsavedDraft } from "@shared/app-shell";

let nextRequest = 0;

export function flushWindowEdits(window: BrowserWindow | null, signal: AbortSignal): Promise<void> {
  if (window === null || window.isDestroyed()) return Promise.resolve();
  const contents = window.webContents;
  const request = ++nextRequest;
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      ipcMain.removeListener(APP_SHELL_EVENTS.pendingEditsFlushed, replied);
      signal.removeEventListener("abort", aborted);
      contents.removeListener("destroyed", destroyed);
      if (error) reject(error);
      else resolve();
    };
    const replied = (event: IpcMainEvent, id: unknown, succeeded: unknown): void => {
      if (event.sender !== contents || id !== request) return;
      finish(succeeded === true ? undefined : new Error("The window could not save its pending edits."));
    };
    const aborted = (): void => finish(new Error("Pending edit flush was cancelled."));
    const destroyed = (): void => finish(new Error("The window closed before confirming its pending edits."));
    ipcMain.on(APP_SHELL_EVENTS.pendingEditsFlushed, replied);
    contents.once("destroyed", destroyed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) return aborted();
    try {
      contents.send(APP_SHELL_EVENTS.flushPendingEdits, request);
    } catch (error: unknown) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export type DraftQueryResult = { kind: "available"; drafts: UnsavedDraft[] } | { kind: "unavailable"; error: unknown };

/** Missing acknowledgement is unknown, never evidence that there are no drafts. */
export function queryWindowDrafts(window: BrowserWindow | null, signal: AbortSignal): Promise<DraftQueryResult> {
  if (window === null) return Promise.resolve({ kind: "available", drafts: [] });
  if (window.isDestroyed()) return Promise.resolve({ kind: "unavailable", error: new Error("The window closed before its drafts could be checked.") });
  const contents = window.webContents;
  const request = ++nextRequest;
  return new Promise<DraftQueryResult>((resolve) => {
    const finish = (result: DraftQueryResult): void => {
      ipcMain.removeListener(APP_SHELL_EVENTS.unsavedDraftsReported, replied);
      signal.removeEventListener("abort", aborted);
      contents.removeListener("destroyed", destroyed);
      resolve(result);
    };
    const replied = (event: IpcMainEvent, id: unknown, drafts: unknown): void => {
      if (event.sender !== contents || id !== request) return;
      if (!Array.isArray(drafts) || drafts.some((draft) => draft !== "settings")) {
        finish({ kind: "unavailable", error: new Error("The window returned an invalid drafts report.") });
        return;
      }
      finish({ kind: "available", drafts });
    };
    const aborted = (): void => finish({ kind: "unavailable", error: new Error("The drafts check was cancelled or timed out.") });
    const destroyed = (): void => finish({ kind: "unavailable", error: new Error("The window closed before reporting its drafts.") });
    ipcMain.on(APP_SHELL_EVENTS.unsavedDraftsReported, replied);
    contents.once("destroyed", destroyed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) return aborted();
    try {
      contents.send(APP_SHELL_EVENTS.queryUnsavedDrafts, request);
    } catch (error: unknown) {
      finish({ kind: "unavailable", error });
    }
  });
}

/** Tells the window to close its session-only drafts without saving them. */
export function discardWindowDrafts(window: BrowserWindow | null): void {
  if (window === null || window.isDestroyed()) return;
  try {
    window.webContents.send(APP_SHELL_EVENTS.discardUnsavedDrafts);
  } catch {
    // The window is going away with its drafts.
  }
}
