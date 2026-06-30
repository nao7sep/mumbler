import type {
  DependencyState,
  DependencyStatus,
  StatusRole,
  ToolFacts,
  ToolName,
  ToolTransient,
} from "@shared/app-shell";

// The pure derivation the managed-runtime-dependencies-conventions mandate: the one
// place a tool's displayed state is computed, from persisted facts plus the
// transient operation status and nothing else (no I/O, no filesystem probe, no
// --version call). Both the main process (to fill the snapshot) and the renderer
// call this, so every surface shows identical state, and the invariants below are
// unit-tested here rather than hoped for in scattered view code.

// The four-state model. Presence is a scanned input (I2); "up-to-date" requires a
// check that actually succeeded (lastCheckedAtUtc set — a failed check writes
// nothing), so "not checking" can never read as "up to date" (I3, the honest-state
// principle). There is no faulted state: a damaged file fails when used and is
// fixed by installing again.
function stateOf(facts: ToolFacts): DependencyState {
  if (!facts.present) {
    return "not-installed";
  }
  const checked =
    facts.lastCheckedAtUtc !== null &&
    facts.desiredVersion !== null &&
    facts.installedVersion !== null;
  if (!checked) {
    return "installed-unchecked";
  }
  return facts.desiredVersion === facts.installedVersion ? "up-to-date" : "update-available";
}

// Role from the persisted state alone — the base before any transient overlay.
// required-absent and update-available are warnings; optional-absent and
// installed-unchecked are informational; up-to-date is silent.
function baseRole(state: DependencyState, required: boolean): StatusRole {
  switch (state) {
    case "not-installed":
      return required ? "warning" : "informational";
    case "update-available":
      return "warning";
    case "installed-unchecked":
      return "informational";
    case "up-to-date":
      return "none";
  }
}

// Render = role(persisted), overridden by the transient when an operation is
// running (informational, with progress) or just failed (error). The persisted
// state underneath is unchanged (I5).
function applyTransient(base: StatusRole, transient: ToolTransient): StatusRole {
  if (transient.kind === "running") {
    return "informational";
  }
  if (transient.kind === "failed") {
    return "error";
  }
  return base;
}

export function deriveStatus(
  name: ToolName,
  required: boolean,
  facts: ToolFacts,
  transient: ToolTransient,
): DependencyStatus {
  const state = stateOf(facts);
  return {
    name,
    required,
    state,
    role: applyTransient(baseRole(state, required), transient),
    installedVersion: facts.installedVersion,
    desiredVersion: facts.desiredVersion,
    lastCheckedAtUtc: facts.lastCheckedAtUtc,
    transient,
  };
}

const ROLE_RANK: Record<StatusRole, number> = {
  none: 0,
  informational: 1,
  warning: 2,
  error: 3,
};

// The single set indicator (a status-bar badge): the worst role present, by
// precedence error > warning > informational > none (I6). An empty set is quiet.
export function rollUpRole(statuses: DependencyStatus[]): StatusRole {
  return statuses.reduce<StatusRole>(
    (worst, status) => (ROLE_RANK[status.role] > ROLE_RANK[worst] ? status.role : worst),
    "none",
  );
}
