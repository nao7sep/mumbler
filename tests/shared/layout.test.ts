import { describe, expect, it } from "vitest";

import {
  clampSplitter,
  DETAIL_MIN_HEIGHT,
  DETAIL_MIN_WIDTH,
  QUEUE_MIN_WIDTH,
  QUEUE_WIDTH,
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

  it("sources QUEUE_MIN_WIDTH from the queue-pane bounds", () => {
    // The window-minimum derivation and the splitter clamp must read the same
    // queue minimum, so they can never drift apart.
    expect(QUEUE_MIN_WIDTH).toBe(QUEUE_WIDTH.min);
    expect(QUEUE_WIDTH.min).toBeLessThanOrEqual(QUEUE_WIDTH.default);
    expect(QUEUE_WIDTH.default).toBeLessThanOrEqual(QUEUE_WIDTH.max);
  });
});

describe("clampSplitter", () => {
  const bounds = { min: QUEUE_WIDTH.min, max: QUEUE_WIDTH.max };
  // Enough room that the pane's own max is the only ceiling.
  const roomy = { available: 4000, siblingMin: DETAIL_MIN_WIDTH + WORKSPACE_GAP, ...bounds };

  it("returns the desired width when it fits within the pane's own bounds", () => {
    expect(clampSplitter(520, roomy)).toBe(520);
  });

  it("clamps to the pane's own min and max regardless of room", () => {
    expect(clampSplitter(QUEUE_WIDTH.min - 100, roomy)).toBe(QUEUE_WIDTH.min);
    expect(clampSplitter(QUEUE_WIDTH.max + 100, roomy)).toBe(QUEUE_WIDTH.max);
  });

  it("narrows toward the pane min as the window shrinks, holding the sibling its minimum", () => {
    // A window only wide enough for the detail min + gap + 480 of queue: the
    // dragged intent of 700 is held back to 480 (display-only) so the detail pane
    // keeps its floor.
    const available = DETAIL_MIN_WIDTH + WORKSPACE_GAP + 480;
    expect(
      clampSplitter(700, { available, siblingMin: DETAIL_MIN_WIDTH + WORKSPACE_GAP, ...bounds }),
    ).toBe(480);
  });

  it("never reports below the pane's own min even when the window is too small", () => {
    // Below the enforced window minimum the room goes negative; the pane still
    // reports its own min (the OS/window minimum is what actually holds the frame).
    expect(
      clampSplitter(700, { available: 300, siblingMin: DETAIL_MIN_WIDTH + WORKSPACE_GAP, ...bounds }),
    ).toBe(QUEUE_WIDTH.min);
  });

  it("rounds the desired width to a whole pixel", () => {
    expect(clampSplitter(512.6, roomy)).toBe(513);
  });
});
