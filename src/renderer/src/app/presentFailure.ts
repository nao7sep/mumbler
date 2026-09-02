/**
 * Preserve a recovered renderer failure in the session log while returning
 * stable operation copy that cannot contain an IPC wrapper, errno, or path.
 */
export function presentFailure(error: unknown, userMessage: string, source: string): string {
  reportRendererDiagnostic(error, source);
  return userMessage;
}

export function reportRendererDiagnostic(error: unknown, source: string): void {
  const known = error instanceof Error ? error : new Error(String(error));
  const reporter = window.mumbler?.reportRendererDiagnostic;
  if (typeof reporter !== "function") return;
  void reporter({
    message: known.message,
    source,
    stack: known.stack,
  }).catch(() => {
    // The failed operation's IPC boundary normally has the same diagnostic.
    // Reporting must never replace the recovered failure.
  });
}
