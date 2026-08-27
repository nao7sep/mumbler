import { describe, expect, it } from "vitest";

import type { PendingImportReviewItem } from "@shared/app-shell";
import {
  isFileDrag,
  inspectFileDragOffer,
  parseDroppedPaths,
  reconcilePendingReviewDrafts,
} from "@renderer/app/import-rules";

const item = (id: string): PendingImportReviewItem => ({ id }) as unknown as PendingImportReviewItem;

describe("parseDroppedPaths", () => {
  it("preserves duplicate paths and accounts for inaccessible entries", () => {
    const files = [{ name: "a" }, { name: "b" }, { name: "c" }] as unknown as File[];
    const paths = parseDroppedPaths(files, (file) => {
      const name = (file as { name: string }).name;
      if (name === "b") throw new Error("unavailable");
      return "/abs/audio.wav";
    });
    expect(paths).toEqual({
      paths: ["/abs/audio.wav", "/abs/audio.wav"],
      unavailable: [{
        sourcePath: "b",
        message: "Local path could not be read: unavailable",
      }],
    });
  });

  it("returns an empty array when nothing resolves", () => {
    const files = [{ name: "a" }] as unknown as File[];
    expect(parseDroppedPaths(files, () => "")).toEqual({
      paths: [],
      unavailable: [{
        sourcePath: "a",
        message: "No usable local file path was available.",
      }],
    });
  });
});

describe("isFileDrag", () => {
  it("accepts the native Files transfer type", () => {
    expect(isFileDrag({ types: ["Files"], items: [] as unknown as DataTransferItemList })).toBe(
      true,
    );
  });

  it("accepts an explicitly file-kind item", () => {
    expect(
      isFileDrag({
        types: [],
        items: [{ kind: "file" }] as unknown as DataTransferItemList,
      }),
    ).toBe(true);
  });

  it("rejects text and other non-file payloads", () => {
    expect(
      isFileDrag({
        types: ["text/plain"],
        items: [{ kind: "string" }] as unknown as DataTransferItemList,
      }),
    ).toBe(false);
  });
});

describe("inspectFileDragOffer", () => {
  it("keeps a protected Files marker delivery-only", () => {
    expect(
      inspectFileDragOffer({ types: ["Files"], items: [] as unknown as DataTransferItemList }),
    ).toBe("delivery-only");
  });

  it("keeps an inspectable file item delivery-only until its local path resolves", () => {
    expect(
      inspectFileDragOffer({
        types: ["Files"],
        items: [{ kind: "file", getAsFile: () => ({ name: "audio.wav" }) }] as unknown as DataTransferItemList,
      }),
    ).toBe("delivery-only");
  });

  it("keeps a protected file item delivery-only", () => {
    expect(
      inspectFileDragOffer({
        types: ["Files"],
        items: [{ kind: "file", getAsFile: () => null }] as unknown as DataTransferItemList,
      }),
    ).toBe("delivery-only");
  });

  it("rejects an inspectable unsupported file item", () => {
    expect(
      inspectFileDragOffer({
        types: ["Files"],
        items: [{ kind: "file", getAsFile: () => ({ name: "notes.txt" }) }] as unknown as DataTransferItemList,
      }),
    ).toBe("rejected");
  });

  it("rejects non-file data", () => {
    expect(
      inspectFileDragOffer({
        types: ["text/plain"],
        items: [{ kind: "string" }] as unknown as DataTransferItemList,
      }),
    ).toBe("rejected");
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
