import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";

/**
 * The vertical drag handle between an adjustable pane and the pane beside it:
 * the main window's queue and detail panes, and the records window's list and
 * detail panes. `label` names it for assistive technology. It owns only the
 * pointer gesture: on pointer-down it captures the start, streams the new width
 * (start width + horizontal delta, clamped to the pane's own bounds) while
 * dragging, and reports the final width on release. The parent owns the width —
 * it feeds `width` back in as the displayed size, persists on `onCommit`, and
 * re-derives the display against the live window (see usePaneSize).
 *
 * With `keyboardStep`, the handle also takes focus and resizes by keyboard (the
 * developer's decision for Records windows): the arrows move it by the step,
 * Home and End to the bounds. Stepping is continuous editing, so the width is
 * committed KEY_COMMIT_DELAY_MS after the last step, each step pushing it back,
 * and at once when the handle loses focus, its window closes or it unmounts.
 * The main window's handle stays pointer-only.
 */
const KEY_COMMIT_DELAY_MS = 500;

export function PaneSplitter({
  label,
  width,
  min,
  max,
  onResize,
  onCommit,
  keyboardStep,
}: {
  label: string;
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
  keyboardStep?: number;
}): ReactElement {
  // The width the keys moved to and not yet committed.
  const keyed = useRef<number | null>(null);
  const keyCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishDragRef = useRef<(() => void) | null>(null);
  const commitKeyedRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    // Closing the window commits a step still waiting out its delay.
    const commitPending = (): void => commitKeyedRef.current();
    window.addEventListener("pagehide", commitPending);
    return () => {
      window.removeEventListener("pagehide", commitPending);
      finishDragRef.current?.();
      commitPending();
    };
  }, []);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (keyboardStep === undefined) return;
    const from = keyed.current ?? width;
    const next = event.key === "ArrowLeft" ? from - keyboardStep
      : event.key === "ArrowRight" ? from + keyboardStep
        : event.key === "Home" ? min
          : event.key === "End" ? max
            : null;
    if (next === null) return;
    event.preventDefault();
    keyed.current = Math.max(min, Math.min(max, next));
    onResize(keyed.current);
    if (keyCommitTimer.current !== null) clearTimeout(keyCommitTimer.current);
    keyCommitTimer.current = setTimeout(commitKeyed, KEY_COMMIT_DELAY_MS);
  }

  function commitKeyed(): void {
    if (keyCommitTimer.current !== null) clearTimeout(keyCommitTimer.current);
    keyCommitTimer.current = null;
    if (keyed.current === null) return;
    const committed = keyed.current;
    keyed.current = null;
    onCommit(committed);
  }
  commitKeyedRef.current = commitKeyed;

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    finishDragRef.current?.();
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    const startX = event.clientX;
    const startWidth = width;
    let latest = startWidth;

    const move = (moveEvent: PointerEvent): void => {
      latest = Math.max(min, Math.min(max, Math.round(startWidth + (moveEvent.clientX - startX))));
      onResize(latest);
    };
    const up = (): void => {
      if (finishDragRef.current !== up) return;
      finishDragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("blur", up);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      onCommit(latest);
    };

    finishDragRef.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("blur", up);
    // Keep the resize cursor and suppress text selection everywhere for the drag.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  return (
    <div
      className="workspace-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={onPointerDown}
      tabIndex={keyboardStep === undefined ? undefined : 0}
      {...(keyboardStep === undefined ? {} : {
        "aria-valuenow": width,
        "aria-valuemin": min,
        "aria-valuemax": max,
        onKeyDown,
        onBlur: commitKeyed,
      })}
    >
      <span className="workspace-splitter__grip" aria-hidden="true" />
    </div>
  );
}
