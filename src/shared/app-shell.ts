export const GEMINI_MODELS = [
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
  { id: "gemini-3.1-flash-preview", label: "Gemini 3.1 Flash" },
  { id: "gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite" },
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
  chooseOutputDirectory: "app-shell:choose-output-directory",
  saveCard: "app-shell:save-card",
  removeCard: "app-shell:remove-card",
  reportRendererError: "app-shell:report-renderer-error",
  dismissAppWideError: "app-shell:dismiss-app-wide-error",
  resetState: "app-shell:reset-state",
  cancelPendingImports: "app-shell:cancel-pending-imports",
} as const;

export const APP_SHELL_EVENTS = {
  appWideErrorUpdated: "app-shell:event-app-wide-error-updated",
  pipelineProgressUpdated: "app-shell:event-pipeline-progress-updated",
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
  textMs: number;
}

export interface PromptTemplates {
  structured: string;
  title: string;
  slug: string;
}

export interface MumblerSettings {
  schemaVersion: 1;
  // Files
  outputDirectory: string | null;
  backupDirectory: string | null;
  // Import
  defaultTimezone: string;
  timestampPatterns: string[];
  // Player
  previewSnippetSeconds: number;
  skipIntervalSec: number;
  // AI
  geminiApiKeyObfuscated: string;
  transcriptionModel: string;
  metadataModel: string;
  concurrencyLimit: number;
  prompts: PromptTemplates;
  retryPolicy: RetryPolicy;
  timeouts: OperationTimeouts;
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
  logsDir: string;
  workingDir: string;
  outputDir: string;
  backupsDir: string;
}

export interface SettingsSummary {
  // Files
  outputDirectory: string | null;
  defaultOutputDirectory: string;
  backupDirectory: string | null;
  defaultBackupDirectory: string;
  // Import
  defaultTimezone: string;
  timestampPatternCount: number;
  // Player
  previewSnippetSeconds: number;
  skipIntervalSec: number;
  // AI
  hasGeminiApiKey: boolean;
  transcriptionModel: string;
  metadataModel: string;
  concurrencyLimit: number;
}

export interface SettingsDraft {
  schemaVersion: 1;
  // Files
  outputDirectory: string;
  defaultOutputDirectory: string;
  backupDirectory: string;
  defaultBackupDirectory: string;
  // Import
  defaultTimezone: string;
  timestampPatternsText: string;
  // Player
  previewSnippetSeconds: number;
  skipIntervalSec: number;
  // AI
  hasGeminiApiKey: boolean;
  geminiApiKeyInput: string;
  clearGeminiApiKey: boolean;
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
  textTimeoutMs: number;
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

export interface AppSnapshot {
  appName: string;
  appVersion: string;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  shellReadyAtUtc: number;
  paths: AppPaths | null;
  settingsSummary: SettingsSummary | null;
  queueSummary: QueueSummary | null;
  commands: CommandDefinition[];
  startupDiagnostic: StartupDiagnostic | null;
  appWideError: StartupDiagnostic | null;
  state: MumblerState | null;
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
  chooseOutputDirectory(): Promise<AppSnapshot>;
  saveCard(cardId: string, resolution?: SaveConflictResolution): Promise<SaveCardResult>;
  removeCard(cardId: string): Promise<AppSnapshot>;
  reportRendererError(report: RendererErrorReport): Promise<AppSnapshot>;
  dismissAppWideError(): Promise<AppSnapshot>;
  resetState(): Promise<AppSnapshot>;
  cancelPendingImports(): Promise<AppSnapshot>;
  getPathForFile(file: File): string;
  onAppWideErrorChanged(listener: () => void): () => void;
  onPipelineProgressUpdated(listener: () => void): () => void;
}
