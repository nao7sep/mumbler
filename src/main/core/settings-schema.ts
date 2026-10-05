import type {
  MumblerCard,
  MumblerSettings,
  MumblerQueue,
  PendingImportReviewItem,
  SettingsDraft,
  SettingsSummary,
} from "@shared/app-shell";
import { homedir } from "node:os";
import {
  DEFAULT_TIMESTAMP_PATTERN,
  SYSTEM_TIMEZONE,
  formatUtcIsoCompact,
  isValidTimezone,
  normalizeUtcMs,
  resolveTimezone,
} from "@shared/timestamps";
import { isLanguage, normalizeLanguagePreference } from "@shared/i18n/languages";
import { isPositiveIntegerSetting, isRatioSetting } from "@shared/settings-validation";
import { THEME_PREFERENCES } from "@shared/app-shell";
import { AI_ROLES, defaultModelFor, GEMINI_ENDPOINT, rowFor, thinkingFor, type AiRole } from "@shared/ai-models";
import { JsonStore } from "./json-store";
import { OperationError } from "./operation-error";
import { resolvePathFromHome } from "./storage-root";
import { multiline, singleLine } from "./text-cleanup";

// Version 2 keeps each card's transcription and structured outline in the card's
// own file under transcripts/ (TranscriptStore), not in queue.json. Version 1
// files still load: their bodies are read here and moved out on first launch.
const QUEUE_SCHEMA_VERSION = 2;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// One validator per set serves the reader and applySettingsDraft
// (config-sets-conventions, "Reading and healing"): it returns why a value is not
// valid, or null.
type SetValidator = (value: unknown) => string | null;

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function text(label: string): SetValidator {
  return (value) => (isText(value) ? null : `${label} must be text.`);
}

function path(label: string): SetValidator {
  return (value) => (value === null || isText(value) ? null : `${label} must be a path.`);
}

function positiveInteger(label: string, value: unknown): string | null {
  return typeof value === "number" && isPositiveIntegerSetting(value) ? null : `${label} must be a positive integer.`;
}

function positive(label: string): SetValidator {
  return (value) => positiveInteger(label, value);
}

function model(label: string): SetValidator {
  return (value) => (isText(value) && value.trim().length > 0 ? null : `${label} model is required.`);
}

function timestampPatternIssue(value: unknown): string | null {
  if (!isText(value) || value.length === 0) return "Timestamp pattern is required.";
  try {
    new RegExp(value);
    return null;
  } catch {
    return "Timestamp pattern must be a valid regular expression.";
  }
}

function endpointIssue(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    if (isText(value) && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) {
      return null;
    }
  } catch { /* reported below */ }
  return "Endpoint must be an HTTP or HTTPS URL without credentials, query, or fragment.";
}

function promptIssue(prompt: string, placeholders: readonly string[], label: string): string | null {
  if (prompt.length === 0) return `${label} is required.`;
  if (placeholders.some((placeholder) => prompt.includes(placeholder))) return null;
  return placeholders.length === 1
    ? `${label} must include ${placeholders[0]}.`
    : `${label} must include one of ${placeholders.join(" or ")}.`;
}

function promptsIssue(value: unknown): string | null {
  const prompts = asRecord(value);
  if (prompts === null || ![prompts.structured, prompts.title, prompts.slug].every(isText)) {
    return "Prompts must be text.";
  }
  return promptIssue(prompts.structured as string, ["{transcript}"], "Structured prompt") ??
    promptIssue(prompts.title as string, ["{transcript}", "{structured}"], "Title prompt") ??
    promptIssue(prompts.slug as string, ["{title}"], "Slug prompt");
}

function retryPolicyIssue(value: unknown): string | null {
  const policy = asRecord(value);
  if (policy === null) return "Retry policy must be a set of numbers.";
  const issue = positiveInteger("Retry max retries", policy.maxRetries) ??
    positiveInteger("Retry initial delay", policy.initialDelayMs) ??
    positiveInteger("Retry max delay", policy.maxDelayMs) ??
    (typeof policy.jitterRatio === "number" && isRatioSetting(policy.jitterRatio) ? null : "Retry jitter ratio must be between 0 and 1.");
  if (issue !== null) return issue;
  return (policy.maxDelayMs as number) < (policy.initialDelayMs as number)
    ? "Retry max delay must be greater than or equal to retry initial delay."
    : null;
}

function timeoutsIssue(value: unknown): string | null {
  const timeouts = asRecord(value);
  if (timeouts === null) return "Timeouts must be a set of numbers.";
  return positiveInteger("Transcription timeout", timeouts.transcriptionMs) ??
    positiveInteger("Metadata timeout", timeouts.metadataMs);
}

// The declared set keys also own the shape boundary and unknown-key filtering.
const SETTINGS_SETS = {
  language: (value) => (value === "system" || isLanguage(value) ? null : "Language must be System or a supported language."),
  theme: (value) => (THEME_PREFERENCES.some(({ value: theme }) => theme === value) ? null : "Theme must be System, Light, or Dark."),
  uiFontFamily: text("UI font"),
  outputDirectory: path("Output directory"),
  backupDirectory: path("Backup directory"),
  defaultTimezone: (value) => (isText(value) && (value === SYSTEM_TIMEZONE || isValidTimezone(value)) ? null : "Default timezone must be a valid IANA timezone."),
  timestampPattern: timestampPatternIssue,
  skipIntervalSec: positive("Skip interval"),
  previewSnippetSeconds: positive("Preview snippet seconds"),
  "gemini.endpoint": endpointIssue,
  "gemini.transcription": model("Transcription"),
  "gemini.outline": model("Outline"),
  "gemini.metadata": model("Metadata"),
  "gemini.thinking.transcription": text("Transcription thinking"),
  "gemini.thinking.outline": text("Outline thinking"),
  "gemini.thinking.metadata": text("Metadata thinking"),
  concurrencyLimit: positive("Concurrency limit"),
  prompts: promptsIssue,
  retryPolicy: retryPolicyIssue,
  timeouts: timeoutsIssue,
  checkUpdatesAtLaunch: (value) => (typeof value === "boolean" ? null : "Check for updates at launch must be on or off."),
} satisfies Record<keyof MumblerSettings, SetValidator>;
const SETTINGS_SET_KEYS = Object.keys(SETTINGS_SETS) as (keyof MumblerSettings)[];

function knownSettings(raw: Record<string, unknown>): Partial<MumblerSettings> {
  return Object.fromEntries(SETTINGS_SET_KEYS.filter((key) => Object.hasOwn(raw, key)).map((key) => [key, raw[key]]));
}

const MODEL_SET_KEYS: ReadonlySet<string> = new Set(AI_ROLES.map((role) => `gemini.${role.id}`));
const THINKING_SET_ROLES: ReadonlyMap<string, AiRole> = new Map(AI_ROLES.map((role) => [`gemini.thinking.${role.id}`, role.id]));

// Values arrive cleaned (applySettingsDraft cleans text at Save); a model id is its
// own key, so it is compared trimmed and case-insensitively. A role's thinking
// equals its built-in while the value it sends is the default for the model the
// role selects, and always for a model with no row.
function equalsBuiltIn(key: keyof MumblerSettings, settings: MumblerSettings, builtIn: MumblerSettings): boolean {
  const value = settings[key];
  const role = THINKING_SET_ROLES.get(key);
  if (role) {
    const row = rowFor(settings[`gemini.${role}`]);
    return !row || thinkingFor(row.id, String(value)) === row.defaultThinking;
  }
  if (MODEL_SET_KEYS.has(key)) {
    return typeof value === "string" && value.trim().toLowerCase() === String(builtIn[key]).toLowerCase();
  }
  return JSON.stringify(value) === JSON.stringify(builtIn[key]);
}

// What the file holds for these settings: every set that differs from its built-in.
function storedSets(settings: MumblerSettings): Partial<MumblerSettings> {
  const builtIn = createDefaultSettings();
  return Object.fromEntries(
    SETTINGS_SET_KEYS.filter((key) => !equalsBuiltIn(key, settings, builtIn)).map((key) => [key, settings[key]]),
  );
}

function sameSets(a: Partial<MumblerSettings>, b: Partial<MumblerSettings>): boolean {
  const keys = Object.keys(a) as (keyof MumblerSettings)[];
  return keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

function normalizeSettings(
  raw: Partial<MumblerSettings>,
  homeDirectory: string,
  warn: (key: keyof MumblerSettings) => void,
): MumblerSettings {
  const settings = createDefaultSettings();
  for (const key of SETTINGS_SET_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    if (SETTINGS_SETS[key](raw[key]) !== null) {
      warn(key);
      continue;
    }
    Object.assign(settings, { [key]: raw[key] });
  }
  for (const key of ["outputDirectory", "backupDirectory"] as const) {
    const path = settings[key]?.trim() ?? "";
    settings[key] = path.length === 0 ? null : resolvePathFromHome(path, homeDirectory);
  }
  return settings;
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
  const transcriptionRun = normalizeAiRunInfo(card.ai?.transcription);
  // Before a trim kept results, every stored transcription matched the card's
  // current trim, so a record without transcribedTrim takes it from there. The
  // text itself lives in the card's transcript file, so the run info is what
  // says a transcription exists.
  const transcribedTrim =
    transcriptionRun === null ? null : (card.transcribedTrim ?? { ...card.trim });

  return {
    ...card,
    audioProfile: card.audioProfile ?? null,
    transcription: { text: card.transcription?.text ?? null },
    transcribedTrim,
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
      transcription: transcriptionRun,
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

function normalizeQueue(raw: Record<string, unknown>, defaults: MumblerQueue): MumblerQueue {
  return {
    schemaVersion: QUEUE_SCHEMA_VERSION,
    pendingImports: Array.isArray(raw.pendingImports)
      ? (raw.pendingImports as PendingImportReviewItem[]).map(normalizePendingImportRecord)
      : defaults.pendingImports,
    cards: Array.isArray(raw.cards)
      ? (raw.cards as MumblerCard[]).map(normalizeCardRecord)
      : defaults.cards,
  };
}

// Render in-memory state to its on-disk shape: every UTC instant (stored as an
// epoch-ms number and named with the convention's `*Utc` suffix) becomes the
// canonical ISO-8601 string, while everything else passes through unchanged.
// The model keeps epoch-ms for arithmetic/sorting; this converts only at the
// persistence edge. The read path (normalizeUtcMs) accepts both ISO and
// epoch-ms, so a legacy numeric queue.json keeps loading and is rewritten as ISO
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

// The transcription and structured outline are written by TranscriptStore into
// each card's own file, so queue.json stays small and its frequent saves record
// small rows in the backup history.
export function serializeQueue(state: MumblerQueue): unknown {
  return serializeUtcInstants({
    ...state,
    cards: state.cards.map(({ transcription: _bodyInOwnFile, metadata, ...card }) => ({
      ...card,
      metadata: { title: metadata.title, slug: metadata.slug },
    })),
  });
}

export function recoverInterruptedCards(
  state: MumblerQueue,
): { state: MumblerQueue; recoveredInterruptedCards: number; restoredSavingCards: number } {
  let recoveredInterruptedCards = 0;
  let restoredSavingCards = 0;

  const cards = state.cards.map((card) => {
    // A save that did not finish published nothing it kept (its output is staged
    // and rolled back), so the card is simply ready to save again.
    if (card.status === "Saving") {
      restoredSavingCards += 1;
      return { ...card, status: "Ready to Save" as const };
    }

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
    },
    recoveredInterruptedCards,
    restoredSavingCards,
  };
}

export function createDefaultSettings(): MumblerSettings {
  return {
    language: "system",
    // Appearance
    theme: "system",
    uiFontFamily: "",
    // Files
    outputDirectory: null,
    backupDirectory: null,
    // Import
    // Follows the computer's zone; a zone the user picks is kept instead.
    defaultTimezone: SYSTEM_TIMEZONE,
    timestampPattern: DEFAULT_TIMESTAMP_PATTERN,
    // Player
    skipIntervalSec: 10,
    previewSnippetSeconds: 10,
    "gemini.endpoint": GEMINI_ENDPOINT,
    "gemini.transcription": defaultModelFor("gemini", "transcription"),
    "gemini.outline": defaultModelFor("gemini", "text-balanced"),
    "gemini.metadata": defaultModelFor("gemini", "text-fast"),
    "gemini.thinking.transcription": rowFor(defaultModelFor("gemini", "transcription"))!.defaultThinking,
    "gemini.thinking.outline": rowFor(defaultModelFor("gemini", "text-balanced"))!.defaultThinking,
    "gemini.thinking.metadata": rowFor(defaultModelFor("gemini", "text-fast"))!.defaultThinking,
    concurrencyLimit: 3,
    prompts: {
      structured:
        "Reorganize the transcript into a well-structured Markdown outline. Preserve all information; resolve obvious self-contradictions using surrounding context. Use the transcript's language. Output Markdown only.\n\n<transcript>\n{transcript}\n</transcript>",
      title:
        "Write a single concise title in the source's language that summarizes the content. The title is plain text with no prefix, no quotation marks around it, no markdown, and no trailing period unless it is a complete sentence.\n\n<source>\n{structured}\n</source>",
      slug:
        "Create a short English URL slug for the title. Lowercase a–z, digits, and hyphens only. No leading or trailing hyphen. Aim for 3–6 words.\n\n<title>\n{title}\n</title>",
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

// Settings keep the user map separate from effective built-ins. Saves run inside
// the JsonStore write queue; the app holds a single-instance lock.
export class SettingsStore {
  private readonly store: JsonStore<Partial<MumblerSettings>>;

  constructor(
    path: string,
    private readonly homeDirectory: string,
    private readonly warn: (key: keyof MumblerSettings) => void,
  ) {
    this.store = new JsonStore({ path, validate: knownSettings, createDefault: () => ({}) });
  }

  get path(): string { return this.store.path; }

  async load() {
    const loaded = await this.store.load();
    return { ...loaded, value: normalizeSettings(loaded.value, this.homeDirectory, this.warn) };
  }

  // The one owner of what a save stores: the file is built from the full settings
  // the app holds, every set that differs from its built-in written whole. A save
  // that changes nothing on disk writes nothing, and one that leaves no set writes `{}`.
  async save(settings: MumblerSettings): Promise<void> {
    const next = storedSets(settings);
    await this.store.update((current) => (sameSets(current, next) ? undefined : next));
  }

  flush(): Promise<void> { return this.store.flush(); }
  preserveExistingFiles(): Promise<string[]> { return this.store.preserveExistingFiles(); }
}

export function createSettingsStore(
  path: string,
  homeDirectory: string = homedir(),
  warn: (key: keyof MumblerSettings) => void = (key) => console.warn(`Invalid settings set: ${key}`),
): SettingsStore {
  return new SettingsStore(path, homeDirectory, warn);
}

export function createQueueStore(path: string): JsonStore<MumblerQueue> {
  return new JsonStore<MumblerQueue>({
    path,
    schemaVersion: QUEUE_SCHEMA_VERSION,
    validate: (raw) => normalizeQueue(raw, createEmptyQueue()),
    createDefault: () => createEmptyQueue(),
    serialize: serializeQueue,
  });
}

export function createEmptyQueue(): MumblerQueue {
  return {
    schemaVersion: QUEUE_SCHEMA_VERSION,
    pendingImports: [],
    cards: [],
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
    defaultTimezone: resolveTimezone(settings.defaultTimezone),
    // Player
    skipIntervalSec: settings.skipIntervalSec,
    previewSnippetSeconds: settings.previewSnippetSeconds,
    // AI
    hasGeminiApiKey,
    transcriptionModel: settings["gemini.transcription"],
    outlineModel: settings["gemini.outline"],
    metadataModel: settings["gemini.metadata"],
    concurrencyLimit: settings.concurrencyLimit,
    checkUpdatesAtLaunch: settings.checkUpdatesAtLaunch,
  };
}

// The draft shows the value a role sends; a model with no row keeps the stored one.
function draftThinking(settings: MumblerSettings, role: AiRole): string {
  const chosen = settings[`gemini.thinking.${role}`];
  return thinkingFor(settings[`gemini.${role}`], chosen) ?? chosen;
}

export function buildSettingsDraft(
  settings: MumblerSettings,
  defaultOutputDirectory: string,
  defaultBackupDirectory: string,
  hasGeminiApiKey: boolean,
): SettingsDraft {
  return {
    language: settings.language,
    // Appearance
    theme: settings.theme,
    uiFontFamily: settings.uiFontFamily,
    // Files
    outputDirectory: settings.outputDirectory ?? "",
    defaultOutputDirectory,
    backupDirectory: settings.backupDirectory ?? "",
    defaultBackupDirectory,
    // Import
    defaultTimezone: settings.defaultTimezone,
    timestampPattern: settings.timestampPattern,
    // Player
    skipIntervalSec: settings.skipIntervalSec,
    previewSnippetSeconds: settings.previewSnippetSeconds,
    // AI (presence only; the key value is never part of the draft)
    hasGeminiApiKey,
    geminiEndpoint: settings["gemini.endpoint"],
    transcriptionModel: settings["gemini.transcription"],
    outlineModel: settings["gemini.outline"],
    metadataModel: settings["gemini.metadata"],
    transcriptionThinking: draftThinking(settings, "transcription"),
    outlineThinking: draftThinking(settings, "outline"),
    metadataThinking: draftThinking(settings, "metadata"),
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

export function applySettingsDraft(
  current: MumblerSettings,
  draft: SettingsDraft,
  homeDirectory: string = homedir(),
): MumblerSettings {
  const outputDirectory = draft.outputDirectory.trim();
  const backupDirectory = draft.backupDirectory.trim();
  const next: MumblerSettings = {
    ...current,
    language: normalizeLanguagePreference(draft.language),
    // Appearance
    theme: draft.theme,
    // Free text; blank means the built-in default stack.
    uiFontFamily: singleLine(draft.uiFontFamily),
    // Files
    outputDirectory:
      outputDirectory.length === 0
        ? null
        : resolvePathFromHome(outputDirectory, homeDirectory),
    backupDirectory:
      backupDirectory.length === 0
        ? null
        : resolvePathFromHome(backupDirectory, homeDirectory),
    // Import
    defaultTimezone: singleLine(draft.defaultTimezone),
    timestampPattern: singleLine(draft.timestampPattern),
    // Player
    skipIntervalSec: draft.skipIntervalSec,
    previewSnippetSeconds: draft.previewSnippetSeconds,
    // AI (the Gemini key is set via its own IPC path, not this draft)
    "gemini.endpoint": singleLine(draft.geminiEndpoint),
    "gemini.transcription": draft.transcriptionModel.trim(),
    "gemini.outline": draft.outlineModel.trim(),
    "gemini.metadata": draft.metadataModel.trim(),
    "gemini.thinking.transcription": draft.transcriptionThinking,
    "gemini.thinking.outline": draft.outlineThinking,
    "gemini.thinking.metadata": draft.metadataThinking,
    concurrencyLimit: draft.concurrencyLimit,
    // Prompt templates are multi-line bodies (instructions plus <transcript>/<source>/
    // <title> blocks). A scalar .trim() eats the first line's indentation and leaves
    // interior trailing whitespace, so clean them as multiline bodies. They are plain
    // LLM instructions, not Markdown relying on two-trailing-spaces hard breaks, so the
    // defaults (trim line ends, drop edge blanks, keep interior blanks) are correct.
    prompts: {
      structured: multiline(draft.structuredPrompt),
      title: multiline(draft.titlePrompt),
      slug: multiline(draft.slugPrompt),
    },
    retryPolicy: {
      maxRetries: draft.retryMaxRetries,
      initialDelayMs: draft.retryInitialDelayMs,
      maxDelayMs: draft.retryMaxDelayMs,
      jitterRatio: draft.retryJitterRatio,
    },
    timeouts: {
      transcriptionMs: draft.transcriptionTimeoutMs,
      metadataMs: draft.metadataTimeoutMs,
    },
  };
  for (const key of SETTINGS_SET_KEYS) {
    const issue = SETTINGS_SETS[key](next[key]);
    if (issue !== null) throw new OperationError(issue);
  }
  return next;
}
