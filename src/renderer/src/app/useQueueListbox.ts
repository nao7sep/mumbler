// The queue's in-app listbox layer — a PROJECTION-ONLY composite per the
// composite-control conventions. It projects the queue's single source of truth
// (the backend `selectedCardId`) onto the DOM: `role="listbox"`/`role="option"`,
// `aria-selected`, a roving tabindex (the selected row is the sole tab stop, every
// other row is removed from the tab order), and click parity (a click selects,
// mirroring the keyboard command layer).
//
// COMMAND LAYER OWNS NAVIGATION. This hook DELIBERATELY does NOT bind
// Up/Down/Home/End. Queue navigation stays owned by the EXISTING window-level
// command layer in App.tsx (the `select-previous` / `select-next` shortcuts on
// Up/Down), which reads and advances `selectedCardId` through the backend. Folding
// arrow handling into the listbox would duplicate that authority and create the
// cross-control key bleed the conventions warn against; keeping it out is the
// "command layer is separate" rule applied literally.
//
// TYPE-AHEAD IS CONSCIOUSLY CEDED. The single-letter keys the conventions would
// spend on type-ahead (F/B/T/S) are already app commands, so the list cannot also
// claim them — an accepted trade-off, not a violation.
//
// RECOVERY is delegated. When the selected card is removed, the backend recomputes
// `selectedCardId`; this hook simply re-projects, and follows focus to the new
// selected row only when focus already lived in the list (never-steal-focus).

import { useEffect, useRef } from "react";

export interface QueueListboxOptionProps {
  role: "option";
  "aria-selected": boolean;
  tabIndex: 0 | -1;
  "data-card-id": string;
}

export interface QueueListboxContainerProps {
  role: "listbox";
  "aria-label": string;
  ref: React.RefObject<HTMLDivElement | null>;
}

export interface UseQueueListboxResult {
  containerProps: QueueListboxContainerProps;
  getOptionProps: (cardId: string) => QueueListboxOptionProps;
}

export function useQueueListbox(params: {
  cardIds: readonly string[];
  selectedCardId: string | null;
  label: string;
}): UseQueueListboxResult {
  const { cardIds, selectedCardId, label } = params;
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Follow the selection with DOM focus, but never steal it: only move focus to
  // the newly selected row when focus already lives somewhere in the list. The
  // command layer drives the selection change (Up/Down) and the user is keyboard-
  // navigating the list, so the focus move is expected; when focus is elsewhere
  // (a detail-pane field, a dialog) the projection updates silently.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null || selectedCardId === null) {
      return;
    }

    const active = document.activeElement;
    const focusInList = active instanceof Node && container.contains(active);
    if (!focusInList) {
      return;
    }

    const target = container.querySelector<HTMLElement>(
      `[data-card-id="${CSS.escape(selectedCardId)}"]`,
    );
    if (target !== null && target !== active) {
      target.focus();
    }
  }, [selectedCardId, cardIds]);

  return {
    containerProps: {
      role: "listbox",
      "aria-label": label,
      ref: containerRef,
    },
    getOptionProps: (cardId: string): QueueListboxOptionProps => ({
      role: "option",
      "aria-selected": cardId === selectedCardId,
      // Roving tabindex: the selected row is the single tab stop. With nothing
      // selected the list still needs one stop so Tab can enter it, so the first
      // row carries it then.
      tabIndex:
        cardId === selectedCardId || (selectedCardId === null && cardId === cardIds[0])
          ? 0
          : -1,
      "data-card-id": cardId,
    }),
  };
}
