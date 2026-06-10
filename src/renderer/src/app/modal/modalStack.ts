// Coordinates the stack of open app modals so the shared shell can enforce three
// invariants the modal conventions require:
//
//   1. Only the topmost modal/dialog reacts to Escape and focus containment.
//   2. Background scrolling is locked exactly once while ANY modal is open and
//      restored only when the LAST one closes — so a confirmation stacked over a
//      form (e.g. a discard prompt over Settings) never unlocks the page early.
//   3. Visual stacking and interaction stacking come from the same order, so the
//      modal that receives focus and Escape is also the one painted on top.
//
// ModalShell registers on mount and unregisters on unmount. Identity is a unique
// symbol per open modal; the most recently registered modal is topmost. Each
// entry gets a z-index derived from this order, and ModalShell renders through a
// body-level portal so ancestor stacking contexts and JSX order cannot disagree
// with the stack.

export type ModalId = symbol;

export interface ModalLayer {
  index: number;
  isTopmost: boolean;
  zIndex: number;
}

export const MODAL_BASE_Z_INDEX = 2100;
const MODAL_Z_INDEX_STEP = 10;

const stack: ModalId[] = [];
let savedBodyOverflow: string | null = null;
let version = 0;
const listeners = new Set<() => void>();

export function registerModal(): ModalId {
  const id = Symbol("modal");
  stack.push(id);
  if (stack.length === 1) {
    lockBodyScroll();
  }
  notifyModalStackChanged();
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
  if (index !== -1) {
    notifyModalStackChanged();
  }
}

export function isTopmostModal(id: ModalId): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

export function getModalLayer(id: ModalId): ModalLayer | null {
  const index = stack.lastIndexOf(id);
  if (index === -1) {
    return null;
  }

  return {
    index,
    isTopmost: index === stack.length - 1,
    zIndex: MODAL_BASE_Z_INDEX + index * MODAL_Z_INDEX_STEP,
  };
}

export function getModalStackVersion(): number {
  return version;
}

export function subscribeModalStack(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyModalStackChanged(): void {
  version += 1;
  listeners.forEach((listener) => listener());
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
