import { describe, expect, it } from "vitest";

import type { DependencyStatus, ToolFacts, ToolTransient } from "@shared/app-shell";
import { deriveStatus, rollUpRole } from "@shared/dependency-status";

const idle: ToolTransient = { kind: "idle" };

function facts(overrides: Partial<ToolFacts> = {}): ToolFacts {
  return {
    present: false,
    installedVersion: null,
    desiredVersion: null,
    lastCheckedAtUtc: null,
    ...overrides,
  };
}

// A healthy installed baseline; per-test overrides drive the version/check facts.
function installed(overrides: Partial<ToolFacts> = {}): ToolFacts {
  return facts({ present: true, installedVersion: "8.1.1", ...overrides });
}

function derive(f: ToolFacts, t: ToolTransient = idle, required = true): DependencyStatus {
  return deriveStatus("ffmpeg", required, f, t);
}

// I1 — Render is pure. Enforced by construction: deriveStatus imports no I/O and
// takes only data. This guards that it is deterministic and total (never throws)
// across the state space, so a renderer can call it freely.
describe("I1 — derivation is pure and total", () => {
  it("is deterministic for identical inputs", () => {
    const f = installed({ lastCheckedAtUtc: 1, desiredVersion: "8.1.1" });
    expect(derive(f)).toEqual(derive(f));
  });

  it("never throws across states and transients", () => {
    const cases: ToolFacts[] = [
      facts(),
      installed(),
      installed({ lastCheckedAtUtc: 1, desiredVersion: "8.1.1" }),
      installed({ lastCheckedAtUtc: 1, desiredVersion: "8.2" }),
    ];
    const transients: ToolTransient[] = [
      idle,
      { kind: "running", operation: "provision", percent: 40 },
      { kind: "running", operation: "check", percent: null },
      { kind: "failed", operation: "provision", error: "boom" },
    ];
    for (const f of cases) {
      for (const t of transients) {
        expect(() => derive(f, t)).not.toThrow();
      }
    }
  });
});

// I2 — Presence is scanned, not stored: "Not installed" derives from present=false
// regardless of any version facts that may linger.
describe("I2/I4 — missing is always known", () => {
  it("is not-installed when absent, even with stale version facts present", () => {
    const s = derive(facts({ installedVersion: "8.1.1", desiredVersion: "8.2", lastCheckedAtUtc: 5 }));
    expect(s.state).toBe("not-installed");
  });
});

// I3 — A failed check is honest: it persists nothing, so lastCheckedAtUtc stays
// null and a present tool reads installed-unchecked, never up-to-date.
describe("I3 — honest state: no successful check ⇒ not up-to-date", () => {
  it("present with no check is installed-unchecked", () => {
    const s = derive(installed());
    expect(s.state).toBe("installed-unchecked");
    expect(s.role).toBe("informational");
  });

  it("present with a successful matching check is up-to-date", () => {
    const s = derive(installed({ lastCheckedAtUtc: 5, desiredVersion: "8.1.1" }));
    expect(s.state).toBe("up-to-date");
    expect(s.role).toBe("none");
  });

  it("present with a newer latest is update-available", () => {
    const s = derive(installed({ lastCheckedAtUtc: 5, desiredVersion: "8.2" }));
    expect(s.state).toBe("update-available");
    expect(s.role).toBe("warning");
  });
});

// The state → role mapping the convention tables, including the optional-absent
// nuance (informational, not a warning).
describe("state → role mapping", () => {
  it("required-absent → warning", () => {
    expect(derive(facts(), idle, true).role).toBe("warning");
  });

  it("optional-absent → informational", () => {
    expect(derive(facts(), idle, false).role).toBe("informational");
  });

  it("installed-unchecked → informational", () => {
    expect(derive(installed()).role).toBe("informational");
  });

  it("update-available → warning", () => {
    expect(derive(installed({ lastCheckedAtUtc: 5, desiredVersion: "8.2" })).role).toBe("warning");
  });

  it("up-to-date → none", () => {
    expect(derive(installed({ lastCheckedAtUtc: 5, desiredVersion: "8.1.1" })).role).toBe("none");
  });
});

// I5 — Operations are transient: a failed operation never persists as a state.
describe("I5 — a failed operation is transient over persisted state", () => {
  it("a failed provision leaves the tool not-installed, shown as error via the overlay", () => {
    const status = derive(facts(), { kind: "failed", operation: "provision", error: "network down" });
    expect(status.state).toBe("not-installed"); // persisted state unchanged
    expect(status.role).toBe("error"); // transient overlay
  });

  it("a running operation overlays informational regardless of base role", () => {
    const status = derive(facts(), { kind: "running", operation: "provision", percent: 10 });
    expect(status.role).toBe("informational");
  });
});

// I6 — Roll-up is the worst role by precedence error > warning > informational > none.
describe("I6 — roll-up is the worst role", () => {
  const row = (role: DependencyStatus["role"]): DependencyStatus => ({ ...derive(facts()), role });

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
