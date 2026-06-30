import type { ToolName } from "@shared/app-shell";

import { JsonStore } from "../json-store";
import { TOOL_NAMES } from "./registry";

// Persisted per-tool facts — the honest single source of truth the status is
// derived from (managed-runtime-dependencies-conventions). Only what cannot be
// re-derived is stored: the installed version, the last-known latest, and the
// last *successful* check time. `present` is NOT persisted — it is scanned from
// disk at startup, so the file can never claim a tool the user has since deleted.
// No integrity flag, fault flag, or check-error is kept: a failed check writes
// nothing, and a damaged file fails when used and is fixed by installing again.
export interface PersistedToolFacts {
  installedVersion: string | null;
  desiredVersion: string | null;
  lastCheckedAtUtc: number | null;
}

export interface DependenciesValue {
  schemaVersion: 1;
  tools: Record<ToolName, PersistedToolFacts>;
}

const SCHEMA_VERSION = 1;

function emptyFacts(): PersistedToolFacts {
  return {
    installedVersion: null,
    desiredVersion: null,
    lastCheckedAtUtc: null,
  };
}

export function createDefaultDependencies(): DependenciesValue {
  return {
    schemaVersion: SCHEMA_VERSION,
    tools: { ffmpeg: emptyFacts(), ffprobe: emptyFacts() },
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeFacts(raw: unknown): PersistedToolFacts {
  const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  // Any legacy fields from the old model (installedSha256, faulted, lastError,
  // lastCheckError) are simply not read here, so they drop on the next save.
  return {
    installedVersion: asString(record.installedVersion),
    desiredVersion: asString(record.desiredVersion),
    lastCheckedAtUtc: asNumber(record.lastCheckedAtUtc),
  };
}

function normalize(raw: Record<string, unknown>): DependenciesValue {
  const tools = raw.tools !== null && typeof raw.tools === "object" ? (raw.tools as Record<string, unknown>) : {};
  const out = createDefaultDependencies();
  for (const name of TOOL_NAMES) {
    out.tools[name] = normalizeFacts(tools[name]);
  }
  return out;
}

export function createDependenciesStore(path: string): JsonStore<DependenciesValue> {
  return new JsonStore<DependenciesValue>({
    path,
    schemaVersion: SCHEMA_VERSION,
    validate: normalize,
    createDefault: createDefaultDependencies,
  });
}
