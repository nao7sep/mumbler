import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { formatUtcMarker } from "@shared/timestamps";

const LOG_RETENTION_DAYS = 30;

export interface AppLogger {
  debug(op: string, message: string, details?: unknown): Promise<void>;
  info(op: string, message: string, details?: unknown): Promise<void>;
  warn(op: string, message: string, details?: unknown): Promise<void>;
  error(op: string, message: string, error: unknown, details?: unknown): Promise<void>;
}

export function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return error;
}

function redactSecrets(value: string, secrets: string[]): string {
  return secrets.reduce((output, secret) => {
    if (secret.length === 0) {
      return output;
    }
    return output.split(secret).join("[REDACTED]");
  }, value);
}

function formatUtcDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}${month}${day}`;
}

export function createLogger(logsDir: string, secrets: string[]): AppLogger {
  // One file per launch, named with the full UTC timestamp (matching the other
  // apps' log naming). The stamp is captured once here — not per write — so
  // every line of a session lands in the same file.
  const filePath = join(logsDir, `${formatUtcMarker(new Date())}.log`);

  const write = async (
    level: "debug" | "info" | "warn" | "error",
    op: string,
    message: string,
    details?: unknown,
    error?: unknown,
  ): Promise<void> => {
    const payload = {
      time: new Date().toISOString(),
      level,
      op,
      message,
      ...(details === undefined ? {} : { details }),
      ...(error === undefined ? {} : { error: serializeError(error) }),
    };

    const sanitized = redactSecrets(JSON.stringify(payload), secrets);
    await writeFile(filePath, `${sanitized}\n`, { encoding: "utf8", flag: "a" });
  };

  return {
    debug: (op, message, details) => write("debug", op, message, details),
    info: (op, message, details) => write("info", op, message, details),
    warn: (op, message, details) => write("warn", op, message, details),
    error: (op, message, error, details) => write("error", op, message, details, error),
  };
}

// Matches both the per-launch form (yyyymmdd-hhmmss-utc.log) and the legacy
// daily form (yyyymmdd.log), so logs written before the naming change are still
// pruned. The leading 8 digits are the UTC date in either form.
const LOG_FILE_PATTERN = /^(\d{8})(?:-\d{6}-utc)?\.log$/;

export async function pruneOldLogs(logsDir: string): Promise<void> {
  const entries = await readdir(logsDir, { withFileTypes: true });
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - LOG_RETENTION_DAYS);
  const cutoffStamp = Number(formatUtcDate(cutoff));

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && LOG_FILE_PATTERN.test(entry.name))
      .map(async (entry) => {
        const stamp = Number(entry.name.slice(0, 8));
        if (stamp < cutoffStamp) {
          await rm(join(logsDir, entry.name), { force: true });
        }
      }),
  );
}
