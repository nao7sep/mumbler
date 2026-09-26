import type { ReactElement, ReactNode } from "react";

import { CloseIcon } from "./Icon";
import { useI18n } from "../i18n/I18nContext";

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
  const { t } = useI18n();
  return (
    <div
      id={id}
      className={`inline-result inline-result--error${className ? ` ${className}` : ""}`}
      role="alert"
      aria-atomic="true"
    >
      <div className="inline-result__message">{children}</div>
      {onDismiss ? (
        <button
          type="button"
          className="result-close"
          onClick={onDismiss}
          aria-label={t("common.closeResult")}
        >
          <CloseIcon />
        </button>
      ) : null}
    </div>
  );
}
