import { createTranslator } from "@shared/i18n/translate";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { PipelineCoordinator } from "@main/core/pipeline-coordinator";

import type { MumblerCard, PendingImportReviewItem } from "@shared/app-shell";

// app-runtime imports electron at module load; stub it so the module's exported
// pure helpers can be exercised under the node test environment. The helpers
// under test never touch electron.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

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
    launchCheckDue(): boolean {
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
  resetFailureDiagnostic,
} = await import("@main/core/app-runtime");

const { createQueueStore, QueueStore } = await import("@main/core/settings-schema");
const { TranscriptStore } = await import("@main/core/transcript-store");
const { JsonStore } = await import("@main/core/json-store");
const workingFiles = await import("@main/core/working-files");
const audioTools = await import("@main/core/audio-tools");
const cardPipeline = await import("@main/core/card-pipeline");

describe("reset failure presentation", () => {
  it("says existing files were left unchanged when the reset moved nothing", () => {
    const presentation = resetFailureDiagnostic([], "/home/me/.mumbler");

    const english = createTranslator("en");
    expect(english.text(presentation.title)).toBe("Reset Failed");
    expect(english.text(presentation.message)).toContain("Existing files were left unchanged");
  });

  it("names what a reset set aside before it failed, instead of claiming nothing changed", () => {
    const presentation = resetFailureDiagnostic(["config.json", "queue.json", "transcripts"], "/home/me/.mumbler");

    const text = createTranslator("en").text(presentation.message);
    expect(text).toContain("it set these aside in /home/me/.mumbler");
    expect(text).toContain("config.json, queue.json, transcripts.");
    expect(text).not.toContain("unchanged");
  });
});

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

  it("returns the stored item, its updated time kept, when the draft changes nothing", () => {
    const authoritative = authoritativeItem();
    // Only fields the review cannot edit differ, so nothing the user made changed.
    const result = applyPendingImportDraft(authoritative, { ...authoritative, workingFilePath: "/elsewhere" });

    expect(result).toBe(authoritative);
    expect(result.updatedAtUtc).toBe(1_700_000_000_000);
  });

  it("moves the updated time to the moment of the edit when the recording's time changes", () => {
    const authoritative = authoritativeItem();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      const result = applyPendingImportDraft(authoritative, { ...authoritative, timezone: "Europe/Berlin" });

      expect(result.timezone).toBe("Europe/Berlin");
      expect(result.updatedAtUtc).toBe(1_800_000_000_000);
      expect(result.createdAtUtc).toBe(1_700_000_000_000);
    } finally {
      now.mockRestore();
    }
  });

  it("keeps the updated time when only the backup or delete choice changes, which are not content", () => {
    const authoritative = authoritativeItem();

    const result = applyPendingImportDraft(authoritative, {
      ...authoritative,
      copyToBackupOnConfirm: !authoritative.copyToBackupOnConfirm,
      deleteOriginalOnConfirm: !authoritative.deleteOriginalOnConfirm,
    });

    expect(result).not.toBe(authoritative);
    expect(result.copyToBackupOnConfirm).toBe(!authoritative.copyToBackupOnConfirm);
    expect(result.deleteOriginalOnConfirm).toBe(!authoritative.deleteOriginalOnConfirm);
    expect(result.updatedAtUtc).toBe(1_700_000_000_000);
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

  it("moves the instant by a fractional offset exactly and appends its tenths to the local time", () => {
    const result = applyFrontTrimOffset(base, 0.5);
    expect(result.effectiveUtc).toBe(base.confirmedUtc + 500);
    expect(result.effectiveLocal).toBe("2026-04-22 09:44:00.5");
  });

  it("moves the recorded instant by the trim across a daylight-saving change", () => {
    const beforeChange = buildConfirmedTimestamps("2026-03-08 01:59:50", "America/New_York", "");

    const result = applyFrontTrimOffset(beforeChange, 3620);

    expect(result.effectiveUtc).toBe(Date.UTC(2026, 2, 8, 8, 0, 10));
    expect(result.effectiveLocal).toBe("2026-03-08 04:00:10");
  });

  it("returns the timestamps unchanged when the card's zone is not one", () => {
    const broken = { ...base, timezone: "Not/AZone" };
    expect(applyFrontTrimOffset(broken, 5)).toBe(broken);
  });
});

// The MUMBLER_DATA_DIR storage-root resolution (storage-path-conventions). The home
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
  // that file stays distinct from durable queue data and volatile layout.json.
  const ROOT = join(parse(process.cwd()).root, "data", "mumbler-paths-test");

  function withRoot<T>(run: () => T): T {
    const previous = process.env.MUMBLER_DATA_DIR;
    process.env.MUMBLER_DATA_DIR = ROOT;
    try {
      return run();
    } finally {
      if (previous === undefined) delete process.env.MUMBLER_DATA_DIR;
      else process.env.MUMBLER_DATA_DIR = previous;
    }
  }

  it("resolves durable settings to config.json under the storage root", () => {
    const paths = withRoot(() => getAppPaths());
    expect(paths.homeDir).toBe(ROOT);
    expect(paths.settingsPath).toBe(join(ROOT, "config.json"));
  });

  it("keeps config.json separate from the queue, layout, and secrets stores", () => {
    const paths = withRoot(() => getAppPaths());
    expect(paths.queuePath).toBe(join(ROOT, "queue.json"));
    expect(paths.layoutPath).toBe(join(ROOT, "layout.json"));
    expect(paths.apiKeysPath).toBe(join(ROOT, "api-keys.json"));

    // Distinct roles, distinct files: durable settings must never collide with the
    // durable queue, the self-healing layout, or the 0600 secrets file.
    const distinct = new Set([
      paths.settingsPath,
      paths.queuePath,
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
    const previousRoot = process.env.MUMBLER_DATA_DIR;
    process.env.MUMBLER_DATA_DIR = join(root, "profile");

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
          sourcePath: "",
          message: { key: "import.noLocalPath" },
          kind: "invalid",
        },
        {
          sourcePath: unsupported,
          message: { key: "import.unsupportedType" },
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

      const persisted = await createQueueStore(join(process.env.MUMBLER_DATA_DIR, "queue.json")).load();
      expect(persisted.value.pendingImports.map((item) => item.originalSourcePath)).toEqual([
        firstAudio,
        secondAudio,
      ]);
    } finally {
      await runtime?.shutdown();
      if (previousRoot === undefined) delete process.env.MUMBLER_DATA_DIR;
      else process.env.MUMBLER_DATA_DIR = previousRoot;
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("ApplicationRuntime confirmed import commit", () => {
  async function withImport(
    run: (runtime: Awaited<ReturnType<typeof ApplicationRuntime.initialize>>, item: PendingImportReviewItem, queuePath: string) => Promise<void>,
  ): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "mumbler-confirm-import-"));
    const previousRoot = process.env.MUMBLER_DATA_DIR;
    process.env.MUMBLER_DATA_DIR = join(root, "profile");
    let runtime: Awaited<ReturnType<typeof ApplicationRuntime.initialize>> | null = null;
    try {
      const original = join(root, "recording.wav");
      await writeFile(original, "original recording");
      runtime = await ApplicationRuntime.initialize();
      expect(runtime.getSnapshot().startupDiagnostic).toBeNull();
      await runtime.importDroppedPaths([original]);
      const pending = runtime.getSnapshot().state!.pendingImports[0];
      vi.spyOn(audioTools, "probeAudioProfile").mockResolvedValue({ durationSec: null, audioProfile: null });
      await run(runtime, {
        ...pending,
        localTimestampText: "2026-04-22 09:44:00",
        timezone: "Asia/Tokyo",
        deleteOriginalOnConfirm: true,
        copyToBackupOnConfirm: false,
      }, getAppPaths().queuePath);
    } finally {
      vi.restoreAllMocks();
      try {
        await runtime?.shutdown();
      } finally {
        if (previousRoot === undefined) delete process.env.MUMBLER_DATA_DIR;
        else process.env.MUMBLER_DATA_DIR = previousRoot;
        await rm(root, { force: true, recursive: true });
      }
    }
  }

  // Exercise the actual persistence owner without involving providers or output publication.
  function persistence(runtime: Awaited<ReturnType<typeof ApplicationRuntime.initialize>>): {
    persistState(): Promise<void>;
    queueBehind: boolean;
  } {
    return runtime as unknown as { persistState(): Promise<void>; queueBehind: boolean };
  }

  function gate(): { promise: Promise<void>; release(): void } {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  }

  async function withCard(
    run: (runtime: Awaited<ReturnType<typeof ApplicationRuntime.initialize>>, card: MumblerCard, queuePath: string) => Promise<void>,
  ): Promise<void> {
    await withImport(async (runtime, item, queuePath) => {
      const result = await runtime.confirmPendingImports([{ ...item, deleteOriginalOnConfirm: false }]);
      await run(runtime, result.snapshot.state!.cards[0], queuePath);
    });
  }

  it("publishes the confirmed queue before deleting the original source", async () => {
    await withImport(async (runtime, item, queuePath) => {
      const deleteSource = workingFiles.deleteImportedSource;
      const deletion = vi.spyOn(workingFiles, "deleteImportedSource").mockImplementation(async (file) => {
        const committed = (await createQueueStore(queuePath).load()).value;
        expect(committed.pendingImports).toEqual([]);
        expect(committed.cards).toHaveLength(1);
        expect(committed.cards[0].sourceFilePath).toBe(item.workingFilePath);
        expect(await readFile(file, "utf8")).toBe("original recording");
        await deleteSource(file);
      });

      const result = await runtime.confirmPendingImports([item]);

      expect(result.originalWarnings).toEqual([]);
      expect(result.snapshot.state!.cards).toHaveLength(1);
      expect(deletion).toHaveBeenCalledOnce();
      await expect(stat(item.originalSourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(item.workingFilePath, "utf8")).toBe("original recording");
    });
  });

  it("retains the original and durable pending import when queue publication fails", async () => {
    await withImport(async (runtime, item, queuePath) => {
      const saveFailure = new Error("queue publication failed");
      vi.spyOn(QueueStore.prototype, "save").mockRejectedValueOnce(saveFailure);
      const deletion = vi.spyOn(workingFiles, "deleteImportedSource");

      await expect(runtime.confirmPendingImports([item])).rejects.toBe(saveFailure);

      expect(deletion).not.toHaveBeenCalled();
      expect(await readFile(item.originalSourcePath, "utf8")).toBe("original recording");
      const persisted = (await createQueueStore(queuePath).load()).value;
      expect(persisted.cards).toEqual([]);
      expect(persisted.pendingImports.map((pending) => pending.id)).toEqual([item.id]);
    });
  });

  it("returns a warning on the committed import when original deletion fails", async () => {
    await withImport(async (runtime, item, queuePath) => {
      vi.spyOn(workingFiles, "deleteImportedSource").mockRejectedValueOnce(new Error("deletion failed"));

      const result = await runtime.confirmPendingImports([item]);

      expect(result.originalWarnings).toEqual([{
        sourcePath: item.originalSourcePath,
        message: { key: "import.deleteFailed", values: { file: item.originalSourcePath } },
      }]);
      expect(result.snapshot.state!.cards).toHaveLength(1);
      const persisted = (await createQueueStore(queuePath).load()).value;
      expect(persisted.pendingImports).toEqual([]);
      expect(persisted.cards).toHaveLength(1);
      expect(await readFile(item.originalSourcePath, "utf8")).toBe("original recording");
    });
  });

  it("keeps import success after transcript cleanup, selection and observer failures", async () => {
    await withImport(async (runtime, item, queuePath) => {
      const warnings = vi.spyOn(runtime.currentLogger(), "warn");
      vi.spyOn(TranscriptStore.prototype, "removeAbsent").mockRejectedValueOnce(new Error("cleanup failed"));
      const save = JsonStore.prototype.save;
      vi.spyOn(JsonStore.prototype, "save").mockImplementation(function (this: typeof JsonStore.prototype, value) {
        if (typeof value === "object" && value !== null && "selectedCardId" in value) {
          return Promise.reject(new Error("selection save failed"));
        }
        return save.call(this, value);
      });
      runtime.onPipelineProgress(() => { throw new Error("observer failed"); });

      const result = await runtime.confirmPendingImports([item]);

      expect(result.snapshot.state!.cards).toHaveLength(1);
      expect(result.originalWarnings).toEqual([]);
      const persisted = (await createQueueStore(queuePath).load()).value;
      expect(persisted.pendingImports).toEqual([]);
      expect(persisted.cards).toHaveLength(1);
      await expect(stat(item.originalSourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(warnings.mock.calls.map(([operation]) => operation)).toEqual([
        "queue.cleanup-transcripts", "queue.select-card", "queue.progress", "import.select-card",
      ]);
      expect(warnings.mock.calls.every(([, , details]) =>
        (details as { error: { stack?: string } }).error.stack !== undefined,
      )).toBe(true);
    });
  });

  it.each([false, true])("aborts and releases a detached run when cancellation save fails: %s", async (saveFails) => {
    await withCard(async (runtime, card) => {
      const control = runtime as unknown as {
        pipeline: PipelineCoordinator;
        runtime: { settings: { concurrencyLimit: number } };
      };
      control.runtime.settings.concurrencyLimit = 1;
      const started = gate();
      const stopped = gate();
      let signal: AbortSignal | undefined;
      vi.spyOn(cardPipeline, "executeCardPipeline").mockImplementation(async (_id, _step, _mode, ctx) => {
        signal = ctx.signal;
        started.release();
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) resolve();
          else ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        stopped.release();
      });
      await control.pipeline.startOrEnqueue(card.id, "generate", "transcription");
      await started.promise;
      const failure = new Error("cancel queue save failed");
      if (saveFails) vi.spyOn(QueueStore.prototype, "save").mockRejectedValueOnce(failure);
      try {
        const cancel = runtime.cancelCardProcessing(card.id);
        if (saveFails) await expect(cancel).rejects.toBe(failure);
        else await expect(cancel).resolves.toMatchObject({ state: { cards: [{ status: "Cancelled" }] } });
        expect(signal!.aborted).toBe(true);
        await stopped.promise;
        expect(control.pipeline.hasRun(card.id)).toBe(false);
        expect(runtime.getSnapshot().state!.cards[0]).not.toBe(card);
        expect(runtime.getSnapshot().state!.cards[0].status).toBe("Cancelled");
        await control.pipeline.startOrEnqueue(card.id, "generate", "transcription");
        expect(control.pipeline.hasRun(card.id)).toBe(true);
        expect(runtime.getSnapshot().state!.cards[0].status).toBe("Transcribing");
      } finally {
        await control.pipeline.shutdown();
      }
    });
  });

  it("persists failed-start settlement after a queued successor captured its busy status", async () => {
    await withCard(async (runtime, card, queuePath) => {
      const duplicate = await runtime.duplicateCard(card.id);
      const second = duplicate.state!.cards.find((entry) => entry.id !== card.id)!;
      const control = runtime as unknown as {
        pipeline: PipelineCoordinator;
        runtime: { settings: { concurrencyLimit: number } };
      };
      control.runtime.settings.concurrencyLimit = 1;
      vi.spyOn(cardPipeline, "executeCardPipeline").mockImplementation(async (_id, _step, _mode, ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) resolve();
          else ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      });
      const entered = gate();
      let reject!: (error: Error) => void;
      const held = new Promise<void>((_resolve, fail) => { reject = fail; });
      vi.spyOn(QueueStore.prototype, "save").mockImplementationOnce(async () => {
        entered.release();
        await held;
      });
      const failure = new Error("prestart publication failed");
      const first = control.pipeline.startOrEnqueue(card.id, "generate", "transcription");
      const rejected = expect(first).rejects.toBe(failure);
      let queued: Promise<void> | undefined;
      try {
        await entered.promise;
        queued = control.pipeline.startOrEnqueue(second.id, "generate", "transcription");
        expect(second.status).toBe("Queued");
        reject(failure);
        await rejected;
        await queued;
        expect(card.status).toBe("Imported");
        expect(control.pipeline.hasRun(card.id)).toBe(false);
        expect(control.pipeline.hasRun(second.id)).toBe(true);
        expect(persistence(runtime).queueBehind).toBe(false);
        const durable = (await createQueueStore(queuePath).load()).value.cards.find((entry) => entry.id === card.id)!;
        expect(durable).toMatchObject({ status: "Imported", activeStep: null, queuedMode: null, queuedAtUtc: null });
      } finally {
        reject(failure);
        await Promise.allSettled([first, rejected, ...(queued ? [queued] : [])]);
        await control.pipeline.shutdown();
      }
    });
  });

  it("captures queue fields and both transcript bodies before its first wait", async () => {
    await withCard(async (runtime, card, queuePath) => {
      const state = runtime.getSnapshot().state!;
      card.transcription.text = "first transcript";
      card.metadata.structured = "first outline";
      card.metadata.title = "first title";
      card.ai.title = { provider: "gemini", model: "first model", generatedAtUtc: 1_700_000_000_000 };
      state.pendingImports.push({ ...authoritativeItem(), id: "pending", workingFilePath: card.sourceFilePath });
      const before = structuredClone(state);
      const entered = gate();
      const release = gate();
      const write = TranscriptStore.prototype.writeChanged;
      vi.spyOn(TranscriptStore.prototype, "writeChanged").mockImplementationOnce(async function (this: typeof TranscriptStore.prototype, cards) {
        entered.release();
        await release.promise;
        return write.call(this, cards);
      });
      const pending = persistence(runtime).persistState();
      try {
        await entered.promise;
        card.transcription.text = "later transcript";
        card.metadata.structured = "later outline";
        card.metadata.title = "later title";
        card.ai.title!.model = "later model";
        card.trim.frontMarkerSec = 2;
        state.pendingImports[0].timezone = "Europe/Berlin";
        release.release();
        await pending;
        const saved = (await createQueueStore(queuePath).load()).value;
        expect(saved.cards[0].metadata.title).toBe("first title");
        expect(saved.cards[0].ai.title).toEqual(before.cards[0].ai.title);
        expect(saved.cards[0].trim).toEqual(before.cards[0].trim);
        expect(saved.pendingImports[0].timezone).toBe(before.pendingImports[0].timezone);
        const transcripts = await new TranscriptStore(getAppPaths().transcriptsDir).open([card.id]);
        expect(transcripts.get(card.id)).toEqual({ transcription: "first transcript", structured: "first outline" });
        expect(runtime.getSnapshot().state).toBe(state);
        expect(card.metadata.title).toBe("later title");
      } finally {
        release.release();
        await Promise.allSettled([pending]);
      }
    });
  });

  it("orders complete packets so old cleanup cannot remove a newer card's text", async () => {
    await withCard(async (runtime, card, queuePath) => {
      const state = runtime.getSnapshot().state!;
      const entered = gate();
      const release = gate();
      const operations: string[] = [];
      const write = TranscriptStore.prototype.writeChanged;
      const cleanup = TranscriptStore.prototype.removeAbsent;
      const save = QueueStore.prototype.save;
      vi.spyOn(TranscriptStore.prototype, "writeChanged").mockImplementation(async function (this: typeof TranscriptStore.prototype, cards) {
        operations.push(`text:${cards.length}`);
        if (cards.length === 0) { entered.release(); await release.promise; }
        return write.call(this, cards);
      });
      vi.spyOn(QueueStore.prototype, "save").mockImplementation(function (this: typeof QueueStore.prototype, queue) {
        operations.push(`queue:${queue.cards.length}`);
        return save.call(this, queue);
      });
      vi.spyOn(TranscriptStore.prototype, "removeAbsent").mockImplementation(function (this: typeof TranscriptStore.prototype, cards) {
        operations.push(`cleanup:${cards.length}`);
        return cleanup.call(this, cards);
      });
      state.cards = [];
      const older = persistence(runtime).persistState();
      let newer: Promise<void> | undefined;
      try {
        await entered.promise;
        card.transcription.text = "newer durable text";
        state.cards = [card];
        newer = persistence(runtime).persistState();
        release.release();
        await Promise.all([older, newer]);
        expect(operations).toEqual(["text:0", "queue:0", "cleanup:0", "text:1", "queue:1", "cleanup:1"]);
        expect((await createQueueStore(queuePath).load()).value.cards.map((entry) => entry.id)).toEqual([card.id]);
        expect((await new TranscriptStore(getAppPaths().transcriptsDir).open([card.id])).get(card.id)?.transcription)
          .toBe("newer durable text");
        expect(runtime.getSnapshot().layout!.selectedCardId).toBe(card.id);
      } finally {
        release.release();
        await Promise.allSettled([older, ...(newer ? [newer] : [])]);
      }
    });
  });

  it("keeps newer packets dirty after an older commit and continues after their failed save", async () => {
    await withCard(async (runtime, card, queuePath) => {
      const entered = gate();
      const release = gate();
      const write = TranscriptStore.prototype.writeChanged;
      let writes = 0;
      vi.spyOn(TranscriptStore.prototype, "writeChanged").mockImplementation(async function (this: typeof TranscriptStore.prototype, cards) {
        if (++writes === 2) { entered.release(); await release.promise; }
        return write.call(this, cards);
      });
      const save = QueueStore.prototype.save;
      const failure = new Error("newer queue save failed");
      let saves = 0;
      vi.spyOn(QueueStore.prototype, "save").mockImplementation(function (this: typeof QueueStore.prototype, queue) {
        return ++saves === 2 ? Promise.reject(failure) : save.call(this, queue);
      });
      card.metadata.title = "older";
      const older = persistence(runtime).persistState();
      card.metadata.title = "newer";
      const newer = persistence(runtime).persistState();
      const rejected = expect(newer).rejects.toBe(failure);
      try {
        await entered.promise;
        await older;
        expect(persistence(runtime).queueBehind).toBe(true);
        expect((await createQueueStore(queuePath).load()).value.cards[0].metadata.title).toBe("older");
        release.release();
        await rejected;
        expect(persistence(runtime).queueBehind).toBe(true);
        await persistence(runtime).persistState();
        expect(persistence(runtime).queueBehind).toBe(false);
        expect((await createQueueStore(queuePath).load()).value.cards[0].metadata.title).toBe("newer");
      } finally {
        release.release();
        await Promise.allSettled([older, newer, rejected]);
      }
    });
  });

  it.each(["import", "duplicate"] as const)("quit drains %s copy admitted before its first persistence", async (kind) => {
    await withCard(async (runtime, card, queuePath) => {
      const held = gate();
      const entered = gate();
      const copy = workingFiles.copyIntoWorking;
      const copying = vi.spyOn(workingFiles, "copyIntoWorking").mockImplementationOnce(async (...args) => {
        entered.release();
        await held.promise;
        return copy(...args);
      });
      const work = kind === "import" ? runtime.importDroppedPaths([card.sourceFilePath]) : runtime.duplicateCard(card.id);
      let quit: Promise<unknown> | undefined;
      try {
        await entered.promise;
        quit = runtime.saveForQuit();
        let settled = false;
        void quit.then(() => { settled = true; });
        await expect(runtime.importDroppedPaths([card.sourceFilePath])).rejects.toThrow("closing");
        await expect(runtime.duplicateCard(card.id)).rejects.toThrow("closing");
        await expect(runtime.updateCardTrim(card.id, { frontMarkerSec: 1, backMarkerSec: null })).rejects.toThrow("closing");
        await expect(runtime.generateCardStep(card.id, "transcription")).rejects.toThrow("closing");
        expect(settled).toBe(false);
        expect(copying).toHaveBeenCalledTimes(1);
        held.release();
        await work;
        expect(await quit).toEqual([]);
        const saved = (await createQueueStore(queuePath).load()).value;
        expect(kind === "import" ? saved.pendingImports.length : saved.cards.length).toBe(kind === "import" ? 1 : 2);
      } finally {
        held.release();
        await Promise.allSettled([work, ...(quit ? [quit] : [])]);
      }
    });
  });

  it("quit waits for failed working deletion to restore and persist its card", async () => {
    await withCard(async (runtime, card, queuePath) => {
      const held = gate();
      const entered = gate();
      const primary = new Error("working deletion failed");
      vi.mocked(rm).mockImplementationOnce(async () => {
        entered.release();
        await held.promise;
        throw primary;
      });
      const work = runtime.removeCard(card.id);
      const outcome = work.catch((error: unknown) => error);
      let quit: Promise<unknown> | undefined;
      try {
        await entered.promise;
        expect(runtime.getSnapshot().state!.cards).toHaveLength(0);
        quit = runtime.saveForQuit();
        let settled = false;
        void quit.then(() => { settled = true; });
        await expect(runtime.removeCard(card.id)).rejects.toThrow("closing");
        expect(settled).toBe(false);
        held.release();
        expect(await outcome).toMatchObject({ cause: primary });
        expect(await quit).toEqual([]);
        expect((await createQueueStore(queuePath).load()).value.cards.map((entry) => entry.id)).toEqual([card.id]);
        expect(await readFile(card.sourceFilePath, "utf8")).toBe("original recording");
      } finally {
        held.release();
        await Promise.allSettled([work, ...(quit ? [quit] : [])]);
      }
    });
  });

  it("quit drains a failed copy without changing its original error", async () => {
    await withCard(async (runtime, card, queuePath) => {
      const held = gate();
      const entered = gate();
      const primary = new Error("working copy failed");
      vi.spyOn(workingFiles, "copyIntoWorking").mockImplementationOnce(async () => {
        entered.release();
        await held.promise;
        throw primary;
      });
      const work = runtime.duplicateCard(card.id);
      const outcome = work.catch((error: unknown) => error);
      let quit: Promise<unknown> | undefined;
      try {
        await entered.promise;
        quit = runtime.saveForQuit();
        let settled = false;
        void quit.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        held.release();
        expect(await outcome).toBe(primary);
        expect(await quit).toEqual([]);
        expect((await createQueueStore(queuePath).load()).value.cards).toHaveLength(1);
      } finally {
        held.release();
        await Promise.allSettled([work, ...(quit ? [quit] : [])]);
      }
    });
  });

  it("quit drains confirmation held in audio probing before queue admission", async () => {
    await withImport(async (runtime, item, queuePath) => {
      const held = gate();
      const entered = gate();
      vi.mocked(audioTools.probeAudioProfile).mockImplementationOnce(async () => {
        entered.release();
        await held.promise;
        return { durationSec: 5, audioProfile: null };
      });
      const work = runtime.confirmPendingImports([{ ...item, deleteOriginalOnConfirm: false }]);
      let quit: Promise<unknown> | undefined;
      try {
        await entered.promise;
        quit = runtime.saveForQuit();
        let settled = false;
        void quit.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        held.release();
        await work;
        expect(await quit).toEqual([]);
        expect((await createQueueStore(queuePath).load()).value.cards[0].durationSec).toBe(5);
      } finally {
        held.release();
        await Promise.allSettled([work, ...(quit ? [quit] : [])]);
      }
    });
  });

  it.each([false, true])("quit drains trim analysis, including superseded=%s work", async (superseded) => {
    await withCard(async (runtime, card, queuePath) => {
      const decision = await audioTools.analyzeTrimDecision(card.sourceFilePath, { frontMarkerSec: null, backMarkerSec: null }, null);
      const held = gate();
      const entered = gate();
      vi.spyOn(audioTools, "analyzeTrimDecision").mockImplementation(async () => decision).mockImplementationOnce(async () => {
        entered.release();
        await held.promise;
        return decision;
      });
      const work = runtime.updateCardTrim(card.id, { frontMarkerSec: 1, backMarkerSec: null });
      let quit: Promise<unknown> | undefined;
      try {
        await entered.promise;
        if (superseded) await runtime.updateCardTrim(card.id, { frontMarkerSec: 2, backMarkerSec: null });
        quit = runtime.saveForQuit();
        let settled = false;
        void quit.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        held.release();
        await work;
        expect(await quit).toEqual([]);
        expect((await createQueueStore(queuePath).load()).value.cards[0].trim.frontMarkerSec).toBe(superseded ? 2 : 1);
      } finally {
        held.release();
        await Promise.allSettled([work, ...(quit ? [quit] : [])]);
      }
    });
  });

  it("a cancelled quit keeps old producers owned and a new quit drains newly admitted work", async () => {
    await withCard(async (runtime, card, queuePath) => {
      const firstHeld = gate();
      const secondHeld = gate();
      const firstEntered = gate();
      const secondEntered = gate();
      const copy = workingFiles.copyIntoWorking;
      vi.spyOn(workingFiles, "copyIntoWorking")
        .mockImplementationOnce(async (...args) => { firstEntered.release(); await firstHeld.promise; return copy(...args); })
        .mockImplementationOnce(async (...args) => { secondEntered.release(); await secondHeld.promise; return copy(...args); });
      const writes = vi.spyOn(TranscriptStore.prototype, "writeChanged");
      const first = runtime.duplicateCard(card.id);
      let second: Promise<unknown> | undefined;
      let firstQuit: Promise<unknown> | undefined;
      let secondQuit: Promise<unknown> | undefined;
      try {
        await firstEntered.promise;
        firstQuit = runtime.saveForQuit();
        await runtime.resumeAfterCancelledQuit();
        second = runtime.duplicateCard(card.id);
        await secondEntered.promise;
        secondQuit = runtime.saveForQuit();
        expect(secondQuit).not.toBe(firstQuit);
        let settled = false;
        void secondQuit.then(() => { settled = true; });
        firstHeld.release();
        await first;
        expect(await firstQuit).toEqual([]);
        expect(settled).toBe(false);
        expect(runtime.saveForQuit()).toBe(secondQuit);
        secondHeld.release();
        await second;
        expect(await secondQuit).toEqual([]);
        expect((await createQueueStore(queuePath).load()).value.cards).toHaveLength(3);
        // Two producer packets and only the current quit's final packet.
        expect(writes).toHaveBeenCalledTimes(3);
      } finally {
        firstHeld.release();
        secondHeld.release();
        await Promise.allSettled([first, ...(second ? [second] : []), ...(firstQuit ? [firstQuit] : []), ...(secondQuit ? [secondQuit] : [])]);
      }
    });
  });

  it.each([false, true])("quit owns an admitted key lookup and prevents late processing even after resume=%s", async (resumed) => {
    await withCard(async (runtime, card) => {
      const held = gate();
      const entered = gate();
      const lifecycle = runtime as unknown as { resolveGeminiApiKey(): Promise<string | null>; pipeline: PipelineCoordinator };
      vi.spyOn(lifecycle, "resolveGeminiApiKey").mockImplementationOnce(async () => {
        entered.release();
        await held.promise;
        return "test key";
      });
      const start = vi.spyOn(lifecycle.pipeline, "startOrEnqueue");
      const work = runtime.generateCardStep(card.id, "transcription");
      const outcome = work.catch((error: unknown) => error);
      let quit: Promise<unknown> | undefined;
      try {
        await entered.promise;
        quit = runtime.saveForQuit();
        let settled = false;
        void quit.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        if (resumed) await runtime.resumeAfterCancelledQuit();
        held.release();
        expect(await outcome).toMatchObject({ message: expect.stringContaining("closing") });
        expect(await quit).toEqual([]);
        expect(start).not.toHaveBeenCalled();
      } finally {
        held.release();
        await Promise.allSettled([work, ...(quit ? [quit] : [])]);
      }
    });
  });

  it("drains an admitted packet before quit's final snapshot", async () => {
    await withCard(async (runtime, card, queuePath) => {
      const entered = gate();
      const release = gate();
      const write = TranscriptStore.prototype.writeChanged;
      vi.spyOn(TranscriptStore.prototype, "writeChanged").mockImplementationOnce(async function (this: typeof TranscriptStore.prototype, cards) {
        entered.release();
        await release.promise;
        return write.call(this, cards);
      });
      card.metadata.title = "admitted title";
      const pending = persistence(runtime).persistState();
      let quit: Promise<unknown> | undefined;
      let newer: Promise<void> | undefined;
      try {
        await entered.promise;
        card.metadata.title = "quit title";
        card.transcription.text = "quit transcript";
        // A newer accepted packet makes the final queue snapshot dirty while the older one waits.
        newer = persistence(runtime).persistState();
        quit = runtime.saveForQuit();
        let settled = false;
        void quit.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        release.release();
        await Promise.all([pending, newer]);
        expect(await quit).toEqual([]);
        expect((await createQueueStore(queuePath).load()).value.cards[0].metadata.title).toBe("quit title");
        expect((await new TranscriptStore(getAppPaths().transcriptsDir).open([card.id])).get(card.id)?.transcription)
          .toBe("quit transcript");
      } finally {
        release.release();
        await Promise.allSettled([pending, ...(newer ? [newer] : []), ...(quit ? [quit] : [])]);
      }
    });
  });

  it("orders quit's final packet with a later admitted save without mixing snapshots", async () => {
    await withCard(async (runtime, card, queuePath) => {
      card.metadata.title = "quit title";
      card.transcription.text = "quit text";
      vi.spyOn(QueueStore.prototype, "save").mockRejectedValueOnce(new Error("initial save failure"));
      await expect(persistence(runtime).persistState()).rejects.toThrow("initial save failure");
      vi.restoreAllMocks();
      const entered = gate();
      const release = gate();
      const write = TranscriptStore.prototype.writeChanged;
      const save = QueueStore.prototype.save;
      const operations: string[] = [];
      vi.spyOn(TranscriptStore.prototype, "writeChanged").mockImplementation(async function (this: typeof TranscriptStore.prototype, cards) {
        operations.push(`text:${cards[0].metadata.title}`);
        if (operations.length === 1) { entered.release(); await release.promise; }
        return write.call(this, cards);
      });
      vi.spyOn(QueueStore.prototype, "save").mockImplementation(function (this: typeof QueueStore.prototype, queue) {
        operations.push(`queue:${queue.cards[0].metadata.title}`);
        return save.call(this, queue);
      });
      const quit = runtime.saveForQuit();
      let later: Promise<void> | undefined;
      try {
        await entered.promise;
        card.metadata.title = "later title";
        card.transcription.text = "later text";
        later = persistence(runtime).persistState();
        await Promise.resolve();
        expect(operations).toEqual(["text:quit title"]);
        release.release();
        expect(await quit).toEqual([]);
        await later;
        expect(operations).toEqual(["text:quit title", "queue:quit title", "text:later title", "queue:later title"]);
        expect(persistence(runtime).queueBehind).toBe(false);
        expect((await createQueueStore(queuePath).load()).value.cards[0].metadata.title).toBe("later title");
        expect((await new TranscriptStore(getAppPaths().transcriptsDir).open([card.id])).get(card.id)?.transcription)
          .toBe("later text");
      } finally {
        release.release();
        await Promise.allSettled([quit, ...(later ? [later] : [])]);
      }
    });
  });

  it("attempts required stores before held layout work and does not await optional error logging", async () => {
    await withCard(async (runtime, card) => {
      type Stores = {
        transcriptStore: InstanceType<typeof TranscriptStore>;
        queueStore: ReturnType<typeof createQueueStore>;
        layoutStore: { flush(): Promise<void> };
      };
      const stores = (runtime as unknown as { runtime: Stores }).runtime;
      card.transcription.text = "required before optional";
      const held = gate();
      const layout = vi.spyOn(stores.layoutStore, "flush").mockImplementation(() => held.promise);
      const text = vi.spyOn(stores.transcriptStore, "writeChanged").mockRejectedValueOnce(new Error("text failure"));
      const diagnostic = vi.spyOn(runtime.currentLogger(), "error").mockImplementation(() => held.promise);
      const quit = runtime.saveForQuit();
      try {
        await vi.waitFor(() => expect(layout).toHaveBeenCalledOnce());
        expect(text).toHaveBeenCalledOnce();
        expect(diagnostic).toHaveBeenCalledOnce();
        held.release();
        expect(await quit).toEqual(["transcripts"]);
      } finally {
        held.release(); await quit;
        layout.mockRestore(); text.mockRestore(); diagnostic.mockRestore();
      }
    });
  });

  it.each(["transcripts", "queue"] as const)("preserves quit's %s failure category and retries through the owner", async (failedStore) => {
    await withCard(async (runtime, card, queuePath) => {
      card.metadata.title = "unsaved title";
      vi.spyOn(QueueStore.prototype, "save").mockRejectedValueOnce(new Error("initial save failure"));
      await expect(persistence(runtime).persistState()).rejects.toThrow("initial save failure");
      vi.restoreAllMocks();
      card.transcription.text = "unsaved transcript";
      const queueSave = vi.spyOn(QueueStore.prototype, "save");
      const cleanup = vi.spyOn(TranscriptStore.prototype, "removeAbsent");
      if (failedStore === "transcripts") {
        vi.spyOn(TranscriptStore.prototype, "writeChanged").mockRejectedValueOnce(new Error("quit transcript failure"));
      } else {
        queueSave.mockRejectedValueOnce(new Error("quit queue failure"));
      }
      expect(await runtime.saveForQuit()).toEqual([failedStore]);
      expect(persistence(runtime).queueBehind).toBe(true);
      expect(cleanup).not.toHaveBeenCalled();
      if (failedStore === "transcripts") expect(queueSave).not.toHaveBeenCalled();
      expect(await runtime.saveForQuit()).toEqual([]);
      expect(persistence(runtime).queueBehind).toBe(false);
      expect((await createQueueStore(queuePath).load()).value.cards[0].metadata.title).toBe("unsaved title");
      expect((await new TranscriptStore(getAppPaths().transcriptsDir).open([card.id])).get(card.id)?.transcription)
        .toBe("unsaved transcript");
    });
  });

});

// Storage-path-conventions: the root is owner-only (0700) on POSIX — created
// that way, and tightened to 0700 at each launch when an existing root is
// broader. Windows uses its own permission model, so this is skipped there.
(process.platform === "win32" ? describe.skip : describe)(
  "ApplicationRuntime storage root permissions",
  () => {
    it("creates a fresh storage root as owner-only (0700)", async () => {
      const root = await mkdtemp(join(tmpdir(), "mumbler-runtime-root-"));
      const previousRoot = process.env.MUMBLER_DATA_DIR;
      process.env.MUMBLER_DATA_DIR = join(root, "profile");

      let runtime: Awaited<ReturnType<typeof ApplicationRuntime.initialize>> | null = null;
      try {
        runtime = await ApplicationRuntime.initialize();
        expect(runtime.getSnapshot().startupDiagnostic).toBeNull();

        const mode = (await stat(process.env.MUMBLER_DATA_DIR)).mode & 0o777;
        expect(mode).toBe(0o700);
      } finally {
        await runtime?.shutdown();
        if (previousRoot === undefined) delete process.env.MUMBLER_DATA_DIR;
        else process.env.MUMBLER_DATA_DIR = previousRoot;
        await rm(root, { force: true, recursive: true });
      }
    });

    it("tightens an existing broader storage root to 0700 on launch", async () => {
      const root = await mkdtemp(join(tmpdir(), "mumbler-runtime-root-"));
      const homeDir = join(root, "profile");
      await mkdir(homeDir, { recursive: true, mode: 0o755 });
      await chmod(homeDir, 0o755);
      expect((await stat(homeDir)).mode & 0o777).toBe(0o755);

      const previousRoot = process.env.MUMBLER_DATA_DIR;
      process.env.MUMBLER_DATA_DIR = homeDir;

      let runtime: Awaited<ReturnType<typeof ApplicationRuntime.initialize>> | null = null;
      try {
        runtime = await ApplicationRuntime.initialize();
        expect(runtime.getSnapshot().startupDiagnostic).toBeNull();

        const mode = (await stat(homeDir)).mode & 0o777;
        expect(mode).toBe(0o700);
      } finally {
        await runtime?.shutdown();
        if (previousRoot === undefined) delete process.env.MUMBLER_DATA_DIR;
        else process.env.MUMBLER_DATA_DIR = previousRoot;
        await rm(root, { force: true, recursive: true });
      }
    });
  },
);
