import type { ToolName } from "@shared/app-shell";
import { formatUtcIsoCompact } from "@shared/timestamps";

import { FORMAT_VERSIONS } from "../format-versions";
import { JsonStore } from "../json-store";
import { TOOL_NAMES } from "./registry";

// Persisted per-tool facts — the honest single source of truth the status is
// derived from (managed-runtime-dependencies-conventions). Only what cannot be
// re-derived is stored, and both survivors are NETWORK facts with no on-disk
// source: the last-known latest and the last *successful* check time. `present`
// is NOT persisted — it is scanned from disk at startup — and neither is the
// INSTALLED version, which is read from the binary itself (installed-version.ts):
// a fact about a file kept away from that file drifts the moment an install does
// not write the record, and a present tool with no recorded version can only read
// as "installed (not checked)" forever. No integrity flag, fault flag, or
// check-error is kept either: a failed check writes nothing, and a damaged file
// fails when used and is fixed by installing again.
//
// `lastCheckedAtUtc` is held in memory as epoch-ms (cheap to compare) but written
// to disk as canonical ISO-8601 (per the timestamp-conventions) via the store's
// serialize/validate hooks — the same epoch-ms-in-core / ISO-at-the-edge split the
// state store uses.
export interface PersistedToolFacts {
  desiredVersion: string | null;
  lastCheckedAtUtc: number | null;
}

// Beside the per-tool facts sits the one app-wide time of the last check attempt,
// automatic or manual, written immediately before the check starts
// (managed-runtime-dependencies-conventions).
export interface DependenciesValue {
  tools: Record<ToolName, PersistedToolFacts>;
  lastCheckAttemptAtUtc: number | null;
}

function emptyFacts(): PersistedToolFacts {
  return {
    desiredVersion: null,
    lastCheckedAtUtc: null,
  };
}

export function createDefaultDependencies(): DependenciesValue {
  return {
    tools: { ffmpeg: emptyFacts(), ffprobe: emptyFacts() },
    lastCheckAttemptAtUtc: null,
  };
}

const LAUNCH_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Whether the launch check runs: only when the last attempt is missing, invalid,
// in the future, or at least a day old (managed-runtime-dependencies-conventions).
export function launchCheckDue(lastCheckAttemptAtUtc: number | null, nowMs: number): boolean {
  return lastCheckAttemptAtUtc === null || lastCheckAttemptAtUtc > nowMs || nowMs - lastCheckAttemptAtUtc >= LAUNCH_CHECK_INTERVAL_MS;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// Read a UTC instant written either as canonical ISO-8601 (current) or as a raw
// epoch-ms number (files written before this store serialized timestamps).
// Garbage yields null rather than a false "checked just now".
function asUtcMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function normalizeFacts(raw: unknown): PersistedToolFacts {
  const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  // Fields from earlier models — installedVersion, and the older installedSha256,
  // faulted, lastError, lastCheckError — are simply not read here, so they drop on
  // the next save (the app is pre-release; no migration code).
  return {
    desiredVersion: asString(record.desiredVersion),
    lastCheckedAtUtc: asUtcMs(record.lastCheckedAtUtc),
  };
}

function normalize(raw: Record<string, unknown>): DependenciesValue {
  const tools = raw.tools !== null && typeof raw.tools === "object" ? (raw.tools as Record<string, unknown>) : {};
  const out = createDefaultDependencies();
  for (const name of TOOL_NAMES) {
    out.tools[name] = normalizeFacts(tools[name]);
  }
  out.lastCheckAttemptAtUtc = asUtcMs(raw.lastCheckAttemptAtUtc);
  return out;
}

// Render the in-memory value to its on-disk shape: epoch-ms instants become
// canonical ISO-8601. The write-side mirror of normalize() above.
function serializeDependencies(value: DependenciesValue): object {
  const tools: Record<string, unknown> = {};
  for (const name of TOOL_NAMES) {
    const facts = value.tools[name];
    tools[name] = {
      desiredVersion: facts.desiredVersion,
      lastCheckedAtUtc:
        facts.lastCheckedAtUtc === null ? null : formatUtcIsoCompact(facts.lastCheckedAtUtc),
    };
  }
  return {
    tools,
    lastCheckAttemptAtUtc:
      value.lastCheckAttemptAtUtc === null ? null : formatUtcIsoCompact(value.lastCheckAttemptAtUtc),
  };
}

export function createDependenciesStore(path: string): JsonStore<DependenciesValue> {
  return new JsonStore<DependenciesValue>({
    path,
    formatVersion: FORMAT_VERSIONS.dependencies,
    validate: normalize,
    createDefault: createDefaultDependencies,
    serialize: serializeDependencies,
    // not recorded: dependencies.json contains only re-derivable latest-version
    // and successful-check facts; losing it causes a refresh, not lost user work.
    record: false,
  });
}
