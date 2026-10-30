import { app, BrowserWindow, dialog, shell } from "electron";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";

import { nanoid } from "nanoid";
import { getAppPaths } from "./app-paths";
import { admitStorageRoot, type StorageAdmission } from "./storage-admission";
import { WaveformCache } from "./waveform-cache";

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
  type RecordingTimeCandidate,
  type RendererErrorReport,
  type SaveCardResult,
  type SaveOutputFile,
  type SaveCardOptions,
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
  computeWaveformPeaks,
  configureToolResolver,
  cleanupPreparedAudio,
  prepareAudioForTranscription,
  probeAudioProfile,
  probeRecordingTags,
  rewriteAudioTags,
  type PreparedAudioInput,
} from "./audio-tools";
import {
  carriesOnlyRecordingTime,
  isPlausibleFileTime,
  officialStartUtcMs,
  prefilledRecordingTime,
  recordingTimesFromTags,
  recordingTimeWriteArgs,
} from "./recording-times";
import { outputBaseName } from "@shared/output-name";
import { isCancelledError } from "./cancellation";
import { ToolManager } from "./binaries/manager";
import { createDefaultDependencies, createDependenciesStore, type DependenciesValue } from "./binaries/store";
import {
  parseUtcFromDisplay,
  SYSTEM_TIMEZONE,
  formatUtcMarker,
  getSystemTimezone,
  isValidTimezone,
  parseTimestampFromFilename,
  recomputeLocalFromUtc,
  recomputeUtcFromLocal,
  resolveTimezone,
} from "@shared/timestamps";
import { abandonBackupStore, closeBackupStore, setBackupStoreSession, setBackupStoreWarn } from "./backupStore";
import { NewerFormatError } from "./format-versions";
import { CorruptStateError, UnreadableStoreError, type JsonStore } from "./json-store";
import { resolveStorageRoot } from "./storage-root";
import { TranscriptStore } from "./transcript-store";
import { formatError, preserveAside } from "./file-io";
import { claimWorkingPath, copyIntoWorking, copyOriginalToBackup, deleteImportedSource, reconcileWorkingState, sourceFileIdentity } from "./working-files";
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

import { resolveSettingsDirectory, applySettingsDraft, buildSettingsDraft, createDefaultSettings, importTimezone, createEmptyQueue, createSettingsStore, createQueueStore, recoverInterruptedCards, summarizeSettings, type QueueStore, type SettingsStore } from "./settings-schema";
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
import { applyThemePreference, currentSystemTheme } from "./theme";
import { alignAppKit, loadInterfaceCatalogue, mainTranslator, resolveInterfaceLanguage } from "../i18n";
import { normalizeLanguagePreference, type InterfaceLanguage, type LanguagePreference } from "@shared/i18n/languages";
import type { RecordDetail, RecordKind, RecordSources, RecordsPage, RecordsQuery } from "@shared/records";
import { createTranslator, message, pathValue, type Message, type Translator } from "@shared/i18n/translate";
import type { MessageKey } from "@shared/i18n/catalogues";
import { clearCardResultsFromStep, resolveGenerateStartStep } from "./card-pipeline";
import { PipelineCoordinator } from "./pipeline-coordinator";


// Debug logging is developer-only: on for an unpackaged/dev build, or when an
// explicit MUMBLER_DEBUG=1 is set; off in a packaged release so the firehose
// never reaches an end-user's disk.
const DEBUG_LOGGING_ENABLED = !app.isPackaged || process.env.MUMBLER_DEBUG === "1";

function rendererReportError(report: RendererErrorReport): Error {
  // The whole chain is rebuilt, since its record keeps every level; only a
  // cause leading back to one already rebuilt stops, so a cycle cannot loop.
  const seen = new WeakSet<object>();
  const build = (diagnostic: { name?: unknown; message?: unknown; stack?: unknown; cause?: unknown }): Error => {
    if (seen.has(diagnostic)) return new Error("Renderer cause chain is circular.");
    seen.add(diagnostic);
    const cause = diagnostic.cause && typeof diagnostic.cause === "object"
      ? build(diagnostic.cause as { name?: unknown; message?: unknown; stack?: unknown; cause?: unknown })
      : undefined;
    const error = new Error(String(diagnostic.message ?? "Unknown renderer error."), cause === undefined ? undefined : { cause });
    error.name = typeof diagnostic.name === "string" ? diagnostic.name : "Error";
    if (typeof diagnostic.stack === "string") error.stack = diagnostic.stack;
    return error;
  };
  return build(report);
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

// Reset, which sets the saved work aside and starts empty, is offered only when
// damaged content in a work store stopped launch: that is the one stop it can
// clear. A file that could not be read or is from a newer Mumbler is named and
// left exactly in place, and any other failure is left for a reopen, with no
// Reset (developer decision; store-recovery-conventions).
export function startupFailureDiagnostic(error: unknown): StartupFailure {
  if (error instanceof NewerFormatError) {
    return {
      title: message("diagnostic.newerTitle"),
      message: message("diagnostic.newerBody", { path: error.filePath }),
      canReset: false,
    };
  }
  if (error instanceof UnreadableStoreError) {
    return {
      title: message("diagnostic.unreadableTitle"),
      message: message("diagnostic.unreadableBody", { path: error.filePath }),
      canReset: false,
    };
  }
  return error instanceof CorruptStateError
    ? {
        title: message("diagnostic.corruptTitle"),
        message: message("diagnostic.corruptBody", { path: error.filePath }),
        canReset: true,
      }
    : { title: message("diagnostic.startupTitle"), message: message("diagnostic.startupBody"), canReset: false };
}

// A source that is not importable, with the reason the interface shows (in the
// reader's language) and English for the log.
class ImportAdmissionError extends Error {
  constructor(readonly reason: MessageKey) {
    super(createTranslator("en").t(reason));
  }
}

// What a runtime command returns: its own result and the snapshot after it.
// The IPC boundary replies with the result alone.
export type WithSnapshot<T> = T & { snapshot: AppSnapshot };

/** The user's own work a quit could not save. */
export type QuitSaveFailure = "queue" | "transcripts" | "settings";

/** The app-owned work still running that a quit would stop. */
export interface RunningWork {
  /** Recordings being transcribed, generated or saved. */
  recordings: number;
  /** Audio tools being installed or updated. */
  tools: number;
}

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

interface SettingsCommit {
  previous: MumblerSettings;
  previousLanguage: string;
  next: MumblerSettings;
}

export class ApplicationRuntime {
  private readonly runtime: AppRuntimeState;
  private firstRun = false;
  // The runs and their places under Concurrent transcriptions live in the
  // coordinator; the runtime owns the queue those runs report to.
  private readonly pipeline: PipelineCoordinator;
  // Set while a quit saves and closes; a cancelled quit clears it again.
  private closing = false;
  private quitSave: Promise<QuitSaveFailure[]> | null = null;
  private closePromise: Promise<void> | null = null;
  // The queue's owner: every change to the cards and pending imports runs as
  // one of these commands, including its persist, after every earlier one.
  // Long work (copies, probes, analyses, runs, saves) runs outside a command
  // and reports its result through another.
  private queueTail: Promise<void> = Promise.resolve();
  private persistenceTail: Promise<void> = Promise.resolve();
  private onPipelineProgressCallback: (() => void) | null = null;
  private onLanguageChangedCallback: (() => void) | null = null;
  private onDependenciesChangedCallback: (() => void) | null = null;
  // Derive each settings intent from the last committed settings, and publish
  // its authority before another intent derives its replacement.
  private settingsTail: Promise<void> = Promise.resolve();
  // A quit can retry a rejected write. Its exact failure identity owns the
  // settings to publish if those bytes later commit and the user keeps running.
  private failedSettingsMutation: { failure: object; next: MumblerSettings } | null = null;
  // api-keys.json has one writer: setting and clearing the key take turns.
  private keyTail: Promise<void> = Promise.resolve();
  // Saves to the output folder and copies of originals into Recordings take
  // turns (developer decision); a quit aborts them through one controller.
  private exportsTail: Promise<void> = Promise.resolve();
  private exportsAbort = new AbortController();
  // Cards whose trim markers are being analyzed, each with its analysis's
  // controller. Such a card is busy for every other change (save, generate,
  // remove, duplicate); a newer trim of the same card aborts the older.
  private readonly trimAnalyses = new Map<string, AbortController>();
  // The waveform of the recording on screen; it lives while its player does.
  private waveformCache: WaveformCache | undefined;

  private constructor(runtime: AppRuntimeState) {
    this.runtime = runtime;
    this.pipeline = new PipelineCoordinator(runtime, {
      persistState: () => this.persistState(),
      resolveApiKey: () => this.resolveGeminiApiKey(),
      command: (work) => this.command(work),
    });
  }

  static async initialize(admission?: StorageAdmission): Promise<ApplicationRuntime> {
    const shellReadyAtUtc = Date.now();

    // Resolve the storage root first. An unusable MUMBLER_DATA_DIR override is a
    // startup error the convention requires us to report and STOP on, never a
    // silent fallback to the default — and it happens before any logger or store
    // exists (those derive from the very paths we could not resolve), so it
    // surfaces as a paths-less startup diagnostic rather than crashing the
    // process uncaught.
    let paths: AppPaths;
    let firstRun: boolean;
    try {
      const admitted = admission ?? await admitStorageRoot(getAppPaths());
      paths = admitted.paths;
      firstRun = admitted.firstRun;
    } catch (error: unknown) {
      // An unadmitted root must receive no diagnostics or fallback files.
      const logger = createLogger(null, { debugEnabled: DEBUG_LOGGING_ENABLED });
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
          canReset: false,
        },
        appWideError: null,
        recoveredInterruptedCards: 0,
        shellReadyAtUtc,
        toolManager: null,
        hasGeminiApiKey: false,
      });
    }

    // One logger owns this admitted launch and all its later diagnostics.
    const logger = createLogger(paths, { debugEnabled: DEBUG_LOGGING_ENABLED });

    // Point the write-through backup store's single failure log at this launch's session log. The store
    // logs only failures (a record failure or a store that could not be opened), never a line per save.
    setBackupStoreWarn((message, details) => {
      void logger.warn("backup.record", message, details);
    });
    setBackupStoreSession(logger.session);

    const settingsStore = createLoggedSettingsStore(paths.settingsPath, logger);
    const queueStore = createQueueStore(paths.queuePath);

    try {
      await ensureDirectories(paths);

      // Authored settings with damaged content are set aside and the app starts on
      // the built-ins, leaving the work stores alone (store-recovery-conventions).
      // A file that could not be read or is in a newer format halts launch below,
      // left in place; a failed set-aside propagates.
      let settingsLoad;
      let settingsNotice: AppSnapshot["appWideError"] = null;
      try {
        settingsLoad = await settingsStore.load();
      } catch (error: unknown) {
        if (!(error instanceof CorruptStateError)) throw error;
        const [quarantinedTo] = await settingsStore.preserveExistingFiles();
        await logger.warn(
          "settings.corrupt-quarantined",
          "config.json was damaged; quarantined aside and started with the built-in settings.",
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
      // Sets whose saved value this build cannot use run on their built-ins and
      // stay in the file until the user saves Settings; the user is told which.
      if (settingsLoad.unusable.length > 0) {
        settingsNotice = {
          title: message("diagnostic.settingsUnusableTitle"),
          message: message("diagnostic.settingsUnusableBody", { items: [...settingsLoad.unusable] }),
        };
      }
      let settings = settingsLoad.value;
      // The interpretation zone is the computer's at first launch, saved as that
      // concrete zone so it stays when the computer's zone changes
      // (timestamp-conventions, Time zones). A saved value this build cannot
      // use stays in the file instead, under its launch notice.
      if (settings.defaultTimezone === null && !settingsLoad.unusable.includes("defaultTimezone")) {
        settings = { ...settings, defaultTimezone: getSystemTimezone() };
        await settingsStore.save(settings).catch((error: unknown) => logger.warn(
          "settings.first-zone", "The computer's time zone could not be saved as the import zone; it is used this session.", {
            error: serializeError(error),
          },
        ));
      }
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
      const reconciliation = await reconcileWorkingState(paths, recovered.state, logger).catch((error: unknown) => {
        // Failed presence/directory reads say nothing about whether saved work
        // is missing. Name that path without treating it as damaged/resettable.
        if (error instanceof Error) {
          const failure = error as NodeJS.ErrnoException;
          if (typeof failure.path === "string" && failure.path.length > 0 &&
            typeof failure.code === "string" && failure.code.length > 0) {
            const checkedAudio = failure.syscall === "access" && (
              recovered.state.pendingImports.some((item) => item.workingFilePath === failure.path) ||
              recovered.state.cards.some((card) => card.sourceFilePath === failure.path)
            );
            const scannedDerived = failure.syscall === "scandir" && failure.path === join(paths.workingDir, "derived");
            if (checkedAudio || scannedDerived) throw new UnreadableStoreError(failure.path, { cause: error });
          }
        }
        throw error;
      });

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

      // Presentation state (disposable, volatile). No layout problem halts launch:
      // the session runs on defaults, and nothing is set aside. A missing or
      // damaged layout.json is written only once the user changes the pane width
      // or card selection, which replaces a damaged one. One that could not be
      // read or is in a newer format is left as it is and not written this session.
      let layoutStore: JsonStore<MumblerLayout> | null = createLayoutStore(paths.layoutPath);
      let layout: MumblerLayout;
      try {
        layout = (await layoutStore.load()).value;
      } catch (error: unknown) {
        layout = createDefaultLayout();
        const damaged = error instanceof CorruptStateError;
        if (!damaged) layoutStore = null;
        await logger.warn("app.layout-defaults", damaged
          ? "Layout file was damaged; using defaults until the next layout save replaces it."
          : "Layout file could not be used; using defaults and not saving it this session.", {
          layoutPath: paths.layoutPath,
          error: error instanceof Error ? error.message : String(error),
        });
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

      // Setup is owed from a first launch until it is finished or dismissed, so
      // a quit partway through brings it back rather than losing it.
      if (firstRun && !layout.setupPending) {
        layout = { ...layout, setupPending: true };
        await layoutStore?.save(layout).catch((error: unknown) => logger.warn(
          "setup.pending-save", "Could not record that first-run setup is pending; it shows this session only.", {
            error: serializeError(error),
          },
        ));
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

      runtime.firstRun = layout.setupPending;

      await runtime.initializeTools();

      await runtime.drainQueuedCards();
      // The staleness-gated launch update check runs in the background so it never
      // blocks the shell. Nothing auto-downloads — a missing required tool is
      // surfaced by the renderer opening the Audio Tools modal.
      void runtime.startToolMaintenance();
      return runtime;
    } catch (error: unknown) {
      // Root admission already succeeded; later startup failures may use it.
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

  private async initializeTools(): Promise<void> {
    const { paths, logger } = this.runtime;
    if (paths === null) throw new Error("Audio tools require resolved app paths.");
    // Managed audio tools (ffmpeg/ffprobe). The store holds their persisted
    // facts; the manager reconciles on-disk presence, drives the operations, and
    // notifies the runtime to re-emit the snapshot as state changes. The tool
    // resolver is wired so audio-tools can find the managed binaries; a missing
    // tool surfaces through the Audio Tools surface, never a hard startup failure.
    // dependencies.json is a re-derivable facts cache, so no problem with it
    // blocks launch and nothing is set aside. A damaged file starts from the
    // defaults and is replaced by the next facts save. One that could not be
    // read or is in a newer format is left as it is: this session keeps its
    // facts in memory only.
    const dependenciesFile = createDependenciesStore(paths.dependenciesPath);
    let dependenciesStore: Pick<JsonStore<DependenciesValue>, "save"> = dependenciesFile;
    let dependenciesValue: DependenciesValue;
    try {
      const loaded = await dependenciesFile.load();
      dependenciesValue = loaded.value;
      if (loaded.origin === "created") await dependenciesStore.save(dependenciesValue);
    } catch (error: unknown) {
      dependenciesValue = createDefaultDependencies();
      const damaged = error instanceof CorruptStateError;
      if (!damaged) dependenciesStore = { save: async () => undefined };
      await logger.warn("dependencies.defaults", damaged
        ? "dependencies.json was damaged; using defaults until the next facts save replaces it."
        : "dependencies.json could not be used; keeping tool facts in memory this session.", {
        path: paths.dependenciesPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const toolManager = new ToolManager({
      binDir: paths.binDir,
      tempDir: paths.tempDir,
      platform: process.platform,
      arch: process.arch,
      value: dependenciesValue,
      store: dependenciesStore,
      logger,
      notify: () => this.emitDependenciesChanged(),
    });
    await toolManager.reconcile();
    this.attachToolManager(toolManager);
    configureToolResolver((name) => toolManager.resolveToolPath(name));
  }

  onPipelineProgress(callback: () => void): void {
    this.onPipelineProgressCallback = callback;
  }

  // Setup finished or dismissed: it is not shown again, this session (reopening
  // the Mac window) or later. Only the pending marker in layout.json records it;
  // no skipped setting is written.
  async dismissFirstRunSetup(): Promise<void> {
    this.firstRun = false;
    const layout = this.runtime.layout;
    if (layout?.setupPending !== true) return;
    const next: MumblerLayout = { ...layout, setupPending: false };
    this.runtime.layout = next;
    await this.runtime.layoutStore?.save(next);
  }

  onDependenciesChanged(callback: () => void): void {
    this.onDependenciesChangedCallback = callback;
  }

  recordsMissing(): boolean {
    return this.runtime.logger.recordsMissing();
  }

  // Called for stored records and changes in missing-history health.
  onRecordsChanged(callback: (missingRecords: boolean) => void): void {
    this.runtime.logger.onRecordsChanged(callback);
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
        await manager.checkTools({ automatic: true });
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

  async saveToolSettings(checkUpdatesAtLaunch: boolean): Promise<AppSnapshot> {
    this.ensureAcceptingWork();
    await this.mutateSettings((current) => ({ ...current, checkUpdatesAtLaunch }));
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
      displayTimezone: this.runtime.settings === null ? getSystemTimezone() : resolveTimezone(this.runtime.settings.displayTimezone),
      sessions,
      cards: cardIds.map((cardId) => ({ cardId, name: names.get(cardId) ?? null })),
    };
  }

  getSnapshot(): AppSnapshot {
    const { paths, settings, state, layout } = this.runtime;

    return {
      firstRun: this.firstRun,
      interfaceLanguage: this.interfaceLanguage(),
      systemLanguage: resolveInterfaceLanguage("system").language,
      systemTheme: currentSystemTheme(),
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
      // Admit every reset-owned store before moving any sibling aside. The
      // layout is disposable: one from a newer Mumbler is left as it is and not
      // written this session, rather than blocking the reset of saved work.
      await settingsStore.admitReset();
      await queueStore.admitReset();
      const layoutNewer = await layoutStore.admitReset().then(() => false, (error: unknown) => {
        if (error instanceof NewerFormatError) return true;
        throw error;
      });
      await transcriptStore.admitReset();
      await loadInterfaceCatalogue(settings.language);
      await ensureDirectories(paths);
      // Preserve each store before the user-commanded reset returns to built-ins.
      const preservedSettingsFiles = moved(paths.settingsPath, await settingsStore.preserveExistingFiles());
      const preservedStateFiles = moved(paths.queuePath, await queueStore.preserveExistingFiles());
      // The preserved queue.json keeps its cards' text and recordings beside it;
      // a reset deletes no user audio.
      const preservedTranscripts = moved(paths.transcriptsDir, await transcriptStore.preserveExistingFiles());
      const preservedRecordings = moved(paths.workingDir, await preserveAside(paths.workingDir));
      await mkdir(paths.workingDir, { recursive: true });
      const preservedLayoutFiles = layoutNewer ? [] : moved(paths.layoutPath, await layoutStore.preserveExistingFiles());
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
      this.runtime.layoutStore = layoutNewer ? null : layoutStore;
      this.runtime.hasGeminiApiKey = await hasApiKey(paths.apiKeysPath, "gemini", makeApiKeyWarn(logger));
      if (this.runtime.toolManager === null) await this.initializeTools();
      this.runtime.startupDiagnostic = null;
      this.runtime.appWideError = null;
      this.runtime.recoveredInterruptedCards = 0;
      applyThemePreference(settings.theme);
      this.followLanguageChange(previousPreference, previousLanguage);
      void this.startToolMaintenance();

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

  async openImportDialog(window: BrowserWindow): Promise<WithSnapshot<ImportOperationResult>> {
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

  async importDroppedPaths(paths: string[]): Promise<WithSnapshot<ImportOperationResult>> {
    return this.importPaths(paths, "drag-and-drop");
  }

  updatePendingImportDrafts(items: PendingImportReviewItem[]): Promise<AppSnapshot> {
    return this.command(async () => {
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
      // A draft that could not be saved stays as the user's latest input; the
      // next save of the queue, or the quit's, writes it.
      if (state.pendingImports.some((item, index) => item !== current[index])) {
        await this.persistState();
      }
      return this.getSnapshot();
    });
  }

  // The queue reads what to probe in its turn, the recordings are probed
  // outside it, and the confirmation is validated and committed in a second
  // turn from the pending imports as they are then; original copies and
  // deletions follow the committed import, in the exports' turn.
  async confirmPendingImports(items: PendingImportReviewItem[]): Promise<WithSnapshot<ConfirmImportsResult>> {
    const byId = new Map(items.map((item) => [item.id, item]));
    const toProbe = await this.command(async () => {
      this.ensureAcceptingWork();
      return this.runtime.state!.pendingImports
        .filter((pendingImport) => byId.has(pendingImport.id))
        .map(({ id, originalFilename, workingFilePath }) => ({ id, originalFilename, workingFilePath }));
    });
    const probes = new Map<string, Awaited<ReturnType<typeof probeAudioProfile>>>();
    for (const { id, originalFilename, workingFilePath } of toProbe) {
      try {
        const probed = await probeAudioProfile(workingFilePath);
        probes.set(id, probed);
        await this.runtime.logger.debug("audio.probe", "Probed audio profile for imported file.", {
          filename: originalFilename,
          durationSec: probed.durationSec,
          formatName: probed.audioProfile?.formatName,
          codecName: probed.audioProfile?.codecName,
          bitRateKbps: probed.audioProfile?.bitRateKbps,
          sampleRateHz: probed.audioProfile?.sampleRateHz,
          channels: probed.audioProfile?.channels,
        });
      } catch (error: unknown) {
        await this.runtime.logger.warn("audio.probe", "Failed to probe imported audio metadata.", {
          filePath: workingFilePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const { reviewed, cardsToAdd, backupDir } = await this.command(async () => {
      this.ensureReady();
      const state = this.runtime.state!;
      // Every reviewed import is validated before anything changes, so a bad
      // timestamp on one of them cannot leave another confirmed.
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
            merged.timestampBasis,
          );
          return { pendingImport, merged, timestamps };
        });
      const backupDir = this.runtime.settings!.backupDirectory;
      if (reviewed.some(({ merged }) => merged.copyToBackupOnConfirm) && backupDir === null) {
        throw new OperationError("Choose a Recordings folder before adding recordings to it.");
      }
      const cardsToAdd = reviewed.map(({ pendingImport, timestamps }) =>
        createConfirmedCard(pendingImport, timestamps, probes.get(pendingImport.id) ?? { durationSec: null, audioProfile: null }));

      const confirmedIds = new Set(reviewed.map(({ pendingImport }) => pendingImport.id));
      const previousPending = state.pendingImports;
      const previousCards = state.cards;
      state.pendingImports = state.pendingImports.filter((item) => !confirmedIds.has(item.id));
      state.cards = [...state.cards, ...cardsToAdd].sort((left, right) =>
        left.timestamps.effectiveUtc - right.timestamps.effectiveUtc,
      );
      try {
        await this.persistState();
      } catch (error: unknown) {
        // The review stays, with the choices just submitted.
        const submitted = new Map(reviewed.map(({ pendingImport, merged }) => [pendingImport.id, merged]));
        state.pendingImports = previousPending.map((item) => submitted.get(item.id) ?? item);
        state.cards = previousCards;
        throw error;
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
      return { reviewed, cardsToAdd, backupDir };
    });

    // Original copies/deletions are optional consequences of the committed
    // import. A refused primary save leaves no copy to repeat on Retry.
    const originalWarnings = await this.exportTurn(() => this.fileOriginals(reviewed, backupDir));
    await this.runtime.logger.info(
      "import.confirm-review",
      "Confirmed pending imports into queue.",
      { addedCards: cardsToAdd.length, stillPending: this.runtime.state!.pendingImports.length },
    );

    return { snapshot: this.getSnapshot(), originalWarnings };
  }

  // A backup or deletion of the original that did not happen is a warning on
  // the confirmed import, never its failure (error-handling-conventions).
  private async fileOriginals(
    reviewed: { pendingImport: PendingImportReviewItem; merged: PendingImportReviewItem; timestamps: MumblerCard["timestamps"] }[],
    backupDir: string | null,
  ): Promise<ImportOriginalWarning[]> {
    const originalWarnings: ImportOriginalWarning[] = [];
    for (const { pendingImport, merged, timestamps } of reviewed) {
      let backupSucceeded = true;
      let sourceIsArchive = false;
      const file = pendingImport.originalSourcePath;
      if (merged.copyToBackupOnConfirm) {
        try {
          // Named by its settled recording time alone (timestamp-conventions,
          // Filenames); the card keeps the original name.
          const archivedName = `${formatUtcMarker(new Date(timestamps.confirmedUtc))}${extname(file).toLowerCase()}`;
          const filed = await copyOriginalToBackup(pendingImport.workingFilePath, backupDir!, archivedName, this.runtime.logger);
          sourceIsArchive = await realpath(file) === await realpath(filed.path);
          // Only an independent source entry can be removed after deduplication;
          // the archive itself must survive reimport and path aliases.
          await this.runtime.logger.info("import.backup-original", filed.reused
            ? "The original was already in the Recordings folder; nothing was copied."
            : "Copied the original into the Recordings folder.", {
            originalSourcePath: pendingImport.originalSourcePath,
            backupPath: filed.path,
          });
        } catch (error: unknown) {
          backupSucceeded = false;
          await this.runtime.logger.warn("import.backup-original", "Failed to copy the original into the Recordings folder.", {
            originalSourcePath: pendingImport.originalSourcePath,
            backupDir,
            error: error instanceof Error ? error.message : String(error),
          });
          if (!merged.deleteOriginalOnConfirm) {
            originalWarnings.push({
              sourcePath: file,
              message: message("import.backupFailed", { file: pathValue(file), folder: pathValue(backupDir!) }),
            });
          }
        }
      }

      if (merged.deleteOriginalOnConfirm && !sourceIsArchive) {
        if (merged.copyToBackupOnConfirm && !backupSucceeded) {
          originalWarnings.push({
            sourcePath: file,
            message: message("import.backupFailedNotDeleted", { file: pathValue(file), folder: pathValue(backupDir!) }),
          });
          await this.runtime.logger.warn(
            "import.delete-original",
            "Skipped deleting original because backup copy failed.",
            { originalSourcePath: pendingImport.originalSourcePath },
          );
        } else {
          try { await deleteImportedSource(file, pendingImport.sourceIdentity); }
          catch (error: unknown) {
            originalWarnings.push({ sourcePath: file, message: message("import.deleteFailed", { file: pathValue(file) }) });
            await this.runtime.logger.warn("import.delete-original", "Failed to delete original after confirm.", {
              originalSourcePath: file, error: serializeError(error),
            });
          }
        }
      }
    }
    return originalWarnings;
  }

  cancelPendingImports(ids: string[]): Promise<AppSnapshot> {
    return this.command(async () => {
      this.ensureAcceptingWork();
      const state = this.runtime.state!;
      const cancelIds = new Set(ids);
      const cancelled = state.pendingImports.filter((item) => cancelIds.has(item.id));
      const previousPending = state.pendingImports;
      state.pendingImports = state.pendingImports.filter((item) => !cancelIds.has(item.id));
      // Keep every recording until the durable queue no longer references it.
      try {
        await this.persistState();
      } catch (error: unknown) {
        state.pendingImports = previousPending;
        throw error;
      }
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

      await this.runtime.logger.info("import.cancelled", "Cancelled pending imports.", {
        cancelledCount: cancelled.length,
      });

      return this.getSnapshot();
    });
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

  // The queue claims the copy's name in its turn, the copy runs outside it,
  // and the duplicate joins the queue in a second turn. The copy is
  // independent audio, so the source may change or go meanwhile.
  async duplicateCard(cardId: string): Promise<AppSnapshot> {
    const { source, duplicatePath } = await this.command(async () => {
      this.ensureAcceptingWork();
      const source = this.requireIdleCard(cardId, {
        missing: "Card to duplicate does not exist.",
        busy: "Cannot duplicate a card while it is being processed.",
      });
      const duplicatePath = await claimWorkingPath(this.runtime.paths!.workingDir, basename(source.sourceFilePath));
      return { source: structuredClone(source), duplicatePath };
    });
    await copyIntoWorking(source.sourceFilePath, duplicatePath);
    return this.command(async () => {
      const state = this.runtime.state!;
      const duplicate = createDuplicatedCard(source, duplicatePath);
      const previousCards = state.cards;
      state.cards = [...state.cards, duplicate].sort((left, right) =>
        left.timestamps.effectiveUtc - right.timestamps.effectiveUtc,
      );
      try {
        await this.persistState();
      } catch (error: unknown) {
        state.cards = previousCards;
        await rm(duplicatePath, { force: true }).catch(() => undefined);
        throw error;
      }
      await this.persistSelectedCard(duplicate.id);
      await this.runtime.logger.info("card.duplicate", "Duplicated card for independent trimming.", {
        sourceCardId: source.id,
        duplicateCardId: duplicate.id,
        duplicateSourcePath: duplicatePath,
      });
      return this.getSnapshot();
    });
  }

  // The analysis runs outside the queue's turn, from the inputs the queue
  // handed it; the card stays busy for other changes meanwhile, and a newer
  // trim of the same card aborts it. The result is applied in a second turn.
  async updateCardTrim(cardId: string, trim: CardTrim): Promise<AppSnapshot> {
    const request = await this.command(async () => {
      this.ensureAcceptingWork();
      const card = this.requireCard(cardId, "Card to update does not exist.");
      // Not requireIdleCard: a trim still analyzing is superseded by this one
      // rather than refusing it.
      if (isCardBusy(card)) {
        throw new OperationError("Cannot change trim markers while this card is being processed.");
      }
      const normalizedTrim = normalizeTrim(trim, card.durationSec);
      this.trimAnalyses.get(cardId)?.abort();
      this.trimAnalyses.delete(cardId);
      // The trim the card already holds changes nothing: no analysis, no new
      // updatedAtUtc, no write.
      if (sameTrim(normalizedTrim, card.trim)) return null;
      const controller = new AbortController();
      this.trimAnalyses.set(cardId, controller);
      return { controller, normalizedTrim, sourceFilePath: card.sourceFilePath, durationSec: card.durationSec, editedAtUtc: Date.now() };
    });
    if (request === null) return this.getSnapshot();
    const { controller, normalizedTrim } = request;
    const finished = (): void => {
      if (this.trimAnalyses.get(cardId) === controller) this.trimAnalyses.delete(cardId);
    };
    let trimDecision: TrimDecision;
    try {
      trimDecision = await analyzeTrimDecision(request.sourceFilePath, normalizedTrim, request.durationSec, controller.signal);
    } catch (error: unknown) {
      finished();
      // A newer trim superseded this one.
      if (controller.signal.aborted) return this.getSnapshot();
      throw error;
    }
    return this.command(async () => {
      finished();
      if (controller.signal.aborted) return this.getSnapshot();
      const card = this.requireCard(cardId, "Card to update does not exist.");
      await this.applyCardTrim(card, normalizedTrim, trimDecision, request.editedAtUtc);
      return this.getSnapshot();
    });
  }

  private async applyCardTrim(
    card: MumblerCard,
    normalizedTrim: CardTrim,
    trimDecision: TrimDecision,
    editedAtUtc: number,
  ): Promise<void> {
    const state = this.runtime.state!;
    const cardId = card.id;
    const previous = { trim: card.trim, trimDecision: card.trimDecision, timestamps: card.timestamps, updatedAtUtc: card.updatedAtUtc };
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

    try {
      await this.persistState();
    } catch (error: unknown) {
      Object.assign(card, previous);
      throw error;
    }
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

  async getCardWaveformPeaks(cardId: string, requestId: string): Promise<Float32Array | null> {
    this.ensureReady();
    const filePath = this.resolveCardSourcePath(cardId);
    if (filePath === null) throw new OperationError("Card media source no longer exists.");
    this.waveformCache ??= new WaveformCache(computeWaveformPeaks);
    try {
      return await this.waveformCache.acquire(filePath, requestId);
    } catch (error: unknown) {
      if (isCancelledError(error)) return null;
      await this.runtime.logger.warn("waveform.failed", "Could not compute the recording's waveform.", {
        cardId, error: serializeError(error),
      });
      throw new OperationError("The waveform could not be drawn.");
    }
  }

  // Release the acquisition even after its card has left the queue.
  cancelCardWaveformPeaks(requestId: string): void {
    this.waveformCache?.release(requestId);
  }

  // A card's working recording, or that of a pending import, which the review plays.
  resolveCardSourcePath(cardId: string): string | null {
    if (this.runtime.state === null) {
      return null;
    }
    const card = this.runtime.state.cards.find((entry) => entry.id === cardId);
    if (card !== undefined) return card.sourceFilePath;
    return this.runtime.state.pendingImports.find((entry) => entry.id === cardId)?.workingFilePath ?? null;
  }

  generateCardStep(cardId: string, target: GenerateTarget): Promise<AppSnapshot> {
    return this.command(async () => {
      this.ensureReady();
      this.requireCard(cardId, "Card to generate does not exist.");
      if ((await this.resolveGeminiApiKey()) === null) {
        throw new OperationError("Gemini API key is not configured.");
      }
      // A quit that began during the key lookup stops this start.
      this.ensureAcceptingWork();
      const card = this.requireIdleCard(cardId, {
        missing: "Card to generate does not exist.",
        busy: "This card is already being processed.",
      });
      this.pipeline.assertCardCanStart(card);

      const startStep = resolveGenerateStartStep(card, target);
      const previous = structuredClone(card);
      if (clearCardResultsFromStep(card, startStep)) {
        card.updatedAtUtc = Date.now();
      }
      card.status = "Imported";
      card.activeStep = null;
      card.queuedMode = null;
      card.queuedAtUtc = null;
      card.lastError = null;
      try {
        await this.pipeline.startOrEnqueue(cardId, "generate", startStep);
      } catch (error: unknown) {
        Object.assign(card, previous);
        throw error;
      }
      await this.runtime.logger.info("pipeline.generate", "Started dependency-aware generation.", {
        cardId,
        requestedStep: target,
        startStep,
      });
      return this.getSnapshot();
    });
  }

  cancelCardProcessing(cardId: string): Promise<AppSnapshot> {
    return this.command(async () => {
      this.ensureReady();
      const state = this.runtime.state!;
      const cardIndex = state.cards.findIndex((entry) => entry.id === cardId);

      if (cardIndex === -1) {
        throw new OperationError("Card to cancel does not exist.");
      }

      const oldCard = state.cards[cardIndex];
      if (oldCard.status !== "Queued" && !this.pipeline.hasRun(cardId)) {
        throw new OperationError("This card is not being processed.");
      }

      const failedStep = oldCard.activeStep ?? "transcription";

      // Take the card from its run and abort it: from here the run no longer
      // owns the card, so a result it reports later is dropped.
      this.pipeline.detachAndAbort(cardId);

      // The card shows as cancelled at once.
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

      await this.persistState();

      await this.runtime.logger.info("pipeline.cancel-immediate", "Immediately detached and cancelled card pipeline.", {
        cardId,
        failedStep,
      });
      return this.getSnapshot();
    });
  }

  async pickOutputDirectory(window: BrowserWindow, directory?: string, literalDirectory?: string): Promise<string | null> {
    this.ensureReady();

    const result = await dialog.showOpenDialog(window, {
      title: this.translator().t("dialog.chooseOutputFolder"),
      defaultPath: directory === undefined
        ? this.runtime.settings!.outputDirectory ?? this.runtime.paths!.outputDir
        : resolveSettingsDirectory(directory, literalDirectory) ?? this.runtime.paths!.outputDir,
      properties: ["openDirectory", "createDirectory"],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0] ?? null;
  }

  async pickBackupDirectory(window: BrowserWindow, directory?: string, literalDirectory?: string): Promise<string | null> {
    this.ensureReady();
    const result = await dialog.showOpenDialog(window, {
      title: this.translator().t("settings.backupDirectory"),
      defaultPath: directory === undefined
        ? this.runtime.settings!.backupDirectory ?? this.runtime.paths!.originalsDir
        : resolveSettingsDirectory(directory, literalDirectory) ?? this.runtime.paths!.originalsDir,
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  }

  async openOutputDirectory(): Promise<void> {
    this.ensureReady();

    const targetDir = this.runtime.settings!.outputDirectory;
    if (targetDir === null) throw new OperationError("Choose a save folder first.");
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
    return this.whenAccepting(() => this.persistSettingsDraft({ ...draft }));
  }

  private mutateSettings(
    update: (current: MumblerSettings) => MumblerSettings,
    options: { replaceUnusable?: boolean } = {},
  ): Promise<SettingsCommit> {
    return this.enqueueSettings(async () => {
      const previous = this.runtime.settings!;
      const previousLanguage = this.interfaceLanguage().language;
      const next = update(previous);
      const store = this.runtime.settingsStore!;
      const previousFailure = store.failedWrite;
      try {
        await store.save(next, options);
      } catch (error: unknown) {
        const failure = store.failedWrite;
        if (failure !== null && failure !== previousFailure) this.failedSettingsMutation = { failure, next };
        throw error;
      }
      this.runtime.settings = next;
      this.failedSettingsMutation = null;
      return { previous, previousLanguage, next };
    });
  }

  private enqueueSettings<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.settingsTail.then(work, work);
    this.settingsTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private retryFailedSettings(failure: object): Promise<SettingsCommit | null> {
    return this.enqueueSettings(async () => {
      const store = this.runtime.settingsStore!;
      // A resumed app may have committed a newer intent before this queued retry.
      if (store.failedWrite !== failure) return null;
      const mutation = this.failedSettingsMutation;
      const previous = this.runtime.settings!;
      const previousLanguage = this.interfaceLanguage().language;
      try {
        await store.retryFailedWrite();
      } catch (error: unknown) {
        const retryFailure = store.failedWrite;
        if (mutation?.failure === failure && retryFailure !== null) {
          this.failedSettingsMutation = { failure: retryFailure, next: mutation.next };
        }
        throw error;
      }
      if (mutation?.failure !== failure) return null;
      this.runtime.settings = mutation.next;
      this.failedSettingsMutation = null;
      return { previous, previousLanguage, next: mutation.next };
    });
  }

  private followSettingsCommit(commit: SettingsCommit): void {
    applyThemePreference(this.themePreference());
    const languageChanged = this.interfaceLanguage().language !== commit.previousLanguage;
    this.followLanguageChange(commit.previous.language, commit.previousLanguage);
    // A new display zone re-renders the windows' times as a new language does.
    if (!languageChanged && commit.previous.displayTimezone !== commit.next.displayTimezone) {
      this.onLanguageChangedCallback?.();
    }
  }

  private async persistSettingsDraft(draft: SettingsDraft): Promise<AppSnapshot> {
    this.ensureReady();

    await loadInterfaceCatalogue(normalizeLanguagePreference(draft.language));
    // The Settings window showed the built-in in place of any saved value this
    // build could not use, so saving it replaces those values.
    const commit = await this.mutateSettings(
      (current) => applySettingsDraft(current, draft), { replaceUnusable: true },
    );
    const nextSettings = commit.next;
    this.followSettingsCommit(commit);
    await this.runtime.logger.info("settings.save", "Updated application settings.", {
      outputDirectory: nextSettings.outputDirectory,
      backupDirectory: nextSettings.backupDirectory,
      transcriptionModel: nextSettings["gemini.transcription"],
      metadataModel: nextSettings["gemini.metadata"],
      defaultTimezone: nextSettings.defaultTimezone,
      timestampPatterns: nextSettings.timestampPatterns,
      previewSnippetSeconds: nextSettings.previewSnippetSeconds,
      concurrencyLimit: nextSettings.concurrencyLimit,
    });

    await this.command(() => this.pipeline.drainQueued());

    return this.getSnapshot();
  }

  // Store a new Gemini API key in the dedicated 0600 secrets file (never the
  // settings store), refresh the cached presence flag, then admit any queued
  // cards that were waiting only on a missing key. The raw key never enters the
  // snapshot or the log — only the resulting presence boolean is reported.
  setGeminiApiKey(apiKey: string): Promise<AppSnapshot> {
    return this.whenAccepting(() => this.withKeyFile(() => this.storeGeminiApiKey(apiKey)));
  }

  private async storeGeminiApiKey(apiKey: string): Promise<AppSnapshot> {
    this.ensureReady();
    const trimmed = apiKey.trim();
    if (trimmed.length === 0) {
      throw new OperationError("Enter a Gemini API key.");
    }

    this.runtime.logger.maskSecret(trimmed);
    await writeApiKey(this.runtime.paths!.apiKeysPath, "gemini", trimmed, this.apiKeyWarn());
    await this.refreshHasGeminiApiKey();
    await this.runtime.logger.info("settings.api-key-set", "Stored Gemini API key.", {
      hasGeminiApiKey: this.runtime.hasGeminiApiKey,
    });

    await this.command(() => this.pipeline.drainQueued());
    return this.getSnapshot();
  }

  // Remove the stored key from the secrets file. An environment-supplied key, if
  // present, still resolves afterward — so hasGeminiApiKey may remain true.
  clearGeminiApiKey(): Promise<AppSnapshot> {
    return this.whenAccepting(() => this.withKeyFile(() => this.removeGeminiApiKey()));
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
    const key = await resolveApiKey(this.runtime.paths!.apiKeysPath, "gemini", this.apiKeyWarn());
    // Whatever echoes it later, a provider error or a typed endpoint, records mask it.
    if (key !== null) this.runtime.logger.maskSecret(key);
    return key;
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

  drainQueuedCards(): Promise<void> {
    return this.command(() => this.pipeline.drainQueued());
  }

  // The app-owned work still running that a quit would stop, which a quit by
  // the user asks about first. Queued recordings are not counted: they stay queued
  // in the saved queue and start again at the next launch.
  runningWork(): RunningWork {
    const busy: readonly MumblerCard["status"][] = ["Transcribing", "Generating Metadata", "Saving"];
    return {
      recordings: (this.runtime.state?.cards ?? []).filter((card) => busy.includes(card.status)).length,
      tools: (this.runtime.toolManager?.listStatuses() ?? [])
        .filter((status) => status.transient.kind === "running" && status.transient.operation === "provision").length,
    };
  }

  // The quit's save (unsaved-edits conventions, Quitting). Stops new pipelines
  // and saves, aborts in-flight ones and lets them unwind (a cancelled save
  // rolls back and leaves its card Ready to Save; a cancelled run leaves its
  // card Cancelled), drains the store write-queues, then writes the user's own
  // work that is not on disk: the queue and the transcripts from what the app
  // holds, and any settings write that failed, during the quit or before it.
  // Returns what could not be saved; a call while one runs joins it.
  saveForQuit(): Promise<QuitSaveFailure[]> {
    this.quitSave ??= this.runQuitSave().finally(() => { this.quitSave = null; });
    return this.quitSave;
  }

  private async runQuitSave(): Promise<QuitSaveFailure[]> {
    const { queueStore, transcriptStore, settingsStore, logger } = this.runtime;
    this.closing = true;
    this.exportsAbort.abort();
    this.runtime.toolManager?.cancelAll();
    // Admission is closed; the queue stops the runs in its turn, and they
    // report as they unwind. A cancelled save leaves its card Ready to Save.
    const runs = this.runtime.state === null ? null : await this.command(async () => this.pipeline.stop());
    await Promise.all([runs?.settled, this.exportsTail, this.settingsTail, this.keyTail]);
    await queueStore?.flush();
    await transcriptStore?.flush();
    await settingsStore?.flush();

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
    // A settings change that could not be saved, at the time or during this
    // quit, is tried again; one that still fails is asked about.
    const retrySettings = async (): Promise<void> => {
      const settingsFailure = settingsStore?.failedWrite ?? null;
      if (settingsStore && settingsFailure !== null) {
        await attempt("settings", async () => {
          const commit = await this.retryFailedSettings(settingsFailure);
          if (commit !== null) this.followSettingsCommit(commit);
        });
      }
    };
    const state = this.runtime.state;
    if (state !== null && queueStore !== null && transcriptStore !== null) {
      // The queue as the app holds it is always written: the transcripts first,
      // then queue.json.
      await this.command(async () => {
        const snapshot = structuredClone(state);
        const transcriptsSaved = await attempt("transcripts", () => transcriptStore.writeChanged(snapshot.cards));
        if (transcriptsSaved) {
          await attempt("queue", () => queueStore.save(snapshot));
        }
        const packetSaved = failures.length === 0;
        await retrySettings();
        if (packetSaved) {
          // Cleanup of removed cards' files, not the user's work: logged only.
          await transcriptStore.removeAbsent(snapshot.cards).catch((error: unknown) => {
            void logger.warn("quit.transcript-cleanup-failed", "Could not delete a removed card's text file.", {
              error: serializeError(error),
            }).catch(() => undefined);
          });
        }
      });
    } else await retrySettings();
    await this.runtime.layoutStore?.flush();
    return failures;
  }

  // The user cancelled the quit: the app takes work again. Runs a quit stopped
  // stay Cancelled, for the user to start again.
  async resumeAfterCancelledQuit(): Promise<void> {
    this.closing = false;
    this.exportsAbort = new AbortController();
    if (this.runtime.state !== null) await this.command(() => this.pipeline.resume());
    void this.runtime.logger.info("quit.cancelled", "Quit cancelled; Mumbler keeps running.").catch(() => undefined);
  }

  // The quit's last step, after its save: closes the backup history and the
  // records, which log their own failures. Called once; later calls share it.
  // The history is best effort and never holds up an exit: a user's quit lets
  // its pending writes draw on what remains of the exit deadline, and an OS
  // session end skips them (data-backup-conventions).
  closeForQuit(details: Record<string, unknown> = {}): Promise<void> {
    this.closePromise ??= (async () => {
      // A waveform being drawn is display work: it stops, and its ffmpeg exits.
      const waveforms = this.waveformCache?.close() ?? Promise.resolve();
      let backups: Promise<void> = Promise.resolve();
      if (details.origin === "session-end") abandonBackupStore();
      else backups = closeBackupStore();
      void this.runtime.logger.info("app.shutdown", "Shutdown complete.", {
        ...details,
        cardCount: this.runtime.state?.cards.length ?? 0,
      }).catch(() => undefined);
      this.runtime.toolManager?.cancelAll();
      await Promise.all([backups, waveforms, this.runtime.logger.close()]);
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
    return this.whenAccepting(() => this.pickAndSaveOutputDirectory(window));
  }

  private async pickAndSaveOutputDirectory(window: BrowserWindow): Promise<AppSnapshot> {
    const outputDirectory = await this.pickOutputDirectory(window);
    if (outputDirectory === null) {
      return this.getSnapshot();
    }

    return this.persistSetupDirectory(outputDirectory);
  }

  chooseOriginalsDirectory(window: BrowserWindow): Promise<AppSnapshot> {
    return this.whenAccepting(async () => {
      this.ensureReady();
      const result = await dialog.showOpenDialog(window, {
        title: this.translator().t("settings.backupDirectory"),
        defaultPath: this.runtime.settings!.backupDirectory ?? this.runtime.paths!.originalsDir,
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) return this.getSnapshot();
      await this.mutateSettings((current) => ({ ...current, backupDirectory: result.filePaths[0]! }));
      return this.getSnapshot();
    });
  }

  saveSetupDirectory(directory: string): Promise<AppSnapshot> {
    return this.whenAccepting(() => this.persistSetupDirectory(directory));
  }

  private async persistSetupDirectory(directory: string): Promise<AppSnapshot> {
    this.ensureReady();
    // Setup supplies only the native picker result or the suggested absolute
    // path, never authored expressions. Preserve that literal selection.
    if (!isAbsolute(directory)) throw new OperationError("Choose a save folder first.");
    // Targeted save preserves unsupported and unknown settings the setup never showed.
    const { next: nextSettings } = await this.mutateSettings((current) => ({ ...current, outputDirectory: directory }));

    await this.runtime.logger.info("settings.output-directory", "Updated output directory.", {
      outputDirectory: nextSettings.outputDirectory,
    });
    return this.getSnapshot();
  }

  // Setup's Recordings folder: the suggested absolute path or a picker result,
  // kept literal like the output folder.
  saveSetupRecordingsDirectory(directory: string): Promise<AppSnapshot> {
    return this.whenAccepting(async () => {
      this.ensureReady();
      if (!isAbsolute(directory)) throw new OperationError("Choose a Recordings folder first.");
      await this.mutateSettings((current) => ({ ...current, backupDirectory: directory }));
      return this.getSnapshot();
    });
  }

  // Setup's confirmation of the zone recording times without one are read in.
  saveSetupTimezone(timezone: string): Promise<AppSnapshot> {
    return this.whenAccepting(async () => {
      this.ensureReady();
      if (timezone !== SYSTEM_TIMEZONE && !isValidTimezone(timezone)) throw new OperationError("Choose a valid time zone.");
      await this.mutateSettings((current) => ({ ...current, defaultTimezone: timezone }));
      return this.getSnapshot();
    });
  }

  // A save starts with a queue command that marks the card Saving, publishes
  // in the exports' turn, outside the queue's, and ends with a command that
  // records the outcome. Saving is busy, so no generation, trim, removal or
  // second save starts while this one reads the card and then deletes its
  // working audio; any outcome but a completed save hands the card back as
  // Ready to Save.
  async saveCard(
    cardId: string,
    resolution?: SaveConflictResolution,
    options: SaveCardOptions = { removeAfterSave: true },
  ): Promise<WithSnapshot<SaveCardResult>> {
    const card = await this.command(async () => {
      this.ensureReady();
      const card = this.requireCard(cardId, "Card to save does not exist.");

      if (card.status !== "Ready to Save") {
        throw new OperationError("Only cards in Ready to Save state can be finalized.");
      }
      // A text write may have committed before an interrupted queue update, or
      // its file may be absent. Status alone cannot certify a complete export.
      if ([card.transcription.text, card.metadata.structured, card.metadata.title, card.metadata.slug]
        .some((value) => value === null || value.trim().length === 0)) {
        throw new OperationError("Generate the missing transcript and metadata before saving this recording.");
      }
      if (this.closing) {
        throw new OperationError("Mumbler is closing; the recording was not saved.");
      }
      if (this.trimAnalyses.has(cardId)) {
        throw new OperationError("The trim markers are still being applied. Save again in a moment.");
      }
      if (resolution !== "cancel" && this.runtime.settings!.outputDirectory === null) {
        throw new OperationError("Choose a save folder before exporting a recording.");
      }
      card.status = "Saving";
      try {
        await this.persistState();
      } catch (error: unknown) {
        card.status = "Ready to Save";
        throw error;
      }
      return card;
    });
    const outcome = await this.exportTurn(async (signal) => {
      let outcome: SaveOutcome | null = null;
      try {
        outcome = await this.writeCardOutputs(card, resolution, signal);
        return outcome;
      } finally {
        await this.command(async () => {
          // Publication is the commit point: once the files are out, the save
          // has succeeded, and removing the card from the queue is cleanup that
          // reports its own failure to the log.
          if (outcome?.kind === "saved" && options.removeAfterSave) {
            await this.discardWorkingCard(card);
            return;
          }
          // A recording kept after its save stays ready to be saved again.
          card.status = "Ready to Save";
          await this.persistState().catch((error: unknown) =>
            this.runtime.logger.error("card.save-settlement-failed", "Could not persist the recording's ready state after saving stopped.", error, {
              cardId: card.id,
            }).catch(() => undefined));
        });
      }
    });
    return { ...outcome, snapshot: this.getSnapshot() };
  }

  private async writeCardOutputs(
    card: MumblerCard,
    resolution: SaveConflictResolution | undefined,
    signal: AbortSignal,
  ): Promise<SaveOutcome> {
    const cardId = card.id;
    const settings = this.runtime.settings!;
    const logger = this.runtime.logger;

    if (resolution === "cancel") {
      await logger.info("save.cancelled", "Save cancelled by user.", { cardId });
      return { kind: "cancelled" };
    }
    const outputDirectory = settings.outputDirectory;
    if (outputDirectory === null) throw new OperationError("Choose a save folder before exporting a recording.");
    await mkdir(outputDirectory, { recursive: true });

    const extension = extname(card.sourceFilePath);
    const baseName = outputBaseName(card)!;
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

    const targetPaths: SaveTargetPaths =
      resolution === "suffix"
        ? await buildUniqueSuffixedTargets(outputDirectory, baseName, extension)
        : initialTargets;

    const trimmedAudio = await prepareAudioForTranscription({
      sourceFilePath: card.sourceFilePath,
      workingDir: this.runtime.paths!.workingDir,
      trim: card.trim,
      trimDecision: card.trimDecision,
      durationSec: card.durationSec,
      audioProfile: card.audioProfile,
      logger,
      signal,
    });

    let stamped: Awaited<ReturnType<typeof this.stampRecordingTime>> | null = null;
    let committed: Extract<SaveOutcome, { kind: "saved" }> | null = null;
    try {
      stamped = await this.stampRecordingTime(card, trimmedAudio, signal);
      const finalAudio = stamped.audio;
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
          warnings = [message("notice.saveCleanupFailed", { folder: pathValue(outputDirectory) })];
        }
      } catch (error: unknown) {
        if (error instanceof OutputLocationError) return { kind: "failed", message: message("error.saveOutputLocationUnsafe") };
        if (error instanceof OutputPartialFailureError) {
          await logger.error("save.incomplete", "Output save did not finish every output.", error, {
            cardId,
            issues: error.issues.map((issue) => ({ ...issue, error: serializeError(issue.error) })),
          });
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

      if (stamped.warning !== null) warnings.push(stamped.warning);
      committed = { kind: "saved", ...targetPaths, warnings };
      return committed;
    } finally {
      let cleaned = true;
      if (stamped !== null && stamped.audio !== trimmedAudio) cleaned = await cleanupPreparedAudio(stamped.audio, logger);
      if (!await cleanupPreparedAudio(trimmedAudio, logger)) cleaned = false;
      if (!cleaned) {
        committed?.warnings?.push(message("notice.saveCleanupFailed", { folder: pathValue(this.runtime.paths!.workingDir) }));
      }
    }
  }

  // The saved audio carries its official start inside it,
  // read back by the same reader new recordings get before it is trusted. A format
  // with no place for a time is saved as it is; a write that fails, or reads
  // back as anything else, saves the audio as it was and says so.
  private async stampRecordingTime(
    card: MumblerCard,
    audio: PreparedAudioInput,
    signal: AbortSignal,
  ): Promise<{ audio: PreparedAudioInput; warning: Message | null }> {
    const utcMs = officialStartUtcMs(card.timestamps.effectiveUtc);
    const timezone = card.timestamps.timezone;
    const extension = extname(audio.filePath);
    const notWritten = message("notice.saveTimeNotWritten");
    if (!isValidTimezone(timezone)) return { audio, warning: notWritten };
    const tagArgs = recordingTimeWriteArgs(extension, utcMs, timezone);
    if (tagArgs === null) {
      await this.runtime.logger.info("save.time-not-writable", "This audio format has no place for a recording time.", { cardId: card.id, extension });
      return { audio, warning: null };
    }
    let rewritten: PreparedAudioInput | null = null;
    try {
      rewritten = await rewriteAudioTags({ sourceFilePath: audio.filePath, workingDir: this.runtime.paths!.workingDir, tagArgs, signal, logger: this.runtime.logger });
      const tags = await probeRecordingTags(rewritten.filePath, signal);
      if (carriesOnlyRecordingTime(recordingTimesFromTags(tags), utcMs, timezone)) return { audio: rewritten, warning: null };
      await this.runtime.logger.warn("save.time-mismatch", "The saved audio did not read back with its recording time.", {
        cardId: card.id, extension, tags,
      });
    } catch (error: unknown) {
      if (isCancelledError(error)) {
        if (rewritten !== null) await cleanupPreparedAudio(rewritten, this.runtime.logger);
        throw error;
      }
      await this.runtime.logger.warn("save.time-write-failed", "Could not write the recording time into the saved audio.", {
        cardId: card.id, extension, error: serializeError(error),
      });
    }
    if (rewritten !== null) await cleanupPreparedAudio(rewritten, this.runtime.logger);
    return { audio, warning: notWritten };
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
    const targetInfo = await Promise.all(Object.values(targets).map(async (target) => {
      let info: Awaited<ReturnType<typeof stat>> | null = null;
      try { info = await stat(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return { path: join(output, basename(target)), info };
    }));
    // Only the three outputs are fixed in number. Visit retained sources one at
    // a time so a large queue cannot flood the filesystem before a collision.
    for (const path of sources) {
      let source: { path: string; info: NonNullable<Awaited<ReturnType<typeof stat>>> };
      try { source = { path: await realpath(path), info: await stat(path) }; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (targetInfo.some((target) => target.path === source.path || (target.info !== null &&
          target.info.dev === source.info.dev && target.info.ino === source.info.ino))) return false;
    }
    return true;
  }

  removeCard(cardId: string): Promise<AppSnapshot> {
    return this.command(async () => {
      this.ensureAcceptingWork();
      const state = this.runtime.state!;
      // requireIdleCard also refuses a "Queued" card: its working audio is one
      // drain away from a run reading it, so removal waits until the card is
      // cancelled or finishes.
      const card = this.requireIdleCard(cardId, {
        missing: "Card to remove does not exist.",
        busy: "Cannot remove a card while it is being processed.",
      });
      const previousCards = state.cards;
      state.cards = state.cards.filter((entry) => entry.id !== cardId);

      // Commit removal before deleting the recording. A failed queue publication
      // must leave the working audio intact; a crash after publication may leave
      // an unreferenced recording, which launch deliberately never sweeps.
      try {
        await this.persistState();
      } catch (error: unknown) {
        state.cards = previousCards;
        throw error;
      }
      try {
        await rm(card.sourceFilePath, { force: true });
      } catch (error: unknown) {
        state.cards = previousCards;
        // Restore retry information, including the transcript removed by the
        // committed queue change. persistState writes text before the queue.
        try { await this.persistState(); } catch (restoreError: unknown) {
          await this.runtime.logger.error("card.remove-restore", "Removal failed and the retained card could not be saved; working audio remains intact.", restoreError, { cardId });
        }
        throw new Error(`Failed to delete the working audio of card ${cardId}: ${formatError(error)}`, { cause: error });
      }
      await this.runtime.logger.info("card.remove", "Deleted card working audio and removed card.", {
        cardId,
        sourceFilePath: card.sourceFilePath,
      });

      return this.getSnapshot();
    });
  }

  private importPaths(sourcePaths: string[], importSource: ImportSource): Promise<WithSnapshot<ImportOperationResult>> {
    return this.whenAccepting(() => this.importPathBatch(sourcePaths, importSource));
  }

  // Runs `work` as a queue command, after every earlier one has settled.
  private command<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queueTail.then(work);
    this.queueTail = run.then(() => undefined, () => undefined);
    return run;
  }

  // Runs `work` in the exports' turn: saves and original copies take turns.
  private exportTurn<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const run = this.exportsTail.then(() => work(this.exportsAbort.signal));
    this.exportsTail = run.then(() => undefined, () => undefined);
    return run;
  }

  // The key file's one writer.
  private withKeyFile<T>(work: () => Promise<T>): Promise<T> {
    const run = this.keyTail.then(work);
    this.keyTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private whenAccepting<T>(work: () => Promise<T>): Promise<T> {
    try { this.ensureAcceptingWork(); } catch (error: unknown) { return Promise.reject(error); }
    return work();
  }

  private ensureAcceptingWork(): void {
    this.ensureReady();
    if (this.closing) throw new OperationError("Mumbler is closing; new work cannot start.");
  }

  private async importPathBatch(
    sourcePaths: string[],
    importSource: ImportSource,
  ): Promise<WithSnapshot<ImportOperationResult>> {
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
        const pending = await this.prepareImport(sourcePath, importSource);
        // Once the queue holds the copy, a failed queue save retains it for retry.
        await this.command(async () => {
          this.runtime.state!.pendingImports.push(pending);
          await this.persistState();
        });
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

  private async prepareImport(sourcePath: string, importSource: ImportSource): Promise<PendingImportReviewItem> {
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
    const sourceIdentity = sourceFileIdentity(sourceStats);
    // The queue claims the copy's name in its turn; the copy runs outside it.
    const workingFilePath = await this.command(() => claimWorkingPath(paths.workingDir, originalFilename));
    try {
      await copyIntoWorking(sourcePath, workingFilePath);

      await this.runtime.logger.debug("import.file", "Staged file to working storage.", {
        originalFilename,
        fileSizeBytes: sourceStats.size,
        importSource,
      });

      const filenameStem = basename(originalFilename, extname(originalFilename));
      const parsed = parseTimestampFromFilename(filenameStem, settings.timestampPatterns);
      // The zone the filename's local time is read in. Each card keeps its own zone
      // from here on, so a later change of the setting never re-dates a recording
      // already imported.
      const importZone = importTimezone(settings);
      // Every time the recording offers, for the review to choose from: its file
      // name, its container/audio-stream tags and the file's own times, to the second.
      const timeCandidates: RecordingTimeCandidate[] = [];
      if (parsed.localTimestampText.length > 0) {
        timeCandidates.push({ source: "file-name", utcMs: null, localText: parsed.localTimestampText });
      }
      try {
        timeCandidates.push(...recordingTimesFromTags(await probeRecordingTags(workingFilePath)));
      } catch (error: unknown) {
        // Missing tools or an unreadable container leave the other times.
        await this.runtime.logger.debug("import.tags", "Could not read the recording's embedded times.", {
          originalFilename, error: serializeError(error),
        });
      }
      const second = (ms: number) => Math.floor(ms / 1000) * 1000;
      const now = Date.now();
      if (sourceStats.birthtimeMs > 0 && isPlausibleFileTime(sourceStats.birthtimeMs, now)) {
        timeCandidates.push({ source: "file-created", utcMs: second(sourceStats.birthtimeMs), localText: null });
      }
      if (isPlausibleFileTime(sourceStats.mtimeMs, now)) {
        timeCandidates.push({ source: "file-modified", utcMs: second(sourceStats.mtimeMs), localText: null });
      }
      const timestampDraft = prefilledRecordingTime(timeCandidates, importZone);

      const pendingImport: PendingImportReviewItem = {
        id: nanoid(),
        originalFilename,
        importSource,
        originalSourcePath: sourcePath,
        sourceIdentity,
        workingFilePath,
        fileSizeBytes: sourceStats.size,
        ...timestampDraft,
        timezone: importZone,
        parseStatus: timestampDraft.localTimestampText.length > 0 ? "parsed" : "manual-required",
        timeCandidates,
        // An imported original is moved into Recordings by default: copied, then
        // deleted once the copy is complete.
        deleteOriginalOnConfirm: true,
        copyToBackupOnConfirm: true,
        createdAtUtc: Date.now(),
        updatedAtUtc: Date.now(),
      };

      return pendingImport;
    } catch (error) {
      await rm(workingFilePath, { force: true });
      throw error;
    }
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
    if (isCardBusy(card) || this.trimAnalyses.has(cardId)) {
      throw new OperationError(messages.busy);
    }
    return card;
  }

  private enqueuePersistence(work: () => Promise<void>): Promise<void> {
    const run = this.persistenceTail.then(work);
    this.persistenceTail = run.then(() => undefined, () => undefined);
    return run;
  }

  // Called inside queue commands: the transcripts, then queue.json, from the
  // queue as the command left it.
  private async persistState(): Promise<void> {
    const snapshot = structuredClone(this.runtime.state!);
    await this.enqueuePersistence(async () => {
      await this.runtime.transcriptStore!.writeChanged(snapshot.cards);
      await this.runtime.queueStore!.save(snapshot);
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

  // Never throws: it runs after a save has published its files. The queue is
  // saved first and the working audio deleted only once it no longer lists the
  // card: deleting first would bring the card back at the next launch as an
  // error with its audio missing. When the queue cannot be saved the audio stays,
  // so a relaunch shows the card intact; if a later queue save drops it, its
  // working copy remains in working/ unreferenced (launch never deletes a
  // recording).
  private async discardWorkingCard(card: MumblerCard): Promise<void> {
    this.runtime.state!.cards = this.runtime.state!.cards.filter((entry) => entry.id !== card.id);
    try {
      await this.persistState();
    } catch (error: unknown) {
      await this.runtime.logger.error(
        "card.cleanup",
        "Saved card was removed from the queue, but the queue could not be saved; its working audio is kept.",
        error,
        { cardId: card.id },
      );
      return;
    }

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
  }
}

// The single storage-root resolver lives in its own electron-free module so the pure Node
// backup store can resolve the root the same way without importing electron. Re-exported here so the
// existing callers and tests that reach it through app-runtime keep working (it is imported at the top for
// getAppPaths' own use).
export { resolveStorageRoot };

export { getAppPaths };

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

async function ensureDirectories(paths: AppPaths): Promise<void> {
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
  timestampBasis: PendingImportReviewItem["timestampBasis"] = "local",
): MumblerCard["timestamps"] {
  if (!isValidTimezone(timezone)) {
    throw new OperationError(`Invalid timezone: ${timezone}`);
  }

  const localResult = recomputeUtcFromLocal(localTimestampText, timezone);
  if (timestampBasis !== "utc" && localResult.error === null) {
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
    const utcMs = parseUtcFromDisplay(utcTimestampText)!;
    return {
      confirmedLocal: utcResult.localTimestampText,
      confirmedUtc: utcMs,
      timezone,
      frontTrimOffsetSec: 0,
      effectiveLocal: utcResult.localTimestampText,
      effectiveUtc: utcMs,
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
    timestampBasis: draft.timestampBasis,
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

function createConfirmedCard(
  pendingImport: PendingImportReviewItem,
  timestamps: MumblerCard["timestamps"],
  probed: Awaited<ReturnType<typeof probeAudioProfile>>,
): MumblerCard {
  return {
    id: nanoid(),
    originalFilename: pendingImport.originalFilename,
    importSource: pendingImport.importSource,
    sourceFilePath: pendingImport.workingFilePath,
    audioProfile: probed.audioProfile,
    durationSec: probed.durationSec,
    fileSizeBytes: pendingImport.fileSizeBytes,
    timestamps,
    trim: { frontMarkerSec: null, backMarkerSec: null },
    trimDecision: null,
    transcribedTrim: null,
    transcription: { text: null },
    metadata: { structured: null, title: null, slug: null },
    ai: { transcription: null, structured: null, title: null, slug: null },
    status: "Imported",
    activeStep: null,
    queuedMode: null,
    queuedAtUtc: null,
    lastError: null,
    createdAtUtc: Date.now(),
    updatedAtUtc: Date.now(),
  };
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
  const frontMarkerSec = normalizeMarker(trim.frontMarkerSec, "front");
  const backMarkerSec = normalizeMarker(trim.backMarkerSec, "back");

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

// The renderer sends markers in tenths of a second, so anything finer or
// negative is refused rather than rounded. A front marker of 0 is the start,
// the same as none; a back marker of 0 would keep nothing.
function normalizeMarker(value: number | null, side: "front" | "back"): number | null {
  if (value === null) {
    return null;
  }

  const tenths = Math.round(value * 10);
  if (!Number.isFinite(value) || value < 0 || Math.abs(value * 10 - tenths) > 1e-6) {
    throw new OperationError("Trim markers must be zero or more seconds, in tenths.");
  }
  if (tenths === 0) {
    if (side === "back") throw new OperationError("The back trim cannot be 0.");
    return null;
  }

  return tenths / 10;
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
