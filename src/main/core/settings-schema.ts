import type {
  MumblerSettings,
  SettingsDraft,
  SettingsSummary,
} from "@shared/app-shell";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import {
  DEFAULT_TIMESTAMP_PATTERNS,
  SYSTEM_TIMEZONE,
  getSystemTimezone,
  isValidTimezone,
  resolveTimezone,
} from "@shared/timestamps";
import { isLanguage, normalizeLanguagePreference } from "@shared/i18n/languages";
import { CONCURRENCY_LIMIT_MAX, isConcurrencyLimitSetting, isPositiveIntegerSetting } from "@shared/settings-validation";
import { THEME_PREFERENCES } from "@shared/app-shell";
import { AI_ROLES, defaultModelFor, GEMINI_ENDPOINT, rowFor, thinkingFor, type AiRole } from "@shared/ai-models";
import { FORMAT_VERSIONS } from "./format-versions";
import { providerEndpointIssue } from "@shared/provider-endpoint";
import { JsonStore, type LoadResult } from "./json-store";
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

function timestampPatternsIssue(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every((pattern) => isText(pattern) && pattern.length > 0)) {
    return "At least one timestamp pattern is required.";
  }
  for (const [index, pattern] of value.entries()) {
    try {
      new RegExp(pattern as string);
    } catch {
      return `Timestamp pattern ${index + 1} must be a valid regular expression.`;
    }
  }
  return null;
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

// The declared set keys also own the shape boundary and unknown-key filtering.
const SETTINGS_SETS = {
  language: (value) => (value === "system" || isLanguage(value) ? null : "Language must be System or a supported language."),
  theme: (value) => (THEME_PREFERENCES.some(({ value: theme }) => theme === value) ? null : "Theme must be System, Light, or Dark."),
  uiFontFamily: text("UI font"),
  outputDirectory: path("Output directory"),
  backupDirectory: path("Recordings directory"),
  defaultTimezone: (value) => (value === null || zoneChoice(value) ? null : "Default timezone must be System or a valid IANA timezone."),
  displayTimezone: (value) => (zoneChoice(value) ? null : "Display timezone must be System or a valid IANA timezone."),
  timestampPatterns: timestampPatternsIssue,
  skipIntervalSec: positive("Skip interval"),
  previewSnippetSeconds: positive("Preview snippet seconds"),
  "gemini.endpoint": endpointIssue,
  "gemini.transcription": model("Transcription"),
  "gemini.outline": model("Outline"),
  "gemini.metadata": model("Metadata"),
  "gemini.thinking.transcription": text("Transcription thinking"),
  "gemini.thinking.outline": text("Outline thinking"),
  "gemini.thinking.metadata": text("Metadata thinking"),
  concurrencyLimit: (value) => (typeof value === "number" && isConcurrencyLimitSetting(value) ? null : `Concurrency limit must be a whole number from 1 to ${CONCURRENCY_LIMIT_MAX}.`),
  prompts: promptsIssue,
  checkUpdatesAtLaunch: (value) => (typeof value === "boolean" ? null : "Check for updates at launch must be on or off."),
} satisfies Record<keyof MumblerSettings, SetValidator>;
const SETTINGS_SET_KEYS = Object.keys(SETTINGS_SETS) as (keyof MumblerSettings)[];

// What a settings file holds that this build cannot use (config-sets-conventions):
// keys it does not know, as a newer Mumbler may write, and known sets whose value
// fails their check. Unknown keys always stay; invalid known values are kept
// until replaced by a valid value or a full Settings save.
interface UnusableSets {
  unknown: Record<string, unknown>;
  invalid: Partial<Record<keyof MumblerSettings, unknown>>;
}

function unusableSets(raw: Record<string, unknown>): UnusableSets {
  // Set names are data, including __proto__, constructor and toString.
  const unknown: Record<string, unknown> = Object.create(null);
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
/** The zone an import reads recording times in, resolved; the computer's before the first-launch save. */
export function importTimezone(settings: Pick<MumblerSettings, "defaultTimezone">): string {
  return resolveTimezone(settings.defaultTimezone ?? SYSTEM_TIMEZONE);
}

function zoneChoice(value: unknown): boolean {
  return isText(value) && (value === SYSTEM_TIMEZONE || isValidTimezone(value));
}

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
    const path = settings[key] ?? "";
    // App saves contain resolved absolute references, not expressions. Keep
    // their literal dollar/percent names and spaces across reopen. Older
    // hand-authored relative/tilde/env expressions retain their input semantics.
    settings[key] = path.trim().length === 0 ? null
      : isAbsolute(path) ? path : resolvePathFromHome(path, homeDirectory);
  }
  return settings;
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
    // Saved as the computer's concrete zone at first launch, which then stays
    // when the computer's zone changes (timestamp-conventions, Time zones).
    defaultTimezone: null,
    displayTimezone: SYSTEM_TIMEZONE,
    timestampPatterns: [...DEFAULT_TIMESTAMP_PATTERNS],
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
        "Reorganize the transcript into a well-structured Markdown outline. Preserve all information; resolve obvious self-contradictions using surrounding context. Write the headings and connecting text in the transcript's dominant language: the one whose grammar structures the recording, not whichever language takes up the most of it. A short set phrase borrowed into otherwise single-language speech doesn't make it bilingual. Keep passages spoken in another language in that language; never translate them. Output Markdown only.\n\n<transcript>\n{transcript}\n</transcript>",
      title:
        "Write a single concise title that summarizes the content, in the source's dominant language: the one whose grammar structures the text, not whichever language takes up the most of it. A short set phrase borrowed into otherwise single-language text doesn't make it bilingual. The title is plain text with no prefix, no quotation marks around it, no markdown, and no trailing period unless it is a complete sentence.\n\n<source>\n{structured}\n</source>",
      slug:
        "Create a short English URL slug for the title. Translate the meaning into English; don't romanize words from another language. Names keep their usual English spelling. Lowercase a–z, digits, and hyphens only. No leading or trailing hyphen. Aim for 3–6 words.\n\n<title>\n{title}\n</title>",
    },
    // Managed audio tools default to a non-blocking update check on launch.
    // Nothing auto-downloads: a missing required tool opens the Audio Tools
    // surface for the user to install it.
    checkUpdatesAtLaunch: true,
  };
}

// Settings keep the user map separate from effective built-ins. Their owner
// orders that metadata with each primary write; the app holds a single-instance lock.
export class SettingsStore {
  private readonly store: JsonStore<Record<string, unknown>>;
  private writeTail: Promise<void> = Promise.resolve();
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
  save(settings: MumblerSettings, options: { replaceUnusable?: boolean } = {}): Promise<void> {
    const submitted = structuredClone(settings);
    const replaceUnusable = options.replaceUnusable;
    return this.enqueueWrite(async () => {
      const invalid = replaceUnusable ? {} : this.unusable.invalid;
      const sets: Record<string, unknown> = { ...storedSets(submitted) };
      const defaults = createDefaultSettings();
      for (const [key, value] of Object.entries(invalid)) {
        if (equalsBuiltIn(key as keyof MumblerSettings, submitted, defaults)) sets[key] = value;
      }
      const next = { ...sets, ...this.unusable.unknown };
      if (!this.exists && Object.keys(next).length === 0 && this.store.failedWrite === null) return;
      await this.store.save(next);
      this.exists = true;
      this.unusable = unusableSets(next);
    });
  }

  private enqueueWrite(work: () => Promise<void>): Promise<void> {
    const operation = this.writeTail.then(work, work);
    this.writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  get failedWrite(): object | null { return this.store.failedWrite; }
  retryFailedWrite(): Promise<void> {
    return this.enqueueWrite(async () => {
      const failed = this.store.failedWrite;
      await this.store.retryFailedWrite();
      if (failed !== null) {
        this.exists = true;
        this.unusable = unusableSets(failed.value);
      }
    });
  }
  async flush(): Promise<void> {
    await this.writeTail;
    await this.store.flush();
  }
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
    defaultTimezone: settings.defaultTimezone ?? getSystemTimezone(),
    importTimezone: importTimezone(settings),
    displayTimezone: settings.displayTimezone,
    resolvedDisplayTimezone: resolveTimezone(settings.displayTimezone),
    // Player
    skipIntervalSec: settings.skipIntervalSec,
    previewSnippetSeconds: settings.previewSnippetSeconds,
    // AI
    hasGeminiApiKey,
    providerEndpointAllowed: providerEndpointIssue(settings["gemini.endpoint"]) === null,
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
    literalOutputDirectory: settings.outputDirectory ?? "",
    defaultOutputDirectory,
    backupDirectory: settings.backupDirectory ?? "",
    literalBackupDirectory: settings.backupDirectory ?? "",
    defaultBackupDirectory,
    // Import
    defaultTimezone: settings.defaultTimezone ?? getSystemTimezone(),
    displayTimezone: settings.displayTimezone,
    timestampPatterns: [...settings.timestampPatterns],
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
  };
}

export function resolveSettingsDirectory(
  value: string,
  literal: string | undefined,
  homeDirectory: string = homedir(),
): string | null {
  if (value.trim().length === 0) return null;
  // A picker and an unchanged stored reference have already been resolved.
  // Only newly authored text accepts expressions; trimming a literal filename
  // would also change which directory the user selected.
  if (value === literal && isAbsolute(value)) return value;
  return resolvePathFromHome(value, homeDirectory);
}

export function applySettingsDraft(
  current: MumblerSettings,
  draft: SettingsDraft,
  homeDirectory: string = homedir(),
): MumblerSettings {
  const next: MumblerSettings = {
    ...current,
    language: normalizeLanguagePreference(draft.language),
    // Appearance
    theme: draft.theme,
    // Free text; blank means the built-in default stack.
    uiFontFamily: singleLine(draft.uiFontFamily),
    // Files
    outputDirectory: resolveSettingsDirectory(draft.outputDirectory, draft.literalOutputDirectory, homeDirectory),
    backupDirectory: resolveSettingsDirectory(draft.backupDirectory, draft.literalBackupDirectory, homeDirectory),
    // Import
    defaultTimezone: singleLine(draft.defaultTimezone),
    displayTimezone: singleLine(draft.displayTimezone),
    // One pattern per row; a blank row is not a pattern.
    timestampPatterns: (Array.isArray(draft.timestampPatterns) ? draft.timestampPatterns : [])
      .map((row) => singleLine(String(row)))
      .filter((row) => row.length > 0),
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
  };
  const endpointProblem = providerEndpointIssue(next["gemini.endpoint"]);
  if (endpointProblem !== null) throw new OperationError(endpointProblem);
  for (const key of SETTINGS_SET_KEYS) {
    const issue = SETTINGS_SETS[key](next[key]);
    if (issue !== null) throw new OperationError(issue);
  }
  return next;
}
