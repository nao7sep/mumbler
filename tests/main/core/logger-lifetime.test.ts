import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger, type SessionLogger } from "@main/core/logger";
import type { RecordsWorkerRequest } from "@main/core/records-engine";

interface WorkerFixture {
  requests: RecordsWorkerRequest[];
  termination: Promise<number> | null;
  terminate: ReturnType<typeof vi.fn>;
  emit(event: string, ...args: unknown[]): boolean;
}
const workers = vi.hoisted(() => [] as WorkerFixture[]);
const fallback = vi.hoisted(() => ({
  held: new Map<string, Promise<void>>(),
  started: [] as string[],
  completed: [] as string[],
  writes: [] as Promise<void>[],
}));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      requests: RecordsWorkerRequest[] = [];
      termination: Promise<number> | null = null;
      constructor() { super(); workers.push(this); }
      unref() {}
      postMessage(request: RecordsWorkerRequest) {
        this.requests.push(request);
        if (request.type === "close") queueMicrotask(() => this.emit("message", { type: "closed" }));
      }
      terminate = vi.fn(() => (this.termination ?? Promise.resolve(0)).then((code) => {
        this.emit("exit", code);
        return code;
      }));
    },
  };
});
vi.mock("node:fs/promises", () => ({
  mkdir: async () => undefined,
  appendFile: (_path: string, line: string) => {
    const { message } = JSON.parse(line) as { message: string };
    const write = (async () => {
      fallback.started.push(message);
      await fallback.held.get(message);
      fallback.completed.push(message);
    })();
    fallback.writes.push(write);
    return write;
  },
}));

const opened: SessionLogger[] = [];
const releases: Array<() => void> = [];
function open(): SessionLogger {
  const logger = createLogger({ recordsPath: "/unused/records.sqlite3", logsDir: "/unused/logs" }, { debugEnabled: true });
  opened.push(logger);
  return logger;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  workers.length = 0;
  fallback.held.clear();
  fallback.started.length = 0;
  fallback.completed.length = 0;
  fallback.writes.length = 0;
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  const closing = opened.splice(0).map((logger) => logger.close());
  await vi.advanceTimersByTimeAsync(5_000);
  await Promise.allSettled(closing);
  await Promise.allSettled(fallback.writes);
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("optional records lifetime", () => {
  it("retains missing-history health after later successful writes", async () => {
    const logger = open();
    const changed = vi.fn();
    logger.onRecordsChanged(changed);
    expect(logger.recordsMissing()).toBe(false);
    const first = logger.info("test", "missing");
    const request = workers[0]!.requests[0]!;
    workers[0]!.emit("message", { type: "written", id: "id" in request ? request.id : -1, stored: false });
    await first;
    expect(fallback.completed, "main writes the refused entry to the fallback file").toEqual(["missing"]);
    expect(logger.recordsMissing()).toBe(true);
    expect(changed).toHaveBeenLastCalledWith(true);
    const second = logger.info("test", "stored");
    const next = workers[0]!.requests[1]!;
    workers[0]!.emit("message", { type: "written", id: "id" in next ? next.id : -1, stored: true });
    await second;
    expect(logger.recordsMissing()).toBe(true);
    expect(changed).toHaveBeenLastCalledWith(true);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("reports uncertain worker-exit history once while fallback writes continue", async () => {
    const logger = open();
    const changed = vi.fn();
    logger.onRecordsChanged(changed);
    const first = logger.info("test", "first");
    workers[0]!.emit("exit", 1);
    await first;
    await logger.info("test", "second");
    expect(fallback.completed).toEqual(["first", "second"]);
    expect(logger.recordsMissing()).toBe(true);
    expect(changed).toHaveBeenCalledExactlyOnceWith(true);
  });
});
