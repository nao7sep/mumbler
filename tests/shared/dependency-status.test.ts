import { describe, expect, it } from "vitest";

import type { DependencyStatus, ToolFacts, ToolTransient } from "@shared/app-shell";
import { deriveStatus, rollUpRole } from "@shared/dependency-status";

const idle: ToolTransient = { kind: "idle" };

function facts(overrides: Partial<ToolFacts> = {}): ToolFacts {
  return {
    present: false,
    faulted: false,
    installedVersion: null,
    desiredVersion: null,
    lastCheckedAtUtc: null,
    lastCheckError: null,
    lastError: null,
    ...overrides,
  };
}

// A healthy, provisioned baseline; per-test overrides drive the currency sub-state.
function provisioned(overrides: Partial<ToolFacts> = {}): ToolFacts {
  return facts({ present: true, installedVersion: "8.1.1", ...overrides });
}

function derive(f: ToolFacts, t: ToolTransient = idle): DependencyStatus {
  return deriveStatus("ffmpeg", true, f, t);
}

// I1 — Render is pure. Enforced by construction: deriveStatus imports no I/O and
// takes only data. This guards that it is deterministic and total (never throws)
// across the state space, so a renderer can call it freely.
describe("I1 — derivation is pure and total", () => {
  it("is deterministic for identical inputs", () => {
    const f = provisioned({ lastCheckedAtUtc: 1, desiredVersion: "8.1.1" });
    expect(derive(f)).toEqual(derive(f));
  });

  it("never throws across lifecycles and transients", () => {
    const cases: ToolFacts[] = [
      facts(),
      facts({ present: true, faulted: true, lastError: "bad" }),
      provisioned(),
      provisioned({ lastCheckedAtUtc: 1, desiredVersion: "8.1.1" }),
      provisioned({ lastCheckedAtUtc: 1, desiredVersion: "8.2" }),
      provisioned({ lastCheckedAtUtc: 1, lastCheckError: "offline" }),
    ];
    const transients: ToolTransient[] = [
      idle,
      { kind: "running", operation: "provision", percent: 40 },
      { kind: "failed", operation: "update", error: "boom" },
    ];
    for (const f of cases) {
      for (const t of transients) {
        expect(() => derive(f, t)).not.toThrow();
      }
    }
  });
});

// I2 — Currency is nested: null unless the lifecycle is provisioned.
describe("I2 — currency is a sub-state of provisioned only", () => {
  it("is null when absent", () => {
    expect(derive(facts()).currency).toBeNull();
  });

  it("is null when faulted", () => {
    expect(derive(facts({ present: true, faulted: true })).currency).toBeNull();
  });

  it("is set when provisioned", () => {
    expect(derive(provisioned()).currency).toBe("unchecked");
  });
});

// I3 — A failed check is honest: check-failed, never current, version facts intact.
describe("I3 — a failed check never yields current", () => {
  it("is check-failed even when a version diff exists", () => {
    const status = derive(
      provisioned({ lastCheckedAtUtc: 5, desiredVersion: "8.2", lastCheckError: "rate limited" }),
    );
    expect(status.currency).toBe("check-failed");
    expect(status.role).toBe("error");
    // The version facts are passed through untouched, not collapsed to current.
    expect(status.installedVersion).toBe("8.1.1");
    expect(status.desiredVersion).toBe("8.2");
  });
});

// I4 — Fault is recorded, not inferred: faulted only via the recorded flag.
describe("I4 — a failed integrity yields faulted, never provisioned", () => {
  it("is faulted even when versions would otherwise read current", () => {
    const status = derive(
      facts({ present: true, faulted: true, installedVersion: "8.1.1", desiredVersion: "8.1.1", lastCheckedAtUtc: 5, lastError: "sha mismatch" }),
    );
    expect(status.lifecycle).toBe("faulted");
    expect(status.currency).toBeNull();
    expect(status.role).toBe("error");
    expect(status.error).toBe("sha mismatch");
  });
});

// I5 — One role; provisioned + current is quiet.
describe("I5 — exactly one role; current is quiet", () => {
  it("provisioned + current yields role none", () => {
    const status = derive(provisioned({ lastCheckedAtUtc: 5, desiredVersion: "8.1.1" }));
    expect(status.currency).toBe("current");
    expect(status.role).toBe("none");
  });
});

// I6 — Operations are transient: a failed operation never persists as a lifecycle.
describe("I6 — a failed operation is transient over persisted state", () => {
  it("a failed provision leaves the tool absent, shown as error via the overlay", () => {
    const status = derive(facts(), { kind: "failed", operation: "provision", error: "network down" });
    expect(status.lifecycle).toBe("absent"); // persisted state unchanged
    expect(status.role).toBe("error"); // transient overlay
    expect(status.operation).toBe("provision");
  });

  it("a running operation overlays informational regardless of base role", () => {
    const status = derive(facts(), { kind: "running", operation: "provision", percent: 10 });
    expect(status.role).toBe("informational");
  });
});

// I7 — Roll-up is the worst role by precedence error > warning > informational > none.
describe("I7 — roll-up is the worst role", () => {
  const row = (role: DependencyStatus["role"]): DependencyStatus =>
    ({ ...derive(facts()), role });

  it("picks error over warning and informational", () => {
    expect(rollUpRole([row("none"), row("warning"), row("error"), row("informational")])).toBe("error");
  });

  it("picks warning over informational and none", () => {
    expect(rollUpRole([row("none"), row("informational"), row("warning")])).toBe("warning");
  });

  it("is none for an all-quiet or empty set", () => {
    expect(rollUpRole([row("none"), row("none")])).toBe("none");
    expect(rollUpRole([])).toBe("none");
  });
});

// The state → role → operation mapping the convention tables.
describe("state mapping", () => {
  it("absent → warning, provision", () => {
    const s = derive(facts());
    expect(s.lifecycle).toBe("absent");
    expect(s.role).toBe("warning");
    expect(s.operation).toBe("provision");
  });

  it("provisioned · unchecked → informational, check", () => {
    const s = derive(provisioned());
    expect(s.currency).toBe("unchecked");
    expect(s.role).toBe("informational");
    expect(s.operation).toBe("check");
  });

  it("provisioned · stale → warning, update", () => {
    const s = derive(provisioned({ lastCheckedAtUtc: 5, desiredVersion: "8.2" }));
    expect(s.currency).toBe("stale");
    expect(s.role).toBe("warning");
    expect(s.operation).toBe("update");
  });

  it("provisioned · current → none, verify", () => {
    const s = derive(provisioned({ lastCheckedAtUtc: 5, desiredVersion: "8.1.1" }));
    expect(s.role).toBe("none");
    expect(s.operation).toBe("verify");
  });

  it("faulted → error, verify (repair)", () => {
    const s = derive(facts({ present: true, faulted: true }));
    expect(s.operation).toBe("verify");
  });
});
