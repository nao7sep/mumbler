import type { PersistedToolFacts } from "./store";

// The pure per-operation state transitions — the persisted-facts half of the two
// operations that mutate state, lifted out of the stateful ToolManager so each
// move is unit-testable on its own (Separation of Concerns #4). The manager stays
// the I/O shell that runs the operation and applies one of these to its facts.
//
// There is no transition for a failed check or a failed install: both write
// nothing (managed-runtime-dependencies-conventions). A failed check is honest in
// the data (the wording stays at the last successful knowledge); a failed install
// leaves the prior facts untouched and surfaces only through the transient overlay.

// A successful Install / Update: the tool is installed at `version`, which is also
// the latest the resolve just returned — so it is current as of `nowUtc`.
export function afterInstall(
  facts: PersistedToolFacts,
  version: string,
  nowUtc: number,
): PersistedToolFacts {
  return {
    ...facts,
    installedVersion: version,
    desiredVersion: version,
    lastCheckedAtUtc: nowUtc,
  };
}

// A successful update check: record the latest version and the check time.
// Installed version is untouched.
export function afterCheckSuccess(
  facts: PersistedToolFacts,
  desiredVersion: string,
  nowUtc: number,
): PersistedToolFacts {
  return { ...facts, desiredVersion, lastCheckedAtUtc: nowUtc };
}
