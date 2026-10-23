import { CancelledError } from "./cancellation";

// Metadata has its own capacity so a transcription slot can be reused while
// earlier recordings generate text. Issued work owns capacity until settlement,
// even if its caller has cancelled and the provider ignores the abort signal.
export class MetadataAdmission {
  private active = 0;
  private readonly waiting: Array<{ start(): void }> = [];

  constructor(private readonly limit: () => number) {}

  async run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      const aborted = (): void => {
        const index = this.waiting.indexOf(waiter);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(new CancelledError("Metadata request cancelled before admission."));
      };
      const waiter = {
        start: (): void => {
          signal.removeEventListener("abort", aborted);
          this.active += 1;
          resolve();
        },
      };
      if (signal.aborted) { aborted(); return; }
      signal.addEventListener("abort", aborted, { once: true });
      this.waiting.push(waiter);
      this.drain();
    });
    try {
      if (signal.aborted) throw new CancelledError("Metadata request cancelled before starting.");
      return await operation();
    } finally {
      this.active -= 1;
      this.drain();
    }
  }

  // Called on settlement and preference changes; lowering the limit never
  // cancels issued calls, and raising it admits already-waiting calls.
  drain(): void {
    while (this.active < this.limit() && this.waiting.length > 0) {
      this.waiting.shift()!.start();
    }
  }
}
