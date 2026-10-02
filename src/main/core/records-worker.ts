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
const engine = new RecordsEngine(workerData as RecordsTarget);

port.on("message", (message: RecordsWorkerRequest) => {
  if (message.type === "write") {
    engine.write(message.entry);
    port.postMessage({ type: "written", id: message.id } satisfies RecordsWorkerResponse);
    return;
  }

  engine.close();
  port.postMessage({ type: "closed" } satisfies RecordsWorkerResponse);
  port.close();
});
