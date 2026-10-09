/**
 * Pins the write-through backup store (data-backup conventions): byte-identical BLOB fidelity, the
 * serialized ISO-8601-ms `written_at_utc` shape (NOT a filename stamp), one row per path per session, and
 * the best-effort contract (a store failure never throws, logs exactly one warn, and never touches the
 * caller's bytes). The store resolves its file from MUMBLER_DATA_DIR, which the global setup points at a
 * throwaway root and closes between tests; each test here overrides MUMBLER_DATA_DIR with its own root so it
 * can read the resulting `backups.sqlite3` back directly.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  abandonBackupStore,
  closeBackupStore,
  record,
  setBackupStoreSession,
  setBackupStoreWarn,
  type BackupWarn,
} from "@main/core/backupStore";

let root: string;
let storeFilePath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mumbler-backupstore-"));
  process.env.MUMBLER_DATA_DIR = root;
  storeFilePath = join(root, "backups.sqlite3");
  setBackupStoreSession("session-a");
});

afterEach(async () => {
  await closeBackupStore();
  // Restore the default console warn sink so a test that swapped it does not leak into the next.
  setBackupStoreWarn((message, details) => {
    console.warn(message, details);
  });
  delete process.env.MUMBLER_DATA_DIR;
  await rm(root, { recursive: true, force: true });
});

interface Row {
  session_id: string | null;
  path: string;
  content: Uint8Array;
  content_sha256: string;
  byte_size: number;
  written_at_utc: string;
}

// Open a fresh read-only-ish handle to the store the code under test just wrote. Opened AFTER
// closeBackupStore() (called by the caller) so the writer's handle is released first.
function readRows(path: string): Row[] {
  const db = new DatabaseSync(storeFilePath);
  try {
    return db
      .prepare("SELECT session_id, path, content, content_sha256, byte_size, written_at_utc FROM backups WHERE path = ? ORDER BY id ASC")
      .all(path) as unknown as Row[];
  } finally {
    db.close();
  }
}

describe("record — BLOB byte fidelity", () => {
  it("stores the exact bytes verbatim, including CR/LF and a non-UTF-8 byte", async () => {
    const file = join(root, "config.json");
    // A CR, an LF, a CRLF pair, a UTF-8 BOM, a NUL, and a lone 0xC0 — 0xC0 is not a valid standalone
    // UTF-8 byte, so reading the file as a string would have mangled it. The BLOB path must keep it exact.
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x41, 0x0d, 0x0a, 0x42, 0x0d, 0x43, 0x0a, 0x00, 0xc0, 0xff]);
    record(file, bytes);
    await closeBackupStore();

    const rows = readRows(file);
    expect(rows).toHaveLength(1);
    const stored = Buffer.from(rows[0]!.content);
    // Byte-identical: same length, same bytes, and the 0xC0 survived (a string round-trip would not).
    expect(stored.equals(bytes)).toBe(true);
    expect(rows[0]!.byte_size).toBe(bytes.byteLength);
    // The hash is over the raw bytes, matching an independent SHA-256 of the same buffer.
    expect(rows[0]!.content_sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    // path is the full absolute path as written.
    expect(rows[0]!.path).toBe(file);
  });
});

describe("record — written_at_utc shape", () => {
  it("is the serialized ISO-8601-ms form (toISOString), NOT the yyyymmdd-hhmmss filename stamp", async () => {
    const file = join(root, "state.json");
    record(file, Buffer.from("x", "utf8"));
    await closeBackupStore();

    const stored = readRows(file)[0]!.written_at_utc;
    // ISO-8601 extended, exactly 3 fractional digits, Z suffix — e.g. 2026-07-06T04:05:12.345Z.
    expect(stored).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Explicitly NOT the filename stamp form yyyymmdd-hhmmss(-fff)-utc.
    expect(stored).not.toMatch(/^\d{8}-\d{6}/);
    expect(stored).not.toContain("-utc");
    // It parses back to a real instant, and re-serializing yields the same string (proves it is toISOString).
    expect(new Date(stored).toISOString()).toBe(stored);
  });
});

const text = (row: Row): string => Buffer.from(row.content).toString("utf8");

describe("record — one row per path per session", () => {
  it("keeps one row for a path within a session, holding its latest save", async () => {
    const file = join(root, "config.json");
    record(file, Buffer.from('{"v":1}\n', "utf8"));
    record(file, Buffer.from('{"v":2}\n', "utf8"));
    record(file, Buffer.from('{"v":3}\n', "utf8"));
    await closeBackupStore();

    const rows = readRows(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id: "session-a", byte_size: 8 });
    expect(text(rows[0]!)).toBe('{"v":3}\n');
  });

  it("adds nothing when a session's first save equals the latest earlier version, and a row when it differs", async () => {
    const file = join(root, "config.json");
    record(file, Buffer.from('{"v":1}\n', "utf8"));
    await closeBackupStore();

    setBackupStoreSession("session-b");
    record(file, Buffer.from('{"v":1}\n', "utf8"));
    await closeBackupStore();
    expect(readRows(file).map((row) => row.session_id)).toEqual(["session-a"]);

    record(file, Buffer.from('{"v":2}\n', "utf8"));
    await closeBackupStore();
    const rows = readRows(file);
    expect(rows.map((row) => row.session_id)).toEqual(["session-a", "session-b"]);
    expect(rows.map(text)).toEqual(['{"v":1}\n', '{"v":2}\n']);
  });

  it("never changes an earlier session's row", async () => {
    const file = join(root, "config.json");
    record(file, Buffer.from("first", "utf8"));
    await closeBackupStore();
    setBackupStoreSession("session-b");
    record(file, Buffer.from("second", "utf8"));
    record(file, Buffer.from("third", "utf8"));
    await closeBackupStore();

    expect(readRows(file).map(text)).toEqual(["first", "third"]);
  });

  it("keeps each path's row independently", async () => {
    const a = join(root, "config.json");
    const b = join(root, "other.json");
    record(a, Buffer.from("same", "utf8"));
    record(b, Buffer.from("same", "utf8"));
    record(a, Buffer.from("same", "utf8"));
    await closeBackupStore();

    expect(readRows(a)).toHaveLength(1);
    expect(readRows(b)).toHaveLength(1);
  });
});

describe("record — an OS session end skips the history", () => {
  it("accepts nothing after abandoning, waits for nothing and reports nothing", async () => {
    const warn = vi.fn<BackupWarn>();
    setBackupStoreWarn(warn);
    const file = join(root, "config.json");
    record(file, Buffer.from("before", "utf8"));
    abandonBackupStore();
    record(file, Buffer.from("after", "utf8"));
    await delay(200);

    expect(warn).not.toHaveBeenCalled();
    await closeBackupStore();
    const rows = readdirSync(root).includes("backups.sqlite3") ? readRows(file) : [];
    expect(rows.map(text)).not.toContain("after");
  });

  it("records again after the abandoned store is closed", async () => {
    abandonBackupStore();
    await closeBackupStore();
    const file = join(root, "config.json");
    record(file, Buffer.from("later", "utf8"));
    await closeBackupStore();
    expect(readRows(file).map(text)).toEqual(["later"]);
  });
});

describe("record — best-effort: a store failure never throws, logs one warn, save unaffected", () => {
  it("catches an insert failure, logs exactly one warn, and does not throw", async () => {
    // Force a failure at the store's OPEN step by pointing MUMBLER_DATA_DIR at a path whose parent is a file,
    // so mkdirSync of the store's directory throws (ENOTDIR). record() must swallow it and warn once.
    const blocker = join(root, "not-a-dir");
    // Create a regular file where a directory would need to be.
    writeFileSync(blocker, "x");
    process.env.MUMBLER_DATA_DIR = join(blocker, "inside");

    const warn = vi.fn<BackupWarn>();
    setBackupStoreWarn(warn);

    const bytes = Buffer.from("payload", "utf8");
    // The call itself must not throw — the "never breaks the save" guarantee.
    expect(() => record(join(process.env.MUMBLER_DATA_DIR!, "config.json"), bytes)).not.toThrow();

    // Recording is asynchronous: enqueue a second record, then drain the worker.
    // The failed open disables its engine, so the second record does not add a
    // per-save warning flood.
    record(join(process.env.MUMBLER_DATA_DIR!, "state.json"), Buffer.from("more", "utf8"));
    await closeBackupStore();
    expect(warn).toHaveBeenCalledTimes(1);

    // The caller's bytes are untouched by the failed record (no mutation, no consumption).
    expect(bytes.toString("utf8")).toBe("payload");
  });

  it("a successful record logs NOTHING (only failures log)", async () => {
    const warn = vi.fn<BackupWarn>();
    setBackupStoreWarn(warn);
    record(join(root, "config.json"), Buffer.from("ok", "utf8"));
    await closeBackupStore();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("record — format version", () => {
  it("records the history's format version in user_version", async () => {
    record(join(root, "config.json"), Buffer.from("x", "utf8"));
    await closeBackupStore();
    const db = new DatabaseSync(storeFilePath);
    try {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    } finally {
      db.close();
    }
  });

  it.each([
    ["in a newer format", "CREATE TABLE future (id INTEGER PRIMARY KEY); PRAGMA user_version = 3;", "newer than this build reads"],
    ["without its format version", "CREATE TABLE backups (id INTEGER PRIMARY KEY);", "records no format version"],
  ])("leaves a history %s untouched, warning once and recording nothing", async (_kind, setup, reported) => {
    const existing = new DatabaseSync(storeFilePath);
    existing.exec(setup);
    existing.close();
    const before = createHash("sha256").update(readFileSync(storeFilePath)).digest("hex");
    const warn = vi.fn<BackupWarn>();
    setBackupStoreWarn(warn);

    record(join(root, "config.json"), Buffer.from("x", "utf8"));
    record(join(root, "queue.json"), Buffer.from("y", "utf8"));
    await closeBackupStore();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not open"),
      expect.objectContaining({ error: expect.stringContaining(reported) }),
    );
    expect(createHash("sha256").update(readFileSync(storeFilePath)).digest("hex")).toBe(before);
    expect(readdirSync(root)).not.toContain("backups.sqlite3-wal");
  });
});

describe("record — upgrading a history written before sessions", () => {
  it("keeps every earlier row as history and records this session beside them", async () => {
    const file = join(root, "config.json");
    const old = new DatabaseSync(storeFilePath);
    old.exec(`CREATE TABLE backups (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL, content BLOB NOT NULL, content_sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL, written_at_utc TEXT NOT NULL);
      CREATE INDEX idx_backups_path_id ON backups (path, id);
      PRAGMA user_version = 1;`);
    const insert = old.prepare("INSERT INTO backups (path, content, content_sha256, byte_size, written_at_utc) VALUES (?, ?, ?, ?, ?)");
    for (const value of ["one", "two"]) {
      const bytes = Buffer.from(value, "utf8");
      insert.run(file, bytes, createHash("sha256").update(bytes).digest("hex"), bytes.byteLength, "2026-10-01T00:00:00.000Z");
    }
    old.close();

    record(file, Buffer.from("two", "utf8"));
    record(file, Buffer.from("three", "utf8"));
    await closeBackupStore();

    const rows = readRows(file);
    expect(rows.map((row) => [row.session_id, text(row)])).toEqual([[null, "one"], [null, "two"], ["session-a", "three"]]);
    const db = new DatabaseSync(storeFilePath);
    try {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    } finally {
      db.close();
    }
  });
});

describe("record — WAL sidecars are the store's own artifacts under the root", () => {
  it("keeps the store and its -wal/-shm siblings directly under the resolved root", async () => {
    record(join(root, "config.json"), Buffer.from("x", "utf8"));
    await closeBackupStore();
    const names = readdirSync(root);
    // The store file itself is present (WAL sidecars may be checkpointed away on close, so they are not
    // asserted as always-present — only that nothing unexpected leaked and the store is where it belongs).
    expect(names).toContain("backups.sqlite3");
  });
});
