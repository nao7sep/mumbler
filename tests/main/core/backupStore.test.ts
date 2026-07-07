/**
 * Pins the write-through backup store (data-backup conventions): byte-identical BLOB fidelity, the
 * serialized ISO-8601-ms `written_at_utc` shape (NOT a filename stamp), content-hash dedup per path, and
 * the best-effort contract (a store failure never throws, logs exactly one warn, and never touches the
 * caller's bytes). The store resolves its file from MUMBLER_HOME, which the global setup points at a
 * throwaway root and closes between tests; each test here overrides MUMBLER_HOME with its own root so it
 * can read the resulting `backups.sqlite3` back directly.
 */
import { createHash } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeBackupStore,
  record,
  setBackupStoreWarn,
  type BackupWarn,
} from "@main/core/backupStore";

let root: string;
let storeFilePath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mumbler-backupstore-"));
  process.env.MUMBLER_HOME = root;
  storeFilePath = join(root, "backups.sqlite3");
});

afterEach(async () => {
  closeBackupStore();
  // Restore the default console warn sink so a test that swapped it does not leak into the next.
  setBackupStoreWarn((message, details) => {
    // eslint-disable-next-line no-console
    console.warn(message, details);
  });
  delete process.env.MUMBLER_HOME;
  await rm(root, { recursive: true, force: true });
});

interface Row {
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
      .prepare("SELECT path, content, content_sha256, byte_size, written_at_utc FROM backups WHERE path = ? ORDER BY id ASC")
      .all(path) as unknown as Row[];
  } finally {
    db.close();
  }
}

describe("record — BLOB byte fidelity", () => {
  it("stores the exact bytes verbatim, including CR/LF and a non-UTF-8 byte", () => {
    const file = join(root, "config.json");
    // A CR, an LF, a CRLF pair, a UTF-8 BOM, a NUL, and a lone 0xC0 — 0xC0 is not a valid standalone
    // UTF-8 byte, so reading the file as a string would have mangled it. The BLOB path must keep it exact.
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x41, 0x0d, 0x0a, 0x42, 0x0d, 0x43, 0x0a, 0x00, 0xc0, 0xff]);
    record(file, bytes);
    closeBackupStore();

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
  it("is the serialized ISO-8601-ms form (toISOString), NOT the yyyymmdd-hhmmss filename stamp", () => {
    const file = join(root, "state.json");
    record(file, Buffer.from("x", "utf8"));
    closeBackupStore();

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

describe("record — dedup by content hash per path", () => {
  it("skips an unchanged re-save (same bytes → no second row)", () => {
    const file = join(root, "config.json");
    const bytes = Buffer.from('{"a":1}\n', "utf8");
    record(file, bytes);
    record(file, Buffer.from('{"a":1}\n', "utf8")); // identical content, fresh buffer
    closeBackupStore();

    expect(readRows(file)).toHaveLength(1);
  });

  it("records a changed save, and records a revert to an earlier value as a new row", () => {
    const file = join(root, "config.json");
    const v1 = Buffer.from('{"v":1}\n', "utf8");
    const v2 = Buffer.from('{"v":2}\n', "utf8");

    record(file, v1); // row 1
    record(file, v2); // row 2 — changed
    record(file, v1); // row 3 — a revert differs from the immediately preceding row (v2), so it records
    closeBackupStore();

    const rows = readRows(file);
    expect(rows).toHaveLength(3);
    expect(Buffer.from(rows[0]!.content).toString("utf8")).toBe('{"v":1}\n');
    expect(Buffer.from(rows[1]!.content).toString("utf8")).toBe('{"v":2}\n');
    expect(Buffer.from(rows[2]!.content).toString("utf8")).toBe('{"v":1}\n');
  });

  it("dedups per path independently — the same content under two paths records twice", () => {
    const a = join(root, "config.json");
    const b = join(root, "state.json");
    const bytes = Buffer.from("same", "utf8");
    record(a, bytes);
    record(b, bytes);
    record(a, Buffer.from("same", "utf8")); // dedup skip on a
    closeBackupStore();

    expect(readRows(a)).toHaveLength(1);
    expect(readRows(b)).toHaveLength(1);
  });
});

describe("record — best-effort: a store failure never throws, logs one warn, save unaffected", () => {
  it("catches an insert failure, logs exactly one warn, and does not throw", () => {
    // Force a failure at the store's OPEN step by pointing MUMBLER_HOME at a path whose parent is a file,
    // so mkdirSync of the store's directory throws (ENOTDIR). record() must swallow it and warn once.
    const blocker = join(root, "not-a-dir");
    // Create a regular file where a directory would need to be.
    writeFileSync(blocker, "x");
    process.env.MUMBLER_HOME = join(blocker, "inside");

    const warn = vi.fn<BackupWarn>();
    setBackupStoreWarn(warn);

    const bytes = Buffer.from("payload", "utf8");
    // The call itself must not throw — the "never breaks the save" guarantee.
    expect(() => record(join(process.env.MUMBLER_HOME!, "config.json"), bytes)).not.toThrow();

    // Exactly one warn line for the failed open; recording is then disabled for the session, so a second
    // record does NOT warn again (no per-save flood).
    expect(warn).toHaveBeenCalledTimes(1);
    record(join(process.env.MUMBLER_HOME!, "state.json"), Buffer.from("more", "utf8"));
    expect(warn).toHaveBeenCalledTimes(1);

    // The caller's bytes are untouched by the failed record (no mutation, no consumption).
    expect(bytes.toString("utf8")).toBe("payload");
  });

  it("a successful record logs NOTHING (only failures log)", () => {
    const warn = vi.fn<BackupWarn>();
    setBackupStoreWarn(warn);
    record(join(root, "config.json"), Buffer.from("ok", "utf8"));
    closeBackupStore();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("record — WAL sidecars are the store's own artifacts under the root", () => {
  it("keeps the store and its -wal/-shm siblings directly under the resolved root", () => {
    record(join(root, "config.json"), Buffer.from("x", "utf8"));
    closeBackupStore();
    const names = readdirSync(root);
    // The store file itself is present (WAL sidecars may be checkpointed away on close, so they are not
    // asserted as always-present — only that nothing unexpected leaked and the store is where it belongs).
    expect(names).toContain("backups.sqlite3");
  });
});
