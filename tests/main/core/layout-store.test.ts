import { describe, expect, it } from "vitest";

import { QUEUE_WIDTH } from "@shared/layout";
import {
  clampQueueWidth,
  createDefaultLayout,
  LAYOUT_SCHEMA_VERSION,
  normalizeLayout,
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
    });
  });
});

describe("normalizeLayout", () => {
  it("clamps a persisted width and stamps the current schema version", () => {
    expect(normalizeLayout({ schemaVersion: 1, queueWidth: 640 })).toEqual({
      schemaVersion: LAYOUT_SCHEMA_VERSION,
      queueWidth: 640,
    });
  });

  it("self-heals a missing or garbage width to the default rather than rejecting", () => {
    expect(normalizeLayout({}).queueWidth).toBe(QUEUE_WIDTH.default);
    expect(normalizeLayout({ queueWidth: "wide" }).queueWidth).toBe(QUEUE_WIDTH.default);
  });
});
