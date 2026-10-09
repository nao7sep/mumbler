import { QUIT_BUDGETS, within } from "./quit";

/** macOS closes its workspace without quitting the application. */
export function createWindowCloseController(steps: {
  /** Asks before discarding session-only drafts; false keeps the window open. */
  confirm(): Promise<boolean>;
  flush(signal: AbortSignal): Promise<void>;
  close(): void;
  failed(): Promise<void>;
  dismiss(): void;
}): { request(): void; cancel(): void } {
  let attempt: AbortController | null = null;
  return {
    request() {
      if (attempt !== null) return;
      const current = new AbortController();
      attempt = current;
      void (async () => {
        if (!(await steps.confirm()) || attempt !== current) return;
        const flushed = await within(Promise.resolve().then(() => steps.flush(current.signal)), QUIT_BUDGETS.user.flush);
        if (attempt !== current) return;
        current.abort();
        if (flushed.done) steps.close();
        else await steps.failed();
      })().catch(() => {
        // A failed error notice also retains the window and its unsent edits.
      }).finally(() => {
        current.abort();
        if (attempt === current) attempt = null;
      });
    },
    cancel() {
      attempt?.abort();
      attempt = null;
      steps.dismiss();
    },
  };
}
