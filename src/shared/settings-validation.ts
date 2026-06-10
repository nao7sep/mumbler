import type { SettingsDraft } from "./app-shell";

// Single source of truth for what makes a numeric setting valid, shared by the
// main-process commit validation (settings-schema) and the renderer's Settings
// form. The renderer's Save gate is built from the same predicates the backend
// enforces, so the button can never enable a value the backend will reject.

export function isPositiveIntegerSetting(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function isRatioSetting(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

type NumericSettingField =
  | "skipIntervalSec"
  | "previewSnippetSeconds"
  | "concurrencyLimit"
  | "retryMaxRetries"
  | "retryInitialDelayMs"
  | "retryMaxDelayMs"
  | "retryJitterRatio"
  | "transcriptionTimeoutMs"
  | "metadataTimeoutMs";

interface NumericSettingRule {
  field: NumericSettingField;
  label: string;
  isValid: (value: number) => boolean;
  requirement: string;
}

const NUMERIC_SETTING_RULES: NumericSettingRule[] = [
  { field: "skipIntervalSec", label: "Skip interval", isValid: isPositiveIntegerSetting, requirement: "a positive integer" },
  { field: "previewSnippetSeconds", label: "Preview duration", isValid: isPositiveIntegerSetting, requirement: "a positive integer" },
  { field: "concurrencyLimit", label: "Concurrent transcriptions", isValid: isPositiveIntegerSetting, requirement: "a positive integer" },
  { field: "retryMaxRetries", label: "Max retries", isValid: isPositiveIntegerSetting, requirement: "a positive integer" },
  { field: "retryInitialDelayMs", label: "Initial retry delay", isValid: isPositiveIntegerSetting, requirement: "a positive integer" },
  { field: "retryMaxDelayMs", label: "Max retry delay", isValid: isPositiveIntegerSetting, requirement: "a positive integer" },
  { field: "transcriptionTimeoutMs", label: "Transcription timeout", isValid: isPositiveIntegerSetting, requirement: "a positive integer" },
  { field: "metadataTimeoutMs", label: "Metadata generation timeout", isValid: isPositiveIntegerSetting, requirement: "a positive integer" },
  { field: "retryJitterRatio", label: "Retry jitter", isValid: isRatioSetting, requirement: "between 0 and 1" },
];

// One human-readable message per invalid numeric field, in form order. An empty
// array means every numeric setting is valid and the form is safe to commit.
export function getSettingsNumberErrors(draft: SettingsDraft): string[] {
  return NUMERIC_SETTING_RULES.filter((rule) => !rule.isValid(draft[rule.field])).map(
    (rule) => `${rule.label} must be ${rule.requirement}.`,
  );
}
