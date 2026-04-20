export const APP_SHELL_CHANNELS = {
  getSnapshot: "app-shell:get-snapshot",
  getSettingsDraft: "app-shell:get-settings-draft",
  openImportDialog: "app-shell:open-import-dialog",
  importDroppedPaths: "app-shell:import-dropped-paths",
  confirmPendingImports: "app-shell:confirm-pending-imports",
  selectCard: "app-shell:select-card",
  duplicateCard: "app-shell:duplicate-card",
  updateCardTrim: "app-shell:update-card-trim",
  updateCardLanguage: "app-shell:update-card-language",
  getCardMediaSource: "app-shell:get-card-media-source",
  transcribeCard: "app-shell:transcribe-card",
  retryCard: "app-shell:retry-card",
  pickOutputDirectory: "app-shell:pick-output-directory",
  saveSettingsDraft: "app-shell:save-settings-draft",
  chooseOutputDirectory: "app-shell:choose-output-directory",
  saveCard: "app-shell:save-card",
  removeCard: "app-shell:remove-card",
  respondToWindowClose: "app-shell:respond-to-window-close",
} as const;

export const APP_SHELL_EVENTS = {
  windowCloseRequested: "app-shell:event-window-close-requested",
} as const;

export type CardStatus =
  | "Pending Review"
  | "Imported"
  | "Transcribing"
  | "Generating Metadata"
  | "Ready to Save"
  | "Error";

export type CommandId =
  | "play-pause"
  | "set-front-marker"
  | "set-back-marker"
  | "play-first-snippet"
  | "play-last-snippet"
  | "transcribe-selected"
  | "save-selected"
  | "retry-selected"
  | "remove-selected"
  | "select-previous"
  | "select-next";

export interface CommandDefinition {
  id: CommandId;
  label: string;
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
  titleMs: number;
  slugMs: number;
}

export interface PromptTemplates {
  title: string;
  slug: string;
}

export interface MumblerSettings {
  schemaVersion: 1;
  geminiApiKeyObfuscated: string;
  outputDirectory: string | null;
  transcriptionModel: string;
  metadataModel: string;
  defaultLanguage: string;
  languages: string[];
  defaultTimezone: string;
  timestampPatterns: string[];
  prompts: PromptTemplates;
  previewSnippetSeconds: number;
  concurrencyLimit: number;
  retryPolicy: RetryPolicy;
  timeouts: OperationTimeouts;
  shortcuts: Record<CommandId, string>;
}

export type ImportSource = "file-picker" | "drag-and-drop";
export type CardProcessingStep = "transcription" | "title" | "slug" | null;
export type TimestampParseStatus = "parsed" | "manual-required";

export interface CardError {
  message: string;
  occurredAtUtc: string;
  failedStep: Exclude<CardProcessingStep, null> | "startup-recovery";
}

export interface CardTimestamps {
  confirmedLocal: string;
  confirmedUtc: string;
  timezone: string;
  frontTrimOffsetSec: number;
  effectiveLocal: string;
  effectiveUtc: string;
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
  analyzedAtUtc: string;
}

export interface AiRunInfo {
  provider: "gemini";
  model: string;
  generatedAtUtc: string;
}

export interface PendingImportReviewItem {
  id: string;
  originalFilename: string;
  importSource: ImportSource;
  workingFilePath: string;
  fileSizeBytes: number;
  localTimestampText: string;
  timezone: string;
  utcTimestampText: string;
  parseStatus: TimestampParseStatus;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface MumblerCard {
  id: string;
  originalFilename: string;
  importSource: ImportSource;
  sourceFilePath: string;
  audioProfile: AudioProfile | null;
  durationSec: number | null;
  fileSizeBytes: number;
  language: string;
  timestamps: CardTimestamps;
  trim: CardTrim;
  trimDecision: TrimDecision | null;
  transcription: {
    text: string | null;
  };
  metadata: {
    title: string | null;
    slug: string | null;
  };
  ai: {
    transcription: AiRunInfo | null;
    title: AiRunInfo | null;
    slug: AiRunInfo | null;
  };
  status: CardStatus;
  activeStep: CardProcessingStep;
  lastError: CardError | null;
  createdAtUtc: string;
  updatedAtUtc: string;
}

export interface MumblerState {
  schemaVersion: 1;
  pendingImports: PendingImportReviewItem[];
  cards: MumblerCard[];
  selectedCardId: string | null;
  updatedAtUtc: string;
}

export interface AppPaths {
  homeDir: string;
  settingsPath: string;
  statePath: string;
  logsDir: string;
  workingDir: string;
}

export interface SettingsSummary {
  hasGeminiApiKey: boolean;
  outputDirectory: string | null;
  transcriptionModel: string;
  metadataModel: string;
  defaultLanguage: string;
  languages: string[];
  defaultTimezone: string;
  languageCount: number;
  timestampPatternCount: number;
  previewSnippetSeconds: number;
  concurrencyLimit: number;
  shortcuts: Record<CommandId, string>;
}

export interface SettingsDraft {
  schemaVersion: 1;
  hasGeminiApiKey: boolean;
  geminiApiKeyInput: string;
  clearGeminiApiKey: boolean;
  outputDirectory: string;
  transcriptionModel: string;
  metadataModel: string;
  defaultLanguage: string;
  languagesText: string;
  defaultTimezone: string;
  timestampPatternsText: string;
  titlePrompt: string;
  slugPrompt: string;
  previewSnippetSeconds: number;
  concurrencyLimit: number;
  retryMaxRetries: number;
  retryInitialDelayMs: number;
  retryMaxDelayMs: number;
  retryJitterRatio: number;
  transcriptionTimeoutMs: number;
  titleTimeoutMs: number;
  slugTimeoutMs: number;
  shortcuts: Record<CommandId, string>;
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

export interface AppSnapshot {
  appName: string;
  appVersion: string;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  shellReadyAtUtc: string;
  paths: AppPaths | null;
  settingsSummary: SettingsSummary | null;
  queueSummary: QueueSummary | null;
  commands: CommandDefinition[];
  startupDiagnostic: StartupDiagnostic | null;
  state: MumblerState | null;
  supportedTimezones: string[];
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
    }
  | {
      kind: "conflict";
      snapshot: AppSnapshot;
      audioPath: string;
      jsonPath: string;
    }
  | {
      kind: "cancelled";
      snapshot: AppSnapshot;
    };

export interface MumblerShellApi {
  getSnapshot(): Promise<AppSnapshot>;
  getSettingsDraft(): Promise<SettingsDraft>;
  openImportDialog(): Promise<ImportOperationResult>;
  importDroppedPaths(paths: string[]): Promise<ImportOperationResult>;
  confirmPendingImports(items: PendingImportReviewItem[]): Promise<AppSnapshot>;
  selectCard(cardId: string | null): Promise<AppSnapshot>;
  duplicateCard(cardId: string): Promise<AppSnapshot>;
  updateCardTrim(cardId: string, trim: CardTrim): Promise<AppSnapshot>;
  updateCardLanguage(cardId: string, language: string): Promise<AppSnapshot>;
  getCardMediaSource(cardId: string): Promise<string>;
  transcribeCard(cardId: string): Promise<AppSnapshot>;
  retryCard(cardId: string): Promise<AppSnapshot>;
  pickOutputDirectory(): Promise<string | null>;
  saveSettingsDraft(draft: SettingsDraft): Promise<AppSnapshot>;
  chooseOutputDirectory(): Promise<AppSnapshot>;
  saveCard(cardId: string, resolution?: SaveConflictResolution): Promise<SaveCardResult>;
  removeCard(cardId: string): Promise<AppSnapshot>;
  respondToWindowClose(shouldClose: boolean): Promise<void>;
  onWindowCloseRequested(listener: () => void): () => void;
}
