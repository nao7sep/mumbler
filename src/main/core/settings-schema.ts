import type {
  AppPaths,
  MumblerCard,
  MumblerSettings,
  MumblerState,
  PendingImportReviewItem,
  SettingsDraft,
  SettingsSummary,
} from "@shared/app-shell";
import {
  isSupportedTimezone,
  normalizeUtcMs,
} from "@shared/timestamps";
import { readJsonFile, writeJsonFile } from "./file-io";

const SETTINGS_SCHEMA_VERSION = 1;
const STATE_SCHEMA_VERSION = 1;

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

function normalizeSettings(
  raw: Record<string, unknown>,
  defaults: MumblerSettings,
): MumblerSettings {
  const prompts = asRecord(raw.prompts);
  const retryPolicy = asRecord(raw.retryPolicy);
  const timeouts = asRecord(raw.timeouts);

  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    // Files
    outputDirectory: asNullableString(raw.outputDirectory),
    backupDirectory: asNullableString(raw.backupDirectory),
    // Import
    defaultTimezone:
      asString(raw.defaultTimezone) && isSupportedTimezone(asString(raw.defaultTimezone)!)
        ? (asString(raw.defaultTimezone) as string)
        : defaults.defaultTimezone,
    timestampPatterns: asStringArray(raw.timestampPatterns) ?? defaults.timestampPatterns,
    // Player
    skipIntervalSec: asPositiveInteger(raw.skipIntervalSec) ?? defaults.skipIntervalSec,
    previewSnippetSeconds:
      asPositiveInteger(raw.previewSnippetSeconds) ?? defaults.previewSnippetSeconds,
    // AI
    geminiApiKeyObfuscated: asString(raw.geminiApiKeyObfuscated) ?? defaults.geminiApiKeyObfuscated,
    transcriptionModel: asString(raw.transcriptionModel) ?? defaults.transcriptionModel,
    metadataModel: asString(raw.metadataModel) ?? defaults.metadataModel,
    concurrencyLimit: asPositiveInteger(raw.concurrencyLimit) ?? defaults.concurrencyLimit,
    prompts: {
      structured: asString(prompts?.structured) ?? defaults.prompts.structured,
      title: asString(prompts?.title) ?? defaults.prompts.title,
      slug: asString(prompts?.slug) ?? defaults.prompts.slug,
    },
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
      metadataMs: asPositiveInteger(timeouts?.metadataMs) ?? defaults.timeouts.metadataMs,
    },
  };
}

function normalizePendingImportRecord(item: PendingImportReviewItem): PendingImportReviewItem {
  const createdAtUtc = normalizeUtcMs(item.createdAtUtc);

  return {
    ...item,
    originalSourcePath: typeof item.originalSourcePath === 'string' ? item.originalSourcePath : '',
    deleteOriginalOnConfirm: typeof item.deleteOriginalOnConfirm === 'boolean' ? item.deleteOriginalOnConfirm : false,
    copyToBackupOnConfirm: typeof item.copyToBackupOnConfirm === 'boolean' ? item.copyToBackupOnConfirm : false,
    createdAtUtc,
    updatedAtUtc: normalizeUtcMs(item.updatedAtUtc, createdAtUtc),
  };
}

function normalizeTrimDecisionRecord(cardTrimDecision: MumblerCard["trimDecision"]): MumblerCard["trimDecision"] {
  if (cardTrimDecision === null) {
    return null;
  }

  return {
    ...cardTrimDecision,
    analyzedAtUtc: normalizeUtcMs(cardTrimDecision.analyzedAtUtc),
  };
}

function normalizeAiRunInfo(
  run: MumblerCard["ai"]["transcription"] | undefined,
): MumblerCard["ai"]["transcription"] {
  if (run === null || run === undefined) {
    return null;
  }

  return {
    ...run,
    generatedAtUtc: normalizeUtcMs(run.generatedAtUtc),
  };
}

function normalizeCardError(error: MumblerCard["lastError"]): MumblerCard["lastError"] {
  if (error === null) {
    return null;
  }

  return {
    ...error,
    occurredAtUtc: normalizeUtcMs(error.occurredAtUtc),
  };
}

function normalizeCardRecord(card: MumblerCard): MumblerCard {
  const createdAtUtc = normalizeUtcMs(card.createdAtUtc);
  const confirmedUtc = normalizeUtcMs(card.timestamps.confirmedUtc);
  const queuedMode = card.queuedMode === "generate" ? card.queuedMode : null;
  const queuedAtUtc =
    queuedMode !== null && typeof card.queuedAtUtc === "number"
      ? normalizeUtcMs(card.queuedAtUtc)
      : null;

  return {
    ...card,
    audioProfile: card.audioProfile ?? null,
    timestamps: {
      ...card.timestamps,
      confirmedUtc,
      effectiveUtc: normalizeUtcMs(card.timestamps.effectiveUtc, confirmedUtc),
    },
    trimDecision: normalizeTrimDecisionRecord(card.trimDecision),
    metadata: {
      structured: card.metadata?.structured ?? null,
      title: card.metadata?.title ?? null,
      slug: card.metadata?.slug ?? null,
    },
    ai: {
      transcription: normalizeAiRunInfo(card.ai?.transcription),
      structured: normalizeAiRunInfo(card.ai?.structured),
      title: normalizeAiRunInfo(card.ai?.title),
      slug: normalizeAiRunInfo(card.ai?.slug),
    },
    queuedMode,
    queuedAtUtc,
    lastError: normalizeCardError(card.lastError),
    createdAtUtc,
    updatedAtUtc: normalizeUtcMs(card.updatedAtUtc, createdAtUtc),
  };
}

function normalizeState(raw: Record<string, unknown>, defaults: MumblerState): MumblerState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    pendingImports: Array.isArray(raw.pendingImports)
      ? (raw.pendingImports as PendingImportReviewItem[]).map(normalizePendingImportRecord)
      : defaults.pendingImports,
    cards: Array.isArray(raw.cards)
      ? (raw.cards as MumblerCard[]).map(normalizeCardRecord)
      : defaults.cards,
    selectedCardId: asNullableString(raw.selectedCardId),
    updatedAtUtc: normalizeUtcMs(raw.updatedAtUtc, defaults.updatedAtUtc),
  };
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
        message: "Interrupted — generate again to resume",
        occurredAtUtc: Date.now(),
        failedStep: "startup-recovery" as const,
      },
      updatedAtUtc: Date.now(),
    };
  });

  return {
    state: {
      ...state,
      cards,
      updatedAtUtc: Date.now(),
    },
    recoveredInterruptedCards,
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

function requirePromptAnyPlaceholder(
  prompt: string,
  acceptedPlaceholders: string[],
  label: string,
): void {
  if (prompt.length === 0) {
    throw new Error(`${label} is required.`);
  }

  if (!acceptedPlaceholders.some((placeholder) => prompt.includes(placeholder))) {
    throw new Error(`${label} must include one of ${acceptedPlaceholders.join(" or ")}.`);
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

function encodeGeminiApiKey(value: string): string {
  return Buffer.from(value.split("").reverse().join(""), "utf8").toString("base64");
}

export function getSystemTimezone(): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezone && timezone.length > 0 && isSupportedTimezone(timezone) ? timezone : "UTC";
}

export function createDefaultSettings(systemTimezone: string): MumblerSettings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    // Files
    outputDirectory: null,
    backupDirectory: null,
    // Import
    defaultTimezone: systemTimezone,
    timestampPatterns: [
      "(?<year>\\d{2}(?:\\d{2})?)(?<month>\\d{2})(?<day>\\d{2})[-_](?<hour>\\d{2})(?<minute>\\d{2})(?<second>\\d{2})?",
    ],
    // Player
    skipIntervalSec: 10,
    previewSnippetSeconds: 10,
    // AI
    geminiApiKeyObfuscated: "",
    transcriptionModel: "gemini-3.1-pro-preview",
    metadataModel: "gemini-3-flash-preview",
    concurrencyLimit: 3,
    prompts: {
      structured:
        "Reorganize the transcript into a well-structured Markdown outline. Preserve all information; resolve obvious self-contradictions using surrounding context. Use the transcript's language. Output Markdown only.\n\n<transcript>\n{transcript}\n</transcript>",
      title:
        "Write a single concise title in the source's language that summarizes the content. Output only the title — no prefix, no quotes, no markdown, no trailing period unless it is a complete sentence.\n\n<source>\n{structured}\n</source>",
      slug:
        "Create a short English URL slug for the title. Lowercase a–z, digits, and hyphens only. No leading or trailing hyphen. Aim for 3–6 words. Output only the slug.\n\n<title>\n{title}\n</title>",
    },
    retryPolicy: {
      maxRetries: 3,
      initialDelayMs: 1000,
      maxDelayMs: 16000,
      jitterRatio: 0.2,
    },
    timeouts: {
      transcriptionMs: 30 * 60 * 1000,
      metadataMs: 5 * 60 * 1000,
    },
  };
}

export async function loadSettings(paths: AppPaths): Promise<MumblerSettings> {
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

export async function loadState(
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

export function createEmptyState(): MumblerState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    pendingImports: [],
    cards: [],
    selectedCardId: null,
    updatedAtUtc: Date.now(),
  };
}

export function summarizeSettings(
  settings: MumblerSettings,
  defaultOutputDirectory: string,
  defaultBackupDirectory: string,
): SettingsSummary {
  return {
    // Files
    outputDirectory: settings.outputDirectory,
    defaultOutputDirectory,
    backupDirectory: settings.backupDirectory,
    defaultBackupDirectory,
    // Import
    defaultTimezone: settings.defaultTimezone,
    timestampPatternCount: settings.timestampPatterns.length,
    // Player
    skipIntervalSec: settings.skipIntervalSec,
    previewSnippetSeconds: settings.previewSnippetSeconds,
    // AI
    hasGeminiApiKey: decodeGeminiApiKey(settings.geminiApiKeyObfuscated).length > 0,
    transcriptionModel: settings.transcriptionModel,
    metadataModel: settings.metadataModel,
    concurrencyLimit: settings.concurrencyLimit,
  };
}

export function buildSettingsDraft(
  settings: MumblerSettings,
  defaultOutputDirectory: string,
  defaultBackupDirectory: string,
): SettingsDraft {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    // Files
    outputDirectory: settings.outputDirectory ?? "",
    defaultOutputDirectory,
    backupDirectory: settings.backupDirectory ?? "",
    defaultBackupDirectory,
    // Import
    defaultTimezone: settings.defaultTimezone,
    timestampPatternsText: settings.timestampPatterns.join("\n"),
    // Player
    skipIntervalSec: settings.skipIntervalSec,
    previewSnippetSeconds: settings.previewSnippetSeconds,
    // AI
    hasGeminiApiKey: decodeGeminiApiKey(settings.geminiApiKeyObfuscated).length > 0,
    geminiApiKeyInput: "",
    clearGeminiApiKey: false,
    transcriptionModel: settings.transcriptionModel,
    metadataModel: settings.metadataModel,
    concurrencyLimit: settings.concurrencyLimit,
    structuredPrompt: settings.prompts.structured,
    titlePrompt: settings.prompts.title,
    slugPrompt: settings.prompts.slug,
    retryMaxRetries: settings.retryPolicy.maxRetries,
    retryInitialDelayMs: settings.retryPolicy.initialDelayMs,
    retryMaxDelayMs: settings.retryPolicy.maxDelayMs,
    retryJitterRatio: settings.retryPolicy.jitterRatio,
    transcriptionTimeoutMs: settings.timeouts.transcriptionMs,
    metadataTimeoutMs: settings.timeouts.metadataMs,
  };
}

export function applySettingsDraft(current: MumblerSettings, draft: SettingsDraft): MumblerSettings {
  const outputDirectory = draft.outputDirectory.trim();
  const backupDirectory = draft.backupDirectory.trim();
  const defaultTimezone = draft.defaultTimezone.trim();
  const timestampPatterns = deduplicateStrings(parseSettingsEntries(draft.timestampPatternsText));
  const transcriptionModel = draft.transcriptionModel.trim();
  const metadataModel = draft.metadataModel.trim();
  const structuredPrompt = draft.structuredPrompt.trim();
  const titlePrompt = draft.titlePrompt.trim();
  const slugPrompt = draft.slugPrompt.trim();

  if (!isSupportedTimezone(defaultTimezone)) {
    throw new Error("Default timezone must be a valid IANA timezone.");
  }

  if (timestampPatterns.length === 0) {
    throw new Error("Add at least one timestamp regex pattern.");
  }

  if (transcriptionModel.length === 0) {
    throw new Error("Transcription model is required.");
  }

  if (metadataModel.length === 0) {
    throw new Error("Metadata model is required.");
  }

  requirePromptPlaceholders(structuredPrompt, ["{transcript}"], "Structured prompt");
  requirePromptAnyPlaceholder(titlePrompt, ["{transcript}", "{structured}"], "Title prompt");
  requirePromptPlaceholders(slugPrompt, ["{title}"], "Slug prompt");

  const skipIntervalSec = requirePositiveInteger(draft.skipIntervalSec, "Skip interval");
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
  const metadataTimeoutMs = requirePositiveInteger(draft.metadataTimeoutMs, "Metadata timeout");

  if (retryMaxDelayMs < retryInitialDelayMs) {
    throw new Error("Retry max delay must be greater than or equal to retry initial delay.");
  }

  return {
    ...current,
    // Files
    outputDirectory: outputDirectory.length === 0 ? null : outputDirectory,
    backupDirectory: backupDirectory.length === 0 ? null : backupDirectory,
    // Import
    defaultTimezone,
    timestampPatterns,
    // Player
    skipIntervalSec,
    previewSnippetSeconds,
    // AI
    geminiApiKeyObfuscated: resolveGeminiApiKeyObfuscated(current, draft),
    transcriptionModel,
    metadataModel,
    concurrencyLimit,
    prompts: {
      structured: structuredPrompt,
      title: titlePrompt,
      slug: slugPrompt,
    },
    retryPolicy: {
      maxRetries: retryMaxRetries,
      initialDelayMs: retryInitialDelayMs,
      maxDelayMs: retryMaxDelayMs,
      jitterRatio: retryJitterRatio,
    },
    timeouts: {
      transcriptionMs: transcriptionTimeoutMs,
      metadataMs: metadataTimeoutMs,
    },
  };
}

export function decodeGeminiApiKey(obfuscated: string): string {
  if (obfuscated.length === 0) {
    return "";
  }

  try {
    return Buffer.from(obfuscated, "base64").toString("utf8").split("").reverse().join("");
  } catch {
    return "";
  }
}

export function getSecretsForRedaction(settings: MumblerSettings): string[] {
  const decodedKey = decodeGeminiApiKey(settings.geminiApiKeyObfuscated);
  return decodedKey.length > 0 ? [decodedKey] : [];
}
