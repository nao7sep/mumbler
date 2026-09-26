import type { ReactElement } from "react";

import type { DependencyState, DependencyStatus, StatusRole, ToolName } from "@shared/app-shell";

import type { MessageKey } from "@shared/i18n/catalogues";
import type { Message, Translator } from "@shared/i18n/translate";

import { ModalShell } from "./modal/ModalShell";
import { useI18n } from "../i18n/I18nContext";

// The management surface for mumbler's audio tools (ffmpeg/ffprobe), per the
// managed-runtime-dependencies-conventions: one named, dismissible surface listing
// every tool with its state, version facts, live progress, and per-tool error.
// Each row offers a single context-aware action — Install when missing, Update
// when a newer version is known or the installed one could not be read, nothing
// otherwise — over the one acquire operation (download the latest, verify once).
// A set-wide "Check for updates"
// resolves the latest version. The single toggle ("check at launch") lives here,
// not in Settings. Status is shown through the semantic role each row derives; the
// theme owns the concrete colour.

export interface AudioToolsModalProps {
  dependencies: DependencyStatus[];
  checkUpdatesAtLaunch: boolean;
  isChecking: boolean;
  // A non-persisted terminal notice when an explicit check just failed (offline,
  // rate-limited). The application owner retains it across view replacement until
  // the next matching check supersedes it.
  checkNotice: Message | null;
  operationError: Message | null;
  onProvision: (name: ToolName) => void;
  onCancelProvision: (name: ToolName) => void;
  onCheck: () => void;
  onCancelCheck: () => void;
  onToggleCheckUpdates: (value: boolean) => void;
  onClose: () => void;
}

const ROLE_CLASS: Record<StatusRole, string> = {
  none: "tools-role--ok",
  informational: "tools-role--info",
  warning: "tools-role--warning",
  error: "tools-role--error",
};

const STATUS_LABEL: Record<DependencyState, MessageKey> = {
  "not-installed": "tools.stateNotInstalled",
  "update-available": "tools.stateUpdateAvailable",
  "up-to-date": "tools.stateUpToDate",
  "installed-unchecked": "tools.stateUnchecked",
};

// The one per-row action: Install when missing, Update when a newer version is
// known — and Update again when a present tool's own version could not be read,
// which is the only way out of that row: the set-wide Check resolves the LATEST,
// so it can never clear an unreadable INSTALLED version, and re-acquiring is what
// replaces the copy that would not answer. Up to date, and installed-but-unchecked
// with a version in hand, offer no row action — the set-wide Check is that move.
function acquireLabel(state: DependencyState, installedVersion: string | null): MessageKey | null {
  if (state === "not-installed") return "tools.install";
  if (state === "update-available") return "tools.update";
  if (state === "installed-unchecked" && installedVersion === null) return "tools.update";
  return null;
}

// How long ago, through the platform's relative-time formatting.
function relativeTime(i18n: Translator, utcMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - utcMs) / 1000));
  if (diffSec < 60) return i18n.t("tools.justNow");
  if (diffSec < 3600) return i18n.relativeTime(-Math.floor(diffSec / 60), "minute");
  if (diffSec < 86400) return i18n.relativeTime(-Math.floor(diffSec / 3600), "hour");
  return i18n.relativeTime(-Math.floor(diffSec / 86400), "day");
}

function lastCheckedHint(i18n: Translator, dependencies: DependencyStatus[], isChecking: boolean): string {
  if (isChecking) return i18n.t("tools.checking");
  const stamps = dependencies
    .map((dep) => dep.lastCheckedAtUtc)
    .filter((value): value is number => value !== null);
  if (stamps.length === 0) return i18n.t("tools.neverChecked");
  return i18n.t("tools.lastChecked", { when: relativeTime(i18n, Math.max(...stamps)) });
}

function displayArtifactIdentity(identity: string | null): string | null {
  return identity?.match(/^Latest Auto-Build \((.+)\)$/)?.[1] ?? identity;
}

export function AudioToolsModal({
  dependencies,
  checkUpdatesAtLaunch,
  isChecking,
  checkNotice,
  operationError,
  onProvision,
  onCancelProvision,
  onCheck,
  onCancelCheck,
  onToggleCheckUpdates,
  onClose,
}: AudioToolsModalProps): ReactElement {
  const i18n = useI18n();
  const { t, text } = i18n;
  return (
    <ModalShell
      title={t("tools.title")}
      onRequestClose={onClose}
      describedById="audio-tools-description"
      footer={
        <button type="button" className="button button--ghost" onClick={onClose}>
          {t("common.close")}
        </button>
      }
    >
      <div className="modal-card__body">
        <p id="audio-tools-description" className="tools-intro">
          {t("tools.intro")}
        </p>

        <div className="tools-toolbar">
          <span className="field-hint">{lastCheckedHint(i18n, dependencies, isChecking)}</span>
          <button
            type="button"
            className="button button--ghost button--compact"
            onClick={isChecking ? onCancelCheck : onCheck}
          >
            {isChecking ? t("tools.cancelCheck") : t("tools.checkForUpdates")}
          </button>
        </div>

        {checkNotice !== null && (
          <p className="banner banner--warning tools-error">{text(checkNotice)}</p>
        )}

        {operationError !== null && (
          <p className="banner banner--error tools-error" role="alert">
            {text(operationError)}
          </p>
        )}

        <table className="tools-table">
          <thead>
            <tr>
              <th>{t("tools.columnTool")}</th>
              <th>{t("tools.columnStatus")}</th>
              <th>{t("tools.columnInstalled")}</th>
              <th>{t("tools.columnLatest")}</th>
              <th aria-label={t("tools.columnActions")} />
            </tr>
          </thead>
          <tbody>
            {dependencies.map((status) => {
              const running = status.transient.kind === "running";
              const needsAttention = status.role === "warning" || status.role === "error";
              const action = acquireLabel(status.state, status.installedVersion);
              return (
                <tr key={status.name}>
                  <td className="tools-table__name">{status.name}</td>
                  <td>
                    <span className={ROLE_CLASS[status.role]}>{t(STATUS_LABEL[status.state])}</span>
                  </td>
                  <td>
                    {displayArtifactIdentity(status.installedVersion) ??
                      (status.state === "not-installed" ? "—" : t("tools.versionUnreadable"))}
                  </td>
                  <td>{displayArtifactIdentity(status.desiredVersion) ?? (isChecking ? "…" : t("common.unknown"))}</td>
                  <td className="tools-table__action">
                    {running ? (
                      <span className="tools-table__actions">
                        <span className="field-hint">
                          {status.transient.kind === "running" && status.transient.percent !== null
                            ? i18n.percent(status.transient.percent / 100)
                            : t("tools.working")}
                        </span>
                        {status.transient.kind === "running" &&
                        status.transient.operation === "provision" ? (
                          <button
                            type="button"
                            className="button button--compact button--ghost"
                            onClick={() => onCancelProvision(status.name)}
                          >
                            {t("common.cancel")}
                          </button>
                        ) : null}
                      </span>
                    ) : action === null ? null : (
                      <button
                        type="button"
                        className={`button button--compact ${needsAttention ? "button--primary" : "button--ghost"}`}
                        onClick={() => onProvision(status.name)}
                        title={t("tools.acquireTitle")}
                      >
                        {t(action)}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {dependencies
          .filter((status) => status.transient.kind === "failed")
          .map((status) => {
            const failure = status.transient.kind === "failed" ? status.transient.error : null;
            return failure === null ? null : (
              <p key={status.name} className="banner banner--error tools-error" role="alert">
                {text(failure)}
              </p>
            );
          })}

        <div className="tools-gates">
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={checkUpdatesAtLaunch}
              onChange={(event) => onToggleCheckUpdates(event.target.checked)}
            />
            <span>{t("tools.checkOnLaunch")}</span>
          </label>
        </div>
      </div>
    </ModalShell>
  );
}
