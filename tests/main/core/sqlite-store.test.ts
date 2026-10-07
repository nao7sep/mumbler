import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackupStoreEngine } from "@main/core/backup-store-engine";
import { RecordsEngine, type LogEntry } from "@main/core/records-engine";
import { openVersionedDatabase } from "@main/core/sqlite-store";

const faults = vi.hoisted(() => ({
  beforePublish: null as (() => void) | null,
  unsupportedLink: false,
  cleanupFailure: false,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
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
function open(version = 1, ddl = schema, report = vi.fn()): DatabaseSync {
  const db = openVersionedDatabase(file, version, ddl, report);
  connections.push(db);
  return db;
}
function entry(message: string): LogEntry {
  return { kind: "log", session: "session", time: "2026-10-07T00:00:00.000Z", level: "info", op: "test", message, cardId: null, details: null, error: null };
}
beforeEach(async () => {
  faults.beforePublish = null;
  faults.unsupportedLink = false;
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

  it("does not change a valid existing database's journal mode", () => {
    const db = connect();
    db.exec(`PRAGMA user_version = 1; ${schema}`);
    open();
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
  });

  it("opens the completed winner of overlapping first publication", () => {
    faults.beforePublish = () => { open().exec("INSERT INTO facts VALUES ('winner')"); };
    const db = open();
    expect(db.prepare("SELECT value FROM facts").all()).toEqual([{ value: "winner" }]);
    expect(readdirSync(root).some((name) => name.startsWith(".mumbler-sqlite-"))).toBe(false);
  });

  it("admits a newer first-publication winner without replacing it", () => {
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

  it("rolls back failed schema application on an existing store", () => {
    const db = connect();
    db.exec("PRAGMA user_version = 1; CREATE TABLE kept (value TEXT)");
    expect(() => open(1, `${schema}; NOT VALID SQL`)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master ORDER BY name").all()).toEqual([{ name: "kept" }]);
  });

  it("rechecks admission after acquiring the initialization writer slot", () => {
    const db = connect();
    db.exec(`PRAGMA user_version = 1; ${schema}`);
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
    expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([{ name: "facts" }]);
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

describe("cached SQLite engine admission", () => {
  it("refuses a cached backup write after the marker changes and releases its transaction", () => {
    const warn = vi.fn();
    const engine = new BackupStoreEngine(file, warn);
    engines.push(engine);
    engine.record("recording", Buffer.from("first"), "2026-10-07T00:00:00.000Z");
    const db = connect();
    db.exec("PRAGMA user_version = 2");
    engine.record("recording", Buffer.from("refused"), "2026-10-07T00:00:01.000Z");
    expect(db.prepare("SELECT COUNT(*) AS count FROM backups").get()).toEqual({ count: 1 });
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: expect.stringContaining("newer than this build reads") }));
    db.exec("PRAGMA user_version = 1");
    engine.record("recording", Buffer.from("later"), "2026-10-07T00:00:02.000Z");
    expect(db.prepare("SELECT COUNT(*) AS count FROM backups").get()).toEqual({ count: 2 });
  });

  it("falls back on a cached records write and refuses cached reads of a newer format", () => {
    const fallback = join(root, "fallback.log");
    const report = vi.fn();
    const engine = new RecordsEngine({ databasePath: file, fallbackPath: fallback }, report);
    engines.push(engine);
    expect(engine.write(entry("first"))).toBe(true);
    const db = connect();
    db.exec("PRAGMA user_version = 2");
    expect(engine.write(entry("refused"))).toBe(false);
    expect(JSON.parse(readFileSync(fallback, "utf8"))).toMatchObject({ message: "refused" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM logs").get()).toEqual({ count: 1 });
    expect(() => engine.read({ op: "sources" })).toThrow("newer than this build reads");
    db.exec("PRAGMA user_version = 1");
    expect(engine.write(entry("later"))).toBe(true);
    expect(engine.read({ op: "sources" })).toEqual({ sessions: ["session"], cardIds: [] });
  });

  it("keeps multi-query sources in the admitted read snapshot", () => {
    const engine = new RecordsEngine({ databasePath: file, fallbackPath: join(root, "fallback.log") }, vi.fn());
    engines.push(engine);
    engine.write(entry("first"));
    const db = connect();
    const prepare = DatabaseSync.prototype.prepare;
    let insert = true;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, ...args) {
      if (args[0].includes("SELECT card_id AS cardId") && insert) {
        insert = false;
        db.exec("INSERT INTO logs (session,time,level,op,message,card_id) VALUES ('new','2026-10-07T00:00:01.000Z','info','test','new','new-card'); PRAGMA user_version = 2");
      }
      return prepare.apply(this, args);
    });
    expect(engine.read({ op: "sources" })).toEqual({ sessions: ["session"], cardIds: [] });
    expect(() => engine.read({ op: "sources" })).toThrow("newer than this build reads");
  });
});
