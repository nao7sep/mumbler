import { app, BrowserWindow, dialog, shell } from "electron";
import { access, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

interface AppRuntimeState {
  paths: AppPaths | null;
  settings: MumblerSettings | null;
  state: MumblerState | null;
  logger: AppLogger | null;
  startupDiagnostic: AppSnapshot["startupDiagnostic"];
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

    try {
      const paths = getAppPaths();
      await ensureDirectories(paths);
      assertFfmpegToolingPresent();

      const settings = await loadSettings(paths);
      const logger = createLogger(paths.logsDir, getSecretsForRedaction(settings));
      await pruneOldLogs(paths.logsDir);

      const { state, recoveredInterruptedCards } = await loadState(paths);
      await logger.info("app.startup", "Application runtime initialized.", {
        cardCount: state.cards.length,
        pendingImportCount: state.pendingImports.length,
        recoveredInterruptedCards,
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
        state,
        logger,
        startupDiagnostic: null,
        recoveredInterruptedCards,
        shellReadyAtUtc,
        supportedTimezones,
      });
    } catch (error: unknown) {
      return new ApplicationRuntime({
        paths: null,
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
      state,
      supportedTimezones: this.runtime.supportedTimezones,
    };
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

function summarizeSettings(settings: MumblerSettings): SettingsSummary {
  return {
    hasGeminiApiKey: decodeGeminiApiKey(settings.geminiApiKeyObfuscated).length > 0,
    outputDirectory: settings.outputDirectory,
    transcriptionModel: settings.transcriptionModel,
    metadataModel: settings.metadataModel,
    defaultLanguage: settings.defaultLanguage,
    defaultTimezone: settings.defaultTimezone,
    languageCount: settings.languages.length,
    timestampPatternCount: settings.timestampPatterns.length,
    previewSnippetSeconds: settings.previewSnippetSeconds,
    concurrencyLimit: settings.concurrencyLimit,
  };
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
