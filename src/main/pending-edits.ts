import { ipcMain, type BrowserWindow, type IpcMainEvent } from "electron";
import { APP_SHELL_EVENTS } from "@shared/app-shell";

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
