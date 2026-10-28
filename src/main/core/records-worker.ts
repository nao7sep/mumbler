import { parentPort, workerData } from "node:worker_threads";

import {
  RecordsEngine,
  type RecordsTarget,
  type RecordsWorkerRequest,
  type RecordsWorkerResponse,
} from "./records-engine.ts";

if (parentPort === null) {
  throw new Error("Records worker requires a parent port.");
}

const port = parentPort;
const engine = new RecordsEngine(workerData as RecordsTarget, (text) => {
  port.postMessage({ type: "report", text } satisfies RecordsWorkerResponse);
});

port.on("message", (message: RecordsWorkerRequest) => {
  if (message.type === "write") {
    const stored = engine.write(message.entry);
    port.postMessage({ type: "written", id: message.id, stored } satisfies RecordsWorkerResponse);
    return;
  }

  if (message.type === "read") {
    let response: RecordsWorkerResponse;
    try {
      response = { type: "read", id: message.id, ok: true, value: engine.read(message.read) };
    } catch (error: unknown) {
      response = {
        type: "read",
        id: message.id,
        ok: false,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
    }
    port.postMessage(response);
    return;
  }

  engine.close();
  port.postMessage({ type: "closed" } satisfies RecordsWorkerResponse);
  port.close();
});
