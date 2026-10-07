import { closeSync, constants, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { NewerFormatError } from "./format-versions.ts";

// Call within the transaction that owns the read or mutation, including on a
// cached connection. A present, unversioned database is never a fresh store.
export function admitDatabaseFormat(db: DatabaseSync, file: string, supported: number): void {
  const { user_version: recorded } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (recorded > supported) throw new NewerFormatError(file, recorded, supported);
  if (recorded < 1) throw new Error(`${file} records no format version (user_version ${recorded}).`);
}

type ReportCleanup = (error: unknown) => void;

// Journal mode cannot change inside a transaction. Initialize it on a private
// database, close/checkpoint it, then claim the absent final path exclusively.
// Other first-open callers either publish first or admit the completed winner.
function createDatabase(file: string, formatVersion: number, schema: string, reportCleanup: ReportCleanup): void {
  const stageDir = mkdtempSync(path.join(path.dirname(file), ".mumbler-sqlite-"));
  const stage = path.join(stageDir, "database.sqlite3");
  let db: DatabaseSync | undefined;
  let primary: unknown;
  const cleanup: unknown[] = [];
  try {
    closeSync(openSync(stage, "wx", 0o600));
    db = new DatabaseSync(stage);
    db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
    db.exec(schema);
    db.exec(`PRAGMA user_version = ${formatVersion}; COMMIT`);
    db.exec("PRAGMA journal_mode = WAL");
    db.close();
    db = undefined;
    try { linkSync(stage, file); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(code ?? "")) {
        try { copyFileSync(stage, file, constants.COPYFILE_EXCL); }
        catch (copyError) {
          if ((copyError as NodeJS.ErrnoException).code !== "EEXIST") throw copyError;
        }
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
export function openVersionedDatabase(file: string, formatVersion: number, schema: string, reportCleanup: ReportCleanup = () => undefined): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true });
  if (!existsSync(file)) createDatabase(file, formatVersion, schema, reportCleanup);
  const db = new DatabaseSync(file);
  let transactionOpen = false;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    admitDatabaseFormat(db, file, formatVersion);
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    admitDatabaseFormat(db, file, formatVersion);
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
