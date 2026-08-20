/**
 * The pipeline's one cancellation signal-in-error form.
 *
 * Cancelling is not a failure, and the pipeline decides which of the two a card
 * records by asking `isCancelledError`. So every stage that can be interrupted
 * has to reject with THIS type — a stage that lets its own runtime's abort error
 * escape (Node's `AbortError`, an SDK's own) lands the card as *failed*, telling
 * the user something broke when they were the one who stopped it.
 *
 * It lived in `gemini-adapter` under the name `GeminiCancelledError` while the
 * network call was the only interruptible stage. It never was provider-specific
 * — the pipeline's own retry sleep and its between-stage checkpoints threw it
 * too — and the audio tools throw it now as well, so it lives here under a name
 * that says what it means.
 */
export class CancelledError extends Error {
  constructor(message = "Work cancelled by user.") {
    super(message);
    this.name = "CancelledError";
  }
}

export function isCancelledError(error: unknown): boolean {
  return error instanceof CancelledError;
}

/**
 * True for the abort error a Node API raises when an AbortSignal fires —
 * `child_process`, `fs`, and `fetch` all reject this way. Callers translate it
 * into a CancelledError rather than letting it escape, since only the typed
 * error tells the pipeline that a stop was deliberate.
 */
export function isNodeAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR";
}
