// Focusable-element discovery and Tab containment for the shared modal shell.
//
// Kept framework-free and DOM-only so the wrapping logic can be unit tested in
// jsdom without rendering React, mirroring how the rest of the renderer's
// keyboard helpers (shortcut-utils) are tested.

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "audio[controls]",
  "video[controls]",
  '[tabindex]:not([tabindex="-1"])',
  "details > summary:first-of-type",
].join(",");

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  // The first/last wrap points depend on document order. A comma-joined
  // selector is document-ordered in real browsers but clause-grouped in some
  // engines (jsdom), so sort explicitly rather than trust querySelectorAll.
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(isInteractable)
    .sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
}

function isInteractable(element: HTMLElement): boolean {
  if (element.hasAttribute("disabled")) {
    return false;
  }
  if (element.getAttribute("aria-hidden") === "true") {
    return false;
  }
  // `hidden` on the element or any ancestor removes it from the tab order.
  if (element.closest("[hidden]") !== null) {
    return false;
  }
  return true;
}

// Contain Tab / Shift+Tab within the container, wrapping at both ends. The
// container itself is the fallback focus target (it carries tabIndex -1), so a
// Tab from the bare dialog surface moves into the first/last control instead of
// escaping to the page behind the modal. Tab between interior controls is left
// to the browser's native order.
export function trapTabFocus(container: HTMLElement, event: KeyboardEvent): void {
  const focusables = getFocusableElements(container);
  if (focusables.length === 0) {
    event.preventDefault();
    return;
  }

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  const activeIsInside = active instanceof HTMLElement && container.contains(active);

  if (event.shiftKey) {
    if (!activeIsInside || active === first || active === container) {
      event.preventDefault();
      last.focus();
    }
  } else {
    if (!activeIsInside || active === last || active === container) {
      event.preventDefault();
      first.focus();
    }
  }
}
