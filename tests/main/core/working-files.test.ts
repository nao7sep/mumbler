import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppLogger } from "@main/core/logger";
import type { AppPaths, MumblerCard, MumblerState, PendingImportReviewItem } from "@shared/app-shell";

// The filesystem is real throughout — these functions are about what actually
// lands on disk. The single exception is a removal the OS refuses: `rm` fails
// only for paths registered in `undeletable`, so the retained-orphan path is
// exercised without depending on POSIX permissions.
const undeletable = vi.hoisted(() => new Set<string>());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      if (undeletable.has(String(path))) {
        throw new Error("EACCES: permission denied");
      }
      return actual.rm(path, options);
    },
  };
});

const {
  cleanupOrphanedWorkingFiles,
  copyIntoWorking,
  copyOriginalToBackup,
  deleteImportedSource,
  listWorkingFiles,
  reconcileWorkingState,
} = await import("@main/core/working-files");

let dir: string;

function makeLogger(): AppLogger {
  return {
    debug: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
  };
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

function makeState(overrides: Partial<MumblerState> = {}): MumblerState {
  return { schemaVersion: 2, pendingImports: [], cards: [], ...overrides };
}

beforeEach(async () => {
  undeletable.clear();
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

  it("names the import that could not be copied, and leaves no partial copy behind", async () => {
    const working = join(dir, "working");

    await expect(copyIntoWorking(join(dir, "gone.wav"), working, "clip.wav")).rejects.toThrow(
      /Failed to create a readable working copy for clip\.wav/,
    );

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

  it("names the original that could not be backed up", async () => {
    const source = join(dir, "gone.m4a");

    await expect(copyOriginalToBackup(source, join(dir, "backup"))).rejects.toThrow(
      new RegExp(`Failed to copy ${source} to backup directory`),
    );
  });

  it("deletes the imported source the user asked to remove", async () => {
    const source = join(dir, "source.m4a");
    await writeFile(source, "audio", "utf8");

    await deleteImportedSource(source);

    await expect(access(source)).rejects.toThrow();
  });
});

describe("the working directory listing", () => {
  it("lists working files and derived output, and ignores other directories", async () => {
    const working = join(dir, "working");
    await mkdir(join(working, "derived", "nested"), { recursive: true });
    await mkdir(join(working, "scratch"), { recursive: true });
    await writeFile(join(working, "rec.m4a"), "audio", "utf8");
    await writeFile(join(working, "derived", "rec.wav"), "audio", "utf8");
    await writeFile(join(working, "scratch", "ignored.tmp"), "junk", "utf8");
    await writeFile(join(working, "derived", "nested", "ignored.wav"), "audio", "utf8");

    expect((await listWorkingFiles(working)).sort()).toEqual(
      [join(working, "rec.m4a"), join(working, "derived", "rec.wav")].sort(),
    );
  });
});

describe("orphaned working files", () => {
  it("deletes what nothing references, keeps what is referenced, and traces each deletion", async () => {
    const working = join(dir, "working");
    await mkdir(join(working, "derived"), { recursive: true });
    const referenced = join(working, "kept.m4a");
    const orphan = join(working, "orphan.m4a");
    const derivedOrphan = join(working, "derived", "orphan.wav");
    for (const file of [referenced, orphan, derivedOrphan]) await writeFile(file, "audio", "utf8");
    const logger = makeLogger();

    const result = await cleanupOrphanedWorkingFiles(makePaths(working), new Set([referenced]), logger);

    expect(result).toEqual({ deletedOrphanedFiles: 2, retainedOrphanedFiles: 0 });
    expect((await listWorkingFiles(working))).toEqual([referenced]);
    expect(logger.debug).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenCalledWith("working.cleanup", expect.any(String), { filePath: orphan });
  });

  it("counts and warns about an orphan the filesystem refuses to delete, and keeps going", async () => {
    const working = join(dir, "working");
    await mkdir(working, { recursive: true });
    const stuck = join(working, "stuck.m4a");
    const orphan = join(working, "orphan.m4a");
    await writeFile(stuck, "audio", "utf8");
    await writeFile(orphan, "audio", "utf8");
    undeletable.add(stuck);
    const logger = makeLogger();

    const result = await cleanupOrphanedWorkingFiles(makePaths(working), new Set(), logger);

    expect(result).toEqual({ deletedOrphanedFiles: 1, retainedOrphanedFiles: 1 });
    expect(await listWorkingFiles(working), "the file it could not delete is still there").toEqual([stuck]);
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
      deletedOrphanedFiles: 0,
      retainedOrphanedFiles: 0,
    });
    expect(result.state, "the same state is handed back, not a rewritten copy").toBe(state);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("drops a pending import whose audio is gone, errors a card whose audio is gone, and clears the leftovers", async () => {
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
      deletedOrphanedFiles: 1,
      retainedOrphanedFiles: 0,
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
    });
    expect(await listWorkingFiles(working), "the unreferenced file is swept").toEqual([survivingCardFile]);
    expect(logger.warn).toHaveBeenCalledWith("startup.pending-missing", expect.any(String), expect.objectContaining({ pendingImportId: "pending-gone" }));
    expect(logger.warn).toHaveBeenCalledWith("startup.card-missing", expect.any(String), expect.objectContaining({ cardId: "card-gone" }));
  });
});
