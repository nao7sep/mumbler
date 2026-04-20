import { BrowserWindow, ipcMain } from "electron";

import type { PendingImportReviewItem } from "@shared/app-shell";

import type { ApplicationRuntime } from "../core/app-runtime";

export function registerAppShellIpc(runtime: ApplicationRuntime): void {
  ipcMain.handle("app-shell:get-snapshot", () => runtime.getSnapshot());

  ipcMain.handle("app-shell:open-import-dialog", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null) {
      throw new Error("Import dialog requires an active window.");
    }

    return runtime.openImportDialog(window);
  });

  ipcMain.handle("app-shell:import-dropped-paths", (_event, paths: string[]) =>
    runtime.importDroppedPaths(paths),
  );

  ipcMain.handle(
    "app-shell:confirm-pending-imports",
    (_event, items: PendingImportReviewItem[]) => runtime.confirmPendingImports(items),
  );

  ipcMain.handle("app-shell:select-card", (_event, cardId: string | null) =>
    runtime.selectCard(cardId),
  );
}
