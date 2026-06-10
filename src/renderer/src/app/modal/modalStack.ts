// Coordinates the stack of open app modals so the shared shell can enforce two
// invariants the modal conventions require:
//
//   1. Only the topmost modal/dialog reacts to Escape and focus containment.
//   2. Background scrolling is locked exactly once while ANY modal is open and
//      restored only when the LAST one closes — so a confirmation stacked over a
//      form (e.g. a discard prompt over Settings) never unlocks the page early.
//
// ModalShell registers on mount and unregisters on unmount. Identity is a unique
// symbol per open modal; the most recently registered modal is topmost. Scroll
// lock is reference-counted off the stack depth rather than a boolean so nesting
// is correct.

type ModalId = symbol;

const stack: ModalId[] = [];
let savedBodyOverflow: string | null = null;

export function registerModal(): ModalId {
  const id = Symbol("modal");
  stack.push(id);
  if (stack.length === 1) {
    lockBodyScroll();
  }
  return id;
}

export function unregisterModal(id: ModalId): void {
  const index = stack.lastIndexOf(id);
  if (index !== -1) {
    stack.splice(index, 1);
  }
  if (stack.length === 0) {
    unlockBodyScroll();
  }
}

export function isTopmostModal(id: ModalId): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

function lockBodyScroll(): void {
  if (typeof document === "undefined") {
    return;
  }
  savedBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
}

function unlockBodyScroll(): void {
  if (typeof document === "undefined") {
    return;
  }
  document.body.style.overflow = savedBodyOverflow ?? "";
  savedBodyOverflow = null;
}
