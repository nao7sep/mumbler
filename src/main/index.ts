import { app, BrowserWindow, powerMonitor, protocol } from "electron";
import { extname } from "node:path";

import { APP_SHELL_EVENTS } from "@shared/app-shell";
import { getAppPaths } from "./core/app-paths";
import { admitStorageRoot, prepareFrameworkStorage, type StorageAdmission } from "./core/storage-admission";
import { ApplicationRuntime } from "./core/app-runtime";
import { registerAppShellIpc } from "./ipc/app-shell";
import { createMainWindow } from "./window";
import { createMediaResponse } from "./media-response";
import { applyThemePreference, followOsThemeChanges } from "./core/theme";
import { showStartupFailureDialog } from "./startup-failure-dialog";
import { loadInterfaceCatalogue, mainTranslator } from "./i18n";
import { installApplicationMenu } from "./app-menu";
import { notifyRecordsChanged, openRecordsWindow } from "./records-window";
import { createQuitController, discardDraftsDialog, quitFailureDialog, stopWorkDialog } from "./quit";
import { showPlainDialog, type OpenPlainDialog } from "./plain-dialog";
import { discardWindowDrafts, flushWindowEdits, queryWindowDrafts } from "./pending-edits";

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

// Set once the runtime exists, so the quit paths can reach it.
let runtimeForShutdown: ApplicationRuntime | null = null;
// Settles when startup has finished or failed; a quit's save waits for it.
let startupSettled: Promise<void> = Promise.resolve();
// The main window, apart from the records window beside it: closing it quits
// on every platform (window-conventions), and the other windows go with it.
let mainWindow: BrowserWindow | null = null;

// How long the window has to report its session-only drafts. The renderer
// times out its own interaction; a window that does not answer is asked about.
const DRAFTS_ANSWER_MS = 1_000;

type DraftQuitChoice = "discard" | "cancel" | "retry" | "quit-anyway";

// A failed query asks whether to quit anyway; it never counts as no drafts. OS
// takeover cancels the query or question and continues through the bounded
// session-end path.
async function confirmDiscardDrafts(
  runtime: ApplicationRuntime | null,
  window: BrowserWindow | null,
  shown: (question: OpenPlainDialog<DraftQuitChoice> | null) => void,
  cancelled: AbortSignal,
): Promise<boolean> {
  if (runtime === null) return true;
  const timeout = AbortSignal.any([AbortSignal.timeout(DRAFTS_ANSWER_MS), cancelled]);
  const result = await queryWindowDrafts(window, timeout);
  if (cancelled.aborted) return false;
  if (result.kind === "available" && result.drafts.length === 0) return true;
  if (result.kind === "unavailable") {
    void runtime.currentLogger().error("quit.drafts-unavailable", "Could not check the window's unsaved drafts.", result.error).catch(() => undefined);
  }
  const question: OpenPlainDialog<DraftQuitChoice> = result.kind === "unavailable"
    ? showPlainDialog(quitFailureDialog(runtime.translator(), "drafts-unavailable"))
    : showPlainDialog(discardDraftsDialog(runtime.translator()));
  shown(question);
  let choice: DraftQuitChoice;
  try { choice = await question.choice; }
  finally { shown(null); }
  if (cancelled.aborted || choice === "cancel") return false;
  discardWindowDrafts(window);
  return true;
}

// The quit owner exists before startup, so a quit at any moment goes through
// it; before the runtime exists there is nothing to ask about or save.
const quitController = (() => {
  let question: OpenPlainDialog<"retry" | "quit-anyway" | "cancel"> | null = null;
  let draftsQuestion: OpenPlainDialog<DraftQuitChoice> | null = null;
  let workQuestion: OpenPlainDialog<"quit" | "cancel"> | null = null;
  let draftsQuery = new AbortController();
  const runtime = (): ApplicationRuntime | null => runtimeForShutdown;
  return createQuitController({
    // Running work the app owns is asked about before quit stops it
    // (unsaved-edits-conventions, Closing and quitting).
    confirmStopWork: async () => {
      const current = runtime();
      const dialog = current === null ? null : stopWorkDialog(current.translator(), current.runningWork());
      if (dialog === null) return true;
      workQuestion = showPlainDialog(dialog);
      try {
        return (await workQuestion.choice) === "quit";
      } finally {
        workQuestion = null;
      }
    },
    confirmDiscardDrafts: () => {
      draftsQuery = new AbortController();
      return confirmDiscardDrafts(runtime(), mainWindow, (shown) => { draftsQuestion = shown; }, draftsQuery.signal);
    },
    flushEdits: (signal) => flushWindowEdits(mainWindow, signal),
    // Startup may still be writing its stores; the save follows it.
    save: async () => {
      await startupSettled;
      return runtime()?.saveForQuit() ?? [];
    },
    resume: async () => { await runtime()?.resumeAfterCancelledQuit(); },
    close: async (details) => { await runtime()?.closeForQuit(details); },
    ask: async (failure) => {
      question = showPlainDialog(quitFailureDialog(runtime()?.translator() ?? mainTranslator("system"), failure));
      try {
        return await question.choice;
      } finally {
        question = null;
      }
    },
    dismissQuestion: () => {
      draftsQuery.abort();
      question?.close();
      workQuestion?.close();
      draftsQuestion?.close();
    },
    warn: (event, message, details) => {
      console.error(`[mumbler] ${message}`, details);
      void runtime()?.currentLogger().warn(event, message, details);
    },
    // A clean exit waits for a worker blocked inside SQLite (measured:
    // Electron's app.exit joins it), so an exit at the deadline kills the
    // process instead; nothing is claimed as saved by it.
    exit: (settled) => {
      if (settled) app.exit(0);
      else process.kill(process.pid, "SIGKILL");
    },
  });
})();

async function openMainWindow(runtime: ApplicationRuntime): Promise<void> {
  const window = await createMainWindow(runtime);
  mainWindow = window;
  // Closing the main window quits on every platform, through the same quit
  // flow and questions as every other quit, which a question can cancel.
  window.on("close", (event) => {
    event.preventDefault();
    quitController.request("user");
  });
  // Windows does not send before-quit for logout/restart. Start best-effort
  // saving without vetoing or extending the OS session end; Windows may end
  // the process before the app's own bounded attempt finishes.
  window.on("query-session-end", () => {
    quitController.request("session-end");
  });
  // A session end Windows did not ask about first (a forced or critical one)
  // ends the process soon after this returns; the same save starts, as far as
  // it gets.
  window.on("session-end", () => {
    quitController.request("session-end");
  });
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
}

async function bootstrap(admission: StorageAdmission): Promise<void> {
  const runtime = await ApplicationRuntime.initialize(admission);
  runtimeForShutdown = runtime;
  // Once a quit has begun, startup goes no further: it opens no window and
  // shows nothing, and the quit exits through its own deadline.
  if (quitController.isRunning()) return;
  // A logout, restart or shutdown on macOS (and Linux) starts the session-end
  // quit at once: it closes any open question, saves within its bound and
  // exits. The OS's own quit that follows joins it. Nothing is remembered for a
  // later quit, so one after another app cancelled the logout asks as usual.
  powerMonitor.on("shutdown", () => {
    quitController.request("session-end");
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
  if (quitController.isRunning()) return;
  await openMainWindow(runtime);

  // Settings saves enqueue asynchronous, best-effort history recording after
  // their atomic rename. Other app stores are excluded from backup history,
  // and there is no startup backup scan.

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

}

let handlingBootstrapFailure = false;
async function handleBootstrapFailure(error: unknown): Promise<void> {
  if (handlingBootstrapFailure) return;
  handlingBootstrapFailure = true;
  // A quit under way ends the process; startup shows nothing more.
  if (quitController.isRunning()) {
    console.error("[mumbler] Bootstrap failed during quit:", error instanceof Error ? error.stack : String(error));
    return;
  }
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

  // Top-level await keeps Electron's ready event behind asynchronous admission.
  // The instance lock was acquired at its established location and stays held.
  try {
    const admission = await admitStorageRoot(getAppPaths());
    await prepareFrameworkStorage(admission, app);
    startupSettled = app.whenReady().then(() => bootstrap(admission)).catch(handleBootstrapFailure);
  } catch (error) {
    startupSettled = app.whenReady().then(() => handleBootstrapFailure(error));
  }

  // Only an exit closes the main window, so this is the same end on every platform.
  app.on("window-all-closed", () => {
    app.quit();
  });

  // The menu's Quit, Cmd+Q, the Dock's Quit and, on macOS, a logout, restart
  // or shutdown all arrive here. Every quit is held and goes through the quit
  // controller, whose exit alone ends the process; one arriving while a quit
  // runs is held too.
  app.on("before-quit", (event) => {
    event.preventDefault();
    quitController.request("user");
  });
}
