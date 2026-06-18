import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { formatUtcMarker } from "@shared/timestamps";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppLogger {
  debug(op: string, message: string, details?: unknown): Promise<void>;
  info(op: string, message: string, details?: unknown): Promise<void>;
  warn(op: string, message: string, details?: unknown): Promise<void>;
  error(op: string, message: string, error: unknown, details?: unknown): Promise<void>;
}

export interface LoggerOptions {
  // `debug` lines are written only when this is true — set from a dev build or an
  // explicit MUMBLER_DEBUG=1, and off in a packaged release so the developer-only
  // firehose never reaches an end-user's disk.
  debugEnabled: boolean;
}

// This app's own denied-key set (the conventions forbid a cross-app taxonomy).
// Matched by EXACT, case-insensitive field name — never by substring — so
// `token` redacts a field literally named "token" but leaves "tokenCount" and
// "broken" alone. Stored lower-cased for the case-insensitive compare.
const REDACTED_KEYS = new Set([
  "apikey",
  "authorization",
  "token",
  "password",
  "secret",
]);

const REDACTION_MARKER = "[redacted]";
const MAX_ERROR_CAUSE_DEPTH = 8;

// The mandatory non-destructive redaction backstop. It is a pure, total,
// type-preserving function over the structured log object (before serialization):
//   - replaces only the VALUE of an exact, case-insensitive denied-key match with
//     a fixed marker; every other field stays byte-identical,
//   - recurses through nested objects and arrays,
//   - never regex-scans string values and never edits the envelope `message`
//     (because "message" is not a denied key),
//   - cannot throw: primitives pass through, and a cycle guard keeps a malformed
//     (self-referential) object from recursing forever.
// The primary defense against logging secrets remains "summarize, don't dump";
// this only catches the day someone logs a whole object that holds one.
export function redactSecrets(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);
    return value.map((item) => redactSecrets(item, seen));
  }

  if (value !== null && typeof value === "object") {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, fieldValue]) =>
        REDACTED_KEYS.has(key.toLowerCase())
          ? [key, REDACTION_MARKER]
          : [key, redactSecrets(fieldValue, seen)],
      ),
    );
  }

  return value;
}

// Captures the full exception — type, message, stack — and follows the `cause`
// chain for wrapped errors, so a log line carries enough to reconstruct the
// failure. Depth-bounded so a pathological self-referential cause can't loop.
export function serializeError(error: unknown, depth = 0): unknown {
  if (error instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    if (error.cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH) {
      serialized.cause = serializeError(error.cause, depth + 1);
    }
    return serialized;
  }

  return error;
}

export function createLogger(logsDir: string, options: LoggerOptions): AppLogger {
  // One file per launch, named with the full UTC session-start timestamp (see
  // timestamp-conventions). The stamp is captured once here — not per write — so
  // every line of a session lands in the same file.
  const filePath = join(logsDir, `${formatUtcMarker(new Date())}.log`);

  // Serialize appends through a promise chain so concurrent log calls (e.g. from
  // parallel pipelines) can never interleave a partial line. Every line is
  // appended immediately — nothing is buffered in memory — so the last lines
  // before a crash are already on disk without any flush-on-exit machinery, and
  // warn/error/debug get the "flush now" the conventions ask for for free.
  let tail: Promise<void> = Promise.resolve();

  const append = (line: string): Promise<void> => {
    const writeOnce = (): Promise<void> => writeFile(filePath, line, { encoding: "utf8", flag: "a" });
    tail = tail.then(writeOnce, writeOnce).then(
      () => undefined,
      (error: unknown) => {
        // File logging failed (disk full, permissions). Degrade to stderr,
        // best-effort and dependency-free; never crash and never silently
        // swallow the failure — surface it somewhere, even if only the console.
        try {
          process.stderr.write(
            `[mumbler:log] failed to write log line: ${error instanceof Error ? error.message : String(error)}\n${line}`,
          );
        } catch {
          // Last resort: if even stderr is unavailable there is nothing more we
          // can safely do, and logging must never take the app down.
        }
      },
    );
    return tail;
  };

  const write = (
    level: LogLevel,
    op: string,
    message: string,
    details?: unknown,
    error?: unknown,
  ): Promise<void> => {
    // The debug firehose is developer-only: drop it entirely in a release build.
    if (level === "debug" && !options.debugEnabled) {
      return Promise.resolve();
    }

    const payload = {
      time: new Date().toISOString(),
      level,
      op,
      message,
      ...(details === undefined ? {} : { details }),
      ...(error === undefined ? {} : { error: serializeError(error) }),
    };

    let line: string;
    try {
      line = `${JSON.stringify(redactSecrets(payload))}\n`;
    } catch (serializationFailure: unknown) {
      // The payload could not be serialized (e.g. a BigInt in details). Never
      // lose the event: fall back to a minimal, always-serializable envelope.
      line = `${JSON.stringify({
        time: new Date().toISOString(),
        level,
        op,
        message,
        serializationError:
          serializationFailure instanceof Error
            ? serializationFailure.message
            : String(serializationFailure),
      })}\n`;
    }

    return append(line);
  };

  return {
    debug: (op, message, details) => write("debug", op, message, details),
    info: (op, message, details) => write("info", op, message, details),
    warn: (op, message, details) => write("warn", op, message, details),
    error: (op, message, error, details) => write("error", op, message, details, error),
  };
}
