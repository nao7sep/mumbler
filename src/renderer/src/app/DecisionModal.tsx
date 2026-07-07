import { useId, type ReactElement } from "react";

import { ModalShell } from "./modal/ModalShell";

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
