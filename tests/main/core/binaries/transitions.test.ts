import { describe, expect, it } from "vitest";

import type { PersistedToolFacts } from "@main/core/binaries/store";
import {
  afterCheckFailure,
  afterCheckSuccess,
  afterInstall,
  afterVerifyFail,
  afterVerifyPass,
} from "@main/core/binaries/transitions";

function facts(overrides: Partial<PersistedToolFacts> = {}): PersistedToolFacts {
  return {
    installedVersion: "8.1.1",
    installedSha256: "a".repeat(64),
    desiredVersion: "8.1.1",
    lastCheckedAtUtc: 100,
    lastCheckError: null,
    lastError: null,
    faulted: false,
    ...overrides,
  };
}

describe("afterInstall", () => {
  it("sets version + hash current and clears every error/fault", () => {
    const next = afterInstall(
      facts({ desiredVersion: "8.2", lastCheckError: "x", lastError: "y", faulted: true }),
      "8.2",
      "b".repeat(64),
      500,
    );
    expect(next).toMatchObject({
      installedVersion: "8.2",
      desiredVersion: "8.2",
      installedSha256: "b".repeat(64),
      lastCheckedAtUtc: 500,
      lastCheckError: null,
      lastError: null,
      faulted: false,
    });
  });
});

describe("afterCheckSuccess", () => {
  it("records desired + time, clears the check error, leaves installed untouched", () => {
    const next = afterCheckSuccess(facts({ lastCheckError: "stale" }), "8.2", 700);
    expect(next.desiredVersion).toBe("8.2");
    expect(next.lastCheckedAtUtc).toBe(700);
    expect(next.lastCheckError).toBeNull();
    expect(next.installedVersion).toBe("8.1.1");
  });
});

describe("afterCheckFailure (I3)", () => {
  it("records only time + error, never touching the versions", () => {
    const next = afterCheckFailure(facts({ desiredVersion: "8.5" }), "offline", 900);
    expect(next.lastCheckError).toBe("offline");
    expect(next.lastCheckedAtUtc).toBe(900);
    expect(next.installedVersion).toBe("8.1.1");
    expect(next.desiredVersion).toBe("8.5");
  });
});

describe("afterVerify (I4)", () => {
  it("pass clears the fault", () => {
    expect(afterVerifyPass(facts({ faulted: true, lastError: "bad" }))).toMatchObject({
      faulted: false,
      lastError: null,
    });
  });

  it("fail faults with the reason, versions untouched", () => {
    const next = afterVerifyFail(facts(), "installed file failed integrity");
    expect(next.faulted).toBe(true);
    expect(next.lastError).toBe("installed file failed integrity");
    expect(next.installedVersion).toBe("8.1.1");
  });
});
