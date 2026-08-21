import { parentPort, workerData } from "node:worker_threads";

import { BackupStoreEngine } from "./backup-store-engine.ts";

type WorkerRequest =
  | { type: "record"; path: string; bytes: Uint8Array; writtenAtUtc: string }
  | { type: "close" };

type WorkerResponse =
  | { type: "warning"; message: string; details: Record<string, unknown> }
  | { type: "closed" };

if (parentPort === null) {
  throw new Error("Backup store worker requires a parent port.");
}

const port = parentPort;
const data = workerData as { file: string };
const engine = new BackupStoreEngine(data.file, (message, details) => {
  port.postMessage({ type: "warning", message, details } satisfies WorkerResponse);
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
