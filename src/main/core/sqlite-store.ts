import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type FileFormat, type FileWriter, FORMAT_OWNER, NewerFormatError } from "./format-versions.ts";

// A database's header (file-identity-conventions): user_version holds the
// format version, and file_header the owner, kind and writer.
const FILE_HEADER_SCHEMA = "CREATE TABLE file_header (key TEXT PRIMARY KEY, value TEXT NOT NULL)";

// A database's format is checked once, inside the transaction that opens it. The
// single-instance lock keeps any other Mumbler off the data root, so the format
// cannot change while this process holds the connection, and reads and writes on
// it do not check again. A present, unversioned database is never a fresh store.
// The writer rows are never read.
function admitDatabaseFormat(db: DatabaseSync, file: string, format: FileFormat): void {
  const { user_version: recorded } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (recorded > format.version) throw new NewerFormatError(file, recorded, format.version);
  if (recorded !== format.version) throw new Error(`${file} records no format version this build reads (user_version ${recorded}).`);
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'file_header'").get();
  const rows = table === undefined ? [] : db.prepare("SELECT key, value FROM file_header WHERE key IN ('format.owner', 'format.kind')").all() as { key: string; value: string }[];
  const header = new Map(rows.map((row) => [row.key, row.value]));
  if (header.get("format.owner") !== FORMAT_OWNER || header.get("format.kind") !== format.kind) {
    throw new Error(`${file} has no file header naming it a Mumbler ${format.kind} database.`);
  }
}

function writeHeaderRows(db: DatabaseSync, rows: Record<string, string>): void {
  const upsert = db.prepare("INSERT INTO file_header (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  for (const [key, value] of Object.entries(rows)) upsert.run(key, value);
}

function writerRows(writer: FileWriter): Record<string, string> {
  return { "writer.name": writer.name, "writer.version": writer.version };
}

type ReportCleanup = (error: unknown) => void;

// Journal mode cannot change inside a transaction. Initialize it on a private
// database, close/checkpoint it, then claim the absent final path exclusively.
// Other first-open callers either publish first or admit the completed winner.
function createDatabase(file: string, format: FileFormat, writer: FileWriter, schema: string, reportCleanup: ReportCleanup): void {
  const stageDir = mkdtempSync(path.join(path.dirname(file), ".mumbler-sqlite-"));
  const stage = path.join(stageDir, "database.sqlite3");
  let db: DatabaseSync | undefined;
  let primary: unknown;
  const cleanup: unknown[] = [];
  try {
    closeSync(openSync(stage, "wx", 0o600));
    db = new DatabaseSync(stage);
    db.exec("BEGIN IMMEDIATE");
    db.exec(FILE_HEADER_SCHEMA);
    writeHeaderRows(db, { "format.owner": FORMAT_OWNER, "format.kind": format.kind, ...writerRows(writer) });
    db.exec(schema);
    db.exec(`PRAGMA user_version = ${format.version}; COMMIT`);
    db.exec("PRAGMA journal_mode = WAL");
    db.close();
    db = undefined;
    try { linkSync(stage, file); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(code ?? "")) {
        // One worker owns this private store under the app's instance lock.
        // Recheck for a completed winner, then publish the closed stage in one
        // operation: copying here could expose a partial canonical database.
        let present = true;
        try { lstatSync(file); }
        catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
          present = false;
        }
        if (!present) renameSync(stage, file);
      } else if (code !== "EEXIST") throw error;
    }
  } catch (error) { primary = error; }
  finally {
    if (db !== undefined) {
      try { db.close(); } catch (error) { cleanup.push(error); }
    }
    try { rmSync(stageDir, { recursive: true, force: true }); } catch (error) { cleanup.push(error); }
  }
  if (primary !== undefined) {
    if (cleanup.length > 0) throw new AggregateError([primary, ...cleanup], `Failed to initialize ${file}: ${String(primary)}; staging cleanup also failed: ${cleanup.map(String).join("; ")}`, { cause: primary });
    throw primary;
  }
  for (const error of cleanup) {
    try { reportCleanup(error); } catch { /* Optional reporting cannot deny the published database. */ }
  }
}

/** Opens a versioned store. WAL is initialized once, never rewritten on ordinary opens. */
export function openVersionedDatabase(
  file: string,
  format: FileFormat,
  writer: FileWriter,
  schema: string,
  reportCleanup: ReportCleanup = () => undefined,
): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true });
  if (!existsSync(file)) createDatabase(file, format, writer, schema, reportCleanup);
  const db = new DatabaseSync(file);
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    admitDatabaseFormat(db, file, format);
    writeHeaderRows(db, writerRows(writer));
    db.exec(schema);
    db.exec("COMMIT");
    transactionOpen = false;
    return db;
  } catch (error: unknown) {
    const cleanup: unknown[] = [];
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch (secondary) { cleanup.push(secondary); }
    }
    try { db.close(); } catch (secondary) { cleanup.push(secondary); }
    for (const secondary of cleanup) {
      try { reportCleanup(secondary); } catch { /* Preserve the admission/initialization failure. */ }
    }
    throw error;
  }
}
