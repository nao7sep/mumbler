import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger, pruneOldLogs } from "@main/core/logger";

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

describe("createLogger", () => {
  it("writes to one per-launch yyyymmdd-hhmmss-utc.log file with ISO timestamps", async () => {
    const logger = createLogger(dir, []);
    await logger.info("startup", "hello");
    await logger.warn("startup", "careful");

    const files = await logFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{8}-\d{6}-utc\.log$/);

    const lines = (await readFile(join(dir, files[0]), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(first.op).toBe("startup");
  });

  it("redacts configured secrets from log lines", async () => {
    const logger = createLogger(dir, ["s3cr3t"]);
    await logger.info("auth", "key is s3cr3t");

    const files = await logFiles();
    const text = await readFile(join(dir, files[0]), "utf8");
    expect(text).not.toContain("s3cr3t");
    expect(text).toContain("[REDACTED]");
  });

  it("captures details and a serialized error on the error level, with an ISO time", async () => {
    const logger = createLogger(dir, []);
    await logger.error("convert", "boom", new Error("nope"), { cardId: "c1" });

    const files = await logFiles();
    const line = JSON.parse((await readFile(join(dir, files[0]), "utf8")).trim());
    expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(line.level).toBe("error");
    expect(line.details).toEqual({ cardId: "c1" });
    expect(line.error).toMatchObject({ name: "Error", message: "nope" });
    expect(typeof line.error.stack).toBe("string");
  });
});

describe("pruneOldLogs", () => {
  it("removes legacy (yyyymmdd) and per-launch logs past retention, keeps recent and non-logs", async () => {
    await writeFile(join(dir, "20000101.log"), "old daily\n", "utf8");
    await writeFile(join(dir, "20000101-010101-utc.log"), "old launch\n", "utf8");

    const today = new Date();
    const stamp =
      `${today.getUTCFullYear()}` +
      `${`${today.getUTCMonth() + 1}`.padStart(2, "0")}` +
      `${`${today.getUTCDate()}`.padStart(2, "0")}`;
    const keep = `${stamp}-120000-utc.log`;
    await writeFile(join(dir, keep), "fresh\n", "utf8");
    await writeFile(join(dir, "notes.txt"), "ignored\n", "utf8");

    await pruneOldLogs(dir);

    const remaining = await readdir(dir);
    expect(remaining).toContain(keep);
    expect(remaining).toContain("notes.txt");
    expect(remaining).not.toContain("20000101.log");
    expect(remaining).not.toContain("20000101-010101-utc.log");
  });
});
