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
import { createQuitController, discardDraftsDialog, QUIT_BUDGETS, quitFailureDialog, stopWorkDialog, type QuitController } from "./quit";
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

// Set once bootstrap finishes so the quit paths can reach the runtime.
let runtimeForShutdown: ApplicationRuntime | null = null;
// Every quit path goes through it once the runtime exists.
let quitController: QuitController | null = null;
// The main window, apart from the records window beside it: closing it quits
// on every platform (window-conventions), and the other windows go with it.
let mainWindow: BrowserWindow | null = null;

// Asks before a user's quit discards the window's session-only drafts, such as
// unsaved Settings changes; true goes on. A window that does not answer in time
// is taken to hold none, so it cannot hold the quit open. `cancelled` aborts
// when a session end takes over while the window is still being asked: no
// question opens after that, and false means nothing was discarded (the quit
// goes on regardless).
async function confirmDiscardDrafts(
  runtime: ApplicationRuntime,
  window: BrowserWindow | null,
  shown: (question: OpenPlainDialog<"discard" | "cancel"> | null) => void,
  cancelled: AbortSignal,
): Promise<boolean> {
  const timeout = AbortSignal.any([AbortSignal.timeout(QUIT_BUDGETS.user.flush), cancelled]);
  const drafts = await queryWindowDrafts(window, timeout);
  if (cancelled.aborted) return false;
  if (drafts.length === 0) return true;
  const question = showPlainDialog(discardDraftsDialog(runtime.translator()));
  shown(question);
  try {
    if ((await question.choice) !== "discard") return false;
  } finally {
    shown(null);
  }
  discardWindowDrafts(window);
  return true;
}

function createQuit(runtime: ApplicationRuntime): QuitController {
  let question: OpenPlainDialog<"retry" | "quit-anyway" | "cancel"> | null = null;
  let draftsQuestion: OpenPlainDialog<"discard" | "cancel"> | null = null;
  let workQuestion: OpenPlainDialog<"quit" | "cancel"> | null = null;
  let draftsQuery = new AbortController();
  return createQuitController({
    // Running work the app owns is asked about before quit stops it
    // (unsaved-edits-conventions, Closing and quitting).
    confirmStopWork: async () => {
      const dialog = stopWorkDialog(runtime.translator(), runtime.runningWork());
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
      return confirmDiscardDrafts(runtime, mainWindow, (shown) => { draftsQuestion = shown; }, draftsQuery.signal);
    },
    flushEdits: (signal) => flushWindowEdits(mainWindow, signal),
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
    dismissQuestion: () => {
      draftsQuery.abort();
      question?.close();
      workQuestion?.close();
      draftsQuestion?.close();
    },
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
  // Closing the main window quits on every platform, through the same quit
  // flow and questions as every other quit, which a question can cancel.
  window.on("close", (event) => {
    if (quitController === null) return;
    event.preventDefault();
    quitController.request("user");
  });
  // Windows does not send before-quit for logout/restart. Start best-effort
  // saving without vetoing or extending the OS session end; Windows may end
  // the process before the app's own bounded attempt finishes.
  window.on("query-session-end", () => {
    quitController?.request("session-end");
  });
  // A session end Windows did not ask about first (a forced or critical one)
  // ends the process soon after this returns; the same save starts, as far as
  // it gets.
  window.on("session-end", () => {
    quitController?.request("session-end");
  });
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
}

async function bootstrap(): Promise<void> {
  const runtime = await ApplicationRuntime.initialize();
  runtimeForShutdown = runtime;
  quitController = createQuit(runtime);
  // A logout, restart or shutdown on macOS (and Linux) starts the session-end
  // quit at once: it closes any open question, saves within its bound and
  // exits. The OS's own quit that follows joins it. Nothing is remembered for a
  // later quit, so one after another app cancelled the logout asks as usual.
  powerMonitor.on("shutdown", () => {
    quitController?.request("session-end");
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

  // Only an exit closes the main window, so this is the same end on every platform.
  app.on("window-all-closed", () => {
    app.quit();
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
    quitController.request("user");
  });
}
