import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppLogger } from "@main/core/logger";
import type { AppPaths, MumblerCard, MumblerQueue, PendingImportReviewItem } from "@shared/app-shell";

// The filesystem is real throughout — these functions are about what actually
// lands on disk. The single exception is a removal the OS refuses: `rm` fails
// only for paths registered in `undeletable`, so the retained-orphan path is
// exercised without depending on POSIX permissions.
const undeletable = vi.hoisted(() => new Set<string>());
const backupFaults = vi.hoisted(() => ({
  beforeLink: null as ((source: string, target: string) => Promise<void>) | null,
  unsupported: null as string | null,
  stageFailure: null as Error | null,
  publicFailure: null as Error | null,
  refuseStageCleanup: false,
  beforeCopy: null as ((target: string) => Promise<void>) | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
      await backupFaults.beforeCopy?.(String(args[1]));
      return actual.copyFile(...args);
    },
    link: async (source: Parameters<typeof actual.link>[0], target: Parameters<typeof actual.link>[1]) => {
      await backupFaults.beforeLink?.(String(source), String(target));
      if (backupFaults.unsupported !== null) throw Object.assign(new Error("links unsupported"), { code: backupFaults.unsupported });
      return actual.link(source, target);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const stage = basename(String(args[0])) === "audio";
      if (stage && backupFaults.refuseStageCleanup) undeletable.add(dirname(String(args[0])));
      const failure = stage ? backupFaults.stageFailure : backupFaults.publicFailure;
      if (args[1] === "wx" && failure !== null) {
        vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
          await handle.write("partial", 0, "utf8");
          throw failure;
        });
      }
      return handle;
    },
    rm: async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      if (undeletable.has(String(path))) {
        throw new Error("EACCES: permission denied");
      }
      return actual.rm(path, options);
    },
  };
});

const {
  cleanupDerivedFiles,
  copyIntoWorking,
  copyOriginalToBackup,
  deleteImportedSource,
  listDerivedFiles,
  reconcileWorkingState,
} = await import("@main/core/working-files");

let dir: string;

function makeLogger(): AppLogger {
  return {
    debug: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    providerCall: vi.fn().mockResolvedValue(undefined),
  };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** Only workingDir matters here; the rest of the paths are never read. */
function makePaths(workingDir: string): AppPaths {
  return { workingDir } as AppPaths;
}

function makePendingImport(overrides: Partial<PendingImportReviewItem> = {}): PendingImportReviewItem {
  return {
    id: "pending-1",
    originalFilename: "rec.m4a",
    importSource: "file-picker",
    originalSourcePath: "/tmp/rec.m4a",
    workingFilePath: "/tmp/working/rec.m4a",
    fileSizeBytes: 1024,
    localTimestampText: "2026-04-22 09:44:00",
    timezone: "Asia/Tokyo",
    utcTimestampText: "2026-04-22T00:44:00Z",
    parseStatus: "parsed",
    deleteOriginalOnConfirm: false,
    copyToBackupOnConfirm: false,
    createdAtUtc: 1,
    updatedAtUtc: 1,
    ...overrides,
  };
}

function makeCard(overrides: Partial<MumblerCard> = {}): MumblerCard {
  return {
    id: "card-1",
    originalFilename: "rec.m4a",
    importSource: "file-picker",
    sourceFilePath: "/tmp/working/rec.m4a",
    audioProfile: null,
    durationSec: 60,
    fileSizeBytes: 1024,
    timestamps: {
      confirmedLocal: "2026-04-22 09:44:00",
      confirmedUtc: Date.UTC(2026, 3, 22, 0, 44, 0),
      timezone: "Asia/Tokyo",
      frontTrimOffsetSec: 0,
      effectiveLocal: "2026-04-22 09:44:00",
      effectiveUtc: Date.UTC(2026, 3, 22, 0, 44, 0),
    },
    trim: { frontMarkerSec: null, backMarkerSec: null },
    trimDecision: null,
    transcribedTrim: null,
    transcription: { text: "hello world" },
    metadata: { structured: null, title: null, slug: null },
    ai: { transcription: null, structured: null, title: null, slug: null },
    status: "Imported",
    activeStep: null,
    queuedMode: null,
    queuedAtUtc: null,
    lastError: null,
    createdAtUtc: 1,
    updatedAtUtc: 1,
    ...overrides,
  };
}

function makeState(overrides: Partial<MumblerQueue> = {}): MumblerQueue {
  return { pendingImports: [], cards: [], ...overrides };
}

beforeEach(async () => {
  undeletable.clear();
  backupFaults.beforeLink = null;
  backupFaults.beforeCopy = null;
  backupFaults.unsupported = null;
  backupFaults.stageFailure = null;
  backupFaults.publicFailure = null;
  backupFaults.refuseStageCleanup = false;
  dir = await mkdtemp(join(tmpdir(), "mumbler-working-files-"));
});

afterEach(async () => {
  undeletable.clear();
  await rm(dir, { recursive: true, force: true });
});

describe("working audio copies", () => {
  it("copies imported audio under a case-insensitively unique working path", async () => {
    const source = join(dir, "source.wav");
    const working = join(dir, "working");
    await writeFile(source, "audio", "utf8");
    await mkdir(working, { recursive: true });
    await writeFile(join(working, "Clip.wav"), "existing", "utf8");

    const copied = await copyIntoWorking(source, working, "clip.wav");

    expect(basename(copied).toLowerCase()).not.toBe("clip.wav");
    expect(await readFile(copied, "utf8")).toBe("audio");
  });

  it("neither overwrites nor removes a file that takes the chosen name after the folder was read", async () => {
    const source = join(dir, "source.wav");
    const working = join(dir, "working");
    await writeFile(source, "audio", "utf8");
    backupFaults.beforeCopy = async (target) => { await writeFile(target, "someone else's", "utf8"); };

    await expect(copyIntoWorking(source, working, "clip.wav")).rejects.toMatchObject({ cause: { code: "EEXIST" } });

    expect(await readFile(join(working, "clip.wav"), "utf8")).toBe("someone else's");
  });

  it("names the import that could not be copied, and leaves no partial copy behind", async () => {
    const working = join(dir, "working");

    await expect(copyIntoWorking(join(dir, "gone.wav"), working, "clip.wav")).rejects.toMatchObject({
      message: expect.stringMatching(/Failed to create a readable working copy for clip\.wav/),
      cause: { code: "ENOENT" },
    });

    expect(await readdir(working), "the partial copy is cleaned up").toEqual([]);
  });

  it("still reports the real failure when the partial copy cannot be cleaned up", async () => {
    const working = join(dir, "working");
    await mkdir(working, { recursive: true });
    undeletable.add(join(working, "clip.wav"));

    await expect(copyIntoWorking(join(dir, "gone.wav"), working, "clip.wav")).rejects.toThrow(
      /Failed to create a readable working copy for clip\.wav/,
    );
  });

  it("copies an original into the chosen backup directory", async () => {
    const source = join(dir, "source.m4a");
    const backup = join(dir, "backup");
    await writeFile(source, "audio", "utf8");

    const copied = await copyOriginalToBackup(source, backup);

    expect(copied).toBe(join(backup, "source.m4a"));
    expect(await readFile(copied, "utf8")).toBe("audio");
  });

  it("keeps a public file that arrives after backup name selection", async () => {
    const source = join(dir, "source.m4a");
    const backup = join(dir, "backup");
    await writeFile(source, "complete audio");
    backupFaults.beforeLink = async (stage, target) => {
      expect(await readFile(stage, "utf8")).toBe("complete audio");
      await writeFile(target, "user file");
    };
    await expect(copyOriginalToBackup(source, backup)).rejects.toMatchObject({ cause: { code: "EEXIST" } });
    expect(await readFile(join(backup, "source.m4a"), "utf8")).toBe("user file");
    expect(await readFile(source, "utf8")).toBe("complete audio");
    expect(await readdir(backup)).toEqual(["source.m4a"]);
  });

  it.each(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"])("copies exclusively when links fail with %s", async (code) => {
    const source = join(dir, "source.m4a");
    const backup = join(dir, "backup");
    const recorded = new Date("2024-05-06T07:08:09.500Z");
    await writeFile(source, "complete audio");
    await utimes(source, recorded, recorded);
    await chmod(source, 0o444);
    backupFaults.unsupported = code;
    const copied = await copyOriginalToBackup(source, backup);
    expect(await readFile(copied, "utf8")).toBe("complete audio");
    expect((await stat(copied)).mtime.getTime()).toBe(recorded.getTime());
    if (process.platform !== "win32") expect((await stat(copied)).mode & 0o777).toBe(0o444);
    expect(await readdir(backup)).toEqual(["source.m4a"]);
  });

  it("keeps a public contender even on the unsupported-link fallback", async () => {
    const source = join(dir, "source.m4a");
    const backup = join(dir, "backup");
    await writeFile(source, "complete audio");
    backupFaults.unsupported = "ENOTSUP";
    backupFaults.beforeLink = async (_stage, target) => { await writeFile(target, "user file"); };
    await expect(copyOriginalToBackup(source, backup)).rejects.toMatchObject({ cause: { code: "EEXIST" } });
    expect(await readFile(join(backup, "source.m4a"), "utf8")).toBe("user file");
    expect(await readdir(backup)).toEqual(["source.m4a"]);
  });

  it("reports backup staging cleanup secondarily after publication", async () => {
    const source = join(dir, "source.m4a");
    const backup = join(dir, "backup");
    await writeFile(source, "complete audio");
    backupFaults.refuseStageCleanup = true;
    const logger = makeLogger();
    vi.mocked(logger.warn).mockRejectedValueOnce(new Error("optional logger failed"));
    const copied = await copyOriginalToBackup(source, backup, logger);
    expect(await readFile(copied, "utf8")).toBe("complete audio");
    expect(logger.warn).toHaveBeenCalledWith("import.backup-cleanup", expect.any(String), expect.objectContaining({ targetPath: copied, error: expect.objectContaining({ message: "EACCES: permission denied" }) }));
    expect((await readdir(backup)).some((name) => name.startsWith(".mumbler-backup-"))).toBe(true);
  });

  it("keeps a failed staged copy's primary cause while cleaning its private partial bytes", async () => {
    const source = join(dir, "source.m4a");
    const backup = join(dir, "backup");
    await writeFile(source, "complete audio");
    const primary = new Error("stream refused");
    backupFaults.stageFailure = primary;
    await expect(copyOriginalToBackup(source, backup)).rejects.toMatchObject({ cause: primary });
    expect(await readdir(backup)).toEqual([]);
    expect(await readFile(source, "utf8")).toBe("complete audio");
  });

  it("names an incomplete exclusive fallback and keeps the original on failure", async () => {
    const source = join(dir, "source.m4a");
    const backup = join(dir, "backup");
    await writeFile(source, "complete audio");
    backupFaults.unsupported = "ENOTSUP";
    const primary = new Error("stream refused");
    backupFaults.publicFailure = primary;
    const error = await copyOriginalToBackup(source, backup).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ cause: primary, message: expect.stringContaining(join(backup, "source.m4a")) });
    expect(await readFile(source, "utf8")).toBe("complete audio");
    expect(await readFile(join(backup, "source.m4a"), "utf8")).toBe("partial");
    expect(await readdir(backup)).toEqual(["source.m4a"]);
  });

  // A fixed time well in the past, so a copy that took the moment of copying fails.
  const RECORDED = new Date(Date.UTC(2024, 4, 6, 7, 8, 9, 500));

  it.each([
    ["a working copy", (source: string) => copyIntoWorking(source, join(dir, "working"), "clip.wav")],
    ["a backup of the original", (source: string) => copyOriginalToBackup(source, join(dir, "backup"))],
  ])("keeps the recording's modified time on %s", async (_name, copy) => {
    const source = join(dir, "clip.wav");
    await writeFile(source, "audio", "utf8");
    await utimes(source, RECORDED, RECORDED);

    const copied = await copy(source);

    expect((await stat(copied)).mtime.getTime()).toBe(RECORDED.getTime());
  });

  it.skipIf(process.platform === "win32")("keeps the recording's permission mode on its copies", async () => {
    const source = join(dir, "clip.wav");
    await writeFile(source, "audio", "utf8");
    await chmod(source, 0o640);

    const working = await copyIntoWorking(source, join(dir, "working"), "clip.wav");
    const backup = await copyOriginalToBackup(source, join(dir, "backup"));

    expect((await stat(working)).mode & 0o777).toBe(0o640);
    expect((await stat(backup)).mode & 0o777).toBe(0o640);
  });

  it("names the original that could not be backed up, keeping the filesystem's error as the cause", async () => {
    const source = join(dir, "gone.m4a");

    await expect(copyOriginalToBackup(source, join(dir, "backup"))).rejects.toThrow(
      new RegExp(`Failed to copy ${source} to backup directory`),
    );
    await expect(copyOriginalToBackup(source, join(dir, "backup"))).rejects.toMatchObject({
      cause: { code: "ENOENT" },
    });
  });

  it("deletes the imported source the user asked to remove", async () => {
    const source = join(dir, "source.m4a");
    await writeFile(source, "audio", "utf8");

    await deleteImportedSource(source);

    await expect(access(source)).rejects.toThrow();
  });
});

describe("the derived audio listing", () => {
  it("lists only the files directly in derived/, never a recording in working/ itself", async () => {
    const working = join(dir, "working");
    await mkdir(join(working, "derived", "nested"), { recursive: true });
    await mkdir(join(working, "scratch"), { recursive: true });
    await writeFile(join(working, "rec.m4a"), "audio", "utf8");
    await writeFile(join(working, "derived", "rec.wav"), "audio", "utf8");
    await writeFile(join(working, "scratch", "ignored.tmp"), "junk", "utf8");
    await writeFile(join(working, "derived", "nested", "ignored.wav"), "audio", "utf8");

    expect(await listDerivedFiles(working)).toEqual([join(working, "derived", "rec.wav")]);
  });

  it("lists nothing when no pipeline has made derived/ yet", async () => {
    const working = join(dir, "working");
    await mkdir(working, { recursive: true });

    expect(await listDerivedFiles(working)).toEqual([]);
  });
});

describe("leftover derived audio", () => {
  it("deletes every derived file, keeps every recording, and traces each deletion", async () => {
    const working = join(dir, "working");
    await mkdir(join(working, "derived"), { recursive: true });
    const recording = join(working, "unreferenced.m4a");
    const derived = join(working, "derived", "leftover.wav");
    for (const file of [recording, derived]) await writeFile(file, "audio", "utf8");
    const logger = makeLogger();

    const result = await cleanupDerivedFiles(makePaths(working), logger);

    expect(result).toEqual({ deletedDerivedFiles: 1, retainedDerivedFiles: 0 });
    expect(await exists(recording), "a recording no queue refers to is still the user's audio").toBe(true);
    expect(await exists(derived)).toBe(false);
    expect(logger.debug).toHaveBeenCalledExactlyOnceWith("working.cleanup", expect.any(String), { filePath: derived });
  });

  it("counts and warns about a derived file the filesystem refuses to delete, and keeps going", async () => {
    const working = join(dir, "working");
    await mkdir(join(working, "derived"), { recursive: true });
    const stuck = join(working, "derived", "stuck.wav");
    const leftover = join(working, "derived", "leftover.wav");
    await writeFile(stuck, "audio", "utf8");
    await writeFile(leftover, "audio", "utf8");
    undeletable.add(stuck);
    const logger = makeLogger();

    const result = await cleanupDerivedFiles(makePaths(working), logger);

    expect(result).toEqual({ deletedDerivedFiles: 1, retainedDerivedFiles: 1 });
    expect(await listDerivedFiles(working), "the file it could not delete is still there").toEqual([stuck]);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("working.cleanup-failed", expect.any(String), {
      filePath: stuck,
      error: expect.stringContaining("EACCES"),
    });
  });
});

describe("reconciling saved state with the working directory", () => {
  it("leaves intact state untouched", async () => {
    const working = join(dir, "working");
    await mkdir(working, { recursive: true });
    const pendingFile = join(working, "pending.m4a");
    const cardFile = join(working, "card.m4a");
    await writeFile(pendingFile, "audio", "utf8");
    await writeFile(cardFile, "audio", "utf8");
    const state = makeState({
      pendingImports: [makePendingImport({ workingFilePath: pendingFile })],
      cards: [makeCard({ sourceFilePath: cardFile })],
    });
    const logger = makeLogger();

    const result = await reconcileWorkingState(makePaths(working), state, logger);

    expect(result).toEqual({
      state,
      droppedPendingImports: 0,
      missingWorkingCards: 0,
      deletedDerivedFiles: 0,
      retainedDerivedFiles: 0,
    });
    expect(result.state, "the same state is handed back, not a rewritten copy").toBe(state);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("drops a pending import whose audio is gone, errors a card whose audio is gone, and keeps every recording", async () => {
    const working = join(dir, "working");
    await mkdir(working, { recursive: true });
    const survivingCardFile = join(working, "card.m4a");
    const orphan = join(working, "orphan.m4a");
    await writeFile(survivingCardFile, "audio", "utf8");
    await writeFile(orphan, "audio", "utf8");
    const survivor = makeCard({ id: "card-kept", sourceFilePath: survivingCardFile });
    const state = makeState({
      pendingImports: [makePendingImport({ id: "pending-gone", workingFilePath: join(working, "gone.m4a") })],
      cards: [survivor, makeCard({ id: "card-gone", sourceFilePath: join(working, "also-gone.m4a") })],
    });
    const logger = makeLogger();

    const result = await reconcileWorkingState(makePaths(working), state, logger);

    expect(result).toMatchObject({
      droppedPendingImports: 1,
      missingWorkingCards: 1,
      deletedDerivedFiles: 0,
      retainedDerivedFiles: 0,
    });
    expect(result.state.pendingImports).toEqual([]);
    expect(result.state.cards[0], "the card whose audio is still there is untouched").toBe(survivor);
    expect(result.state.cards[1]).toMatchObject({
      id: "card-gone",
      status: "Error",
      activeStep: null,
      queuedMode: null,
      queuedAtUtc: null,
      lastError: { failedStep: "startup-recovery", message: expect.stringContaining("missing") },
      updatedAtUtc: 1,
    });
    expect(await exists(orphan), "a recording the queue does not refer to is kept").toBe(true);
    expect(logger.warn).toHaveBeenCalledWith("startup.pending-missing", expect.any(String), expect.objectContaining({ pendingImportId: "pending-gone" }));
    expect(logger.warn).toHaveBeenCalledWith("startup.card-missing", expect.any(String), expect.objectContaining({ cardId: "card-gone" }));
  });
});
