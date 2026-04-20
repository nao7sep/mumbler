import { app, BrowserWindow, protocol } from "electron";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import { APP_SHELL_EVENTS } from "@shared/app-shell";
import { ApplicationRuntime } from "./core/app-runtime";
import { registerAppShellIpc } from "./ipc/app-shell";
import { createMainWindow } from "./window";
import { attachWindowCloseHandling, registerWindowCloseIpc } from "./window-close";

app.setName("Mumbler");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "mumbler-asset",
    privileges: { secure: true, standard: true, stream: true, bypassCSP: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const AUDIO_MIME_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
  ".opus": "audio/ogg",
};

async function bootstrap(): Promise<void> {
  protocol.handle("mumbler-asset", async (request) => {
    const url = new URL(request.url);
    const filePath = url.searchParams.get("path") ?? "";
    if (!filePath) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const data = await readFile(filePath);
      return new Response(data, {
        status: 200,
        headers: {
          "Content-Type": AUDIO_MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
          "Content-Length": String(data.byteLength),
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  const runtime = await ApplicationRuntime.initialize();
  registerAppShellIpc(runtime);
  registerWindowCloseIpc();
  attachWindowCloseHandling(createMainWindow());

  const broadcastAppWideError = (): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(APP_SHELL_EVENTS.appWideErrorUpdated);
      }
    }
  };

  runtime.onPipelineProgress(() => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(APP_SHELL_EVENTS.pipelineProgressUpdated);
      }
    }
  });

  process.on("uncaughtException", (error) => {
    void runtime.reportMainProcessError("uncaughtException", error).then(() => {
      broadcastAppWideError();
    });
  });

  process.on("unhandledRejection", (error) => {
    void runtime.reportMainProcessError("unhandledRejection", error).then(() => {
      broadcastAppWideError();
    });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      attachWindowCloseHandling(createMainWindow());
    }
  });
}

app.whenReady().then(bootstrap).catch((error: unknown) => {
  console.error("[mumbler] Bootstrap failed:", error instanceof Error ? error.stack : String(error));
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
