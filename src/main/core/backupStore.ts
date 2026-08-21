import path from "node:path";
import { Worker } from "node:worker_threads";

import { storageRoot } from "./storage-root";

export type BackupWarn = (message: string, details: Record<string, unknown>) => void;

type WorkerResponse =
  | { type: "warning"; message: string; details: Record<string, unknown> }
  | { type: "closed" };

let warn: BackupWarn = (message, details) => {
  console.warn(message, details);
};

let worker: Worker | null = null;
let closing: Promise<void> | null = null;
let disabled = false;
let failureReported = false;

export function setBackupStoreWarn(sink: BackupWarn): void {
  warn = sink;
}

// Enqueue the exact bytes immediately after their atomic save lands. The worker
// receives messages FIFO, so per-path history and dedup retain save order while
// SQLite open, hashing, lock waits, and inserts never block Electron's main/save
// path. The timestamp is captured here at enqueue time rather than later in the
// worker, so it describes the completed save.
export function record(absolutePath: string, bytes: Buffer): void {
  if (disabled || closing !== null) return;
  try {
    ensureWorker().postMessage({
      type: "record",
      path: absolutePath,
      bytes,
      writtenAtUtc: new Date().toISOString(),
    });
  } catch (error: unknown) {
    disableAfterFailure("backup store: could not start worker; recording disabled for this session", {
      file: storeFile(),
      error: errorInfo(error),
    });
  }
}

// Drain every queued record and close its SQLite handle. The close message sits
// behind prior record messages in the same FIFO worker channel. Tests use this
// to inspect the store; graceful app shutdown uses it before process exit.
export async function closeBackupStore(): Promise<void> {
  if (closing !== null) return closing;
  const current = worker;
  if (current === null) {
    resetSession();
    return;
  }

  closing = new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    current.once("error", settle);
    current.once("exit", settle);
    current.on("message", (message: WorkerResponse) => {
      if (message.type === "closed") settle();
    });
    try {
      current.postMessage({ type: "close" });
    } catch {
      settle();
    }
  });

  try {
    await closing;
    await current.terminate().catch(() => undefined);
  } finally {
    resetSession();
  }
}

function ensureWorker(): Worker {
  if (worker !== null) return worker;
  // Tests execute the source module directly with Node's TypeScript stripping;
  // the app runs electron-vite's explicit backup-store-worker.js entry.
  const workerModule = import.meta.url.endsWith(".ts")
    ? "./backup-store-worker.ts"
    : "./backup-store-worker.js";
  const created = new Worker(new URL(workerModule, import.meta.url), {
    workerData: { file: storeFile() },
  });
  created.on("message", (message: WorkerResponse) => {
    if (message.type === "warning") warn(message.message, message.details);
  });
  created.on("error", (error) => {
    disableAfterFailure("backup store: worker failed; recording disabled for this session", {
      file: storeFile(),
      error: errorInfo(error),
    });
  });
  created.on("exit", (code) => {
    if (closing === null && worker === created) {
      worker = null;
    }
    if (code !== 0 && closing === null) {
      disableAfterFailure("backup store: worker exited; recording disabled for this session", {
        file: storeFile(),
        exitCode: code,
      });
    }
  });
  worker = created;
  return created;
}

function storeFile(): string {
  return path.join(storageRoot(), "backups.sqlite3");
}

function disableAfterFailure(message: string, details: Record<string, unknown>): void {
  disabled = true;
  if (!failureReported) {
    failureReported = true;
    warn(message, details);
  }
}

function resetSession(): void {
  worker = null;
  closing = null;
  disabled = false;
  failureReported = false;
}

function errorInfo(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
