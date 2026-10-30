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

// What a whole-number field's text reads as: digits only, surrounding spaces
// aside. Anything else, a fraction included, reads as NaN so the rule reports it
// instead of the field cutting it to a whole number.
export function parseWholeNumberText(text: string): number {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

// The most transcriptions that may run at once (developer decision, matching
// TapeBox's downloads).
export const CONCURRENCY_LIMIT_MAX = 16;

export function isConcurrencyLimitSetting(value: number): boolean {
  return isPositiveIntegerSetting(value) && value <= CONCURRENCY_LIMIT_MAX;
}


export type NumericSettingField =
  | "skipIntervalSec"
  | "previewSnippetSeconds"
  | "concurrencyLimit";

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
  { field: "concurrencyLimit", isValid: isConcurrencyLimitSetting, issue: "settingsIssue.concurrencyLimit" },
];

// One field-addressable issue per invalid numeric setting, in form order. The
// renderer uses the field identity for aria-invalid / aria-describedby while the
// message remains the same validation truth shown to the user.
export function getSettingsNumberIssues(draft: SettingsDraft): NumericSettingIssue[] {
  return NUMERIC_SETTING_RULES.filter((rule) => !rule.isValid(draft[rule.field])).map(
    (rule) => ({ field: rule.field, message: message(rule.issue) }),
  );
}

export interface TimestampPatternIssue {
  // The row the issue is about, or null for the list as a whole.
  row: number | null;
  message: Message;
}

// The timestamp pattern rows' issues, shared like the numeric rules: a blank row
// is dropped at save, so the list needs one filled row, and each filled row must
// compile. Rows are numbered from 1, as the editor shows them.
export function getTimestampPatternIssues(rows: readonly string[]): TimestampPatternIssue[] {
  const filled = rows.map((row) => row.trim());
  if (filled.every((row) => row.length === 0)) {
    return [{ row: null, message: message("settingsIssue.timestampPatternsRequired") }];
  }
  return filled.flatMap((row, index) => {
    if (row.length === 0) return [];
    try {
      new RegExp(row);
      return [];
    } catch {
      return [{ row: index, message: message("settingsIssue.timestampPatternInvalid", { number: index + 1 }) }];
    }
  });
}
