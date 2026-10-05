import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger, serializeError, type SessionLogger } from "@main/core/logger";
import type { RecordsQuery } from "@shared/records";

let dir: string;
let recordsPath: string;
let logsDir: string;
const opened: SessionLogger[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mumbler-records-"));
  recordsPath = join(dir, "records.sqlite3");
  logsDir = join(dir, "logs");
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((logger) => logger.close()));
  await rm(dir, { recursive: true, force: true });
});

function open(debugEnabled = true, paths = { recordsPath, logsDir }): SessionLogger {
  const logger = createLogger(paths, { debugEnabled });
  opened.push(logger);
  return logger;
}

function rows(table: "logs" | "provider_calls"): Record<string, unknown>[] {
  const db = new DatabaseSync(recordsPath);
  try {
    return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

async function fallbackLines(): Promise<Record<string, unknown>[]> {
  const files = await readdir(logsDir);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^\d{8}-\d{6}-\d{3}-utc\.log$/);
  const text = await readFile(join(logsDir, files[0]), "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("createLogger", () => {
  it("writes each line as a row of one session, with its time and card", async () => {
    const logger = open();
    await logger.info("startup", "hello");
    await logger.warn("pipeline.step", "careful", { cardId: "c1", attempt: 2 });
    await logger.close();

    const [first, second] = rows("logs");
    expect(first).toMatchObject({ level: "info", op: "startup", message: "hello", card_id: null, details: null });
    expect(first.session).toMatch(ISO_MS);
    expect(first.time).toMatch(ISO_MS);
    expect(second.session).toBe(first.session);
    expect(second.card_id).toBe("c1");
    expect(JSON.parse(second.details as string)).toEqual({ cardId: "c1", attempt: 2 });
  });

  it("captures details and a serialized error on the error level", async () => {
    const logger = open();
    await logger.error("convert", "boom", new Error("nope"), { cardId: "c1" });
    await logger.close();

    const [row] = rows("logs");
    expect(row.level).toBe("error");
    const error = JSON.parse(row.error as string) as Record<string, unknown>;
    expect(error).toMatchObject({ name: "Error", message: "nope" });
    expect(typeof error.stack).toBe("string");
  });

  it("keeps every field as given, secrets included", async () => {
    const logger = open();
    const details = { apiKey: "AIzaSECRET", Authorization: "Bearer t", nested: { password: "pw" } };
    await logger.info("auth", "configured the key", details);
    await logger.close();

    expect(JSON.parse(rows("logs")[0].details as string)).toEqual(details);
  });

  it("does not write debug lines when debug is disabled, but does when enabled", async () => {
    const off = open(false);
    await off.debug("probe", "dev only");
    await off.info("probe", "always");
    const on = open(true);
    await on.debug("probe", "dev only");
    await off.close();
    await on.close();

    expect(rows("logs").map((row) => row.level)).toEqual(["info", "debug"]);
  });

  it("records a provider call whole, request and response", async () => {
    const logger = open();
    const request = { model: "gemini-x", contents: [{ role: "user", parts: [{ text: "hi" }] }] };
    const response = { text: "hello", usageMetadata: { totalTokenCount: 5 } };
    await logger.providerCall({
      provider: "gemini",
      operation: "models.generateContent",
      endpoint: null,
      model: "gemini-x",
      cardId: "c1",
      step: "title",
      attempt: 1,
      startedAt: "2026-10-02T00:00:00.000Z",
      finishedAt: "2026-10-02T00:00:01.000Z",
      request,
      response,
      error: null,
    });
    await logger.providerCall({
      provider: "gemini",
      operation: "models.generateContent",
      endpoint: "https://proxy.example",
      model: "gemini-x",
      cardId: "c1",
      step: "title",
      attempt: 2,
      startedAt: "2026-10-02T00:00:02.000Z",
      finishedAt: "2026-10-02T00:00:03.000Z",
      request,
      response: null,
      error: new Error("quota"),
    });
    await logger.close();

    const [ok, failed] = rows("provider_calls");
    expect(ok).toMatchObject({ card_id: "c1", step: "title", attempt: 1, operation: "models.generateContent", error: null });
    expect(JSON.parse(ok.request as string)).toEqual(request);
    expect(JSON.parse(ok.response as string)).toEqual(response);
    expect(failed).toMatchObject({ attempt: 2, endpoint: "https://proxy.example", response: "null" });
    expect(JSON.parse(failed.error as string)).toMatchObject({ name: "Error", message: "quota" });
  });

  it("falls back to this session's text file under logs/ when the database cannot be written", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      // A directory where the database file should be makes every open fail.
      const logger = open(true, { recordsPath: dir, logsDir });
      await expect(logger.info("startup", "kept anyway", { cardId: "c1" })).resolves.toBeUndefined();
      await logger.close();

      const [line] = await fallbackLines();
      expect(line).toMatchObject({ kind: "log", message: "kept anyway", cardId: "c1", details: { cardId: "c1" } });
      expect(stderr).toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it("records the database's format version in user_version", async () => {
    const logger = open();
    await logger.info("startup", "first line");
    await logger.close();
    const db = new DatabaseSync(recordsPath);
    try {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    } finally {
      db.close();
    }
  });

  it.each([
    ["in a newer format", "CREATE TABLE future (id INTEGER PRIMARY KEY); PRAGMA user_version = 2;", "newer than this build reads"],
    ["without its format version", "CREATE TABLE logs (id INTEGER PRIMARY KEY);", "records no format version"],
  ])("leaves a database %s untouched, and keeps its lines in the fallback file", async (_kind, setup, reported) => {
    const existing = new DatabaseSync(recordsPath);
    existing.exec(setup);
    existing.close();
    const before = await readFile(recordsPath);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const logger = open();
      await logger.info("startup", "kept anyway");
      await logger.close();

      expect((await fallbackLines())[0]).toMatchObject({ kind: "log", message: "kept anyway" });
      expect(stderr.mock.calls.some(([text]) => String(text).includes(reported))).toBe(true);
      expect(await readFile(recordsPath)).toEqual(before);
      expect(await readdir(dir)).not.toContain("records.sqlite3-wal");
    } finally {
      stderr.mockRestore();
    }
  });

  it("never throws when neither the database nor the fallback file can be written", async () => {
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x", "utf8");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const logger = open(true, { recordsPath: join(blocker, "records.sqlite3"), logsDir: join(blocker, "logs") });
      await expect(logger.error("io", "should not throw", new Error("x"))).resolves.toBeUndefined();
      await logger.close();
      expect(stderr.mock.calls.some(([text]) => String(text).includes("should not throw"))).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });

  it("calls its stored listener after each entry the database stores", async () => {
    const logger = open();
    const stored = vi.fn();
    logger.onStored(stored);
    await logger.info("startup", "hello");
    expect(stored).toHaveBeenCalledOnce();
    await logger.providerCall({
      provider: "gemini", operation: "models.generateContent", endpoint: null, model: null, cardId: null,
      step: null, attempt: null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      request: {}, response: null, error: null,
    });
    expect(stored).toHaveBeenCalledTimes(2);
  });

  it("does not call its stored listener for an entry that went to the fallback file", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const logger = open(true, { recordsPath: dir, logsDir });
      const stored = vi.fn();
      logger.onStored(stored);
      await logger.info("startup", "kept anyway");
      await logger.close();
      expect(stored).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it("constructs without touching the filesystem", async () => {
    const missing = join(dir, "not-created-yet");
    open(true, { recordsPath: join(missing, "records.sqlite3"), logsDir: join(missing, "logs") });
    await expect(readdir(missing)).rejects.toThrow();
  });
});

describe("serializeError", () => {
  it("preserves aggregate failures and a reused cause through JSON", () => {
    const original = Object.assign(new Error("source read failed"), {
      operation: "read", nativeCode: 6,
    });
    const fallback = Object.assign(new Error("fallback read failed"), {
      operation: "fallback", nativeCode: 5,
    });
    const aggregate = new AggregateError([original, fallback], "all reads failed", { cause: original });
    const serialized = JSON.parse(JSON.stringify(serializeError(aggregate)));
    expect(serialized).toMatchObject({
      name: "AggregateError",
      cause: { message: original.message, stack: original.stack, operation: "read", nativeCode: 6 },
      errors: [
        { message: original.message, stack: original.stack, operation: "read", nativeCode: 6 },
        { message: fallback.message, stack: fallback.stack, operation: "fallback", nativeCode: 5 },
      ],
    });
  });

  it("contains a self-referential aggregate", () => {
    const aggregate = new AggregateError([], "cycle");
    aggregate.errors.push(aggregate);
    expect(() => JSON.stringify(serializeError(aggregate))).not.toThrow();
  });
  it("captures name, message, stack, and the wrapped cause chain", () => {
    const serialized = serializeError(
      new Error("outer", { cause: new Error("inner") }),
    ) as Record<string, unknown>;
    expect(serialized.name).toBe("Error");
    expect(serialized.message).toBe("outer");
    expect(typeof serialized.stack).toBe("string");
    expect(serialized.cause).toMatchObject({ name: "Error", message: "inner" });
  });
});

describe("readRecords", () => {
  const query = (overrides: Partial<RecordsQuery> = {}): RecordsQuery => ({
    session: null, kind: null, level: null, cardId: null, search: "", after: null, ...overrides,
  });

  async function seed(): Promise<{ earlier: string; later: SessionLogger }> {
    const first = open();
    await first.info("app.startup", "Started.");
    await first.close();
    const later = open();
    await later.warn("pipeline.step", "Careful with 50% of it.", { cardId: "c1" });
    await later.providerCall({
      provider: "gemini",
      operation: "models.generateContent",
      endpoint: null,
      model: "gemini-x",
      cardId: "c1",
      step: "title",
      attempt: 1,
      startedAt: new Date(Date.now() + 1000).toISOString(),
      finishedAt: new Date(Date.now() + 2000).toISOString(),
      request: { contents: "say hello", apiKey: "sk-test" },
      response: null,
      error: new Error("quota"),
    });
    return { earlier: first.session, later };
  }

  it("pages every record newest first, a failed provider call reading as an error", async () => {
    const { earlier, later } = await seed();
    const page = await later.readRecords({ op: "page", query: query() });

    expect(page.more).toBe(false);
    expect(page.records.map((record) => [record.kind, record.level, record.title])).toEqual([
      ["provider-call", "error", "gemini models.generateContent"],
      ["log", "warn", "pipeline.step"],
      ["log", "info", "app.startup"],
    ]);
    expect(page.records[2]!.session).toBe(earlier);
    expect(page.records[0]).toMatchObject({ text: "gemini-x", cardId: "c1", session: later.session });
  });

  it("filters by launch, kind, level, card and search", async () => {
    const { earlier, later } = await seed();
    const titles = async (overrides: Partial<RecordsQuery>) =>
      (await later.readRecords({ op: "page", query: query(overrides) })).records.map((record) => record.title);

    expect(await titles({ session: earlier })).toEqual(["app.startup"]);
    expect(await titles({ kind: "log" })).toEqual(["pipeline.step", "app.startup"]);
    expect(await titles({ level: "error" })).toEqual(["gemini models.generateContent"]);
    expect(await titles({ cardId: "c1", kind: "log" })).toEqual(["pipeline.step"]);
    // Search reaches the stored request, key included, and takes % literally.
    expect(await titles({ search: "SK-TEST" })).toEqual(["gemini models.generateContent"]);
    expect(await titles({ search: "50%" })).toEqual(["pipeline.step"]);
    expect(await titles({ search: "5_%" })).toEqual([]);
  });

  it("filters for attention: warning and error lines and failed provider calls", async () => {
    const logger = open();
    const call = (error: unknown, model: string) => logger.providerCall({
      provider: "gemini", operation: "models.generateContent", endpoint: null, model, cardId: null, step: null,
      attempt: null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      request: {}, response: null, error,
    });
    await logger.info("calm", "Fine.");
    await logger.warn("careful", "Careful.");
    await logger.error("broken", "Broken.", new Error("x"));
    await call(null, "succeeded");
    await call(new Error("quota"), "failed");

    const page = await logger.readRecords({ op: "page", query: query({ level: "attention" }) });
    expect(page.records.map((record) => record.text).sort()).toEqual(["Broken.", "Careful.", "failed"]);
  });

  it("continues a long list from the last record of the page before", async () => {
    const logger = open();
    await Promise.all(Array.from({ length: 105 }, (_, index) => logger.info("tick", `Tick ${index}.`)));

    const first = await logger.readRecords({ op: "page", query: query() });
    const last = first.records.at(-1)!;
    const second = await logger.readRecords({ op: "page", query: query({ after: last }) });

    expect(first.records).toHaveLength(100);
    expect(first.more).toBe(true);
    expect(second.records).toHaveLength(5);
    expect(second.more).toBe(false);
    expect(new Set([...first.records, ...second.records].map((record) => record.id)).size).toBe(105);
  });

  it("returns a record whole, and the launches and cards the filters offer", async () => {
    const { earlier, later } = await seed();
    const [call] = (await later.readRecords({ op: "page", query: query({ kind: "provider-call" }) })).records;

    const detail = await later.readRecords({ op: "detail", kind: "provider-call", id: call!.id });
    expect(detail).toMatchObject({ kind: "provider-call", provider: "gemini", step: "title", attempt: 1, response: "null" });
    expect(JSON.parse((detail as { request: string }).request)).toEqual({ contents: "say hello", apiKey: "sk-test" });
    expect(JSON.parse((detail as { error: string }).error)).toMatchObject({ message: "quota" });
    expect(await later.readRecords({ op: "detail", kind: "log", id: 999 })).toBeNull();

    expect(await later.readRecords({ op: "sources" })).toEqual({ sessions: [later.session, earlier], cardIds: ["c1"] });
  });

  it("refuses to read once the logger is closed", async () => {
    const logger = open();
    await logger.close();
    await expect(logger.readRecords({ op: "sources" })).rejects.toThrow();
  });
});
