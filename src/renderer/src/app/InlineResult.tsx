import type { ReactElement, ReactNode } from "react";

import { CloseIcon, ErrorIcon } from "./Icon";

export function InlineError({
  children,
  id,
  onDismiss,
  className = "",
}: {
  children: ReactNode;
  id?: string;
  onDismiss?: () => void;
  className?: string;
}): ReactElement {
  return (
    <div
      id={id}
      className={`inline-result inline-result--error${className ? ` ${className}` : ""}`}
      role="alert"
      aria-atomic="true"
    >
      <span className="inline-result__severity">
        <ErrorIcon />
        <span>Error</span>
      </span>
      <div className="inline-result__message">{children}</div>
      {onDismiss ? (
        <button
          type="button"
          className="button button--ghost button--compact"
          onClick={onDismiss}
          aria-label="Dismiss error"
        >
          <CloseIcon />
        </button>
      ) : null}
    </div>
  );
}
