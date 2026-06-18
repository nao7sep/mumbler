import { describe, expect, it } from "vitest";

import type { SettingsDraft } from "@shared/app-shell";
import {
  getSettingsNumberErrors,
  isPositiveIntegerSetting,
  isRatioSetting,
} from "@shared/settings-validation";

function validDraft(): SettingsDraft {
  return {
    schemaVersion: 1,
    outputDirectory: "",
    defaultOutputDirectory: "/out",
    backupDirectory: "",
    defaultBackupDirectory: "/backup",
    defaultTimezone: "Asia/Tokyo",
    timestampPatternsText: "",
    skipIntervalSec: 10,
    previewSnippetSeconds: 10,
    hasGeminiApiKey: false,
    transcriptionModel: "gemini-3-flash",
    metadataModel: "gemini-3-flash",
    concurrencyLimit: 3,
    structuredPrompt: "{transcript}",
    titlePrompt: "{transcript}",
    slugPrompt: "{title}",
    retryMaxRetries: 3,
    retryInitialDelayMs: 500,
    retryMaxDelayMs: 5000,
    retryJitterRatio: 0.2,
    transcriptionTimeoutMs: 60000,
    metadataTimeoutMs: 30000,
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

describe("isRatioSetting", () => {
  it("accepts the inclusive 0..1 range", () => {
    expect(isRatioSetting(0)).toBe(true);
    expect(isRatioSetting(0.2)).toBe(true);
    expect(isRatioSetting(1)).toBe(true);
  });

  it("rejects values outside 0..1 and non-finite values", () => {
    expect(isRatioSetting(-0.1)).toBe(false);
    expect(isRatioSetting(1.5)).toBe(false);
    expect(isRatioSetting(Number.NaN)).toBe(false);
  });
});

describe("getSettingsNumberErrors", () => {
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
    draft.transcriptionTimeoutMs = 1500.5;
    expect(getSettingsNumberErrors(draft)).toEqual([
      "Transcription timeout must be a positive integer.",
    ]);
  });

  it("flags an out-of-range jitter ratio", () => {
    const draft = validDraft();
    draft.retryJitterRatio = 7;
    expect(getSettingsNumberErrors(draft)).toEqual([
      "Retry jitter must be between 0 and 1.",
    ]);
  });

  it("reports every invalid field in form order", () => {
    const draft = validDraft();
    draft.skipIntervalSec = 0;
    draft.retryJitterRatio = 2;
    draft.metadataTimeoutMs = Number.NaN;
    expect(getSettingsNumberErrors(draft)).toEqual([
      "Skip interval must be a positive integer.",
      "Metadata generation timeout must be a positive integer.",
      "Retry jitter must be between 0 and 1.",
    ]);
  });
});
