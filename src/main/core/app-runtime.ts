import { app, BrowserWindow, dialog, shell } from "electron";
import { mkdir, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

import { nanoid } from "nanoid";

import {
  type CardTrim,
  type AppPaths,
  type AppSnapshot,
  type FailedImport,
  type GenerateTarget,
  type ImportOperationResult,
  type ImportSource,
  type MumblerCard,
  type MumblerSettings,
  type MumblerState,
  type PendingImportReviewItem,
  type RendererErrorReport,
  type SaveCardResult,
  type SaveConflictResolution,
  type SettingsDraft,
  type ToolName,
} from "@shared/app-shell";
import { COMMAND_DEFINITIONS } from "@shared/commands";
import {
  analyzeTrimDecision,
  configureToolResolver,
  prepareAudioForTranscription,
  probeAudioProfile,
} from "./audio-tools";
import { ToolManager } from "./binaries/manager";
import { createDependenciesStore } from "./binaries/store";
import {
  formatUtcForDisplay,
  formatUtcMarker,
  isValidTimezone,
  parseTimestampFromFilename,
  recomputeLocalFromUtc,
  recomputeUtcFromLocal,
} from "@shared/timestamps";
import { formatError } from "./file-io";
import { CorruptStateError, type JsonStore } from "./json-store";
import { copyIntoWorking, copyOriginalToBackup, deleteImportedSource, reconcileWorkingState, selectExistingCardId } from "./working-files";
import {
  buildMarkdownContent,
  buildOutputPayload,
  buildUniqueSuffixedTargets,
  computeFinalDuration,
  finalizeOutputsAtomically,
  pathsConflict,
  type SaveTargetPaths,
} from "./file-output";

import { applySettingsDraft, buildSettingsDraft, createDefaultSettings, createEmptyState, createSettingsStore, createStateStore, getSystemTimezone, recoverInterruptedCards, summarizeSettings } from "./settings-schema";
import { clearApiKey, hasApiKey, resolveApiKey, writeApiKey } from "./api-keys";
import { type AppLogger, createLogger, serializeError } from "./logger";
import { OperationError } from "./operation-error";
import {
  clearCardResultsFromStep,
  executeCardPipeline,
  resolveGenerateStartStep,
  type CardPipelineContext,
  type PipelineMode,
  type PipelineStartStep,
} from "./card-pipeline";
import {
  TranscriptionSlotPool,
  selectNextQueuedCard,
  type TranscriptionSlot,
} from "./transcription-queue";


// Debug logging is developer-only: on for an unpackaged/dev build, or when an
// explicit MUMBLER_DEBUG=1 is set; off in a packaged release so the firehose
// never reaches an end-user's disk.
const DEBUG_LOGGING_ENABLED = !app.isPackaged || process.env.MUMBLER_DEBUG === "1";

// A managed audio-tool currency check is skipped if a successful one ran within
// this window — keeps the startup check off the network on most launches.
const TOOL_CHECK_STALE_MS = 24 * 60 * 60 * 1000;

interface AppRuntimeState {
  paths: AppPaths | null;
  settings: MumblerSettings | null;
  state: MumblerState | null;
  settingsStore: JsonStore<MumblerSettings> | null;
  stateStore: JsonStore<MumblerState> | null;
  logger: AppLogger;
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

// One active (non-detached) pipeline per card: its abort controller plus the
// transcription slot it holds (null for a metadata-only run). Cancel detaches a
// run by removing it here; the detached run keeps its own reference and so can
// only ever release its *own* slot, never a replacement's.
interface ActivePipelineRun {
  controller: AbortController;
  slot: TranscriptionSlot | null;
}

export class ApplicationRuntime {
  private readonly runtime: AppRuntimeState;
  private readonly transcriptionSlots = new TranscriptionSlotPool();
  private readonly activeRuns = new Map<string, ActivePipelineRun>();
  // In-flight pipeline promises, so shutdown can await them after aborting.
  private readonly activePipelines = new Set<Promise<void>>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private onPipelineProgressCallback: (() => void) | null = null;
  private onDependenciesChangedCallback: (() => void) | null = null;

  private constructor(runtime: AppRuntimeState) {
    this.runtime = runtime;
  }

  static async initialize(): Promise<ApplicationRuntime> {
    const shellReadyAtUtc = Date.now();

    // Resolve the storage root first. An unusable MUMBLER_HOME override is a
    // startup error the convention requires us to report and STOP on, never a
    // silent fallback to the default — and it happens before any logger or store
    // exists (those derive from the very paths we could not resolve), so it
    // surfaces as a paths-less startup diagnostic rather than crashing the
    // process uncaught.
    let paths: AppPaths;
    try {
      paths = getAppPaths();
    } catch (error: unknown) {
      // No usable storage root means no resolved logs directory either, so the
      // diagnostic logger writes into the *default* root's logs dir; createLogger
      // never throws on a missing directory (its append degrades to stderr), so
      // the failure is still recorded somewhere.
      const fallbackLogsDir = join(homedir(), ".mumbler", "logs");
      const logger = createLogger(fallbackLogsDir, { debugEnabled: DEBUG_LOGGING_ENABLED });
      await logger.error("app.startup-failed", "Storage location could not be resolved.", error);
      return new ApplicationRuntime({
        paths: null,
        settings: null,
        state: null,
        settingsStore: null,
        stateStore: null,
        logger,
        startupDiagnostic: {
          title: "Storage Location Could Not Be Resolved",
          message:
            error instanceof Error
              ? error.message
              : "The MUMBLER_HOME override could not be resolved to a usable storage location.",
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
    // launch's lines always land in a single file (createLogger stamps the
    // filename from the current time, so rebuilding it would fork a new file). It
    // is created before ensureDirectories() deliberately: createLogger touches no
    // filesystem until its first append, and that append degrades to stderr
    // without throwing if the directory is missing — so the logger is on hand to
    // record a startup failure on the very path that could not create it.
    const logger = createLogger(paths.logsDir, { debugEnabled: DEBUG_LOGGING_ENABLED });

    const settingsStore = createSettingsStore(paths.settingsPath);
    const stateStore = createStateStore(paths.statePath);

    try {
      await ensureDirectories(paths);

      const settingsLoad = await settingsStore.load();
      const settings = settingsLoad.value;
      // Materialize defaults on first launch so the config file is discoverable
      // and hand-editable. This writes a missing file; it never overwrites an
      // existing valid one (that path stays in load()).
      if (settingsLoad.origin === "created") {
        await settingsStore.save(settings);
      }

      // Resolve whether a Gemini key is available (env-first, then the dedicated
      // secrets file) once, so the snapshot can report presence without async I/O.
      const hasGeminiApiKey = await hasApiKey(
        paths.apiKeysPath,
        ["gemini"],
        undefined,
        makeApiKeyWarn(logger),
      );

      const stateLoad = await stateStore.load();
      const recovered = recoverInterruptedCards(stateLoad.value);
      const reconciliation = await reconcileWorkingState(paths, recovered.state, logger);

      // Persist startup fix-ups (interrupted-card recovery, working-file
      // reconciliation) or a freshly created file — but never rewrite an
      // unchanged, already-good state just because we read it.
      const stateChanged =
        stateLoad.origin === "created" ||
        recovered.recoveredInterruptedCards > 0 ||
        reconciliation.droppedPendingImports > 0 ||
        reconciliation.missingWorkingCards > 0;
      if (stateChanged) {
        await stateStore.save(reconciliation.state);
      }

      await logger.info("app.startup", "Application runtime initialized.", {
        appVersion: app.getVersion(),
        isPackaged: app.isPackaged,
        debugLogging: DEBUG_LOGGING_ENABLED,
        // Key effective configuration, secrets redacted: summarizeSettings reports
        // the API key only as a presence boolean, never the value.
        config: summarizeSettings(settings, paths.outputDir, paths.backupsDir, hasGeminiApiKey),
        cardCount: reconciliation.state.cards.length,
        pendingImportCount: reconciliation.state.pendingImports.length,
        recoveredInterruptedCards: recovered.recoveredInterruptedCards,
        droppedPendingImports: reconciliation.droppedPendingImports,
        missingWorkingCards: reconciliation.missingWorkingCards,
        deletedOrphanedFiles: reconciliation.deletedOrphanedFiles,
        retainedOrphanedFiles: reconciliation.retainedOrphanedFiles,
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
        settingsStore,
        stateStore,
        logger,
        startupDiagnostic: null,
        appWideError: null,
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
      const dependenciesLoad = await dependenciesStore.load();
      if (dependenciesLoad.origin === "created") {
        await dependenciesStore.save(dependenciesLoad.value);
      }
      const toolManager = new ToolManager({
        binDir: paths.binDir,
        downloadsDir: join(paths.workingDir, "tool-downloads"),
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
      // Tool maintenance (auto-download missing required tools, staleness-gated
      // currency check) runs in the background so it never blocks the shell.
      void runtime.startToolMaintenance();
      return runtime;
    } catch (error: unknown) {
      // Record the startup failure in the session log before surfacing it as a
      // diagnostic. The logger was built before any fallible step, so it exists
      // here even when the failure was ensureDirectories() itself — in which case
      // the append simply degrades to stderr.
      await logger.error("app.startup-failed", "Application runtime failed to start.", error);
      return new ApplicationRuntime({
        paths,
        settings: null,
        state: null,
        settingsStore: null,
        stateStore: null,
        logger,
        startupDiagnostic: {
          title:
            error instanceof CorruptStateError
              ? "Saved Data Could Not Be Loaded"
              : "Startup Failed",
          message:
            error instanceof Error
              ? error.message
              : "Unknown startup failure while preparing app storage.",
        },
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

  // Called by the ToolManager whenever dependency state changes (an operation's
  // progress, completion, or failure) so the renderer re-pulls the snapshot.
  emitDependenciesChanged(): void {
    this.onDependenciesChangedCallback?.();
  }

  // Attach the managed-tool controller built during initialize().
  attachToolManager(manager: ToolManager): void {
    this.runtime.toolManager = manager;
  }

  // Background startup maintenance: auto-fetch missing required tools (gated by
  // autoDownloadTools), then a staleness-gated currency check (gated by
  // checkToolUpdates). Both record their own outcomes and never throw, so a
  // failure here never disturbs the shell.
  async startToolMaintenance(): Promise<void> {
    const manager = this.runtime.toolManager;
    const settings = this.runtime.settings;
    if (manager === null || settings === null) {
      return;
    }
    try {
      if (settings.autoDownloadTools) {
        for (const name of manager.missingRequired()) {
          await manager.installTool(name, "provision");
        }
      }
      if (settings.checkToolUpdates && manager.checkIsStale(TOOL_CHECK_STALE_MS)) {
        await manager.checkTools();
      }
    } catch (error: unknown) {
      await this.runtime.logger.warn("tools.maintenance", "Background tool maintenance failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private ensureToolManager(): ToolManager {
    if (this.runtime.toolManager === null) {
      throw new OperationError("Audio tools are unavailable.");
    }
    return this.runtime.toolManager;
  }

  async provisionTool(name: ToolName): Promise<AppSnapshot> {
    await this.ensureToolManager().installTool(name, "provision");
    return this.getSnapshot();
  }

  async updateTool(name: ToolName): Promise<AppSnapshot> {
    await this.ensureToolManager().installTool(name, "update");
    return this.getSnapshot();
  }

  async verifyTool(name: ToolName): Promise<AppSnapshot> {
    await this.ensureToolManager().installTool(name, "verify");
    return this.getSnapshot();
  }

  async checkTools(): Promise<AppSnapshot> {
    await this.ensureToolManager().checkTools();
    return this.getSnapshot();
  }

  async saveToolSettings(
    checkToolUpdates: boolean,
    autoDownloadTools: boolean,
  ): Promise<AppSnapshot> {
    this.ensureReady();
    this.runtime.settings = {
      ...this.runtime.settings!,
      checkToolUpdates,
      autoDownloadTools,
    };
    await this.persistSettings();
    await this.runtime.logger.info("settings.tool-gates", "Updated audio tool settings.", {
      checkToolUpdates,
      autoDownloadTools,
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

  getSnapshot(): AppSnapshot {
    const { paths, settings, state } = this.runtime;

    return {
      appName: app.getName(),
      appVersion: app.getVersion(),
      platform: process.platform,
      isPackaged: app.isPackaged,
      shellReadyAtUtc: this.runtime.shellReadyAtUtc,
      paths,
      settingsSummary:
        settings && paths
          ? summarizeSettings(
              settings,
              paths.outputDir,
              paths.backupsDir,
              this.runtime.hasGeminiApiKey,
            )
          : null,
      queueSummary:
        state === null
          ? null
          : {
              cardCount: state.cards.length,
              pendingImportCount: state.pendingImports.length,
              selectedCardId: state.selectedCardId,
              recoveredInterruptedCards: this.runtime.recoveredInterruptedCards,
            },
      commands: COMMAND_DEFINITIONS,
      startupDiagnostic: this.runtime.startupDiagnostic,
      appWideError: this.runtime.appWideError,
      state,
      dependencies: this.runtime.toolManager?.listStatuses() ?? null,
    };
  }

  async reportRendererError(report: RendererErrorReport): Promise<AppSnapshot> {
    await this.setAppWideError("Unexpected Renderer Error", report.message, {
      source: report.source,
      stack: report.stack,
    });
    return this.getSnapshot();
  }

  async reportMainProcessError(origin: "uncaughtException" | "unhandledRejection", error: unknown): Promise<void> {
    await this.setAppWideError("Unexpected Main Process Error", formatError(error), {
      origin,
      error: serializeError(error),
    });
  }

  async dismissAppWideError(): Promise<AppSnapshot> {
    const title = this.runtime.appWideError?.title ?? null;
    this.runtime.appWideError = null;
    await this.runtime.logger.info("app.error-dismissed", "App-wide error dismissed by user.", {
      dismissedTitle: title,
    });
    return this.getSnapshot();
  }

  async resetState(): Promise<AppSnapshot> {
    const paths = this.runtime.paths ?? getAppPaths();
    const settingsStore = createSettingsStore(paths.settingsPath);
    const stateStore = createStateStore(paths.statePath);
    const settings = createDefaultSettings(getSystemTimezone());
    const state = createEmptyState();

    try {
      await ensureDirectories(paths);
      // Reset is the explicit escape hatch from a corrupt-data halt, so it must
      // never silently destroy prior data — set each store's existing files
      // (canonical + its .bak recovery copy) aside before writing defaults.
      const preservedSettingsFiles = await settingsStore.preserveExistingFiles();
      const preservedStateFiles = await stateStore.preserveExistingFiles();
      await settingsStore.save(settings);
      // Reuse the per-launch session logger rather than building a new one, so a
      // reset keeps writing to the same file as the rest of the launch.
      const logger = this.runtime.logger;
      const reconciliation = await reconcileWorkingState(paths, state, logger);
      await stateStore.save(reconciliation.state);
      await logger.warn("app.reset-state", "Reset settings and state from diagnostic recovery.", {
        workingDir: paths.workingDir,
        preservedSettingsFiles,
        preservedStateFiles,
        deletedOrphanedFiles: reconciliation.deletedOrphanedFiles,
        retainedOrphanedFiles: reconciliation.retainedOrphanedFiles,
      });

      this.runtime.paths = paths;
      this.runtime.settings = settings;
      this.runtime.state = reconciliation.state;
      this.runtime.settingsStore = settingsStore;
      this.runtime.stateStore = stateStore;
      this.runtime.startupDiagnostic = null;
      this.runtime.appWideError = null;
      this.runtime.recoveredInterruptedCards = 0;

      return this.getSnapshot();
    } catch (error: unknown) {
      this.runtime.startupDiagnostic = {
        title: "Reset Failed",
        message: formatError(error),
      };
      throw error;
    }
  }

  getSettingsDraft(): SettingsDraft {
    this.ensureReady();
    return buildSettingsDraft(
      this.runtime.settings!,
      this.runtime.paths!.outputDir,
      this.runtime.paths!.backupsDir,
      this.runtime.hasGeminiApiKey,
    );
  }

  getDefaultPrompts(): MumblerSettings["prompts"] {
    return createDefaultSettings(getSystemTimezone()).prompts;
  }

  async openImportDialog(window: BrowserWindow): Promise<ImportOperationResult> {
    this.ensureReady();

    const result = await dialog.showOpenDialog(window, {
      title: "Import Audio Files",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Audio Files",
          extensions: [
            "mp3",
            "m4a",
            "aac",
            "wav",
            "flac",
            "ogg",
            "oga",
            "aif",
            "aiff",
            "mp4",
          ],
        },
        { name: "All Files", extensions: ["*"] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return {
        snapshot: this.getSnapshot(),
        importedCount: 0,
        failedImports: [],
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
    state.pendingImports = state.pendingImports.map((authoritative) => {
      const draft = draftsById.get(authoritative.id);
      return draft ? applyPendingImportDraft(authoritative, draft) : authoritative;
    });
    await this.persistState();
    return this.getSnapshot();
  }

  async confirmPendingImports(items: PendingImportReviewItem[]): Promise<AppSnapshot> {
    this.ensureReady();
    const state = this.runtime.state!;
    const paths = this.runtime.paths!;

    const byId = new Map(items.map((item) => [item.id, item]));
    const pendingImports = [...state.pendingImports];
    const cardsToAdd: MumblerCard[] = [];

    for (const pendingImport of pendingImports) {
      const candidate = byId.get(pendingImport.id);
      if (candidate === undefined) {
        throw new OperationError(`Pending import ${pendingImport.originalFilename} is missing review data.`);
      }

      // Overlay only the review-editable fields onto the authoritative item; the
      // working/original paths always come from server-side state below.
      const merged = applyPendingImportDraft(pendingImport, candidate);
      const timestamps = buildConfirmedTimestamps(
        merged.localTimestampText,
        merged.timezone,
        merged.utcTimestampText,
      );
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
      if (merged.copyToBackupOnConfirm) {
        const backupDir = this.runtime.settings!.backupDirectory ?? paths.backupsDir;
        try {
          const backupPath = await copyOriginalToBackup(pendingImport.originalSourcePath, backupDir);
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
        }
      }

      if (merged.deleteOriginalOnConfirm) {
        if (merged.copyToBackupOnConfirm && !backupSucceeded) {
          await this.runtime.logger.warn(
            "import.delete-original",
            "Skipped deleting original because backup copy failed.",
            { originalSourcePath: pendingImport.originalSourcePath },
          );
        } else {
          try {
            await deleteImportedSource(pendingImport.originalSourcePath);
          } catch (error: unknown) {
            await this.runtime.logger.warn("import.delete-original", "Failed to delete original after confirm.", {
              originalSourcePath: pendingImport.originalSourcePath,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }

    state.pendingImports = [];
    state.cards = [...state.cards, ...cardsToAdd].sort((left, right) =>
      left.timestamps.effectiveUtc - right.timestamps.effectiveUtc,
    );
    state.selectedCardId = cardsToAdd[0]?.id ?? state.selectedCardId;

    await this.persistState();
    await this.runtime.logger.info(
      "import.confirm-review",
      "Confirmed pending imports into queue.",
      { addedCards: cardsToAdd.length },
    );

    return this.getSnapshot();
  }

  async cancelPendingImports(): Promise<AppSnapshot> {
    this.ensureReady();
    const pendingImports = [...this.runtime.state!.pendingImports];

    for (const pendingImport of pendingImports) {
      try {
        await rm(pendingImport.workingFilePath, { force: true });
      } catch (error: unknown) {
        await this.runtime.logger.warn("import.cancel-cleanup", "Failed to delete working file on cancel.", {
          workingFilePath: pendingImport.workingFilePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.runtime.state!.pendingImports = [];
    await this.persistState();
    await this.runtime.logger.info("import.cancelled", "Cancelled pending imports.", {
      cancelledCount: pendingImports.length,
    });

    return this.getSnapshot();
  }

  async selectCard(cardId: string | null): Promise<AppSnapshot> {
    this.ensureReady();
    const state = this.runtime.state!;

    if (cardId !== null && !state.cards.some((card) => card.id === cardId)) {
      throw new OperationError("Selected card no longer exists.");
    }

    state.selectedCardId = cardId;
    await this.persistState();
    // Selection is a high-frequency navigation action (arrow keys), so it is
    // traced at debug — developer-only — rather than info, per the volume rules.
    await this.runtime.logger.debug("card.select", "Selected card.", { cardId });
    return this.getSnapshot();
  }

  async duplicateCard(cardId: string): Promise<AppSnapshot> {
    this.ensureReady();
    const state = this.runtime.state!;
    const paths = this.runtime.paths!;
    const source = state.cards.find((card) => card.id === cardId);

    if (source === undefined) {
      throw new OperationError("Card to duplicate does not exist.");
    }

    if (
      source.status === "Queued" ||
      source.status === "Transcribing" ||
      source.status === "Generating Metadata"
    ) {
      throw new OperationError("Cannot duplicate a card while it is being processed.");
    }

    const duplicateSourcePath = await copyIntoWorking(
      source.sourceFilePath,
      paths.workingDir,
      basename(source.sourceFilePath),
    );
    const duplicate = createDuplicatedCard(source, duplicateSourcePath);
    state.cards = [...state.cards, duplicate].sort((left, right) =>
      left.timestamps.effectiveUtc - right.timestamps.effectiveUtc,
    );
    state.selectedCardId = duplicate.id;

    await this.persistState();
    await this.runtime.logger.info("card.duplicate", "Duplicated card for independent trimming.", {
      sourceCardId: source.id,
      duplicateCardId: duplicate.id,
      duplicateSourcePath,
    });

    return this.getSnapshot();
  }

  async updateCardTrim(cardId: string, trim: CardTrim): Promise<AppSnapshot> {
    this.ensureReady();
    const state = this.runtime.state!;
    const card = state.cards.find((entry) => entry.id === cardId);

    if (card === undefined) {
      throw new OperationError("Card to update does not exist.");
    }

    if (
      card.status === "Queued" ||
      card.status === "Transcribing" ||
      card.status === "Generating Metadata"
    ) {
      throw new OperationError("Cannot change trim markers while this card is being processed.");
    }

    const normalizedTrim = normalizeTrim(trim, card.durationSec);
    const trimDecision = await analyzeTrimDecision(
      card.sourceFilePath,
      normalizedTrim,
      card.durationSec,
    );

    card.trim = normalizedTrim;
    card.trimDecision = trimDecision;
    card.timestamps = applyFrontTrimOffset(card.timestamps, normalizedTrim.frontMarkerSec ?? 0);
    card.transcription = { text: null };
    card.metadata = { structured: null, title: null, slug: null };
    card.ai = { transcription: null, structured: null, title: null, slug: null };
    card.status = "Imported";
    card.activeStep = null;
    card.lastError = null;
    card.updatedAtUtc = Date.now();

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

    return this.getSnapshot();
  }

  async getCardMediaSource(cardId: string): Promise<string> {
    this.ensureReady();
    const card = this.runtime.state!.cards.find((entry) => entry.id === cardId);

    if (card === undefined) {
      throw new OperationError("Card media source no longer exists.");
    }

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

  async generateCardStep(cardId: string, target: GenerateTarget): Promise<AppSnapshot> {
    this.ensureReady();
    const card = this.runtime.state!.cards.find((entry) => entry.id === cardId);

    if (card === undefined) {
      throw new OperationError("Card to generate does not exist.");
    }

    this.assertCardCanStartPipeline(card);

    if ((await this.resolveGeminiApiKey()) === null) {
      throw new OperationError("Gemini API key is not configured.");
    }

    const startStep = resolveGenerateStartStep(card, target);
    clearCardResultsFromStep(card, startStep);
    card.status = "Imported";
    card.activeStep = null;
    card.queuedMode = null;
    card.queuedAtUtc = null;
    card.lastError = null;
    card.updatedAtUtc = Date.now();
    await this.startOrEnqueueCard(cardId, "generate", startStep);
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
    const run = this.activeRuns.get(cardId);
    const isQueued = oldCard.status === "Queued";
    const isActive = run !== undefined;

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
      updatedAtUtc: Date.now(),
    };

    // Detach the run so its later unwind can't touch a replacement's bookkeeping,
    // then free its slot immediately so the user can generate again at once.
    this.activeRuns.delete(cardId);

    await this.persistState();

    if (run !== undefined) {
      run.controller.abort();
      // Releasing the run's own slot is idempotent and admits any queued cards
      // into the freed capacity. A no-op if the slot was already released (e.g.
      // the card was cancelled during the metadata phase).
      await this.releaseSlotAndDrain(run.slot);
    }

    await this.runtime.logger.info("pipeline.cancel-immediate", "Immediately detached and cancelled card pipeline.", {
      cardId,
      failedStep,
    });
    return this.getSnapshot();
  }

  private async startOrEnqueueCard(
    cardId: string,
    mode: PipelineMode,
    requestedStartStep?: PipelineStartStep,
  ): Promise<void> {
    const state = this.runtime.state!;
    const settings = this.runtime.settings!;
    const card = state.cards.find((entry) => entry.id === cardId);

    if (card === undefined) {
      throw new OperationError("Card to process does not exist.");
    }

    this.assertCardCanStartPipeline(card);

    if ((await this.resolveGeminiApiKey()) === null) {
      throw new OperationError("Gemini API key is not configured.");
    }

    const startStep = requestedStartStep ?? "transcription";
    const needsTranscriptionSlot = startStep === "transcription";
    const slotAvailable = this.transcriptionSlots.inUse < settings.concurrencyLimit;

    if (!needsTranscriptionSlot || slotAvailable) {
      const slot = needsTranscriptionSlot ? this.transcriptionSlots.acquire() : null;
      card.status = startStep === "transcription" ? "Transcribing" : "Generating Metadata";
      card.activeStep = startStep;
      card.queuedMode = null;
      card.queuedAtUtc = null;
      card.updatedAtUtc = Date.now();
      await this.persistState();
      this.spawnCardPipeline(cardId, startStep, mode, slot);
      return;
    }

    card.status = "Queued";
    card.queuedMode = mode;
    card.queuedAtUtc = Date.now();
    card.activeStep = null;
    card.updatedAtUtc = Date.now();
    await this.persistState();
    await this.runtime.logger.info(
      "pipeline.queued",
      "Queued card; awaiting transcription slot.",
      {
        cardId,
        mode,
        activeSlots: this.transcriptionSlots.inUse,
        concurrencyLimit: settings.concurrencyLimit,
      },
    );
  }

  private spawnCardPipeline(
    cardId: string,
    startStep: PipelineStartStep,
    mode: PipelineMode,
    slot: TranscriptionSlot | null,
  ): void {
    const controller = new AbortController();
    const run: ActivePipelineRun = { controller, slot };
    this.activeRuns.set(cardId, run);

    // Resolve the key just-in-time inside the spawned chain (env-first, then the
    // secrets file), so a key cleared between enqueue and start is caught here and
    // surfaces as a normal pipeline "not configured" error on the card. An empty
    // string is passed when nothing resolves; the pipeline's own guard rejects it.
    const pipeline = (async () => {
      const apiKey = (await this.resolveGeminiApiKey()) ?? "";
      const ctx: CardPipelineContext = {
        state: this.runtime.state!,
        settings: this.runtime.settings!,
        paths: this.runtime.paths!,
        logger: this.runtime.logger,
        signal: controller.signal,
        apiKey,
        persistState: () => this.persistState(),
        releaseTranscriptionSlot: () => this.releaseSlotAndDrain(slot),
      };
      await executeCardPipeline(cardId, startStep, mode, ctx);
    })()
      .catch(async (error: unknown) => {
        await this.runtime.logger.error(
          "pipeline.unhandled",
          "Unhandled pipeline error.",
          error,
          { cardId, mode, startStep },
        );
      })
      .finally(() => {
        void this.finalizeCardPipeline(cardId, run);
      });

    // Track the chain so shutdown() can await it after aborting.
    this.activePipelines.add(pipeline);
    void pipeline.finally(() => {
      this.activePipelines.delete(pipeline);
    });
  }

  // Frees one transcription slot (if still held) and admits any queued cards into
  // the freed capacity. Idempotent on the slot, so every release path — mid-run
  // after transcription, the pipeline's finally, finalize, and cancel — can call
  // it freely without double-counting.
  private async releaseSlotAndDrain(slot: TranscriptionSlot | null): Promise<void> {
    if (slot === null || !slot.held) {
      return;
    }
    slot.release();
    await this.tryStartNextQueuedCards();
  }

  private async finalizeCardPipeline(cardId: string, run: ActivePipelineRun): Promise<void> {
    try {
      // Only the still-current run for this card may touch shared bookkeeping. A
      // run detached by cancel was replaced (or removed) in activeRuns, so this
      // identity check stops an orphaned pipeline from clobbering its replacement;
      // the orphan's own slot was already freed on its release path.
      if (this.activeRuns.get(cardId) !== run) {
        return;
      }
      this.activeRuns.delete(cardId);
      await this.releaseSlotAndDrain(run.slot);
    } catch (error: unknown) {
      await this.runtime.logger.error(
        "pipeline.finalize-failed",
        "Failed to finalize card pipeline state.",
        error,
        { cardId },
      );
    }
  }

  private async tryStartNextQueuedCards(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    if (this.runtime.state === null || this.runtime.settings === null) {
      return;
    }

    const settings = this.runtime.settings;
    const state = this.runtime.state;

    // Cards with an active run are excluded from selection: spawnCardPipeline
    // registers the run synchronously, but a card's status flips to "Transcribing"
    // only later inside the pipeline. Without this, one drain pass with capacity
    // for several cards would re-select — and double-spawn — the card it just
    // started. We seed the set from active runs and extend it in lockstep as we
    // spawn, rather than rebuilding it from activeRuns on every iteration.
    const excludedCardIds = new Set(this.activeRuns.keys());
    while (this.transcriptionSlots.inUse < settings.concurrencyLimit) {
      const next = selectNextQueuedCard(state.cards, excludedCardIds);

      if (next === null || next.queuedMode === null) {
        return;
      }

      const slot = this.transcriptionSlots.acquire();
      this.spawnCardPipeline(next.id, "transcription", next.queuedMode, slot);
      excludedCardIds.add(next.id);
    }
  }

  async pickOutputDirectory(window: BrowserWindow): Promise<string | null> {
    this.ensureReady();

    const result = await dialog.showOpenDialog(window, {
      title: "Choose Output Directory",
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

  async saveSettingsDraft(draft: SettingsDraft): Promise<AppSnapshot> {
    this.ensureReady();

    const nextSettings = applySettingsDraft(this.runtime.settings!, draft);
    this.runtime.settings = nextSettings;

    await this.persistSettings();
    await this.runtime.logger.info("settings.save", "Updated application settings.", {
      outputDirectory: nextSettings.outputDirectory,
      backupDirectory: nextSettings.backupDirectory,
      transcriptionModel: nextSettings.transcriptionModel,
      metadataModel: nextSettings.metadataModel,
      defaultTimezone: nextSettings.defaultTimezone,
      timestampPatternCount: nextSettings.timestampPatterns.length,
      previewSnippetSeconds: nextSettings.previewSnippetSeconds,
      concurrencyLimit: nextSettings.concurrencyLimit,
    });

    await this.tryStartNextQueuedCards();

    return this.getSnapshot();
  }

  // Store a new Gemini API key in the dedicated 0600 secrets file (never the
  // settings store), refresh the cached presence flag, then admit any queued
  // cards that were waiting only on a missing key. The raw key never enters the
  // snapshot or the log — only the resulting presence boolean is reported.
  async setGeminiApiKey(apiKey: string): Promise<AppSnapshot> {
    this.ensureReady();
    const trimmed = apiKey.trim();
    if (trimmed.length === 0) {
      throw new OperationError("Enter a Gemini API key.");
    }

    await writeApiKey(this.runtime.paths!.apiKeysPath, ["gemini"], trimmed, this.apiKeyWarn());
    await this.refreshHasGeminiApiKey();
    await this.runtime.logger.info("settings.api-key-set", "Stored Gemini API key.", {
      hasGeminiApiKey: this.runtime.hasGeminiApiKey,
    });

    await this.tryStartNextQueuedCards();
    return this.getSnapshot();
  }

  // Remove the stored key from the secrets file. An environment-supplied key, if
  // present, still resolves afterward — so hasGeminiApiKey may remain true.
  async clearGeminiApiKey(): Promise<AppSnapshot> {
    this.ensureReady();
    await clearApiKey(this.runtime.paths!.apiKeysPath, ["gemini"], this.apiKeyWarn());
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
    return resolveApiKey(this.runtime.paths!.apiKeysPath, ["gemini"], undefined, this.apiKeyWarn());
  }

  private async refreshHasGeminiApiKey(): Promise<void> {
    this.runtime.hasGeminiApiKey = await hasApiKey(
      this.runtime.paths!.apiKeysPath,
      ["gemini"],
      undefined,
      this.apiKeyWarn(),
    );
  }

  private apiKeyWarn(): (message: string, details: Record<string, unknown>) => void {
    return makeApiKeyWarn(this.runtime.logger);
  }

  async drainQueuedCards(): Promise<void> {
    await this.tryStartNextQueuedCards();
  }

  // Idempotent graceful shutdown, called from the app's before-quit handler.
  // Stops new pipelines, aborts in-flight ones and lets them unwind, then drains
  // the store write-queues so the canonical files are current before the process
  // exits. Cards aborted mid-step are left for startup recovery to mark as
  // resumable Errors, so no work is silently lost or half-written.
  async shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) {
      return this.shutdownPromise;
    }
    this.shutdownPromise = (async () => {
      this.shuttingDown = true;
      for (const run of this.activeRuns.values()) {
        run.controller.abort();
      }
      await Promise.allSettled([...this.activePipelines]);
      await this.runtime.stateStore?.flush();
      await this.runtime.settingsStore?.flush();
      await this.runtime.logger.info("app.shutdown", "Graceful shutdown complete.", {
        reason: "before-quit",
        cardCount: this.runtime.state?.cards.length ?? 0,
      });
    })();
    return this.shutdownPromise;
  }

  async chooseOutputDirectory(window: BrowserWindow): Promise<AppSnapshot> {
    const outputDirectory = await this.pickOutputDirectory(window);
    if (outputDirectory === null) {
      return this.getSnapshot();
    }

    const previousOutputDirectory = this.runtime.settings!.outputDirectory;
    this.runtime.settings!.outputDirectory = outputDirectory;

    try {
      await this.persistSettings();
    } catch (error: unknown) {
      this.runtime.settings!.outputDirectory = previousOutputDirectory;
      throw error;
    }

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

    const settings = this.runtime.settings!;
    const state = this.runtime.state!;
    const logger = this.runtime.logger;
    const card = state.cards.find((entry) => entry.id === cardId);

    if (card === undefined) {
      throw new OperationError("Card to save does not exist.");
    }

    if (card.status !== "Ready to Save") {
      throw new OperationError("Only cards in Ready to Save state can be finalized.");
    }

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
    });

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
        return {
          kind: "conflict",
          snapshot: this.getSnapshot(),
          audioPath: initialTargets.audioPath,
          jsonPath: initialTargets.jsonPath,
          markdownPath: initialTargets.markdownPath,
        };
      }

      if (resolution === "cancel") {
        await logger.info("save.cancelled", "Save cancelled by user.", { cardId });
        return {
          kind: "cancelled",
          snapshot: this.getSnapshot(),
        };
      }

      const targetPaths: SaveTargetPaths =
        resolution === "suffix"
          ? await buildUniqueSuffixedTargets(outputDirectory, baseName, extension)
          : initialTargets;

      const finalProfile = await probeAudioProfile(finalAudio.filePath);
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

      await finalizeOutputsAtomically({
        sourceAudioPath: finalAudio.filePath,
        targets: targetPaths,
        overwrite: resolution === "overwrite",
        jsonContent: `${JSON.stringify(outputPayload, null, 2)}\n`,
        markdownContent,
      });

      await logger.info("save.completed", "Saved finalized audio and metadata.", {
        cardId,
        audioTargetPath: targetPaths.audioPath,
        jsonTargetPath: targetPaths.jsonPath,
        markdownTargetPath: targetPaths.markdownPath,
        overwrite: resolution === "overwrite",
      });

      await this.discardWorkingCard(card);
      return {
        kind: "saved",
        snapshot: this.getSnapshot(),
        audioPath: targetPaths.audioPath,
        jsonPath: targetPaths.jsonPath,
        markdownPath: targetPaths.markdownPath,
      };
    } finally {
      await finalAudio.cleanup();
    }
  }

  async removeCard(cardId: string): Promise<AppSnapshot> {
    this.ensureReady();
    const state = this.runtime.state!;
    const card = state.cards.find((entry) => entry.id === cardId);

    if (card === undefined) {
      throw new OperationError("Card to remove does not exist.");
    }

    if (card.status === "Transcribing" || card.status === "Generating Metadata") {
      throw new OperationError("Cannot remove a card while it is being processed.");
    }

    try {
      await rm(card.sourceFilePath, { force: true });
      await this.runtime.logger.info("card.remove", "Deleted card working audio and removed card.", {
        cardId,
        sourceFilePath: card.sourceFilePath,
      });
    } catch (error: unknown) {
      await this.runtime.logger.warn(
        "card.remove",
        "Working audio could not be deleted; removing card anyway.",
        {
          cardId,
          sourceFilePath: card.sourceFilePath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }

    state.cards = state.cards.filter((entry) => entry.id !== cardId);
    await this.persistState();
    return this.getSnapshot();
  }

  private async importPaths(
    sourcePaths: string[],
    importSource: ImportSource,
  ): Promise<ImportOperationResult> {
    this.ensureReady();
    const failedImports: FailedImport[] = [];
    const uniquePaths = [...new Set(sourcePaths.filter((path) => path.trim().length > 0))];
    let importedCount = 0;

    for (const sourcePath of uniquePaths) {
      try {
        await this.importSinglePath(sourcePath, importSource);
        importedCount += 1;
      } catch (error: unknown) {
        failedImports.push({
          sourcePath,
          message: error instanceof Error ? error.message : "Unknown import failure.",
        });
        await this.runtime.logger.error(
          "import.failed",
          "Failed to import source file.",
          error,
          { sourcePath, importSource },
        );
      }
    }

    if (importedCount > 0) {
      await this.persistState();
      await this.runtime.logger.info("import.completed", "Imported files into pending review.", {
        importedCount,
        failedCount: failedImports.length,
        importSource,
      });
    }

    return {
      snapshot: this.getSnapshot(),
      importedCount,
      failedImports,
    };
  }

  private async importSinglePath(sourcePath: string, importSource: ImportSource): Promise<void> {
    const paths = this.runtime.paths!;
    const settings = this.runtime.settings!;
    const sourceStats = await stat(sourcePath);

    if (!sourceStats.isFile()) {
      throw new Error("Only files can be imported.");
    }

    const originalFilename = basename(sourcePath);
    const workingFilePath = await copyIntoWorking(sourcePath, paths.workingDir, originalFilename);

    await this.runtime.logger.debug("import.file", "Staged file to working storage.", {
      originalFilename,
      fileSizeBytes: sourceStats.size,
      importSource,
    });

    const filenameStem = basename(originalFilename, extname(originalFilename));
    const parsed = parseTimestampFromFilename(filenameStem, settings.timestampPatterns);
    const utcResult =
      parsed.localTimestampText.length > 0
        ? recomputeUtcFromLocal(parsed.localTimestampText, settings.defaultTimezone)
        : { utcMs: null, error: null };

    const pendingImport: PendingImportReviewItem = {
      id: nanoid(),
      originalFilename,
      importSource,
      originalSourcePath: sourcePath,
      workingFilePath,
      fileSizeBytes: sourceStats.size,
      localTimestampText: parsed.localTimestampText,
      timezone: settings.defaultTimezone,
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

  private assertCardCanStartPipeline(card: MumblerCard): void {
    if (
      card.status === "Queued" ||
      card.status === "Transcribing" ||
      card.status === "Generating Metadata" ||
      this.activeRuns.has(card.id)
    ) {
      throw new OperationError("This card is already being processed.");
    }
  }

  private async persistState(): Promise<void> {
    const state = this.runtime.state!;
    const normalized =
      state.cards.length === 0 && state.pendingImports.length === 0
        ? createEmptyState()
        : {
            ...state,
            selectedCardId: selectExistingCardId(state),
            updatedAtUtc: Date.now(),
          };

    this.runtime.state = normalized;
    // The store serializes writes, so overlapping persistState calls can never
    // interleave on disk.
    await this.runtime.stateStore!.save(normalized);

    if (this.onPipelineProgressCallback !== null) {
      this.onPipelineProgressCallback();
    }
  }

  private async persistSettings(): Promise<void> {
    await this.runtime.settingsStore!.save(this.runtime.settings!);
  }

  private async setAppWideError(
    title: string,
    message: string,
    details?: unknown,
  ): Promise<void> {
    this.runtime.appWideError = {
      title,
      message,
    };

    await this.runtime.logger.error("app.unhandled", title, new Error(message), details);
  }

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

    await this.persistState();
  }
}

// Resolve the single storage root per the storage-path-conventions, and the
// reference implementation other TS apps mirror. The root is MUMBLER_HOME when
// that variable is set and non-empty (trimmed); otherwise the default
// `<home>/.mumbler`. An override is expanded (a leading `~`/`~/` and `$VAR` env
// references), then made absolute against the HOME directory — never
// process.cwd(), so the override can never reintroduce a working-directory
// dependence. A value that cannot be made into a usable absolute path is a
// reported startup error, never a silent fallback to the default.
//
// Pure and home-injectable so it is unit-testable without touching electron or
// the real environment.
export function resolveStorageRoot(
  rawOverride: string | undefined,
  homeDirectory: string,
): string {
  const trimmed = rawOverride?.trim() ?? "";
  if (trimmed.length === 0) {
    return join(homeDirectory, ".mumbler");
  }

  let value = expandEnvReferences(trimmed).trim();

  // An override that is set but expands to nothing — an unset `$VAR`/`%VAR%`,
  // say — is a misconfiguration. Rejecting it is the "reported startup error,
  // not a silent fallback" the convention requires, and it avoids silently
  // collapsing the root onto the bare home directory.
  if (value.length === 0) {
    throw new Error(
      `MUMBLER_HOME is set to "${rawOverride}" but expands to an empty path ` +
        `(an unset $VAR/%VAR%?). Set it to a usable directory, or unset it to use ~/.mumbler.`,
    );
  }

  // Expand a leading `~` / `~/` (and `~\` on Windows) to the home directory.
  if (value === "~") {
    value = homeDirectory;
  } else if (value.startsWith("~/") || value.startsWith("~\\")) {
    value = join(homeDirectory, value.slice(2));
  }

  // A still-relative value is resolved against the HOME directory, not the
  // working directory, so launch context can never move the storage root.
  // resolve() always returns an absolute path, so no further guard is needed.
  return isAbsolute(value) ? resolve(value) : resolve(homeDirectory, value);
}

// Expand `$VAR` / `${VAR}` (POSIX) and `%VAR%` (Windows) references against the
// current environment. An undefined reference expands to empty, matching shell
// behavior, rather than being left as a literal that would later become a
// directory name.
function expandEnvReferences(value: string): string {
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "")
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => process.env[name] ?? "")
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_match, name: string) => process.env[name] ?? "");
}

function getAppPaths(): AppPaths {
  const homeDir = resolveStorageRoot(process.env.MUMBLER_HOME, homedir());

  return {
    homeDir,
    settingsPath: join(homeDir, "settings.json"),
    statePath: join(homeDir, "state.json"),
    apiKeysPath: join(homeDir, "api-keys.json"),
    logsDir: join(homeDir, "logs"),
    workingDir: join(homeDir, "working"),
    outputDir: join(homeDir, "output"),
    backupsDir: join(homeDir, "backups"),
    binDir: join(homeDir, "bin"),
    dependenciesPath: join(homeDir, "dependencies.json"),
  };
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
  await mkdir(paths.homeDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });
  await mkdir(paths.workingDir, { recursive: true });
  await mkdir(paths.binDir, { recursive: true });
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
      throw new OperationError(normalizedUtc.error);
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
export function applyPendingImportDraft(
  authoritative: PendingImportReviewItem,
  draft: PendingImportReviewItem,
): PendingImportReviewItem {
  return {
    ...authoritative,
    localTimestampText: draft.localTimestampText,
    timezone: draft.timezone,
    utcTimestampText: draft.utcTimestampText,
    deleteOriginalOnConfirm: draft.deleteOriginalOnConfirm,
    copyToBackupOnConfirm: draft.copyToBackupOnConfirm,
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
  const confirmedDate = parseConfirmedLocalTimestamp(timestamps.confirmedLocal);
  if (confirmedDate === null) {
    return timestamps;
  }

  const effectiveDate = new Date(confirmedDate.getTime() + frontTrimOffsetSec * 1000);
  const effectiveBaseText = formatLocalDateTime(effectiveDate);
  const effectiveUtcResult = recomputeUtcFromLocal(effectiveBaseText, timestamps.timezone);

  return {
    ...timestamps,
    frontTrimOffsetSec,
    effectiveLocal:
      frontTrimOffsetSec % 1 === 0
        ? effectiveBaseText
        : `${effectiveBaseText}.${Math.round((frontTrimOffsetSec % 1) * 10)}`,
    effectiveUtc:
      effectiveUtcResult.utcMs ?? timestamps.confirmedUtc,
  };
}

function parseConfirmedLocalTimestamp(value: string): Date | null {
  const match =
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})$/.exec(
      value,
    );

  if (!match?.groups) {
    return null;
  }

  return new Date(
    Date.UTC(
      Number(match.groups.year),
      Number(match.groups.month) - 1,
      Number(match.groups.day),
      Number(match.groups.hour),
      Number(match.groups.minute),
      Number(match.groups.second),
    ),
  );
}

function formatLocalDateTime(value: Date): string {
  return `${value.getUTCFullYear().toString().padStart(4, "0")}-${`${value.getUTCMonth() + 1}`.padStart(2, "0")}-${`${value.getUTCDate()}`.padStart(2, "0")} ${`${value.getUTCHours()}`.padStart(2, "0")}:${`${value.getUTCMinutes()}`.padStart(2, "0")}:${`${value.getUTCSeconds()}`.padStart(2, "0")}`;
}
