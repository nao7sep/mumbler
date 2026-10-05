import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type {
  RecordDetail,
  RecordKind,
  RecordsPage,
  RecordsQuery,
  RecordSummary,
} from "@shared/records";

import { FORMAT_VERSIONS } from "./format-versions.ts";
import { openVersionedDatabase } from "./sqlite-store.ts";

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

// What the records window asks of the database. Reads go through the same
// worker as writes, so a read sees every entry given before it.
export type RecordsRead =
  | { op: "page"; query: RecordsQuery }
  | { op: "sources" }
  | { op: "detail"; kind: RecordKind; id: number };

export interface RecordsReadResults {
  page: RecordsPage;
  sources: { sessions: string[]; cardIds: string[] };
  detail: RecordDetail | null;
}

export type RecordsWorkerRequest =
  | { type: "write"; id: number; entry: RecordEntry }
  | { type: "read"; id: number; read: RecordsRead }
  | { type: "close" };

export type RecordsWorkerResponse =
  // `stored` is false when the entry went to the fallback file instead.
  | { type: "written"; id: number; stored: boolean }
  | { type: "read"; id: number; ok: true; value: RecordsReadResults[RecordsRead["op"]] }
  | { type: "read"; id: number; ok: false; error: string }
  | { type: "closed" }
  | { type: "report"; text: string };

export const RECORDS_PAGE_SIZE = 100;

// A provider call has no level of its own; a failed one reads as an error.
const CALL_LEVEL = "CASE WHEN error IS NULL THEN 'info' ELSE 'error' END";
const LOG_SEARCHED = ["op", "message", "card_id", "details", "error"];
const CALL_SEARCHED = [
  "provider", "operation", "endpoint", "model", "step", "card_id", "request", "response", "error",
];

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

export function recordsFailureText(error: unknown, line?: string): string {
  return `[mumbler:records] ${errorInfo(error)}\n${line ?? ""}`;
}

export function writeRecordsReport(text: string): void {
  try {
    process.stderr.write(text);
  } catch {
    // Nothing is left to report to; recording must never take the app down.
  }
}

export function reportRecordsFailure(error: unknown, line?: string): void {
  writeRecordsReport(recordsFailureText(error, line));
}

export class RecordsEngine {
  private db: DatabaseSync | null = null;
  private opened = false;
  private readonly target: RecordsTarget;
  // Where a failure the engine cannot record is reported. The worker hands it
  // to the parent over the port its replies use, so a report always arrives
  // before the reply it precedes; a worker's own stderr can lose its last
  // writes when the worker is terminated.
  private readonly report: (text: string) => void;

  constructor(target: RecordsTarget, report: (text: string) => void) {
    this.target = target;
    this.report = report;
  }

  // Whether the entry reached the database.
  write(entry: RecordEntry): boolean {
    try {
      this.insert(this.open(), entry);
      return true;
    } catch (error: unknown) {
      this.report(recordsFailureText(error));
      this.writeFallback(entry);
      return false;
    }
  }

  read(read: RecordsRead): RecordsReadResults[RecordsRead["op"]] {
    const db = this.open();
    if (read.op === "page") return readPage(db, read.query);
    if (read.op === "sources") return readSources(db);
    return readDetail(db, read.kind, read.id);
  }

  close(): void {
    try {
      this.db?.close();
    } catch (error: unknown) {
      this.report(recordsFailureText(error));
    }
    this.db = null;
    this.opened = false;
  }

  private open(): DatabaseSync {
    if (this.db !== null) return this.db;
    if (this.opened) throw new Error(`records database is unavailable: ${this.target.databasePath}`);
    this.opened = true;
    // A database in a newer format is left untouched: entries go to the
    // fallback file and reads fail, as for any database that cannot be opened.
    this.db = openVersionedDatabase(this.target.databasePath, FORMAT_VERSIONS.records, SCHEMA);
    return this.db;
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
      this.report(recordsFailureText(error, line));
    }
  }
}

function likePattern(search: string): string | null {
  const trimmed = search.trim();
  return trimmed === "" ? null : `%${trimmed.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function readPage(db: DatabaseSync, query: RecordsQuery): RecordsPage {
  const pattern = likePattern(query.search);
  const parts: string[] = [];
  const params: SQLInputValue[] = [];
  const table = (select: string, from: string, level: string, searched: string[]): void => {
    const where = ["1 = 1"];
    if (query.session !== null) {
      where.push("session = ?");
      params.push(query.session);
    }
    if (query.level === "attention") {
      where.push(`${level} IN ('warn', 'error')`);
    } else if (query.level !== null) {
      where.push(`${level} = ?`);
      params.push(query.level);
    }
    if (query.cardId !== null) {
      where.push("card_id = ?");
      params.push(query.cardId);
    }
    if (pattern !== null) {
      where.push(`(${searched.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
      params.push(...searched.map(() => pattern));
    }
    parts.push(`${select} FROM ${from} WHERE ${where.join(" AND ")}`);
  };
  if (query.kind !== "provider-call") {
    table(
      "SELECT 'log' AS kind, id, session, time, level, op AS title, message AS text, card_id AS cardId",
      "logs", "level", LOG_SEARCHED,
    );
  }
  if (query.kind !== "log") {
    table(
      `SELECT 'provider-call' AS kind, id, session, started_at AS time, ${CALL_LEVEL} AS level,
        provider || ' ' || operation AS title, model AS text, card_id AS cardId`,
      "provider_calls", CALL_LEVEL, CALL_SEARCHED,
    );
  }
  let after = "";
  if (query.after !== null) {
    const { time, kind, id } = query.after;
    after = "WHERE time < ? OR (time = ? AND (kind < ? OR (kind = ? AND id < ?)))";
    params.push(time, time, kind, kind, id);
  }
  params.push(RECORDS_PAGE_SIZE + 1);
  const rows = db.prepare(
    `SELECT * FROM (${parts.join(" UNION ALL ")}) ${after} ORDER BY time DESC, kind DESC, id DESC LIMIT ?`,
  ).all(...params) as unknown as RecordSummary[];
  return { records: rows.slice(0, RECORDS_PAGE_SIZE), more: rows.length > RECORDS_PAGE_SIZE };
}

function readSources(db: DatabaseSync): RecordsReadResults["sources"] {
  const sessions = db.prepare(
    "SELECT session FROM logs UNION SELECT session FROM provider_calls ORDER BY session DESC",
  ).all() as { session: string }[];
  const cards = db.prepare(
    `SELECT card_id AS cardId, MAX(time) AS last FROM (
      SELECT card_id, time FROM logs UNION ALL SELECT card_id, started_at FROM provider_calls
    ) WHERE card_id IS NOT NULL GROUP BY card_id ORDER BY last DESC`,
  ).all() as { cardId: string }[];
  return { sessions: sessions.map((row) => row.session), cardIds: cards.map((row) => row.cardId) };
}

function readDetail(db: DatabaseSync, kind: RecordKind, id: number): RecordDetail | null {
  if (kind === "log") {
    const row = db.prepare(
      `SELECT 'log' AS kind, id, session, time, level, op, message, card_id AS cardId, details, error
        FROM logs WHERE id = ?`,
    ).get(id);
    return (row as unknown as RecordDetail | undefined) ?? null;
  }
  const row = db.prepare(
    `SELECT 'provider-call' AS kind, id, session, started_at AS startedAt, finished_at AS finishedAt,
      card_id AS cardId, step, attempt, provider, operation, endpoint, model, request, response, error
      FROM provider_calls WHERE id = ?`,
  ).get(id);
  return (row as unknown as RecordDetail | undefined) ?? null;
}

function errorInfo(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
