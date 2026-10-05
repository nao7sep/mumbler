import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { NewerFormatError } from "./format-versions.ts";

/**
 * Opens one of Mumbler's SQLite stores in WAL mode with its schema, its format
 * version recorded in `PRAGMA user_version` (store-recovery-conventions). A new,
 * empty database is stamped as it is created; one that holds tables but no
 * version is unreadable, and one that records a newer version throws
 * NewerFormatError; either is closed untouched. Imported with its extension by
 * the worker engines, which Node runs with type stripping.
 */
export function openVersionedDatabase(file: string, formatVersion: number, schema: string): DatabaseSync {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const { user_version: recorded } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (recorded > formatVersion) {
      throw new NewerFormatError(file, recorded, formatVersion);
    }
    if (recorded === 0 && db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get() !== undefined) {
      throw new Error(`${file} records no format version.`);
    }
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(schema);
    if (recorded === 0) {
      db.exec(`PRAGMA user_version = ${formatVersion}`);
    }
    return db;
  } catch (error: unknown) {
    db.close();
    throw error;
  }
}
