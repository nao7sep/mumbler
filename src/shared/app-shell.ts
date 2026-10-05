import type { InterfaceLanguage, LanguagePreference } from "./i18n/languages";
import type { MessageKey } from "./i18n/catalogues";
import type { Message } from "./i18n/translate";
import type { RecordDetail, RecordKind, RecordSources, RecordsPage, RecordsQuery } from "./records";

export const APP_SHELL_CHANNELS = {
  getInterfaceLanguage: "app-shell:get-interface-language",
  getSnapshot: "app-shell:get-snapshot",
  getSettingsDraft: "app-shell:get-settings-draft",
  getDefaultPrompts: "app-shell:get-default-prompts",
  openImportDialog: "app-shell:open-import-dialog",
  importDroppedPaths: "app-shell:import-dropped-paths",
  updatePendingImportDrafts: "app-shell:update-pending-import-drafts",
  confirmPendingImports: "app-shell:confirm-pending-imports",
  selectCard: "app-shell:select-card",
  duplicateCard: "app-shell:duplicate-card",
  updateCardTrim: "app-shell:update-card-trim",
  getCardMediaSource: "app-shell:get-card-media-source",
  generateCardStep: "app-shell:generate-card-step",
  cancelCardProcessing: "app-shell:cancel-card-processing",
  pickOutputDirectory: "app-shell:pick-output-directory",
  openOutputDirectory: "app-shell:open-output-directory",
  openExternal: "app-shell:open-external",
  saveSettingsDraft: "app-shell:save-settings-draft",
  setGeminiApiKey: "app-shell:set-gemini-api-key",
  clearGeminiApiKey: "app-shell:clear-gemini-api-key",
  chooseOutputDirectory: "app-shell:choose-output-directory",
  saveCard: "app-shell:save-card",
  removeCard: "app-shell:remove-card",
  reportRendererError: "app-shell:report-renderer-error",
  reportRendererDiagnostic: "app-shell:report-renderer-diagnostic",
  dismissAppWideError: "app-shell:dismiss-app-wide-error",
  resetState: "app-shell:reset-state",
  cancelPendingImports: "app-shell:cancel-pending-imports",
  provisionTool: "app-shell:provision-tool",
  cancelToolProvision: "app-shell:cancel-tool-provision",
  checkTools: "app-shell:check-tools",
  cancelToolCheck: "app-shell:cancel-tool-check",
  saveToolSettings: "app-shell:save-tool-settings",
  saveLayout: "app-shell:save-layout",
  openRecordsWindow: "app-shell:open-records-window",
  readRecordsPage: "app-shell:read-records-page",
  readRecordDetail: "app-shell:read-record-detail",
  readRecordSources: "app-shell:read-record-sources",
  getRecordsListWidth: "app-shell:get-records-list-width",
  saveRecordsListWidth: "app-shell:save-records-list-width",
} as const;

export const APP_SHELL_EVENTS = {
  appWideErrorUpdated: "app-shell:event-app-wide-error-updated",
  pipelineProgressUpdated: "app-shell:event-pipeline-progress-updated",
  dependenciesUpdated: "app-shell:event-dependencies-updated",
  interfaceLanguageChanged: "app-shell:event-interface-language-changed",
  recordsChanged: "app-shell:event-records-changed",
} as const;

export type CardStatus =
  | "Pending Review"
  | "Imported"
  | "Queued"
  | "Transcribing"
  | "Generating Metadata"
  | "Ready to Save"
  | "Saving"
  | "Cancelled"
  | "Error";

export type CommandId =
  | "select-previous"
  | "select-next"
  | "play-pause"
  | "skip-backward"
  | "skip-forward"
  | "play-first-snippet"
  | "play-last-snippet"
  | "set-front-marker"
  | "set-back-marker"
  | "transcribe-selected"
  | "save-selected";

export interface CommandDefinition {
  id: CommandId;
  labelKey: MessageKey;
  groupKey: MessageKey;
  /** The literal event.key values this command matches (letters lowercase).
   * Usually one; a second entry is an alternate binding kept alongside the
   * original (keyboard-shortcut-conventions: "known from elsewhere"). */
  keys: readonly string[];
}

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export interface OperationTimeouts {
  transcriptionMs: number;
  metadataMs: number;
}

export interface PromptTemplates {
  structured: string;
  title: string;
  slug: string;
}


/** The saved appearance choice. System follows the OS appearance. */
export type ThemePreference = "system" | "light" | "dark";

export const THEME_PREFERENCES: ReadonlyArray<{ value: ThemePreference; labelKey: MessageKey }> = [
  { value: "system", labelKey: "settings.themeSystem" },
  { value: "light", labelKey: "settings.themeLight" },
  { value: "dark", labelKey: "settings.themeDark" },
];

/** A missing or unrecognized theme follows the OS. */
export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export interface MumblerSettings {
  // The interface language: "system" follows the computer's language on every
  // launch, a tag keeps that language (localization-conventions).
  language: LanguagePreference;
  // Appearance — the theme, applied app-wide through Electron's nativeTheme.themeSource.
  theme: ThemePreference;
  // Appearance — the UI (chrome) font family. Family only; blank means the built-in default stack
  // (the renderer's `--font-ui` variable). The read-only transcription/structured/title/slug views
  // are display surfaces, so they follow this UI font rather than a separate content font.
  uiFontFamily: string;
  // Files
  outputDirectory: string | null;
  backupDirectory: string | null;
  // Import — the zone a filename's local time is read in at import: "system"
  // (SYSTEM_TIMEZONE) follows the computer's zone, or an IANA zone the user chose.
  defaultTimezone: string;
  timestampPattern: string;
  // Player
  skipIntervalSec: number;
  previewSnippetSeconds: number;
  // AI
  // NOTE: the Gemini API key is NOT a setting. It is a secret resolved
  // environment-first and stored in its own 0600 file (api-keys.json), never in
  // this shared settings store. See src/main/core/api-keys.ts.
  "gemini.endpoint": string;
  "gemini.transcription": string;
  "gemini.outline": string;
  "gemini.metadata": string;
  "gemini.thinking.transcription": string;
  "gemini.thinking.outline": string;
  "gemini.thinking.metadata": string;
  concurrencyLimit: number;
  prompts: PromptTemplates;
  retryPolicy: RetryPolicy;
  timeouts: OperationTimeouts;
  // Managed audio tools (ffmpeg/ffprobe), per the managed-runtime-dependencies
  // conventions. The one update switch: whether to run the (cached, staleness-
  // gated) latest-version check at launch. Nothing auto-downloads or auto-installs;
  // every install/update is user-triggered in the Audio Tools surface.
  checkUpdatesAtLaunch: boolean;
}

export type ImportSource = "file-picker" | "drag-and-drop";
export type CardProcessingStep = "transcription" | "structured" | "title" | "slug" | null;
export type GenerateTarget = Exclude<CardProcessingStep, null>;
export type TimestampParseStatus = "parsed" | "manual-required";

export interface CardError {
  /** Human-readable reason from the provider's documented field, never raw transport errors. */
  providerReason?: string;
  /** The provider refused the input; a retry cannot change that. */
  refused?: true;
  message: string;
  occurredAtUtc: number;
  failedStep: Exclude<CardProcessingStep, null> | "startup-recovery";
}

export interface CardTimestamps {
  confirmedLocal: string;
  confirmedUtc: number;
  timezone: string;
  frontTrimOffsetSec: number;
  effectiveLocal: string;
  effectiveUtc: number;
}

export interface CardTrim {
  frontMarkerSec: number | null;
  backMarkerSec: number | null;
}

export interface AudioProfile {
  formatName: string | null;
  codecName: string | null;
  bitRateKbps: number | null;
  sampleRateHz: number | null;
  channels: number | null;
}

export type TrimDecisionKind = "not-needed" | "stream-copy" | "reencode";

export interface TrimDecision {
  kind: TrimDecisionKind;
  toleranceSec: number;
  requestedStartSec: number | null;
  requestedEndSec: number | null;
  searchStartFromSec: number | null;
  searchStartToSec: number | null;
  searchEndFromSec: number | null;
  searchEndToSec: number | null;
  chosenStartBoundarySec: number | null;
  chosenEndBoundarySec: number | null;
  startDeltaSec: number | null;
  endDeltaSec: number | null;
  reason: string;
  analyzedAtUtc: number;
}

export interface AiRunInfo {
  provider: "gemini";
  model: string;
  generatedAtUtc: number;
}

export interface PendingImportReviewItem {
  id: string;
  originalFilename: string;
  importSource: ImportSource;
  originalSourcePath: string;
  workingFilePath: string;
  fileSizeBytes: number;
  localTimestampText: string;
  timezone: string;
  utcTimestampText: string;
  parseStatus: TimestampParseStatus;
  deleteOriginalOnConfirm: boolean;
  copyToBackupOnConfirm: boolean;
  createdAtUtc: number;
  updatedAtUtc: number;
}

export interface MumblerCard {
  id: string;
  originalFilename: string;
  importSource: ImportSource;
  sourceFilePath: string;
  audioProfile: AudioProfile | null;
  durationSec: number | null;
  fileSizeBytes: number;
  timestamps: CardTimestamps;
  trim: CardTrim;
  trimDecision: TrimDecision | null;
  // The trim the current transcription was made from, null while there is no
  // transcription. The results are stale when it differs from `trim`.
  transcribedTrim: CardTrim | null;
  transcription: {
    text: string | null;
  };
  metadata: {
    structured: string | null;
    title: string | null;
    slug: string | null;
  };
  ai: {
    transcription: AiRunInfo | null;
    structured: AiRunInfo | null;
    title: AiRunInfo | null;
    slug: AiRunInfo | null;
  };
  status: CardStatus;
  activeStep: CardProcessingStep;
  queuedMode: "generate" | null;
  queuedAtUtc: number | null;
  lastError: CardError | null;
  createdAtUtc: number;
  updatedAtUtc: number;
}

/** The user's durable card queue and pending imports; presentation is in MumblerLayout. */
export interface MumblerQueue {
  pendingImports: PendingImportReviewItem[];
  cards: MumblerCard[];
}

export interface AppPaths {
  homeDir: string;
  settingsPath: string;
  queuePath: string;
  // The earlier queue filename, renamed only when queuePath is absent.
  legacyQueuePath: string;
  // One file per card holding its transcription and structured outline, kept out
  // of queuePath so the queue's frequent saves stay small.
  transcriptsDir: string;
  // Disposable presentation state (pane width and last selection). Its own file,
  // apart from settingsPath/queuePath, so it self-heals independently.
  layoutPath: string;
  // The secrets file. The Gemini API key lives here in its own 0600 file, not in
  // settingsPath (storage-path-conventions, "Secrets and keys").
  apiKeysPath: string;
  recordsPath: string;
  // Only for records the database could not take.
  logsDir: string;
  workingDir: string;
  outputDir: string;
  originalsDir: string;
  // Managed audio tools: the installed executables live in binDir; their persisted
  // facts in dependenciesPath. Per the storage-path-conventions, under the app root.
  binDir: string;
  dependenciesPath: string;
  // Disposable download staging for managed dependencies — a root-level sibling of
  // bin/, holding nothing precious (cleared each launch). NOT under working/, which
  // holds semi-persisted session data; temp/ declares it is safe to delete.
  tempDir: string;
}

export interface SettingsSummary {
  // Appearance
  uiFontFamily: string;
  // Files
  outputDirectory: string | null;
  defaultOutputDirectory: string;
  backupDirectory: string | null;
  defaultBackupDirectory: string;
  // Import — the resolved IANA zone (System already resolved to the computer's).
  defaultTimezone: string;
  // Player
  skipIntervalSec: number;
  previewSnippetSeconds: number;
  // AI
  hasGeminiApiKey: boolean;
  transcriptionModel: string;
  outlineModel: string;
  metadataModel: string;
  concurrencyLimit: number;
  // The one managed-audio-tool toggle, surfaced so the Audio Tools modal can show
  // and edit it without the full settings-draft roundtrip.
  checkUpdatesAtLaunch: boolean;
}

export interface SettingsDraft {
  language: LanguagePreference;
  // Appearance
  theme: ThemePreference;
  uiFontFamily: string;
  // Files
  outputDirectory: string;
  defaultOutputDirectory: string;
  backupDirectory: string;
  defaultBackupDirectory: string;
  // Import — "system" or an IANA zone, as saved.
  defaultTimezone: string;
  timestampPattern: string;
  // Player
  skipIntervalSec: number;
  previewSnippetSeconds: number;
  // AI
  // Presence flag only — whether a Gemini key is currently available (env or
  // stored). The key value itself is never part of this draft; it is set/cleared
  // through the dedicated setGeminiApiKey/clearGeminiApiKey IPC, not the settings
  // JSON roundtrip.
  hasGeminiApiKey: boolean;
  geminiEndpoint: string;
  transcriptionModel: string;
  outlineModel: string;
  metadataModel: string;
  transcriptionThinking: string;
  outlineThinking: string;
  metadataThinking: string;
  concurrencyLimit: number;
  structuredPrompt: string;
  titlePrompt: string;
  slugPrompt: string;
  retryMaxRetries: number;
  retryInitialDelayMs: number;
  retryMaxDelayMs: number;
  retryJitterRatio: number;
  transcriptionTimeoutMs: number;
  metadataTimeoutMs: number;
}

export interface QueueSummary {
  cardCount: number;
  pendingImportCount: number;
  selectedCardId: string | null;
  recoveredInterruptedCards: number;
}

// Rendered in the interface language by the renderer, never finished text.
export interface StartupDiagnostic {
  title: Message;
  message: Message;
}

// Why the stores did not load. Reset sets them aside and starts empty, so it is
// offered only where nothing must stay exactly in place.
export interface StartupFailure extends StartupDiagnostic {
  canReset: boolean;
}

export interface RendererErrorReport {
  message: string;
  source: string;
  stack?: string;
  name?: string;
  cause?: RendererErrorCause;
}

export interface RendererErrorCause {
  name?: string;
  message: string;
  stack?: string;
  cause?: RendererErrorCause;
}

// The Node platform string (the member set of NodeJS.Platform), spelled out as a
// portable union so shared code carries no dependency on @types/node — it is
// imported by the renderer, which is typechecked without Node types.
export type Platform =
  | "aix"
  | "android"
  | "darwin"
  | "freebsd"
  | "haiku"
  | "linux"
  | "openbsd"
  | "sunos"
  | "win32"
  | "cygwin"
  | "netbsd";

// ── Managed dependencies (the audio tools: ffmpeg / ffprobe) ──────────────────
// State, surfacing, and operations for the tools mumbler provisions at runtime,
// per the managed-runtime-dependencies-conventions. Both tools are required to
// function. mumbler owns its bin directory and never adopts a hand-placed binary,
// so there is no user-supplied path to model.

export type ToolName = "ffmpeg" | "ffprobe";

// The four states a managed dependency can be in, derived from scanned presence
// plus the two version facts (managed-runtime-dependencies-conventions, "Show").
// There is no faulted state: a damaged file fails loudly when used and is fixed by
// installing again, never tracked as a persisted fault. "Up to date" requires a
// check that actually succeeded — with checks off, or before any check, a present
// tool reads "installed-unchecked", never "up-to-date".
export type DependencyState =
  | "not-installed"
  | "update-available"
  | "up-to-date"
  | "installed-unchecked";

// Semantic status role — the meaning, not the colour. The theme maps each role to
// a concrete colour/icon.
export type StatusRole = "none" | "informational" | "warning" | "error";

// The kind of operation in flight, used to label the transient status. Install and
// Update are the same one operation underneath (acquire the latest, verify once),
// so a single "provision" kind covers both.
export type ToolOperationKind = "provision" | "check";

// The honest per-tool facts status derives from. Both version strings are already
// normalized, so they compare by string equality. Only desiredVersion and
// lastCheckedAtUtc are PERSISTED — network facts with no on-disk source. `present`
// and `installedVersion` are both read from the artifact (a filesystem scan and the
// binary itself), so they cannot drift from disk or from each other.
export interface ToolFacts {
  present: boolean;
  // What the installed binary reports, or what the install recorded beside it.
  // Null on a present tool means its version could not be read — not the same as
  // absent, and never dressed up as up to date.
  installedVersion: string | null;
  // The last latest-version a check successfully resolved; null until one has.
  desiredVersion: string | null;
  // UTC ms of the last *successful* check; null until one has. A failed check
  // writes nothing, so a non-null value always means a check truly succeeded.
  lastCheckedAtUtc: number | null;
}

// Transient, non-persisted status of an in-flight or just-failed operation. It
// overlays the persisted state at render and never becomes a state — a failed
// Provision leaves the tool Not installed, shown as an error only via this overlay.
export type ToolTransient =
  | { kind: "idle" }
  | { kind: "running"; operation: ToolOperationKind; percent: number | null }
  | { kind: "failed"; operation: ToolOperationKind; error: Message };

// The derived row the surface renders — the output of deriveStatus(). Rendering
// reads this and nothing else (no filesystem probe, no --version call).
export interface DependencyStatus {
  name: ToolName;
  required: boolean;
  state: DependencyState;
  role: StatusRole;
  installedVersion: string | null;
  desiredVersion: string | null;
  lastCheckedAtUtc: number | null;
  transient: ToolTransient;
}

// Disposable presentation state, separate from config.json and queue.json (which
// holds precious card data). queueWidth and recordsListWidth are the user's
// dragged intents in CSS pixels, for the main window's queue pane and the records
// window's list pane; selectedCardId remembers where the user left the queue view.
export interface MumblerLayout {
  queueWidth: number;
  recordsListWidth: number;
  selectedCardId: string | null;
}

export interface AppSnapshot {
  // The language the main process and the renderer both speak, resolved from
  // the saved choice and the computer's language.
  interfaceLanguage: InterfaceLanguage;
  appName: string;
  appVersion: string;
  platform: Platform;
  isPackaged: boolean;
  shellReadyAtUtc: number;
  paths: AppPaths | null;
  settingsSummary: SettingsSummary | null;
  queueSummary: QueueSummary | null;
  commands: CommandDefinition[];
  startupDiagnostic: StartupFailure | null;
  appWideError: StartupDiagnostic | null;
  state: MumblerQueue | null;
  // Disposable presentation state. Null until the runtime is ready, like the
  // other snapshot slices.
  layout: MumblerLayout | null;
  // Derived status of each managed audio tool, computed in main via deriveStatus
  // from persisted facts + transient operation status. The renderer reads these
  // directly (never probes). Null until the runtime is ready.
  dependencies: DependencyStatus[] | null;
}

export interface FailedImport {
  // Empty when the delivered item had no usable path or name.
  sourcePath: string;
  message: Message;
  kind: "invalid" | "failure";
}

export interface ImportOperationResult {
  snapshot: AppSnapshot;
  attemptedPaths: string[];
  importedCount: number;
  failedImports: FailedImport[];
  duplicateImports: string[];
}

export type SaveConflictResolution = "overwrite" | "suffix" | "cancel";

export type SaveCardResult =
  | {
      kind: "saved";
      snapshot: AppSnapshot;
      audioPath: string;
      jsonPath: string;
      markdownPath: string;
    }
  | {
      kind: "conflict";
      snapshot: AppSnapshot;
      audioPath: string;
      jsonPath: string;
      markdownPath: string;
    }
  | {
      kind: "cancelled";
      snapshot: AppSnapshot;
    };

export interface MumblerShellApi {
  getInterfaceLanguage(): Promise<InterfaceLanguage>;
  getSnapshot(): Promise<AppSnapshot>;
  getSettingsDraft(): Promise<SettingsDraft>;
  getDefaultPrompts(): Promise<PromptTemplates>;
  openImportDialog(): Promise<ImportOperationResult>;
  importDroppedPaths(paths: string[]): Promise<ImportOperationResult>;
  updatePendingImportDrafts(items: PendingImportReviewItem[]): Promise<AppSnapshot>;
  confirmPendingImports(items: PendingImportReviewItem[]): Promise<AppSnapshot>;
  selectCard(cardId: string | null): Promise<AppSnapshot>;
  duplicateCard(cardId: string): Promise<AppSnapshot>;
  updateCardTrim(cardId: string, trim: CardTrim): Promise<AppSnapshot>;
  getCardMediaSource(cardId: string): Promise<string>;
  generateCardStep(cardId: string, target: GenerateTarget): Promise<AppSnapshot>;
  cancelCardProcessing(cardId: string): Promise<AppSnapshot>;
  pickOutputDirectory(): Promise<string | null>;
  openOutputDirectory(): Promise<void>;
  openExternal(url: string): Promise<void>;
  saveSettingsDraft(draft: SettingsDraft): Promise<AppSnapshot>;
  // Set/clear the Gemini API key. These go to the dedicated secrets file
  // (api-keys.json), separate from the settings JSON, and return a fresh snapshot
  // so the renderer's hasGeminiApiKey presence flag updates immediately.
  setGeminiApiKey(apiKey: string): Promise<AppSnapshot>;
  clearGeminiApiKey(): Promise<AppSnapshot>;
  chooseOutputDirectory(): Promise<AppSnapshot>;
  saveCard(cardId: string, resolution?: SaveConflictResolution): Promise<SaveCardResult>;
  removeCard(cardId: string): Promise<AppSnapshot>;
  reportRendererError(report: RendererErrorReport): Promise<AppSnapshot>;
  reportRendererDiagnostic(report: RendererErrorReport): Promise<void>;
  dismissAppWideError(): Promise<AppSnapshot>;
  resetState(): Promise<AppSnapshot>;
  cancelPendingImports(ids: string[]): Promise<AppSnapshot>;
  // Managed audio-tool operations. Each returns a fresh snapshot so the surface
  // reflects the new state; live progress arrives via onDependenciesUpdated.
  // provisionTool is the single acquire operation (Install when absent, Update
  // when a newer version is known — same flow underneath).
  provisionTool(name: ToolName): Promise<AppSnapshot>;
  cancelToolProvision(name: ToolName): Promise<AppSnapshot>;
  checkTools(): Promise<AppSnapshot>;
  cancelToolCheck(): Promise<AppSnapshot>;
  saveToolSettings(checkUpdatesAtLaunch: boolean): Promise<AppSnapshot>;
  // Persist the queue (left) pane's dragged width intent to layout.json and return
  // a fresh snapshot. Called only on a splitter drag-commit; a window resize
  // re-derives the displayed width in the renderer and persists nothing.
  saveLayout(queueWidth: number): Promise<AppSnapshot>;
  // The records window: opened from the main window, it reads records.sqlite3.
  openRecordsWindow(): Promise<void>;
  readRecordsPage(query: RecordsQuery): Promise<RecordsPage>;
  readRecordDetail(kind: RecordKind, id: number): Promise<RecordDetail | null>;
  readRecordSources(): Promise<RecordSources>;
  // The records window's list pane width: the dragged intent, read at open and
  // saved when a drag ends; the saved width comes back clamped.
  getRecordsListWidth(): Promise<number>;
  saveRecordsListWidth(width: number): Promise<number>;
  getPathForFile(file: File): string;
  onAppWideErrorChanged(listener: () => void): () => void;
  onPipelineProgressUpdated(listener: () => void): () => void;
  onDependenciesUpdated(listener: () => void): () => void;
  onInterfaceLanguageChanged(listener: () => void): () => void;
  // A record was stored in the records database.
  onRecordsChanged(listener: () => void): () => void;
}
