import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger, serializeError, type SessionLogger } from "@main/core/logger";

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
