import { describe, expect, it } from "vitest";

import { QUEUE_WIDTH } from "@shared/layout";
import {
  clampQueueWidth,
  createDefaultLayout,
  LAYOUT_SCHEMA_VERSION,
  normalizeLayout,
  selectExistingCardId,
} from "@main/core/layout-store";

describe("clampQueueWidth", () => {
  it("keeps an in-range width, rounded to a whole pixel", () => {
    expect(clampQueueWidth(512.4)).toBe(512);
  });

  it("snaps an out-of-range width to the nearest bound (self-healing)", () => {
    expect(clampQueueWidth(QUEUE_WIDTH.min - 50)).toBe(QUEUE_WIDTH.min);
    expect(clampQueueWidth(QUEUE_WIDTH.max + 50)).toBe(QUEUE_WIDTH.max);
  });

  it("falls back to the default for a non-finite or non-number value", () => {
    expect(clampQueueWidth(Number.NaN)).toBe(QUEUE_WIDTH.default);
    expect(clampQueueWidth(Number.POSITIVE_INFINITY)).toBe(QUEUE_WIDTH.default);
    expect(clampQueueWidth("400")).toBe(QUEUE_WIDTH.default);
    expect(clampQueueWidth(undefined)).toBe(QUEUE_WIDTH.default);
  });
});

describe("createDefaultLayout", () => {
  it("is the default queue width at the current schema version", () => {
    expect(createDefaultLayout()).toEqual({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      queueWidth: QUEUE_WIDTH.default,
      selectedCardId: null,
      windowPlacements: { main: null },
    });
  });
});

describe("normalizeLayout", () => {
  it("clamps a persisted width and stamps the current schema version", () => {
    expect(normalizeLayout({ schemaVersion: 1, queueWidth: 640 })).toEqual({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      queueWidth: 640,
      selectedCardId: null,
      windowPlacements: { main: null },
    });
  });

  it("self-heals a missing or garbage width to the default rather than rejecting", () => {
    expect(normalizeLayout({}).queueWidth).toBe(QUEUE_WIDTH.default);
    expect(normalizeLayout({ queueWidth: "wide" }).queueWidth).toBe(QUEUE_WIDTH.default);
  });

  it("keeps a string selection and resets a missing or invalid one", () => {
    expect(normalizeLayout({ selectedCardId: "card-a" }).selectedCardId).toBe("card-a");
    expect(normalizeLayout({ selectedCardId: 42 }).selectedCardId).toBeNull();
    expect(normalizeLayout({}).selectedCardId).toBeNull();
  });

  it("normalizes placement geometry and mode independently", () => {
    expect(normalizeLayout({
      windowPlacements: {
        main: {
          normalBounds: { x: 10, y: 20, width: "wide", height: 800 },
          mode: "maximized",
        },
      },
    }).windowPlacements.main).toEqual({ normalBounds: null, mode: "maximized" });
  });

  it("preserves native bounds and discards malformed native data independently", () => {
    const placement = { normalBounds: { x: 89, y: 81, width: 1201, height: 749 }, mode: "maximized",
      windowsNormalBounds: { left: 111, top: 101, right: 1613, bottom: 1038 } };
    const state = normalizeLayout({ selectedCardId: "kept", windowPlacements: { main: placement } });
    expect(state.selectedCardId).toBe("kept");
    expect(state.windowPlacements.main).toEqual(placement);
    expect(normalizeLayout({ windowPlacements: { main: { ...placement, windowsNormalBounds: {} } } })
      .windowPlacements.main).toEqual({ ...placement, windowsNormalBounds: null });
  });
});

describe("selectExistingCardId", () => {
  it("keeps a selection that still exists", () => {
    expect(selectExistingCardId(["a", "b", "c"], "b")).toBe("b");
  });

  it("falls back to the first card for an absent or missing selection", () => {
    expect(selectExistingCardId(["a", "b"], "missing")).toBe("a");
    expect(selectExistingCardId(["a", "b"], null)).toBe("a");
  });

  it("returns null when the queue is empty", () => {
    expect(selectExistingCardId([], "anything")).toBeNull();
    expect(selectExistingCardId([], null)).toBeNull();
  });
});
