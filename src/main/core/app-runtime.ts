import { app, BrowserWindow, dialog, shell } from "electron";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

import { nanoid } from "nanoid";

import {
  type CardTrim,
  type AppPaths,
  type AppSnapshot,
  type CardProcessingStep,
  type FailedImport,
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
} from "@shared/app-shell";
import { COMMAND_DEFINITIONS } from "@shared/commands";
import {
  analyzeTrimDecision,
  assertFfmpegToolingPresent,
  prepareAudioForTranscription,
  probeAudioProfile,
} from "./audio-tools";
import {
  generateTextWithGemini,
  getInlineAudioSafetyLimitBytes,
  getInlineRequestLimitBytes,
  isRetryableGeminiError,
  transcribeWithGemini,
} from "./gemini-adapter";
import {
  getSupportedTimezones,
  isSupportedTimezone,
  normalizeUtcMarkerText,
  nowUtcMarker,
  parseTimestampFromFilename,
  recomputeLocalFromUtc,
  recomputeUtcFromLocal,
} from "@shared/timestamps";
import { formatError, uniquePathInDirectory, writeJsonFile } from "./file-io";
import { moveImportedSourceToTrash, reconcileWorkingState } from "./working-files";
import {
  buildOutputPayload,
  buildUniqueSuffixedTargets,
  computeFinalDuration,
  finalizeOutputsAtomically,
  pathsConflict,
} from "./file-output";

import { applySettingsDraft, buildSettingsDraft, createDefaultSettings, createEmptyState, decodeGeminiApiKey, getSecretsForRedaction, getSystemTimezone, loadSettings, loadState, summarizeSettings } from "./settings-schema";

const LOG_RETENTION_DAYS = 30;

interface AppLogger {
  debug(op: string, message: string, details?: unknown): Promise<void>;
  info(op: string, message: string, details?: unknown): Promise<void>;
  warn(op: string, message: string, details?: unknown): Promise<void>;
  error(op: string, message: string, error: unknown, details?: unknown): Promise<void>;
}


interface AppRuntimeState {
  paths: AppPaths | null;
  settings: MumblerSettings | null;
  state: MumblerState | null;
  logger: AppLogger | null;
  startupDiagnostic: AppSnapshot["startupDiagnostic"];
  appWideError: AppSnapshot["appWideError"];
  recoveredInterruptedCards: number;
  shellReadyAtUtc: string;
  supportedTimezones: string[];
}

export class ApplicationRuntime {
  private readonly runtime: AppRuntimeState;
  private readonly activeCardOperations = new Set<string>();
  private persistQueue: Promise<void> = Promise.resolve();
  private onPipelineProgressCallback: (() => void) | null = null;

  private constructor(runtime: AppRuntimeState) {
    this.runtime = runtime;
  }

  static async initialize(): Promise<ApplicationRuntime> {
    const shellReadyAtUtc = nowUtcMarker();
    const supportedTimezones = getSupportedTimezones();
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
        trashedOrphanedFiles: reconciliation.trashedOrphanedFiles,
        retainedOrphanedFiles: reconciliation.retainedOrphanedFiles,
      });

      if (recoveredInterruptedCards > 0) {
        await logger.warn(
          "app.startup-recovery",
          "Recovered interrupted cards from previous session.",
          { recoveredInterruptedCards },
        );
      }

      return new ApplicationRuntime({
        paths,
        settings,
        state: reconciliation.state,
        logger,
        startupDiagnostic: null,
        appWideError: null,
        recoveredInterruptedCards,
        shellReadyAtUtc,
        supportedTimezones,
      });
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
        supportedTimezones,
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
      settingsSummary: settings ? summarizeSettings(settings) : null,
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
      supportedTimezones: this.runtime.supportedTimezones,
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
    this.runtime.appWideError = null;
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
        trashedOrphanedFiles: reconciliation.trashedOrphanedFiles,
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
    return buildSettingsDraft(this.runtime.settings!);
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
    const settings = this.runtime.settings!;

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
      const probed = await probeAudioProfile(pendingImport.workingFilePath).catch(async (error) => {
        await this.runtime.logger!.warn("audio.probe", "Failed to probe imported audio metadata.", {
          filePath: pendingImport.workingFilePath,
          error: error instanceof Error ? error.message : String(error),
        });

        return {
          durationSec: null,
          audioProfile: null,
        };
      });

      cardsToAdd.push({
        id: nanoid(),
        originalFilename: pendingImport.originalFilename,
        importSource: pendingImport.importSource,
        sourceFilePath: pendingImport.workingFilePath,
        audioProfile: probed.audioProfile,
        durationSec: probed.durationSec,
        fileSizeBytes: pendingImport.fileSizeBytes,
        language: settings.defaultLanguage,
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
          title: null,
          slug: null,
        },
        ai: {
          transcription: null,
          title: null,
          slug: null,
        },
        status: "Imported",
        activeStep: null,
        lastError: null,
        createdAtUtc: nowUtcMarker(),
        updatedAtUtc: nowUtcMarker(),
      });
    }

    state.pendingImports = [];
    state.cards = [...state.cards, ...cardsToAdd].sort((left, right) =>
      left.timestamps.effectiveUtc.localeCompare(right.timestamps.effectiveUtc),
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

    if (source.status === "Transcribing" || source.status === "Generating Metadata") {
      throw new Error("Cannot duplicate a card while it is being processed.");
    }

    const duplicate = createDuplicatedCard(source);
    state.cards = [...state.cards, duplicate].sort((left, right) =>
      left.timestamps.effectiveUtc.localeCompare(right.timestamps.effectiveUtc),
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

    if (card.status === "Transcribing" || card.status === "Generating Metadata") {
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
    card.metadata = { title: null, slug: null };
    card.ai = { transcription: null, title: null, slug: null };
    card.status = "Imported";
    card.activeStep = null;
    card.lastError = null;
    card.updatedAtUtc = nowUtcMarker();

    state.cards.sort((left, right) =>
      left.timestamps.effectiveUtc.localeCompare(right.timestamps.effectiveUtc),
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

  async updateCardLanguage(cardId: string, language: string): Promise<AppSnapshot> {
    this.ensureReady();
    const state = this.runtime.state!;
    const settings = this.runtime.settings!;
    const card = state.cards.find((entry) => entry.id === cardId);

    if (card === undefined) {
      throw new Error("Card to update does not exist.");
    }

    if (card.status === "Transcribing" || card.status === "Generating Metadata") {
      throw new Error("Cannot change language while this card is being processed.");
    }

    const normalizedLanguage = language.trim();
    if (normalizedLanguage.length === 0) {
      throw new Error("Language is required.");
    }

    if (!settings.languages.includes(normalizedLanguage)) {
      throw new Error("Choose a language from the configured language list.");
    }

    if (card.language === normalizedLanguage) {
      return this.getSnapshot();
    }

    card.language = normalizedLanguage;
    clearCardResults(card);
    await this.persistState();
    await this.runtime.logger!.info("card.language", "Updated card language and cleared results.", {
      cardId,
      language: normalizedLanguage,
    });

    return this.getSnapshot();
  }

  async getCardMediaSource(cardId: string): Promise<string> {
    this.ensureReady();
    const card = this.runtime.state!.cards.find((entry) => entry.id === cardId);

    if (card === undefined) {
      throw new Error("Card media source no longer exists.");
    }

    return pathToFileURL(card.sourceFilePath).href;
  }

  async transcribeCard(cardId: string): Promise<AppSnapshot> {
    return this.runCardPipeline(cardId, "transcribe");
  }

  async retryCard(cardId: string): Promise<AppSnapshot> {
    return this.runCardPipeline(cardId, "retry");
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

  async saveSettingsDraft(draft: SettingsDraft): Promise<AppSnapshot> {
    this.ensureReady();

    const nextSettings = applySettingsDraft(this.runtime.settings!, draft);
    const logger = createLogger(this.runtime.paths!.logsDir, getSecretsForRedaction(nextSettings));
    this.runtime.settings = nextSettings;
    this.runtime.logger = logger;

    await this.persistSettings();
    await logger.info("settings.save", "Updated application settings.", {
      outputDirectory: nextSettings.outputDirectory,
      transcriptionModel: nextSettings.transcriptionModel,
      metadataModel: nextSettings.metadataModel,
      defaultLanguage: nextSettings.defaultLanguage,
      defaultTimezone: nextSettings.defaultTimezone,
      languageCount: nextSettings.languages.length,
      timestampPatternCount: nextSettings.timestampPatterns.length,
      previewSnippetSeconds: nextSettings.previewSnippetSeconds,
      concurrencyLimit: nextSettings.concurrencyLimit,
    });

    return this.getSnapshot();
  }

  async chooseOutputDirectory(window: BrowserWindow): Promise<AppSnapshot> {
    const outputDirectory = await this.pickOutputDirectory(window);
    if (outputDirectory === null) {
      return this.getSnapshot();
    }

    this.runtime.settings!.outputDirectory = outputDirectory;
    await this.persistSettings();
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

    if (this.activeCardOperations.has(cardId)) {
      throw new Error("Cannot save a card while it is being processed.");
    }

    const outputDirectory = settings.outputDirectory;
    if (outputDirectory === null || outputDirectory.trim().length === 0) {
      throw new Error("Choose an output directory before saving.");
    }

    const finalAudio = await prepareAudioForTranscription({
      sourceFilePath: card.sourceFilePath,
      workingDir: this.runtime.paths!.workingDir,
      trim: card.trim,
      trimDecision: card.trimDecision,
      durationSec: card.durationSec,
      audioProfile: card.audioProfile,
    });

    try {
      const extension = extname(finalAudio.filePath) || extname(card.sourceFilePath);
      const baseName = `${card.timestamps.effectiveUtc}-${card.metadata.slug}`;
      const initialTargets = {
        audioPath: join(outputDirectory, `${baseName}${extension}`),
        jsonPath: join(outputDirectory, `${baseName}.json`),
      };

      const conflictExists = await pathsConflict(initialTargets.audioPath, initialTargets.jsonPath);
      if (conflictExists && resolution === undefined) {
        await logger.info("save.conflict", "Output path conflict detected, awaiting resolution.", {
          cardId,
          audioPath: initialTargets.audioPath,
          jsonPath: initialTargets.jsonPath,
        });
        return {
          kind: "conflict",
          snapshot: this.getSnapshot(),
          audioPath: initialTargets.audioPath,
          jsonPath: initialTargets.jsonPath,
        };
      }

      if (resolution === "cancel") {
        await logger.info("save.cancelled", "Save cancelled by user.", { cardId });
        return {
          kind: "cancelled",
          snapshot: this.getSnapshot(),
        };
      }

      const targetPaths =
        resolution === "suffix"
          ? await buildUniqueSuffixedTargets(outputDirectory, baseName, extension)
          : initialTargets;

      const finalProfile = await probeAudioProfile(finalAudio.filePath);
      const finalDurationSec = computeFinalDuration(card, finalProfile.durationSec);
      const finalizedAtUtc = nowUtcMarker();
      const outputPayload = buildOutputPayload({
        card,
        finalProfile: finalProfile.audioProfile,
        finalDurationSec,
        finalizedAtUtc,
      });

      await finalizeOutputsAtomically({
        sourceAudioPath: finalAudio.filePath,
        audioTargetPath: targetPaths.audioPath,
        jsonTargetPath: targetPaths.jsonPath,
        overwrite: resolution === "overwrite",
        jsonContent: `${JSON.stringify(outputPayload, null, 2)}\n`,
      });

      await logger.info("save.completed", "Saved finalized audio and metadata.", {
        cardId,
        audioTargetPath: targetPaths.audioPath,
        jsonTargetPath: targetPaths.jsonPath,
        overwrite: resolution === "overwrite",
      });

      await this.discardWorkingCard(card);
      return {
        kind: "saved",
        snapshot: this.getSnapshot(),
        audioPath: targetPaths.audioPath,
        jsonPath: targetPaths.jsonPath,
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

    if (this.activeCardOperations.has(cardId)) {
      throw new Error("Cannot remove a card while it is being processed.");
    }

    await shell.trashItem(card.sourceFilePath);
    await this.runtime.logger!.info("card.remove", "Moved card audio to trash and removed card.", {
      cardId,
      sourceFilePath: card.sourceFilePath,
    });

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

    try {
      await moveImportedSourceToTrash(sourcePath, paths.workingDir);
    } catch (error: unknown) {
      await rm(workingFilePath, { force: true });
      throw error;
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
        : { utcTimestampText: "", error: null };

    const pendingImport: PendingImportReviewItem = {
      id: nanoid(),
      originalFilename,
      importSource,
      workingFilePath,
      fileSizeBytes: sourceStats.size,
      localTimestampText: parsed.localTimestampText,
      timezone: settings.defaultTimezone,
      utcTimestampText: utcResult.error === null ? utcResult.utcTimestampText : "",
      parseStatus: parsed.parseStatus,
      createdAtUtc: nowUtcMarker(),
      updatedAtUtc: nowUtcMarker(),
    };

    this.runtime.state!.pendingImports.push(pendingImport);
  }

  private ensureReady(): void {
    if (this.runtime.paths === null || this.runtime.settings === null || this.runtime.state === null) {
      throw new Error("Application runtime is not ready.");
    }
  }

  private async runCardPipeline(
    cardId: string,
    mode: "transcribe" | "retry",
  ): Promise<AppSnapshot> {
    this.ensureReady();

    const state = this.runtime.state!;
    const settings = this.runtime.settings!;
    const logger = this.runtime.logger!;
    const card = state.cards.find((entry) => entry.id === cardId);

    if (card === undefined) {
      throw new Error("Card to process does not exist.");
    }

    if (this.activeCardOperations.has(cardId)) {
      throw new Error("This card is already being processed.");
    }

    if (this.activeCardOperations.size >= settings.concurrencyLimit) {
      throw new Error(
        `Concurrency limit reached (${settings.concurrencyLimit}). Wait for another card to finish first.`,
      );
    }

    const apiKey = decodeGeminiApiKey(settings.geminiApiKeyObfuscated);
    if (apiKey.length === 0) {
      throw new Error("Gemini API key is not configured.");
    }

    const startStep = resolvePipelineStartStep(card, mode);
    await logger.info("pipeline.start", "Starting card pipeline.", {
      cardId,
      mode,
      startStep,
    });
    let activeStep: Exclude<CardProcessingStep, null> = startStep;

    this.activeCardOperations.add(cardId);

    try {
      if (startStep === "transcription") {
        clearCardResults(card);
        await this.setCardStepState(card, "Transcribing", "transcription");

        const trimDecision =
          card.trimDecision ??
          (await analyzeTrimDecision(card.sourceFilePath, card.trim, card.durationSec));
        card.trimDecision = trimDecision;
        card.updatedAtUtc = nowUtcMarker();
        await this.persistState();

        const preparedAudio = await prepareAudioForTranscription({
          sourceFilePath: card.sourceFilePath,
          workingDir: this.runtime.paths!.workingDir,
          trim: card.trim,
          trimDecision,
          durationSec: card.durationSec,
          audioProfile: card.audioProfile,
        });

        try {
          await logger.info("pipeline.audio-input", "Prepared audio for Gemini transcription.", {
            cardId,
            transportCandidate:
              (await stat(preparedAudio.filePath)).size <= getInlineAudioSafetyLimitBytes()
                ? "inline"
                : "files-api",
            inlineSafetyLimitBytes: getInlineAudioSafetyLimitBytes(),
            inlineRequestLimitBytes: getInlineRequestLimitBytes(),
            sourceFilePath: card.sourceFilePath,
            preparedFilePath: preparedAudio.filePath,
            preparedMimeType: preparedAudio.mimeType,
            wasDerived: preparedAudio.wasDerived,
            trimDecision: trimDecision.kind,
          });

          const transcriptionResult = await this.executeWithRetry({
            cardId,
            step: "transcription",
            op: "gemini.transcription",
            execute: () =>
              transcribeWithGemini({
                apiKey,
                filePath: preparedAudio.filePath,
                mimeType: preparedAudio.mimeType,
                model: settings.transcriptionModel,
                language: card.language,
                timeoutMs: settings.timeouts.transcriptionMs,
              }),
          });

          card.transcription.text = transcriptionResult.text;
          card.ai.transcription = {
            provider: "gemini",
            model: transcriptionResult.modelVersion ?? settings.transcriptionModel,
            generatedAtUtc: nowUtcMarker(),
          };
          card.updatedAtUtc = nowUtcMarker();

          await logger.info("pipeline.transcription-complete", "Completed Gemini transcription.", {
            cardId,
            modelVersion: transcriptionResult.modelVersion,
            transport: transcriptionResult.transport,
            usageMetadata: transcriptionResult.usageMetadata,
          });
        } finally {
          await preparedAudio.cleanup();
        }

        activeStep = "title";
      }

      if (activeStep === "title") {
        await this.setCardStepState(card, "Generating Metadata", "title");
        const titlePrompt = renderPromptTemplate(settings.prompts.title, {
          transcript: card.transcription.text ?? "",
          title: "",
          language: card.language,
        });
        const titleResult = await this.executeWithRetry({
          cardId,
          step: "title",
          op: "gemini.title",
          execute: () =>
            generateTextWithGemini({
              apiKey,
              prompt: titlePrompt,
              model: settings.metadataModel,
              timeoutMs: settings.timeouts.titleMs,
            }),
        });

        card.metadata.title = sanitizeTitle(titleResult.text);
        card.ai.title = {
          provider: "gemini",
          model: titleResult.modelVersion ?? settings.metadataModel,
          generatedAtUtc: nowUtcMarker(),
        };
        card.updatedAtUtc = nowUtcMarker();
        await this.persistState();
        await logger.info("pipeline.title-complete", "Generated title metadata.", {
          cardId,
          modelVersion: titleResult.modelVersion,
          usageMetadata: titleResult.usageMetadata,
        });

        activeStep = "slug";
      }

      if (activeStep === "slug") {
        await this.setCardStepState(card, "Generating Metadata", "slug");
        const slugPrompt = renderPromptTemplate(settings.prompts.slug, {
          transcript: card.transcription.text ?? "",
          title: card.metadata.title ?? "",
          language: card.language,
        });
        const slugResult = await this.executeWithRetry({
          cardId,
          step: "slug",
          op: "gemini.slug",
          execute: () =>
            generateTextWithGemini({
              apiKey,
              prompt: slugPrompt,
              model: settings.metadataModel,
              timeoutMs: settings.timeouts.slugMs,
            }),
        });

        card.metadata.slug = sanitizeSlug(slugResult.text);
        if (card.metadata.slug.length === 0) {
          throw new Error("Generated slug was empty after sanitization.");
        }
        card.ai.slug = {
          provider: "gemini",
          model: slugResult.modelVersion ?? settings.metadataModel,
          generatedAtUtc: nowUtcMarker(),
        };
        card.status = "Ready to Save";
        card.activeStep = null;
        card.lastError = null;
        card.updatedAtUtc = nowUtcMarker();

        await this.persistState();
        await logger.info("pipeline.slug-complete", "Generated slug metadata.", {
          cardId,
          modelVersion: slugResult.modelVersion,
          usageMetadata: slugResult.usageMetadata,
        });
      }
    } catch (error: unknown) {
      card.status = "Error";
      card.activeStep = null;
      card.lastError = {
        message: getCardErrorMessage(error),
        occurredAtUtc: nowUtcMarker(),
        failedStep: activeStep,
      };
      card.updatedAtUtc = nowUtcMarker();

      await this.persistState();
      await logger.error("pipeline.failed", "Card pipeline failed.", error, {
        cardId,
        failedStep: activeStep,
        status: card.status,
      });
    } finally {
      this.activeCardOperations.delete(cardId);
    }

    return this.getSnapshot();
  }

  private async setCardStepState(
    card: MumblerCard,
    status: Extract<MumblerCard["status"], "Transcribing" | "Generating Metadata">,
    step: Exclude<CardProcessingStep, null>,
  ): Promise<void> {
    card.status = status;
    card.activeStep = step;
    card.lastError = null;
    card.updatedAtUtc = nowUtcMarker();
    await this.persistState();
  }

  private async executeWithRetry<T>(params: {
    cardId: string;
    step: Exclude<CardProcessingStep, null>;
    op: string;
    execute: () => Promise<T>;
  }): Promise<T> {
    const { retryPolicy } = this.runtime.settings!;
    const logger = this.runtime.logger!;

    let attempt = 1;
    while (true) {
      try {
        return await params.execute();
      } catch (error: unknown) {
        const retryable = isRetryableGeminiError(error);
        const exhausted = attempt >= retryPolicy.maxRetries;

        await logger.warn(params.op, "Gemini step attempt failed.", {
          cardId: params.cardId,
          step: params.step,
          attempt,
          retryable,
          exhausted,
          error: error instanceof Error ? error.message : String(error),
        });

        if (!retryable || exhausted) {
          throw error;
        }

        const delayMs = computeRetryDelayMs(attempt, retryPolicy);
        await logger.debug(params.op, "Retrying Gemini step after delay.", {
          cardId: params.cardId,
          step: params.step,
          nextAttempt: attempt + 1,
          delayMs,
        });
        await sleep(delayMs);
        attempt += 1;
      }
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
              updatedAtUtc: nowUtcMarker(),
            };

      this.runtime.state = normalized;
      await writeJsonFile(this.runtime.paths!.statePath, normalized);

      if (this.activeCardOperations.size > 0 && this.onPipelineProgressCallback !== null) {
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
      await shell.trashItem(card.sourceFilePath);
    } catch (error: unknown) {
      await this.runtime.logger!.warn(
        "card.cleanup",
        "Saved card was removed from the queue, but working audio could not be trashed.",
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
  };
}

async function ensureDirectories(paths: AppPaths): Promise<void> {
  await mkdir(paths.homeDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });
  await mkdir(paths.workingDir, { recursive: true });
  await mkdir(join(paths.workingDir, "trash-staging"), { recursive: true });
}

function createLogger(logsDir: string, secrets: string[]): AppLogger {
  const write = async (
    level: "debug" | "info" | "warn" | "error",
    op: string,
    message: string,
    details?: unknown,
    error?: unknown,
  ): Promise<void> => {
    const filePath = join(logsDir, `${formatUtcDate(new Date())}.log`);
    const payload = {
      time: nowUtcMarker(),
      level,
      op,
      message,
      ...(details === undefined ? {} : { details }),
      ...(error === undefined ? {} : { error: serializeError(error) }),
    };

    const sanitized = redactSecrets(JSON.stringify(payload), secrets);
    await writeFile(filePath, `${sanitized}\n`, { encoding: "utf8", flag: "a" });
  };

  return {
    debug: (op, message, details) => write("debug", op, message, details),
    info: (op, message, details) => write("info", op, message, details),
    warn: (op, message, details) => write("warn", op, message, details),
    error: (op, message, error, details) => write("error", op, message, details, error),
  };
}

async function pruneOldLogs(logsDir: string): Promise<void> {
  const entries = await readdir(logsDir, { withFileTypes: true });
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - LOG_RETENTION_DAYS);
  const cutoffStamp = Number(formatUtcDate(cutoff));

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /^\d{8}\.log$/.test(entry.name))
      .map(async (entry) => {
        const stamp = Number(entry.name.slice(0, 8));
        if (stamp < cutoffStamp) {
          await rm(join(logsDir, entry.name), { force: true });
        }
      }),
  );
}

function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return error;
}

function redactSecrets(value: string, secrets: string[]): string {
  return secrets.reduce((output, secret) => {
    if (secret.length === 0) {
      return output;
    }
    return output.split(secret).join("[REDACTED]");
  }, value);
}

function formatUtcDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}${month}${day}`;
}


// Uses 4^n (not 2^n) for aggressive backoff suited to Gemini API rate limits,
// which penalize rapid retries more heavily than typical HTTP services.
function computeRetryDelayMs(
  attempt: number,
  retryPolicy: MumblerSettings["retryPolicy"],
): number {
  const baseDelay = Math.min(
    retryPolicy.maxDelayMs,
    retryPolicy.initialDelayMs * 4 ** (attempt - 1),
  );
  const jitterWindow = Math.round(baseDelay * retryPolicy.jitterRatio);
  const jitterOffset =
    jitterWindow === 0 ? 0 : Math.round((Math.random() * jitterWindow * 2) - jitterWindow);
  return Math.max(0, baseDelay + jitterOffset);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
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
      confirmedUtc: localResult.utcTimestampText,
      timezone,
      frontTrimOffsetSec: 0,
      effectiveLocal: localTimestampText,
      effectiveUtc: localResult.utcTimestampText,
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
      confirmedUtc: normalizedUtc.utcTimestampText,
      timezone,
      frontTrimOffsetSec: 0,
      effectiveLocal: utcResult.localTimestampText,
      effectiveUtc: normalizedUtc.utcTimestampText,
    };
  }

  throw new Error("Pending import timestamps are incomplete.");
}

function normalizePendingImport(item: PendingImportReviewItem): PendingImportReviewItem {
  return {
    ...item,
    localTimestampText: item.localTimestampText.trim(),
    timezone: item.timezone.trim(),
    utcTimestampText: item.utcTimestampText.trim().toLowerCase(),
    createdAtUtc: normalizeUtcMarkerText(item.createdAtUtc),
    updatedAtUtc: nowUtcMarker(),
  };
}

function selectExistingCardId(state: MumblerState): string | null {
  if (state.selectedCardId !== null && state.cards.some((card) => card.id === state.selectedCardId)) {
    return state.selectedCardId;
  }

  return state.cards[0]?.id ?? null;
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
      title: null,
      slug: null,
    },
    ai: {
      transcription: null,
      title: null,
      slug: null,
    },
    status: "Imported",
    activeStep: null,
    lastError: null,
    createdAtUtc: nowUtcMarker(),
    updatedAtUtc: nowUtcMarker(),
  };
}

function clearCardResults(card: MumblerCard): void {
  card.transcription = { text: null };
  card.metadata = { title: null, slug: null };
  card.ai = { transcription: null, title: null, slug: null };
  card.status = "Imported";
  card.activeStep = null;
  card.lastError = null;
  card.updatedAtUtc = nowUtcMarker();
}

function resolvePipelineStartStep(
  card: MumblerCard,
  mode: "transcribe" | "retry",
): Exclude<CardProcessingStep, null> {
  if (mode === "transcribe") {
    return "transcription";
  }

  if (card.lastError?.failedStep === "title" && card.transcription.text !== null) {
    return "title";
  }

  if (
    card.lastError?.failedStep === "slug" &&
    card.transcription.text !== null &&
    card.metadata.title !== null
  ) {
    return "slug";
  }

  return "transcription";
}

function renderPromptTemplate(
  template: string,
  values: {
    transcript: string;
    title: string;
    language: string;
  },
): string {
  return template
    .replaceAll("{transcript}", values.transcript)
    .replaceAll("{title}", values.title)
    .replaceAll("{language}", values.language);
}

function sanitizeTitle(value: string): string {
  return value
    .replaceAll(/\*\*/g, "")
    .replaceAll(/\*/g, "")
    .replace(/^\s*["'`]+|["'`]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[`"'“”‘’]/g, "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 80);
}

function getCardErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown processing failure.";
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
      effectiveUtcResult.error === null ? effectiveUtcResult.utcTimestampText : timestamps.confirmedUtc,
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
