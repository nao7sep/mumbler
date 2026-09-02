/**
 * Preserve a recovered renderer failure in the session log while returning
 * stable operation copy that cannot contain an IPC wrapper, errno, or path.
 */
export function presentFailure(error: unknown, userMessage: string, source: string): string {
  reportRendererDiagnostic(error, source);
  return userMessage;
}

export function reportRendererDiagnostic(error: unknown, source: string): void {
  const diagnostic = describeRendererError(error);
  const reporter = window.mumbler?.reportRendererDiagnostic;
  if (typeof reporter !== "function") {
    console.error("[Mumbler] Renderer diagnostic bridge is unavailable.", { source, diagnostic });
    return;
  }
  void reporter({
    ...diagnostic,
    source,
  }).catch((reportError) => {
    console.error("[Mumbler] Renderer diagnostic could not be recorded.", { reportError, source, diagnostic });
  });
}

export function describeRendererError(error: unknown, seen = new WeakSet<object>()): {
  name?: string;
  message: string;
  stack?: string;
  cause?: ReturnType<typeof describeRendererError>;
} {
  if (!(error instanceof Error)) return { message: String(error) };
  if (seen.has(error)) return { name: error.name, message: error.message, cause: { message: "Circular cause" } };
  seen.add(error);
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(error.cause === undefined ? {} : { cause: describeRendererError(error.cause, seen) }),
  };
}
