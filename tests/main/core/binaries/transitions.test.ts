import { describe, expect, it } from "vitest";

import type { PersistedToolFacts } from "@main/core/binaries/store";
import { recordLatest } from "@main/core/binaries/transitions";

function facts(overrides: Partial<PersistedToolFacts> = {}): PersistedToolFacts {
  return {
    desiredVersion: "8.1.1",
    lastCheckedAtUtc: 100,
    ...overrides,
  };
}

describe("recordLatest", () => {
  it("records the resolved latest and the time it was resolved", () => {
    expect(recordLatest(facts(), "8.2", 700)).toEqual({
      desiredVersion: "8.2",
      lastCheckedAtUtc: 700,
    });
  });

  // The one transition both writers share. An install learns the latest too, and
  // records nothing about what is now installed — that is read from the binary, so
  // the two cannot drift apart.
  it("is the whole of what a successful install persists", () => {
    const fresh: PersistedToolFacts = { desiredVersion: null, lastCheckedAtUtc: null };
    expect(recordLatest(fresh, "8.2", 500)).toEqual({
      desiredVersion: "8.2",
      lastCheckedAtUtc: 500,
    });
  });
});
