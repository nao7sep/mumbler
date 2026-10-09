import { chmod, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { backupRecord, capturedRenames, writeEvents, stageModes, faults } = vi.hoisted(() => {
  const events: string[] = [];
  return {
    backupRecord: vi.fn((path: string, _bytes: Buffer): void => {
      events.push(`record:${path}`);
    }),
    capturedRenames: [] as Array<{ source: string; destination: string }>,
    faults: { tempId: null as string | null, cleanup: false, rename: null as Error | null },
    writeEvents: events,
    stageModes: [] as Array<{ mode: number; size: number }>,
  };
});

vi.mock("nanoid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nanoid")>();
  return { ...actual, nanoid: (size?: number) => faults.tempId ?? actual.nanoid(size) };
});

vi.mock("@main/core/backupStore", () => ({ record: backupRecord }));

// Observes (without altering) every rename the module under test performs, so the
// atomic-write temp-file and quarantine-file shapes can be pinned without new
// production-code hooks. Every other fs operation runs for real.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[1] === "wx") {
        const info = await handle.stat();
        stageModes.push({ mode: info.mode & 0o777, size: info.size });
      }
      return handle;
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (faults.cleanup && String(args[0]).endsWith(".tmp")) throw new Error("cleanup failed");
      return actual.rm(...args);
    },
    rename: async (source: string, destination: string) => {
      if (faults.rename !== null) throw faults.rename;
      await actual.rename(source, destination);
      capturedRenames.push({ source: String(source), destination: String(destination) });
      writeEvents.push(`rename:${destination}`);
    },
  };
});

const { preserveAside, sameFileBytes, uniquePathInDirectory, writeJsonFile } = await import("@main/core/file-io");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mumbler-file-io-"));
  faults.tempId = null;
  faults.cleanup = false;
  capturedRenames.length = 0;
  stageModes.length = 0;
  writeEvents.length = 0;
  backupRecord.mockClear();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("uniquePathInDirectory", () => {
  it("returns the requested name unchanged when the directory is empty", async () => {
    const path = await uniquePathInDirectory(dir, "clip.wav");
    expect(dirname(path)).toBe(dir);
    expect(basename(path)).toBe("clip.wav");
  });

  it("disambiguates a name that collides case-insensitively", async () => {
    // "Clip.wav" already on disk; "clip.wav" would silently clobber it on the
    // case-insensitive filesystems (macOS/Windows) the invariant guards against.
    await writeFile(join(dir, "Clip.wav"), "existing");

    const path = await uniquePathInDirectory(dir, "clip.wav");

    expect(basename(path).toLowerCase()).not.toBe("clip.wav");
    expect(basename(path)).toMatch(/^clip-[^.]+\.wav$/);
  });
});

describe("writeJsonFile", () => {
  it("names its atomic-write temp file <stem>-<nanoid>.tmp in the target's own directory", async () => {
    const target = join(dir, "config.json");

    await writeJsonFile(target, { hello: "world" });

    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ hello: "world" });

    const tempRenames = capturedRenames.filter((r) => r.destination === target);
    expect(tempRenames).toHaveLength(1);
    expect(dirname(tempRenames[0]!.source)).toBe(dir);
    expect(basename(tempRenames[0]!.source)).toMatch(/^config-[\w-]{8}\.tmp$/);
  });
});

describe.skipIf(process.platform === "win32")("writeJsonFile — the replaced file's mode", () => {
  it("keeps the mode of the file it replaces", async () => {
    const target = join(dir, "config.json");
    await writeJsonFile(target, { version: 1 });
    await chmod(target, 0o640);

    await writeJsonFile(target, { version: 2 });

    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ version: 2 });
    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });

  it("applies an explicit mode instead, as the secrets file does", async () => {
    const target = join(dir, "api-keys.json");
    await writeJsonFile(target, { version: 1 });
    await chmod(target, 0o644);

    await writeJsonFile(target, { version: 2 }, { mode: 0o600, record: false });

    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });
});

describe("writeJsonFile — a write that changes nothing", () => {
  it("leaves a file that already holds the same bytes untouched", async () => {
    const target = join(dir, "queue.json");
    await writeJsonFile(target, { formatVersion: 1, cards: [] });
    const earlier = new Date(Date.UTC(2024, 4, 6, 7, 8, 9));
    await utimes(target, earlier, earlier);
    capturedRenames.length = 0;
    backupRecord.mockClear();

    await writeJsonFile(target, { formatVersion: 1, cards: [] });

    expect((await stat(target)).mtime.getTime()).toBe(earlier.getTime());
    expect(capturedRenames).toEqual([]);
    expect(backupRecord).not.toHaveBeenCalled();
  });

  it("still writes a change", async () => {
    const target = join(dir, "queue.json");
    await writeJsonFile(target, { formatVersion: 1, cards: [] });

    await writeJsonFile(target, { formatVersion: 1, cards: ["x"] });

    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ formatVersion: 1, cards: ["x"] });
  });
});

describe("sameFileBytes", () => {
  it("tells identical files from ones that differ in a byte or in length", async () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((name) => join(dir, name));
    await writeFile(a, "same bytes");
    await writeFile(b, "same bytes");
    await writeFile(c, "same bytez");
    await writeFile(d, "same bytes and more");

    expect(await sameFileBytes(a, b)).toBe(true);
    expect(await sameFileBytes(a, c)).toBe(false);
    expect(await sameFileBytes(a, d)).toBe(false);
  });
});

// The data-backup hook lives in exactly this one choke point (data-backup conventions). This file-I/O suite
// mocks that boundary so it can pin the exact call and its ordering without starting the worker or SQLite;
// backupStore.test.ts owns the real worker/database integration.
describe("writeJsonFile — data-backup record hook", () => {
  it("records the exact bytes just written, strictly AFTER the rename lands", async () => {
    const target = join(dir, "config.json");

    await writeJsonFile(target, { hello: "world" }, { record: true });

    const onDisk = await readFile(target);
    expect(backupRecord).toHaveBeenCalledOnce();
    expect(backupRecord).toHaveBeenCalledWith(target, onDisk);
    expect(writeEvents).toEqual([`rename:${target}`, `record:${target}`]);
  });

  it("does NOT record when record:false (the secrets-file opt-out)", async () => {
    const secret = join(dir, "api-keys.json");

    await writeJsonFile(secret, { keys: { gemini: "obf:zzz" } }, { record: false });

    expect(backupRecord).not.toHaveBeenCalled();
    expect(writeEvents).toEqual([`rename:${secret}`]);
  });

  it("records nothing by default: a store opts in at its own write boundary", async () => {
    const target = join(dir, "queue.json");

    await writeJsonFile(target, { formatVersion: 1 });

    expect(backupRecord).not.toHaveBeenCalled();
    expect(writeEvents).toEqual([`rename:${target}`]);
  });
});

describe("preserveAside", () => {
  it("quarantines an existing file as <stem>-<yyyymmdd-hhmmss-fff-utc>.invalid in the same directory", async () => {
    const target = join(dir, "state.json");
    await writeFile(target, "not valid json");

    const preserved = await preserveAside(target);

    expect(preserved).not.toBeNull();
    expect(dirname(preserved!)).toBe(dir);
    expect(basename(preserved!)).toMatch(/^state-\d{8}-\d{6}-\d{3}-utc\.invalid$/);
    expect(await readFile(preserved!, "utf8")).toBe("not valid json");
  });

  it("returns null without renaming anything when the file does not exist", async () => {
    const target = join(dir, "missing.json");
    expect(await preserveAside(target)).toBeNull();
    expect(capturedRenames).toEqual([]);
  });
});


it.skipIf(process.platform === "win32")("creates private staging before writing any secret bytes", async () => {
  await writeJsonFile(join(dir, "secret.json"), { secret: "key" }, { mode: 0o600, record: false });
  expect(stageModes).toEqual([{ mode: 0o600, size: 0 }]);
});

it.skipIf(process.platform === "win32")("creates replacement staging with the existing restricted mode", async () => {
  const target = join(dir, "config.json");
  await writeFile(target, "old", { mode: 0o600 });
  await writeJsonFile(target, { updated: true });
  expect(stageModes).toEqual([{ mode: 0o600, size: 0 }]);
});

it("preserves a failed publication and removes only its staged file", async () => {
  const target = join(dir, "config.json");
  await writeFile(target, "old");
  const primary = new Error("rename refused");
  faults.rename = primary;
  try {
    await expect(writeJsonFile(target, { updated: true })).rejects.toBe(primary);
  } finally { faults.rename = null; }
  expect(await readFile(target, "utf8")).toBe("old");
  expect(await readdir(dir)).toEqual(["config.json"]);
});


it("does not remove or overwrite another writer's colliding staging file", async () => {
  faults.tempId = "collision";
  const foreign = join(dir, "config-collision.tmp");
  await writeFile(foreign, "foreign bytes");
  await expect(writeJsonFile(join(dir, "config.json"), { updated: true })).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(foreign, "utf8")).toBe("foreign bytes");
  expect(await readdir(dir)).toEqual(["config-collision.tmp"]);
});

it("cleanup failure does not replace the primary publication error", async () => {
  const primary = new Error("rename refused");
  faults.cleanup = true;
  faults.rename = primary;
  try {
    await expect(writeJsonFile(join(dir, "config.json"), { updated: true })).rejects.toBe(primary);
    expect(await readdir(dir)).toHaveLength(1);
  } finally { faults.cleanup = false; faults.rename = null; }
});
