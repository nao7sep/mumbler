import { useId, type ReactElement, type ReactNode } from "react";

import { ModalShell } from "./modal/ModalShell";

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
  // Escape and backdrop both route here. Callers pass the safe/cancel path so a
  // dismissal never performs the destructive choice.
  onRequestClose: () => void;
}

export function DecisionModal({ title, body, actions, onRequestClose }: DecisionModalProps): ReactElement {
  const bodyId = useId();
  return (
    <ModalShell
      title={title}
      size="narrow"
      onRequestClose={onRequestClose}
      showCloseButton={false}
      describedById={bodyId}
      initialFocus="firstControl"
      footer={actions.map((action) => (
        <button
          key={action.label}
          type="button"
          className={`button button--${action.variant ?? "ghost"}`}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ))}
    >
      <div className="modal-card__body">
        <p id={bodyId} className="empty-state__body">{body}</p>
      </div>
    </ModalShell>
  );
}
