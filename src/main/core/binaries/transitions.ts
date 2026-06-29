import type { PersistedToolFacts } from "./store";

// The pure per-operation state transitions — the persisted-facts half of the
// transition table in the managed-dependency-status-conventions, lifted out of
// the stateful ToolManager so each move is unit-testable on its own (Separation
// of Concerns #4). The manager stays the I/O shell that runs the operation and
// applies one of these to its persisted facts.

// A successful Provision / Update / Repair: the tool is installed at `version`
// with `installedSha256`, so it is current and trusted — every fault, check
// error, and stale-version signal is cleared.
export function afterInstall(
  facts: PersistedToolFacts,
  version: string,
  installedSha256: string,
  nowUtc: number,
): PersistedToolFacts {
  return {
    ...facts,
    installedVersion: version,
    installedSha256,
    desiredVersion: version,
    lastCheckedAtUtc: nowUtc,
    lastCheckError: null,
    lastError: null,
    faulted: false,
  };
}

// A successful currency check: record the desired version and the check time,
// clear any prior check error. Installed version and integrity are untouched.
export function afterCheckSuccess(
  facts: PersistedToolFacts,
  desiredVersion: string,
  nowUtc: number,
): PersistedToolFacts {
  return { ...facts, desiredVersion, lastCheckedAtUtc: nowUtc, lastCheckError: null };
}

// A failed currency check (I3): record only the check time and error — never
// touch the installed or desired version, so a failure can't read as Current.
export function afterCheckFailure(
  facts: PersistedToolFacts,
  error: string,
  nowUtc: number,
): PersistedToolFacts {
  return { ...facts, lastCheckedAtUtc: nowUtc, lastCheckError: error };
}

// Verify found the installed file intact: clear any fault.
export function afterVerifyPass(facts: PersistedToolFacts): PersistedToolFacts {
  return { ...facts, faulted: false, lastError: null };
}

// Verify found the installed file corrupt (I4): the present file is no longer
// trustworthy — fault it and record why. Versions are untouched.
export function afterVerifyFail(facts: PersistedToolFacts, message: string): PersistedToolFacts {
  return { ...facts, faulted: true, lastError: message };
}
