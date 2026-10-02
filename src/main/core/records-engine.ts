import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// The records database (data-lifecycle-conventions, Records): one row per log
// line or provider call, each carrying its session, its time and the card it
// belongs to. Fields named in JSON_FIELDS hold JSON text.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS logs (
  id      INTEGER PRIMARY KEY,
  session TEXT NOT NULL,
  time    TEXT NOT NULL,
  level   TEXT NOT NULL,
  op      TEXT NOT NULL,
  message TEXT NOT NULL,
  card_id TEXT,
  details TEXT,
  error   TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_session ON logs (session);
CREATE INDEX IF NOT EXISTS idx_logs_card_id ON logs (card_id);
CREATE TABLE IF NOT EXISTS provider_calls (
  id          INTEGER PRIMARY KEY,
  session     TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  card_id     TEXT,
  step        TEXT,
  attempt     INTEGER,
  provider    TEXT NOT NULL,
  operation   TEXT NOT NULL,
  endpoint    TEXT,
  model       TEXT,
  request     TEXT NOT NULL,
  response    TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_provider_calls_session ON provider_calls (session);
CREATE INDEX IF NOT EXISTS idx_provider_calls_card_id ON provider_calls (card_id);
`;

export interface LogEntry {
  kind: "log";
  session: string;
  time: string;
  level: string;
  op: string;
  message: string;
  cardId: string | null;
  details: string | null;
  error: string | null;
}

export interface ProviderCallEntry {
  kind: "provider-call";
  session: string;
  startedAt: string;
  finishedAt: string;
  cardId: string | null;
  step: string | null;
  attempt: number | null;
  provider: string;
  operation: string;
  endpoint: string | null;
  model: string | null;
  request: string;
  response: string | null;
  error: string | null;
}

export type RecordEntry = LogEntry | ProviderCallEntry;

export type RecordsWorkerRequest =
  | { type: "write"; id: number; entry: RecordEntry }
  | { type: "close" };

export type RecordsWorkerResponse =
  | { type: "written"; id: number }
  | { type: "closed" };

export interface RecordsTarget {
  databasePath: string;
  fallbackPath: string;
}

const JSON_FIELDS = new Set(["details", "error", "request", "response"]);

// One entry as one JSON line, its JSON-text fields spliced in as objects.
export function fallbackLine(entry: RecordEntry): string {
  const fields = Object.entries(entry).map(([key, value]) =>
    `${JSON.stringify(key)}:${JSON_FIELDS.has(key) && value !== null ? value : JSON.stringify(value)}`,
  );
  return `{${fields.join(",")}}\n`;
}

export function reportRecordsFailure(error: unknown, line?: string): void {
  try {
    process.stderr.write(`[mumbler:records] ${errorInfo(error)}\n${line ?? ""}`);
  } catch {
    // Nothing is left to report to; recording must never take the app down.
  }
}

export class RecordsEngine {
  private db: DatabaseSync | null = null;
  private opened = false;
  private readonly target: RecordsTarget;

  constructor(target: RecordsTarget) {
    this.target = target;
  }

  write(entry: RecordEntry): void {
    try {
      this.insert(this.open(), entry);
    } catch (error: unknown) {
      reportRecordsFailure(error);
      this.writeFallback(entry);
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch (error: unknown) {
      reportRecordsFailure(error);
    }
    this.db = null;
    this.opened = false;
  }

  private open(): DatabaseSync {
    if (this.db !== null) return this.db;
    if (this.opened) throw new Error(`records database is unavailable: ${this.target.databasePath}`);
    this.opened = true;
    mkdirSync(path.dirname(this.target.databasePath), { recursive: true });
    const db = new DatabaseSync(this.target.databasePath);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec(SCHEMA);
    } catch (error: unknown) {
      db.close();
      throw error;
    }
    this.db = db;
    return db;
  }

  private insert(db: DatabaseSync, entry: RecordEntry): void {
    if (entry.kind === "log") {
      db.prepare(
        "INSERT INTO logs (session, time, level, op, message, card_id, details, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(entry.session, entry.time, entry.level, entry.op, entry.message, entry.cardId, entry.details, entry.error);
      return;
    }
    db.prepare(
      `INSERT INTO provider_calls (session, started_at, finished_at, card_id, step, attempt, provider, operation,
        endpoint, model, request, response, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.session, entry.startedAt, entry.finishedAt, entry.cardId, entry.step, entry.attempt, entry.provider,
      entry.operation, entry.endpoint, entry.model, entry.request, entry.response, entry.error,
    );
  }

  private writeFallback(entry: RecordEntry): void {
    const line = fallbackLine(entry);
    try {
      mkdirSync(path.dirname(this.target.fallbackPath), { recursive: true });
      appendFileSync(this.target.fallbackPath, line, "utf8");
    } catch (error: unknown) {
      reportRecordsFailure(error, line);
    }
  }
}

function errorInfo(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
