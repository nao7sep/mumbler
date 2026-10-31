import { parentPort, workerData } from "node:worker_threads";

import { BackupStoreEngine } from "./backup-store-engine.ts";
import type { FileWriter } from "./format-versions.ts";

type WorkerRequest =
  | { type: "record"; path: string; bytes: Uint8Array; writtenAtUtc: string }
  | { type: "close" };

type WorkerResponse =
  | { type: "warning"; message: string; details: Record<string, unknown>; off: boolean }
  | { type: "closed" };

if (parentPort === null) {
  throw new Error("Backup store worker requires a parent port.");
}

const port = parentPort;
const data = workerData as { file: string; session: string; writer: FileWriter };
const engine = new BackupStoreEngine(data.file, data.session, data.writer, (message, details, off = false) => {
  port.postMessage({ type: "warning", message, details, off } satisfies WorkerResponse);
});

port.on("message", (message: WorkerRequest) => {
  if (message.type === "record") {
    engine.record(message.path, message.bytes, message.writtenAtUtc);
    return;
  }

  engine.close();
  port.postMessage({ type: "closed" } satisfies WorkerResponse);
  port.close();
});
