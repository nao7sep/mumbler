import { createTranslator } from "@shared/i18n/translate";
import { describe, expect, it } from "vitest";

import type { SettingsDraft } from "@shared/app-shell";
import {
  getSettingsNumberIssues,
  getTimestampPatternIssues,
  isPositiveIntegerSetting,
} from "@shared/settings-validation";

function validDraft(): SettingsDraft {
  return {
    language: "system",
    theme: "system",
    uiFontFamily: "",
    outputDirectory: "",
    defaultOutputDirectory: "/out",
    backupDirectory: "",
    defaultBackupDirectory: "/backup",
    defaultTimezone: "Asia/Tokyo",
    displayTimezone: "system",
    timestampPatterns: ["(?<year>\\d{4})"],
    skipIntervalSec: 10,
    previewSnippetSeconds: 10,
    hasGeminiApiKey: false,
    geminiEndpoint: "https://generativelanguage.googleapis.com",
    outlineModel: "gemini-3.8-flash",
    transcriptionModel: "gemini-3-flash",
    metadataModel: "gemini-3-flash",
    transcriptionThinking: "medium",
    outlineThinking: "medium",
    metadataThinking: "minimal",
    concurrencyLimit: 3,
    structuredPrompt: "{transcript}",
    titlePrompt: "{transcript}",
    slugPrompt: "{title}",
  };
}

describe("isPositiveIntegerSetting", () => {
  it("accepts positive integers only", () => {
    expect(isPositiveIntegerSetting(1)).toBe(true);
    expect(isPositiveIntegerSetting(60000)).toBe(true);
  });

  it("rejects zero, negatives, fractionals, and non-finite values", () => {
    expect(isPositiveIntegerSetting(0)).toBe(false);
    expect(isPositiveIntegerSetting(-5)).toBe(false);
    expect(isPositiveIntegerSetting(2.5)).toBe(false);
    expect(isPositiveIntegerSetting(Number.NaN)).toBe(false);
    expect(isPositiveIntegerSetting(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

const english = createTranslator("en");
function getSettingsNumberErrors(draft: SettingsDraft): string[] {
  return getSettingsNumberIssues(draft).map((issue) => english.text(issue.message));
}

describe("getSettingsNumberIssues", () => {
  it("returns no errors for a fully valid draft", () => {
    expect(getSettingsNumberErrors(validDraft())).toEqual([]);
  });

  it("flags a cleared (NaN) integer field — the case that gates Save", () => {
    const draft = validDraft();
    draft.concurrencyLimit = Number.NaN;
    expect(getSettingsNumberErrors(draft)).toEqual([
      "Concurrent transcriptions must be a positive integer.",
    ]);
  });

  it("flags zero and negative integer fields the backend rejects", () => {
    const draft = validDraft();
    draft.skipIntervalSec = 0;
    draft.previewSnippetSeconds = -1;
    expect(getSettingsNumberErrors(draft)).toEqual([
      "Skip interval must be a positive integer.",
      "Preview duration must be a positive integer.",
    ]);
  });

  it("flags a fractional value in an integer field", () => {
    const draft = validDraft();
    draft.concurrencyLimit = 1.5;
    expect(getSettingsNumberErrors(draft)).toEqual([
      "Concurrent transcriptions must be a positive integer.",
    ]);
  });

  it("reports every invalid field in form order", () => {
    const draft = validDraft();
    draft.skipIntervalSec = 0;
    draft.concurrencyLimit = Number.NaN;
    expect(getSettingsNumberErrors(draft)).toEqual([
      "Skip interval must be a positive integer.",
      "Concurrent transcriptions must be a positive integer.",
    ]);
  });
});

describe("getTimestampPatternIssues", () => {
  it("needs one filled row, and ignores blank ones", () => {
    expect(getTimestampPatternIssues([]).map((issue) => [issue.row, issue.message.key])).toEqual([[null, "settingsIssue.timestampPatternsRequired"]]);
    expect(getTimestampPatternIssues(["", "  "]).map((issue) => issue.row)).toEqual([null]);
    expect(getTimestampPatternIssues(["", "(?<year>\\d{4})", " "])).toEqual([]);
  });

  it("points at each row that does not compile, numbered as the editor shows it", () => {
    const issues = getTimestampPatternIssues(["(?<year>\\d{4})", "(", "", "[a-"]);
    expect(issues.map((issue) => issue.row)).toEqual([1, 3]);
    expect(issues[0]!.message).toEqual({ key: "settingsIssue.timestampPatternInvalid", values: { number: 2 } });
  });
});
