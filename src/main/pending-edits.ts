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

/** The session-only drafts the window holds; none when it has no window, does
 * not answer before `signal` aborts, or is destroyed first. */
export function queryWindowDrafts(window: BrowserWindow | null, signal: AbortSignal): Promise<UnsavedDraft[]> {
  if (window === null || window.isDestroyed()) return Promise.resolve([]);
  const contents = window.webContents;
  const request = ++nextRequest;
  return new Promise<UnsavedDraft[]>((resolve) => {
    const finish = (drafts: UnsavedDraft[]): void => {
      ipcMain.removeListener(APP_SHELL_EVENTS.unsavedDraftsReported, replied);
      signal.removeEventListener("abort", aborted);
      contents.removeListener("destroyed", aborted);
      resolve(drafts);
    };
    const replied = (event: IpcMainEvent, id: unknown, drafts: unknown): void => {
      if (event.sender !== contents || id !== request) return;
      finish(Array.isArray(drafts) ? drafts.filter((draft): draft is UnsavedDraft => draft === "settings") : []);
    };
    const aborted = (): void => finish([]);
    ipcMain.on(APP_SHELL_EVENTS.unsavedDraftsReported, replied);
    contents.once("destroyed", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) return aborted();
    try {
      contents.send(APP_SHELL_EVENTS.queryUnsavedDrafts, request);
    } catch {
      aborted();
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
