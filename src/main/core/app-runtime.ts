import { app, BrowserWindow, dialog, shell } from "electron";
import {
  access,
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
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
  type SettingsSummary,
} from "@shared/app-shell";
import { COMMAND_DEFINITIONS, buildDefaultShortcutMap } from "@shared/commands";
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
  parseTimestampFromFilename,
  recomputeLocalFromUtc,
  recomputeUtcFromLocal,
} from "@shared/timestamps";

const SETTINGS_SCHEMA_VERSION = 1;
const STATE_SCHEMA_VERSION = 1;
const LOG_RETENTION_DAYS = 30;

interface AppLogger {
  debug(op: string, message: string, details?: unknown): Promise<void>;
  info(op: string, message: string, details?: unknown): Promise<void>;
  warn(op: string, message: string, details?: unknown): Promise<void>;
  error(op: string, message: string, error: unknown, details?: unknown): Promise<void>;
}

interface WorkingReconciliationResult {
  state: MumblerState;
  droppedPendingImports: number;
  missingWorkingCards: number;
  trashedOrphanedFiles: number;
  retainedOrphanedFiles: number;
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

  private constructor(runtime: AppRuntimeState) {
    this.runtime = runtime;
  }

  static async initialize(): Promise<ApplicationRuntime> {
    const shellReadyAtUtc = new Date().toISOString();
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
        createdAtUtc: new Date().toISOString(),
        updatedAtUtc: new Date().toISOString(),
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
    card.updatedAtUtc = new Date().toISOString();

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
        return {
          kind: "conflict",
          snapshot: this.getSnapshot(),
          audioPath: initialTargets.audioPath,
          jsonPath: initialTargets.jsonPath,
        };
      }

      if (resolution === "cancel") {
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
      const finalizedAtUtc = new Date().toISOString();
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
      createdAtUtc: new Date().toISOString(),
      updatedAtUtc: new Date().toISOString(),
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
        card.updatedAtUtc = new Date().toISOString();
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
            generatedAtUtc: new Date().toISOString(),
          };
          card.updatedAtUtc = new Date().toISOString();

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
          generatedAtUtc: new Date().toISOString(),
        };
        card.updatedAtUtc = new Date().toISOString();
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
          generatedAtUtc: new Date().toISOString(),
        };
        card.status = "Ready to Save";
        card.activeStep = null;
        card.lastError = null;
        card.updatedAtUtc = new Date().toISOString();

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
        occurredAtUtc: new Date().toISOString(),
        failedStep: activeStep,
      };
      card.updatedAtUtc = new Date().toISOString();

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
    card.updatedAtUtc = new Date().toISOString();
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
        await sleep(delayMs);
        attempt += 1;
      }
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
            updatedAtUtc: new Date().toISOString(),
          };

    this.runtime.state = normalized;
    await writeJsonFile(this.runtime.paths!.statePath, normalized);
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

async function loadSettings(paths: AppPaths): Promise<MumblerSettings> {
  const systemTimezone = getSystemTimezone();
  const defaults = createDefaultSettings(systemTimezone);
  const raw = await readJsonFile<Record<string, unknown> | null>(paths.settingsPath);

  if (raw === null) {
    await writeJsonFile(paths.settingsPath, defaults);
    return defaults;
  }

  const normalized = normalizeSettings(raw, defaults);
  await writeJsonFile(paths.settingsPath, normalized);
  return normalized;
}

async function loadState(
  paths: AppPaths,
): Promise<{ state: MumblerState; recoveredInterruptedCards: number }> {
  const raw = await readJsonFile<Record<string, unknown> | null>(paths.statePath);
  const defaults = createEmptyState();

  if (raw === null) {
    await writeJsonFile(paths.statePath, defaults);
    return { state: defaults, recoveredInterruptedCards: 0 };
  }

  const normalized = normalizeState(raw, defaults);
  const { state, recoveredInterruptedCards } = recoverInterruptedCards(normalized);
  await writeJsonFile(paths.statePath, state);
  return { state, recoveredInterruptedCards };
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

function createDefaultSettings(systemTimezone: string): MumblerSettings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    geminiApiKeyObfuscated: "",
    outputDirectory: null,
    transcriptionModel: "gemini-3.1-pro-preview",
    metadataModel: "gemini-3.1-pro-preview",
    defaultLanguage: "English",
    languages: [
      "English",
      "Japanese",
      "Spanish",
      "French",
      "German",
      "Mandarin Chinese",
      "Korean",
      "Portuguese",
      "Russian",
      "Arabic",
      "Hindi",
      "Italian",
    ],
    defaultTimezone: systemTimezone,
    timestampPatterns: [
      "(?<year>\\d{4})(?<month>\\d{2})(?<day>\\d{2})[-_ ](?<hour>\\d{2})(?<minute>\\d{2})(?<second>\\d{2})",
      "(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})[ T](?<hour>\\d{2})\\.(?<minute>\\d{2})\\.(?<second>\\d{2})",
      "(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})[ T](?<hour>\\d{2})-(?<minute>\\d{2})-(?<second>\\d{2})",
      "(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})[ T](?<hour>\\d{2}):(?<minute>\\d{2}):(?<second>\\d{2})",
    ],
    prompts: {
      title:
        "Read the following transcript in {language} and produce a concise, accurate title in {language}. Return plain text only, with no markdown, quotes, bullets, or extra commentary. Transcript:\n\n{transcript}",
      slug:
        "Create a short English slug using lowercase letters, numbers, and hyphens only. Return only the slug text, with no markdown, quotes, or commentary. Base it on this title:\n\n{title}",
    },
    previewSnippetSeconds: 10,
    concurrencyLimit: 3,
    retryPolicy: {
      maxRetries: 3,
      initialDelayMs: 1000,
      maxDelayMs: 16000,
      jitterRatio: 0.2,
    },
    timeouts: {
      transcriptionMs: 5 * 60 * 1000,
      titleMs: 2 * 60 * 1000,
      slugMs: 2 * 60 * 1000,
    },
    shortcuts: buildDefaultShortcutMap(),
  };
}

function createEmptyState(): MumblerState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    pendingImports: [],
    cards: [],
    selectedCardId: null,
    updatedAtUtc: new Date().toISOString(),
  };
}

function normalizeSettings(
  raw: Record<string, unknown>,
  defaults: MumblerSettings,
): MumblerSettings {
  const prompts = asRecord(raw.prompts);
  const retryPolicy = asRecord(raw.retryPolicy);
  const timeouts = asRecord(raw.timeouts);
  const shortcuts = asRecord(raw.shortcuts);

  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    geminiApiKeyObfuscated: asString(raw.geminiApiKeyObfuscated) ?? defaults.geminiApiKeyObfuscated,
    outputDirectory: asNullableString(raw.outputDirectory),
    transcriptionModel: asString(raw.transcriptionModel) ?? defaults.transcriptionModel,
    metadataModel: asString(raw.metadataModel) ?? defaults.metadataModel,
    defaultLanguage: asString(raw.defaultLanguage) ?? defaults.defaultLanguage,
    languages: asStringArray(raw.languages) ?? defaults.languages,
    defaultTimezone:
      asString(raw.defaultTimezone) && isSupportedTimezone(asString(raw.defaultTimezone)!)
        ? (asString(raw.defaultTimezone) as string)
        : defaults.defaultTimezone,
    timestampPatterns: asStringArray(raw.timestampPatterns) ?? defaults.timestampPatterns,
    prompts: {
      title: asString(prompts?.title) ?? defaults.prompts.title,
      slug: asString(prompts?.slug) ?? defaults.prompts.slug,
    },
    previewSnippetSeconds:
      asPositiveInteger(raw.previewSnippetSeconds) ?? defaults.previewSnippetSeconds,
    concurrencyLimit: asPositiveInteger(raw.concurrencyLimit) ?? defaults.concurrencyLimit,
    retryPolicy: {
      maxRetries: asPositiveInteger(retryPolicy?.maxRetries) ?? defaults.retryPolicy.maxRetries,
      initialDelayMs:
        asPositiveInteger(retryPolicy?.initialDelayMs) ?? defaults.retryPolicy.initialDelayMs,
      maxDelayMs: asPositiveInteger(retryPolicy?.maxDelayMs) ?? defaults.retryPolicy.maxDelayMs,
      jitterRatio: asRatio(retryPolicy?.jitterRatio) ?? defaults.retryPolicy.jitterRatio,
    },
    timeouts: {
      transcriptionMs:
        asPositiveInteger(timeouts?.transcriptionMs) ?? defaults.timeouts.transcriptionMs,
      titleMs: asPositiveInteger(timeouts?.titleMs) ?? defaults.timeouts.titleMs,
      slugMs: asPositiveInteger(timeouts?.slugMs) ?? defaults.timeouts.slugMs,
    },
    shortcuts: normalizeShortcuts(shortcuts, defaults.shortcuts),
  };
}

function normalizeState(raw: Record<string, unknown>, defaults: MumblerState): MumblerState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    pendingImports: Array.isArray(raw.pendingImports)
      ? (raw.pendingImports as PendingImportReviewItem[])
      : defaults.pendingImports,
    cards: Array.isArray(raw.cards)
      ? (raw.cards as MumblerCard[]).map((card) => ({
          ...card,
          audioProfile: card.audioProfile ?? null,
          trimDecision: card.trimDecision ?? null,
        }))
      : defaults.cards,
    selectedCardId: asNullableString(raw.selectedCardId),
    updatedAtUtc: asString(raw.updatedAtUtc) ?? defaults.updatedAtUtc,
  };
}

function normalizeShortcuts(
  raw: Record<string, unknown> | null,
  defaults: Record<string, string>,
): Record<string, string> {
  if (raw === null) {
    return defaults;
  }

  const output: Record<string, string> = { ...defaults };

  for (const command of COMMAND_DEFINITIONS) {
    const candidate = raw[command.id];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      output[command.id] = candidate;
    }
  }

  return output;
}

function recoverInterruptedCards(
  state: MumblerState,
): { state: MumblerState; recoveredInterruptedCards: number } {
  let recoveredInterruptedCards = 0;

  const cards = state.cards.map((card) => {
    if (card.status !== "Transcribing" && card.status !== "Generating Metadata") {
      return card;
    }

    recoveredInterruptedCards += 1;
    return {
      ...card,
      status: "Error" as const,
      activeStep: null,
      lastError: {
        message: "Interrupted — retry to resume",
        occurredAtUtc: new Date().toISOString(),
        failedStep: "startup-recovery" as const,
      },
      updatedAtUtc: new Date().toISOString(),
    };
  });

  return {
    state: {
      ...state,
      cards,
      updatedAtUtc: new Date().toISOString(),
    },
    recoveredInterruptedCards,
  };
}

async function reconcileWorkingState(
  paths: AppPaths,
  state: MumblerState,
  logger: AppLogger,
): Promise<WorkingReconciliationResult> {
  const referencedPaths = new Set<string>();
  const nextPendingImports: PendingImportReviewItem[] = [];
  let droppedPendingImports = 0;

  for (const pendingImport of state.pendingImports) {
    if (await fileExists(pendingImport.workingFilePath)) {
      nextPendingImports.push(pendingImport);
      referencedPaths.add(pendingImport.workingFilePath);
      continue;
    }

    droppedPendingImports += 1;
    await logger.warn(
      "startup.pending-missing",
      "Dropped pending import because its working file is missing.",
      {
        pendingImportId: pendingImport.id,
        originalFilename: pendingImport.originalFilename,
        workingFilePath: pendingImport.workingFilePath,
      },
    );
  }

  let missingWorkingCards = 0;
  const nextCards: MumblerCard[] = [];

  for (const card of state.cards) {
    if (await fileExists(card.sourceFilePath)) {
      referencedPaths.add(card.sourceFilePath);
      nextCards.push(card);
      continue;
    }

    missingWorkingCards += 1;
    nextCards.push(markCardWorkingFileMissing(card));
    await logger.warn(
      "startup.card-missing",
      "Marked card as errored because its working file is missing.",
      {
        cardId: card.id,
        originalFilename: card.originalFilename,
        sourceFilePath: card.sourceFilePath,
      },
    );
  }

  const cleanupResult = await cleanupOrphanedWorkingFiles(paths, referencedPaths, logger);
  const changed =
    droppedPendingImports > 0 ||
    missingWorkingCards > 0 ||
    cleanupResult.trashedOrphanedFiles > 0 ||
    cleanupResult.retainedOrphanedFiles > 0;

  const nextState =
    !changed
      ? state
      : {
          ...state,
          pendingImports: nextPendingImports,
          cards: nextCards,
          selectedCardId: selectExistingCardId({
            ...state,
            pendingImports: nextPendingImports,
            cards: nextCards,
          }),
          updatedAtUtc: new Date().toISOString(),
        };

  return {
    state: nextState,
    droppedPendingImports,
    missingWorkingCards,
    trashedOrphanedFiles: cleanupResult.trashedOrphanedFiles,
    retainedOrphanedFiles: cleanupResult.retainedOrphanedFiles,
  };
}

function summarizeSettings(settings: MumblerSettings): SettingsSummary {
  return {
    hasGeminiApiKey: decodeGeminiApiKey(settings.geminiApiKeyObfuscated).length > 0,
    outputDirectory: settings.outputDirectory,
    transcriptionModel: settings.transcriptionModel,
    metadataModel: settings.metadataModel,
    defaultLanguage: settings.defaultLanguage,
    languages: [...settings.languages],
    defaultTimezone: settings.defaultTimezone,
    languageCount: settings.languages.length,
    timestampPatternCount: settings.timestampPatterns.length,
    previewSnippetSeconds: settings.previewSnippetSeconds,
    concurrencyLimit: settings.concurrencyLimit,
    shortcuts: { ...settings.shortcuts },
  };
}

function buildSettingsDraft(settings: MumblerSettings): SettingsDraft {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    hasGeminiApiKey: decodeGeminiApiKey(settings.geminiApiKeyObfuscated).length > 0,
    geminiApiKeyInput: "",
    clearGeminiApiKey: false,
    outputDirectory: settings.outputDirectory ?? "",
    transcriptionModel: settings.transcriptionModel,
    metadataModel: settings.metadataModel,
    defaultLanguage: settings.defaultLanguage,
    languagesText: settings.languages.join("\n"),
    defaultTimezone: settings.defaultTimezone,
    timestampPatternsText: settings.timestampPatterns.join("\n"),
    titlePrompt: settings.prompts.title,
    slugPrompt: settings.prompts.slug,
    previewSnippetSeconds: settings.previewSnippetSeconds,
    concurrencyLimit: settings.concurrencyLimit,
    retryMaxRetries: settings.retryPolicy.maxRetries,
    retryInitialDelayMs: settings.retryPolicy.initialDelayMs,
    retryMaxDelayMs: settings.retryPolicy.maxDelayMs,
    retryJitterRatio: settings.retryPolicy.jitterRatio,
    transcriptionTimeoutMs: settings.timeouts.transcriptionMs,
    titleTimeoutMs: settings.timeouts.titleMs,
    slugTimeoutMs: settings.timeouts.slugMs,
    shortcuts: { ...settings.shortcuts },
  };
}

function applySettingsDraft(current: MumblerSettings, draft: SettingsDraft): MumblerSettings {
  const transcriptionModel = draft.transcriptionModel.trim();
  const metadataModel = draft.metadataModel.trim();
  const defaultLanguage = draft.defaultLanguage.trim();
  const defaultTimezone = draft.defaultTimezone.trim();
  const titlePrompt = draft.titlePrompt.trim();
  const slugPrompt = draft.slugPrompt.trim();
  const outputDirectory = draft.outputDirectory.trim();
  const languages = deduplicateStrings(parseSettingsEntries(draft.languagesText));
  const timestampPatterns = deduplicateStrings(parseSettingsEntries(draft.timestampPatternsText));

  if (transcriptionModel.length === 0) {
    throw new Error("Transcription model is required.");
  }

  if (metadataModel.length === 0) {
    throw new Error("Metadata model is required.");
  }

  if (defaultLanguage.length === 0) {
    throw new Error("Default language is required.");
  }

  if (!isSupportedTimezone(defaultTimezone)) {
    throw new Error("Default timezone must be a valid IANA timezone.");
  }

  if (languages.length === 0) {
    throw new Error("Add at least one language.");
  }

  if (timestampPatterns.length === 0) {
    throw new Error("Add at least one timestamp regex pattern.");
  }

  requirePromptPlaceholders(titlePrompt, ["{transcript}", "{language}"], "Title prompt");
  requirePromptPlaceholders(slugPrompt, ["{title}"], "Slug prompt");

  const previewSnippetSeconds = requirePositiveInteger(
    draft.previewSnippetSeconds,
    "Preview snippet seconds",
  );
  const concurrencyLimit = requirePositiveInteger(draft.concurrencyLimit, "Concurrency limit");
  const retryMaxRetries = requirePositiveInteger(draft.retryMaxRetries, "Retry max retries");
  const retryInitialDelayMs = requirePositiveInteger(
    draft.retryInitialDelayMs,
    "Retry initial delay",
  );
  const retryMaxDelayMs = requirePositiveInteger(draft.retryMaxDelayMs, "Retry max delay");
  const retryJitterRatio = requireRatio(draft.retryJitterRatio, "Retry jitter ratio");
  const transcriptionTimeoutMs = requirePositiveInteger(
    draft.transcriptionTimeoutMs,
    "Transcription timeout",
  );
  const titleTimeoutMs = requirePositiveInteger(draft.titleTimeoutMs, "Title timeout");
  const slugTimeoutMs = requirePositiveInteger(draft.slugTimeoutMs, "Slug timeout");
  const shortcuts = normalizeDraftShortcuts(draft.shortcuts, current.shortcuts);

  if (retryMaxDelayMs < retryInitialDelayMs) {
    throw new Error("Retry max delay must be greater than or equal to retry initial delay.");
  }

  const normalizedLanguages = languages.includes(defaultLanguage)
    ? languages
    : [defaultLanguage, ...languages];

  return {
    ...current,
    geminiApiKeyObfuscated: resolveGeminiApiKeyObfuscated(current, draft),
    outputDirectory: outputDirectory.length === 0 ? null : outputDirectory,
    transcriptionModel,
    metadataModel,
    defaultLanguage,
    languages: normalizedLanguages,
    defaultTimezone,
    timestampPatterns,
    prompts: {
      title: titlePrompt,
      slug: slugPrompt,
    },
    previewSnippetSeconds,
    concurrencyLimit,
    retryPolicy: {
      maxRetries: retryMaxRetries,
      initialDelayMs: retryInitialDelayMs,
      maxDelayMs: retryMaxDelayMs,
      jitterRatio: retryJitterRatio,
    },
    timeouts: {
      transcriptionMs: transcriptionTimeoutMs,
      titleMs: titleTimeoutMs,
      slugMs: slugTimeoutMs,
    },
    shortcuts,
  };
}

function resolveGeminiApiKeyObfuscated(current: MumblerSettings, draft: SettingsDraft): string {
  const nextApiKey = draft.geminiApiKeyInput.trim();

  if (draft.clearGeminiApiKey && nextApiKey.length > 0) {
    throw new Error("Enter a new Gemini API key or clear the saved key, not both.");
  }

  if (draft.clearGeminiApiKey) {
    return "";
  }

  if (nextApiKey.length === 0) {
    return current.geminiApiKeyObfuscated;
  }

  return encodeGeminiApiKey(nextApiKey);
}

function parseSettingsEntries(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function deduplicateStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeDraftShortcuts(
  shortcuts: Record<string, string>,
  defaults: Record<string, string>,
): Record<string, string> {
  const normalized = { ...defaults };

  for (const command of COMMAND_DEFINITIONS) {
    const value = shortcuts[command.id]?.trim();
    if (!value) {
      throw new Error(`Shortcut for ${command.label} is required.`);
    }
    normalized[command.id] = value;
  }

  return normalized;
}

function requirePromptPlaceholders(
  prompt: string,
  requiredPlaceholders: string[],
  label: string,
): void {
  if (prompt.length === 0) {
    throw new Error(`${label} is required.`);
  }

  for (const placeholder of requiredPlaceholders) {
    if (!prompt.includes(placeholder)) {
      throw new Error(`${label} must include ${placeholder}.`);
    }
  }
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return value;
}

function requireRatio(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1.`);
  }

  return value;
}

async function pathsConflict(audioPath: string, jsonPath: string): Promise<boolean> {
  const [audioExists, jsonExists] = await Promise.all([fileExists(audioPath), fileExists(jsonPath)]);
  return audioExists || jsonExists;
}

async function buildUniqueSuffixedTargets(
  outputDirectory: string,
  baseName: string,
  extension: string,
): Promise<{ audioPath: string; jsonPath: string }> {
  while (true) {
    const suffixedBase = `${baseName}-${nanoid(8)}`;
    const audioPath = join(outputDirectory, `${suffixedBase}${extension}`);
    const jsonPath = join(outputDirectory, `${suffixedBase}.json`);
    if (!(await pathsConflict(audioPath, jsonPath))) {
      return { audioPath, jsonPath };
    }
  }
}

async function finalizeOutputsAtomically(params: {
  sourceAudioPath: string;
  audioTargetPath: string;
  jsonTargetPath: string;
  overwrite: boolean;
  jsonContent: string;
}): Promise<void> {
  await mkdir(dirname(params.audioTargetPath), { recursive: true });

  const token = nanoid(8);
  const audioTempPath = join(
    dirname(params.audioTargetPath),
    `.${basename(params.audioTargetPath)}.${token}.tmp`,
  );
  const jsonTempPath = join(
    dirname(params.jsonTargetPath),
    `.${basename(params.jsonTargetPath)}.${token}.tmp`,
  );

  await copyFile(params.sourceAudioPath, audioTempPath);
  await syncFile(audioTempPath);
  await writeFile(jsonTempPath, params.jsonContent, "utf8");
  await syncFile(jsonTempPath);

  const audioBackupPath = `${params.audioTargetPath}.${token}.bak`;
  const jsonBackupPath = `${params.jsonTargetPath}.${token}.bak`;
  const audioHadExisting = params.overwrite && (await fileExists(params.audioTargetPath));
  const jsonHadExisting = params.overwrite && (await fileExists(params.jsonTargetPath));

  let audioFinalized = false;
  let jsonFinalized = false;

  try {
    if (audioHadExisting) {
      await rename(params.audioTargetPath, audioBackupPath);
    }
    if (jsonHadExisting) {
      await rename(params.jsonTargetPath, jsonBackupPath);
    }

    await rename(audioTempPath, params.audioTargetPath);
    audioFinalized = true;
    await rename(jsonTempPath, params.jsonTargetPath);
    jsonFinalized = true;

    if (audioHadExisting) {
      await rm(audioBackupPath, { force: true });
    }
    if (jsonHadExisting) {
      await rm(jsonBackupPath, { force: true });
    }
  } catch (error: unknown) {
    if (jsonFinalized) {
      await rm(params.jsonTargetPath, { force: true }).catch(() => undefined);
    }
    if (audioFinalized) {
      await rm(params.audioTargetPath, { force: true }).catch(() => undefined);
    }

    if (audioHadExisting && (await fileExists(audioBackupPath))) {
      await rename(audioBackupPath, params.audioTargetPath).catch(() => undefined);
    }
    if (jsonHadExisting && (await fileExists(jsonBackupPath))) {
      await rename(jsonBackupPath, params.jsonTargetPath).catch(() => undefined);
    }

    await rm(audioTempPath, { force: true }).catch(() => undefined);
    await rm(jsonTempPath, { force: true }).catch(() => undefined);

    throw new Error(`Failed to finalize output files: ${formatError(error)}`);
  }
}

function buildOutputPayload(params: {
  card: MumblerCard;
  finalProfile: MumblerCard["audioProfile"];
  finalDurationSec: number | null;
  finalizedAtUtc: string;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    originalFilename: params.card.originalFilename,
    importSource: params.card.importSource,
    timestamps: {
      confirmedLocal: params.card.timestamps.confirmedLocal,
      confirmedUtc: params.card.timestamps.confirmedUtc,
      timezone: params.card.timestamps.timezone,
      effectiveLocal: params.card.timestamps.effectiveLocal,
      effectiveUtc: params.card.timestamps.effectiveUtc,
      transcribedAtUtc: params.card.ai.transcription?.generatedAtUtc ?? null,
      finalizedAtUtc: params.finalizedAtUtc,
    },
    language: params.card.language,
    trim:
      params.card.trim.frontMarkerSec === null && params.card.trim.backMarkerSec === null
        ? null
        : params.card.trim,
    duration: {
      originalSec: params.card.durationSec,
      finalSec: params.finalDurationSec,
    },
    transcription: {
      raw: params.card.transcription.text,
      title: params.card.metadata.title,
      slug: params.card.metadata.slug,
    },
    providers: {
      transcription: params.card.ai.transcription,
      title: params.card.ai.title,
      slug: params.card.ai.slug,
    },
    audio: {
      finalCodec: params.finalProfile?.codecName ?? null,
      finalBitrateKbps: params.finalProfile?.bitRateKbps ?? null,
      finalSampleRateHz: params.finalProfile?.sampleRateHz ?? null,
      finalChannels: params.finalProfile?.channels ?? null,
      trimDecision: params.card.trimDecision?.kind ?? "not-needed",
    },
    appVersion: app.getVersion(),
  };
}

function computeFinalDuration(card: MumblerCard, probedDurationSec: number | null): number | null {
  if (probedDurationSec !== null) {
    return probedDurationSec;
  }

  if (card.durationSec === null) {
    return null;
  }

  const startSec = card.trim.frontMarkerSec ?? 0;
  const endSec = card.trim.backMarkerSec ?? card.durationSec;
  return Math.max(0, Math.round((endSec - startSec) * 1000) / 1000);
}

function getSystemTimezone(): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezone && timezone.length > 0 && isSupportedTimezone(timezone) ? timezone : "UTC";
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw new Error(`Failed to read JSON file at ${filePath}: ${formatError(error)}`);
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
      time: new Date().toISOString(),
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

function getSecretsForRedaction(settings: MumblerSettings): string[] {
  const decodedKey = decodeGeminiApiKey(settings.geminiApiKeyObfuscated);
  return decodedKey.length > 0 ? [decodedKey] : [];
}

function encodeGeminiApiKey(value: string): string {
  return Buffer.from(value.split("").reverse().join(""), "utf8").toString("base64");
}

function decodeGeminiApiKey(obfuscated: string): string {
  if (obfuscated.length === 0) {
    return "";
  }

  try {
    return Buffer.from(obfuscated, "base64").toString("utf8").split("").reverse().join("");
  } catch {
    return "";
  }
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNullableString(value: unknown): string | null {
  return value === null ? null : asString(value);
}

function asStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : null;
}

function asPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function asRatio(value: unknown): number | null {
  return typeof value === "number" && value >= 0 && value <= 1 ? value : null;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

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

async function uniquePathInDirectory(directory: string, filename: string): Promise<string> {
  const extension = extname(filename);
  const stem = filename.slice(0, filename.length - extension.length);
  let candidate = join(directory, filename);

  while (await fileExists(candidate)) {
    candidate = join(directory, `${stem}-${nanoid(8)}${extension}`);
  }

  return candidate;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function moveImportedSourceToTrash(sourcePath: string, workingDir: string): Promise<void> {
  try {
    await shell.trashItem(sourcePath);
    return;
  } catch (directTrashError: unknown) {
    const stagingDir = join(workingDir, "trash-staging");
    const stagedPath = await uniquePathInDirectory(stagingDir, basename(sourcePath));

    try {
      await copyFile(sourcePath, stagedPath);
      await access(stagedPath, fsConstants.R_OK);
      await rm(sourcePath);
    } catch (stageError: unknown) {
      await rm(stagedPath, { force: true });
      throw new Error(
        `Failed to stage imported source for trash after direct trash failed: ${formatError(stageError)}`,
      );
    }

    try {
      await shell.trashItem(stagedPath);
    } catch (trashError: unknown) {
      try {
        await copyFile(stagedPath, sourcePath);
        await rm(stagedPath, { force: true });
      } catch (restoreError: unknown) {
        throw new Error(
          `Failed to trash staged source and failed to restore it. Staged copy remains at ${stagedPath}. Trash error: ${formatError(trashError)}. Restore error: ${formatError(restoreError)}`,
        );
      }

      throw new Error(
        `Failed to move source to trash after local staging: ${formatError(trashError)}`,
      );
    }

    if (directTrashError instanceof Error) {
      return;
    }
  }
}

async function cleanupOrphanedWorkingFiles(
  paths: AppPaths,
  referencedPaths: Set<string>,
  logger: AppLogger,
): Promise<{ trashedOrphanedFiles: number; retainedOrphanedFiles: number }> {
  let trashedOrphanedFiles = 0;
  let retainedOrphanedFiles = 0;
  const candidates = await listWorkingFiles(paths.workingDir);

  for (const candidate of candidates) {
    if (referencedPaths.has(candidate)) {
      continue;
    }

    try {
      await shell.trashItem(candidate);
      trashedOrphanedFiles += 1;
      await logger.info("working.cleanup", "Moved orphaned working file to trash.", {
        filePath: candidate,
      });
    } catch (error: unknown) {
      retainedOrphanedFiles += 1;
      await logger.warn("working.cleanup-failed", "Failed to trash orphaned working file.", {
        filePath: candidate,
        error: formatError(error),
      });
    }
  }

  return {
    trashedOrphanedFiles,
    retainedOrphanedFiles,
  };
}

async function listWorkingFiles(workingDir: string): Promise<string[]> {
  const entries = await readdir(workingDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(workingDir, entry.name);
    if (entry.isFile()) {
      files.push(entryPath);
      continue;
    }

    if (entry.isDirectory() && entry.name === "trash-staging") {
      const stagedEntries = await readdir(entryPath, { withFileTypes: true });
      for (const stagedEntry of stagedEntries) {
        if (stagedEntry.isFile()) {
          files.push(join(entryPath, stagedEntry.name));
        }
      }
    }
  }

  return files;
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
    updatedAtUtc: new Date().toISOString(),
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
    createdAtUtc: new Date().toISOString(),
    updatedAtUtc: new Date().toISOString(),
  };
}

function markCardWorkingFileMissing(card: MumblerCard): MumblerCard {
  return {
    ...card,
    status: "Error",
    activeStep: null,
    lastError: {
      message: "Working audio is missing from working storage — remove this card or re-import the source audio.",
      occurredAtUtc: new Date().toISOString(),
      failedStep: "startup-recovery",
    },
    updatedAtUtc: new Date().toISOString(),
  };
}

function clearCardResults(card: MumblerCard): void {
  card.transcription = { text: null };
  card.metadata = { title: null, slug: null };
  card.ai = { transcription: null, title: null, slug: null };
  card.status = "Imported";
  card.activeStep = null;
  card.lastError = null;
  card.updatedAtUtc = new Date().toISOString();
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
