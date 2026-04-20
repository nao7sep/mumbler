export const APP_SHELL_CHANNELS = {
  getSnapshot: "app-shell:get-snapshot",
  openImportDialog: "app-shell:open-import-dialog",
  importDroppedPaths: "app-shell:import-dropped-paths",
  confirmPendingImports: "app-shell:confirm-pending-imports",
  selectCard: "app-shell:select-card",
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
  durationSec: number | null;
  fileSizeBytes: number;
  language: string;
  timestamps: CardTimestamps;
  trim: CardTrim;
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
  defaultTimezone: string;
  languageCount: number;
  timestampPatternCount: number;
  previewSnippetSeconds: number;
  concurrencyLimit: number;
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

export interface MumblerShellApi {
  getSnapshot(): Promise<AppSnapshot>;
  openImportDialog(): Promise<ImportOperationResult>;
  importDroppedPaths(paths: string[]): Promise<ImportOperationResult>;
  confirmPendingImports(items: PendingImportReviewItem[]): Promise<AppSnapshot>;
  selectCard(cardId: string | null): Promise<AppSnapshot>;
}
