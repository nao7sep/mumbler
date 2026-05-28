import { app, BrowserWindow, protocol } from "electron";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import { APP_SHELL_EVENTS } from "@shared/app-shell";
import { ApplicationRuntime } from "./core/app-runtime";
import { registerAppShellIpc } from "./ipc/app-shell";
import { createMainWindow } from "./window";

app.setName("Mumbler");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "mumbler-asset",
    privileges: { secure: true, standard: true, stream: true, supportFetchAPI: true, corsEnabled: true },
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
  const runtime = await ApplicationRuntime.initialize();

  protocol.handle("mumbler-asset", async (request) => {
    const url = new URL(request.url);
    // URL shape: mumbler-asset://media/<cardId>
    // host = "media", pathname = "/<cardId>"
    if (url.host !== "media") {
      return new Response("Not found", { status: 404 });
    }
    let cardId: string;
    try {
      cardId = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    } catch {
      return new Response("Not found", { status: 404 });
    }
    if (cardId.length === 0) {
      return new Response("Not found", { status: 404 });
    }
    const filePath = runtime.resolveCardSourcePath(cardId);
    if (filePath === null) {
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

  registerAppShellIpc(runtime);
  createMainWindow();

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
      createMainWindow();
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
