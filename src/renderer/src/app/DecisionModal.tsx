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
  // The safe action takes focus: the first one that is not destructive. A confirmation
  // exists because something could go wrong, so the action a reflexive Enter reaches
  // must be the one that costs nothing. Marking it by variant rather than by position
  // means reordering the footer cannot hand Enter to a destructive action. When every
  // action is destructive there is no safe default worth defaulting to, so nothing is
  // marked and focus stays on the surface.
  const safeIndex = actions.findIndex((action) => (action.variant ?? "ghost") !== "danger");
  return (
    <ModalShell
      title={title}
      size="narrow"
      onRequestClose={onRequestClose}
      showCloseButton={false}
      describedById={bodyId}
      initialFocus={safeIndex >= 0 ? "firstControl" : "surface"}
      footer={actions.map((action, index) => (
        <button
          key={action.label}
          type="button"
          data-modal-autofocus={index === safeIndex ? "" : undefined}
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
