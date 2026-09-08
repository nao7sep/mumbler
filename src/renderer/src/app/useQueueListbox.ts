// The queue's in-app listbox layer owns the listbox interaction per the
// composite-control conventions. It projects the queue's single source of truth
// (the backend `selectedCardId`) onto the DOM: `role="listbox"`/`role="option"`,
// `aria-selected`, a roving tabindex (the selected row is the sole tab stop, every
// other row is removed from the tab order), click parity, and the conventional
// Up/Down/PageUp/PageDown/Home/End navigation keys. Queue arrows deliberately do
// not belong to the window command layer: the focused listbox is their owner.
//
// TYPE-AHEAD IS CONSCIOUSLY CEDED. The single-letter keys the conventions would
// spend on type-ahead (F/B/T/S) are already app commands, so the list cannot also
// claim them — an accepted trade-off, not a violation.
//
// RECOVERY is delegated. When the selected card is removed, the backend recomputes
// `selectedCardId`; this hook simply re-projects, and follows focus to the new
// selected row only when focus already lived in the list (never-steal-focus).

import { useEffect, useRef, type KeyboardEvent } from "react";
import { currentCompositeIndex, nextIndex, type NavDirection } from "./composite-nav";

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
  tabIndex: 0 | -1;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
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

  function focusCard(cardId: string): void {
    const target = containerRef.current?.querySelector<HTMLElement>(
      `[data-card-id="${CSS.escape(cardId)}"]`,
    );
    if (target === undefined || target === null) return;
    target.focus();
    target.scrollIntoView?.({ block: "nearest" });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

    let direction: NavDirection | null = null;
    if (event.key === "ArrowDown") direction = "next";
    else if (event.key === "ArrowUp") direction = "prev";
    else if (event.key === "PageDown") direction = "page-next";
    else if (event.key === "PageUp") direction = "page-prev";
    else if (event.key === "Home") direction = "first";
    else if (event.key === "End") direction = "last";
    if (direction === null) return;

    event.preventDefault();
    const focusedId = document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.cardId
      : undefined;
    const current = currentCompositeIndex({ ids: cardIds, focusedId, selectedId: selectedCardId });
    const scrollOwner = containerRef.current?.closest<HTMLElement>(".queue-pane");
    const firstOption = containerRef.current?.querySelector<HTMLElement>("[data-card-id]");
    const measuredPage = scrollOwner && firstOption?.offsetHeight
      ? Math.floor(scrollOwner.clientHeight / firstOption.offsetHeight)
      : 8;
    const targetIndex = nextIndex(direction, current, cardIds.length, measuredPage);
    if (targetIndex >= 0) focusCard(cardIds[targetIndex]!);
  }

  // Follow the selection with DOM focus, but never steal it: only move focus to
  // the newly selected row when focus already lives somewhere in the list. The
  // listbox drives the selection change and the user is keyboard-navigating the
  // list, so the focus move is expected; when focus is elsewhere
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
      target.scrollIntoView?.({ block: "nearest" });
    }
  }, [selectedCardId, cardIds]);

  return {
    containerProps: {
      role: "listbox",
      "aria-label": label,
      ref: containerRef,
      tabIndex: cardIds.length === 0 ? 0 : -1,
      onKeyDown: handleKeyDown,
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
