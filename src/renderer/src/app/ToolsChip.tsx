import type { ReactElement } from "react";

import type { DependencyStatus, StatusRole } from "@shared/app-shell";
import { rollUpRole, rollUpRoleAtRest, toolsActivity, type ToolsActivity } from "@shared/dependency-status";
import type { MessageKey } from "@shared/i18n/catalogues";

import { useI18n } from "../i18n/I18nContext";

const ACTIVITY: Record<ToolsActivity, MessageKey> = {
  installing: "tools.chipInstalling",
  updating: "tools.chipUpdating",
  checking: "tools.chipChecking",
};

// The informational state covers two different stories, and the chip can tell
// them apart, so it does: a tool whose own version could not be read needs the
// user to re-acquire it (the modal's Update), where a merely-unchecked one only
// needs a check.
function restingMessage(role: StatusRole, dependencies: DependencyStatus[]): MessageKey {
  if (role !== "informational") return "tools.chipAttention";
  const unreadable = dependencies.some((dep) => dep.state === "installed-unchecked" && dep.installedVersion === null);
  return unreadable ? "tools.chipVersionUnreadable" : "tools.chipUpdatesUnchecked";
}

// The topbar dependency roll-up (managed-runtime-dependencies-conventions): a
// single status message at the worst role present that opens Managed tools. It
// is deliberately a tinted status pill, not a plain button — a missing or
// outdated tool needs to read as a condition that wants attention. With Managed
// tools closed, work it started shows here until it ends; while the view is
// open, the view shows it, so a quick check does not flash behind it.
export function ToolsChip({ dependencies, checking, viewOpen, onOpen }: {
  dependencies: DependencyStatus[] | null;
  checking: boolean;
  viewOpen: boolean;
  onOpen: () => void;
}): ReactElement | null {
  const { t } = useI18n();
  if (dependencies === null) return null;
  const activity = viewOpen ? null : toolsActivity(dependencies, checking);
  const role = activity !== null ? rollUpRole(dependencies) : rollUpRoleAtRest(dependencies);
  if (activity === null && role === "none") return null;
  const shownRole = role === "none" ? "informational" : role;
  return (
    <button
      type="button"
      className={`tools-chip tools-chip--${shownRole}`}
      onClick={onOpen}
      title={t("tools.openTitle")}
      aria-live="polite"
    >
      {t(activity !== null ? ACTIVITY[activity] : restingMessage(role, dependencies))}
    </button>
  );
}
