import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";

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
 * Home and End to the bounds, and the width is committed once, when the key is
 * released or the handle loses focus. The main window's handle stays pointer-only.
 */
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
  }

  function commitKeyed(): void {
    if (keyed.current === null) return;
    const committed = keyed.current;
    keyed.current = null;
    onCommit(committed);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    let latest = startWidth;

    const move = (moveEvent: PointerEvent): void => {
      latest = Math.max(min, Math.min(max, Math.round(startWidth + (moveEvent.clientX - startX))));
      onResize(latest);
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onCommit(latest);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
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
        onKeyUp: commitKeyed,
        onBlur: commitKeyed,
      })}
    >
      <span className="workspace-splitter__grip" aria-hidden="true" />
    </div>
  );
}
