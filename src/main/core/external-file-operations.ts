import { availableParallelism } from "node:os";

// Audio on removable/network storage may stall in an uncancellable native call.
// The caller leaves on a deadline; the finite physical owner keeps its slot and
// private files until the operation and its cleanup actually settle.
export const EXTERNAL_FILE_IDLE_MS = 30_000;
export const EXTERNAL_FILE_DEADLINE_MS = 5 * 60_000;
export interface ExternalFileContext { signal: AbortSignal; progress(): void; claimSource(key: string): void }

export class ExternalFileOperations {
  private accepting = true;
  private readonly sources = new Map<string, AbortController>();
  private readonly active = new Map<AbortController, Promise<unknown>>();
  constructor(private readonly limit = availableParallelism()) {}

  run<T>(operation: (context: ExternalFileContext) => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error("External file operation cancelled for quit."));
    if (this.active.size >= this.limit) return Promise.reject(new Error("External file operations are still settling; try again later."));
    const controller = new AbortController();
    const ownedSources = new Set<string>();
    const claimSource = (key: string) => {
      controller.signal.throwIfAborted();
      const owner = this.sources.get(key);
      if (owner !== undefined && owner !== controller) throw new Error("This source recording is still in use by another import operation.");
      this.sources.set(key, controller);
      ownedSources.add(key);
    };
    const abort = (reason: string) => controller.abort(new Error(reason));
    const deadline = setTimeout(() => abort("External file operation exceeded its deadline."), EXTERNAL_FILE_DEADLINE_MS);
    let idle: ReturnType<typeof setTimeout>;
    const progress = () => {
      if (controller.signal.aborted) return;
      clearTimeout(idle);
      idle = setTimeout(() => abort("External file operation stopped making progress."), EXTERNAL_FILE_IDLE_MS);
    };
    progress();
    const physical = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation({ signal: controller.signal, progress, claimSource });
    });
    this.active.set(controller, physical);
    return new Promise<T>((resolve, reject) => {
      const cancelled = () => { clearTimeout(deadline); clearTimeout(idle); reject(controller.signal.reason); };
      controller.signal.addEventListener("abort", cancelled, { once: true });
      const settled = () => {
        clearTimeout(deadline);
        clearTimeout(idle);
        controller.signal.removeEventListener("abort", cancelled);
        this.active.delete(controller);
        for (const key of ownedSources) this.sources.delete(key);
      };
      void physical.then((result) => {
        settled();
        if (!controller.signal.aborted) resolve(result);
      }, (error) => { settled(); reject(error); });
    });
  }

  resume(): void { this.accepting = true; }

  async cancelAndDrain(): Promise<void> {
    this.accepting = false;
    for (const controller of this.active.keys()) controller.abort(new Error("External file operation cancelled for quit."));
    await Promise.allSettled(this.active.values());
  }
}
