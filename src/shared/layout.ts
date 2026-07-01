// Single source of truth for the window's minimum size.
//
// The window-chrome conventions require the window minimum to be DERIVED from
// the panes' own minimums plus the fixed chrome — never a hand-typed constant
// that silently drifts when a pane changes and starts truncating content. The
// constants below mirror the layout in src/renderer/src/styles.css; the window
// minimum falls out of them, so the OS can never shrink the window small enough
// to clip a pane.
//
// When a value here changes, change the matching CSS rule (noted per constant)
// and the derivation stays correct automatically.

// Horizontal padding reserved by `.app-shell` (padding: 20px 24px → 24px each
// side). Counts as fixed chrome on the width axis.
export const SHELL_PADDING_X = 48;

// The `.workspace` grid gap between the queue and detail panes.
export const WORKSPACE_GAP = 20;

// Queue (left) pane bounds. It is the fixed, user-adjustable pane in the two-pane
// workspace (the detail pane is the fill). The user drags a splitter to set its
// width; the drag is clamped to these bounds and the result persisted as the
// "intent" in layout.json (see @shared/app-shell MumblerLayout), while the
// DISPLAYED width is that intent re-clamped to the live window on every resize
// (clampSplitter below) — so a wide pane narrows toward its min when the window
// shrinks and returns to the intent when it grows.
//
//   min     — smallest width at which a queue row's filename, status, and metadata
//             stay readable. Mirrors the historical fixed 400px track and feeds
//             the window minimum below.
//   default — opening width on first run (kept at the old fixed width, so the
//             initial layout is unchanged).
//   max     — the widest the list may take; beyond this it only steals space from
//             the detail pane for no benefit.
export const QUEUE_WIDTH = { min: 400, default: 400, max: 720 } as const;

// The queue pane's real minimum, sourced from QUEUE_WIDTH so the window-minimum
// derivation below and the splitter clamp can never disagree.
export const QUEUE_MIN_WIDTH = QUEUE_WIDTH.min;

// Detail pane: real minimum width. The detail stack's most demanding row is the
// three-column Timestamps / Audio / Options grid (`.detail-row`); below roughly
// this width those columns and the labelled fields stop being legible. Mirrored
// by the `minmax(...)` floor on the second `.workspace` track.
export const DETAIL_MIN_WIDTH = 640;

// Vertical chrome reserved above the panes by `.app-shell` (padding: 20px top +
// 20px bottom) plus the topbar block.
//
// Topbar: padding 14px*2 (28) + the 1.5rem/line-height-1.5 h1 (~36) ≈ 64, plus
// its 20px margin-bottom = 84. Shell vertical padding = 40. Total fixed vertical
// chrome before any pane = 124.
const SHELL_PADDING_Y = 40;
const TOPBAR_BLOCK = 84;
export const VERTICAL_CHROME = SHELL_PADDING_Y + TOPBAR_BLOCK;

// Detail stack minimum height: the smallest height at which the detail pane's
// own content is still usable. The driving region is the "Transcription and
// Metadata" card, whose tall transcription textarea has a 360px min-height
// (`.result-output--tall`); add the waveform canvas minimum (160px,
// `.waveform-canvas`) above it and the panel/card chrome (headers, gaps,
// padding) around them. Kept deliberately modest so it stays ≤ the default
// height; a real floor, not the literal sum of every stacked card.
export const DETAIL_MIN_HEIGHT = 600;

// Derived — do not hand-edit. The minimum width is the sum of the pane minimums
// plus the workspace gap plus the horizontal shell chrome.
export const WINDOW_MIN_WIDTH =
  SHELL_PADDING_X + QUEUE_MIN_WIDTH + WORKSPACE_GAP + DETAIL_MIN_WIDTH;

// Derived — do not hand-edit. The minimum height is the detail stack's minimum
// plus the fixed vertical chrome (shell padding + topbar block).
export const WINDOW_MIN_HEIGHT = VERTICAL_CHROME + DETAIL_MIN_HEIGHT;

// Clamp an adjustable pane's desired size to what the live window allows, holding
// every sibling its minimum. `desired` is the drag/intent size; `available` is the
// live extent of the container the panes share (here the workspace's content-box
// width); `siblingMin` is the sum of minimums on the far side (the detail-pane
// minimum plus the workspace gap); `min`/`max` are the dragged pane's own bounds.
// Used to derive the DISPLAYED width from the persisted intent on every resize —
// never to change what is persisted (app-chrome-conventions: re-clamp on resize,
// persist only on a drag).
export function clampSplitter(
  desired: number,
  opts: { available: number; siblingMin: number; min: number; max: number },
): number {
  const { available, siblingMin, min, max } = opts;
  // The most this pane may take and still leave every sibling its minimum.
  const room = available - siblingMin;
  // Never let the room ceiling fall below the pane's own min (a too-small window
  // is held by WINDOW_MIN_* / the schema floor; the pane still reports its min).
  const ceiling = Math.max(min, Math.min(max, room));
  return Math.max(min, Math.min(ceiling, Math.round(desired)));
}
