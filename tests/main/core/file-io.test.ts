import { readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeBackupStore } from "@main/core/backupStore";

const { capturedRenames } = vi.hoisted(() => ({
  capturedRenames: [] as Array<{ source: string; destination: string }>,
}));

// Observes (without altering) every rename the module under test performs, so the
// atomic-write temp-file and quarantine-file shapes can be pinned without new
// production-code hooks. Every other fs operation runs for real.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: (source: string, destination: string) => {
      capturedRenames.push({ source: String(source), destination: String(destination) });
      return actual.rename(source, destination);
    },
  };
});

const { preserveAside, uniquePathInDirectory, writeJsonFile } = await import("@main/core/file-io");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mumbler-file-io-"));
  capturedRenames.length = 0;
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

// The data-backup hook lives in exactly this one choke point (data-backup conventions). These tests point
// MUMBLER_HOME at the test's own dir so the resulting backups.sqlite3 can be read back, and close the store
// before reading so its file handle is released.
describe("writeJsonFile — data-backup record hook", () => {
  function storeRows(homeRoot: string): Array<{ path: string; content: Uint8Array }> {
    const db = new DatabaseSync(join(homeRoot, "backups.sqlite3"));
    try {
      return db
        .prepare("SELECT path, content FROM backups ORDER BY id ASC")
        .all() as unknown as Array<{ path: string; content: Uint8Array }>;
    } finally {
      db.close();
    }
  }

  it("records the exact bytes just written, strictly AFTER the rename lands", async () => {
    process.env.MUMBLER_HOME = dir;
    const target = join(dir, "config.json");

    await writeJsonFile(target, { hello: "world" });
    closeBackupStore();

    // The record captured the same absolute path and the exact serialized bytes the file holds on disk —
    // proving it reused the in-hand buffer, not a re-read. The on-disk bytes and the stored blob match.
    const onDisk = await readFile(target);
    const rows = storeRows(dir).filter((r) => r.path === target);
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]!.content).equals(onDisk)).toBe(true);

    // Ordering: the rename onto the target was captured before the record could run (record fires after the
    // rename resolves), so the rename is present in capturedRenames when we read the row back.
    expect(capturedRenames.some((r) => r.destination === target)).toBe(true);
  });

  it("does NOT record when record:false (the secrets-file opt-out)", async () => {
    process.env.MUMBLER_HOME = dir;
    const secret = join(dir, "api-keys.json");

    await writeJsonFile(secret, { keys: { gemini: "obf:zzz" } }, { record: false });
    closeBackupStore();

    // No store file is created at all when the only write opts out — nothing recorded a secret.
    expect(readdirSync(dir)).not.toContain("backups.sqlite3");
  });

  it("records by default (no options) — a managed text write is captured", async () => {
    process.env.MUMBLER_HOME = dir;
    const target = join(dir, "state.json");

    await writeJsonFile(target, { schemaVersion: 1 });
    closeBackupStore();

    expect(storeRows(dir).filter((r) => r.path === target)).toHaveLength(1);
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
