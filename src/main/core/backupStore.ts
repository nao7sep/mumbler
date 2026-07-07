/**
 * The write-through data-backup store (data-backup conventions). It owns one add-only SQLite file,
 * `backups.sqlite3`, directly under mumbler's storage root (`MUMBLER_HOME` or `~/.mumbler`, resolved in one
 * place by {@link storageRoot} — never a hardcoded path). Every managed *text* save records the exact bytes
 * it just wrote here, strictly AFTER its atomic rename lands, so the history is always as current as the
 * last save. There is no startup scan, no periodic pass, no restore path — this replaces the retired
 * startup-scan ZIP engine.
 *
 * SQLite binding: Node's built-in `node:sqlite` (`DatabaseSync`), not better-sqlite3. In an Electron main
 * process better-sqlite3 is a native addon that must be rebuilt against Electron's Node ABI on every
 * Electron bump — real, recurring packaging drag. `node:sqlite` is built into Node (mumbler runs on Node
 * 26 / Electron 43), needs no native build, no `node-gyp`, no `electron-rebuild`, and is synchronous
 * exactly like better-sqlite3 — which is what a record-after-rename hook wants. It returns a BLOB as a
 * `Uint8Array`, wrapped in a Buffer here for byte-identical hashing and compare.
 *
 * Two absolute musts drive every line below (they are not best-effort aspirations):
 *
 *  - It never breaks a save and never crashes the app. The save has already succeeded — the file is on disk
 *    before {@link record} is called — so any failure here (the DB is locked, the disk is full, an insert
 *    throws) is caught, logged once at `warn`, and swallowed. A lost record self-heals on the next save of
 *    that file, whose content will differ from the last recorded row.
 *  - It logs only failures. A successful record logs NOTHING; a line per save would flood the log.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { storageRoot } from "./storage-root";

/** The one-line warn sink the store uses for its (only) failure logs. The runtime wires this to the
 *  per-launch session logger at startup ({@link setBackupStoreWarn}); until then, and in tests, it degrades
 *  to `console.warn` so a failure is never silently lost. */
export type BackupWarn = (message: string, details: Record<string, unknown>) => void;

let warn: BackupWarn = (message, details) => {
  // eslint-disable-next-line no-console -- the pre-wire / test fallback for the store's single failure log.
  console.warn(message, details);
};

/** Point the store's failure log at the app's per-launch logger (called once at startup). Keeps the store
 *  free of any electron/logger import while still logging through the same session log as the rest of the
 *  app. */
export function setBackupStoreWarn(sink: BackupWarn): void {
  warn = sink;
}

/** The store file under the resolved storage root. Computed lazily (not frozen into a module constant at
 *  import time) so `MUMBLER_HOME` is read after the environment is set, per the storage-path convention's
 *  caution against import-time resolution. */
function storeFile(): string {
  return path.join(storageRoot(), "backups.sqlite3");
}

/**
 * The one add-only table. `content` is a BLOB of the exact bytes written — never decoded text, so CR/LF, a
 * BOM, and non-UTF-8 bytes are stored byte-identically. `written_at_utc` is the serialized ISO-8601-ms form
 * (`2026-07-06T04:05:12.345Z` — `Date#toISOString()`), a data value — NEVER the `yyyymmdd-hhmmss-fff-utc`
 * filename stamp. The `(path, id)` index serves the latest-row-per-path dedup lookup.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS backups (
  id             INTEGER PRIMARY KEY,
  path           TEXT NOT NULL,
  content        BLOB NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  written_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backups_path_id ON backups (path, id);
`;

/** Module-level singleton, resolved once. `null` DB means recording is disabled for this session because
 *  the store could not be opened — a single warn was already logged; every later `record` becomes a no-op
 *  rather than retrying (and re-logging) a broken open on every save. */
let db: DatabaseSync | null = null;
let initialized = false;

/**
 * Open and initialize the store once (create the table if absent, switch on WAL, set busy_timeout).
 * Best-effort: on any failure it logs ONE warn, leaves recording disabled for the session, and never
 * throws. WAL is what lets the tolerated two-instance case (two mumbler windows writing at once) serialize
 * safely without a cross-process lock.
 */
function ensureOpen(): DatabaseSync | null {
  if (initialized) return db;
  initialized = true;
  try {
    const file = storeFile();
    // not recorded: backups.sqlite3 is the store itself — binary, and written by this backup layer, not
    // through the managed-text atomic-write path — so it never records itself. No recursion, no special
    // case (data-backup conventions: "A binary store, excluded from itself").
    // The first writer under the root does the `mkdir -p` (storage-path convention); the store may be the
    // first thing written on a fresh root.
    mkdirSync(path.dirname(file), { recursive: true });
    const opened = new DatabaseSync(file);
    opened.exec("PRAGMA journal_mode = WAL");
    // busy_timeout: under the tolerated two-instance case, a contended write waits up to this long for
    // SQLite's write lock instead of immediately failing with SQLITE_BUSY and dropping that record.
    opened.exec("PRAGMA busy_timeout = 5000");
    opened.exec(SCHEMA);
    db = opened;
  } catch (err) {
    warn("backup store: could not open; recording disabled for this session", {
      file: storeFile(),
      error: errorInfo(err),
    });
    db = null;
  }
  return db;
}

/** SHA-256 of the exact bytes, lowercase hex. */
function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Record one managed-text write: `absolutePath` is the FULL absolute path of the file as written; `bytes`
 * is the exact raw bytes just written (the caller already holds them — never re-read the file).
 *
 * Dedup by content hash per path: the new content's SHA-256 is compared against the latest row for the same
 * `path`, and the insert is SKIPPED when they are equal. This collapses consecutive identical saves (an
 * autosave with no real change writes no row) while still recording every genuinely distinct version —
 * including a revert, whose content differs from the immediately preceding row.
 *
 * Best-effort and silent on success; any failure is caught, logged once at `warn` (file + reason), and
 * swallowed. It never throws, never crashes the app, and never breaks the save.
 */
export function record(absolutePath: string, bytes: Buffer): void {
  const store = ensureOpen();
  if (!store) return; // open failed earlier; disabled for the session (already warned once)
  try {
    const hash = sha256(bytes);
    const latest = store
      .prepare("SELECT content_sha256 AS h FROM backups WHERE path = ? ORDER BY id DESC LIMIT 1")
      .get(absolutePath) as { h: string } | undefined;
    if (latest?.h === hash) return; // unchanged since the last recorded version — dedup skip

    store
      .prepare(
        "INSERT INTO backups (path, content, content_sha256, byte_size, written_at_utc) VALUES (?, ?, ?, ?, ?)",
      )
      .run(absolutePath, bytes, hash, bytes.byteLength, new Date().toISOString());
  } catch (err) {
    warn("backup store: failed to record a managed write", {
      file: absolutePath,
      error: errorInfo(err),
    });
  }
}

/** Close the store (best-effort). For tests that need to release the file handle between throwaway roots;
 *  the app itself lets the process exit close it. Resets the singleton so the next {@link record} re-opens
 *  against the current `MUMBLER_HOME`. */
export function closeBackupStore(): void {
  try {
    db?.close();
  } catch {
    // best-effort: a close failure on shutdown/teardown is harmless
  }
  db = null;
  initialized = false;
}

/** A compact, always-serializable description of a thrown value for the one warn line. */
function errorInfo(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
