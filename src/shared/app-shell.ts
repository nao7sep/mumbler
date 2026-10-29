import type { InterfaceLanguage, Language, LanguagePreference } from "./i18n/languages";
import type { MessageKey } from "./i18n/catalogues";
import type { Message } from "./i18n/translate";
import type { RecordDetail, RecordKind, RecordSources, RecordsPage, RecordsQuery } from "./records";

export const APP_SHELL_CHANNELS = {
  getInterfaceLanguage: "app-shell:get-interface-language",
  subscribeSnapshot: "app-shell:subscribe-snapshot",
  dismissFirstRunSetup: "app-shell:dismiss-first-run-setup",
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
  getCardWaveformPeaks: "app-shell:get-card-waveform-peaks",
  cancelCardWaveformPeaks: "app-shell:cancel-card-waveform-peaks",
  generateCardStep: "app-shell:generate-card-step",
  cancelCardProcessing: "app-shell:cancel-card-processing",
  pickOutputDirectory: "app-shell:pick-output-directory",
  pickBackupDirectory: "app-shell:pick-backup-directory",
  openOutputDirectory: "app-shell:open-output-directory",
  openExternal: "app-shell:open-external",
  saveSettingsDraft: "app-shell:save-settings-draft",
  setGeminiApiKey: "app-shell:set-gemini-api-key",
  clearGeminiApiKey: "app-shell:clear-gemini-api-key",
  chooseOutputDirectory: "app-shell:choose-output-directory",
  saveSetupDirectory: "app-shell:save-setup-directory",
  saveSetupRecordingsDirectory: "app-shell:save-setup-recordings-directory",
  saveSetupTimezone: "app-shell:save-setup-timezone",
  chooseOriginalsDirectory: "app-shell:choose-originals-directory",
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
  recordsMissing: "app-shell:records-missing",
  readRecordSources: "app-shell:read-record-sources",
  getRecordsListWidth: "app-shell:get-records-list-width",
  saveRecordsListWidth: "app-shell:save-records-list-width",
} as const;

export const APP_SHELL_EVENTS = {
  // The app's state, sent to each subscribed window when it subscribes and
  // after every change: the window's one source of the snapshot.
  snapshotChanged: "app-shell:event-snapshot-changed",
  interfaceLanguageChanged: "app-shell:event-interface-language-changed",
  recordsChanged: "app-shell:event-records-changed",
  // A quit asks the main window to send the edits it has not sent yet; the
  // window replies with the request identity and whether every edit save succeeded.
  flushPendingEdits: "app-shell:event-flush-pending-edits",
  pendingEditsFlushed: "app-shell:event-pending-edits-flushed",
  // A user's quit or window close asks which session-only drafts the window
  // holds, and may then tell it to discard them.
  queryUnsavedDrafts: "app-shell:event-query-unsaved-drafts",
  unsavedDraftsReported: "app-shell:event-unsaved-drafts-reported",
  discardUnsavedDrafts: "app-shell:event-discard-unsaved-drafts",
} as const;

/** A draft that lives only in the window until the user saves it. */
export type UnsavedDraft = "settings";

export const CARD_STATUSES = [
  "Pending Review", "Imported", "Queued", "Transcribing", "Generating Metadata",
  "Ready to Save", "Saving", "Cancelled", "Error",
] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

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
  | "save-selected"
  | "duplicate-selected"
  | "remove-selected";

export interface CommandDefinition {
  id: CommandId;
  labelKey: MessageKey;
  groupKey: MessageKey;
  /** The literal event.key values this command matches (letters lowercase).
   * Usually one; a second entry is an alternate binding kept alongside the
   * original (keyboard-shortcut-conventions: "known from elsewhere"). */
  keys: readonly string[];
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
  // The interpretation zone (timestamp-conventions, Time zones): the zone a
  // recording time carrying none is read in at import. The computer's zone is
  // saved as a concrete zone at first launch (null only before that save) and
  // stays when the computer's changes; System, if chosen, follows it.
  defaultTimezone: string | null;
  // The display zone: the zone the app's own event times are shown in, System
  // (following the computer) by default.
  displayTimezone: string;
  // The file-name timestamp patterns, tried in order: one set, edited as a list.
  timestampPatterns: string[];
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

// A time the review offers for a recording: from its file name, from inside the
// file, or from the file's own created or modified time. An exact one carries
// its UTC instant; a local one (no zone) is read in the item's zone.
export interface RecordingTimeCandidate {
  source: "file-name" | "embedded" | "file-created" | "file-modified";
  utcMs: number | null;
  localText: string | null;
}

export interface SourceFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface PendingImportReviewItem {
  id: string;
  originalFilename: string;
  importSource: ImportSource;
  originalSourcePath: string;
  /** Captured before copying; older pending reviews have no deletion evidence. */
  sourceIdentity?: SourceFileIdentity;
  workingFilePath: string;
  fileSizeBytes: number;
  localTimestampText: string;
  timezone: string;
  utcTimestampText: string;
  /** An exact candidate or UTC edit keeps its instant when the display zone changes. */
  timestampBasis?: "local" | "utc";
  parseStatus: TimestampParseStatus;
  // Found when the recording was staged; facts of the file, never edited.
  timeCandidates: RecordingTimeCandidate[];
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
  profileDir: string;
  homeDir: string;
  settingsPath: string;
  queuePath: string;
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
  providerEndpointAllowed?: boolean;
  // Appearance
  uiFontFamily: string;
  // Files
  outputDirectory: string | null;
  defaultOutputDirectory: string;
  backupDirectory: string | null;
  defaultBackupDirectory: string;
  // Import — the saved interpretation zone (System or an IANA zone), and the
  // zone it resolves to now.
  defaultTimezone: string;
  importTimezone: string;
  // The saved display zone (System or an IANA zone), and the zone it resolves to now.
  displayTimezone: string;
  resolvedDisplayTimezone: string;
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
  // Session-only provenance: unchanged stored/picked paths are literal. Editing
  // their text makes them authored expressions again; these never enter config.
  literalOutputDirectory?: string;
  defaultOutputDirectory: string;
  backupDirectory: string;
  literalBackupDirectory?: string;
  defaultBackupDirectory: string;
  // Import — the saved interpretation zone, System or an IANA zone.
  defaultTimezone: string;
  // The display zone, System or an IANA zone.
  displayTimezone: string;
  // The timestamp patterns as the rows of the list editor, blank rows included.
  timestampPatterns: string[];
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
// check that actually succeeded. Disabling checks retains known versions; a
// present tool without sufficient version knowledge reads "installed-unchecked".
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
// Provision can retain an existing installed tool, with the error shown only via
// this overlay.
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
  // First-run setup is still owed: set at a first launch, cleared when setup is
  // finished or dismissed, so quitting partway shows it again next launch.
  setupPending: boolean;
}

export interface AppSnapshot {
  firstRun: boolean;
  // The language the main process and the renderer both speak, resolved from
  // the saved choice and the computer's language.
  interfaceLanguage: InterfaceLanguage;
  // What each System choice resolves to now, which its entry shows
  // (app-chrome-conventions, Theme; timestamp-conventions, Time zones).
  systemLanguage: Language;
  systemTheme: "light" | "dark";
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

// Replies carry what the operation itself produced; the window learns the
// app's new state from its snapshot subscription.
export interface ImportOperationResult {
  attemptedPaths: string[];
  importedCount: number;
  failedImports: FailedImport[];
  duplicateImports: string[];
}

// A confirmed import whose requested backup or deletion of the original did not
// happen. The import itself reached the queue; this is a warning on that success.
export interface ImportOriginalWarning {
  sourcePath: string;
  message: Message;
}

export interface ConfirmImportsResult {
  originalWarnings: ImportOriginalWarning[];
}

export type SaveConflictResolution = "overwrite" | "suffix" | "cancel";

// Whether the recording leaves the queue once its files are out.
export interface SaveCardOptions {
  removeAfterSave: boolean;
}

export interface SaveOutputFile {
  path: string;
  status: "saved" | "unchanged" | "failed" | "pending";
}

export type SaveCardResult =
  | {
      kind: "saved";
      audioPath: string;
      jsonPath: string;
      markdownPath: string;
      warnings?: Message[];
    }
  | {
      kind: "failed";
      message: Message;
      files?: SaveOutputFile[];
    }
  | {
      kind: "conflict";
      audioPath: string;
      jsonPath: string;
      markdownPath: string;
    }
  | {
      kind: "cancelled";
    };

export interface MumblerShellApi {
  getInterfaceLanguage(): Promise<InterfaceLanguage>;
  /** Delivers the current snapshot to `listener`, then every later one; resolves
   * with the unsubscribe once the first has been delivered. */
  subscribeSnapshot(listener: (snapshot: AppSnapshot) => void): Promise<() => void>;
  dismissFirstRunSetup(): Promise<void>;
  getSettingsDraft(): Promise<SettingsDraft>;
  getDefaultPrompts(): Promise<PromptTemplates>;
  openImportDialog(): Promise<ImportOperationResult>;
  importDroppedPaths(paths: string[]): Promise<ImportOperationResult>;
  updatePendingImportDrafts(items: PendingImportReviewItem[]): Promise<void>;
  confirmPendingImports(items: PendingImportReviewItem[]): Promise<ConfirmImportsResult>;
  selectCard(cardId: string | null): Promise<void>;
  duplicateCard(cardId: string): Promise<void>;
  updateCardTrim(cardId: string, trim: CardTrim): Promise<void>;
  getCardMediaSource(cardId: string): Promise<string>;
  // The loudest level in each hundredth of a second, for the player's waveform.
  // Null when the run was stopped before it finished.
  getCardWaveformPeaks(cardId: string, requestId: string): Promise<Float32Array | null>;
  cancelCardWaveformPeaks(requestId: string): Promise<void>;
  generateCardStep(cardId: string, target: GenerateTarget): Promise<void>;
  cancelCardProcessing(cardId: string): Promise<void>;
  pickOutputDirectory(directory?: string, literalDirectory?: string): Promise<string | null>;
  pickBackupDirectory(directory?: string, literalDirectory?: string): Promise<string | null>;
  openOutputDirectory(): Promise<void>;
  openExternal(url: string): Promise<void>;
  saveSettingsDraft(draft: SettingsDraft): Promise<void>;
  // Set/clear the Gemini API key. These go to the dedicated secrets file
  // (api-keys.json), separate from the settings JSON, and return a fresh snapshot
  // so the renderer's hasGeminiApiKey presence flag updates immediately.
  setGeminiApiKey(apiKey: string): Promise<{ hasGeminiApiKey: boolean }>;
  clearGeminiApiKey(): Promise<{ hasGeminiApiKey: boolean }>;
  chooseOutputDirectory(): Promise<void>;
  saveSetupDirectory(directory: string): Promise<void>;
  saveSetupRecordingsDirectory(directory: string): Promise<void>;
  saveSetupTimezone(timezone: string): Promise<void>;
  chooseOriginalsDirectory(): Promise<void>;
  saveCard(cardId: string, resolution?: SaveConflictResolution, options?: SaveCardOptions): Promise<SaveCardResult>;
  removeCard(cardId: string): Promise<void>;
  reportRendererError(report: RendererErrorReport): Promise<void>;
  reportRendererDiagnostic(report: RendererErrorReport): Promise<void>;
  dismissAppWideError(): Promise<void>;
  resetState(): Promise<void>;
  cancelPendingImports(ids: string[]): Promise<void>;
  // Managed audio-tool operations. Each returns a fresh snapshot so the surface
  // reflects the new state; live progress arrives with each snapshot.
  // provisionTool is the single acquire operation (Install when absent, Update
  // when a newer version is known — same flow underneath).
  provisionTool(name: ToolName): Promise<void>;
  cancelToolProvision(name: ToolName): Promise<void>;
  checkTools(): Promise<void>;
  cancelToolCheck(): Promise<void>;
  saveToolSettings(checkUpdatesAtLaunch: boolean): Promise<void>;
  // Persist the queue (left) pane's dragged width intent to layout.json and return
  // a fresh snapshot. Called only on a splitter drag-commit; a window resize
  // re-derives the displayed width in the renderer and persists nothing.
  saveLayout(queueWidth: number): Promise<void>;
  // The records window: opened from the main window, it reads records.sqlite3.
  openRecordsWindow(): Promise<void>;
  readRecordsPage(query: RecordsQuery): Promise<RecordsPage>;
  readRecordDetail(kind: RecordKind, id: number): Promise<RecordDetail | null>;
  recordsMissing(): Promise<boolean>;
  readRecordSources(): Promise<RecordSources>;
  // The records window's list pane width: the dragged intent, read at open and
  // saved when a drag ends; the saved width comes back clamped.
  getRecordsListWidth(): Promise<number>;
  saveRecordsListWidth(width: number): Promise<number>;
  getPathForFile(file: File): string;
  onInterfaceLanguageChanged(listener: () => void): () => void;
  // A record was stored or missing-history health changed.
  onRecordsChanged(listener: (missingRecords: boolean) => void): () => void;
  /** Registers what sends the window's unsent edits when a quit asks for them. */
  onFlushPendingEdits(flush: () => Promise<void>): () => void;
  /** Registers what reports, and what discards, a session-only draft when a
   * user's quit or window close asks. */
  onUnsavedDrafts(report: () => UnsavedDraft[], discard: () => void): () => void;
}
