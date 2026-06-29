import type { ToolName } from "@shared/app-shell";

import { JsonStore } from "../json-store";
import { TOOL_NAMES } from "./registry";

// Persisted per-tool facts — the honest single source of truth the status is
// derived from (managed-dependency-status-conventions). `present` is NOT persisted:
// it is reconciled from disk at startup, so the file can never claim a tool is
// installed that the user has since deleted.
export interface PersistedToolFacts {
  installedVersion: string | null;
  // SHA-256 of the installed executable, recorded at install so Verify can
  // re-hash the on-disk file and detect post-install corruption (→ Faulted).
  installedSha256: string | null;
  desiredVersion: string | null;
  lastCheckedAtUtc: number | null;
  // Non-null iff the last currency check failed (→ check-failed).
  lastCheckError: string | null;
  // Display message for a fault (set only alongside faulted=true). Operation
  // failures are transient and never persisted (managed-dependency-status I6).
  lastError: string | null;
  // Present-but-unusable: a failed integrity verify or unparseable version (→ faulted).
  faulted: boolean;
}

export interface DependenciesValue {
  schemaVersion: 1;
  tools: Record<ToolName, PersistedToolFacts>;
}

const SCHEMA_VERSION = 1;

function emptyFacts(): PersistedToolFacts {
  return {
    installedVersion: null,
    installedSha256: null,
    desiredVersion: null,
    lastCheckedAtUtc: null,
    lastCheckError: null,
    lastError: null,
    faulted: false,
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
  return {
    installedVersion: asString(record.installedVersion),
    installedSha256: asString(record.installedSha256),
    desiredVersion: asString(record.desiredVersion),
    lastCheckedAtUtc: asNumber(record.lastCheckedAtUtc),
    lastCheckError: asString(record.lastCheckError),
    lastError: asString(record.lastError),
    faulted: record.faulted === true,
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
