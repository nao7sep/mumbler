import type {
  MumblerCard,
  MumblerSettings,
  MumblerQueue,
  PendingImportReviewItem,
  SettingsDraft,
  SettingsSummary,
} from "@shared/app-shell";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  DEFAULT_TIMESTAMP_PATTERN,
  SYSTEM_TIMEZONE,
  formatUtcIsoCompact,
  isValidTimezone,
  parseUtcMs,
  resolveTimezone,
} from "@shared/timestamps";
import { isLanguage, normalizeLanguagePreference } from "@shared/i18n/languages";
import { isPositiveIntegerSetting, isRatioSetting } from "@shared/settings-validation";
import { CARD_STATUSES, THEME_PREFERENCES } from "@shared/app-shell";
import { AI_ROLES, defaultModelFor, GEMINI_ENDPOINT, rowFor, thinkingFor, type AiRole } from "@shared/ai-models";
import { FORMAT_VERSIONS } from "./format-versions";
import { CorruptStateError, JsonStore, type LoadResult } from "./json-store";
import { OperationError } from "./operation-error";
import { resolvePathFromHome } from "./storage-root";
import { multiline, singleLine } from "./text-cleanup";

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
  backupDirectory: path("Originals directory"),
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
  checkReleasesAtLaunch: (value) => (typeof value === "boolean" ? null : "Check GitHub for new releases at launch must be on or off."),
} satisfies Record<keyof MumblerSettings, SetValidator>;
const SETTINGS_SET_KEYS = Object.keys(SETTINGS_SETS) as (keyof MumblerSettings)[];

// What a settings file holds that this build cannot use (config-sets-conventions):
// keys it does not know, as a newer Mumbler may write, and known sets whose value
// fails their check. Both are kept as written, so a save never erases them.
interface UnusableSets {
  unknown: Record<string, unknown>;
  invalid: Partial<Record<keyof MumblerSettings, unknown>>;
}

function unusableSets(raw: Record<string, unknown>): UnusableSets {
  const unknown: Record<string, unknown> = {};
  const invalid: Partial<Record<keyof MumblerSettings, unknown>> = {};
  for (const key of Object.keys(raw)) {
    if (key === "formatVersion") continue;
    if (!Object.hasOwn(SETTINGS_SETS, key)) unknown[key] = raw[key];
    else if (SETTINGS_SETS[key as keyof MumblerSettings](raw[key]) !== null) invalid[key as keyof MumblerSettings] = raw[key];
  }
  return { unknown, invalid };
}

const MODEL_SET_KEYS: ReadonlySet<string> = new Set(AI_ROLES.map((role) => `gemini.${role.id}`));
const THINKING_SET_ROLES: ReadonlyMap<string, AiRole> = new Map(AI_ROLES.map((role) => [`gemini.thinking.${role.id}`, role.id]));

// Values arrive cleaned (applySettingsDraft cleans text at Save); a model id is its
// own key, so it is compared trimmed and case-insensitively. A role's thinking
// equals its built-in while the value it sends is the default for the model the
// role selects; under a model with no row it is kept, unsent, while it differs
// from the built-in.
function equalsBuiltIn(key: keyof MumblerSettings, settings: MumblerSettings, builtIn: MumblerSettings): boolean {
  const value = settings[key];
  const role = THINKING_SET_ROLES.get(key);
  if (role) {
    const row = rowFor(settings[`gemini.${role}`]);
    return row ? thinkingFor(row.id, String(value)) === row.defaultThinking : value === builtIn[key];
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
  // A thinking choice is stored only while it differs from the selected model's own
  // default, so one the file does not hold is that model's default, not the role's
  // built-in (which belongs to the role's default model).
  for (const [key, role] of THINKING_SET_ROLES) {
    const setKey = key as keyof MumblerSettings;
    const stored = Object.hasOwn(raw, setKey) && SETTINGS_SETS[setKey](raw[setKey]) === null;
    const row = rowFor(settings[`gemini.${role}`]);
    if (!stored && row) Object.assign(settings, { [key]: row.defaultThinking });
  }
  for (const key of ["outputDirectory", "backupDirectory"] as const) {
    const path = settings[key]?.trim() ?? "";
    settings[key] = path.length === 0 ? null : resolvePathFromHome(path, homeDirectory);
  }
  return settings;
}

// A time the queue file holds unreadable is taken from another time the same
// item recorded, and only an item that recorded none takes its audio file's
// modified time, never the moment of loading (content-lifecycle-conventions,
// "A missing time is not made up"). Each list is in the order a missing time is
// taken from: the item's own change times first.
function pendingImportRecordedTimes(item: PendingImportReviewItem): (number | null)[] {
  return [item.updatedAtUtc, item.createdAtUtc].map(parseUtcMs);
}

function cardRecordedTimes(card: MumblerCard): (number | null)[] {
  return [
    card.updatedAtUtc,
    card.createdAtUtc,
    card.queuedAtUtc,
    card.trimDecision?.analyzedAtUtc,
    card.ai.transcription?.generatedAtUtc,
    card.ai.structured?.generatedAtUtc,
    card.ai.title?.generatedAtUtc,
    card.ai.slug?.generatedAtUtc,
    card.lastError?.occurredAtUtc,
    card.timestamps.effectiveUtc,
    card.timestamps.confirmedUtc,
  ].map(parseUtcMs);
}

function firstRecorded(times: (number | null)[]): number | null {
  return times.find((time) => time !== null) ?? null;
}

// The queue fields the app reads or acts on, checked before anything is
// normalized: a wrong shape coerced to an empty list would let startup delete the
// transcripts as unreferenced (store-recovery-conventions).
// An absent list is empty; an absent time is taken from the item's other times.
function textIssue(owner: string, record: Record<string, unknown>, keys: readonly string[]): string | null {
  const key = keys.find((name) => typeof record[name] !== "string");
  return key === undefined ? null : `${owner} ${key} is not text`;
}

function objectOrNullIssue(owner: string, record: Record<string, unknown>, keys: readonly string[]): string | null {
  const key = keys.find((name) => record[name] !== null && asRecord(record[name]) === null);
  return key === undefined ? null : `${owner} ${key} is not an object or null`;
}

function pendingImportIssue(item: unknown): string | null {
  const record = asRecord(item);
  if (record === null) return "a pending import is not an object";
  const flag = ["deleteOriginalOnConfirm", "copyToBackupOnConfirm"].find((key) => typeof record[key] !== "boolean");
  return textIssue("a pending import's", record, [
    "id",
    "originalFilename",
    "originalSourcePath",
    "workingFilePath",
    "localTimestampText",
    "timezone",
    "utcTimestampText",
  ]) ?? (flag === undefined ? null : `a pending import's ${flag} is not true or false`);
}

function cardIssue(item: unknown): string | null {
  const card = asRecord(item);
  if (card === null) return "a card is not an object";
  const issue = textIssue("a card's", card, ["id", "originalFilename", "sourceFilePath", "status"]) ??
    objectOrNullIssue("a card's", card, ["trimDecision", "transcribedTrim", "lastError"]);
  if (issue !== null) return issue;
  if (!CARD_STATUSES.includes(card.status as MumblerCard["status"])) return "a card's status is unknown";
  const part = ["timestamps", "trim", "metadata", "ai"].find((key) => asRecord(card[key]) === null);
  if (part !== undefined) return `a card's ${part} is not an object`;
  for (const [name, trim] of [["trim", card.trim], ["transcribedTrim", card.transcribedTrim]] as const) {
    if (trim === null) continue;
    for (const key of ["frontMarkerSec", "backMarkerSec"]) {
      const value = (trim as Record<string, unknown>)[key];
      if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        return `a card's ${name} ${key} is not a non-negative finite number or null`;
      }
    }
  }
  const metadata = card.metadata as Record<string, unknown>;
  const label = ["title", "slug"].find((key) => metadata[key] !== null && typeof metadata[key] !== "string");
  return textIssue("a card's timestamps", card.timestamps as Record<string, unknown>, ["confirmedLocal", "effectiveLocal", "timezone"]) ??
    objectOrNullIssue("a card's ai", card.ai as Record<string, unknown>, ["transcription", "structured", "title", "slug"]) ??
    (label === undefined ? null : `a card's metadata ${label} is not text or null`);
}

function queueShapeIssue(raw: Record<string, unknown>): string | null {
  const lists = [["pendingImports", pendingImportIssue], ["cards", cardIssue]] as const;
  for (const [key, itemIssue] of lists) {
    if (!Object.hasOwn(raw, key)) continue;
    const list = raw[key];
    if (!Array.isArray(list)) return `${key} is not a list`;
    const ids = new Set<string>();
    for (const item of list) {
      const issue = itemIssue(item);
      if (issue !== null) return issue;
      const id = (item as Record<string, unknown>).id as string;
      if (id.length === 0 || ids.has(id)) return `${key} contains an empty or duplicate id`;
      ids.add(id);
    }
  }
  return null;
}

function rawPendingImports(raw: Record<string, unknown>): PendingImportReviewItem[] | null {
  return Array.isArray(raw.pendingImports) ? (raw.pendingImports as PendingImportReviewItem[]) : null;
}

function rawCards(raw: Record<string, unknown>): MumblerCard[] | null {
  return Array.isArray(raw.cards) ? (raw.cards as MumblerCard[]) : null;
}

// The audio files of the items that recorded no readable time at all.
function undatedItemFiles(raw: Record<string, unknown>): string[] {
  return [
    ...(rawPendingImports(raw) ?? [])
      .filter((item) => firstRecorded(pendingImportRecordedTimes(item)) === null)
      .map((item) => item.workingFilePath),
    ...(rawCards(raw) ?? [])
      .filter((card) => firstRecorded(cardRecordedTimes(card)) === null)
      .map((card) => card.sourceFilePath),
  ];
}

/** The time the loader read for an undated item from its audio file, or failing that the queue file. */
type UndatedItemTime = (audioFilePath: string) => number;

function normalizePendingImportRecord(
  item: PendingImportReviewItem,
  undatedTime: UndatedItemTime,
): PendingImportReviewItem {
  const fallback = firstRecorded(pendingImportRecordedTimes(item)) ?? undatedTime(item.workingFilePath);

  return {
    ...item,
    createdAtUtc: parseUtcMs(item.createdAtUtc) ?? fallback,
    updatedAtUtc: parseUtcMs(item.updatedAtUtc) ?? fallback,
  };
}

function normalizeTrimDecisionRecord(
  cardTrimDecision: MumblerCard["trimDecision"],
  fallback: number,
): MumblerCard["trimDecision"] {
  if (cardTrimDecision === null) {
    return null;
  }

  return {
    ...cardTrimDecision,
    analyzedAtUtc: parseUtcMs(cardTrimDecision.analyzedAtUtc) ?? fallback,
  };
}

function normalizeAiRunInfo(
  run: MumblerCard["ai"]["transcription"],
  fallback: number,
): MumblerCard["ai"]["transcription"] {
  if (run === null) {
    return null;
  }

  return {
    ...run,
    generatedAtUtc: parseUtcMs(run.generatedAtUtc) ?? fallback,
  };
}

function normalizeCardError(error: MumblerCard["lastError"], fallback: number): MumblerCard["lastError"] {
  if (error === null) {
    return null;
  }

  return {
    ...error,
    occurredAtUtc: parseUtcMs(error.occurredAtUtc) ?? fallback,
  };
}

function normalizeCardRecord(card: MumblerCard, undatedTime: UndatedItemTime): MumblerCard {
  const fallback = firstRecorded(cardRecordedTimes(card)) ?? undatedTime(card.sourceFilePath);
  // The confirmed and effective instants are one recording time apart by the
  // front trim, which applyFrontTrimOffset applies exactly, so either one
  // restores the other before the card's other times are used.
  const frontTrimOffsetSec = card.timestamps.frontTrimOffsetSec;
  const frontTrimOffsetMs = Number.isFinite(frontTrimOffsetSec) ? Math.round(frontTrimOffsetSec * 1000) : 0;
  const storedConfirmedUtc = parseUtcMs(card.timestamps.confirmedUtc);
  const storedEffectiveUtc = parseUtcMs(card.timestamps.effectiveUtc);
  const confirmedUtc =
    storedConfirmedUtc ?? (storedEffectiveUtc !== null ? storedEffectiveUtc - frontTrimOffsetMs : fallback);
  const queuedMode = card.queuedMode === "generate" ? card.queuedMode : null;
  // queuedAtUtc is paired with queuedMode and read like every other instant.
  const queuedAtUtc = queuedMode !== null ? (parseUtcMs(card.queuedAtUtc) ?? fallback) : null;

  return {
    ...card,
    // Filled from the card's transcript file once it is read.
    transcription: { text: null },
    timestamps: {
      ...card.timestamps,
      confirmedUtc,
      effectiveUtc: storedEffectiveUtc ?? confirmedUtc + frontTrimOffsetMs,
    },
    trimDecision: normalizeTrimDecisionRecord(card.trimDecision, fallback),
    // Filled from the card's transcript file once it is read.
    metadata: { ...card.metadata, structured: null },
    ai: {
      transcription: normalizeAiRunInfo(card.ai.transcription, fallback),
      structured: normalizeAiRunInfo(card.ai.structured, fallback),
      title: normalizeAiRunInfo(card.ai.title, fallback),
      slug: normalizeAiRunInfo(card.ai.slug, fallback),
    },
    queuedMode,
    queuedAtUtc,
    lastError: normalizeCardError(card.lastError, fallback),
    createdAtUtc: parseUtcMs(card.createdAtUtc) ?? fallback,
    updatedAtUtc: parseUtcMs(card.updatedAtUtc) ?? fallback,
  };
}

function normalizeQueue(raw: Record<string, unknown>, undatedTime: UndatedItemTime): MumblerQueue {
  const defaults = createEmptyQueue();
  return {
    pendingImports:
      rawPendingImports(raw)?.map((item) => normalizePendingImportRecord(item, undatedTime)) ??
      defaults.pendingImports,
    cards: rawCards(raw)?.map((card) => normalizeCardRecord(card, undatedTime)) ?? defaults.cards,
  };
}

// Render in-memory state to its on-disk shape: every UTC instant (stored as an
// epoch-ms number and named with the convention's `*Utc` suffix) becomes the
// canonical ISO-8601 string, while everything else passes through unchanged.
// The model keeps epoch-ms for arithmetic/sorting; this converts only at the
// persistence edge; the read path (parseUtcMs) turns the ISO back into epoch-ms.
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
export function serializeQueue(state: MumblerQueue): Record<string, unknown> {
  return serializeUtcInstants({
    ...state,
    cards: state.cards.map(({ transcription: _bodyInOwnFile, metadata, ...card }) => ({
      ...card,
      metadata: { title: metadata.title, slug: metadata.slug },
    })),
  }) as Record<string, unknown>;
}

export function recoverInterruptedCards(
  state: MumblerQueue,
): { state: MumblerQueue; recoveredInterruptedCards: number; restoredSavingCards: number } {
  let recoveredInterruptedCards = 0;
  let restoredSavingCards = 0;

  const cards = state.cards.map((card) => {
    // An interrupted save may have published some outputs. Retain the card as
    // ready so the user can inspect those files and retry.
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
    // The app-release check defaults on (github-release-check-conventions); an
    // explicitly saved off stays off.
    checkReleasesAtLaunch: true,
  };
}

// Settings keep the user map separate from effective built-ins. Saves run inside
// the JsonStore write queue; the app holds a single-instance lock.
export class SettingsStore {
  private readonly store: JsonStore<Record<string, unknown>>;
  // What the file held that this build cannot use, carried into every save.
  private unusable: UnusableSets = { unknown: {}, invalid: {} };
  // Whether config.json exists; first run writes nothing until a set differs.
  private exists = false;

  constructor(
    path: string,
    private readonly homeDirectory: string,
    private readonly warn: (key: keyof MumblerSettings) => void,
  ) {
    this.store = new JsonStore({
      path,
      formatVersion: FORMAT_VERSIONS.config,
      validate: (raw) => raw,
      createDefault: () => ({}),
      // Settings are what the user authors, the one store the backup history protects.
      record: true,
    });
  }

  get path(): string { return this.store.path; }

  /** Loads the settings; `unusable` names the known sets whose saved value is
   * kept but replaced by its built-in for this session. */
  async load(): Promise<LoadResult<MumblerSettings> & { unusable: (keyof MumblerSettings)[] }> {
    const loaded = await this.store.load();
    this.exists = loaded.origin === "loaded";
    this.unusable = unusableSets(loaded.value);
    const known = Object.fromEntries(SETTINGS_SET_KEYS.filter((key) => Object.hasOwn(loaded.value, key)).map((key) => [key, loaded.value[key]]));
    return {
      ...loaded,
      value: normalizeSettings(known, this.homeDirectory, this.warn),
      unusable: Object.keys(this.unusable.invalid) as (keyof MumblerSettings)[],
    };
  }

  // The one owner of what a save stores: every set that differs from its built-in,
  // written whole, plus what this build could not use, as it was written. An
  // unusable set stays until the user saves the Settings window, which showed its
  // built-in in its place (`replaceUnusable`); unknown keys always stay. Each save
  // writes from memory: the single-instance lock makes this process the file's only
  // writer, and a write of unchanged bytes is skipped.
  async save(settings: MumblerSettings, options: { replaceUnusable?: boolean } = {}): Promise<void> {
    const invalid = options.replaceUnusable ? {} : this.unusable.invalid;
    const sets: Record<string, unknown> = { ...storedSets(settings) };
    for (const [key, value] of Object.entries(invalid)) {
      if (equalsBuiltIn(key as keyof MumblerSettings, settings, createDefaultSettings())) sets[key] = value;
    }
    const next = { ...sets, ...this.unusable.unknown };
    if (!this.exists && Object.keys(next).length === 0) return;
    await this.store.save(next);
    this.exists = true;
    this.unusable = { unknown: this.unusable.unknown, invalid };
  }

  get failedWrite(): object | null { return this.store.failedWrite; }
  retryFailedWrite(): Promise<void> { return this.store.retryFailedWrite(); }
  flush(): Promise<void> { return this.store.flush(); }
  admitReset(): Promise<void> { return this.store.admitReset(); }
  preserveExistingFiles(): Promise<string[]> { return this.store.preserveExistingFiles(); }
}

export function createSettingsStore(
  path: string,
  homeDirectory: string = homedir(),
  warn: (key: keyof MumblerSettings) => void = (key) => console.warn(`Invalid settings set: ${key}`),
): SettingsStore {
  return new SettingsStore(path, homeDirectory, warn);
}

// The durable card queue. The file is read raw so the modified time of an
// undated item's audio file can be read before the pure normalization.
export class QueueStore {
  private readonly store: JsonStore<Record<string, unknown>>;

  constructor(path: string) {
    // Not recorded in the backup history: the queue and its review drafts are
    // transient work that ends in exports (data-backup-conventions; developer decision).
    this.store = new JsonStore({
      path,
      formatVersion: FORMAT_VERSIONS.queue,
      validate: (raw) => {
        const issue = queueShapeIssue(raw);
        if (issue !== null) throw new CorruptStateError(path, issue);
        return raw;
      },
      createDefault: () => ({}),
    });
  }

  get path(): string { return this.store.path; }

  async load(): Promise<LoadResult<MumblerQueue>> {
    const loaded = await this.store.load();
    const modifiedTime = async (file: string) => Math.floor((await stat(file)).mtimeMs);
    const fileTimes = new Map<string, number>();
    for (const audioFilePath of undatedItemFiles(loaded.value)) {
      // Failing the audio file too, the queue file that recorded the item.
      fileTimes.set(audioFilePath, await modifiedTime(audioFilePath).catch(() => modifiedTime(this.path)));
    }
    // undatedItemFiles named every path normalizeQueue asks for.
    return { ...loaded, value: normalizeQueue(loaded.value, (audioFilePath) => fileTimes.get(audioFilePath)!) };
  }

  save(queue: MumblerQueue): Promise<void> {
    return this.store.save(serializeQueue(queue));
  }

  flush(): Promise<void> { return this.store.flush(); }
  admitReset(): Promise<void> { return this.store.admitReset(); }
  preserveExistingFiles(): Promise<string[]> { return this.store.preserveExistingFiles(); }
}

export function createQueueStore(path: string): QueueStore {
  return new QueueStore(path);
}

export function createEmptyQueue(): MumblerQueue {
  return {
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
    checkReleasesAtLaunch: settings.checkReleasesAtLaunch,
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
    checkReleasesAtLaunch: draft.checkReleasesAtLaunch,
  };
  for (const key of SETTINGS_SET_KEYS) {
    const issue = SETTINGS_SETS[key](next[key]);
    if (issue !== null) throw new OperationError(issue);
  }
  return next;
}
