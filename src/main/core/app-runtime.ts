import { app, BrowserWindow, dialog, shell } from "electron";
import { access, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { homedir } from "node:os";

import { nanoid } from "nanoid";

import {
  type AppPaths,
  type AppSnapshot,
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

  private constructor(runtime: AppRuntimeState) {
    this.runtime = runtime;
  }

  static async initialize(): Promise<ApplicationRuntime> {
    const shellReadyAtUtc = new Date().toISOString();
    const supportedTimezones = getSupportedTimezones();

    try {
      const paths = getAppPaths();
      await ensureDirectories(paths);

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

      cardsToAdd.push({
        id: nanoid(),
        originalFilename: pendingImport.originalFilename,
        importSource: pendingImport.importSource,
        sourceFilePath: pendingImport.workingFilePath,
        durationSec: null,
        fileSizeBytes: pendingImport.fileSizeBytes,
        language: settings.defaultLanguage,
        timestamps,
        trim: {
          frontMarkerSec: null,
          backMarkerSec: null,
        },
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
        "Read the following transcript in {language} and produce a concise, accurate title in {language}. Transcript:\n\n{transcript}",
      slug:
        "Create a short English slug using lowercase letters, numbers, and hyphens only. Base it on this title:\n\n{title}",
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
    cards: Array.isArray(raw.cards) ? (raw.cards as MumblerCard[]) : defaults.cards,
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
