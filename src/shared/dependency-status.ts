import type {
  DependencyStatus,
  StatusRole,
  ToolCurrency,
  ToolFacts,
  ToolLifecycle,
  ToolName,
  ToolOperationKind,
  ToolTransient,
} from "@shared/app-shell";

// The pure derivation the managed-dependency-status-conventions mandate: the one
// place a tool's displayed state is computed, from persisted facts plus the
// transient operation status and nothing else (no I/O, no filesystem probe, no
// --version call). Both the main process (to fill the snapshot) and the renderer
// call this, so every surface shows identical state, and the invariants below are
// unit-tested here rather than hoped for in scattered view code.

function lifecycleOf(facts: ToolFacts): ToolLifecycle {
  if (!facts.present) {
    return "absent";
  }
  // Faulted is reached only by a recorded fault (I4) — present-but-unusable is
  // never inferred from anything else here.
  return facts.faulted ? "faulted" : "provisioned";
}

// Currency is a sub-state of "provisioned" only (I2): null for every other
// lifecycle, so an impossible pairing (absent + stale) cannot be represented.
function currencyOf(lifecycle: ToolLifecycle, facts: ToolFacts): ToolCurrency | null {
  if (lifecycle !== "provisioned") {
    return null;
  }
  if (facts.lastCheckedAtUtc === null) {
    return "unchecked";
  }
  // A failed check is honest (I3): it sets lastCheckError and never resolves to
  // current, regardless of the (now untrusted) version facts.
  if (facts.lastCheckError !== null) {
    return "check-failed";
  }
  if (
    facts.desiredVersion !== null &&
    facts.installedVersion !== null &&
    facts.desiredVersion !== facts.installedVersion
  ) {
    return "stale";
  }
  return "current";
}

// Role from the persisted state alone — the base before any transient overlay.
// warning = an action is available on a healthy tool; error = something is wrong;
// informational = a benign, no-action condition; none = quiet (provisioned +
// current).
function baseRole(lifecycle: ToolLifecycle, currency: ToolCurrency | null): StatusRole {
  if (lifecycle === "absent") {
    return "warning";
  }
  if (lifecycle === "faulted") {
    return "error";
  }
  switch (currency) {
    case "current":
      return "none";
    case "unchecked":
      return "informational";
    case "stale":
      return "warning";
    case "check-failed":
      return "error";
    default:
      return "none";
  }
}

// The operation a row offers for a given state.
function operationOf(
  lifecycle: ToolLifecycle,
  currency: ToolCurrency | null,
): ToolOperationKind | null {
  if (lifecycle === "absent") {
    return "provision";
  }
  if (lifecycle === "faulted") {
    return "verify";
  }
  switch (currency) {
    case "stale":
      return "update";
    case "unchecked":
    case "check-failed":
      return "check";
    default:
      // current: re-verify / reinstall is the only thing left to offer.
      return "verify";
  }
}

// Render = role(persisted), overridden by the transient when an operation is
// running (informational, with progress) or just failed (error). The persisted
// state underneath is unchanged.
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
  const lifecycle = lifecycleOf(facts);
  const currency = currencyOf(lifecycle, facts);
  return {
    name,
    required,
    lifecycle,
    currency,
    role: applyTransient(baseRole(lifecycle, currency), transient),
    operation: operationOf(lifecycle, currency),
    installedVersion: facts.installedVersion,
    desiredVersion: facts.desiredVersion,
    lastCheckedAtUtc: facts.lastCheckedAtUtc,
    error: facts.faulted || facts.lastCheckError !== null ? facts.lastError ?? facts.lastCheckError : null,
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
// precedence error > warning > informational > none (I7). An empty set is quiet.
export function rollUpRole(statuses: DependencyStatus[]): StatusRole {
  return statuses.reduce<StatusRole>(
    (worst, status) => (ROLE_RANK[status.role] > ROLE_RANK[worst] ? status.role : worst),
    "none",
  );
}
