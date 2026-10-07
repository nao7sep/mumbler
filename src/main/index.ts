import { app, BrowserWindow, powerMonitor, protocol } from "electron";
import { extname } from "node:path";

import { APP_SHELL_EVENTS } from "@shared/app-shell";
import { ApplicationRuntime } from "./core/app-runtime";
import { registerAppShellIpc } from "./ipc/app-shell";
import { createMainWindow } from "./window";
import { createMediaResponse } from "./media-response";
import { applyThemePreference, followOsThemeChanges } from "./core/theme";
import { showStartupFailureDialog } from "./startup-failure-dialog";
import { loadInterfaceCatalogue, mainTranslator } from "./i18n";
import { installApplicationMenu } from "./app-menu";
import { notifyRecordsChanged, openRecordsWindow } from "./records-window";
import { createQuitController, quitFailureDialog, type QuitController } from "./quit";
import { showPlainDialog, type OpenPlainDialog } from "./plain-dialog";
import { flushWindowEdits } from "./pending-edits";
import { createWindowCloseController } from "./window-close";

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

// Set once bootstrap finishes so the quit paths can reach the runtime.
let runtimeForShutdown: ApplicationRuntime | null = null;
// Every quit path goes through it once the runtime exists.
let quitController: QuitController | null = null;
// macOS posts a logout, restart or shutdown before it sends the quit, so the
// quit that follows is a session end, which never asks the user.
let sessionEnding = false;
// The main window, apart from the records window beside it: closing it quits
// on Windows and Linux, and on macOS the Dock reopens it.
let mainWindow: BrowserWindow | null = null;

let cancelWindowClose: (() => void) | null = null;

function createQuit(runtime: ApplicationRuntime): QuitController {
  let question: OpenPlainDialog<"retry" | "quit-anyway" | "cancel"> | null = null;
  return createQuitController({
    flushEdits: (signal) => {
      cancelWindowClose?.();
      return flushWindowEdits(mainWindow, signal);
    },
    save: () => runtime.saveForQuit(),
    resume: () => runtime.resumeAfterCancelledQuit(),
    close: (details) => runtime.closeForQuit(details),
    ask: async (failure) => {
      question = showPlainDialog(quitFailureDialog(runtime.translator(), failure));
      try {
        return await question.choice;
      } finally {
        question = null;
      }
    },
    dismissQuestion: () => question?.close(),
    warn: (event, message, details) => {
      console.error(`[mumbler] ${message}`, details);
      void runtime.currentLogger().warn(event, message, details);
    },
    exit: () => app.exit(0),
  });
}

async function openMainWindow(runtime: ApplicationRuntime): Promise<void> {
  const window = await createMainWindow(runtime);
  mainWindow = window;
  let editsSentForClose = false;
  let notice: OpenPlainDialog<"dismiss"> | null = null;
  const close = createWindowCloseController({
    flush: (signal) => flushWindowEdits(window, signal),
    close: () => {
      editsSentForClose = true;
      if (!window.isDestroyed()) window.close();
    },
    failed: async () => {
      const translator = runtime.translator();
      notice = showPlainDialog({
        language: translator.language,
        title: translator.t("windowClose.title"),
        bodyLabel: translator.t("quit.detailsLabel"),
        body: translator.t("windowClose.body"),
        actions: [{ choice: "dismiss", label: translator.t("common.close") }],
        focus: "dismiss",
        dismiss: "dismiss",
      });
      try { await notice.choice; } finally { notice = null; }
    },
    dismiss: () => notice?.close(),
  });
  cancelWindowClose = () => close.cancel();
  window.on("close", (event) => {
    // Closing the main window quits on Windows and Linux, through the same
    // save as every other quit, which a failed save can cancel.
    if (process.platform !== "darwin") {
      if (quitController === null) return;
      event.preventDefault();
      quitController.request("user");
      return;
    }
    // On macOS it only closes the window, after it sends its unsent edits.
    if (editsSentForClose) return;
    event.preventDefault();
    if (!quitController?.isRunning()) close.request();
  });
  // Windows asks before a logout, restart or shutdown and never sends
  // before-quit. Holding the answer gives the save its bounded time; the
  // process then exits and Windows goes on (Electron's documented use).
  window.on("query-session-end", (event) => {
    event.preventDefault();
    quitController?.request("session-end");
  });
  // A session end Windows did not ask about first (a forced or critical one)
  // ends the process soon after this returns; the same save starts, as far as
  // it gets.
  window.on("session-end", () => {
    quitController?.request("session-end");
  });
  window.once("closed", () => {
    close.cancel();
    if (mainWindow === window) {
      mainWindow = null;
      cancelWindowClose = null;
    }
    if (process.platform !== "darwin") app.quit();
  });
}

async function bootstrap(): Promise<void> {
  const runtime = await ApplicationRuntime.initialize();
  runtimeForShutdown = runtime;
  quitController = createQuit(runtime);
  // A logout, restart or shutdown on macOS (and Linux); the OS then sends the
  // quit, which before-quit takes as a session end.
  powerMonitor.on("shutdown", () => {
    sessionEnding = true;
  });

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
      return await createMediaResponse(
        filePath,
        request.headers.get("Range"),
        AUDIO_MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      );
    } catch (error: unknown) {
      // A resolved card pointed at a file we could not read — unexpected at this
      // boundary, so log it rather than silently 404. Earlier 404s above (bad URL
      // shape, unknown card) are expected and stay quiet.
      void runtime.currentLogger().warn("media.read", "Failed to read card media file.", {
        cardId,
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return new Response("Not found", { status: 404 });
    }
  });

  registerAppShellIpc(runtime, { openRecords: () => openRecordsWindow(runtime) });
  runtime.onRecordsChanged(notifyRecordsChanged);
  // The native menu speaks the interface language, and is rebuilt when a
  // language saved in Settings changes it; the other windows are told so.
  installApplicationMenu(runtime.translator(), app.getName());
  runtime.alignAppKit();
  runtime.onLanguageChanged(() => {
    installApplicationMenu(runtime.translator(), app.getName());
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(APP_SHELL_EVENTS.interfaceLanguageChanged);
      }
    }
  });
  // Before the window exists, so its first frame, title bar, and background
  // already match the saved choice.
  applyThemePreference(runtime.themePreference());
  followOsThemeChanges();
  await openMainWindow(runtime);

  // The data backup is now write-through (data-backup conventions): every managed
  // text save records itself into ~/.mumbler/backups.sqlite3 the instant its atomic
  // rename lands (see backupStore + writeJsonFile's record hook). There is no
  // startup scan to fire here — the retired ZIP engine's launch pass is gone.

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

  runtime.onDependenciesChanged(() => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(APP_SHELL_EVENTS.dependenciesUpdated);
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
    if (mainWindow === null || mainWindow.isDestroyed()) {
      void openMainWindow(runtime).catch(handleBootstrapFailure);
    }
  });
}

let handlingBootstrapFailure = false;
async function handleBootstrapFailure(error: unknown): Promise<void> {
  if (handlingBootstrapFailure) return;
  handlingBootstrapFailure = true;
  console.error("[mumbler] Bootstrap failed:", error instanceof Error ? error.stack : String(error));
  try {
    await runtimeForShutdown?.currentLogger().error(
      "startup.failed",
      "Mumbler could not finish startup.",
      error,
    );
  } catch (loggingError) {
    console.error("[mumbler] Could not record bootstrap failure:", loggingError);
  }
  let choice: "close" | "restart" = "close";
  try {
    let translator = runtimeForShutdown?.translator();
    if (translator === undefined) {
      await loadInterfaceCatalogue("system");
      translator = mainTranslator("system");
    }
    choice = await showStartupFailureDialog(translator);
  } catch (dialogError) {
    console.error("[mumbler] Could not show the startup failure window:", dialogError);
  }
  if (choice === "restart") app.relaunch();
  app.exit(1);
}

// Single-instance lock: a second launch must not run a parallel main process. It
// would clear the shared ~/.mumbler/temp staging out from under a download the
// first instance has in flight, and two processes would race the JSON stores. The
// second instance hands focus to the first and quits instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const existing = mainWindow ?? BrowserWindow.getAllWindows()[0];
    if (existing) {
      if (existing.isMinimized()) {
        existing.restore();
      }
      existing.focus();
    }
  });

  app.whenReady().then(bootstrap).catch(handleBootstrapFailure);

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  // The menu's Quit, Cmd+Q, the Dock's Quit and, on macOS, a logout, restart
  // or shutdown all arrive here. Every quit is held and goes through the quit
  // controller, whose app.exit(0) alone ends the process; one arriving while a
  // quit runs is held too (PLAYBOOK, Own the work in flight).
  app.on("before-quit", (event) => {
    event.preventDefault();
    if (quitController === null) {
      app.exit(0);
      return;
    }
    quitController.request(sessionEnding ? "session-end" : "user");
  });
}
