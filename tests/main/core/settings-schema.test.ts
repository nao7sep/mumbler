import { describe, expect, it } from "vitest";
import { join, parse } from "node:path";

import { getSystemTimezone, isValidTimezone } from "@shared/timestamps";
import {
  applySettingsDraft,
  buildSettingsDraft,
  createDefaultSettings,
  summarizeSettings,
} from "@main/core/settings-schema";
import { multiline } from "@main/core/text-cleanup";

const OUT = "/home/user/.mumbler/output";
const BACKUP = "/home/user/.mumbler/backups";
const TEST_HOME = join(parse(process.cwd()).root, "Users", "test");

function freshDraft() {
  return buildSettingsDraft(createDefaultSettings(), OUT, BACKUP, false);
}

describe("getSystemTimezone", () => {
  it("returns a supported IANA timezone", () => {
    expect(isValidTimezone(getSystemTimezone())).toBe(true);
  });
});

describe("time zone and language defaults", () => {
  it("follows the computer's zone and language instead of recording them", () => {
    const defaults = createDefaultSettings();
    expect(defaults.defaultTimezone).toBe("system");
    expect(defaults.language).toBe("system");
    expect(summarizeSettings(defaults, OUT, BACKUP, false).defaultTimezone).toBe(getSystemTimezone());
    expect(freshDraft()).toMatchObject({ defaultTimezone: "system", language: "system" });
  });

  it("keeps a chosen zone and language, and System, through Save", () => {
    const chosen = applySettingsDraft(createDefaultSettings(), { ...freshDraft(), defaultTimezone: "Europe/Berlin", language: "ja" });
    expect(chosen).toMatchObject({ defaultTimezone: "Europe/Berlin", language: "ja" });
    expect(summarizeSettings(chosen, OUT, BACKUP, false).defaultTimezone).toBe("Europe/Berlin");
    const system = applySettingsDraft(chosen, { ...freshDraft(), defaultTimezone: "system", language: "system" });
    expect(system).toMatchObject({ defaultTimezone: "system", language: "system" });
  });

  it("treats an unknown saved language as System", () => {
    const result = applySettingsDraft(createDefaultSettings(), { ...freshDraft(), language: "xx" as never });
    expect(result.language).toBe("system");
  });
});

describe("applySettingsDraft — happy path", () => {
  it("round-trips a freshly built default draft back into equivalent settings", () => {
    const current = createDefaultSettings();
    const result = applySettingsDraft(current, buildSettingsDraft(current, OUT, BACKUP, false));
    expect(result).toEqual(current);
  });

  it("keeps the built-in prompts in their cleaned form", () => {
    for (const prompt of Object.values(createDefaultSettings().prompts)) expect(prompt).toBe(multiline(prompt));
  });

  it("leaves the title and slug answer's format to its strict schema and states only the value's rules", () => {
    const { title, slug } = createDefaultSettings().prompts;
    for (const prompt of [title, slug]) {
      expect(prompt).not.toMatch(/output only|reply with|json/i);
    }
    expect(title).toContain("in the source's language");
    expect(slug).toContain("Lowercase a–z, digits, and hyphens only");
  });

  it("cleans prompts as multiline bodies and scalars as single lines", () => {
    const defaults = createDefaultSettings();
    const result = applySettingsDraft(defaults, {
      ...freshDraft(),
      structuredPrompt: `\r\n${defaults.prompts.structured.replaceAll("\n", "  \r\n")}  \r\n`,
      uiFontFamily: "  Iosevka,\r\n  monospace  ",
    });
    expect(result.prompts).toEqual(defaults.prompts);
    expect(result.uiFontFamily).toBe("Iosevka, monospace");
  });

  it("trims directories to null when blank and cleans the timestamp pattern as a single line", () => {
    const draft = freshDraft();
    draft.outputDirectory = "   ";
    draft.backupDirectory = join(TEST_HOME, "custom", "backups");
    draft.timestampPattern = "  (?<year>\\d{4})|(?<year>\\d{2})  ";
    const result = applySettingsDraft(createDefaultSettings(), draft, TEST_HOME);
    expect(result.outputDirectory).toBeNull();
    expect(result.backupDirectory).toBe(join(TEST_HOME, "custom", "backups"));
    expect(result.timestampPattern).toBe("(?<year>\\d{4})|(?<year>\\d{2})");
  });

  it("expands and absolutizes typed directories against HOME, never cwd", () => {
    const previous = process.env.MUMBLER_TEST_OUTPUT;
    process.env.MUMBLER_TEST_OUTPUT = join(TEST_HOME, "external");
    try {
      const draft = freshDraft();
      draft.outputDirectory = "$MUMBLER_TEST_OUTPUT/exports";
      draft.backupDirectory = "relative/backups";
      const result = applySettingsDraft(createDefaultSettings(), draft, TEST_HOME);
      expect(result.outputDirectory).toBe(join(TEST_HOME, "external", "exports"));
      expect(result.backupDirectory).toBe(join(TEST_HOME, "relative", "backups"));

      draft.outputDirectory = "~/handled-audio";
      expect(
        applySettingsDraft(createDefaultSettings(), draft, TEST_HOME)
          .outputDirectory,
      ).toBe(join(TEST_HOME, "handled-audio"));
    } finally {
      if (previous === undefined) delete process.env.MUMBLER_TEST_OUTPUT;
      else process.env.MUMBLER_TEST_OUTPUT = previous;
    }
  });

  const windowsIt = process.platform === "win32" ? it : it.skip;
  windowsIt("resolves a root-relative Windows directory on the HOME drive", () => {
    const cwdDrive = parse(process.cwd()).root.toLowerCase();
    const homeDrive = cwdDrive === "c:\\" ? "D:\\" : "C:\\";
    const home = join(homeDrive, "Users", "test");
    const draft = freshDraft();
    draft.outputDirectory = "\\handled-audio";

    const result = applySettingsDraft(createDefaultSettings(), draft, home);

    expect(result.outputDirectory).toBe(join(homeDrive, "handled-audio"));
  });

  it("defaults the UI font to blank and round-trips a trimmed custom value", () => {
    expect(createDefaultSettings().uiFontFamily).toBe("");

    const draft = freshDraft();
    draft.uiFontFamily = "  Iosevka, monospace  ";
    const result = applySettingsDraft(createDefaultSettings(), draft);
    expect(result.uiFontFamily).toBe("Iosevka, monospace");
    expect(buildSettingsDraft(result, OUT, BACKUP, false).uiFontFamily).toBe("Iosevka, monospace");
  });
});

describe("applySettingsDraft — theme", () => {
  it("starts on System and saves a chosen theme through the draft", () => {
    const current = createDefaultSettings();
    expect(current.theme).toBe("system");
    const draft = { ...buildSettingsDraft(current, OUT, BACKUP, false), theme: "dark" as const };
    const result = applySettingsDraft(current, draft);
    expect(result.theme).toBe("dark");
    expect(buildSettingsDraft(result, OUT, BACKUP, false).theme).toBe("dark");
  });

  it("rejects a theme that is not one of the three choices", () => {
    const current = createDefaultSettings();
    const draft = { ...buildSettingsDraft(current, OUT, BACKUP, false), theme: "sepia" } as never;
    expect(() => applySettingsDraft(current, draft)).toThrow(/Theme must be/);
  });
});

describe("applySettingsDraft — validation", () => {
  it("rejects an unset leading environment reference instead of targeting the drive root", () => {
    const variableName = "MUMBLER_TEST_UNSET_OUTPUT";
    const previous = process.env[variableName];
    delete process.env[variableName];
    try {
      const draft = freshDraft();
      draft.outputDirectory = `$${variableName}/handled-audio`;
      expect(() =>
        applySettingsDraft(createDefaultSettings(), draft, TEST_HOME),
      ).toThrow(/unset environment variable "MUMBLER_TEST_UNSET_OUTPUT"/i);
    } finally {
      if (previous === undefined) delete process.env[variableName];
      else process.env[variableName] = previous;
    }
  });

  it("rejects an unsupported timezone", () => {
    const draft = freshDraft();
    draft.defaultTimezone = "Mars/Olympus";
    expect(() => applySettingsDraft(createDefaultSettings(), draft)).toThrow(/timezone/i);
  });

  it("rejects an empty timestamp pattern", () => {
    const draft = freshDraft();
    draft.timestampPattern = "   ";
    expect(() => applySettingsDraft(createDefaultSettings(), draft)).toThrow("Timestamp pattern is required.");
  });

  it("rejects a timestamp pattern that is not a valid regular expression", () => {
    const draft = freshDraft();
    draft.timestampPattern = "(?<year>\\d{4}";
    expect(() => applySettingsDraft(createDefaultSettings(), draft)).toThrow("Timestamp pattern must be a valid regular expression.");
  });

  it("requires the {transcript} placeholder in the structured prompt", () => {
    const draft = freshDraft();
    draft.structuredPrompt = "no placeholder here";
    expect(() => applySettingsDraft(createDefaultSettings(), draft)).toThrow(/transcript/i);
  });

  it("requires the title prompt to reference transcript or structured", () => {
    const draft = freshDraft();
    draft.titlePrompt = "summarize please";
    expect(() => applySettingsDraft(createDefaultSettings(), draft)).toThrow(/Title prompt/i);
  });

  it("requires the {title} placeholder in the slug prompt", () => {
    const draft = freshDraft();
    draft.slugPrompt = "make a slug";
    expect(() => applySettingsDraft(createDefaultSettings(), draft)).toThrow(/title/i);
  });

  it("rejects a max retry delay below the initial delay", () => {
    const draft = freshDraft();
    draft.retryInitialDelayMs = 5000;
    draft.retryMaxDelayMs = 1000;
    expect(() => applySettingsDraft(createDefaultSettings(), draft)).toThrow(/max delay/i);
  });

  it("rejects non-positive integer fields", () => {
    const draft = freshDraft();
    draft.concurrencyLimit = 0;
    expect(() => applySettingsDraft(createDefaultSettings(), draft)).toThrow(/Concurrency/i);
  });

  it("rejects a jitter ratio outside 0..1", () => {
    const draft = freshDraft();
    draft.retryJitterRatio = 1.5;
    expect(() => applySettingsDraft(createDefaultSettings(), draft)).toThrow(/jitter/i);
  });
});

describe("Gemini model fields", () => {
  it("holds each role's default model", () => {
    const settings = createDefaultSettings();
    expect(settings["gemini.transcription"]).toBe("gemini-3.8-flash");
    expect(settings["gemini.outline"]).toBe("gemini-3.8-flash");
    expect(settings["gemini.metadata"]).toBe("gemini-3.5-flash-lite");
  });

  it("keeps a typed id that has no supported row", () => {
    const draft = freshDraft();
    draft.transcriptionModel = "gemini-2.5-pro";
    expect(applySettingsDraft(createDefaultSettings(), draft)["gemini.transcription"]).toBe("gemini-2.5-pro");
  });
});

describe("Gemini API key is no longer a setting", () => {
  // The key moved to a dedicated 0600 secrets file resolved environment-first
  // (see api-keys.test.ts). The settings store/draft must not carry it at all, so
  // a key can never be persisted into config.json via the JSON roundtrip.
  it("does not expose any key field on settings or the draft", () => {
    const settings = createDefaultSettings();
    const draft = buildSettingsDraft(settings, OUT, BACKUP, true);

    expect(settings).not.toHaveProperty("geminiApiKeyObfuscated");
    expect(draft).not.toHaveProperty("geminiApiKeyInput");
    expect(draft).not.toHaveProperty("clearGeminiApiKey");
    // The presence flag is passed in by the caller, not derived from settings.
    expect(draft.hasGeminiApiKey).toBe(true);
  });

  it("never writes a key field through applySettingsDraft", () => {
    const result = applySettingsDraft(createDefaultSettings(), freshDraft());
    expect(result).not.toHaveProperty("geminiApiKeyObfuscated");
  });
});

describe("summarizeSettings", () => {
  it("reports key presence from the caller-supplied flag and surfaces defaults", () => {
    const present = summarizeSettings(createDefaultSettings(), OUT, BACKUP, true);
    expect(present.hasGeminiApiKey).toBe(true);
    const absent = summarizeSettings(createDefaultSettings(), OUT, BACKUP, false);
    expect(absent.hasGeminiApiKey).toBe(false);
    expect(absent.defaultOutputDirectory).toBe(OUT);
  });
});
