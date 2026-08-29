import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { PendingImportReviewItem } from "@shared/app-shell";

// app-runtime imports electron at module load; stub it so the module's exported
// pure helpers can be exercised under the node test environment. The helpers
// under test never touch electron.
vi.mock("electron", () => ({
  app: {
    getName: () => "Mumbler Test",
    getVersion: () => "9.9.9-test",
    getPath: () => "/tmp",
    isPackaged: false,
  },
  BrowserWindow: class {},
  dialog: {},
  shell: {},
}));

// Runtime initialization should exercise the real storage and import boundaries,
// but managed ffmpeg/ffprobe maintenance is unrelated to dropped-path admission.
// Keep that independent boundary inert so this remains a local, deterministic
// main-process seam rather than a network or host-tool test.
vi.mock("@main/core/binaries/manager", () => ({
  ToolManager: class {
    async reconcile(): Promise<void> {}
    listStatuses(): [] {
      return [];
    }
    checkIsStale(): boolean {
      return false;
    }
    resolveToolPath(name: string): string {
      return `/unused/${name}`;
    }
  },
}));

const {
  ApplicationRuntime,
  applyPendingImportDraft,
  buildConfirmedTimestamps,
  applyFrontTrimOffset,
  resolveStorageRoot,
  getAppPaths,
} = await import("@main/core/app-runtime");

const { createStateStore } = await import("@main/core/settings-schema");

function authoritativeItem(): PendingImportReviewItem {
  return {
    id: "import-1",
    originalFilename: "rec.m4a",
    importSource: "drag-and-drop",
    originalSourcePath: "/Users/me/Downloads/rec.m4a",
    workingFilePath: "/Users/me/.mumbler/working/rec.m4a",
    fileSizeBytes: 12345,
    localTimestampText: "",
    timezone: "Asia/Tokyo",
    utcTimestampText: "",
    parseStatus: "manual-required",
    deleteOriginalOnConfirm: false,
    copyToBackupOnConfirm: true,
    createdAtUtc: 1_700_000_000_000,
    updatedAtUtc: 1_700_000_000_000,
  };
}

describe("applyPendingImportDraft", () => {
  it("applies only the review-editable fields and never the renderer's paths/identity", () => {
    const authoritative = authoritativeItem();
    // A draft that, besides the legitimate edits, tries to repoint the main
    // process at attacker-chosen paths and rewrite server-established identity.
    const malicious: PendingImportReviewItem = {
      ...authoritative,
      originalSourcePath: "/Users/me/.ssh/id_rsa",
      workingFilePath: "/etc/passwd",
      fileSizeBytes: 0,
      originalFilename: "evil.m4a",
      importSource: "file-picker",
      parseStatus: "parsed",
      createdAtUtc: 0,
      // Legitimate edits the review screen is allowed to make:
      localTimestampText: "2026-04-22 09:44:00",
      timezone: "America/New_York",
      utcTimestampText: "2026-04-22 13:44:00",
      deleteOriginalOnConfirm: true,
      copyToBackupOnConfirm: false,
    };

    const result = applyPendingImportDraft(authoritative, malicious);

    // Server-established fields are kept from the authoritative item.
    expect(result.originalSourcePath).toBe(authoritative.originalSourcePath);
    expect(result.workingFilePath).toBe(authoritative.workingFilePath);
    expect(result.fileSizeBytes).toBe(authoritative.fileSizeBytes);
    expect(result.originalFilename).toBe(authoritative.originalFilename);
    expect(result.importSource).toBe(authoritative.importSource);
    expect(result.parseStatus).toBe(authoritative.parseStatus);
    expect(result.id).toBe(authoritative.id);
    expect(result.createdAtUtc).toBe(authoritative.createdAtUtc);

    // Review-editable fields are taken from the draft.
    expect(result.localTimestampText).toBe("2026-04-22 09:44:00");
    expect(result.timezone).toBe("America/New_York");
    expect(result.utcTimestampText).toBe("2026-04-22 13:44:00");
    expect(result.deleteOriginalOnConfirm).toBe(true);
    expect(result.copyToBackupOnConfirm).toBe(false);
  });
});

describe("buildConfirmedTimestamps", () => {
  it("derives confirmed and effective timestamps from a local timestamp", () => {
    const result = buildConfirmedTimestamps("2026-04-22 09:44:00", "Asia/Tokyo", "");
    // 09:44 JST is 00:44 UTC.
    const expectedUtc = Date.UTC(2026, 3, 22, 0, 44, 0);
    expect(result.confirmedLocal).toBe("2026-04-22 09:44:00");
    expect(result.confirmedUtc).toBe(expectedUtc);
    expect(result.effectiveLocal).toBe("2026-04-22 09:44:00");
    expect(result.effectiveUtc).toBe(expectedUtc);
    expect(result.timezone).toBe("Asia/Tokyo");
    expect(result.frontTrimOffsetSec).toBe(0);
  });

  it("falls back to the UTC timestamp when the local field is empty", () => {
    const result = buildConfirmedTimestamps("", "Asia/Tokyo", "2026-04-22 00:44:00");
    expect(result.confirmedUtc).toBe(Date.UTC(2026, 3, 22, 0, 44, 0));
    expect(result.confirmedLocal.length).toBeGreaterThan(0);
    expect(result.timezone).toBe("Asia/Tokyo");
  });

  it("rejects an invalid timezone", () => {
    expect(() => buildConfirmedTimestamps("2026-04-22 09:44:00", "Not/AZone", "")).toThrow();
  });

  it("rejects when neither the local nor the UTC field is usable", () => {
    expect(() => buildConfirmedTimestamps("", "Asia/Tokyo", "")).toThrow();
  });
});

describe("applyFrontTrimOffset", () => {
  const base = buildConfirmedTimestamps("2026-04-22 09:44:00", "Asia/Tokyo", "");

  it("leaves the effective timestamp equal to confirmed for a zero offset", () => {
    const result = applyFrontTrimOffset(base, 0);
    expect(result.frontTrimOffsetSec).toBe(0);
    expect(result.effectiveLocal).toBe("2026-04-22 09:44:00");
  });

  it("shifts the effective local time by a whole-second offset with no fractional suffix", () => {
    const result = applyFrontTrimOffset(base, 5);
    expect(result.frontTrimOffsetSec).toBe(5);
    expect(result.effectiveLocal).toBe("2026-04-22 09:44:05");
  });

  it("appends a tenths suffix for a fractional offset", () => {
    const result = applyFrontTrimOffset(base, 0.5);
    expect(result.effectiveLocal).toBe("2026-04-22 09:44:00.5");
  });

  it("returns the timestamps unchanged when the confirmed local time is unparseable", () => {
    const broken = { ...base, confirmedLocal: "not a timestamp" };
    expect(applyFrontTrimOffset(broken, 5)).toBe(broken);
  });
});

// The MUMBLER_HOME storage-root resolution (storage-path-conventions). The home
// directory is injected so these are pure, working-directory-independent
// assertions that never touch the real environment or filesystem.
describe("resolveStorageRoot", () => {
  const ROOT = parse(process.cwd()).root;
  const HOME = join(ROOT, "Users", "test");
  const ABSOLUTE_OVERRIDE = join(ROOT, "data", "mumbler-profile");

  it("defaults to <home>/.mumbler when the override is unset", () => {
    expect(resolveStorageRoot(undefined, HOME)).toBe(join(HOME, ".mumbler"));
  });

  it("defaults to <home>/.mumbler when the override is empty or whitespace-only", () => {
    expect(resolveStorageRoot("", HOME)).toBe(join(HOME, ".mumbler"));
    expect(resolveStorageRoot("   ", HOME)).toBe(join(HOME, ".mumbler"));
  });

  it("relocates the root to a set absolute override", () => {
    expect(resolveStorageRoot(ABSOLUTE_OVERRIDE, HOME)).toBe(ABSOLUTE_OVERRIDE);
  });

  it("trims surrounding whitespace before using the override", () => {
    const override = join(ROOT, "data", "mumbler");
    expect(resolveStorageRoot(`  ${override}  `, HOME)).toBe(override);
  });

  it("expands a leading ~ against the home directory", () => {
    expect(resolveStorageRoot("~", HOME)).toBe(HOME);
    expect(resolveStorageRoot("~/elsewhere/mumbler", HOME)).toBe(join(HOME, "elsewhere", "mumbler"));
  });

  it("absolutizes a relative override against HOME, never the working directory", () => {
    expect(resolveStorageRoot("profiles/work", HOME)).toBe(join(HOME, "profiles", "work"));
  });

  it("expands $VAR / ${VAR} environment references in the override", () => {
    const previous = process.env.MUMBLER_TEST_ROOT;
    const environmentRoot = join(ROOT, "mnt", "disk2");
    process.env.MUMBLER_TEST_ROOT = environmentRoot;
    try {
      expect(resolveStorageRoot("$MUMBLER_TEST_ROOT/mumbler", HOME)).toBe(
        join(environmentRoot, "mumbler"),
      );
      expect(resolveStorageRoot("${MUMBLER_TEST_ROOT}/mumbler", HOME)).toBe(
        join(environmentRoot, "mumbler"),
      );
    } finally {
      if (previous === undefined) delete process.env.MUMBLER_TEST_ROOT;
      else process.env.MUMBLER_TEST_ROOT = previous;
    }
  });

  it("throws when a non-empty override expands to empty via an unset env reference, instead of collapsing to the bare home directory", () => {
    const previous = process.env.MUMBLER_UNSET_VAR;
    delete process.env.MUMBLER_UNSET_VAR;
    try {
      // A set-but-empty-expanding override (an unset $VAR / ${VAR}) is a
      // misconfiguration: it must be a reported startup error, never a silent
      // fallback to <home>/.mumbler. If the resolver collapsed to the bare home
      // directory instead of throwing, these toThrow() assertions would fail.
      expect(() => resolveStorageRoot("$MUMBLER_UNSET_VAR", HOME)).toThrow();
      expect(() => resolveStorageRoot("${MUMBLER_UNSET_VAR}", HOME)).toThrow();
    } finally {
      if (previous === undefined) delete process.env.MUMBLER_UNSET_VAR;
      else process.env.MUMBLER_UNSET_VAR = previous;
    }
  });
});

describe("getAppPaths standard layout", () => {
  // getAppPaths is the single source of truth for every stored-file name under the
  // storage root. These assertions pin the filename mapping so a rename of any
  // store cannot silently drift: durable user settings live in config.json, and
  // that file stays distinct from the volatile state.json and layout.json stores.
  const ROOT = join(parse(process.cwd()).root, "data", "mumbler-paths-test");

  function withRoot<T>(run: () => T): T {
    const previous = process.env.MUMBLER_HOME;
    process.env.MUMBLER_HOME = ROOT;
    try {
      return run();
    } finally {
      if (previous === undefined) delete process.env.MUMBLER_HOME;
      else process.env.MUMBLER_HOME = previous;
    }
  }

  it("resolves durable settings to config.json under the storage root", () => {
    const paths = withRoot(() => getAppPaths());
    expect(paths.homeDir).toBe(ROOT);
    expect(paths.settingsPath).toBe(join(ROOT, "config.json"));
  });

  it("keeps config.json separate from the state, layout, and secrets stores", () => {
    const paths = withRoot(() => getAppPaths());
    expect(paths.statePath).toBe(join(ROOT, "state.json"));
    expect(paths.layoutPath).toBe(join(ROOT, "layout.json"));
    expect(paths.apiKeysPath).toBe(join(ROOT, "api-keys.json"));

    // Distinct roles, distinct files: durable settings must never collide with the
    // volatile state, the self-healing layout, or the 0600 secrets file.
    const distinct = new Set([
      paths.settingsPath,
      paths.statePath,
      paths.layoutPath,
      paths.apiKeysPath,
    ]);
    expect(distinct.size).toBe(4);
    // The old name is fully retired — nothing resolves to settings.json.
    for (const p of distinct) {
      expect(p.endsWith("settings.json")).toBe(false);
    }
  });
});

describe("ApplicationRuntime dropped-path import authority", () => {
  it("accounts for complete batches and durably serializes overlapping deliveries", async () => {
    const root = await mkdtemp(join(tmpdir(), "mumbler-runtime-import-"));
    const sourceDir = join(root, "sources");
    const firstAudio = join(sourceDir, "first.wav");
    const secondAudio = join(sourceDir, "second.mp3");
    const unsupported = join(sourceDir, "notes.txt");
    const unavailable = join(sourceDir, "missing.wav");
    const previousRoot = process.env.MUMBLER_HOME;
    process.env.MUMBLER_HOME = join(root, "profile");

    await mkdir(sourceDir, { recursive: true });
    await Promise.all([
      writeFile(firstAudio, "first audio"),
      writeFile(secondAudio, "second audio"),
      writeFile(unsupported, "not audio"),
    ]);

    let runtime: Awaited<ReturnType<typeof ApplicationRuntime.initialize>> | null = null;
    try {
      runtime = await ApplicationRuntime.initialize();
      expect(runtime.getSnapshot().startupDiagnostic).toBeNull();

      const [mixed, overlapping] = await Promise.all([
        runtime.importDroppedPaths([firstAudio, firstAudio, "", unsupported, unavailable]),
        runtime.importDroppedPaths([secondAudio]),
      ]);

      expect(mixed.attemptedPaths).toEqual([
        firstAudio,
        firstAudio,
        "",
        unsupported,
        unavailable,
      ]);
      expect(mixed.importedCount).toBe(1);
      expect(mixed.duplicateImports).toEqual([firstAudio]);
      expect(mixed.failedImports).toEqual([
        {
          sourcePath: "Empty path",
          message: "No usable local file path was available.",
          kind: "invalid",
        },
        {
          sourcePath: unsupported,
          message: "Unsupported audio file type.",
          kind: "invalid",
        },
        expect.objectContaining({ sourcePath: unavailable, kind: "failure" }),
      ]);
      expect(overlapping.importedCount).toBe(1);
      expect(overlapping.failedImports).toEqual([]);

      const pending = runtime.getSnapshot().state?.pendingImports ?? [];
      expect(pending.map((item) => item.originalSourcePath)).toEqual([firstAudio, secondAudio]);
      expect(pending.every((item) => item.importSource === "drag-and-drop")).toBe(true);
      for (const item of pending) {
        expect((await stat(item.workingFilePath)).isFile()).toBe(true);
      }

      const persisted = await createStateStore(join(process.env.MUMBLER_HOME, "state.json")).load();
      expect(persisted.value.pendingImports.map((item) => item.originalSourcePath)).toEqual([
        firstAudio,
        secondAudio,
      ]);
    } finally {
      await runtime?.shutdown();
      if (previousRoot === undefined) delete process.env.MUMBLER_HOME;
      else process.env.MUMBLER_HOME = previousRoot;
      await rm(root, { force: true, recursive: true });
    }
  });
});
