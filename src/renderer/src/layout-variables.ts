import {
  DETAIL_MIN_WIDTH,
  QUEUE_WIDTH,
  RECORDS_DETAIL_MIN_WIDTH,
  RECORDS_GAP,
  RECORDS_PADDING,
  SHELL_PADDING_X,
  SHELL_PADDING_Y,
  VERTICAL_CHROME,
  WORKSPACE_GAP,
} from "@shared/layout";

// The pane lengths the stylesheet uses, set on the document root before the
// first render, so the stylesheet repeats none of the values the window
// minimums are derived from.
export function applyLayoutVariables(root: HTMLElement): void {
  const lengths: Record<string, number> = {
    "--shell-padding-x": SHELL_PADDING_X / 2,
    "--shell-padding-y": SHELL_PADDING_Y / 2,
    "--workspace-gap": WORKSPACE_GAP,
    "--queue-width": QUEUE_WIDTH.default,
    "--detail-min-width": DETAIL_MIN_WIDTH,
    "--vertical-chrome": VERTICAL_CHROME,
    "--records-padding": RECORDS_PADDING,
    "--records-gap": RECORDS_GAP,
    "--records-detail-min-width": RECORDS_DETAIL_MIN_WIDTH,
  };
  for (const [name, value] of Object.entries(lengths)) root.style.setProperty(name, `${value}px`);
}
