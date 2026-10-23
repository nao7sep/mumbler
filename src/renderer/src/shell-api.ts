import type { MumblerShellApi } from "@shared/app-shell";
import { isIpcFailure } from "@shared/ipc-result";

/** Created in the renderer, after the plain result crossed Electron's bridges. */
export class HandledIpcError extends Error {
  constructor() {
    super("The operation could not be completed.");
    this.name = "HandledIpcError";
  }
}

// Event registrations and local synchronous bridge helpers keep their return
// values. Only asynchronous operation results need the IPC failure contract.
export const shellApi = new Proxy({} as MumblerShellApi, {
  get(_target, key) {
    const bridge = window.mumbler;
    const method = bridge === undefined ? undefined : Reflect.get(bridge, key);
    if (typeof method !== "function") return method;
    return (...args: unknown[]): unknown => {
      const result: unknown = Reflect.apply(method, bridge, args);
      if (typeof result !== "object" || result === null || !("then" in result) || typeof result.then !== "function") return result;
      return (result as Promise<unknown>).then((value) => {
        if (isIpcFailure(value)) throw new HandledIpcError();
        return value;
      });
    };
  },
});
