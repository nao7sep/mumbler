import { afterEach, describe, expect, it, vi } from "vitest";

// The backup-isolation setup imports the native resolver before this file.
vi.hoisted(() => vi.resetModules());

// Exercise the application's path decisions with Node's real Windows parser on
// every host. This proves path selection, not Windows filesystem permissions or
// availability; no I/O uses these synthetic drive and UNC paths.
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, join: actual.win32.join, resolve: actual.win32.resolve, isAbsolute: actual.win32.isAbsolute };
});

import { resolvePathFromHome, resolveStorageRoot } from "@main/core/storage-root";
import { applySettingsDraft, buildSettingsDraft, createDefaultSettings } from "@main/core/settings-schema";

const HOME = "D:\\Users\\Example User";

afterEach(() => vi.unstubAllEnvs());

describe("Windows storage and output path selection", () => {
  it.each([
    ["\\exports", "D:\\exports"],
    ["/exports", "D:\\exports"],
    ["recordings\\exports", "D:\\Users\\Example User\\recordings\\exports"],
    ["~\\recordings", "D:\\Users\\Example User\\recordings"],
    ["~/recordings", "D:\\Users\\Example User\\recordings"],
    ["~", HOME],
    ["E:\\音声\\Exports", "E:\\音声\\Exports"],
    ["\\\\server\\share\\Recordings", "\\\\server\\share\\Recordings"],
  ])("resolves %s consistently for the app root and chosen destinations", (input, expected) => {
    expect(resolvePathFromHome(input, HOME)).toBe(expected);
    expect(resolveStorageRoot(input, HOME)).toBe(expected);
    const settings = createDefaultSettings();
    const draft = buildSettingsDraft(settings, "", "", false);
    draft.outputDirectory = input;
    draft.backupDirectory = input;
    expect(applySettingsDraft(settings, draft, HOME)).toMatchObject({
      outputDirectory: expected,
      backupDirectory: expected,
    });
  });

  it.each([undefined, "", "   "])("uses the home folder for an unset app-root override (%s)", (input) => {
    expect(resolveStorageRoot(input, HOME)).toBe(`${HOME}\\.mumbler`);
  });

  it("expands a percent-style environment variable containing spaces", () => {
    vi.stubEnv("MUMBLER_TEST_WINDOWS_PATH", "E:\\Saved Audio");
    expect(resolveStorageRoot("%MUMBLER_TEST_WINDOWS_PATH%\\Mumbler", HOME))
      .toBe("E:\\Saved Audio\\Mumbler");
  });

  it("refuses an unset percent-style variable instead of silently choosing a drive root", () => {
    vi.stubEnv("MUMBLER_TEST_WINDOWS_PATH", undefined);
    expect(() => resolveStorageRoot("%MUMBLER_TEST_WINDOWS_PATH%\\Mumbler", HOME))
      .toThrow("unset environment variable");
    const settings = createDefaultSettings();
    const draft = buildSettingsDraft(settings, "", "", false);
    draft.outputDirectory = "%MUMBLER_TEST_WINDOWS_PATH%\\Exports";
    expect(() => applySettingsDraft(settings, draft, HOME)).toThrow("unset environment variable");
  });

  it("retains an unchosen destination rather than turning it into the home directory", () => {
    const settings = createDefaultSettings();
    const draft = buildSettingsDraft(settings, "", "", false);
    draft.outputDirectory = "  ";
    draft.backupDirectory = "";
    expect(applySettingsDraft(settings, draft, HOME)).toMatchObject({
      outputDirectory: null,
      backupDirectory: null,
    });
  });

  it.each(["$MUMBLER_TEST_WINDOWS_PATH", "%MUMBLER_TEST_WINDOWS_PATH%"])("keeps picked and reopened Windows paths with a literal %s segment", (segment) => {
    vi.stubEnv("MUMBLER_TEST_WINDOWS_PATH", "redirected");
    const selected = `${HOME}\\${segment}\\Recordings`;
    const settings = { ...createDefaultSettings(), outputDirectory: selected, backupDirectory: selected };
    const reopened = buildSettingsDraft(settings, "", "", false);
    expect(applySettingsDraft(settings, reopened, HOME)).toMatchObject({
      outputDirectory: selected, backupDirectory: selected,
    });
    const picked = { ...buildSettingsDraft(createDefaultSettings(), "", "", false),
      outputDirectory: selected, literalOutputDirectory: selected,
      backupDirectory: selected, literalBackupDirectory: selected,
    };
    expect(applySettingsDraft(createDefaultSettings(), picked, HOME)).toMatchObject({
      outputDirectory: selected, backupDirectory: selected,
    });
    picked.outputDirectory = "%MUMBLER_TEST_WINDOWS_PATH%\\edited";
    expect(applySettingsDraft(createDefaultSettings(), picked, HOME).outputDirectory)
      .toBe(`${HOME}\\redirected\\edited`);
  });
});
