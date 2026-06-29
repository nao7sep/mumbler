export const GEMINI_MODELS = [
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash (Preview)" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
] as const;

export const APP_SHELL_CHANNELS = {
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
  updateTool: "app-shell:update-tool",
  verifyTool: "app-shell:verify-tool",
  checkTools: "app-shell:check-tools",
  saveToolSettings: "app-shell:save-tool-settings",
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
  transcriptionModel: string;
  metadataModel: string;
  concurrencyLimit: number;
  prompts: PromptTemplates;
  retryPolicy: RetryPolicy;
  timeouts: OperationTimeouts;
  // Managed audio tools (ffmpeg/ffprobe), per the managed-dependency-status and
  // version-and-update conventions. These gate only the *automatic* behaviour;
  // the manual operations in the Audio Tools surface are always available.
  // checkToolUpdates: run the (cached, staleness-gated) currency check on launch.
  // autoDownloadTools: auto-fetch a missing required tool when the surface opens.
  checkToolUpdates: boolean;
  autoDownloadTools: boolean;
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
  transcriptionModel: string;
  metadataModel: string;
  concurrencyLimit: number;
  // Managed audio-tool gates, surfaced so the Audio Tools modal can show and edit
  // them without the full settings-draft roundtrip.
  checkToolUpdates: boolean;
  autoDownloadTools: boolean;
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
// per the managed-dependency-status-conventions. Both tools are required to
// function. The "unmanaged" (user-supplied) lifecycle is deliberately not modeled
// — mumbler owns its bin directory and never adopts a hand-placed binary.

export type ToolName = "ffmpeg" | "ffprobe";

// Primary lifecycle. Currency is a sub-state of "provisioned" only — the model is
// nested, so an impossible combination (an absent tool that is "stale") cannot be
// expressed.
export type ToolLifecycle = "absent" | "provisioned" | "faulted";

// Currency sub-state, meaningful only while provisioned.
export type ToolCurrency = "unchecked" | "current" | "stale" | "check-failed";

// Semantic status role — the meaning, not the colour. The theme maps each role to
// a concrete colour/icon.
export type StatusRole = "none" | "informational" | "warning" | "error";

// The single operation a row offers.
export type ToolOperationKind = "provision" | "check" | "update" | "verify";

// Persisted, honest per-tool facts — the single source of truth status derives
// from. installedVersion and desiredVersion are stored already normalized, so they
// compare by string equality.
export interface ToolFacts {
  present: boolean;
  // True when present but unusable/untrustworthy: a failed integrity verify, an
  // unreadable file, or an unparseable installed version. The sole route to the
  // Faulted lifecycle, so a fault is always a recorded fact, never inferred.
  faulted: boolean;
  installedVersion: string | null;
  desiredVersion: string | null;
  lastCheckedAtUtc: number | null;
  // Non-null iff the last currency check failed — the signal that distinguishes
  // check-failed from a clean check. Separate from lastError below.
  lastCheckError: string | null;
  // Display message for the last fault or failed operation (provision/verify).
  lastError: string | null;
}

// Transient, non-persisted status of an in-flight or just-failed operation. It
// overlays the persisted state at render and never becomes a lifecycle state — a
// failed Provision leaves the tool Absent with lastError set, not "install-failed".
export type ToolTransient =
  | { kind: "idle" }
  | { kind: "running"; operation: ToolOperationKind; percent: number | null }
  | { kind: "failed"; operation: ToolOperationKind; error: string };

// The derived row the surface renders — the output of deriveStatus(). Rendering
// reads this and nothing else (no filesystem probe, no --version call).
export interface DependencyStatus {
  name: ToolName;
  required: boolean;
  lifecycle: ToolLifecycle;
  currency: ToolCurrency | null;
  role: StatusRole;
  operation: ToolOperationKind | null;
  installedVersion: string | null;
  desiredVersion: string | null;
  lastCheckedAtUtc: number | null;
  error: string | null;
  transient: ToolTransient;
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
  provisionTool(name: ToolName): Promise<AppSnapshot>;
  updateTool(name: ToolName): Promise<AppSnapshot>;
  verifyTool(name: ToolName): Promise<AppSnapshot>;
  checkTools(): Promise<AppSnapshot>;
  saveToolSettings(checkToolUpdates: boolean, autoDownloadTools: boolean): Promise<AppSnapshot>;
  getPathForFile(file: File): string;
  onAppWideErrorChanged(listener: () => void): () => void;
  onPipelineProgressUpdated(listener: () => void): () => void;
  onDependenciesUpdated(listener: () => void): () => void;
}
