import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { nextIndex } from "./composite-nav";
import { useComposing, isComposingKeyboardEvent } from "./useComposing";

/**
 * The app's in-app menu layer: a trigger plus a popup list of commands that
 * behaves like a real menu. The trigger is the single tab stop (aria-haspopup /
 * aria-expanded); opening moves focus into the menu and closing returns it to the
 * trigger; Up/Down move between items (stopping at the ends, like the queue list),
 * Home/End jump, type-ahead jumps by label, Enter/Space activate, and
 * Escape / Tab / outside click close. Items are `menuitem`s navigated by the
 * arrows, never by Tab.
 *
 * Controlled (open / onOpenChange) because the open state lives in App and is also
 * closed by other paths. Hand-rolled on the renderer's own focus and composition
 * helpers — mumbler's own menu, not shared across apps.
 *
 * Type-ahead and Enter/Space activation are guarded against IME composition: while
 * a candidate is being composed those keys belong to the input method, not the
 * menu, per the text input and IME conventions.
 */
type TriggerProps = {
  ref: (el: HTMLButtonElement | null) => void;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  onClick: () => void;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  trigger: (props: TriggerProps) => ReactNode;
  children: ReactNode;
  /** Class on the popup container (e.g. the existing `app-menu`). */
  className?: string;
};

const MenuContext = createContext<{ close: () => void } | null>(null);

export function Menu({ open, onOpenChange, label, trigger, children, className }: Props) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const composing = useComposing();

  const items = (): HTMLElement[] =>
    contentRef.current
      ? Array.from(contentRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      : [];

  const close = (focusTrigger = true) => {
    onOpenChange(false);
    if (focusTrigger) triggerRef.current?.focus();
  };

  // On open, move focus into the menu (first item).
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => items()[0]?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Outside click closes without yanking focus back (a pointer interaction).
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (contentRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      onOpenChange(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onOpenChange]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = items();
    if (all.length === 0) return;
    const current = Math.max(0, all.indexOf(document.activeElement as HTMLElement));
    if (e.key === "ArrowDown") {
      e.preventDefault();
      all[nextIndex("next", current, all.length)]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      all[nextIndex("prev", current, all.length)]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      all[nextIndex("first", current, all.length)]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      all[nextIndex("last", current, all.length)]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" || e.key === " ") {
      // Enter/Space activate the focused item — but during an IME composition
      // Enter confirms the candidate and belongs to the input method, so bail.
      if (isComposingKeyboardEvent(composing.composingRef, e)) return;
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.click();
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Type-ahead jumps by label, but a printable key typed mid-composition is
      // part of the candidate, not a jump target.
      if (isComposingKeyboardEvent(composing.composingRef, e)) return;
      const ch = e.key.toLowerCase();
      const order = [...all.slice(current + 1), ...all.slice(0, current + 1)];
      order.find((el) => el.textContent?.trim().toLowerCase().startsWith(ch))?.focus();
    }
  };

  return (
    <>
      {trigger({
        ref: (el) => {
          triggerRef.current = el;
        },
        "aria-haspopup": "menu",
        "aria-expanded": open,
        onClick: () => onOpenChange(!open),
      })}
      {open ? (
        <div
          ref={contentRef}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          onCompositionStart={composing.handlers.onCompositionStart}
          onCompositionEnd={composing.handlers.onCompositionEnd}
          className={className}
        >
          <MenuContext.Provider value={{ close }}>{children}</MenuContext.Provider>
        </div>
      ) : null}
    </>
  );
}

/**
 * One command in a {@link Menu}: a `menuitem` reachable only by the menu's arrow
 * navigation (never its own tab stop). Activating it runs the action and closes
 * the menu, returning focus to the trigger.
 */
export function MenuItem({
  onSelect,
  children,
  className,
  disabled,
}: {
  onSelect: () => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const ctx = useContext(MenuContext);
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      disabled={disabled}
      onClick={() => {
        ctx?.close();
        onSelect();
      }}
      className={className}
    >
      {children}
    </button>
  );
}
