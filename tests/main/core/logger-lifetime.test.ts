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
function hold(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { wait, release };
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
  it("releases a timed-out writer while keeping late fallback appends physically ordered", async () => {
    const firstGate = hold();
    fallback.held.set("first", firstGate.wait);
    const logger = open();
    let firstDone = false;
    const first = logger.info("test", "first").then(() => { firstDone = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(firstDone).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(fallback.started).toEqual(["first"]);
    const second = logger.info("test", "second");
    await vi.advanceTimersByTimeAsync(5_000);
    await second;
    expect(fallback.started).toEqual(["first"]);
    firstGate.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(fallback.completed).toEqual(["first", "second"]);
    expect(vi.mocked(process.stderr.write).mock.calls.some(([text]) => String(text).includes("unconfirmed"))).toBe(true);
  });

  it("uses the original write deadline after an early worker error and a stalled fallback", async () => {
    fallback.held.set("held", hold().wait);
    const logger = open();
    let done = false;
    const write = logger.info("test", "held").then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(2_000);
    workers[0]!.emit("error", new Error("worker failed"));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await write;
    expect(fallback.started).toEqual(["held"]);
    expect(fallback.completed).toEqual([]);
  });

  it("bounds reads and observes termination rejection", async () => {
    const logger = open();
    const read = logger.readRecords({ op: "sources" }).catch((error: unknown) => error);
    workers[0]!.termination = Promise.reject(new Error("termination refused"));
    // Attach the rejection observer before advancing the timeout that invokes terminate.
    void workers[0]!.termination.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await read).toMatchObject({ message: "The records database could not be read." });
    expect(vi.mocked(process.stderr.write).mock.calls.some(([text]) => String(text).includes("termination refused"))).toBe(true);
  });

  it("bounds close after worker failure while termination and fallback remain held", async () => {
    fallback.held.set("held", hold().wait);
    const logger = open();
    const write = logger.info("test", "held");
    const termination = hold();
    workers[0]!.termination = termination.wait.then(() => 0);
    workers[0]!.emit("error", new Error("worker failed"));
    let closed = false;
    const close = logger.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([write, close]);
    expect(fallback.completed).toEqual([]);
    expect(logger.close()).toBe(logger.close());
  });

  it("includes a held termination after a successful closed reply in the one close budget", async () => {
    const logger = open();
    const write = logger.info("test", "confirmed");
    const request = workers[0]!.requests[0]!;
    expect(request.type).toBe("write");
    if (request.type !== "write") throw new Error("Expected write request");
    workers[0]!.emit("message", { type: "written", id: request.id, stored: true });
    await write;
    workers[0]!.termination = hold().wait.then(() => 0);
    let closed = false;
    const close = logger.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await close;
    expect(fallback.started).toEqual([]);
  });
});
