import type { ReactElement, ReactNode } from "react";

export interface BannerCardProps {
  title: string;
  body?: string;
  variant: "error" | "warning" | "notice";
  onDismiss?: () => void;
  children?: ReactNode;
}

export function BannerCard({
  title,
  body,
  variant,
  onDismiss,
  children,
}: BannerCardProps): ReactElement {
  return (
    <section className={`panel panel--nested banner banner--${variant}`}>
      <div className="banner__header">
        <p className="empty-state__title">{title}</p>
        {onDismiss ? (
          <button
            type="button"
            className="button button--ghost button--compact"
            onClick={onDismiss}
          >
            Dismiss
          </button>
        ) : null}
      </div>
      {body ? <p className="empty-state__body">{body}</p> : null}
      {children}
    </section>
  );
}

export interface DecisionModalProps {
  title: string;
  body: string;
  actions: Array<{
    label: string;
    onClick: () => void;
    variant?: "primary" | "danger" | "ghost";
  }>;
}

export function DecisionModal({ title, body, actions }: DecisionModalProps): ReactElement {
  return (
    <div className="modal-backdrop">
      <section className="modal-card modal-card--narrow">
        <div className="modal-card__header">
          <h2>{title}</h2>
        </div>
        <p className="empty-state__body">{body}</p>
        <div className="modal-actions">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={`button button--${action.variant ?? "ghost"}`}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
