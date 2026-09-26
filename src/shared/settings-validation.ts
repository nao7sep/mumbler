import type { SettingsDraft } from "./app-shell";
import type { MessageKey } from "./i18n/catalogues";
import { message, type Message } from "./i18n/translate";

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

export type NumericSettingField =
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
  isValid: (value: number) => boolean;
  // The whole sentence for this field, so no language has to build it from a
  // label and a requirement.
  issue: MessageKey;
}

export interface NumericSettingIssue {
  field: NumericSettingField;
  message: Message;
}

const NUMERIC_SETTING_RULES: NumericSettingRule[] = [
  { field: "skipIntervalSec", isValid: isPositiveIntegerSetting, issue: "settingsIssue.skipIntervalSec" },
  { field: "previewSnippetSeconds", isValid: isPositiveIntegerSetting, issue: "settingsIssue.previewSnippetSeconds" },
  { field: "concurrencyLimit", isValid: isPositiveIntegerSetting, issue: "settingsIssue.concurrencyLimit" },
  { field: "retryMaxRetries", isValid: isPositiveIntegerSetting, issue: "settingsIssue.retryMaxRetries" },
  { field: "retryInitialDelayMs", isValid: isPositiveIntegerSetting, issue: "settingsIssue.retryInitialDelayMs" },
  { field: "retryMaxDelayMs", isValid: isPositiveIntegerSetting, issue: "settingsIssue.retryMaxDelayMs" },
  { field: "transcriptionTimeoutMs", isValid: isPositiveIntegerSetting, issue: "settingsIssue.transcriptionTimeoutMs" },
  { field: "metadataTimeoutMs", isValid: isPositiveIntegerSetting, issue: "settingsIssue.metadataTimeoutMs" },
  { field: "retryJitterRatio", isValid: isRatioSetting, issue: "settingsIssue.retryJitterRatio" },
];

// One field-addressable issue per invalid numeric setting, in form order. The
// renderer uses the field identity for aria-invalid / aria-describedby while the
// message remains the same validation truth shown to the user.
export function getSettingsNumberIssues(draft: SettingsDraft): NumericSettingIssue[] {
  return NUMERIC_SETTING_RULES.filter((rule) => !rule.isValid(draft[rule.field])).map(
    (rule) => ({ field: rule.field, message: message(rule.issue) }),
  );
}
