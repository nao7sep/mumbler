import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackupStoreEngine } from "@main/core/backup-store-engine";
import { RecordsEngine, type LogEntry } from "@main/core/records-engine";
import { databaseFormatVersion, openVersionedDatabase } from "@main/core/sqlite-store";

const faults = vi.hoisted(() => ({
  beforePublish: null as (() => void) | null,
  unsupportedLink: false,
  renameFailure: false,
  cleanupFailure: false,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (faults.renameFailure) throw new Error("publication refused");
      actual.renameSync(...args);
    },
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      const before = faults.beforePublish;
      faults.beforePublish = null;
      before?.();
      if (faults.unsupportedLink) throw Object.assign(new Error("links unsupported"), { code: "ENOTSUP" });
      actual.linkSync(...args);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (faults.cleanupFailure) throw new Error(`cleanup refused: ${String(args[0])}`);
      actual.rmSync(...args);
    },
  };
});

let root: string;
let file: string;
const connections: DatabaseSync[] = [];
const engines: Array<BackupStoreEngine | RecordsEngine> = [];
const schema = "CREATE TABLE IF NOT EXISTS facts (value TEXT)";

function connect(target = file): DatabaseSync {
  const db = new DatabaseSync(target);
  connections.push(db);
  return db;
}
const WRITER = { name: "mumbler", version: "1.0.0" };
// A database's file header as an earlier session of this format left it.
function headerSql(owner = "mumbler", kind = "facts", writer = WRITER.name): string {
  return `CREATE TABLE file_header (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO file_header VALUES ('format.owner', '${owner}'), ('format.kind', '${kind}'), ('writer.name', '${writer}'), ('writer.version', '0.0.1')`;
}
function headerRows(db: DatabaseSync): Record<string, string> {
  return Object.fromEntries((db.prepare("SELECT key, value FROM file_header").all() as { key: string; value: string }[]).map((row) => [row.key, row.value]));
}
function open(version = 1, ddl = schema, report = vi.fn(), kind = "facts"): DatabaseSync {
  const db = openVersionedDatabase(file, { kind, version }, WRITER, ddl, report);
  connections.push(db);
  return db;
}
function entry(message: string): LogEntry {
  return { kind: "log", session: "session", time: "2026-10-07T00:00:00.000Z", level: "info", op: "test", message, cardId: null, details: null, error: null };
}
beforeEach(async () => {
  faults.beforePublish = null;
  faults.unsupportedLink = false;
  faults.renameFailure = false;
  faults.cleanupFailure = false;
  root = await mkdtemp(join(tmpdir(), "mumbler-sqlite-"));
  file = join(root, "store.sqlite3");
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.close();
  for (const db of connections.splice(0)) db.close();
  await rm(root, { recursive: true, force: true });
});

describe("SQLite creation and admission", () => {
  it.each([false, true])("publishes a fully initialized new WAL store (unsupported links: %s)", (fallback) => {
    faults.unsupportedLink = fallback;
    const db = open();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(db.prepare("SELECT * FROM facts").all()).toEqual([]);
    expect(headerRows(db)).toEqual({ "format.owner": "mumbler", "format.kind": "facts", "writer.name": "mumbler", "writer.version": "1.0.0" });
    expect(readdirSync(root).some((name) => name.startsWith(".mumbler-sqlite-"))).toBe(false);
  });

  it.each([-1, 0, 2])("refuses existing version %s without schema or journal changes", (version) => {
    const db = connect();
    db.exec(`PRAGMA user_version = ${version}`);
    const bytes = readFileSync(file);
    expect(() => open()).toThrow(version === 2 ? "newer than this build reads" : "records no format version");
    expect(readFileSync(file)).toEqual(bytes);
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
  });

  it("refuses an existing zero-byte file", () => {
    writeFileSync(file, "");
    expect(() => open()).toThrow("records no format version");
    expect(readFileSync(file).byteLength).toBe(0);
  });

  it("continues writing an existing current-format database", () => {
    connect().exec(`PRAGMA user_version = 1; ${headerSql()}; ${schema}; INSERT INTO facts VALUES ('earlier')`);
    const db = open();
    db.exec("INSERT INTO facts VALUES ('current')");
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(db.prepare("SELECT value FROM facts ORDER BY rowid").all()).toEqual([{ value: "earlier" }, { value: "current" }]);
  });

  it("rewrites the writer rows at open and never reads them", () => {
    connect().exec(`PRAGMA user_version = 1; ${headerSql("mumbler", "facts", "someone-else")}; ${schema}`);
    const db = open();
    expect(headerRows(db)).toEqual({ "format.owner": "mumbler", "format.kind": "facts", "writer.name": "mumbler", "writer.version": "1.0.0" });
  });

  it.each([
    ["no file header", ""],
    ["another owner", headerSql("otherapp")],
    ["another kind", headerSql("mumbler", "records")],
  ])("refuses a database with %s without changing it", (_name, header) => {
    const db = connect();
    db.exec(`PRAGMA user_version = 1; ${header}${header === "" ? "" : ";"} ${schema}; INSERT INTO facts VALUES ('kept')`);
    const bytes = readFileSync(file);
    expect(() => open()).toThrow("has no file header naming it a Mumbler facts database");
    expect(readFileSync(file)).toEqual(bytes);
    expect(db.prepare("SELECT value FROM facts").all()).toEqual([{ value: "kept" }]);
  });

  it("does not change a valid existing database's journal mode", () => {
    const db = connect();
    db.exec(`PRAGMA user_version = 1; ${headerSql()}; ${schema}`);
    open();
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
  });

  it.each([false, true])("opens the completed first-publication winner (unsupported links: %s)", (fallback) => {
    faults.unsupportedLink = fallback;
    faults.beforePublish = () => { open().exec("INSERT INTO facts VALUES ('winner')"); };
    const db = open();
    expect(db.prepare("SELECT value FROM facts").all()).toEqual([{ value: "winner" }]);
    expect(readdirSync(root).some((name) => name.startsWith(".mumbler-sqlite-"))).toBe(false);
  });

  it.each([false, true])("refuses a newer first-publication winner without replacing it (unsupported links: %s)", (fallback) => {
    faults.unsupportedLink = fallback;
    faults.beforePublish = () => { open(2).exec("INSERT INTO facts VALUES ('future')"); };
    expect(() => open()).toThrow("newer than this build reads");
    const db = connect();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(db.prepare("SELECT value FROM facts").all()).toEqual([{ value: "future" }]);
    expect(readdirSync(root).some((name) => name.startsWith(".mumbler-sqlite-"))).toBe(false);
  });

  it("removes only private residue after failed new schema initialization", () => {
    expect(() => open(1, `${schema}; NOT VALID SQL`)).toThrow();
    expect(readdirSync(root)).toEqual([]);
  });

  it("leaves no canonical partial database when fallback publication fails, then reopens a complete store", () => {
    faults.unsupportedLink = true;
    faults.renameFailure = true;
    expect(() => open()).toThrow("publication refused");
    expect(readdirSync(root)).toEqual([]);
    faults.renameFailure = false;
    const db = open();
    db.exec("INSERT INTO facts VALUES ('complete')");
    expect(open().prepare("SELECT value FROM facts").all()).toEqual([{ value: "complete" }]);
    expect(open().prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
  });

  it("rolls back failed schema application on an existing store", () => {
    const db = connect();
    db.exec(`PRAGMA user_version = 1; ${headerSql()}; CREATE TABLE kept (value TEXT)`);
    expect(() => open(1, `${schema}; NOT VALID SQL`)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: "file_header" }, { name: "kept" }]);
    expect(headerRows(db)["writer.version"], "the writer rows roll back too").toBe("0.0.1");
  });

  it("rechecks admission after acquiring the initialization writer slot", () => {
    const db = connect();
    db.exec(`PRAGMA user_version = 1; ${headerSql()}; ${schema}`);
    const exec = DatabaseSync.prototype.exec;
    let change = true;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === "BEGIN IMMEDIATE" && change) {
        change = false;
        exec.call(db, "PRAGMA user_version = 2");
      }
      exec.call(this, sql);
    });
    expect(() => open(1, "CREATE TABLE forbidden (value TEXT)")).toThrow("newer than this build reads");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: "facts" }, { name: "file_header" }]);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
  });

  it("preserves failed new initialization and its secondary close error", () => {
    const close = DatabaseSync.prototype.close;
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(function (this: DatabaseSync) {
      close.call(this);
      throw new Error("close refused");
    });
    const error = (() => {
      try { open(1, `${schema}; NOT VALID SQL`); } catch (caught) { return caught; }
      throw new Error("Expected initialization failure");
    })();
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ cause: expect.objectContaining({ message: expect.stringContaining("syntax error") }), message: expect.stringContaining("close refused") });
    expect(readdirSync(root)).toEqual([]);
  });

  it("retains admission failure when closing the rejected connection fails", () => {
    connect().exec("PRAGMA user_version = 2");
    const close = DatabaseSync.prototype.close;
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(function (this: DatabaseSync) {
      close.call(this);
      throw new Error("close refused");
    });
    const report = vi.fn();
    expect(() => open(1, schema, report)).toThrow("newer than this build reads");
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: "close refused" }));
  });

  it("reports private cleanup secondarily even if reporting fails after publication", () => {
    faults.cleanupFailure = true;
    const report = vi.fn(() => { throw new Error("report refused"); });
    const db = open(1, schema, report);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("cleanup refused") }));
  });
});

describe("reading a database's format version at launch", () => {
  it("reads user_version from the file header without changing the file", () => {
    expect(databaseFormatVersion(file)).toBeUndefined();
    connect().exec("PRAGMA user_version = 7; CREATE TABLE kept (value TEXT)");
    const bytes = readFileSync(file);
    expect(databaseFormatVersion(file)).toBe(7);
    expect(readFileSync(file)).toEqual(bytes);
    expect(readdirSync(root)).toEqual(["store.sqlite3"]);
  });

  it("reads a file that is not a SQLite database as having none", () => {
    writeFileSync(file, "not a database at all, just some text that is long enough to fill a header and then some more");
    expect(databaseFormatVersion(file)).toBeNull();
  });
});

describe("SQLite engine admission at open", () => {
  it("leaves a newer backup store untouched and records nothing into it", () => {
    connect().exec("PRAGMA user_version = 3");
    const warn = vi.fn();
    const engine = new BackupStoreEngine(file, "session", WRITER, warn);
    engines.push(engine);
    engine.record("recording", Buffer.from("refused"), "2026-10-07T00:00:00.000Z");
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: expect.stringContaining("newer than this build reads") }), true);
    const db = connect();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
  });

  it("refuses writes and reads of a newer records store at open, leaving it untouched", () => {
    connect().exec("PRAGMA user_version = 2");
    const engine = new RecordsEngine({ databasePath: file, fallbackPath: join(root, "fallback.log"), writer: WRITER }, vi.fn());
    engines.push(engine);
    expect(engine.write(entry("refused")), "the caller writes it to the fallback file").toBe(false);
    expect(() => engine.read({ op: "sources" })).toThrow("records database is unavailable");
    expect(connect().prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
  });

  it("keeps multi-query sources in one read snapshot", () => {
    const engine = new RecordsEngine({ databasePath: file, fallbackPath: join(root, "fallback.log"), writer: WRITER }, vi.fn());
    engines.push(engine);
    engine.write(entry("first"));
    const db = connect();
    const prepare = DatabaseSync.prototype.prepare;
    let insert = true;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, ...args) {
      if (args[0].includes("SELECT card_id AS cardId") && insert) {
        insert = false;
        db.exec("INSERT INTO logs (session,time,level,op,message,card_id) VALUES ('new','2026-10-07T00:00:01.000Z','info','test','new','new-card')");
      }
      return prepare.apply(this, args);
    });
    expect(engine.read({ op: "sources" })).toEqual({ sessions: ["session"], cardIds: [] });
    expect(engine.read({ op: "sources" })).toEqual({ sessions: ["session", "new"], cardIds: ["new-card"] });
  });
});
