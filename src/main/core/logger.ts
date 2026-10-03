import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

import { formatUtcMarkerMs } from "@shared/timestamps";

import {
  fallbackLine,
  reportRecordsFailure,
  writeRecordsReport,
  type RecordEntry,
  type RecordsRead,
  type RecordsReadResults,
  type RecordsTarget,
  type RecordsWorkerRequest,
  type RecordsWorkerResponse,
} from "./records-engine";

export type LogLevel = "debug" | "info" | "warn" | "error";

// One call to an outside provider, recorded whole (data-lifecycle-conventions,
// Records). `error` is the raw failure; the logger serializes it.
export interface ProviderCallRecord {
  provider: string;
  operation: string;
  endpoint: string | null;
  model: string | null;
  cardId: string | null;
  step: string | null;
  attempt: number | null;
  startedAt: string;
  finishedAt: string;
  request: unknown;
  response: unknown;
  error: unknown;
}

export interface AppLogger {
  debug(op: string, message: string, details?: unknown): Promise<void>;
  info(op: string, message: string, details?: unknown): Promise<void>;
  warn(op: string, message: string, details?: unknown): Promise<void>;
  error(op: string, message: string, error: unknown, details?: unknown): Promise<void>;
  providerCall(record: ProviderCallRecord): Promise<void>;
}

export interface SessionLogger extends AppLogger {
  // This launch's session, as every record of it carries.
  readonly session: string;
  // Reads the records database after every entry already given.
  readRecords<R extends RecordsRead>(read: R): Promise<RecordsReadResults[R["op"]]>;
  // Writes every entry already given, then releases the database.
  close(): Promise<void>;
  // Called after each entry the database stored; an entry that went to the
  // fallback file is not in the database, so it calls nothing.
  onStored(listener: () => void): void;
}

export interface LoggerOptions {
  // `debug` lines are written only when this is true — set from a dev build or an
  // explicit MUMBLER_DEBUG=1, and off in a packaged release so the developer-only
  // firehose never reaches an end-user's disk.
  debugEnabled: boolean;
}

export interface LoggerPaths {
  recordsPath: string;
  logsDir: string;
}

const MAX_ERROR_CAUSE_DEPTH = 8;
const CLOSE_TIMEOUT_MS = 5_000;

// Captures the full exception — type, message, stack — and follows the `cause`
// chain for wrapped errors, so a log line carries enough to reconstruct the
// failure. Depth-bounded so a pathological self-referential cause can't loop.
export function serializeError(error: unknown, depth = 0): unknown {
  if (error instanceof Error) {
    const serialized: Record<string, unknown> = {
      ...error,
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    if (error.cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH) {
      serialized.cause = serializeError(error.cause, depth + 1);
    }
    if (error instanceof AggregateError && depth < MAX_ERROR_CAUSE_DEPTH) {
      serialized.errors = error.errors.map((entry: unknown) => serializeError(entry, depth + 1));
    }
    return serialized;
  }

  return error;
}

// A value that cannot be serialized (a BigInt, a cycle) is replaced by the
// reason, so the entry itself is never lost.
function toJson(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch (failure: unknown) {
    return JSON.stringify({ serializationError: failure instanceof Error ? failure.message : String(failure) });
  }
}

function cardIdOf(details: unknown): string | null {
  if (typeof details !== "object" || details === null) return null;
  const { cardId } = details as { cardId?: unknown };
  return typeof cardId === "string" ? cardId : null;
}

// Every entry of this process launch goes to the records database through one
// worker thread (logging-conventions, Where logs go); a write it cannot make
// lands in this session's text file under logs/. Each call resolves once its
// entry is written.
export function createLogger(paths: LoggerPaths, options: LoggerOptions): SessionLogger {
  const sessionStart = new Date();
  const session = sessionStart.toISOString();
  const target: RecordsTarget = {
    databasePath: paths.recordsPath,
    fallbackPath: join(paths.logsDir, `${formatUtcMarkerMs(sessionStart)}.log`),
  };

  let worker: Worker | null = null;
  let workerFailed = false;
  let closing: Promise<void> | null = null;
  let nextId = 1;
  const pending = new Map<number, { entry: RecordEntry; resolve: () => void }>();
  const reads = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  let fallbackTail: Promise<void> = Promise.resolve();
  let storedListener: (() => void) | null = null;

  const appendFallback = (entry: RecordEntry): Promise<void> => {
    const line = fallbackLine(entry);
    const append = async (): Promise<void> => {
      try {
        await mkdir(dirname(target.fallbackPath), { recursive: true });
        await appendFile(target.fallbackPath, line, "utf8");
      } catch (error: unknown) {
        reportRecordsFailure(error, line);
      }
    };
    fallbackTail = fallbackTail.then(append);
    return fallbackTail;
  };

  // Entries the worker had not confirmed go to the fallback file, so a worker
  // that fails or does not close in time loses none of them.
  const fallBackPending = (): void => {
    const unwritten = [...pending.values()];
    pending.clear();
    for (const { entry, resolve } of unwritten) {
      void appendFallback(entry).then(resolve);
    }
  };

  const failReads = (): void => {
    const unanswered = [...reads.values()];
    reads.clear();
    for (const { reject } of unanswered) reject(new Error("The records database could not be read."));
  };

  const failWorker = (error: unknown): void => {
    if (!workerFailed) {
      workerFailed = true;
      reportRecordsFailure(error);
    }
    fallBackPending();
    failReads();
    void worker?.terminate();
    worker = null;
  };

  const ensureWorker = (): Worker => {
    if (worker !== null) return worker;
    // Tests run the source with Node's TypeScript stripping; the app runs
    // electron-vite's records-worker.js entry.
    const workerModule = import.meta.url.endsWith(".ts") ? "./records-worker.ts" : "./records-worker.js";
    const created = new Worker(new URL(workerModule, import.meta.url), { workerData: target });
    created.unref();
    created.on("message", (message: RecordsWorkerResponse) => {
      if (message.type === "written") {
        pending.get(message.id)?.resolve();
        pending.delete(message.id);
        if (message.stored) storedListener?.();
      } else if (message.type === "read") {
        const read = reads.get(message.id);
        reads.delete(message.id);
        if (message.ok) read?.resolve(message.value as never);
        else read?.reject(new Error(message.error));
      } else if (message.type === "report") {
        writeRecordsReport(message.text);
      }
    });
    created.on("error", failWorker);
    created.on("exit", (code) => {
      if (closing === null && worker === created) {
        failWorker(new Error(`records worker exited with code ${code}`));
      }
    });
    worker = created;
    return created;
  };

  const writeEntry = (entry: RecordEntry): Promise<void> => {
    if (workerFailed || closing !== null) {
      return appendFallback(entry);
    }
    return new Promise<void>((resolve) => {
      const id = nextId++;
      pending.set(id, { entry, resolve });
      try {
        ensureWorker().postMessage({ type: "write", id, entry } satisfies RecordsWorkerRequest);
      } catch (error: unknown) {
        failWorker(error);
      }
    });
  };

  const readRecords = <R extends RecordsRead>(read: R): Promise<RecordsReadResults[R["op"]]> => {
    if (workerFailed || closing !== null) {
      return Promise.reject(new Error("The records database could not be read."));
    }
    return new Promise((resolve, reject) => {
      const id = nextId++;
      reads.set(id, { resolve: resolve as (value: never) => void, reject });
      try {
        ensureWorker().postMessage({ type: "read", id, read } satisfies RecordsWorkerRequest);
      } catch (error: unknown) {
        failWorker(error);
      }
    });
  };

  const log = (level: LogLevel, op: string, message: string, details?: unknown, error?: unknown): Promise<void> => {
    if (level === "debug" && !options.debugEnabled) {
      return Promise.resolve();
    }
    return writeEntry({
      kind: "log",
      session,
      time: new Date().toISOString(),
      level,
      op,
      message,
      cardId: cardIdOf(details),
      details: toJson(details),
      error: error === undefined ? null : toJson(serializeError(error)),
    });
  };

  const close = (): Promise<void> => {
    if (closing !== null) return closing;
    const current = worker;
    if (current === null) {
      closing = Promise.resolve();
      return closing;
    }
    closing = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
      const settle = (): void => {
        clearTimeout(timer);
        resolve();
      };
      current.once("exit", settle);
      current.on("message", (message: RecordsWorkerResponse) => {
        if (message.type === "closed") settle();
      });
      try {
        current.postMessage({ type: "close" } satisfies RecordsWorkerRequest);
      } catch {
        settle();
      }
    }).then(async () => {
      worker = null;
      await current.terminate().catch(() => undefined);
      fallBackPending();
      failReads();
      await fallbackTail;
    });
    return closing;
  };

  return {
    session,
    readRecords,
    debug: (op, message, details) => log("debug", op, message, details),
    info: (op, message, details) => log("info", op, message, details),
    warn: (op, message, details) => log("warn", op, message, details),
    error: (op, message, error, details) => log("error", op, message, details, error),
    providerCall: (record) =>
      writeEntry({
        kind: "provider-call",
        session,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        cardId: record.cardId,
        step: record.step,
        attempt: record.attempt,
        provider: record.provider,
        operation: record.operation,
        endpoint: record.endpoint,
        model: record.model,
        request: toJson(record.request) ?? "null",
        response: toJson(record.response),
        error: record.error === null || record.error === undefined ? null : toJson(serializeError(record.error)),
      }),
    close,
    onStored: (listener) => {
      storedListener = listener;
    },
  };
}
