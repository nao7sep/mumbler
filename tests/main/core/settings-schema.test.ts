import { describe, expect, it } from "vitest";

import { isValidTimezone } from "@shared/timestamps";
import {
  applySettingsDraft,
  buildSettingsDraft,
  createDefaultSettings,
  getSystemTimezone,
  summarizeSettings,
} from "@main/core/settings-schema";

const OUT = "/home/user/.mumbler/output";
const BACKUP = "/home/user/.mumbler/backups";

function freshDraft() {
  return buildSettingsDraft(createDefaultSettings("Asia/Tokyo"), OUT, BACKUP, false);
}

describe("getSystemTimezone", () => {
  it("returns a supported IANA timezone", () => {
    expect(isValidTimezone(getSystemTimezone())).toBe(true);
  });
});

describe("applySettingsDraft — happy path", () => {
  it("round-trips a freshly built default draft back into equivalent settings", () => {
    const current = createDefaultSettings("Asia/Tokyo");
    const result = applySettingsDraft(current, buildSettingsDraft(current, OUT, BACKUP, false));
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

  it("defaults the UI font to blank and round-trips a trimmed custom value", () => {
    expect(createDefaultSettings("Asia/Tokyo").uiFontFamily).toBe("");

    const draft = freshDraft();
    draft.uiFontFamily = "  Iosevka, monospace  ";
    const result = applySettingsDraft(createDefaultSettings("Asia/Tokyo"), draft);
    expect(result.uiFontFamily).toBe("Iosevka, monospace");
    expect(buildSettingsDraft(result, OUT, BACKUP, false).uiFontFamily).toBe("Iosevka, monospace");
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

describe("Gemini API key is no longer a setting", () => {
  // The key moved to a dedicated 0600 secrets file resolved environment-first
  // (see api-keys.test.ts). The settings store/draft must not carry it at all, so
  // a key can never be persisted into settings.json via the JSON roundtrip.
  it("does not expose any key field on settings or the draft", () => {
    const settings = createDefaultSettings("Asia/Tokyo");
    const draft = buildSettingsDraft(settings, OUT, BACKUP, true);

    expect(settings).not.toHaveProperty("geminiApiKeyObfuscated");
    expect(draft).not.toHaveProperty("geminiApiKeyInput");
    expect(draft).not.toHaveProperty("clearGeminiApiKey");
    // The presence flag is passed in by the caller, not derived from settings.
    expect(draft.hasGeminiApiKey).toBe(true);
  });

  it("never writes a key field through applySettingsDraft", () => {
    const result = applySettingsDraft(createDefaultSettings("Asia/Tokyo"), freshDraft());
    expect(result).not.toHaveProperty("geminiApiKeyObfuscated");
  });
});

describe("summarizeSettings", () => {
  it("reports key presence from the caller-supplied flag and surfaces defaults", () => {
    const present = summarizeSettings(createDefaultSettings("Asia/Tokyo"), OUT, BACKUP, true);
    expect(present.hasGeminiApiKey).toBe(true);
    const absent = summarizeSettings(createDefaultSettings("Asia/Tokyo"), OUT, BACKUP, false);
    expect(absent.hasGeminiApiKey).toBe(false);
    expect(absent.defaultOutputDirectory).toBe(OUT);
    expect(absent.timestampPatternCount).toBe(1);
  });
});
