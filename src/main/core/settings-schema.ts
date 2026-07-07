import type {
  MumblerCard,
  MumblerSettings,
  MumblerState,
  PendingImportReviewItem,
  SettingsDraft,
  SettingsSummary,
} from "@shared/app-shell";
import {
  formatUtcIsoCompact,
  isValidTimezone,
  normalizeUtcMs,
} from "@shared/timestamps";
import { isPositiveIntegerSetting, isRatioSetting } from "@shared/settings-validation";
import { JsonStore } from "./json-store";
import { OperationError } from "./operation-error";
import { multiline } from "./text-cleanup";

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
    // Appearance — free text; blank resolves to the built-in default stack at apply time.
    uiFontFamily: asString(raw.uiFontFamily) ?? defaults.uiFontFamily,
    // Files
    outputDirectory: asNullableString(raw.outputDirectory),
    backupDirectory: asNullableString(raw.backupDirectory),
    // Import
    defaultTimezone:
      asString(raw.defaultTimezone) && isValidTimezone(asString(raw.defaultTimezone)!)
        ? (asString(raw.defaultTimezone) as string)
        : defaults.defaultTimezone,
    timestampPatterns: asStringArray(raw.timestampPatterns) ?? defaults.timestampPatterns,
    // Player
    skipIntervalSec: asPositiveInteger(raw.skipIntervalSec) ?? defaults.skipIntervalSec,
    previewSnippetSeconds:
      asPositiveInteger(raw.previewSnippetSeconds) ?? defaults.previewSnippetSeconds,
    // AI
    // raw.geminiApiKeyObfuscated (a legacy key stored in this file before the
    // secrets-file move) is deliberately NOT carried over: it is dropped here on
    // load, and never written back, so the next save scrubs it from config.json.
    // Pre-release, this needs no migration — a user with a key in the old settings
    // simply re-enters it once into the dedicated secrets store.
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
    // The one managed-audio-tool toggle: check for updates at launch. Missing key
    // → default. Nothing auto-downloads or auto-installs, so there is no second
    // gate and no invariant between them.
    checkUpdatesAtLaunch:
      typeof raw.checkUpdatesAtLaunch === "boolean"
        ? raw.checkUpdatesAtLaunch
        : defaults.checkUpdatesAtLaunch,
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
  // queuedAtUtc is paired with queuedMode: when the card is queued, parse it
  // through normalizeUtcMs (which accepts both a number and the canonical ISO
  // string the store now writes) — the same way every other instant field is
  // read. A `typeof number` guard here would drop the value to null after a
  // save/reload now that instants serialize as ISO, and selectNextQueuedCard
  // would then skip the card forever.
  const queuedAtUtc = queuedMode !== null ? normalizeUtcMs(card.queuedAtUtc) : null;

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

// Render in-memory state to its on-disk shape: every UTC instant (stored as an
// epoch-ms number and named with the convention's `*Utc` suffix) becomes the
// canonical ISO-8601 string, while everything else passes through unchanged.
// The model keeps epoch-ms for arithmetic/sorting; this converts only at the
// persistence edge. The read path (normalizeUtcMs) accepts both ISO and
// epoch-ms, so a legacy numeric state.json keeps loading and is rewritten as ISO
// on the next save — no migration step.
function serializeUtcInstants(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(serializeUtcInstants);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, fieldValue]) => [
        key,
        /Utc$/.test(key) && typeof fieldValue === "number" && Number.isFinite(fieldValue)
          ? formatUtcIsoCompact(fieldValue)
          : serializeUtcInstants(fieldValue),
      ]),
    );
  }
  return value;
}

export function serializeState(state: MumblerState): unknown {
  return serializeUtcInstants(state);
}

export function recoverInterruptedCards(
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
    throw new OperationError(`${label} is required.`);
  }

  for (const placeholder of requiredPlaceholders) {
    if (!prompt.includes(placeholder)) {
      throw new OperationError(`${label} must include ${placeholder}.`);
    }
  }
}

function requirePromptAnyPlaceholder(
  prompt: string,
  acceptedPlaceholders: string[],
  label: string,
): void {
  if (prompt.length === 0) {
    throw new OperationError(`${label} is required.`);
  }

  if (!acceptedPlaceholders.some((placeholder) => prompt.includes(placeholder))) {
    throw new OperationError(`${label} must include one of ${acceptedPlaceholders.join(" or ")}.`);
  }
}

function requirePositiveInteger(value: number, label: string): number {
  if (!isPositiveIntegerSetting(value)) {
    throw new OperationError(`${label} must be a positive integer.`);
  }

  return value;
}

function requireRatio(value: number, label: string): number {
  if (!isRatioSetting(value)) {
    throw new OperationError(`${label} must be between 0 and 1.`);
  }

  return value;
}

export function getSystemTimezone(): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezone && timezone.length > 0 && isValidTimezone(timezone) ? timezone : "UTC";
}

export function createDefaultSettings(systemTimezone: string): MumblerSettings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    // Appearance
    uiFontFamily: "",
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
    // Managed audio tools default to a non-blocking update check on launch.
    // Nothing auto-downloads: a missing required tool opens the Audio Tools
    // surface for the user to install it.
    checkUpdatesAtLaunch: true,
  };
}

// Stores for the two canonical files. Each owns serialized atomic writes and
// non-destructive loading (missing → defaults, malformed or newer-than-supported
// → CorruptStateError with the file left untouched).
// Startup recovery (recoverInterruptedCards) and filesystem reconciliation are
// applied by the caller after load, keeping the store a pure persistence layer.
export function createSettingsStore(path: string): JsonStore<MumblerSettings> {
  return new JsonStore<MumblerSettings>({
    path,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    validate: (raw) => normalizeSettings(raw, createDefaultSettings(getSystemTimezone())),
    createDefault: () => createDefaultSettings(getSystemTimezone()),
  });
}

export function createStateStore(path: string): JsonStore<MumblerState> {
  return new JsonStore<MumblerState>({
    path,
    schemaVersion: STATE_SCHEMA_VERSION,
    validate: (raw) => normalizeState(raw, createEmptyState()),
    createDefault: () => createEmptyState(),
    serialize: serializeState,
  });
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

// hasGeminiApiKey is resolved by the caller (the runtime) from the dedicated
// secrets store + environment, not derived from settings — the key no longer
// lives in MumblerSettings. summarizeSettings stays a pure projection.
export function summarizeSettings(
  settings: MumblerSettings,
  defaultOutputDirectory: string,
  defaultBackupDirectory: string,
  hasGeminiApiKey: boolean,
): SettingsSummary {
  return {
    // Appearance
    uiFontFamily: settings.uiFontFamily,
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
    hasGeminiApiKey,
    transcriptionModel: settings.transcriptionModel,
    metadataModel: settings.metadataModel,
    concurrencyLimit: settings.concurrencyLimit,
    checkUpdatesAtLaunch: settings.checkUpdatesAtLaunch,
  };
}

export function buildSettingsDraft(
  settings: MumblerSettings,
  defaultOutputDirectory: string,
  defaultBackupDirectory: string,
  hasGeminiApiKey: boolean,
): SettingsDraft {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    // Appearance
    uiFontFamily: settings.uiFontFamily,
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
    // AI (presence only; the key value is never part of the draft)
    hasGeminiApiKey,
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
  // Prompt templates are multi-line bodies (instructions plus <transcript>/<source>/
  // <title> blocks). A scalar .trim() eats the first line's indentation and leaves
  // interior trailing whitespace, so clean them as multiline bodies. They are plain
  // LLM instructions, not Markdown relying on two-trailing-spaces hard breaks, so the
  // defaults (trim line ends, drop edge blanks, keep interior blanks) are correct.
  const structuredPrompt = multiline(draft.structuredPrompt);
  const titlePrompt = multiline(draft.titlePrompt);
  const slugPrompt = multiline(draft.slugPrompt);

  if (!isValidTimezone(defaultTimezone)) {
    throw new OperationError("Default timezone must be a valid IANA timezone.");
  }

  if (timestampPatterns.length === 0) {
    throw new OperationError("Add at least one timestamp regex pattern.");
  }

  if (transcriptionModel.length === 0) {
    throw new OperationError("Transcription model is required.");
  }

  if (metadataModel.length === 0) {
    throw new OperationError("Metadata model is required.");
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
    throw new OperationError("Retry max delay must be greater than or equal to retry initial delay.");
  }

  return {
    ...current,
    // Appearance — free text; blank means the built-in default stack.
    uiFontFamily: draft.uiFontFamily.trim(),
    // Files
    outputDirectory: outputDirectory.length === 0 ? null : outputDirectory,
    backupDirectory: backupDirectory.length === 0 ? null : backupDirectory,
    // Import
    defaultTimezone,
    timestampPatterns,
    // Player
    skipIntervalSec,
    previewSnippetSeconds,
    // AI (the Gemini key is set via its own IPC path, not this draft)
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

