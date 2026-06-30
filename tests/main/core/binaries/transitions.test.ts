import { describe, expect, it } from "vitest";

import type { PersistedToolFacts } from "@main/core/binaries/store";
import { afterCheckSuccess, afterInstall } from "@main/core/binaries/transitions";

function facts(overrides: Partial<PersistedToolFacts> = {}): PersistedToolFacts {
  return {
    installedVersion: "8.1.1",
    desiredVersion: "8.1.1",
    lastCheckedAtUtc: 100,
    ...overrides,
  };
}

describe("afterInstall", () => {
  it("sets installed = desired = the new version and stamps the check time", () => {
    const next = afterInstall(facts({ installedVersion: null, desiredVersion: "8.2" }), "8.2", 500);
    expect(next).toEqual({
      installedVersion: "8.2",
      desiredVersion: "8.2",
      lastCheckedAtUtc: 500,
    });
  });
});

describe("afterCheckSuccess", () => {
  it("records desired + time, leaving installed untouched", () => {
    const next = afterCheckSuccess(facts(), "8.2", 700);
    expect(next.desiredVersion).toBe("8.2");
    expect(next.lastCheckedAtUtc).toBe(700);
    expect(next.installedVersion).toBe("8.1.1");
  });
});
