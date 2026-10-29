import { setImmediate } from "node:timers/promises";

/** Waits until `check` passes, trying it first and then after each turn of the
 * event loop, with no deadline: a state that never arrives hangs the test where
 * it waits (tests-folder-conventions, Tests carry no timeouts). The yield is
 * Node's own, so fake timers do not stop it. */
export async function until<T>(check: () => T | Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await check();
    } catch {
      await setImmediate();
    }
  }
}
