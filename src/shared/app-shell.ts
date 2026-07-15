// Built-in default Gemini model suggestions, seeded into the user-owned, editable
// model list (MumblerSettings.geminiModels) at first run. A small, editable starter
// set — the user can add/remove entries and type any id; a wrong or unsupported id
// surfaces at call time (the validity boundary), not from this list. Google's
// `-preview` suffix is branding, not a reason to exclude a model. Ordered
// pro → flash → flash → lite.
export const DEFAULT_GEMINI_MODELS: string[] = [
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite",
];

export const APP_SHELL_CHANNELS = {
  getSnapshot: "app-shell:get-snapshot",
  getSettingsDraft: "app-shell:get-settings-draft",
  getDefaultPrompts: "app-shell:get-default-prompts",
  getDefaultModels: "app-shell:get-default-models",
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
  saveSettingsDraft: "app-shell:save-settings-draft",
  setGeminiApiKey: "app-shell:set-gemini-api-key",
  clearGeminiApiKey: "app-shell:clear-gemini-api-key",
  chooseOutputDirectory: "app-shell:choose-output-directory",
  saveCard: "app-shell:save-card",
  removeCard: "app-shell:remove-card",
  reportRendererError: "app-shell:report-renderer-error",
  dismissAppWideError: "app-shell:dismiss-app-wide-error",
  resetState: "app-shell:reset-state",
  cancelPendingImports: "app-shell:cancel-pending-imports",
  provisionTool: "app-shell:provision-tool",
  checkTools: "app-shell:check-tools",
  saveToolSettings: "app-shell:save-tool-settings",
  saveLayout: "app-shell:save-layout",
} as const;

export const APP_SHELL_EVENTS = {
  appWideErrorUpdated: "app-shell:event-app-wide-error-updated",
  pipelineProgressUpdated: "app-shell:event-pipeline-progress-updated",
  dependenciesUpdated: "app-shell:event-dependencies-updated",
} as const;

export type CardStatus =
  | "Pending Review"
  | "Imported"
  | "Queued"
  | "Transcribing"
  | "Generating Metadata"
  | "Ready to Save"
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
  label: string;
  group: string;
  defaultShortcut: string;
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

// The built-in AI defaults the "Reset models" action restores to: the current
// Gemini model suggestion list and the default model selections.
export interface DefaultModels {
  models: string[];
  transcriptionModel: string;
  metadataModel: string;
}

export interface MumblerSettings {
  schemaVersion: 1;
  // Appearance — the UI (chrome) font family. Family only; blank means the built-in default stack
  // (the renderer's `--font-ui` variable). The read-only transcription/structured/title/slug views
  // are display surfaces, so they follow this UI font rather than a separate content font.
  uiFontFamily: string;
  // Files
  outputDirectory: string | null;
  backupDirectory: string | null;
  // Import
  defaultTimezone: string;
  timestampPatterns: string[];
  // Player
  skipIntervalSec: number;
  previewSnippetSeconds: number;
  // AI
  // NOTE: the Gemini API key is NOT a setting. It is a secret resolved
  // environment-first and stored in its own 0600 file (api-keys.json), never in
  // this shared settings store. See src/main/core/api-keys.ts.
  //
  // The user-owned, editable Gemini model suggestion list (config-seeding-conventions'
  // Shape 1): seeded from DEFAULT_GEMINI_MODELS at first run, then the user's to
  // add to, remove from, or edit. transcriptionModel/metadataModel are by-value
  // selections into it; a value outside the list is allowed (free-text) and is
  // validated at call time by the adapter, not here.
  geminiModels: string[];
  transcriptionModel: string;
  metadataModel: string;
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

export interface MumblerState {
  schemaVersion: 1;
  pendingImports: PendingImportReviewItem[];
  cards: MumblerCard[];
  selectedCardId: string | null;
  updatedAtUtc: number;
}

export interface AppPaths {
  homeDir: string;
  settingsPath: string;
  statePath: string;
  // Disposable pane geometry (the draggable queue-pane width). Its own file, apart
  // from settingsPath/statePath, so it self-heals on corruption instead of halting
  // launch (see MumblerLayout below).
  layoutPath: string;
  // The secrets file. The Gemini API key lives here in its own 0600 file, not in
  // settingsPath (storage-path-conventions, "Secrets and keys").
  apiKeysPath: string;
  logsDir: string;
  workingDir: string;
  outputDir: string;
  backupsDir: string;
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
  // Import
  defaultTimezone: string;
  timestampPatternCount: number;
  // Player
  skipIntervalSec: number;
  previewSnippetSeconds: number;
  // AI
  hasGeminiApiKey: boolean;
  geminiModels: string[];
  transcriptionModel: string;
  metadataModel: string;
  concurrencyLimit: number;
  // The one managed-audio-tool toggle, surfaced so the Audio Tools modal can show
  // and edit it without the full settings-draft roundtrip.
  checkUpdatesAtLaunch: boolean;
}

export interface SettingsDraft {
  schemaVersion: 1;
  // Appearance
  uiFontFamily: string;
  // Files
  outputDirectory: string;
  defaultOutputDirectory: string;
  backupDirectory: string;
  defaultBackupDirectory: string;
  // Import
  defaultTimezone: string;
  timestampPatternsText: string;
  // Player
  skipIntervalSec: number;
  previewSnippetSeconds: number;
  // AI
  // Presence flag only — whether a Gemini key is currently available (env or
  // stored). The key value itself is never part of this draft; it is set/cleared
  // through the dedicated setGeminiApiKey/clearGeminiApiKey IPC, not the settings
  // JSON roundtrip.
  hasGeminiApiKey: boolean;
  // The owned Gemini model list as editable text (one id per line) — the same idiom
  // as timestampPatternsText; parsed and deduped back into geminiModels on save.
  geminiModelsText: string;
  transcriptionModel: string;
  metadataModel: string;
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

export interface StartupDiagnostic {
  title: string;
  message: string;
}

export interface RendererErrorReport {
  message: string;
  source: string;
  stack?: string;
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

// Persisted, honest per-tool facts — the single source of truth status derives
// from. installedVersion and desiredVersion are stored already normalized, so they
// compare by string equality. Presence is NOT here: it is scanned from disk.
export interface ToolFacts {
  present: boolean;
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
  | { kind: "failed"; operation: ToolOperationKind; error: string };

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

// Disposable window/view geometry — the pane sizes the user drags. Persisted in
// its own layout.json (never config.json, which the user edits, nor state.json,
// which holds precious card data): losing a pane width costs the user nothing, so
// unlike those stores a corrupt layout file self-heals to defaults instead of
// halting launch. queueWidth is the user's dragged INTENT in CSS pixels, bounded
// by QUEUE_WIDTH (@shared/layout); the renderer re-clamps it to the live window
// for display (clampSplitter) and persists it only on a splitter drag.
export interface MumblerLayout {
  schemaVersion: number;
  queueWidth: number;
}

export interface AppSnapshot {
  appName: string;
  appVersion: string;
  platform: Platform;
  isPackaged: boolean;
  shellReadyAtUtc: number;
  paths: AppPaths | null;
  settingsSummary: SettingsSummary | null;
  queueSummary: QueueSummary | null;
  commands: CommandDefinition[];
  startupDiagnostic: StartupDiagnostic | null;
  appWideError: StartupDiagnostic | null;
  state: MumblerState | null;
  // Disposable pane geometry (the draggable queue-pane width). Null until the
  // runtime is ready, like the other snapshot slices.
  layout: MumblerLayout | null;
  // Derived status of each managed audio tool, computed in main via deriveStatus
  // from persisted facts + transient operation status. The renderer reads these
  // directly (never probes). Null until the runtime is ready.
  dependencies: DependencyStatus[] | null;
}

export interface FailedImport {
  sourcePath: string;
  message: string;
}

export interface ImportOperationResult {
  snapshot: AppSnapshot;
  importedCount: number;
  failedImports: FailedImport[];
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
  getSnapshot(): Promise<AppSnapshot>;
  getSettingsDraft(): Promise<SettingsDraft>;
  getDefaultPrompts(): Promise<PromptTemplates>;
  getDefaultModels(): Promise<DefaultModels>;
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
  dismissAppWideError(): Promise<AppSnapshot>;
  resetState(): Promise<AppSnapshot>;
  cancelPendingImports(): Promise<AppSnapshot>;
  // Managed audio-tool operations. Each returns a fresh snapshot so the surface
  // reflects the new state; live progress arrives via onDependenciesUpdated.
  // provisionTool is the single acquire operation (Install when absent, Update
  // when a newer version is known — same flow underneath).
  provisionTool(name: ToolName): Promise<AppSnapshot>;
  checkTools(): Promise<AppSnapshot>;
  saveToolSettings(checkUpdatesAtLaunch: boolean): Promise<AppSnapshot>;
  // Persist the queue (left) pane's dragged width intent to layout.json and return
  // a fresh snapshot. Called only on a splitter drag-commit; a window resize
  // re-derives the displayed width in the renderer and persists nothing.
  saveLayout(queueWidth: number): Promise<AppSnapshot>;
  getPathForFile(file: File): string;
  onAppWideErrorChanged(listener: () => void): () => void;
  onPipelineProgressUpdated(listener: () => void): () => void;
  onDependenciesUpdated(listener: () => void): () => void;
}
