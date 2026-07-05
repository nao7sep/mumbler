import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger, redactSecrets, serializeError } from "@main/core/logger";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mumbler-logs-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function logFiles(): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(".log"));
}

async function readLines(): Promise<Record<string, unknown>[]> {
  const files = await logFiles();
  const text = await readFile(join(dir, files[0]), "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("createLogger", () => {
  it("writes to one per-launch yyyymmdd-hhmmss-fff-utc.log file with ISO timestamps", async () => {
    const logger = createLogger(dir, { debugEnabled: true });
    await logger.info("startup", "hello");
    await logger.warn("startup", "careful");

    const files = await logFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{8}-\d{6}-\d{3}-utc\.log$/);

    const lines = await readLines();
    expect(lines).toHaveLength(2);
    expect(lines[0].time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(lines[0].op).toBe("startup");
    expect(lines[0].level).toBe("info");
  });

  it("captures details and a serialized error on the error level, with an ISO time", async () => {
    const logger = createLogger(dir, { debugEnabled: true });
    await logger.error("convert", "boom", new Error("nope"), { cardId: "c1" });

    const [line] = await readLines();
    expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(line.level).toBe("error");
    expect(line.details).toEqual({ cardId: "c1" });
    expect(line.error).toMatchObject({ name: "Error", message: "nope" });
    expect(typeof (line.error as { stack: unknown }).stack).toBe("string");
  });

  it("redacts only exact, case-insensitive denied field names — never substrings or the message", async () => {
    const logger = createLogger(dir, { debugEnabled: true });
    await logger.info("auth", "configured the key", {
      apiKey: "AIzaSECRET",
      Authorization: "Bearer t",
      tokenCount: 42,
      broken: "fine",
      nested: { password: "pw", note: "kept" },
    });

    const [line] = await readLines();
    // The envelope message is prose and is never edited.
    expect(line.message).toBe("configured the key");
    const details = line.details as Record<string, unknown>;
    expect(details.apiKey).toBe("[redacted]");
    expect(details.Authorization).toBe("[redacted]");
    // Substring matches are not redacted — `token` must not hit `tokenCount`, nor
    // `broken`.
    expect(details.tokenCount).toBe(42);
    expect(details.broken).toBe("fine");
    // Redaction recurses into nested objects.
    expect(details.nested).toEqual({ password: "[redacted]", note: "kept" });
  });

  it("does not write debug lines when debug is disabled, but does when enabled", async () => {
    const off = createLogger(dir, { debugEnabled: false });
    await off.debug("probe", "dev only");
    await off.info("probe", "always");

    let lines = await readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("info");

    await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(join(tmpdir(), "mumbler-logs-"));

    const on = createLogger(dir, { debugEnabled: true });
    await on.debug("probe", "dev only");
    lines = await readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("debug");
  });

  it("never throws when the log file cannot be written, degrading to stderr", async () => {
    // Point the logger at a path whose parent is a file, so every append fails.
    const notADir = join(dir, "blocker");
    await writeFile(notADir, "x", "utf8");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    try {
      const logger = createLogger(notADir, { debugEnabled: true });
      await expect(logger.error("io", "should not throw", new Error("x"))).resolves.toBeUndefined();
      expect(stderr).toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it("constructs on a not-yet-existing directory without touching the filesystem", async () => {
    // The runtime builds the session logger before it creates the logs directory,
    // so construction must perform no I/O, and the first append must degrade to
    // stderr rather than throw while the directory is still missing.
    const missingDir = join(dir, "not-created-yet");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    try {
      const logger = createLogger(missingDir, { debugEnabled: true });
      // Merely constructing the logger created nothing on disk.
      await expect(readdir(missingDir)).rejects.toThrow();
      await expect(logger.info("startup", "before the directory exists")).resolves.toBeUndefined();
      expect(stderr).toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("redactSecrets", () => {
  it("is non-destructive: replaces only matched values, recurses arrays, and preserves the rest", () => {
    const input = {
      message: "key is abc",
      apiKey: "secret-value",
      keepMe: 7,
      items: [{ secret: "s", count: 1 }, { ok: true }],
    };
    expect(redactSecrets(input)).toEqual({
      message: "key is abc",
      apiKey: "[redacted]",
      keepMe: 7,
      items: [{ secret: "[redacted]", count: 1 }, { ok: true }],
    });
  });

  it("guards against cycles without throwing", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => redactSecrets(cyclic)).not.toThrow();
  });
});

describe("serializeError", () => {
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
