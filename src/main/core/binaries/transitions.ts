import type { PersistedToolFacts } from "./store";

// The pure per-operation state transition — the persisted-facts half of the two
// operations that mutate state, lifted out of the stateful ToolManager so the move
// is unit-testable on its own (Separation of Concerns #4). The manager stays the
// I/O shell that runs the operation and applies this to its facts.
//
// There is only ONE transition, because there is only one persisted fact pair to
// move: the latest version an operation resolved, and when it resolved it. A check
// learns the latest; an install learns it too (it just downloaded it). Neither
// records what is now installed — that is read back from the binary
// (installed-version.ts), so it cannot drift from what is on disk.
//
// There is no transition for a failed check or a failed install: both write nothing
// (managed-runtime-dependencies-conventions). A failed check is honest in the data
// (the wording stays at the last successful knowledge); a failed install leaves the
// prior facts untouched and surfaces only through the transient overlay.
export function recordLatest(
  facts: PersistedToolFacts,
  desiredVersion: string,
  nowUtc: number,
): PersistedToolFacts {
  return { ...facts, desiredVersion, lastCheckedAtUtc: nowUtc };
}
