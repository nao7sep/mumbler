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
import { AI_ROLES, defaultModelFor, GEMINI_ENDPOINT } from "@shared/ai-models";
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

function asPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

type SettingsValidator = (value: unknown) => boolean;
const isString: SettingsValidator = (value) => typeof value === "string";
const isPath: SettingsValidator = (value) => value === null || isString(value);
const isPositive: SettingsValidator = (value) => asPositiveInteger(value) !== null;
function hasMembers(value: unknown, members: Record<string, SettingsValidator>): boolean {
  const record = asRecord(value);
  return record !== null && Object.entries(members).every(([key, valid]) => valid(record[key]));
}

// The declared set keys also own the shape boundary and unknown-key filtering.
const SETTINGS_SETS = {
  language: (value) => value === "system" || isLanguage(value),
  theme: (value) => THEME_PREFERENCES.some(({ value: theme }) => theme === value),
  uiFontFamily: isString,
  outputDirectory: isPath,
  backupDirectory: isPath,
  defaultTimezone: (value) => typeof value === "string" && (value === SYSTEM_TIMEZONE || isValidTimezone(value)),
  timestampPattern: isString,
  skipIntervalSec: isPositive,
  previewSnippetSeconds: isPositive,
  "gemini.endpoint": isString,
  "gemini.transcription": isString,
  "gemini.outline": isString,
  "gemini.metadata": isString,
  concurrencyLimit: isPositive,
  prompts: (value) => hasMembers(value, { structured: isString, title: isString, slug: isString }),
  retryPolicy: (value) => hasMembers(value, {
    maxRetries: isPositive, initialDelayMs: isPositive, maxDelayMs: isPositive,
    jitterRatio: (ratio) => typeof ratio === "number" && isRatioSetting(ratio),
  }),
  timeouts: (value) => hasMembers(value, { transcriptionMs: isPositive, metadataMs: isPositive }),
  checkUpdatesAtLaunch: (value) => typeof value === "boolean",
} satisfies Record<keyof MumblerSettings, SettingsValidator>;
const SETTINGS_SET_KEYS = Object.keys(SETTINGS_SETS) as (keyof MumblerSettings)[];

function knownSettings(raw: Record<string, unknown>): Partial<MumblerSettings> {
  return Object.fromEntries(SETTINGS_SET_KEYS.filter((key) => Object.hasOwn(raw, key)).map((key) => [key, raw[key]]));
}

const MODEL_SET_KEYS: ReadonlySet<string> = new Set(AI_ROLES.map((role) => `gemini.${role.id}`));

// Values arrive cleaned (applySettingsDraft cleans text at Save); a model id is its
// own key, so it is compared trimmed and case-insensitively.
function equalsBuiltIn(key: keyof MumblerSettings, value: unknown, builtIn: MumblerSettings): boolean {
  if (MODEL_SET_KEYS.has(key)) {
    return typeof value === "string" && value.trim().toLowerCase() === String(builtIn[key]).toLowerCase();
  }
  return JSON.stringify(value) === JSON.stringify(builtIn[key]);
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
    if (!SETTINGS_SETS[key](raw[key])) {
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

// Settings keep the user map separate from effective built-ins. All patches
// re-read inside the JsonStore write queue; the app holds a single-instance lock.
export class SettingsStore {
  private readonly store: JsonStore<Partial<MumblerSettings>>;
  private readonly warned = new Set<keyof MumblerSettings>();

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
    return { ...loaded, value: normalizeSettings(loaded.value, this.homeDirectory, (key) => {
      if (this.warned.has(key)) return;
      this.warned.add(key);
      this.warn(key);
    }) };
  }

  // The one owner of what a save stores: each given set is removed while it equals
  // its built-in and written whole otherwise. A save that changes nothing on disk
  // writes nothing, and one that leaves no set deletes the file.
  async save(sets: Partial<MumblerSettings>): Promise<void> {
    const builtIn = createDefaultSettings();
    await this.store.update((current) => {
      const next = { ...current };
      for (const [key, value] of Object.entries(knownSettings(sets)) as [keyof MumblerSettings, unknown][]) {
        if (equalsBuiltIn(key, value, builtIn)) delete next[key];
        else Object.assign(next, { [key]: value });
      }
      if (sameSets(current, next)) return undefined;
      return Object.keys(next).length === 0 ? null : next;
    });
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
  const defaultTimezone = singleLine(draft.defaultTimezone);
  const timestampPattern = singleLine(draft.timestampPattern);
  const geminiEndpoint = singleLine(draft.geminiEndpoint);
  const outlineModel = draft.outlineModel.trim();
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

  if (!THEME_PREFERENCES.some(({ value }) => value === draft.theme)) {
    throw new OperationError("Theme must be System, Light, or Dark.");
  }

  if (defaultTimezone !== SYSTEM_TIMEZONE && !isValidTimezone(defaultTimezone)) {
    throw new OperationError("Default timezone must be a valid IANA timezone.");
  }

  if (timestampPattern.length === 0) {
    throw new OperationError("Timestamp pattern is required.");
  }
  try {
    new RegExp(timestampPattern);
  } catch {
    throw new OperationError("Timestamp pattern must be a valid regular expression.");
  }

  try {
    const url = new URL(geminiEndpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { throw new OperationError("Endpoint must be an HTTP or HTTPS URL without credentials, query, or fragment."); }
  if (!outlineModel) throw new OperationError("Outline model is required.");

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
    defaultTimezone,
    timestampPattern,
    // Player
    skipIntervalSec,
    previewSnippetSeconds,
    // AI (the Gemini key is set via its own IPC path, not this draft)
    "gemini.endpoint": geminiEndpoint,
    "gemini.transcription": transcriptionModel,
    "gemini.outline": outlineModel,
    "gemini.metadata": metadataModel,
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
