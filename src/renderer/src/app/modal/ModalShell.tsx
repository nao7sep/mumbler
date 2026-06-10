import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { getFocusableElements, trapTabFocus } from "./focusTrap";
import { isTopmostModal, registerModal, unregisterModal } from "./modalStack";

export type ModalSize = "narrow" | "default" | "settings";

export interface ModalShellProps {
  /** Visible heading; also the accessible name via aria-labelledby. */
  title: string;
  size?: ModalSize;
  /**
   * Single close guard for every close path (Escape, backdrop, close button).
   * The owner decides whether to close, run a dirty check, or block.
   */
  onRequestClose: () => void;
  /** Blocks all close paths while a genuinely uninterruptible operation runs. */
  closeDisabled?: boolean;
  showCloseButton?: boolean;
  /** Element id of stable explanatory text to announce via aria-describedby. */
  describedById?: string;
  /**
   * Where focus lands on open. "surface" focuses the dialog itself so screen
   * readers announce the dialog name, then Tab enters the controls — the right
   * default for forms. "firstControl" focuses the first control, which for
   * confirmations is the safe/cancel action (actions are ordered safe-first).
   */
  initialFocus?: "surface" | "firstControl";
  footer?: ReactNode;
  children: ReactNode;
}

const SIZE_CLASS: Record<ModalSize, string> = {
  narrow: "modal-card modal-card--narrow",
  default: "modal-card",
  settings: "modal-card modal-card--settings",
};

export function ModalShell({
  title,
  size = "default",
  onRequestClose,
  closeDisabled = false,
  showCloseButton = true,
  describedById,
  initialFocus = "surface",
  footer,
  children,
}: ModalShellProps): ReactElement {
  const titleId = useId();
  const cardRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const card = cardRef.current;
    const previouslyFocused = document.activeElement;
    const id = registerModal();

    if (card !== null) {
      const target =
        initialFocus === "firstControl" ? getFocusableElements(card)[0] ?? card : card;
      target.focus();
    }

    // Safety net for focus that escapes the topmost modal through programmatic
    // moves or browser quirks (Tab is already contained by the card's keydown
    // handler). Pull focus back to the dialog surface — the neutral landing that
    // keeps Escape working without yanking the user onto a specific control.
    function onFocusIn(event: FocusEvent): void {
      if (card === null || !isTopmostModal(id)) {
        return;
      }
      if (event.target instanceof Node && card.contains(event.target)) {
        return;
      }
      card.focus();
    }

    document.addEventListener("focusin", onFocusIn);

    return () => {
      document.removeEventListener("focusin", onFocusIn);
      unregisterModal(id);
      if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
    // Open-once: identity registration and focus capture must happen exactly
    // when this modal mounts. `initialFocus` is a mount-time choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      // The topmost modal owns Escape unconditionally: swallow it so it never
      // reaches the window-level shortcut/menu handler, then close only if a
      // busy operation isn't holding the modal open.
      event.stopPropagation();
      if (!closeDisabled) {
        onRequestClose();
      }
      return;
    }
    if (event.key === "Tab" && cardRef.current !== null) {
      trapTabFocus(cardRef.current, event.nativeEvent);
    }
  }

  function handleBackdropClick(event: ReactMouseEvent<HTMLDivElement>): void {
    if (event.target !== event.currentTarget || closeDisabled) {
      return;
    }
    onRequestClose();
  }

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick}>
      <section
        ref={cardRef}
        className={SIZE_CLASS[size]}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedById}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <div className="modal-card__header">
          <h2 id={titleId}>{title}</h2>
          {showCloseButton ? (
            <button
              type="button"
              className="button button--ghost button--compact modal-close"
              onClick={onRequestClose}
              disabled={closeDisabled}
              aria-label="Close"
            >
              ✕
            </button>
          ) : null}
        </div>
        {children}
        {footer ? <div className="modal-actions">{footer}</div> : null}
      </section>
    </div>
  );
}
