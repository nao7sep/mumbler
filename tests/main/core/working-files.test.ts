import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppLogger } from "@main/core/logger";


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
  workingSyncFailure: false,
  workingEvents: [] as string[],
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
      if (args[1] === "wx" && basename(dirname(String(args[0]))) === "working") await backupFaults.beforeCopy?.(String(args[0]));
      const handle = await actual.open(...args);
      if (args[1] === "wx" && basename(dirname(String(args[0]))) === "working") {
        const sync = handle.sync.bind(handle);
        const close = handle.close.bind(handle);
        handle.sync = async () => {
          backupFaults.workingEvents.push("file");
          if (backupFaults.workingSyncFailure) throw Object.assign(new Error("working sync failed"), { code: "EIO" });
          await sync();
        };
        handle.close = async () => { backupFaults.workingEvents.push("close"); await close(); };
      }
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
  copyIntoWorking,
  copyOriginalToBackup,
  deleteImportedSource,
  sourceFileIdentity,
} = await import("@main/core/working-files");

let dir: string;

/** What an import does: the copy goes into the import's own new folder. */
async function copyToWorking(source: string, folder: string, name: string): Promise<string> {
  await mkdir(folder, { recursive: true });
  const path = join(folder, name);
  await copyIntoWorking(source, path);
  return path;
}

function makeLogger(): AppLogger {
  return {
    debug: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    providerCall: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(async () => {
  undeletable.clear();
  backupFaults.beforeLink = null;
  backupFaults.beforeCopy = null;
  backupFaults.unsupported = null;
  backupFaults.stageFailure = null;
  backupFaults.publicFailure = null;
  backupFaults.refuseStageCleanup = false;
  backupFaults.workingSyncFailure = false;
  backupFaults.workingEvents.length = 0;
  dir = await mkdtemp(join(tmpdir(), "mumbler-working-files-"));
});

afterEach(async () => {
  undeletable.clear();
  await rm(dir, { recursive: true, force: true });
});

describe("working audio copies", () => {
  it("syncs a read-only source copy before admitting its working path", async () => {
    const source = join(dir, "readonly.wav");
    await writeFile(source, "recording");
    await chmod(source, 0o400);
    try {
      const copied = await copyToWorking(source, join(dir, "working"), "take.wav");
      expect(await readFile(copied, "utf8")).toBe("recording");
      expect(backupFaults.workingEvents).toEqual(["file", "close"]);
    } finally { await chmod(source, 0o600); }
  });

  it("preserves the source and removes only the owned copy after a file sync failure", async () => {
    const source = join(dir, "source.wav");
    const working = join(dir, "working");
    await writeFile(source, "recording");
    backupFaults.workingSyncFailure = true;
    await expect(copyToWorking(source, working, "take.wav")).rejects.toThrow(/sync failed/);
    expect(await readFile(source, "utf8")).toBe("recording");
    expect(await readdir(working)).toEqual([]);
  });

  it("neither overwrites nor removes a file already at the copy's path", async () => {
    const source = join(dir, "source.wav");
    const working = join(dir, "working");
    await writeFile(source, "audio", "utf8");
    let claimed = "";
    backupFaults.beforeCopy = async (target) => { claimed = target; await writeFile(target, "someone else's", "utf8"); };

    await expect(copyToWorking(source, working, "clip.wav")).rejects.toMatchObject({ cause: { code: "EEXIST" } });

    expect(await readFile(claimed, "utf8")).toBe("someone else's");
  });

  it("names the import that could not be copied, and leaves no partial copy behind", async () => {
    const working = join(dir, "working");

    await expect(copyToWorking(join(dir, "gone.wav"), working, "clip.wav")).rejects.toMatchObject({
      message: expect.stringMatching(/Failed to create a readable working copy for clip\.wav/),
      cause: { code: "ENOENT" },
    });

    expect(await readdir(working), "the partial copy is cleaned up").toEqual([]);
  });

  it("still reports the real failure when the partial copy cannot be cleaned up", async () => {
    const working = join(dir, "working");
    await mkdir(working, { recursive: true });
    undeletable.add(join(working, "clip.wav"));

    await expect(copyToWorking(join(dir, "gone.wav"), working, "clip.wav")).rejects.toThrow(
      /Failed to create a readable working copy for clip\.wav/,
    );
  });

  it("files an original under the name it is given, with a lowercase suffix when a different recording holds it", async () => {
    const backup = join(dir, "backup");
    const first = join(dir, "Shibuya Station.m4a");
    const other = join(dir, "kitchen-table.m4a");
    await writeFile(first, "audio", "utf8");
    await writeFile(other, "other audio", "utf8");

    const filed = await copyOriginalToBackup(first, backup, "20261014-063012-utc.m4a");
    const different = await copyOriginalToBackup(other, backup, "20261014-063012-utc.m4a");

    expect(filed).toEqual({ path: join(backup, "20261014-063012-utc.m4a"), reused: false });
    expect(different.reused).toBe(false);
    expect(different.path).toMatch(/[/\\]20261014-063012-utc-[0-9a-z]{8}\.m4a$/);
    expect(await readFile(first, "utf8"), "the source stays for its caller to delete").toBe("audio");
  });

  it("finds the same recording already filed, under its name or a suffixed one, and copies nothing", async () => {
    const backup = join(dir, "backup");
    const recording = join(dir, "take.m4a");
    const other = join(dir, "other.m4a");
    await writeFile(recording, "audio", "utf8");
    await writeFile(other, "other audio", "utf8");
    await copyOriginalToBackup(other, backup, "20261014-063012-utc.m4a");
    const suffixed = await copyOriginalToBackup(recording, backup, "20261014-063012-utc.m4a");

    const again = await copyOriginalToBackup(recording, backup, "20261014-063012-utc.M4A".replace(".M4A", ".m4a"));

    expect(again).toEqual({ path: suffixed.path, reused: true });
    expect((await readdir(backup)).filter((name) => !name.startsWith("."))).toHaveLength(2);
  });

  it("files a same-size recording with different bytes as a new one", async () => {
    const backup = join(dir, "backup");
    const first = join(dir, "a.m4a");
    const second = join(dir, "b.m4a");
    await writeFile(first, "aaaa", "utf8");
    await writeFile(second, "bbbb", "utf8");
    await copyOriginalToBackup(first, backup, "20261014-063012-utc.m4a");
    expect((await copyOriginalToBackup(second, backup, "20261014-063012-utc.m4a")).reused).toBe(false);
  });

  it("copies an original into the chosen backup directory", async () => {
    const source = join(dir, "source.m4a");
    const backup = join(dir, "backup");
    await writeFile(source, "audio", "utf8");

    const { path: copied } = await copyOriginalToBackup(source, backup, "source.m4a");

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
    await expect(copyOriginalToBackup(source, backup, "source.m4a")).rejects.toMatchObject({ cause: { code: "EEXIST" } });
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
    const { path: copied } = await copyOriginalToBackup(source, backup, "source.m4a");
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
    await expect(copyOriginalToBackup(source, backup, "source.m4a")).rejects.toMatchObject({ cause: { code: "EEXIST" } });
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
    const { path: copied } = await copyOriginalToBackup(source, backup, "source.m4a", logger);
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
    await expect(copyOriginalToBackup(source, backup, "source.m4a")).rejects.toMatchObject({ cause: primary });
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
    const error = await copyOriginalToBackup(source, backup, "source.m4a").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ cause: primary, message: expect.stringContaining(join(backup, "source.m4a")) });
    expect(await readFile(source, "utf8")).toBe("complete audio");
    expect(await readFile(join(backup, "source.m4a"), "utf8")).toBe("partial");
    expect(await readdir(backup)).toEqual(["source.m4a"]);
  });

  // A fixed time well in the past, so a copy that took the moment of copying fails.
  const RECORDED = new Date(Date.UTC(2024, 4, 6, 7, 8, 9, 500));

  it.each([
    ["a working copy", (source: string) => copyToWorking(source, join(dir, "working"), "clip.wav")],
    ["a backup of the original", async (source: string) => (await copyOriginalToBackup(source, join(dir, "backup"), "source.m4a")).path],
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

    const working = await copyToWorking(source, join(dir, "working"), "clip.wav");
    const { path: backup } = await copyOriginalToBackup(source, join(dir, "backup"), "source.m4a");

    expect((await stat(working)).mode & 0o777).toBe(0o640);
    expect((await stat(backup)).mode & 0o777).toBe(0o640);
  });

  it("names the original that could not be backed up, keeping the filesystem's error as the cause", async () => {
    const source = join(dir, "gone.m4a");

    await expect(copyOriginalToBackup(source, join(dir, "backup"), "source.m4a")).rejects.toThrow(
      new RegExp(`Failed to copy ${source} into the Recordings folder`),
    );
    await expect(copyOriginalToBackup(source, join(dir, "backup"), "source.m4a")).rejects.toMatchObject({
      cause: { code: "ENOENT" },
    });
  });

  it("deletes the imported source the user asked to remove", async () => {
    const source = join(dir, "source.m4a");
    await writeFile(source, "audio", "utf8");

    const identity = sourceFileIdentity(await stat(source));
    await deleteImportedSource(source, identity);

    await expect(access(source)).rejects.toThrow();
  });
});
