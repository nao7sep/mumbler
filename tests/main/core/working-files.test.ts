import { describe, expect, it } from "vitest";

import type { MumblerCard, MumblerState } from "@shared/app-shell";
import { selectExistingCardId } from "@main/core/working-files";

function state(cardIds: string[], selectedCardId: string | null): MumblerState {
  return {
    schemaVersion: 1,
    pendingImports: [],
    cards: cardIds.map((id) => ({ id }) as MumblerCard),
    selectedCardId,
    updatedAtUtc: 0,
  };
}

describe("selectExistingCardId", () => {
  it("keeps the current selection when it still exists", () => {
    expect(selectExistingCardId(state(["a", "b", "c"], "b"))).toBe("b");
  });

  it("falls back to the first card when the selection is gone", () => {
    expect(selectExistingCardId(state(["a", "b"], "missing"))).toBe("a");
  });

  it("falls back to the first card when nothing is selected", () => {
    expect(selectExistingCardId(state(["a", "b"], null))).toBe("a");
  });

  it("returns null when there are no cards", () => {
    expect(selectExistingCardId(state([], "anything"))).toBeNull();
    expect(selectExistingCardId(state([], null))).toBeNull();
  });
});
