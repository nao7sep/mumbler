// A requested operation was rejected for an expected, user-facing reason — a
// precondition that wasn't met or input that didn't validate (e.g. "card is
// being processed", "API key not configured", "front trim must precede back
// trim"). These are normal control flow surfaced to the user, NOT system
// failures: the IPC boundary logs them at `debug` (developer-only) rather than
// `error`, per the logging conventions' expected-vs-unexpected distinction.
//
// Anything that is genuinely unexpected (an IO/subprocess/network failure, a
// broken invariant) must stay a plain Error / wrapped Error so the IPC boundary
// logs it at `error` with full fidelity.
export class OperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationError";
  }
}
