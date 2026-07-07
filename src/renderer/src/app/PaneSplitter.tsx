import { type PointerEvent as ReactPointerEvent, type ReactElement } from "react";

/**
 * The vertical drag handle between the queue and detail panes. It owns only the
 * pointer gesture: on pointer-down it captures the start, streams the new width
 * (start width + horizontal delta, clamped to the pane's own bounds) while
 * dragging, and reports the final width on release. The parent owns the width —
 * it feeds `width` back in as the displayed size, persists on `onCommit`, and
 * re-derives the display against the live window (see usePaneSize).
 *
 * Keyboard resize is not offered: the width persists, so this is a one-time setup
 * gesture, not a frequent interaction.
 */
export function PaneSplitter({
  width,
  min,
  max,
  onResize,
  onCommit,
}: {
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
}): ReactElement {
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
      aria-label="Resize queue pane"
      onPointerDown={onPointerDown}
    >
      <span className="workspace-splitter__grip" aria-hidden="true" />
    </div>
  );
}
