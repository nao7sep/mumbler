export type NavDirection = "next" | "prev" | "page-next" | "page-prev" | "first" | "last";

/**
 * The roving-navigation index math shared by the app's in-app composite layers
 * (Menu, useQueueListbox). Given the current item index and the item count,
 * returns the index a directional key should move to.
 *
 * Stops at the ends (no wrapping). When nothing is current yet (index `-1`),
 * "next" enters at the first item and "prev" at the last. Returns `-1` for an
 * empty set. The consumers map their own keys onto a direction (e.g. the menu
 * uses Up/Down) and keep the DOM focus movement, which is verified by manual QA.
 */
export function nextIndex(
  direction: NavDirection,
  current: number,
  length: number,
  pageStep = 1,
): number {
  if (length === 0) return -1;
  switch (direction) {
    case "next":
      return current < 0 ? 0 : Math.min(current + 1, length - 1);
    case "prev":
      return current < 0 ? length - 1 : Math.max(current - 1, 0);
    case "page-next":
      return current < 0 ? 0 : Math.min(current + Math.max(1, pageStep), length - 1);
    case "page-prev":
      return current < 0 ? length - 1 : Math.max(current - Math.max(1, pageStep), 0);
    case "first":
      return 0;
    case "last":
      return length - 1;
  }
}

export function indexOfId(ids: readonly string[], id: string | null | undefined): number {
  return id ? ids.indexOf(id) : -1;
}

export function currentCompositeIndex({
  ids,
  focusedId,
  activeId,
  selectedId,
}: {
  ids: readonly string[];
  focusedId?: string | null;
  activeId?: string | null;
  selectedId?: string | null;
}): number {
  const focused = indexOfId(ids, focusedId);
  if (focused >= 0) return focused;
  const active = indexOfId(ids, activeId);
  if (active >= 0) return active;
  return indexOfId(ids, selectedId);
}

export function removalFocusTargetId(
  remainingIds: readonly string[],
  removedIndex: number,
): string | null {
  return remainingIds[removedIndex] ?? remainingIds[removedIndex - 1] ?? null;
}
