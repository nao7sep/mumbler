import { describe, expect, it } from "vitest";

import {
  DETAIL_MIN_HEIGHT,
  DETAIL_MIN_WIDTH,
  QUEUE_MIN_WIDTH,
  SHELL_PADDING_X,
  VERTICAL_CHROME,
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,
  WORKSPACE_GAP,
} from "@shared/layout";

// The app's designed default size (mirrors buildWindowOptions in src/main/window.ts).
const DEFAULT_WIDTH = 1480;
const DEFAULT_HEIGHT = 940;

describe("window minimum derivation", () => {
  it("derives WINDOW_MIN_WIDTH from the pane minimums + gap + chrome", () => {
    // The derivation invariant: guards against a magic number creeping back into
    // the window minimum.
    expect(WINDOW_MIN_WIDTH).toBe(
      SHELL_PADDING_X + QUEUE_MIN_WIDTH + WORKSPACE_GAP + DETAIL_MIN_WIDTH,
    );
  });

  it("derives WINDOW_MIN_HEIGHT from the detail stack minimum + vertical chrome", () => {
    expect(WINDOW_MIN_HEIGHT).toBe(VERTICAL_CHROME + DETAIL_MIN_HEIGHT);
  });

  it("keeps the derived minimums at or below the default size", () => {
    // The window must be able to open at its default size, so the default can
    // never be smaller than the enforced minimum.
    expect(WINDOW_MIN_WIDTH).toBeLessThanOrEqual(DEFAULT_WIDTH);
    expect(WINDOW_MIN_HEIGHT).toBeLessThanOrEqual(DEFAULT_HEIGHT);
  });
});
