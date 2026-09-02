import React from "react";

export class RendererErrorBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    const diagnostic = error instanceof Error
      ? { message: error.message, stack: error.stack, componentStack: info.componentStack ?? "" }
      : { message: String(error), componentStack: info.componentStack ?? "" };
    try {
      void window.mumbler.reportRendererError({
        message: diagnostic.message,
        source: "react error boundary",
        stack: [diagnostic.stack, diagnostic.componentStack].filter(Boolean).join("\n"),
      }).catch((logError) => console.error("Failed to record renderer failure", logError));
    } catch (logError) {
      console.error("Failed to record renderer failure", logError);
    }
  }

  override render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="renderer-failure" role="alert">
        <div className="renderer-failure__card">
          <h1>Mumbler could not keep this window open.</h1>
          <p>Reload the window to recover. Your recordings and saved files are unchanged.</p>
          <button type="button" onClick={() => window.location.reload()}>Reload window</button>
        </div>
      </main>
    );
  }
}
