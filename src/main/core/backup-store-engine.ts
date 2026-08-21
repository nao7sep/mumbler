import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type BackupEngineWarn = (message: string, details: Record<string, unknown>) => void;

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

export class BackupStoreEngine {
  private db: DatabaseSync | null = null;
  private initialized = false;
  private failureReported = false;
  private readonly file: string;
  private readonly warn: BackupEngineWarn;

  constructor(file: string, warn: BackupEngineWarn) {
    this.file = file;
    this.warn = warn;
  }

  record(absolutePath: string, bytes: Uint8Array, writtenAtUtc: string): void {
    const store = this.ensureOpen();
    if (store === null) return;
    try {
      const content = Buffer.from(bytes);
      const hash = createHash("sha256").update(content).digest("hex");
      const latest = store
        .prepare("SELECT content_sha256 AS h FROM backups WHERE path = ? ORDER BY id DESC LIMIT 1")
        .get(absolutePath) as { h: string } | undefined;
      if (latest?.h === hash) return;

      store
        .prepare(
          "INSERT INTO backups (path, content, content_sha256, byte_size, written_at_utc) VALUES (?, ?, ?, ?, ?)",
        )
        .run(absolutePath, content, hash, content.byteLength, writtenAtUtc);
    } catch (error: unknown) {
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
      mkdirSync(path.dirname(this.file), { recursive: true });
      const opened = new DatabaseSync(this.file);
      opened.exec("PRAGMA journal_mode = WAL");
      opened.exec("PRAGMA busy_timeout = 5000");
      opened.exec(SCHEMA);
      this.db = opened;
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
