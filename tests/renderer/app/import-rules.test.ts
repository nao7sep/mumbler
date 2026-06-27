import { describe, expect, it } from "vitest";

import type { PendingImportReviewItem } from "@shared/app-shell";
import { parseDroppedPaths, reconcilePendingReviewDrafts } from "@renderer/app/import-rules";

const item = (id: string): PendingImportReviewItem => ({ id }) as unknown as PendingImportReviewItem;

describe("parseDroppedPaths", () => {
  it("resolves each file's path and drops empties", () => {
    const files = [{ name: "a" }, { name: "b" }, { name: "c" }] as unknown as File[];
    const paths = parseDroppedPaths(files, (file) =>
      (file as { name: string }).name === "b" ? "" : `/abs/${(file as { name: string }).name}`,
    );
    expect(paths).toEqual(["/abs/a", "/abs/c"]);
  });

  it("returns an empty array when nothing resolves", () => {
    const files = [{ name: "a" }] as unknown as File[];
    expect(parseDroppedPaths(files, () => "")).toEqual([]);
  });
});

describe("reconcilePendingReviewDrafts", () => {
  it("keeps the local drafts when the id set is unchanged (preserves in-progress edits)", () => {
    const current = [item("a"), item("b")];
    const snapshot = [item("a"), item("b")];
    expect(reconcilePendingReviewDrafts(current, snapshot)).toBe(current);
  });

  it("adopts the snapshot when the id set differs", () => {
    const current = [item("a")];
    const snapshot = [item("a"), item("b")];
    expect(reconcilePendingReviewDrafts(current, snapshot)).toBe(snapshot);
  });

  it("adopts the snapshot when current is empty", () => {
    const snapshot = [item("a")];
    expect(reconcilePendingReviewDrafts([], snapshot)).toBe(snapshot);
  });

  it("is order-sensitive: a reordered id list is treated as a different set", () => {
    // Documented limitation: the identity check joins ids in order, so the same
    // items in a different order adopt the snapshot rather than keeping edits.
    const current = [item("a"), item("b")];
    const snapshot = [item("b"), item("a")];
    expect(reconcilePendingReviewDrafts(current, snapshot)).toBe(snapshot);
  });

  it("keeps current even when a same-id snapshot item's content changed", () => {
    // Documented limitation/intent: with the id set unchanged, local edits win —
    // a backend content change to the same ids does not clobber an in-flight edit.
    const current = [item("a")];
    const snapshot = [{ id: "a", changed: true } as unknown as PendingImportReviewItem];
    expect(reconcilePendingReviewDrafts(current, snapshot)).toBe(current);
  });
});
