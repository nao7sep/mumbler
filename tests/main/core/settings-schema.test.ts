import { describe, expect, it } from "vitest";

import { isValidTimezone } from "@shared/timestamps";
import {
  applySettingsDraft,
  buildSettingsDraft,
  createDefaultSettings,
  decodeGeminiApiKey,
  getSystemTimezone,
  summarizeSettings,
} from "@main/core/settings-schema";

const OUT = "/home/user/.mumbler/output";
const BACKUP = "/home/user/.mumbler/backups";

function freshDraft() {
  return buildSettingsDraft(createDefaultSettings("Asia/Tokyo"), OUT, BACKUP);
}

describe("getSystemTimezone", () => {
  it("returns a supported IANA timezone", () => {
    expect(isValidTimezone(getSystemTimezone())).toBe(true);
  });
});

describe("applySettingsDraft — happy path", () => {
  it("round-trips a freshly built default draft back into equivalent settings", () => {
    const current = createDefaultSettings("Asia/Tokyo");
    const result = applySettingsDraft(current, buildSettingsDraft(current, OUT, BACKUP));
    expect(result).toEqual(current);
  });

  it("trims directories to null when blank and parses pattern text", () => {
    const draft = freshDraft();
    draft.outputDirectory = "   ";
    draft.backupDirectory = "/custom/backups";
    draft.timestampPatternsText = "  pat-a  \n pat-b \n pat-a ";
    const result = applySettingsDraft(createDefaultSettings("Asia/Tokyo"), draft);
    expect(result.outputDirectory).toBeNull();
    expect(result.backupDirectory).toBe("/custom/backups");
    expect(result.timestampPatterns).toEqual(["pat-a", "pat-b"]); // trimmed + de-duplicated
  });
});

describe("applySettingsDraft — validation", () => {
  it("rejects an unsupported timezone", () => {
    const draft = freshDraft();
    draft.defaultTimezone = "Mars/Olympus";
    expect(() => applySettingsDraft(createDefaultSettings("Asia/Tokyo"), draft)).toThrow(/timezone/i);
  });

  it("rejects an empty set of timestamp patterns", () => {
    const draft = freshDraft();
    draft.timestampPatternsText = "   \n  ";
    expect(() => applySettingsDraft(createDefaultSettings("Asia/Tokyo"), draft)).toThrow(/pattern/i);
  });

  it("requires the {transcript} placeholder in the structured prompt", () => {
    const draft = freshDraft();
    draft.structuredPrompt = "no placeholder here";
    expect(() => applySettingsDraft(createDefaultSettings("Asia/Tokyo"), draft)).toThrow(/transcript/i);
  });

  it("requires the title prompt to reference transcript or structured", () => {
    const draft = freshDraft();
    draft.titlePrompt = "summarize please";
    expect(() => applySettingsDraft(createDefaultSettings("Asia/Tokyo"), draft)).toThrow(/Title prompt/i);
  });

  it("requires the {title} placeholder in the slug prompt", () => {
    const draft = freshDraft();
    draft.slugPrompt = "make a slug";
    expect(() => applySettingsDraft(createDefaultSettings("Asia/Tokyo"), draft)).toThrow(/title/i);
  });

  it("rejects a max retry delay below the initial delay", () => {
    const draft = freshDraft();
    draft.retryInitialDelayMs = 5000;
    draft.retryMaxDelayMs = 1000;
    expect(() => applySettingsDraft(createDefaultSettings("Asia/Tokyo"), draft)).toThrow(/max delay/i);
  });

  it("rejects non-positive integer fields", () => {
    const draft = freshDraft();
    draft.concurrencyLimit = 0;
    expect(() => applySettingsDraft(createDefaultSettings("Asia/Tokyo"), draft)).toThrow(/Concurrency/i);
  });

  it("rejects a jitter ratio outside 0..1", () => {
    const draft = freshDraft();
    draft.retryJitterRatio = 1.5;
    expect(() => applySettingsDraft(createDefaultSettings("Asia/Tokyo"), draft)).toThrow(/jitter/i);
  });
});

describe("Gemini API key handling", () => {
  it("decodes an empty obfuscated value to an empty string", () => {
    expect(decodeGeminiApiKey("")).toBe("");
  });

  it("stores a new key obfuscated and decodes it back", () => {
    const draft = freshDraft();
    draft.geminiApiKeyInput = "  AIzaSecretKey123  ";
    const result = applySettingsDraft(createDefaultSettings("Asia/Tokyo"), draft);
    expect(result.geminiApiKeyObfuscated).not.toBe("");
    expect(result.geminiApiKeyObfuscated).not.toContain("AIzaSecretKey123");
    expect(decodeGeminiApiKey(result.geminiApiKeyObfuscated)).toBe("AIzaSecretKey123");
  });

  it("clears the key when requested", () => {
    const current = createDefaultSettings("Asia/Tokyo");
    const draft = buildSettingsDraft(current, OUT, BACKUP);
    draft.geminiApiKeyInput = "AIzaSecretKey123";
    const withKey = applySettingsDraft(current, draft);

    const clearDraft = buildSettingsDraft(withKey, OUT, BACKUP);
    clearDraft.clearGeminiApiKey = true;
    const cleared = applySettingsDraft(withKey, clearDraft);
    expect(cleared.geminiApiKeyObfuscated).toBe("");
  });

  it("rejects supplying a new key and clearing at the same time", () => {
    const draft = freshDraft();
    draft.geminiApiKeyInput = "newkey";
    draft.clearGeminiApiKey = true;
    expect(() => applySettingsDraft(createDefaultSettings("Asia/Tokyo"), draft)).toThrow(/clear/i);
  });

});

describe("summarizeSettings", () => {
  it("reports key presence as a boolean and surfaces defaults", () => {
    const summary = summarizeSettings(createDefaultSettings("Asia/Tokyo"), OUT, BACKUP);
    expect(summary.hasGeminiApiKey).toBe(false);
    expect(summary.defaultOutputDirectory).toBe(OUT);
    expect(summary.timestampPatternCount).toBe(1);
  });
});
