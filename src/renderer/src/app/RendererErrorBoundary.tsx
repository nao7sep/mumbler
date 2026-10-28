import React from "react";
import { describeRendererError } from "./presentFailure";
import { documentTranslator } from "../i18n/I18nContext";

export class RendererErrorBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    const diagnostic = describeRendererError(error);
    const stack = [diagnostic.stack, info.componentStack].filter(Boolean).join("\n");
    try {
      void window.mumbler.reportRendererError({
        ...diagnostic,
        source: "react error boundary",
        ...(stack ? { stack } : {}),
      }).catch((logError) => console.error("Failed to record renderer failure", logError));
    } catch (logError) {
      console.error("Failed to record renderer failure", logError);
    }
  }

  override render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    // Outside the language provider: speak the language the document last declared.
    const { t } = documentTranslator();
    return (
      <main className="renderer-failure" role="alert">
        <div className="renderer-failure__card">
          <h1>{t("boundary.title")}</h1>
          <p>{t("boundary.body")}</p>
          <button className="button button--primary" type="button" onClick={() => window.location.reload()}>{t("boundary.reload")}</button>
        </div>
      </main>
    );
  }
}
