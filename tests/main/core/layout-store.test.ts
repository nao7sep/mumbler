import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { QUEUE_WIDTH, RECORDS_LIST_WIDTH } from "@shared/layout";
import {
  clampQueueWidth,
  clampRecordsListWidth,
  createDefaultLayout,
  createLayoutStore,
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

describe("clampRecordsListWidth", () => {
  it("keeps an in-range width, rounded, and snaps an out-of-range one to the records list bounds", () => {
    expect(clampRecordsListWidth(450.6)).toBe(451);
    expect(clampRecordsListWidth(RECORDS_LIST_WIDTH.min - 50)).toBe(RECORDS_LIST_WIDTH.min);
    expect(clampRecordsListWidth(RECORDS_LIST_WIDTH.max + 50)).toBe(RECORDS_LIST_WIDTH.max);
  });

  it("falls back to the default for a missing or non-finite value", () => {
    expect(clampRecordsListWidth(undefined)).toBe(RECORDS_LIST_WIDTH.default);
    expect(clampRecordsListWidth(Number.NaN)).toBe(RECORDS_LIST_WIDTH.default);
  });
});

describe("createDefaultLayout", () => {
  it("is the default pane widths with no card selected", () => {
    expect(createDefaultLayout()).toEqual({
      queueWidth: QUEUE_WIDTH.default,
      recordsListWidth: RECORDS_LIST_WIDTH.default,
      selectedCardId: null,
      releaseCheckAttemptAtUtc: null,
    });
  });
});

describe("normalizeLayout", () => {
  it("clamps a persisted width and keeps the format version out of the layout", () => {
    expect(normalizeLayout({ formatVersion: 1, queueWidth: 640, recordsListWidth: 9999 })).toEqual({
      queueWidth: 640,
      recordsListWidth: RECORDS_LIST_WIDTH.max,
      selectedCardId: null,
      releaseCheckAttemptAtUtc: null,
    });
  });

  it("self-heals a missing or garbage width to the default rather than rejecting", () => {
    expect(normalizeLayout({}).queueWidth).toBe(QUEUE_WIDTH.default);
    expect(normalizeLayout({ queueWidth: "wide" }).queueWidth).toBe(QUEUE_WIDTH.default);
    expect(normalizeLayout({ queueWidth: 500 }).recordsListWidth).toBe(RECORDS_LIST_WIDTH.default);
  });

  it("keeps a string selection and resets a missing or invalid one", () => {
    expect(normalizeLayout({ selectedCardId: "card-a" }).selectedCardId).toBe("card-a");
    expect(normalizeLayout({ selectedCardId: 42 }).selectedCardId).toBeNull();
    expect(normalizeLayout({}).selectedCardId).toBeNull();
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

describe("the release check's attempt time in layout.json", () => {
  it("is stored as canonical UTC and read back as the same instant; anything else reads as none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mumbler-layout-"));
    try {
      const store = createLayoutStore(join(dir, "layout.json"));
      const at = Date.UTC(2026, 9, 9, 12, 30, 0);
      await store.save({ ...createDefaultLayout(), releaseCheckAttemptAtUtc: at });
      expect(JSON.parse(await readFile(join(dir, "layout.json"), "utf8")).releaseCheckAttemptAtUtc).toBe("2026-10-09T12:30:00.000Z");
      expect((await store.load()).value.releaseCheckAttemptAtUtc).toBe(at);
      expect(normalizeLayout({ releaseCheckAttemptAtUtc: "yesterday" }).releaseCheckAttemptAtUtc).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
