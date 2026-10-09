import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { FORMAT_VERSIONS } from "./format-versions.ts";
import { openVersionedDatabase, type UpgradeDatabase } from "./sqlite-store.ts";

export type BackupEngineWarn = (message: string, details: Record<string, unknown>) => void;

// One row per file per session (one process launch): the session's first save
// of a path inserts its row, and later saves that session replace its content
// (data-backup-conventions). Rows of earlier sessions are never changed.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS backups (
  id             INTEGER PRIMARY KEY,
  session_id     TEXT,
  path           TEXT NOT NULL,
  content        BLOB NOT NULL,
  content_sha256 TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  written_at_utc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backups_path_id ON backups (path, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_backups_path_session ON backups (path, session_id);
`;

// Format 1 had no sessions: its rows stay as earlier history, with a NULL
// session_id, which the unique index lets repeat.
const upgrade: UpgradeDatabase = (db, recorded) => {
  if (recorded < 2) db.exec("ALTER TABLE backups ADD COLUMN session_id TEXT");
};

export class BackupStoreEngine {
  private db: DatabaseSync | null = null;
  private initialized = false;
  private failureReported = false;
  private readonly file: string;
  private readonly session: string;
  private readonly warn: BackupEngineWarn;

  constructor(file: string, session: string, warn: BackupEngineWarn) {
    this.file = file;
    this.session = session;
    this.warn = warn;
  }

  record(absolutePath: string, bytes: Uint8Array, writtenAtUtc: string): void {
    const store = this.ensureOpen();
    if (store === null) return;
    let transactionOpen = false;
    try {
      const content = Buffer.from(bytes);
      const hash = createHash("sha256").update(content).digest("hex");
      // The latest-row check and the write share one writer transaction, so the
      // decision is made on the row it changes.
      store.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      const latest = store
        .prepare("SELECT session_id AS session, content_sha256 AS h FROM backups WHERE path = ? ORDER BY id DESC LIMIT 1")
        .get(absolutePath) as { session: string | null; h: string } | undefined;
      // A session's first save that equals the latest earlier version adds nothing.
      if (latest === undefined || latest.session === this.session || latest.h !== hash) {
        store
          .prepare(
            `INSERT INTO backups (session_id, path, content, content_sha256, byte_size, written_at_utc)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (path, session_id) DO UPDATE SET content = excluded.content,
               content_sha256 = excluded.content_sha256, byte_size = excluded.byte_size,
               written_at_utc = excluded.written_at_utc`,
          )
          .run(this.session, absolutePath, content, hash, content.byteLength, writtenAtUtc);
      }
      store.exec("COMMIT");
      transactionOpen = false;
    } catch (error: unknown) {
      if (transactionOpen) {
        try {
          store.exec("ROLLBACK");
        } catch {
          // Preserve the original record failure in the single warning below.
        }
      }
      this.warnOnce("backup store: failed to record a managed write", {
        file: absolutePath,
        error: errorInfo(error),
      });
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // A close failure cannot affect a save that already landed.
    }
    this.db = null;
    this.initialized = false;
  }

  private ensureOpen(): DatabaseSync | null {
    if (this.initialized) return this.db;
    this.initialized = true;
    try {
      // A history in a newer format is left untouched, like any other that
      // cannot be opened: recording stays off for the session.
      this.db = openVersionedDatabase(this.file, FORMAT_VERSIONS.backups, SCHEMA, (error) => {
        this.warnOnce("backup store: initialization cleanup failed", { file: this.file, error: errorInfo(error) });
      }, upgrade);
    } catch (error: unknown) {
      this.warnOnce("backup store: could not open; recording disabled for this session", {
        file: this.file,
        error: errorInfo(error),
      });
      this.db = null;
    }
    return this.db;
  }

  private warnOnce(message: string, details: Record<string, unknown>): void {
    if (this.failureReported) return;
    this.failureReported = true;
    this.warn(message, details);
  }
}

function errorInfo(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
