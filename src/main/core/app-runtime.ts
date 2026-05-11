import { app, BrowserWindow, dialog, shell } from "electron";
import {
  access,
  copyFile,
  mkdir,
  rm,
  stat,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";

import { nanoid } from "nanoid";

import {
  type CardTrim,
  type AppPaths,
  type AppSnapshot,
  type FailedImport,
  type ImportOperationResult,
  type ImportSource,
  type MumblerCard,
  type MumblerSettings,
  type MumblerState,
  type PendingImportReviewItem,
  type RendererErrorReport,
  type RegenerateTarget,
  type SaveCardResult,
  type SaveConflictResolution,
  type SettingsDraft,
} from "@shared/app-shell";
import { COMMAND_DEFINITIONS } from "@shared/commands";
import {
  analyzeTrimDecision,
  assertFfmpegToolingPresent,
  prepareAudioForTranscription,
  probeAudioProfile,
} from "./audio-tools";
import {
  formatUtcForDisplay,
  formatUtcMarker,
  isSupportedTimezone,
  normalizeUtcMs,
  parseTimestampFromFilename,
  recomputeLocalFromUtc,
  recomputeUtcFromLocal,
} from "@shared/timestamps";
import { formatError, uniquePathInDirectory, writeJsonFile } from "./file-io";
import { copyOriginalToBackup, deleteImportedSource, reconcileWorkingState, selectExistingCardId } from "./working-files";
import {
  buildMarkdownContent,
  buildOutputPayload,
  buildUniqueSuffixedTargets,
  computeFinalDuration,
  finalizeOutputsAtomically,
  pathsConflict,
  type SaveTargetPaths,
} from "./file-output";

import { applySettingsDraft, buildSettingsDraft, createDefaultSettings, createEmptyState, decodeGeminiApiKey, getSecretsForRedaction, getSystemTimezone, loadSettings, loadState, summarizeSettings } from "./settings-schema";
import { type AppLogger, createLogger, pruneOldLogs, serializeError } from "./logger";
import {
  clearCardResultsFromStep,
  executeCardPipeline,
  resolvePipelineStartStep,
  resolveRegenerateStartStep,
  type CardPipelineContext,
  type PipelineMode,
  type PipelineStartStep,
} from "./card-pipeline";


interface AppRuntimeState {
  paths: AppPaths | null;
  settings: MumblerSettings | null;
  state: MumblerState | null;
  logger: AppLogger | null;
  startupDiagnostic: AppSnapshot["startupDiagnostic"];
  appWideError: AppSnapshot["appWideError"];
  recoveredInterruptedCards: number;
  shellReadyAtUtc: number;
}

export class ApplicationRuntime {
  private readonly runtime: AppRuntimeState;
  private readonly activeCardOperations = new Set<string>();
  private readonly activeCardAbortControllers = new Map<string, AbortController>();
  private persistQueue: Promise<void> = Promise.resolve();
  private onPipelineProgressCallback: (() => void) | null = null;

  private constructor(runtime: AppRuntimeState) {
    this.runtime = runtime;
  }

  static async initialize(): Promise<ApplicationRuntime> {
    const shellReadyAtUtc = Date.now();
    const paths = getAppPaths();

    try {
      await ensureDirectories(paths);
      assertFfmpegToolingPresent();

      const settings = await loadSettings(paths);
      const logger = createLogger(paths.logsDir, getSecretsForRedaction(settings));
      await pruneOldLogs(paths.logsDir);

      const { state, recoveredInterruptedCards } = await loadState(paths);
      const reconciliation = await reconcileWorkingState(paths, state, logger);
      await writeJsonFile(paths.statePath, reconciliation.state);
      await logger.info("app.startup", "Application runtime initialized.", {
        cardCount: reconciliation.state.cards.length,
        pendingImportCount: reconciliation.state.pendingImports.length,
        recoveredInterruptedCards,
        droppedPendingImports: reconciliation.droppedPendingImports,
        missingWorkingCards: reconciliation.missingWorkingCards,
        deletedOrphanedFiles: reconciliation.deletedOrphanedFiles,
        retainedOrphanedFiles: reconciliation.retainedOrphanedFiles,
      });

      if (recoveredInterruptedCards > 0) {
        await logger.warn(
          "app.startup-recovery",
          "Recovered interrupted cards from previous session.",
          { recoveredInterruptedCards },
        );
      }

      const runtime = new ApplicationRuntime({
        paths,
        settings,
        state: reconciliation.state,
        logger,
        startupDiagnostic: null,
        appWideError: null,
        recoveredInterruptedCards,
        shellReadyAtUtc,
      });
      await runtime.drainQueuedCards();
      return runtime;
    } catch (error: unknown) {
      return new ApplicationRuntime({
        paths,
        settings: null,
        state: null,
        logger: null,
        startupDiagnostic: {
          title: "Startup Failed",
          message:
            error instanceof Error
              ? error.message
              : "Unknown startup failure while preparing app storage.",
        },
        appWideError: null,
        recoveredInterruptedCards: 0,
        shellReadyAtUtc,
      });
    }
  }

  onPipelineProgress(callback: () => void): void {
    this.onPipelineProgressCallback = callback;
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
        settings && paths ? summarizeSettings(settings, paths.outputDir, paths.backupsDir) : null,
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
    await this.runtime.logger?.info("app.error-dismissed", "App-wide error dismissed by user.", {
      dismissedTitle: title,
    });
    return this.getSnapshot();
  }

  async resetState(): Promise<AppSnapshot> {
    const paths = this.runtime.paths ?? getAppPaths();
    const settings = createDefaultSettings(getSystemTimezone());
    const state = createEmptyState();

    try {
      await ensureDirectories(paths);
      await writeJsonFile(paths.settingsPath, settings);
      await writeJsonFile(paths.statePath, state);
      const logger = createLogger(paths.logsDir, getSecretsForRedaction(settings));
      await pruneOldLogs(paths.logsDir);
      const reconciliation = await reconcileWorkingState(paths, state, logger);
      await writeJsonFile(paths.statePath, reconciliation.state);
      await logger.warn("app.reset-state", "Reset settings and state from diagnostic recovery.", {
        workingDir: paths.workingDir,
        deletedOrphanedFiles: reconciliation.deletedOrphanedFiles,
        retainedOrphanedFiles: reconciliation.retainedOrphanedFiles,
      });

      this.runtime.paths = paths;
      this.runtime.settings = settings;
      this.runtime.state = reconciliation.state;
      this.runtime.logger = logger;
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
      throw new Error("Pending import drafts are out of date. Reopen the timestamp review.");
    }

    state.pendingImports = items.map((item) => normalizePendingImport(item));
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
        throw new Error(`Pending import ${pendingImport.originalFilename} is missing review data.`);
      }

      const normalized = normalizePendingImport(candidate);
      const timestamps = buildConfirmedTimestamps(
        normalized.localTimestampText,
        normalized.timezone,
        normalized.utcTimestampText,
      );
      let probed: Awaited<ReturnType<typeof probeAudioProfile>>;
      try {
        probed = await probeAudioProfile(pendingImport.workingFilePath);
        await this.runtime.logger!.debug("audio.probe", "Probed audio profile for imported file.", {
          filename: pendingImport.originalFilename,
          durationSec: probed.durationSec,
          formatName: probed.audioProfile?.formatName,
          codecName: probed.audioProfile?.codecName,
          bitRateKbps: probed.audioProfile?.bitRateKbps,
          sampleRateHz: probed.audioProfile?.sampleRateHz,
          channels: probed.audioProfile?.channels,
        });
      } catch (error: unknown) {
        await this.runtime.logger!.warn("audio.probe", "Failed to probe imported audio metadata.", {
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
      if (pendingImport.copyToBackupOnConfirm) {
        const backupDir = this.runtime.settings!.backupDirectory ?? paths.backupsDir;
        try {
          const backupPath = await copyOriginalToBackup(pendingImport.originalSourcePath, backupDir);
          await this.runtime.logger!.info("import.backup-original", "Copied original to backup directory.", {
            originalSourcePath: pendingImport.originalSourcePath,
            backupPath,
          });
        } catch (error: unknown) {
          backupSucceeded = false;
          await this.runtime.logger!.warn("import.backup-original", "Failed to copy original to backup directory.", {
            originalSourcePath: pendingImport.originalSourcePath,
            backupDir,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (pendingImport.deleteOriginalOnConfirm) {
        if (pendingImport.copyToBackupOnConfirm && !backupSucceeded) {
          await this.runtime.logger!.warn(
            "import.delete-original",
            "Skipped deleting original because backup copy failed.",
            { originalSourcePath: pendingImport.originalSourcePath },
          );
        } else {
          try {
            await deleteImportedSource(pendingImport.originalSourcePath);
          } catch (error: unknown) {
            await this.runtime.logger!.warn("import.delete-original", "Failed to delete original after confirm.", {
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
    await this.runtime.logger!.info(
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
        await this.runtime.logger!.warn("import.cancel-cleanup", "Failed to delete working file on cancel.", {
          workingFilePath: pendingImport.workingFilePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.runtime.state!.pendingImports = [];
    await this.persistState();
    await this.runtime.logger!.info("import.cancelled", "Cancelled pending imports.", {
      cancelledCount: pendingImports.length,
    });

    return this.getSnapshot();
  }

  async selectCard(cardId: string | null): Promise<AppSnapshot> {
    this.ensureReady();
    const state = this.runtime.state!;

    if (cardId !== null && !state.cards.some((card) => card.id === cardId)) {
      throw new Error("Selected card no longer exists.");
    }

    state.selectedCardId = cardId;
    await this.persistState();
    return this.getSnapshot();
  }

  async duplicateCard(cardId: string): Promise<AppSnapshot> {
    this.ensureReady();
    const state = this.runtime.state!;
    const source = state.cards.find((card) => card.id === cardId);

    if (source === undefined) {
      throw new Error("Card to duplicate does not exist.");
    }

    if (
      source.status === "Queued" ||
      source.status === "Transcribing" ||
      source.status === "Generating Metadata"
    ) {
      throw new Error("Cannot duplicate a card while it is being processed.");
    }

    const duplicate = createDuplicatedCard(source);
    state.cards = [...state.cards, duplicate].sort((left, right) =>
      left.timestamps.effectiveUtc - right.timestamps.effectiveUtc,
    );
    state.selectedCardId = duplicate.id;

    await this.persistState();
    await this.runtime.logger!.info("card.duplicate", "Duplicated card for independent trimming.", {
      sourceCardId: source.id,
      duplicateCardId: duplicate.id,
    });

    return this.getSnapshot();
  }

  async updateCardTrim(cardId: string, trim: CardTrim): Promise<AppSnapshot> {
    this.ensureReady();
    const state = this.runtime.state!;
    const card = state.cards.find((entry) => entry.id === cardId);

    if (card === undefined) {
      throw new Error("Card to update does not exist.");
    }

    if (
      card.status === "Queued" ||
      card.status === "Transcribing" ||
      card.status === "Generating Metadata"
    ) {
      throw new Error("Cannot change trim markers while this card is being processed.");
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
    await this.runtime.logger!.info("trim.analyze", "Analyzed trim decision.", {
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
      throw new Error("Card media source no longer exists.");
    }

    return `mumbler-asset://local?path=${encodeURIComponent(card.sourceFilePath)}`;
  }

  async transcribeCard(cardId: string): Promise<AppSnapshot> {
    this.ensureReady();
    await this.startOrEnqueueCard(cardId, "transcribe");
    return this.getSnapshot();
  }

  async retryCard(cardId: string): Promise<AppSnapshot> {
    this.ensureReady();
    await this.startOrEnqueueCard(cardId, "retry");
    return this.getSnapshot();
  }

  async cancelCardProcessing(cardId: string): Promise<AppSnapshot> {
    this.ensureReady();
    const card = this.runtime.state!.cards.find((entry) => entry.id === cardId);

    if (card === undefined) {
      throw new Error("Card to cancel does not exist.");
    }

    if (card.status === "Queued") {
      const failedStep =
        card.queuedMode === null ? "transcription" : resolvePipelineStartStep(card, card.queuedMode);
      card.status = "Cancelled";
      card.activeStep = null;
      card.queuedMode = null;
      card.queuedAtUtc = null;
      card.lastError = {
        message: "AI work cancelled by user.",
        occurredAtUtc: Date.now(),
        failedStep,
      };
      card.updatedAtUtc = Date.now();
      await this.persistState();
      await this.runtime.logger!.info("pipeline.cancel-queued", "Cancelled queued card.", {
        cardId,
        failedStep,
      });
      return this.getSnapshot();
    }

    const controller = this.activeCardAbortControllers.get(cardId);
    if (controller === undefined) {
      throw new Error("This card is not being processed.");
    }

    controller.abort();
    await this.runtime.logger!.info("pipeline.cancel-requested", "Requested card pipeline cancellation.", {
      cardId,
      activeStep: card.activeStep,
    });
    return this.getSnapshot();
  }

  async regenerateCardStep(cardId: string, target: RegenerateTarget): Promise<AppSnapshot> {
    this.ensureReady();
    const card = this.runtime.state!.cards.find((entry) => entry.id === cardId);

    if (card === undefined) {
      throw new Error("Card to regenerate does not exist.");
    }

    this.assertCardCanStartPipeline(card);

    if (decodeGeminiApiKey(this.runtime.settings!.geminiApiKeyObfuscated).length === 0) {
      throw new Error("Gemini API key is not configured.");
    }

    const startStep = resolveRegenerateStartStep(card, target);
    clearCardResultsFromStep(card, startStep);
    card.status = "Imported";
    card.activeStep = null;
    card.lastError = null;
    card.updatedAtUtc = Date.now();
    await this.persistState();
    await this.startOrEnqueueCard(
      cardId,
      startStep === "transcription" ? "transcribe" : "regenerate",
      startStep,
    );
    await this.runtime.logger!.info("pipeline.regenerate", "Started dependency-aware regeneration.", {
      cardId,
      requestedStep: target,
      startStep,
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
      throw new Error("Card to process does not exist.");
    }

    this.assertCardCanStartPipeline(card);

    if (decodeGeminiApiKey(settings.geminiApiKeyObfuscated).length === 0) {
      throw new Error("Gemini API key is not configured.");
    }

    const startStep = requestedStartStep ?? resolvePipelineStartStep(card, mode === "regenerate" ? "transcribe" : mode);
    const needsTranscriptionSlot = startStep === "transcription";
    const slotAvailable = this.activeCardOperations.size < settings.concurrencyLimit;

    if (!needsTranscriptionSlot || slotAvailable) {
      if (needsTranscriptionSlot) {
        this.activeCardOperations.add(cardId);
      }
      this.spawnCardPipeline(cardId, startStep, mode);
      return;
    }

    if (mode === "regenerate") {
      throw new Error("Regeneration from transcription could not be queued.");
    }

    card.status = "Queued";
    card.queuedMode = mode;
    card.queuedAtUtc = Date.now();
    card.activeStep = null;
    card.updatedAtUtc = Date.now();
    await this.persistState();
    await this.runtime.logger!.info(
      "pipeline.queued",
      "Queued card; awaiting transcription slot.",
      {
        cardId,
        mode,
        activeSlots: this.activeCardOperations.size,
        concurrencyLimit: settings.concurrencyLimit,
      },
    );
  }

  private spawnCardPipeline(
    cardId: string,
    startStep: PipelineStartStep,
    mode: PipelineMode,
  ): void {
    const controller = new AbortController();
    this.activeCardAbortControllers.set(cardId, controller);
    const ctx: CardPipelineContext = {
      state: this.runtime.state!,
      settings: this.runtime.settings!,
      paths: this.runtime.paths!,
      logger: this.runtime.logger!,
      activeCardOperations: this.activeCardOperations,
      signal: controller.signal,
      persistState: () => this.persistState(),
      onTranscriptionSlotReleased: () => this.tryStartNextQueuedCards(),
    };

    void executeCardPipeline(cardId, startStep, mode, ctx)
      .catch(async (error: unknown) => {
        this.activeCardOperations.delete(cardId);
        await this.runtime.logger?.error(
          "pipeline.unhandled",
          "Unhandled pipeline error.",
          error,
          { cardId, mode, startStep },
        );
      })
      .finally(() => {
        this.activeCardAbortControllers.delete(cardId);
        this.activeCardOperations.delete(cardId);
        void this.tryStartNextQueuedCards();
      });
  }

  private async tryStartNextQueuedCards(): Promise<void> {
    if (this.runtime.state === null || this.runtime.settings === null) {
      return;
    }

    const settings = this.runtime.settings;
    const state = this.runtime.state;

    while (this.activeCardOperations.size < settings.concurrencyLimit) {
      const next = state.cards
        .filter(
          (card) =>
            card.status === "Queued" &&
            card.queuedMode !== null &&
            card.queuedAtUtc !== null,
        )
        .sort((a, b) => (a.queuedAtUtc ?? 0) - (b.queuedAtUtc ?? 0))[0];

      if (next === undefined || next.queuedMode === null) {
        return;
      }

      this.activeCardOperations.add(next.id);
      this.spawnCardPipeline(next.id, resolvePipelineStartStep(next, next.queuedMode), next.queuedMode);
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
  }

  async saveSettingsDraft(draft: SettingsDraft): Promise<AppSnapshot> {
    this.ensureReady();

    const nextSettings = applySettingsDraft(this.runtime.settings!, draft);
    const logger = createLogger(this.runtime.paths!.logsDir, getSecretsForRedaction(nextSettings));
    this.runtime.settings = nextSettings;
    this.runtime.logger = logger;

    await this.persistSettings();
    await logger.info("settings.save", "Updated application settings.", {
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

  async drainQueuedCards(): Promise<void> {
    await this.tryStartNextQueuedCards();
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

    await this.runtime.logger!.info("settings.output-directory", "Updated output directory.", {
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
    const logger = this.runtime.logger!;
    const card = state.cards.find((entry) => entry.id === cardId);

    if (card === undefined) {
      throw new Error("Card to save does not exist.");
    }

    if (card.status !== "Ready to Save") {
      throw new Error("Only cards in Ready to Save state can be finalized.");
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
      throw new Error("Card to remove does not exist.");
    }

    if (card.status === "Transcribing" || card.status === "Generating Metadata") {
      throw new Error("Cannot remove a card while it is being processed.");
    }

    try {
      await rm(card.sourceFilePath, { force: true });
      await this.runtime.logger!.info("card.remove", "Deleted card working audio and removed card.", {
        cardId,
        sourceFilePath: card.sourceFilePath,
      });
    } catch (error: unknown) {
      await this.runtime.logger!.warn(
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
        await this.runtime.logger!.error(
          "import.failed",
          "Failed to import source file.",
          error,
          { sourcePath, importSource },
        );
      }
    }

    if (importedCount > 0) {
      await this.persistState();
      await this.runtime.logger!.info("import.completed", "Imported files into pending review.", {
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
    const workingFilePath = await uniquePathInDirectory(paths.workingDir, originalFilename);

    try {
      await copyFile(sourcePath, workingFilePath);
      await access(workingFilePath, fsConstants.R_OK);
    } catch (error: unknown) {
      await rm(workingFilePath, { force: true });
      throw new Error(
        `Failed to create a readable working copy for ${originalFilename}: ${formatError(error)}`,
      );
    }

    await this.runtime.logger!.debug("import.file", "Staged file to working storage.", {
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
      throw new Error("Application runtime is not ready.");
    }
  }

  private assertCardCanStartPipeline(card: MumblerCard): void {
    if (
      card.status === "Queued" ||
      card.status === "Transcribing" ||
      card.status === "Generating Metadata" ||
      this.activeCardOperations.has(card.id) ||
      this.activeCardAbortControllers.has(card.id)
    ) {
      throw new Error("This card is already being processed.");
    }
  }

  private async persistState(): Promise<void> {
    const work = async (): Promise<void> => {
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
      await writeJsonFile(this.runtime.paths!.statePath, normalized);

      if (this.onPipelineProgressCallback !== null) {
        this.onPipelineProgressCallback();
      }
    };

    this.persistQueue = this.persistQueue.then(work, work);
    return this.persistQueue;
  }

  private async persistSettings(): Promise<void> {
    await writeJsonFile(this.runtime.paths!.settingsPath, this.runtime.settings);
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

    if (this.runtime.logger !== null) {
      await this.runtime.logger.error("app.unhandled", title, new Error(message), details);
    }
  }

  private async discardWorkingCard(card: MumblerCard): Promise<void> {
    this.runtime.state!.cards = this.runtime.state!.cards.filter((entry) => entry.id !== card.id);
    try {
      await rm(card.sourceFilePath, { force: true });
    } catch (error: unknown) {
      await this.runtime.logger!.warn(
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

function getAppPaths(): AppPaths {
  const homeDir = process.env.MUMBLER_HOME ?? join(homedir(), ".mumbler");

  return {
    homeDir,
    settingsPath: join(homeDir, "settings.json"),
    statePath: join(homeDir, "state.json"),
    logsDir: join(homeDir, "logs"),
    workingDir: join(homeDir, "working"),
    outputDir: join(homeDir, "output"),
    backupsDir: join(homeDir, "backups"),
  };
}

async function ensureDirectories(paths: AppPaths): Promise<void> {
  await mkdir(paths.homeDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });
  await mkdir(paths.workingDir, { recursive: true });
}

function buildConfirmedTimestamps(
  localTimestampText: string,
  timezone: string,
  utcTimestampText: string,
): MumblerCard["timestamps"] {
  if (!isSupportedTimezone(timezone)) {
    throw new Error(`Invalid timezone: ${timezone}`);
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
      throw new Error(normalizedUtc.error);
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

  throw new Error("Pending import timestamps are incomplete.");
}

function normalizePendingImport(item: PendingImportReviewItem): PendingImportReviewItem {
  return {
    ...item,
    createdAtUtc: normalizeUtcMs(item.createdAtUtc),
    updatedAtUtc: Date.now(),
  };
}

function createDuplicatedCard(source: MumblerCard): MumblerCard {
  return {
    ...source,
    id: nanoid(),
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
    throw new Error("Front trim must be earlier than back trim.");
  }

  if (durationSec !== null && frontMarkerSec !== null && frontMarkerSec > durationSec) {
    throw new Error("Front trim cannot exceed audio duration.");
  }

  if (durationSec !== null && backMarkerSec !== null && backMarkerSec > durationSec) {
    throw new Error("Back trim cannot exceed audio duration.");
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
    throw new Error("Trim markers must be positive numbers.");
  }

  return Math.round(value * 10) / 10;
}

function applyFrontTrimOffset(
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
