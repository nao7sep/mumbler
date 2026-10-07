import { app, BrowserWindow, dialog, shell } from "electron";
import { chmod, mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";

import { nanoid } from "nanoid";

import {
  type CardTrim,
  type AppPaths,
  type AppSnapshot,
  type ConfirmImportsResult,
  type FailedImport,
  type GenerateTarget,
  type ImportOperationResult,
  type ImportOriginalWarning,
  type ImportSource,
  type MumblerCard,
  type MumblerLayout,
  type MumblerSettings,
  type MumblerQueue,
  type PendingImportReviewItem,
  type RendererErrorReport,
  type SaveCardResult,
  type SaveOutputFile,
  type SaveConflictResolution,
  type SettingsDraft,
  type StartupFailure,
  type ThemePreference,
  type ToolName,
  type TrimDecision,
} from "@shared/app-shell";
import { AUDIO_IMPORT_EXTENSIONS, isSupportedAudioImportName } from "@shared/audio-import";
import { isCardBusy, sameTrim } from "@shared/card-status";
import { COMMAND_DEFINITIONS } from "@shared/commands";
import {
  analyzeTrimDecision,
  configureToolResolver,
  prepareAudioForTranscription,
  probeAudioProfile,
} from "./audio-tools";
import { ToolManager } from "./binaries/manager";
import { createDefaultDependencies, createDependenciesStore } from "./binaries/store";
import {
  formatUtcForDisplay,
  formatUtcMarker,
  isValidTimezone,
  parseTimestampFromFilename,
  recomputeLocalFromUtc,
  recomputeUtcFromLocal,
  resolveTimezone,
} from "@shared/timestamps";
import { closeBackupStore, setBackupStoreWarn } from "./backupStore";
import { NewerFormatError } from "./format-versions";
import { CorruptStateError, type JsonStore } from "./json-store";
import { resolveStorageRoot } from "./storage-root";
import { TranscriptStore } from "./transcript-store";
import { formatError, preserveAside } from "./file-io";
import { copyIntoWorking, copyOriginalToBackup, deleteImportedSource, reconcileWorkingState } from "./working-files";
import {
  buildMarkdownContent,
  buildOutputPayload,
  buildUniqueSuffixedTargets,
  computeFinalDuration,
  finalizeOutputs,
  OutputConflictError,
  OutputLocationError,
  OutputPartialFailureError,
  pathsConflict,
  type SaveTargetPaths,
} from "./file-output";

import { applySettingsDraft, buildSettingsDraft, createDefaultSettings, createEmptyQueue, createSettingsStore, createQueueStore, recoverInterruptedCards, summarizeSettings, type QueueStore, type SettingsStore } from "./settings-schema";
import {
  clampQueueWidth,
  clampRecordsListWidth,
  createDefaultLayout,
  createLayoutStore,
  selectExistingCardId,
} from "./layout-store";
import { clearApiKey, hasApiKey, resolveApiKey, writeApiKey } from "./api-keys";
import { type AppLogger, createLogger, serializeError, type SessionLogger } from "./logger";
import { OperationError } from "./operation-error";
import { applyThemePreference } from "./theme";
import { alignAppKit, loadInterfaceCatalogue, mainTranslator, resolveInterfaceLanguage } from "../i18n";
import type { InterfaceLanguage, LanguagePreference } from "@shared/i18n/languages";
import type { RecordDetail, RecordKind, RecordSources, RecordsPage, RecordsQuery } from "@shared/records";
import { createTranslator, message, type Message, type Translator } from "@shared/i18n/translate";
import type { MessageKey } from "@shared/i18n/catalogues";
import { clearCardResultsFromStep, resolveGenerateStartStep } from "./card-pipeline";
import { PipelineCoordinator } from "./pipeline-coordinator";


// Debug logging is developer-only: on for an unpackaged/dev build, or when an
// explicit MUMBLER_DEBUG=1 is set; off in a packaged release so the firehose
// never reaches an end-user's disk.
const DEBUG_LOGGING_ENABLED = !app.isPackaged || process.env.MUMBLER_DEBUG === "1";

function rendererReportError(report: RendererErrorReport): Error {
  const seen = new WeakSet<object>();
  const build = (diagnostic: { name?: unknown; message?: unknown; stack?: unknown; cause?: unknown }, depth: number): Error => {
    if (seen.has(diagnostic) || depth >= 8) return new Error("Renderer cause chain was truncated.");
    seen.add(diagnostic);
    const cause = diagnostic.cause && typeof diagnostic.cause === "object"
      ? build(diagnostic.cause as { name?: unknown; message?: unknown; stack?: unknown; cause?: unknown }, depth + 1)
      : undefined;
    const error = new Error(String(diagnostic.message ?? "Unknown renderer error."), cause === undefined ? undefined : { cause });
    error.name = typeof diagnostic.name === "string" ? diagnostic.name : "Error";
    if (typeof diagnostic.stack === "string") error.stack = diagnostic.stack;
    return error;
  };
  return build(report, 0);
}

/** Stable presentation for a failed user-commanded reset, naming what it had
 * already set aside in `folder`; the error itself is only logged. */
export function resetFailureDiagnostic(movedAside: readonly string[], folder: string): StartupFailure {
  return {
    title: message("diagnostic.resetTitle"),
    message: movedAside.length === 0
      ? message("diagnostic.resetBody")
      : message("diagnostic.resetMovedBody", { items: [...movedAside], folder }),
    canReset: true,
  };
}

// A store in a newer format is named and left exactly in place, so Reset, which
// would set it aside, is not offered (store-recovery-conventions).
export function startupFailureDiagnostic(error: unknown): StartupFailure {
  if (error instanceof NewerFormatError) {
    return {
      title: message("diagnostic.newerTitle"),
      message: message("diagnostic.newerBody", { path: error.filePath }),
      canReset: false,
    };
  }
  // A halted work store is named and left in place, with no Reset, which would
  // set it aside for a fresh queue (store-recovery-conventions).
  return error instanceof CorruptStateError
    ? {
        title: message("diagnostic.corruptTitle"),
        message: message("diagnostic.corruptBody", { path: error.filePath }),
        canReset: false,
      }
    : { title: message("diagnostic.startupTitle"), message: message("diagnostic.startupBody"), canReset: true };
}

// A source that is not importable, with the reason the interface shows (in the
// reader's language) and English for the log.
class ImportAdmissionError extends Error {
  constructor(readonly reason: MessageKey) {
    super(createTranslator("en").t(reason));
  }
}

/** The user's own work a quit could not save. */
export type QuitSaveFailure = "queue" | "transcripts" | "settings";

// What a save produced, before the snapshot that reports it is taken: the
// snapshot is built only after the card's status has settled.
type SaveOutcome =
  | ({ kind: "saved"; warnings?: Message[] } & SaveTargetPaths)
  | ({ kind: "conflict" } & SaveTargetPaths)
  | { kind: "cancelled" }
  | { kind: "failed"; message: Message; files?: SaveOutputFile[] };

interface AppRuntimeState {
  paths: AppPaths | null;
  settings: MumblerSettings | null;
  state: MumblerQueue | null;
  // Disposable presentation state (pane width and last-selected card). Loaded
  // leniently: a corrupt layout file self-heals rather than failing startup.
  layout: MumblerLayout | null;
  settingsStore: SettingsStore | null;
  queueStore: QueueStore | null;
  // Each card's transcription and structured outline, in its own file.
  transcriptStore: TranscriptStore | null;
  layoutStore: JsonStore<MumblerLayout> | null;
  logger: SessionLogger;
  startupDiagnostic: AppSnapshot["startupDiagnostic"];
  appWideError: AppSnapshot["appWideError"];
  recoveredInterruptedCards: number;
  shellReadyAtUtc: number;
  // The managed audio-tool (ffmpeg/ffprobe) controller; null on a failed startup.
  toolManager: ToolManager | null;
  // Cached presence of a resolvable Gemini key (env or stored secrets file), so
  // the synchronous getSnapshot()/summarizeSettings() can report it without
  // touching the filesystem. Refreshed at startup and after any set/clear.
  hasGeminiApiKey: boolean;
}

export class ApplicationRuntime {
  private readonly runtime: AppRuntimeState;
  // All running-pipeline bookkeeping (concurrency slots, active runs, the
  // queued-card drain) lives in the coordinator; the runtime keeps owning the
  // app state those pipelines mutate and the single persist path they call.
  private readonly pipeline: PipelineCoordinator;
  // Set while a quit saves and closes; a cancelled quit clears it again.
  private closing = false;
  private quitSave: Promise<QuitSaveFailure[]> | null = null;
  private quitAttempt = 0;
  // The settings write that had failed before this quit began, if any: that
  // failure was reported where the change was made, so only a later one is the
  // quit's to retry. Undefined while no quit is under way.
  private settingsFailureBeforeQuit: object | null | undefined = undefined;
  private closePromise: Promise<void> | null = null;
  // Whether queue.json may be behind the queue the app holds: set when a
  // persist fails, cleared when one lands.
  private queueBehind = false;
  private persistenceRequest = 0;
  private persistenceTail: Promise<void> = Promise.resolve();
  private onPipelineProgressCallback: (() => void) | null = null;
  private onLanguageChangedCallback: (() => void) | null = null;
  private onDependenciesChangedCallback: (() => void) | null = null;
  // Picker, drop, review confirm and review cancel all change the pending
  // imports. Keep copy -> pending state -> persistence, and settling a review,
  // ordered here; renderer disabling is presentation and cannot own data safety.
  private importTail: Promise<void> = Promise.resolve();
  // Card producers must be reached before quit snapshots the store tails: a
  // copy, deletion, trim analysis or key lookup can create its first write after an await.
  private readonly activeStateChanges = new Set<Promise<unknown>>();
  // In-flight saves, so shutdown can cancel each one and await its completed
  // publication attempt before the stores are flushed.
  private readonly activeSaves = new Map<AbortController, Promise<unknown>>();
  // Cards whose trim markers are being analyzed, with the number of the latest
  // request. A card listed here is busy for every other mutation (save,
  // generate, remove, duplicate), because the trim changes it after its await;
  // a newer trim of the same card supersedes an older one still analyzing.
  // Request numbers never repeat, so an entry removed and taken again cannot
  // hand a superseded analysis the number it started with.
  private readonly trimRequests = new Map<string, number>();
  private lastTrimRequest = 0;

  private constructor(runtime: AppRuntimeState) {
    this.runtime = runtime;
    this.pipeline = new PipelineCoordinator(runtime, {
      persistState: () => this.persistState(),
      resolveApiKey: () => this.resolveGeminiApiKey(),
    });
  }

  static async initialize(): Promise<ApplicationRuntime> {
    const shellReadyAtUtc = Date.now();

    // Resolve the storage root first. An unusable MUMBLER_DATA_DIR override is a
    // startup error the convention requires us to report and STOP on, never a
    // silent fallback to the default — and it happens before any logger or store
    // exists (those derive from the very paths we could not resolve), so it
    // surfaces as a paths-less startup diagnostic rather than crashing the
    // process uncaught.
    let paths: AppPaths;
    try {
      paths = getAppPaths();
    } catch (error: unknown) {
      // No usable storage root means no resolved records database either, so the
      // diagnostic logger writes into the *default* root's; createLogger never
      // throws (a failed write degrades to a text file, then stderr), so the
      // failure is still recorded somewhere.
      const fallbackRoot = join(homedir(), ".mumbler");
      const logger = createLogger(
        { recordsPath: join(fallbackRoot, "records.sqlite3"), logsDir: join(fallbackRoot, "logs") },
        { debugEnabled: DEBUG_LOGGING_ENABLED },
      );
      await logger.error("app.startup-failed", "Storage location could not be resolved.", error);
      await loadInterfaceCatalogue("system");
      return new ApplicationRuntime({
        paths: null,
        settings: null,
        state: null,
        layout: null,
        settingsStore: null,
        queueStore: null,
        transcriptStore: null,
        layoutStore: null,
        logger,
        startupDiagnostic: {
          title: message("diagnostic.storageTitle"),
          message: message("diagnostic.storageBody"),
          canReset: true,
        },
        appWideError: null,
        recoveredInterruptedCards: 0,
        shellReadyAtUtc,
        toolManager: null,
        hasGeminiApiKey: false,
      });
    }

    // The session logger is a per-launch singleton: built once here, before any
    // fallible startup step, and never rebuilt for the life of the launch — so a
    // launch's records all carry one session (createLogger stamps it from the
    // current time, so rebuilding it would fork a new session). It is created
    // before ensureDirectories() deliberately: createLogger touches no filesystem
    // until its first write, and that write creates the root it needs or degrades
    // without throwing — so the logger is on hand to record a startup failure on
    // the very path that could not create it.
    const logger = createLogger(paths, { debugEnabled: DEBUG_LOGGING_ENABLED });

    // Point the write-through backup store's single failure log at this launch's session log. The store
    // logs only failures (a record failure or a store that could not be opened), never a line per save.
    setBackupStoreWarn((message, details) => {
      void logger.warn("backup.record", message, details);
    });

    const settingsStore = createLoggedSettingsStore(paths.settingsPath, logger);
    const queueStore = createQueueStore(paths.queuePath);

    try {
      await ensureDirectories(paths, logger);

      // Authored settings that cannot be read are set aside and the app starts on
      // the built-ins, leaving the work stores alone (store-recovery-conventions).
      // A newer-format file halts launch below; a failed set-aside propagates.
      let settingsLoad;
      let settingsNotice: AppSnapshot["appWideError"] = null;
      try {
        settingsLoad = await settingsStore.load();
      } catch (error: unknown) {
        if (!(error instanceof CorruptStateError)) throw error;
        const [quarantinedTo] = await settingsStore.preserveExistingFiles();
        await logger.warn(
          "settings.corrupt-quarantined",
          "config.json was unreadable; quarantined aside and started with the built-in settings.",
          { path: paths.settingsPath, quarantinedTo, reason: error.message },
        );
        if (quarantinedTo !== undefined) {
          settingsNotice = {
            title: message("diagnostic.settingsResetTitle"),
            message: message("diagnostic.settingsResetBody", { path: quarantinedTo }),
          };
        }
        settingsLoad = await settingsStore.load();
      }
      const settings = settingsLoad.value;
      await loadInterfaceCatalogue(settings.language);
      // Resolve whether a Gemini key is available (env-first, then the dedicated
      // secrets file) once, so the snapshot can report presence without async I/O.
      const hasGeminiApiKey = await hasApiKey(
        paths.apiKeysPath,
        "gemini",
        makeApiKeyWarn(logger),
      );

      const stateLoad = await queueStore.load();
      const recovered = recoverInterruptedCards(stateLoad.value);
      const reconciliation = await reconcileWorkingState(paths, recovered.state, logger);

      // Each card's text lives in its own file.
      const transcriptStore = new TranscriptStore(paths.transcriptsDir);
      const transcripts = await transcriptStore.open(reconciliation.state.cards.map((card) => card.id));
      for (const card of reconciliation.state.cards) {
        const transcript = transcripts.get(card.id);
        if (transcript !== undefined) {
          card.transcription = { text: transcript.transcription };
          card.metadata = { ...card.metadata, structured: transcript.structured };
        }
      }

      // Persist startup fix-ups (interrupted-card recovery and working-file
      // reconciliation) only. queue.json holds precious queue/work data, so a
      // fresh empty queue has nothing to materialize and an unchanged existing
      // store is never rewritten.
      const stateChanged =
        recovered.recoveredInterruptedCards > 0 ||
        recovered.restoredSavingCards > 0 ||
        reconciliation.droppedPendingImports > 0 ||
        reconciliation.missingWorkingCards > 0;
      if (stateChanged) {
        await queueStore.save(reconciliation.state);
      }

      // Presentation state (disposable, volatile). A missing layout loads defaults
      // in memory and is written only once the user changes the pane width or card
      // selection. A layout.json in a newer format is left as it is: the session
      // runs on defaults and never writes it. A corrupt one must not halt launch
      // either, so it self-heals to defaults and overwrites the bad file.
      let layoutStore: JsonStore<MumblerLayout> | null = createLayoutStore(paths.layoutPath);
      let layout: MumblerLayout;
      try {
        layout = (await layoutStore.load()).value;
      } catch (error: unknown) {
        layout = createDefaultLayout();
        if (error instanceof NewerFormatError) {
          layoutStore = null;
          await logger.warn("app.layout-newer", "Layout file is in a newer format; left unchanged and not saved this session.", {
            layoutPath: paths.layoutPath,
            error: error.message,
          });
        } else {
          await layoutStore.save(layout);
          await logger.warn("app.layout-recovered", "Layout file was unreadable; reset to defaults.", {
            layoutPath: paths.layoutPath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      layout = {
        ...layout,
        selectedCardId: selectExistingCardId(
          reconciliation.state.cards.map((card) => card.id),
          layout.selectedCardId,
        ),
      };

      await logger.info("app.startup", "Application runtime initialized.", {
        appVersion: __APP_VERSION__,
        isPackaged: app.isPackaged,
        debugLogging: DEBUG_LOGGING_ENABLED,
        // Key effective configuration: summarizeSettings reports
        // the API key only as a presence boolean, never the value.
        config: summarizeSettings(settings, paths.outputDir, paths.originalsDir, hasGeminiApiKey),
        cardCount: reconciliation.state.cards.length,
        pendingImportCount: reconciliation.state.pendingImports.length,
        recoveredInterruptedCards: recovered.recoveredInterruptedCards,
        droppedPendingImports: reconciliation.droppedPendingImports,
        missingWorkingCards: reconciliation.missingWorkingCards,
        deletedDerivedFiles: reconciliation.deletedDerivedFiles,
        retainedDerivedFiles: reconciliation.retainedDerivedFiles,
      });

      if (recovered.recoveredInterruptedCards > 0) {
        await logger.warn(
          "app.startup-recovery",
          "Recovered interrupted cards from previous session.",
          { recoveredInterruptedCards: recovered.recoveredInterruptedCards },
        );
      }

      const runtime = new ApplicationRuntime({
        paths,
        settings,
        state: reconciliation.state,
        layout,
        settingsStore,
        queueStore,
        transcriptStore,
        layoutStore,
        logger,
        startupDiagnostic: null,
        appWideError: settingsNotice,
        recoveredInterruptedCards: recovered.recoveredInterruptedCards,
        shellReadyAtUtc,
        toolManager: null,
        hasGeminiApiKey,
      });

      // Managed audio tools (ffmpeg/ffprobe). The store holds their persisted
      // facts; the manager reconciles on-disk presence, drives the operations, and
      // notifies the runtime to re-emit the snapshot as state changes. The tool
      // resolver is wired so audio-tools can find the managed binaries; a missing
      // tool surfaces through the Audio Tools surface, never a hard startup failure.
      const dependenciesStore = createDependenciesStore(paths.dependenciesPath);
      // dependencies.json is a re-derivable facts cache, so corruption does
      // not block launch. A failed set-aside still propagates.
      let dependenciesLoad;
      try {
        dependenciesLoad = await dependenciesStore.load();
      } catch (error) {
        // A newer format halts launch below, leaving the file for the build that wrote it.
        if (!(error instanceof CorruptStateError)) throw error;
        const quarantinedTo = await dependenciesStore.preserveExistingFiles();
        await logger.warn(
          "dependencies.corrupt-quarantined",
          "dependencies.json was corrupt; quarantined aside and reset to defaults.",
          { path: paths.dependenciesPath, quarantinedTo, reason: error.message },
        );
        dependenciesLoad = { value: createDefaultDependencies(), origin: "created" as const };
      }
      if (dependenciesLoad.origin === "created") {
        await dependenciesStore.save(dependenciesLoad.value);
      }
      const toolManager = new ToolManager({
        binDir: paths.binDir,
        tempDir: paths.tempDir,
        platform: process.platform,
        arch: process.arch,
        value: dependenciesLoad.value,
        store: dependenciesStore,
        logger,
        notify: () => runtime.emitDependenciesChanged(),
      });
      await toolManager.reconcile();
      runtime.attachToolManager(toolManager);
      configureToolResolver((name) => toolManager.resolveToolPath(name));

      await runtime.drainQueuedCards();
      // The staleness-gated launch update check runs in the background so it never
      // blocks the shell. Nothing auto-downloads — a missing required tool is
      // surfaced by the renderer opening the Audio Tools modal.
      void runtime.startToolMaintenance();
      return runtime;
    } catch (error: unknown) {
      // Record the startup failure in the session log before surfacing it as a
      // diagnostic. The logger was built before any fallible step, so it exists
      // here even when the failure was ensureDirectories() itself — in which case
      // the append simply degrades to stderr.
      await logger.error("app.startup-failed", "Application runtime failed to start.", error);
      await loadInterfaceCatalogue("system");
      return new ApplicationRuntime({
        paths,
        settings: null,
        state: null,
        layout: null,
        settingsStore: null,
        queueStore: null,
        transcriptStore: null,
        layoutStore: null,
        logger,
        startupDiagnostic: startupFailureDiagnostic(error),
        appWideError: null,
        recoveredInterruptedCards: 0,
        shellReadyAtUtc,
        toolManager: null,
        hasGeminiApiKey: false,
      });
    }
  }

  onPipelineProgress(callback: () => void): void {
    this.onPipelineProgressCallback = callback;
  }

  onDependenciesChanged(callback: () => void): void {
    this.onDependenciesChangedCallback = callback;
  }

  // Called after each record the records database stores.
  onRecordsChanged(callback: () => void): void {
    this.runtime.logger.onStored(callback);
  }

  // Called by the ToolManager whenever dependency state changes (an operation's
  // progress, completion, or failure) so the renderer re-pulls the snapshot.
  emitDependenciesChanged(): void {
    this.onDependenciesChangedCallback?.();
  }

  // Attach the managed-tool controller built during initialize().
  attachToolManager(manager: ToolManager): void {
    this.runtime.toolManager = manager;
  }

  // Background startup maintenance: a latest-version check gated by the one toggle
  // (checkUpdatesAtLaunch) and by the last attempt time. It records its own outcome and a
  // failure here never disturbs the shell (a failed check writes nothing). Nothing
  // is auto-downloaded — a missing required tool is the renderer's concern.
  async startToolMaintenance(): Promise<void> {
    const manager = this.runtime.toolManager;
    const settings = this.runtime.settings;
    if (manager === null || settings === null) {
      return;
    }
    if (settings.checkUpdatesAtLaunch && manager.launchCheckDue()) {
      try {
        await manager.checkTools();
      } catch (error: unknown) {
        await this.runtime.logger.warn("tools.maintenance", "Background tool update check failed.", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private ensureToolManager(): ToolManager {
    if (this.runtime.toolManager === null) {
      throw new OperationError("Audio tools are unavailable.");
    }
    return this.runtime.toolManager;
  }

  async provisionTool(name: ToolName): Promise<AppSnapshot> {
    await this.ensureToolManager().installTool(name);
    return this.getSnapshot();
  }

  cancelToolProvision(name: ToolName): AppSnapshot {
    this.ensureToolManager().cancelInstall(name);
    return this.getSnapshot();
  }

  async checkTools(): Promise<AppSnapshot> {
    await this.ensureToolManager().checkTools();
    return this.getSnapshot();
  }

  cancelToolCheck(): AppSnapshot {
    this.ensureToolManager().cancelCheck();
    return this.getSnapshot();
  }

  saveToolSettings(checkUpdatesAtLaunch: boolean): Promise<AppSnapshot> {
    return this.runStateChange(() => this.persistToolSettings(checkUpdatesAtLaunch));
  }

  private async persistToolSettings(checkUpdatesAtLaunch: boolean): Promise<AppSnapshot> {
    this.ensureReady();
    const nextSettings = { ...this.runtime.settings!, checkUpdatesAtLaunch };
    await this.runtime.settingsStore!.save(nextSettings);
    this.runtime.settings = nextSettings;
    await this.runtime.logger.info("settings.tool-gates", "Updated audio tool settings.", {
      checkUpdatesAtLaunch,
    });
    return this.getSnapshot();
  }

  // The per-launch session logger. Exposed so the IPC boundary and the asset
  // protocol handler can log from outside the runtime instance. Always present:
  // it is built once at startup, before any step that could fail, and lives for
  // the whole launch — never null, never swapped.
  currentLogger(): AppLogger {
    return this.runtime.logger;
  }

  readRecordsPage(query: RecordsQuery): Promise<RecordsPage> {
    return this.runtime.logger.readRecords({ op: "page", query });
  }

  readRecordDetail(kind: RecordKind, id: number): Promise<RecordDetail | null> {
    return this.runtime.logger.readRecords({ op: "detail", kind, id });
  }

  async readRecordSources(): Promise<RecordSources> {
    const { sessions, cardIds } = await this.runtime.logger.readRecords({ op: "sources" });
    const names = new Map((this.runtime.state?.cards ?? []).map((card) => [card.id, card.originalFilename]));
    return {
      currentSession: this.runtime.logger.session,
      sessions,
      cards: cardIds.map((cardId) => ({ cardId, name: names.get(cardId) ?? null })),
    };
  }

  getSnapshot(): AppSnapshot {
    const { paths, settings, state, layout } = this.runtime;

    return {
      interfaceLanguage: this.interfaceLanguage(),
      appName: app.getName(),
      appVersion: __APP_VERSION__,
      platform: process.platform,
      isPackaged: app.isPackaged,
      shellReadyAtUtc: this.runtime.shellReadyAtUtc,
      paths,
      settingsSummary:
        settings && paths
          ? summarizeSettings(
              settings,
              paths.outputDir,
              paths.originalsDir,
              this.runtime.hasGeminiApiKey,
            )
          : null,
      queueSummary:
        state === null
          ? null
          : {
              cardCount: state.cards.length,
              pendingImportCount: state.pendingImports.length,
              selectedCardId: layout?.selectedCardId ?? null,
              recoveredInterruptedCards: this.runtime.recoveredInterruptedCards,
            },
      commands: COMMAND_DEFINITIONS,
      startupDiagnostic: this.runtime.startupDiagnostic,
      appWideError: this.runtime.appWideError,
      state,
      layout,
      dependencies: this.runtime.toolManager?.listStatuses() ?? null,
    };
  }

  // Persist the queue (left) pane's dragged width intent to layout.json. Called
  // only on a splitter drag-commit; the value is clamped to the queue-pane bounds
  // before it is stored. A window resize re-derives the displayed width in the
  // renderer and never reaches this path.
  async saveLayout(queueWidth: number): Promise<AppSnapshot> {
    this.ensureReady();
    const next: MumblerLayout = {
      ...(this.runtime.layout ?? createDefaultLayout()),
      queueWidth: clampQueueWidth(queueWidth),
    };
    this.runtime.layout = next;
    await this.runtime.layoutStore?.save(next);
    // A drag-commit is a low-value, potentially-repeated gesture, so it is traced
    // at debug (developer-only) rather than info, like card selection.
    await this.runtime.logger.debug("layout.save", "Persisted queue pane width.", {
      queueWidth: next.queueWidth,
    });
    return this.getSnapshot();
  }

  // The records window's list pane width: its dragged intent, kept beside the
  // queue pane's in the one in-memory layout and written whole, so a save from
  // either window keeps the other's width. The records window opens even when
  // the runtime failed, so this works without a ready runtime.
  recordsListWidth(): number {
    return clampRecordsListWidth(this.runtime.layout?.recordsListWidth);
  }

  async saveRecordsListWidth(width: number): Promise<number> {
    const next: MumblerLayout = {
      ...(this.runtime.layout ?? createDefaultLayout()),
      recordsListWidth: clampRecordsListWidth(width),
    };
    this.runtime.layout = next;
    await this.runtime.layoutStore?.save(next);
    return next.recordsListWidth;
  }

  async reportRendererError(report: RendererErrorReport): Promise<AppSnapshot> {
    await this.setAppWideError(
      message("diagnostic.unexpectedTitle"),
      message("diagnostic.windowBody"),
      rendererReportError(report),
      {
      source: report.source,
      stack: report.stack,
      },
    );
    return this.getSnapshot();
  }

  async reportRendererDiagnostic(report: RendererErrorReport): Promise<void> {
    await this.runtime.logger.error(
      "renderer.recovered",
      report.source,
      rendererReportError(report),
      { stack: report.stack },
    );
  }

  async reportMainProcessError(origin: "uncaughtException" | "unhandledRejection", error: unknown): Promise<void> {
    await this.setAppWideError(message("diagnostic.unexpectedTitle"), message("diagnostic.mainBody"), error, {
      origin,
      error: serializeError(error),
    });
  }

  async dismissAppWideError(): Promise<AppSnapshot> {
    const title = this.runtime.appWideError?.title.key ?? null;
    this.runtime.appWideError = null;
    await this.runtime.logger.info("app.error-dismissed", "App-wide error dismissed by user.", {
      dismissedTitle: title,
    });
    return this.getSnapshot();
  }

  // A reset that fails part-way is reported in the snapshot it returns, naming
  // what it had already set aside, rather than thrown.
  async resetState(): Promise<AppSnapshot> {
    const previousPreference = this.languagePreference();
    const previousLanguage = this.interfaceLanguage().language;
    const paths = this.runtime.paths ?? getAppPaths();
    const settingsStore = createLoggedSettingsStore(paths.settingsPath, this.runtime.logger);
    const queueStore = createQueueStore(paths.queuePath);
    const layoutStore = createLayoutStore(paths.layoutPath);
    const transcriptStore = new TranscriptStore(paths.transcriptsDir);
    const settings = createDefaultSettings();
    const state = createEmptyQueue();
    const layout = createDefaultLayout();

    // The names of what has been set aside so far.
    const movedAside: string[] = [];
    const moved = <T extends string[] | string | null>(path: string, result: T): T => {
      if (result !== null && result.length > 0) movedAside.push(basename(path));
      return result;
    };
    try {
      // Admit every reset-owned store before moving any sibling aside.
      await settingsStore.admitReset();
      await queueStore.admitReset();
      await layoutStore.admitReset();
      await transcriptStore.admitReset();
      await loadInterfaceCatalogue(settings.language);
      await ensureDirectories(paths, this.runtime.logger);
      // Preserve each store before the user-commanded reset returns to built-ins.
      const preservedSettingsFiles = moved(paths.settingsPath, await settingsStore.preserveExistingFiles());
      const preservedStateFiles = moved(paths.queuePath, await queueStore.preserveExistingFiles());
      // The preserved queue.json keeps its cards' text and recordings beside it;
      // a reset deletes no user audio.
      const preservedTranscripts = moved(paths.transcriptsDir, await transcriptStore.preserveExistingFiles());
      const preservedRecordings = moved(paths.workingDir, await preserveAside(paths.workingDir));
      await mkdir(paths.workingDir, { recursive: true });
      const preservedLayoutFiles = moved(paths.layoutPath, await layoutStore.preserveExistingFiles());
      // Reuse the per-launch session logger rather than building a new one, so a
      // reset keeps writing to the same file as the rest of the launch.
      const logger = this.runtime.logger;
      await logger.warn("app.reset-state", "Reset settings and state from diagnostic recovery.", {
        preservedSettingsFiles,
        preservedStateFiles,
        preservedTranscripts,
        preservedRecordings,
        preservedLayoutFiles,
      });

      this.runtime.paths = paths;
      this.runtime.settings = settings;
      this.runtime.state = state;
      this.runtime.layout = layout;
      this.runtime.settingsStore = settingsStore;
      this.runtime.queueStore = queueStore;
      this.runtime.transcriptStore = new TranscriptStore(paths.transcriptsDir);
      this.queueBehind = false;
      this.runtime.layoutStore = layoutStore;
      this.runtime.startupDiagnostic = null;
      this.runtime.appWideError = null;
      this.runtime.recoveredInterruptedCards = 0;
      applyThemePreference(settings.theme);
      this.followLanguageChange(previousPreference, previousLanguage);

      return this.getSnapshot();
    } catch (error: unknown) {
      await this.runtime.logger.error("app.reset-failed", "Reset of settings and state failed.", error, { movedAside });
      this.runtime.startupDiagnostic = error instanceof NewerFormatError
        ? movedAside.length === 0
          ? startupFailureDiagnostic(error)
          : { ...resetFailureDiagnostic(movedAside, paths.homeDir), canReset: false }
        : resetFailureDiagnostic(movedAside, paths.homeDir);
      return this.getSnapshot();
    }
  }

  getSettingsDraft(): SettingsDraft {
    this.ensureReady();
    return buildSettingsDraft(
      this.runtime.settings!,
      this.runtime.paths!.outputDir,
      this.runtime.paths!.originalsDir,
      this.runtime.hasGeminiApiKey,
    );
  }

  getDefaultPrompts(): MumblerSettings["prompts"] {
    return createDefaultSettings().prompts;
  }

  async openImportDialog(window: BrowserWindow): Promise<ImportOperationResult> {
    this.ensureReady();

    const t = this.translator().t;
    const result = await dialog.showOpenDialog(window, {
      title: t("dialog.importTitle"),
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: t("dialog.audioFiles"),
          extensions: [...AUDIO_IMPORT_EXTENSIONS],
        },
        { name: t("dialog.allFiles"), extensions: ["*"] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return {
        snapshot: this.getSnapshot(),
        attemptedPaths: [],
        importedCount: 0,
        failedImports: [],
        duplicateImports: [],
      };
    }

    return this.importPaths(result.filePaths, "file-picker");
  }

  async importDroppedPaths(paths: string[]): Promise<ImportOperationResult> {
    return this.importPaths(paths, "drag-and-drop");
  }

  async updatePendingImportDrafts(items: PendingImportReviewItem[]): Promise<AppSnapshot> {
    this.ensureReady();
    const state = this.runtime.state!;

    const currentIds = new Set(state.pendingImports.map((item) => item.id));
    const nextIds = new Set(items.map((item) => item.id));

    if (currentIds.size !== nextIds.size || [...currentIds].some((id) => !nextIds.has(id))) {
      throw new OperationError("Pending import drafts are out of date. Reopen the timestamp review.");
    }

    const draftsById = new Map(items.map((item) => [item.id, item]));
    const current = state.pendingImports;
    state.pendingImports = current.map((authoritative) => {
      const draft = draftsById.get(authoritative.id);
      return draft ? applyPendingImportDraft(authoritative, draft) : authoritative;
    });
    // Equal drafts still retry a packet whose previous write failed.
    if (this.queueBehind || state.pendingImports.some((item, index) => item !== current[index])) {
      await this.persistState();
    }
    return this.getSnapshot();
  }

  // Confirm and cancel run on the same serialized import boundary as the copies
  // that create pending imports, and each settles only the imports the review
  // showed: an import that arrives meanwhile stays pending for its own review.
  async confirmPendingImports(items: PendingImportReviewItem[]): Promise<ConfirmImportsResult> {
    return this.runImportExclusive(() => this.confirmReviewedImports(items));
  }

  private async confirmReviewedImports(items: PendingImportReviewItem[]): Promise<ConfirmImportsResult> {
    this.ensureReady();
    const state = this.runtime.state!;
    const paths = this.runtime.paths!;

    const byId = new Map(items.map((item) => [item.id, item]));
    // Every reviewed import is validated before any file is touched, so a bad
    // timestamp on one of them cannot leave another's original already deleted
    // while its import is still pending.
    const reviewed = state.pendingImports
      .filter((pendingImport) => byId.has(pendingImport.id))
      .map((pendingImport) => {
        // Overlay only the review-editable fields onto the authoritative item; the
        // working/original paths always come from server-side state.
        const merged = applyPendingImportDraft(pendingImport, byId.get(pendingImport.id)!);
        const timestamps = buildConfirmedTimestamps(
          merged.localTimestampText,
          merged.timezone,
          merged.utcTimestampText,
        );
        return { pendingImport, merged, timestamps };
      });
    const cardsToAdd: MumblerCard[] = [];
    // A backup or deletion of the original that did not happen is a warning on
    // the confirmed import, never its failure (error-handling-conventions).
    const originalWarnings: ImportOriginalWarning[] = [];
    const originalsToDelete: string[] = [];

    for (const { pendingImport, merged, timestamps } of reviewed) {
      let probed: Awaited<ReturnType<typeof probeAudioProfile>>;
      try {
        probed = await probeAudioProfile(pendingImport.workingFilePath);
        await this.runtime.logger.debug("audio.probe", "Probed audio profile for imported file.", {
          filename: pendingImport.originalFilename,
          durationSec: probed.durationSec,
          formatName: probed.audioProfile?.formatName,
          codecName: probed.audioProfile?.codecName,
          bitRateKbps: probed.audioProfile?.bitRateKbps,
          sampleRateHz: probed.audioProfile?.sampleRateHz,
          channels: probed.audioProfile?.channels,
        });
      } catch (error: unknown) {
        await this.runtime.logger.warn("audio.probe", "Failed to probe imported audio metadata.", {
          filePath: pendingImport.workingFilePath,
          error: error instanceof Error ? error.message : String(error),
        });
        probed = { durationSec: null, audioProfile: null };
      }

      cardsToAdd.push({
        id: nanoid(),
        originalFilename: pendingImport.originalFilename,
        importSource: pendingImport.importSource,
        sourceFilePath: pendingImport.workingFilePath,
        audioProfile: probed.audioProfile,
        durationSec: probed.durationSec,
        fileSizeBytes: pendingImport.fileSizeBytes,
        timestamps,
        trim: {
          frontMarkerSec: null,
          backMarkerSec: null,
        },
        trimDecision: null,
        transcribedTrim: null,
        transcription: {
          text: null,
        },
        metadata: {
          structured: null,
          title: null,
          slug: null,
        },
        ai: {
          transcription: null,
          structured: null,
          title: null,
          slug: null,
        },
        status: "Imported",
        activeStep: null,
        queuedMode: null,
        queuedAtUtc: null,
        lastError: null,
        createdAtUtc: Date.now(),
        updatedAtUtc: Date.now(),
      });

      let backupSucceeded = true;
      const backupDir = this.runtime.settings!.backupDirectory ?? paths.originalsDir;
      const file = pendingImport.originalSourcePath;
      if (merged.copyToBackupOnConfirm) {
        try {
          const backupPath = await copyOriginalToBackup(pendingImport.originalSourcePath, backupDir, this.runtime.logger);
          await this.runtime.logger.info("import.backup-original", "Copied original to backup directory.", {
            originalSourcePath: pendingImport.originalSourcePath,
            backupPath,
          });
        } catch (error: unknown) {
          backupSucceeded = false;
          await this.runtime.logger.warn("import.backup-original", "Failed to copy original to backup directory.", {
            originalSourcePath: pendingImport.originalSourcePath,
            backupDir,
            error: error instanceof Error ? error.message : String(error),
          });
          if (!merged.deleteOriginalOnConfirm) {
            originalWarnings.push({
              sourcePath: file,
              message: message("import.backupFailed", { file, folder: backupDir }),
            });
          }
        }
      }

      if (merged.deleteOriginalOnConfirm) {
        if (merged.copyToBackupOnConfirm && !backupSucceeded) {
          originalWarnings.push({
            sourcePath: file,
            message: message("import.backupFailedNotDeleted", { file, folder: backupDir }),
          });
          await this.runtime.logger.warn(
            "import.delete-original",
            "Skipped deleting original because backup copy failed.",
            { originalSourcePath: pendingImport.originalSourcePath },
          );
        } else {
          originalsToDelete.push(pendingImport.originalSourcePath);
        }
      }
    }

    const confirmedIds = new Set(reviewed.map(({ pendingImport }) => pendingImport.id));
    state.pendingImports = state.pendingImports.filter((item) => !confirmedIds.has(item.id));
    state.cards = [...state.cards, ...cardsToAdd].sort((left, right) =>
      left.timestamps.effectiveUtc - right.timestamps.effectiveUtc,
    );

    await this.persistState();
    for (const file of originalsToDelete) {
      try {
        await deleteImportedSource(file);
      } catch (error: unknown) {
        originalWarnings.push({ sourcePath: file, message: message("import.deleteFailed", { file }) });
        await this.runtime.logger.warn("import.delete-original", "Failed to delete original after confirm.", {
          originalSourcePath: file,
          error: serializeError(error),
        });
      }
    }
    if (cardsToAdd.length > 0) {
      try {
        await this.persistSelectedCard(cardsToAdd[0].id);
      } catch (error: unknown) {
        await this.runtime.logger.warn("import.select-card", "Import committed, but selection was not saved.", {
          error: serializeError(error),
        });
      }
    }
    await this.runtime.logger.info(
      "import.confirm-review",
      "Confirmed pending imports into queue.",
      { addedCards: cardsToAdd.length, stillPending: state.pendingImports.length },
    );

    return { snapshot: this.getSnapshot(), originalWarnings };
  }

  async cancelPendingImports(ids: string[]): Promise<AppSnapshot> {
    return this.runImportExclusive(() => this.cancelReviewedImports(ids));
  }

  private async cancelReviewedImports(ids: string[]): Promise<AppSnapshot> {
    this.ensureReady();
    const state = this.runtime.state!;
    const cancelIds = new Set(ids);
    const cancelled = state.pendingImports.filter((item) => cancelIds.has(item.id));

    for (const pendingImport of cancelled) {
      try {
        await rm(pendingImport.workingFilePath, { force: true });
      } catch (error: unknown) {
        await this.runtime.logger.warn("import.cancel-cleanup", "Failed to delete working file on cancel.", {
          workingFilePath: pendingImport.workingFilePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    state.pendingImports = state.pendingImports.filter((item) => !cancelIds.has(item.id));
    await this.persistState();
    await this.runtime.logger.info("import.cancelled", "Cancelled pending imports.", {
      cancelledCount: cancelled.length,
    });

    return this.getSnapshot();
  }

  async selectCard(cardId: string | null): Promise<AppSnapshot> {
    this.ensureReady();
    const state = this.runtime.state!;

    if (cardId !== null && !state.cards.some((card) => card.id === cardId)) {
      throw new OperationError("Selected card no longer exists.");
    }

    await this.persistSelectedCard(cardId);
    // Selection is a high-frequency navigation action (arrow keys), so it is
    // traced at debug — developer-only — rather than info, per the volume rules.
    await this.runtime.logger.debug("card.select", "Selected card.", { cardId });
    return this.getSnapshot();
  }

  duplicateCard(cardId: string): Promise<AppSnapshot> {
    return this.runStateChange(() => this.duplicateCardFromWorking(cardId));
  }

  private async duplicateCardFromWorking(cardId: string): Promise<AppSnapshot> {
    this.ensureReady();
    const state = this.runtime.state!;
    const paths = this.runtime.paths!;
    const source = this.requireIdleCard(cardId, {
      missing: "Card to duplicate does not exist.",
      busy: "Cannot duplicate a card while it is being processed.",
    });

    const duplicateSourcePath = await copyIntoWorking(
      source.sourceFilePath,
      paths.workingDir,
      basename(source.sourceFilePath),
    );
    const duplicate = createDuplicatedCard(source, duplicateSourcePath);
    state.cards = [...state.cards, duplicate].sort((left, right) =>
      left.timestamps.effectiveUtc - right.timestamps.effectiveUtc,
    );

    await this.persistState();
    await this.persistSelectedCard(duplicate.id);
    await this.runtime.logger.info("card.duplicate", "Duplicated card for independent trimming.", {
      sourceCardId: source.id,
      duplicateCardId: duplicate.id,
      duplicateSourcePath,
    });

    return this.getSnapshot();
  }

  updateCardTrim(cardId: string, trim: CardTrim): Promise<AppSnapshot> {
    return this.runStateChange(() => this.analyzeAndApplyCardTrim(cardId, trim));
  }

  private async analyzeAndApplyCardTrim(cardId: string, trim: CardTrim): Promise<AppSnapshot> {
    this.ensureReady();
    const card = this.requireCard(cardId, "Card to update does not exist.");
    // Not requireIdleCard: a trim still analyzing is superseded by this one
    // rather than refusing it.
    if (isCardBusy(card)) {
      throw new OperationError("Cannot change trim markers while this card is being processed.");
    }
    const normalizedTrim = normalizeTrim(trim, card.durationSec);

    // The trim the card already holds changes nothing: no analysis, no new
    // updatedAtUtc, no write. Dropping the card's entry still supersedes a
    // different trim that is analyzing, since this one is the user's latest.
    if (sameTrim(normalizedTrim, card.trim)) {
      this.trimRequests.delete(cardId);
      return this.getSnapshot();
    }

    const request = ++this.lastTrimRequest;
    const editedAtUtc = Date.now();
    this.trimRequests.set(cardId, request);
    try {
      const trimDecision = await analyzeTrimDecision(
        card.sourceFilePath,
        normalizedTrim,
        card.durationSec,
      );
      if (this.trimRequests.get(cardId) !== request) {
        return this.getSnapshot();
      }
      await this.applyCardTrim(card, normalizedTrim, trimDecision, editedAtUtc);
    } finally {
      if (this.trimRequests.get(cardId) === request) {
        this.trimRequests.delete(cardId);
      }
    }
    return this.getSnapshot();
  }

  private async applyCardTrim(
    card: MumblerCard,
    normalizedTrim: CardTrim,
    trimDecision: TrimDecision,
    editedAtUtc: number,
  ): Promise<void> {
    const state = this.runtime.state!;
    const cardId = card.id;
    // The AI results are kept: a trim usually shaves silence and leaves the
    // words as they were. They read as stale while the trim differs from the
    // one they were transcribed from (hasStaleResults), and Generate replaces
    // them. Status and last error stay as they are for the same reason.
    card.trim = normalizedTrim;
    card.trimDecision = trimDecision;
    card.timestamps = applyFrontTrimOffset(card.timestamps, normalizedTrim.frontMarkerSec ?? 0);
    card.updatedAtUtc = editedAtUtc;

    state.cards.sort((left, right) =>
      left.timestamps.effectiveUtc - right.timestamps.effectiveUtc,
    );

    await this.persistState();
    await this.runtime.logger.info("trim.analyze", "Analyzed trim decision.", {
      cardId,
      sourceFilePath: card.sourceFilePath,
      codec: card.audioProfile?.codecName,
      container: card.audioProfile?.formatName,
      durationSec: card.durationSec,
      requestedStartSec: trimDecision.requestedStartSec,
      requestedEndSec: trimDecision.requestedEndSec,
      searchStartFromSec: trimDecision.searchStartFromSec,
      searchStartToSec: trimDecision.searchStartToSec,
      searchEndFromSec: trimDecision.searchEndFromSec,
      searchEndToSec: trimDecision.searchEndToSec,
      chosenStartBoundarySec: trimDecision.chosenStartBoundarySec,
      chosenEndBoundarySec: trimDecision.chosenEndBoundarySec,
      startDeltaSec: trimDecision.startDeltaSec,
      endDeltaSec: trimDecision.endDeltaSec,
      decision: trimDecision.kind,
      reason: trimDecision.reason,
    });
  }

  async getCardMediaSource(cardId: string): Promise<string> {
    this.ensureReady();
    this.requireCard(cardId, "Card media source no longer exists.");

    await this.runtime.logger.debug("card.media-source", "Resolved card media source URL.", {
      cardId,
    });
    return `mumbler-asset://media/${encodeURIComponent(cardId)}`;
  }

  resolveCardSourcePath(cardId: string): string | null {
    if (this.runtime.state === null) {
      return null;
    }
    const card = this.runtime.state.cards.find((entry) => entry.id === cardId);
    return card?.sourceFilePath ?? null;
  }

  generateCardStep(cardId: string, target: GenerateTarget): Promise<AppSnapshot> {
    return this.runStateChange(() => this.generateCardFromStep(cardId, target));
  }

  private async generateCardFromStep(cardId: string, target: GenerateTarget): Promise<AppSnapshot> {
    const quitAttempt = this.quitAttempt;
    this.ensureReady();
    this.requireCard(cardId, "Card to generate does not exist.");

    // The key is resolved before the card is checked, so nothing awaits between
    // the idle check and startOrEnqueue claiming the card.
    if ((await this.resolveGeminiApiKey()) === null) {
      throw new OperationError("Gemini API key is not configured.");
    }

    this.ensureAcceptingWork();
    if (quitAttempt !== this.quitAttempt) {
      throw new OperationError("Processing was stopped while Mumbler was closing.");
    }
    const card = this.requireIdleCard(cardId, {
      missing: "Card to generate does not exist.",
      busy: "This card is already being processed.",
    });
    this.pipeline.assertCardCanStart(card);

    const startStep = resolveGenerateStartStep(card, target);
    if (clearCardResultsFromStep(card, startStep)) {
      card.updatedAtUtc = Date.now();
    }
    card.status = "Imported";
    card.activeStep = null;
    card.queuedMode = null;
    card.queuedAtUtc = null;
    card.lastError = null;
    await this.pipeline.startOrEnqueue(cardId, "generate", startStep);
    await this.runtime.logger.info("pipeline.generate", "Started dependency-aware generation.", {
      cardId,
      requestedStep: target,
      startStep,
    });
    return this.getSnapshot();
  }

  async cancelCardProcessing(cardId: string): Promise<AppSnapshot> {
    this.ensureReady();
    const state = this.runtime.state!;
    const cardIndex = state.cards.findIndex((entry) => entry.id === cardId);

    if (cardIndex === -1) {
      throw new OperationError("Card to cancel does not exist.");
    }

    const oldCard = state.cards[cardIndex];
    const isQueued = oldCard.status === "Queued";
    const isActive = this.pipeline.hasRun(cardId);

    if (!isQueued && !isActive) {
      throw new OperationError("This card is not being processed.");
    }

    const failedStep = oldCard.activeStep ?? "transcription";

    // Immediately replace the card with a cancelled copy.
    // The orphaned pipeline still holds a reference to the old card object,
    // so any further writes it makes are invisible to the live state.
    state.cards[cardIndex] = {
      ...oldCard,
      status: "Cancelled",
      activeStep: null,
      queuedMode: null,
      queuedAtUtc: null,
      lastError: {
        message: "AI work cancelled by user.",
        occurredAtUtc: Date.now(),
        failedStep,
      },
    };

    // Detach the run so its later unwind can't touch a replacement's bookkeeping,
    // then abort it and free its slot even when saving the cancelled card fails,
    // so the user can generate again at once.
    const detached = this.pipeline.detachRun(cardId);

    try {
      await this.persistState();
    } finally {
      await detached?.abortAndRelease();
    }

    await this.runtime.logger.info("pipeline.cancel-immediate", "Immediately detached and cancelled card pipeline.", {
      cardId,
      failedStep,
    });
    return this.getSnapshot();
  }

  async pickOutputDirectory(window: BrowserWindow): Promise<string | null> {
    this.ensureReady();

    const result = await dialog.showOpenDialog(window, {
      title: this.translator().t("dialog.chooseOutputFolder"),
      properties: ["openDirectory", "createDirectory"],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0] ?? null;
  }

  async openOutputDirectory(): Promise<void> {
    this.ensureReady();

    const configured = this.runtime.settings!.outputDirectory?.trim() ?? "";
    const targetDir = configured.length > 0 ? configured : this.runtime.paths!.outputDir;
    await mkdir(targetDir, { recursive: true });

    const errorMessage = await shell.openPath(targetDir);
    if (errorMessage.length > 0) {
      throw new Error(errorMessage);
    }

    await this.runtime.logger.info("output.open-directory", "Opened output directory.", {
      targetDir,
    });
  }

  /** The saved language, or System when settings could not be loaded. */
  languagePreference(): LanguagePreference {
    return this.runtime.settings?.language ?? "system";
  }

  /** The language the main process and the renderer both speak. */
  interfaceLanguage(): InterfaceLanguage {
    return resolveInterfaceLanguage(this.languagePreference());
  }

  /** The translator for text the main process draws: dialogs, menus, the startup window. */
  translator(): Translator {
    return mainTranslator(this.languagePreference());
  }

  /** Hands the saved language to AppKit for its own menu items, from the next launch. */
  alignAppKit(): void {
    alignAppKit(this.languagePreference(), (error) => {
      void this.runtime.logger.warn("language.appkit", "The interface language could not be handed to AppKit.", {
        error: serializeError(error),
      });
    });
  }

  // Hands a changed language preference to AppKit and rebuilds what speaks the
  // interface language once the language itself changed.
  private followLanguageChange(previousPreference: LanguagePreference, previousLanguage: string): void {
    if (this.languagePreference() !== previousPreference) {
      this.alignAppKit();
    }
    if (this.interfaceLanguage().language !== previousLanguage) {
      this.onLanguageChangedCallback?.();
    }
  }

  onLanguageChanged(callback: () => void): void {
    this.onLanguageChangedCallback = callback;
  }

  /** The saved theme, or System when settings could not be loaded. */
  themePreference(): ThemePreference {
    return this.runtime.settings?.theme ?? "system";
  }

  saveSettingsDraft(draft: SettingsDraft): Promise<AppSnapshot> {
    return this.runStateChange(() => this.persistSettingsDraft(draft));
  }

  private async persistSettingsDraft(draft: SettingsDraft): Promise<AppSnapshot> {
    this.ensureReady();

    const previousPreference = this.languagePreference();
    const previousLanguage = this.interfaceLanguage().language;
    const nextSettings = applySettingsDraft(this.runtime.settings!, draft);
    await loadInterfaceCatalogue(nextSettings.language);
    await this.runtime.settingsStore!.save(nextSettings);
    this.runtime.settings = nextSettings;
    applyThemePreference(nextSettings.theme);
    this.followLanguageChange(previousPreference, previousLanguage);
    await this.runtime.logger.info("settings.save", "Updated application settings.", {
      outputDirectory: nextSettings.outputDirectory,
      backupDirectory: nextSettings.backupDirectory,
      transcriptionModel: nextSettings["gemini.transcription"],
      metadataModel: nextSettings["gemini.metadata"],
      defaultTimezone: nextSettings.defaultTimezone,
      timestampPattern: nextSettings.timestampPattern,
      previewSnippetSeconds: nextSettings.previewSnippetSeconds,
      concurrencyLimit: nextSettings.concurrencyLimit,
    });

    await this.pipeline.drainQueued();

    return this.getSnapshot();
  }

  // Store a new Gemini API key in the dedicated 0600 secrets file (never the
  // settings store), refresh the cached presence flag, then admit any queued
  // cards that were waiting only on a missing key. The raw key never enters the
  // snapshot or the log — only the resulting presence boolean is reported.
  setGeminiApiKey(apiKey: string): Promise<AppSnapshot> {
    return this.runStateChange(() => this.storeGeminiApiKey(apiKey));
  }

  private async storeGeminiApiKey(apiKey: string): Promise<AppSnapshot> {
    this.ensureReady();
    const trimmed = apiKey.trim();
    if (trimmed.length === 0) {
      throw new OperationError("Enter a Gemini API key.");
    }

    await writeApiKey(this.runtime.paths!.apiKeysPath, "gemini", trimmed, this.apiKeyWarn());
    await this.refreshHasGeminiApiKey();
    await this.runtime.logger.info("settings.api-key-set", "Stored Gemini API key.", {
      hasGeminiApiKey: this.runtime.hasGeminiApiKey,
    });

    await this.pipeline.drainQueued();
    return this.getSnapshot();
  }

  // Remove the stored key from the secrets file. An environment-supplied key, if
  // present, still resolves afterward — so hasGeminiApiKey may remain true.
  clearGeminiApiKey(): Promise<AppSnapshot> {
    return this.runStateChange(() => this.removeGeminiApiKey());
  }

  private async removeGeminiApiKey(): Promise<AppSnapshot> {
    this.ensureReady();
    await clearApiKey(this.runtime.paths!.apiKeysPath, "gemini", this.apiKeyWarn());
    await this.refreshHasGeminiApiKey();
    await this.runtime.logger.info("settings.api-key-clear", "Cleared stored Gemini API key.", {
      hasGeminiApiKey: this.runtime.hasGeminiApiKey,
    });
    return this.getSnapshot();
  }

  // Resolve the effective Gemini key, environment-first then the secrets file, or
  // null when neither is set. Single chokepoint used by the pipeline guards and
  // by spawnCardPipeline; nothing else reads the secret.
  private async resolveGeminiApiKey(): Promise<string | null> {
    return resolveApiKey(this.runtime.paths!.apiKeysPath, "gemini", this.apiKeyWarn());
  }

  private async refreshHasGeminiApiKey(): Promise<void> {
    this.runtime.hasGeminiApiKey = await hasApiKey(
      this.runtime.paths!.apiKeysPath,
      "gemini",
      this.apiKeyWarn(),
    );
  }

  private apiKeyWarn(): (message: string, details: Record<string, unknown>) => void {
    return makeApiKeyWarn(this.runtime.logger);
  }

  async drainQueuedCards(): Promise<void> {
    await this.pipeline.drainQueued();
  }

  // The quit's save (unsaved-edits conventions, Quitting). Stops new pipelines
  // and saves, aborts in-flight ones and lets them unwind (a cancelled save
  // rolls back and leaves its card Ready to Save; a cancelled run leaves its
  // card Cancelled), drains the store write-queues, then writes the user's own
  // work that is not on disk: the queue and the transcripts from what the app
  // holds, and a settings write that failed during the quit. Returns what could
  // not be saved; a call while one runs shares it.
  saveForQuit(): Promise<QuitSaveFailure[]> {
    if (this.quitSave !== null) return this.quitSave;
    const attempt = ++this.quitAttempt;
    const save = this.runQuitSave(attempt).finally(() => {
      if (this.quitSave === save) this.quitSave = null;
    });
    this.quitSave = save;
    return save;
  }

  private async runQuitSave(attemptId: number): Promise<QuitSaveFailure[]> {
    const { queueStore, transcriptStore, settingsStore, logger } = this.runtime;
    if (this.settingsFailureBeforeQuit === undefined) {
      this.settingsFailureBeforeQuit = settingsStore?.failedWrite ?? null;
    }
    this.closing = true;
    for (const controller of this.activeSaves.keys()) {
      controller.abort();
    }
    await Promise.all([
      Promise.allSettled([...this.activeSaves.values()]),
      this.pipeline.shutdown(),
      this.importTail,
      Promise.allSettled([...this.activeStateChanges]),
    ]);
    if (attemptId !== this.quitAttempt) return [];
    await this.persistenceTail;
    await queueStore?.flush();
    await transcriptStore?.flush();
    await settingsStore?.flush();
    if (attemptId !== this.quitAttempt) return [];

    const failures: QuitSaveFailure[] = [];
    const attempt = async (store: QuitSaveFailure, write: () => Promise<unknown>): Promise<boolean> => {
      try {
        await write();
        return true;
      } catch (error: unknown) {
        failures.push(store);
        void logger.error("quit.save-failed", "Could not save before quitting.", error, { store }).catch(() => undefined);
        return false;
      }
    };
    const retrySettings = async (): Promise<void> => {
      if (attemptId !== this.quitAttempt) return;
      const settingsFailure = settingsStore?.failedWrite ?? null;
      if (settingsStore && settingsFailure !== null && settingsFailure !== this.settingsFailureBeforeQuit) {
        await attempt("settings", () => settingsStore.retryFailedWrite());
      }
    };
    const state = this.runtime.state;
    if (state !== null && queueStore !== null && transcriptStore !== null) {
      const snapshot = structuredClone(state);
      const request = ++this.persistenceRequest;
      const saveQueue = this.queueBehind;
      await this.enqueuePersistence(async () => {
        if (attemptId !== this.quitAttempt) return;
        const transcriptsSaved = await attempt("transcripts", () => transcriptStore.writeChanged(snapshot.cards));
        if (transcriptsSaved && saveQueue) {
          await attempt("queue", () => queueStore.save(snapshot));
        }
        const packetSaved = failures.length === 0;
        this.queueBehind = !packetSaved || request !== this.persistenceRequest;
        await retrySettings();
        if (packetSaved && attemptId === this.quitAttempt) {
          // Cleanup of removed cards' files, not the user's work: logged only.
          await transcriptStore.removeAbsent(snapshot.cards).catch((error: unknown) => {
            void logger.warn("quit.transcript-cleanup-failed", "Could not delete a removed card's text file.", {
              error: serializeError(error),
            }).catch(() => undefined);
          });
        }
      });
    } else await retrySettings();
    if (attemptId !== this.quitAttempt) return failures;
    await this.runtime.layoutStore?.flush();
    return failures;
  }

  // The user cancelled the quit: the app takes work again. Runs a quit stopped
  // stay Cancelled, for the user to start again.
  async resumeAfterCancelledQuit(): Promise<void> {
    // Already admitted producers and physical writes remain owned, but a later
    // quit gets its own drain and a cancelled pass cannot publish a final snapshot.
    this.quitAttempt += 1;
    this.quitSave = null;
    this.closing = false;
    this.settingsFailureBeforeQuit = undefined;
    await this.pipeline.resume();
    void this.runtime.logger.info("quit.cancelled", "Quit cancelled; Mumbler keeps running.").catch(() => undefined);
  }

  // The quit's last step, after its save: closes the backup history and the
  // records, which log their own failures. Called once; later calls share it.
  closeForQuit(details: Record<string, unknown> = {}): Promise<void> {
    this.closePromise ??= (async () => {
      await closeBackupStore();
      void this.runtime.logger.info("app.shutdown", "Shutdown complete.", {
        ...details,
        cardCount: this.runtime.state?.cards.length ?? 0,
      }).catch(() => undefined);
      await this.runtime.logger.close();
    })();
    return this.closePromise;
  }

  // Saves, logging what could not be saved, and closes; for a caller that
  // cannot ask the user, such as tests.
  async shutdown(): Promise<void> {
    const unsaved = await this.saveForQuit();
    await this.closeForQuit({ unsaved });
  }

  chooseOutputDirectory(window: BrowserWindow): Promise<AppSnapshot> {
    return this.runStateChange(() => this.pickAndSaveOutputDirectory(window));
  }

  private async pickAndSaveOutputDirectory(window: BrowserWindow): Promise<AppSnapshot> {
    const outputDirectory = await this.pickOutputDirectory(window);
    if (outputDirectory === null) {
      return this.getSnapshot();
    }

    const nextSettings = { ...this.runtime.settings!, outputDirectory };
    await this.runtime.settingsStore!.save(nextSettings);
    this.runtime.settings = nextSettings;

    await this.runtime.logger.info("settings.output-directory", "Updated output directory.", {
      outputDirectory: this.runtime.settings!.outputDirectory,
    });
    return this.getSnapshot();
  }

  async saveCard(
    cardId: string,
    resolution?: SaveConflictResolution,
  ): Promise<SaveCardResult> {
    this.ensureReady();
    const card = this.requireCard(cardId, "Card to save does not exist.");

    if (card.status !== "Ready to Save") {
      throw new OperationError("Only cards in Ready to Save state can be finalized.");
    }
    if (this.closing) {
      throw new OperationError("Mumbler is closing; the recording was not saved.");
    }
    if (this.trimRequests.has(cardId)) {
      throw new OperationError("The trim markers are still being applied. Save again in a moment.");
    }

    // Claim the card before the first await: "Saving" is busy, so no generation,
    // trim, removal or second save can start while this one reads the card and
    // then deletes its working audio. Any outcome other than a completed save
    // hands the card back as Ready to Save.
    card.status = "Saving";
    const controller = new AbortController();
    const run = this.runSave(card, resolution, controller.signal);
    this.activeSaves.set(controller, run);
    try {
      const outcome = await run;
      return { ...outcome, snapshot: this.getSnapshot() };
    } finally {
      this.activeSaves.delete(controller);
    }
  }

  private async runSave(
    card: MumblerCard,
    resolution: SaveConflictResolution | undefined,
    signal: AbortSignal,
  ): Promise<SaveOutcome> {
    let outcome: SaveOutcome | null = null;
    try {
      await this.persistState();
      outcome = await this.writeCardOutputs(card, resolution, signal);
    } finally {
      if (outcome?.kind !== "saved") {
        card.status = "Ready to Save";
        await this.persistState().catch((error: unknown) =>
          this.runtime.logger.error("card.save-settlement-failed", "Could not persist the recording's ready state after saving stopped.", error, {
            cardId: card.id,
          }).catch(() => undefined));
      }
    }
    // Publication is the commit point: once the files are out, the save has
    // succeeded, and removing the card from the queue is cleanup that reports
    // its own failure to the log rather than turning the save into a failure.
    if (outcome.kind === "saved") {
      await this.discardWorkingCard(card);
    }
    return outcome;
  }

  private async writeCardOutputs(
    card: MumblerCard,
    resolution: SaveConflictResolution | undefined,
    signal: AbortSignal,
  ): Promise<SaveOutcome> {
    const cardId = card.id;
    const settings = this.runtime.settings!;
    const logger = this.runtime.logger;

    const configuredOutputDirectory = settings.outputDirectory?.trim() ?? "";
    const outputDirectory =
      configuredOutputDirectory.length > 0
        ? configuredOutputDirectory
        : this.runtime.paths!.outputDir;
    await mkdir(outputDirectory, { recursive: true });

    const finalAudio = await prepareAudioForTranscription({
      sourceFilePath: card.sourceFilePath,
      workingDir: this.runtime.paths!.workingDir,
      trim: card.trim,
      trimDecision: card.trimDecision,
      durationSec: card.durationSec,
      audioProfile: card.audioProfile,
      logger,
      signal,
    });

    let committed: Extract<SaveOutcome, { kind: "saved" }> | null = null;
    try {
      const extension = extname(finalAudio.filePath) || extname(card.sourceFilePath);
      const baseName = `${formatUtcMarker(new Date(card.timestamps.effectiveUtc))}-${card.metadata.slug}`;
      const initialTargets: SaveTargetPaths = {
        audioPath: join(outputDirectory, `${baseName}${extension}`),
        jsonPath: join(outputDirectory, `${baseName}.json`),
        markdownPath: join(outputDirectory, `${baseName}.md`),
      };

      const conflictExists = await pathsConflict(initialTargets);
      if (conflictExists && resolution === undefined) {
        await logger.info("save.conflict", "Output path conflict detected, awaiting resolution.", {
          cardId,
          audioPath: initialTargets.audioPath,
          jsonPath: initialTargets.jsonPath,
          markdownPath: initialTargets.markdownPath,
        });
        return { kind: "conflict", ...initialTargets };
      }

      if (resolution === "cancel") {
        await logger.info("save.cancelled", "Save cancelled by user.", { cardId });
        return { kind: "cancelled" };
      }

      const targetPaths: SaveTargetPaths =
        resolution === "suffix"
          ? await buildUniqueSuffixedTargets(outputDirectory, baseName, extension)
          : initialTargets;

      const finalProfile = await probeAudioProfile(finalAudio.filePath, signal);
      const finalDurationSec = computeFinalDuration(card, finalProfile.durationSec);
      await logger.debug("audio.probe-final", "Probed final audio profile before save.", {
        cardId,
        finalDurationSec,
        formatName: finalProfile.audioProfile?.formatName,
        codecName: finalProfile.audioProfile?.codecName,
        bitRateKbps: finalProfile.audioProfile?.bitRateKbps,
        sampleRateHz: finalProfile.audioProfile?.sampleRateHz,
        channels: finalProfile.audioProfile?.channels,
      });
      const finalizedAtUtc = Date.now();
      const outputPayload = buildOutputPayload({
        card,
        finalProfile: finalProfile.audioProfile,
        finalDurationSec,
        finalizedAtUtc,
      });
      const markdownContent = buildMarkdownContent({
        card,
        audioFilename: basename(targetPaths.audioPath),
        finalDurationSec,
      });

      let warnings: Message[] = [];
      try {
        const result = await finalizeOutputs({
          sourceAudioPath: finalAudio.filePath,
          targets: targetPaths,
          overwrite: resolution === "overwrite",
          jsonContent: `${JSON.stringify(outputPayload, null, 2)}\n`,
          markdownContent,
          signal,
          isSafeLocation: () => this.isSafeSaveLocation(targetPaths, finalAudio.filePath),
        });
        if (result.warnings.length > 0) {
          await logger.warn("save.cleanup-failed", "Outputs committed but staging cleanup failed.", {
            cardId, issues: result.warnings.map((issue) => ({ ...issue, error: serializeError(issue.error) })),
          });
          warnings = [message("notice.saveCleanupFailed", { folder: outputDirectory })];
        }
      } catch (error: unknown) {
        if (error instanceof OutputLocationError) return { kind: "failed", message: message("error.saveOutputLocationUnsafe") };
        if (error instanceof OutputPartialFailureError || error instanceof NewerFormatError) {
          await logger.error("save.incomplete", "Output save refused or did not finish every output.", error, {
            cardId,
            issues: error instanceof OutputPartialFailureError
              ? error.issues.map((issue) => ({ ...issue, error: serializeError(issue.error) })) : undefined,
          });
          if (error instanceof NewerFormatError) return {
            kind: "failed", message: message("error.saveNewerOutput", { folder: outputDirectory }),
          };
          const savedPaths = error.files.filter((file) => file.status === "saved").map((file) => basename(file.path));
          return { kind: "failed", files: error.files, message: savedPaths.length > 0
            ? message("error.saveIncomplete", { folder: outputDirectory, files: savedPaths.join(", ") })
            : message("error.saveFailed", { folder: outputDirectory }) };
        }
        if (!(error instanceof OutputConflictError)) {
          throw error;
        }
        await logger.info("save.conflict", "Output appeared while saving; nothing was replaced.", {
          cardId,
          takenPath: error.targetPath,
        });
        return { kind: "conflict", ...targetPaths };
      }

      await logger.info("save.completed", "Saved finalized audio and metadata.", {
        cardId,
        audioTargetPath: targetPaths.audioPath,
        jsonTargetPath: targetPaths.jsonPath,
        markdownTargetPath: targetPaths.markdownPath,
        overwrite: resolution === "overwrite",
      });

      committed = { kind: "saved", ...targetPaths, warnings };
      return committed;
    } finally {
      try { await finalAudio.cleanup(); }
      catch (error) {
        await logger.warn("save.prepared-audio-cleanup-failed", "Could not clean up prepared save audio.", {
          cardId, error: serializeError(error),
        });
        committed?.warnings?.push(message("notice.saveCleanupFailed", { folder: this.runtime.paths!.workingDir }));
      }
    }
  }

  // These are actual deletion owners: card/import disposal removes input paths,
  // and startup cleans working/derived and temp. Resolve directory aliases and existing
  // hard links once; private staging needs no identity/rollback machinery.
  private async isSafeSaveLocation(targets: SaveTargetPaths, preparedAudioPath: string): Promise<boolean> {
    const working = await realpath(this.runtime.paths!.workingDir);
    const derivedPath = join(working, "derived");
    const output = await realpath(dirname(targets.audioPath));
    for (const disposablePath of [derivedPath, this.runtime.paths!.tempDir]) {
      const disposable = await realpath(disposablePath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return disposablePath;
        throw error;
      });
      const withinDisposable = relative(disposable, output);
      if (withinDisposable === "" || (withinDisposable !== ".." && !withinDisposable.startsWith(`..${sep}`) && !isAbsolute(withinDisposable))) return false;
    }
    const state = this.runtime.state!;
    const sources = new Set([
      preparedAudioPath,
      ...state.cards.map((card) => card.sourceFilePath),
      ...state.pendingImports.flatMap((item) => [item.workingFilePath, item.originalSourcePath]),
    ]);
    const sourceInfo = await Promise.all([...sources].map(async (path) => {
      try { return { path: await realpath(path), info: await stat(path) }; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }));
    for (const target of Object.values(targets)) {
      const canonical = join(output, basename(target));
      let targetInfo: Awaited<ReturnType<typeof stat>> | null = null;
      try { targetInfo = await stat(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      for (const source of sourceInfo) {
        if (source !== null && (canonical === source.path || (targetInfo !== null &&
            targetInfo.dev === source.info.dev && targetInfo.ino === source.info.ino))) return false;
      }
    }
    return true;
  }

  removeCard(cardId: string): Promise<AppSnapshot> {
    return this.runStateChange(() => this.removeCardWorkingAudio(cardId));
  }

  private async removeCardWorkingAudio(cardId: string): Promise<AppSnapshot> {
    this.ensureReady();
    const state = this.runtime.state!;
    // requireIdleCard also refuses a "Queued" card: its working audio is one
    // drain pass away from a pipeline reading it, so removal must wait until
    // the card is cancelled or finishes.
    const card = this.requireIdleCard(cardId, {
      missing: "Card to remove does not exist.",
      busy: "Cannot remove a card while it is being processed.",
    });
    // Out of the queue before the first await, so no save or trim can claim the
    // card while its audio is being deleted.
    state.cards = state.cards.filter((entry) => entry.id !== cardId);

    // The card's audio is deleted here and nowhere later: startup never sweeps
    // a recording, so audio that cannot be deleted keeps its card in the queue.
    try {
      await rm(card.sourceFilePath, { force: true });
    } catch (error: unknown) {
      state.cards = [...state.cards, card].sort((left, right) =>
        left.timestamps.effectiveUtc - right.timestamps.effectiveUtc,
      );
      // A save made while the deletion ran left the card out of queue.json.
      await this.persistState();
      throw new Error(`Failed to delete the working audio of card ${cardId}: ${formatError(error)}`, { cause: error });
    }
    await this.runtime.logger.info("card.remove", "Deleted card working audio and removed card.", {
      cardId,
      sourceFilePath: card.sourceFilePath,
    });

    // The card's text file goes with it, once queue.json no longer refers to it.
    await this.persistState();
    return this.getSnapshot();
  }

  private async importPaths(
    sourcePaths: string[],
    importSource: ImportSource,
  ): Promise<ImportOperationResult> {
    return this.runImportExclusive(() => this.importPathsExclusive(sourcePaths, importSource));
  }

  // Runs one import-boundary operation after every earlier one has settled.
  private runImportExclusive<T>(operation: () => Promise<T>): Promise<T> {
    try { this.ensureAcceptingWork(); } catch (error: unknown) { return Promise.reject(error); }
    const run = this.importTail.then(operation);
    this.importTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private runStateChange(operation: () => Promise<AppSnapshot>): Promise<AppSnapshot> {
    try { this.ensureAcceptingWork(); } catch (error: unknown) { return Promise.reject(error); }
    const run = operation();
    this.activeStateChanges.add(run);
    void run.then(
      () => this.activeStateChanges.delete(run),
      () => this.activeStateChanges.delete(run),
    );
    return run;
  }

  private ensureAcceptingWork(): void {
    this.ensureReady();
    if (this.closing) throw new OperationError("Mumbler is closing; new work cannot start.");
  }

  private async importPathsExclusive(
    sourcePaths: string[],
    importSource: ImportSource,
  ): Promise<ImportOperationResult> {
    this.ensureReady();
    const failedImports: FailedImport[] = [];
    const attemptedPaths = [...sourcePaths];
    const duplicateImports: string[] = [];
    const seenPaths = new Set<string>();
    let importedCount = 0;

    for (const sourcePath of sourcePaths) {
      if (sourcePath.trim().length === 0) {
        failedImports.push({
          sourcePath: "",
          message: message("import.noLocalPath"),
          kind: "invalid",
        });
        continue;
      }
      if (seenPaths.has(sourcePath)) {
        duplicateImports.push(sourcePath);
        continue;
      }
      seenPaths.add(sourcePath);
      try {
        await this.importSinglePath(sourcePath, importSource);
        importedCount += 1;
      } catch (error: unknown) {
        const kind = error instanceof ImportAdmissionError ? "invalid" : "failure";
        failedImports.push({
          sourcePath,
          message: error instanceof ImportAdmissionError
            ? message(error.reason)
            : message("import.failed"),
          kind,
        });
        if (kind === "invalid") {
          await this.runtime.logger.warn("import.rejected", "Source did not meet audio import requirements.", {
            sourcePath,
            importSource,
            reason: error instanceof Error ? error.message : String(error),
          });
        } else {
          await this.runtime.logger.error(
            "import.failed",
            "Failed to import source file.",
            error,
            { sourcePath, importSource },
          );
        }
      }
    }

    if (importedCount > 0) {
      await this.persistState();
      await this.runtime.logger.info("import.completed", "Imported files into pending review.", {
        importedCount,
        failedCount: failedImports.length,
        duplicateCount: duplicateImports.length,
        importSource,
      });
    }

    return {
      snapshot: this.getSnapshot(),
      attemptedPaths,
      importedCount,
      failedImports,
      duplicateImports,
    };
  }

  private async importSinglePath(sourcePath: string, importSource: ImportSource): Promise<void> {
    const paths = this.runtime.paths!;
    const settings = this.runtime.settings!;
    if (!isSupportedAudioImportName(sourcePath)) {
      throw new ImportAdmissionError("import.unsupportedType");
    }
    const sourceStats = await stat(sourcePath);

    if (!sourceStats.isFile()) {
      throw new ImportAdmissionError("import.notAFile");
    }

    const originalFilename = basename(sourcePath);
    const workingFilePath = await copyIntoWorking(sourcePath, paths.workingDir, originalFilename);

    await this.runtime.logger.debug("import.file", "Staged file to working storage.", {
      originalFilename,
      fileSizeBytes: sourceStats.size,
      importSource,
    });

    const filenameStem = basename(originalFilename, extname(originalFilename));
    const parsed = parseTimestampFromFilename(filenameStem, settings.timestampPattern);
    // The zone the filename's local time is read in. Each card keeps its own zone
    // from here on, so a later change of the setting (or of the computer's zone,
    // under System) never re-dates a recording already imported.
    const importTimezone = resolveTimezone(settings.defaultTimezone);
    const utcResult =
      parsed.localTimestampText.length > 0
        ? recomputeUtcFromLocal(parsed.localTimestampText, importTimezone)
        : { utcMs: null, error: null };

    const pendingImport: PendingImportReviewItem = {
      id: nanoid(),
      originalFilename,
      importSource,
      originalSourcePath: sourcePath,
      workingFilePath,
      fileSizeBytes: sourceStats.size,
      localTimestampText: parsed.localTimestampText,
      timezone: importTimezone,
      utcTimestampText: utcResult.error === null && utcResult.utcMs !== null ? formatUtcForDisplay(utcResult.utcMs) : "",
      parseStatus: parsed.parseStatus,
      deleteOriginalOnConfirm: false,
      copyToBackupOnConfirm: true,
      createdAtUtc: Date.now(),
      updatedAtUtc: Date.now(),
    };

    this.runtime.state!.pendingImports.push(pendingImport);
  }

  private ensureReady(): void {
    if (this.runtime.paths === null || this.runtime.settings === null || this.runtime.state === null) {
      throw new OperationError("Application runtime is not ready.");
    }
  }

  private requireCard(cardId: string, missingMessage: string): MumblerCard {
    const card = this.runtime.state!.cards.find((entry) => entry.id === cardId);
    if (card === undefined) {
      throw new OperationError(missingMessage);
    }
    return card;
  }

  // The busy guard is structural: every mutation that must not race a queued or
  // running pipeline resolves its card through here, so no call site re-spells
  // the shared isCardBusy predicate and drifts from it.
  private requireIdleCard(
    cardId: string,
    messages: { missing: string; busy: string },
  ): MumblerCard {
    const card = this.requireCard(cardId, messages.missing);
    if (isCardBusy(card) || this.trimRequests.has(cardId)) {
      throw new OperationError(messages.busy);
    }
    return card;
  }

  private enqueuePersistence(work: () => Promise<void>): Promise<void> {
    const run = this.persistenceTail.then(work);
    this.persistenceTail = run.then(() => undefined, () => undefined);
    return run;
  }

  // The live state object is never replaced here: handlers and pipelines hold
  // `this.runtime.state` (and its cards) across awaits and mutate it afterwards,
  // so swapping in a copy would detach their later writes from what is saved.
  private async persistState(): Promise<void> {
    const snapshot = structuredClone(this.runtime.state!);
    const request = ++this.persistenceRequest;
    this.queueBehind = true;
    await this.enqueuePersistence(async () => {
      try {
        await this.runtime.transcriptStore!.writeChanged(snapshot.cards);
        await this.runtime.queueStore!.save(snapshot);
      } catch (error: unknown) {
        this.queueBehind = true;
        throw error;
      }
      this.queueBehind = request !== this.persistenceRequest;
      // Error-handling-conventions: secondary failures cannot deny the queue commit.
      try {
        await this.runtime.transcriptStore!.removeAbsent(snapshot.cards);
      } catch (error: unknown) {
        await this.runtime.logger.warn("queue.cleanup-transcripts", "Queue committed, but transcript cleanup failed.", {
          error: serializeError(error),
        });
      }
    });
    const selectedCardId = selectExistingCardId(
      this.runtime.state!.cards.map((card) => card.id),
      this.runtime.layout?.selectedCardId ?? null,
    );
    if (selectedCardId !== (this.runtime.layout?.selectedCardId ?? null)) {
      try {
        await this.persistSelectedCard(selectedCardId);
      } catch (error: unknown) {
        await this.runtime.logger.warn("queue.select-card", "Queue committed, but selection was not saved.", {
          error: serializeError(error),
        });
      }
    }

    try {
      this.onPipelineProgressCallback?.();
    } catch (error: unknown) {
      await this.runtime.logger.warn("queue.progress", "Queue committed, but progress notification failed.", {
        error: serializeError(error),
      });
    }
  }

  private async persistSelectedCard(selectedCardId: string | null): Promise<void> {
    const layout: MumblerLayout = {
      ...(this.runtime.layout ?? createDefaultLayout()),
      selectedCardId,
    };
    this.runtime.layout = layout;
    await this.runtime.layoutStore?.save(layout);
  }

  private async setAppWideError(
    title: Message,
    body: Message,
    error: unknown,
    details?: unknown,
  ): Promise<void> {
    this.runtime.appWideError = {
      title,
      message: body,
    };

    await this.runtime.logger.error("app.unhandled", createTranslator("en").text(title), error, details);
  }

  // Never throws: it runs after a save has published its files.
  private async discardWorkingCard(card: MumblerCard): Promise<void> {
    this.runtime.state!.cards = this.runtime.state!.cards.filter((entry) => entry.id !== card.id);
    try {
      await rm(card.sourceFilePath, { force: true });
    } catch (error: unknown) {
      await this.runtime.logger.warn(
        "card.cleanup",
        "Saved card was removed from the queue, but working audio could not be deleted.",
        {
          cardId: card.id,
          sourceFilePath: card.sourceFilePath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }

    try {
      await this.persistState();
    } catch (error: unknown) {
      // The next successful save of the queue drops the card. If none happens,
      // startup finds its working audio gone and drops it then.
      await this.runtime.logger.error(
        "card.cleanup",
        "Saved card was removed from the queue, but the queue could not be saved.",
        error,
        { cardId: card.id },
      );
    }
  }
}

// The single storage-root resolver lives in its own electron-free module (storage-root.ts) so the pure Node
// backup store can resolve the root the same way without importing electron. Re-exported here so the
// existing callers and tests that reach it through app-runtime keep working (it is imported at the top for
// getAppPaths' own use).
export { resolveStorageRoot };

export function getAppPaths(): AppPaths {
  const homeDir = resolveStorageRoot(process.env.MUMBLER_DATA_DIR, homedir());

  return {
    homeDir,
    settingsPath: join(homeDir, "config.json"),
    queuePath: join(homeDir, "queue.json"),
    transcriptsDir: join(homeDir, "transcripts"),
    layoutPath: join(homeDir, "layout.json"),
    apiKeysPath: join(homeDir, "api-keys.json"),
    recordsPath: join(homeDir, "records.sqlite3"),
    logsDir: join(homeDir, "logs"),
    workingDir: join(homeDir, "working"),
    outputDir: join(homeDir, "output"),
    originalsDir: join(homeDir, "originals"),
    binDir: join(homeDir, "bin"),
    dependenciesPath: join(homeDir, "dependencies.json"),
    tempDir: join(homeDir, "temp"),
  };
}

function createLoggedSettingsStore(settingsPath: string, logger: AppLogger): SettingsStore {
  return createSettingsStore(settingsPath, homedir(), (key) => {
    void logger.warn("settings.invalid-set", "Invalid settings set; using the built-in.", { key });
  });
}

// Adapts the per-launch logger into the warn sink the secrets module calls when
// it tightens an insecure (group/world-readable) api-keys.json back to 0600.
function makeApiKeyWarn(
  logger: AppLogger,
): (message: string, details: Record<string, unknown>) => void {
  return (message, details) => {
    void logger.warn("api-key.insecure-mode", message, details);
  };
}

// Tightens the storage root to owner-only (0700) on POSIX, per the storage-path
// conventions: created that way, and tightened at each launch when an existing
// root is broader, because derived data and logs must never be readable by
// accounts that cannot read their sources. Windows uses its own permission
// model and is unaffected. mkdir's own `mode` is masked by umask and never
// changes an *existing* directory's mode, so this always re-checks after
// creation rather than relying on the mkdir call alone. A failure to tighten
// is logged and never stops the app.
async function secureRoot(rootDir: string, logger: AppLogger): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  try {
    const info = await stat(rootDir);
    if ((info.mode & 0o077) !== 0) {
      await chmod(rootDir, 0o700);
    }
  } catch (error: unknown) {
    await logger.warn(
      "storage.root-permissions",
      "Could not tighten the storage root to owner-only (0700).",
      { rootDir, error: error instanceof Error ? error.message : String(error) },
    );
  }
}

async function ensureDirectories(paths: AppPaths, logger: AppLogger): Promise<void> {
  await mkdir(paths.homeDir, { recursive: true, mode: 0o700 });
  await secureRoot(paths.homeDir, logger);
  await mkdir(paths.workingDir, { recursive: true });
  await mkdir(paths.binDir, { recursive: true });
  // temp/ is disposable download staging: clear it on launch so a download
  // interrupted by a crash leaves no stale partial behind, then recreate it.
  await rm(paths.tempDir, { recursive: true, force: true });
  await mkdir(paths.tempDir, { recursive: true });
}

export function buildConfirmedTimestamps(
  localTimestampText: string,
  timezone: string,
  utcTimestampText: string,
): MumblerCard["timestamps"] {
  if (!isValidTimezone(timezone)) {
    throw new OperationError(`Invalid timezone: ${timezone}`);
  }

  const localResult = recomputeUtcFromLocal(localTimestampText, timezone);
  if (localResult.error === null) {
    return {
      confirmedLocal: localTimestampText,
      confirmedUtc: localResult.utcMs!,
      timezone,
      frontTrimOffsetSec: 0,
      effectiveLocal: localTimestampText,
      effectiveUtc: localResult.utcMs!,
    };
  }

  const utcResult = recomputeLocalFromUtc(utcTimestampText, timezone);
  if (utcResult.error === null) {
    const normalizedUtc = recomputeUtcFromLocal(utcResult.localTimestampText, timezone);
    if (normalizedUtc.error !== null) {
      throw new OperationError(createTranslator("en").t(normalizedUtc.error));
    }

    return {
      confirmedLocal: utcResult.localTimestampText,
      confirmedUtc: normalizedUtc.utcMs!,
      timezone,
      frontTrimOffsetSec: 0,
      effectiveLocal: utcResult.localTimestampText,
      effectiveUtc: normalizedUtc.utcMs!,
    };
  }

  throw new OperationError("Pending import timestamps are incomplete.");
}

// The renderer's timestamp-review screen may edit only these fields. Every other
// field of a pending import — its id, the working/original file paths, filename,
// source, size, and parse status — is established by the main process at import
// time and must never be read back from a renderer-supplied payload. Taking the
// paths from the renderer would let a buggy (or hostile) renderer point the main
// process's unlink / copy / ffprobe at an arbitrary path. So we keep the
// authoritative item and overlay only the review-editable fields from the draft.
//
// updatedAtUtc moves only when the recording's time differs from the stored item
// (content-lifecycle-conventions, "Modified"); the backup and delete choices are
// flags, not content, and leave it. A draft that matches the stored item returns
// the item itself.
export function applyPendingImportDraft(
  authoritative: PendingImportReviewItem,
  draft: PendingImportReviewItem,
): PendingImportReviewItem {
  const content = {
    localTimestampText: draft.localTimestampText,
    timezone: draft.timezone,
    utcTimestampText: draft.utcTimestampText,
  };
  const flags = {
    deleteOriginalOnConfirm: draft.deleteOriginalOnConfirm,
    copyToBackupOnConfirm: draft.copyToBackupOnConfirm,
  };
  const differs = (fields: Partial<PendingImportReviewItem>): boolean =>
    (Object.keys(fields) as (keyof PendingImportReviewItem)[]).some((field) => fields[field] !== authoritative[field]);
  if (differs(content)) {
    return { ...authoritative, ...content, ...flags, updatedAtUtc: Date.now() };
  }
  return differs(flags) ? { ...authoritative, ...flags } : authoritative;
}

function createDuplicatedCard(source: MumblerCard, sourceFilePath: string): MumblerCard {
  return {
    ...source,
    id: nanoid(),
    sourceFilePath,
    trim: {
      frontMarkerSec: null,
      backMarkerSec: null,
    },
    trimDecision: null,
    transcribedTrim: null,
    timestamps: applyFrontTrimOffset(source.timestamps, 0),
    transcription: {
      text: null,
    },
    metadata: {
      structured: null,
      title: null,
      slug: null,
    },
    ai: {
      transcription: null,
      structured: null,
      title: null,
      slug: null,
    },
    status: "Imported",
    activeStep: null,
    queuedMode: null,
    queuedAtUtc: null,
    lastError: null,
    createdAtUtc: Date.now(),
    updatedAtUtc: Date.now(),
  };
}


function normalizeTrim(trim: CardTrim, durationSec: number | null): CardTrim {
  const frontMarkerSec = normalizeMarker(trim.frontMarkerSec);
  const backMarkerSec = normalizeMarker(trim.backMarkerSec);

  if (
    frontMarkerSec !== null &&
    backMarkerSec !== null &&
    frontMarkerSec >= backMarkerSec
  ) {
    throw new OperationError("Front trim must be earlier than back trim.");
  }

  if (durationSec !== null && frontMarkerSec !== null && frontMarkerSec > durationSec) {
    throw new OperationError("Front trim cannot exceed audio duration.");
  }

  if (durationSec !== null && backMarkerSec !== null && backMarkerSec > durationSec) {
    throw new OperationError("Back trim cannot exceed audio duration.");
  }

  return {
    frontMarkerSec,
    backMarkerSec,
  };
}

function normalizeMarker(value: number | null): number | null {
  if (value === null) {
    return null;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new OperationError("Trim markers must be positive numbers.");
  }

  return Math.round(value * 10) / 10;
}

export function applyFrontTrimOffset(
  timestamps: MumblerCard["timestamps"],
  frontTrimOffsetSec: number,
): MumblerCard["timestamps"] {
  // The trim moves the recorded instant exactly, and the local time is read from
  // that instant in the card's zone, so a daylight-saving change in between is
  // counted. The local time shows the trim's tenths as a suffix; file names keep
  // whole seconds.
  const effectiveUtc = timestamps.confirmedUtc + Math.round(frontTrimOffsetSec * 1000);
  const effective = recomputeLocalFromUtc(effectiveUtc, timestamps.timezone);
  if (effective.error !== null) {
    return timestamps;
  }

  return {
    ...timestamps,
    frontTrimOffsetSec,
    effectiveLocal:
      frontTrimOffsetSec % 1 === 0
        ? effective.localTimestampText
        : `${effective.localTimestampText}.${Math.round((frontTrimOffsetSec % 1) * 10)}`,
    effectiveUtc,
  };
}
