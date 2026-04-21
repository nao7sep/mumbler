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
  normalizeUtcMarkerText,
  nowUtcMarker,
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
    geminiApiKeyObfuscated: asString(raw.geminiApiKeyObfuscated) ?? defaults.geminiApiKeyObfuscated,
    outputDirectory: asNullableString(raw.outputDirectory),
    transcriptionModel: asString(raw.transcriptionModel) ?? defaults.transcriptionModel,
    metadataModel: asString(raw.metadataModel) ?? defaults.metadataModel,
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
  };
}

function normalizePendingImportRecord(item: PendingImportReviewItem): PendingImportReviewItem {
  const createdAtUtc = normalizeUtcMarkerText(item.createdAtUtc);

  return {
    ...item,
    originalSourcePath: typeof item.originalSourcePath === 'string' ? item.originalSourcePath : '',
    deleteOriginalOnConfirm: typeof item.deleteOriginalOnConfirm === 'boolean' ? item.deleteOriginalOnConfirm : true,
    createdAtUtc,
    updatedAtUtc: normalizeUtcMarkerText(item.updatedAtUtc, createdAtUtc),
  };
}

function normalizeTrimDecisionRecord(cardTrimDecision: MumblerCard["trimDecision"]): MumblerCard["trimDecision"] {
  if (cardTrimDecision === null) {
    return null;
  }

  return {
    ...cardTrimDecision,
    analyzedAtUtc: normalizeUtcMarkerText(cardTrimDecision.analyzedAtUtc),
  };
}

function normalizeAiRunInfo(run: MumblerCard["ai"]["transcription"]): MumblerCard["ai"]["transcription"] {
  if (run === null) {
    return null;
  }

  return {
    ...run,
    generatedAtUtc: normalizeUtcMarkerText(run.generatedAtUtc),
  };
}

function normalizeCardError(error: MumblerCard["lastError"]): MumblerCard["lastError"] {
  if (error === null) {
    return null;
  }

  return {
    ...error,
    occurredAtUtc: normalizeUtcMarkerText(error.occurredAtUtc),
  };
}

function normalizeCardRecord(card: MumblerCard): MumblerCard {
  const createdAtUtc = normalizeUtcMarkerText(card.createdAtUtc);
  const confirmedUtc = normalizeUtcMarkerText(card.timestamps.confirmedUtc);

  return {
    ...card,
    audioProfile: card.audioProfile ?? null,
    timestamps: {
      ...card.timestamps,
      confirmedUtc,
      effectiveUtc: normalizeUtcMarkerText(card.timestamps.effectiveUtc, confirmedUtc),
    },
    trimDecision: normalizeTrimDecisionRecord(card.trimDecision),
    ai: {
      transcription: normalizeAiRunInfo(card.ai?.transcription),
      title: normalizeAiRunInfo(card.ai?.title),
      slug: normalizeAiRunInfo(card.ai?.slug),
    },
    lastError: normalizeCardError(card.lastError),
    createdAtUtc,
    updatedAtUtc: normalizeUtcMarkerText(card.updatedAtUtc, createdAtUtc),
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
    updatedAtUtc: normalizeUtcMarkerText(asString(raw.updatedAtUtc) ?? defaults.updatedAtUtc),
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
        message: "Interrupted — retry to resume",
        occurredAtUtc: nowUtcMarker(),
        failedStep: "startup-recovery" as const,
      },
      updatedAtUtc: nowUtcMarker(),
    };
  });

  return {
    state: {
      ...state,
      cards,
      updatedAtUtc: nowUtcMarker(),
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
    geminiApiKeyObfuscated: "",
    outputDirectory: null,
    transcriptionModel: "gemini-3.1-pro-preview",
    metadataModel: "gemini-3.1-pro-preview",
    defaultTimezone: systemTimezone,
    timestampPatterns: [
      "(?<year>\\d{2}(?:\\d{2})?)(?<month>\\d{2})(?<day>\\d{2})[-_](?<hour>\\d{2})(?<minute>\\d{2})(?<second>\\d{2})?",
    ],
    prompts: {
      title:
        "Write a single concise title in the same language as the transcript that accurately summarizes the content. Output only the title text — no prefix such as \"Title:\", no quotes, no markdown formatting, no explanation, and no trailing period unless the title is a naturally complete sentence.\n\nTranscript:\n{transcript}",
      slug:
        "Create a short English URL slug for the title below. Use only lowercase letters (a–z), digits (0–9), and hyphens (-). Do not start or end with a hyphen. Aim for 3–6 words. Output only the slug — no label, no quotes, no markdown, no explanation.\n\nTitle:\n{title}",
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
    updatedAtUtc: nowUtcMarker(),
  };
}

export function summarizeSettings(settings: MumblerSettings): SettingsSummary {
  return {
    hasGeminiApiKey: decodeGeminiApiKey(settings.geminiApiKeyObfuscated).length > 0,
    outputDirectory: settings.outputDirectory,
    transcriptionModel: settings.transcriptionModel,
    metadataModel: settings.metadataModel,
    defaultTimezone: settings.defaultTimezone,
    timestampPatternCount: settings.timestampPatterns.length,
    previewSnippetSeconds: settings.previewSnippetSeconds,
    concurrencyLimit: settings.concurrencyLimit,
  };
}

export function buildSettingsDraft(settings: MumblerSettings): SettingsDraft {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    hasGeminiApiKey: decodeGeminiApiKey(settings.geminiApiKeyObfuscated).length > 0,
    geminiApiKeyInput: "",
    clearGeminiApiKey: false,
    outputDirectory: settings.outputDirectory ?? "",
    transcriptionModel: settings.transcriptionModel,
    metadataModel: settings.metadataModel,
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
  };
}

export function applySettingsDraft(current: MumblerSettings, draft: SettingsDraft): MumblerSettings {
  const transcriptionModel = draft.transcriptionModel.trim();
  const metadataModel = draft.metadataModel.trim();
  const defaultTimezone = draft.defaultTimezone.trim();
  const titlePrompt = draft.titlePrompt.trim();
  const slugPrompt = draft.slugPrompt.trim();
  const outputDirectory = draft.outputDirectory.trim();
  const timestampPatterns = deduplicateStrings(parseSettingsEntries(draft.timestampPatternsText));

  if (transcriptionModel.length === 0) {
    throw new Error("Transcription model is required.");
  }

  if (metadataModel.length === 0) {
    throw new Error("Metadata model is required.");
  }

  if (!isSupportedTimezone(defaultTimezone)) {
    throw new Error("Default timezone must be a valid IANA timezone.");
  }

  if (timestampPatterns.length === 0) {
    throw new Error("Add at least one timestamp regex pattern.");
  }

  requirePromptPlaceholders(titlePrompt, ["{transcript}"], "Title prompt");
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

  if (retryMaxDelayMs < retryInitialDelayMs) {
    throw new Error("Retry max delay must be greater than or equal to retry initial delay.");
  }

  return {
    ...current,
    geminiApiKeyObfuscated: resolveGeminiApiKeyObfuscated(current, draft),
    outputDirectory: outputDirectory.length === 0 ? null : outputDirectory,
    transcriptionModel,
    metadataModel,
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
