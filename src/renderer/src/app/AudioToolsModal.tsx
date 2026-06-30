import type { ReactElement } from "react";

import type { DependencyState, DependencyStatus, StatusRole, ToolName } from "@shared/app-shell";

import { ModalShell } from "./modal/ModalShell";

// The management surface for mumbler's audio tools (ffmpeg/ffprobe), per the
// managed-runtime-dependencies-conventions: one named, dismissible surface listing
// every tool with its state, version facts, live progress, and per-tool error.
// Each row offers a single context-aware action — Install when missing, Update
// when a newer version is known, nothing when up to date — over the one acquire
// operation (download the latest, verify once). A set-wide "Check for updates"
// resolves the latest version. The single toggle ("check at launch") lives here,
// not in Settings. Status is shown through the semantic role each row derives; the
// theme owns the concrete colour.

export interface AudioToolsModalProps {
  dependencies: DependencyStatus[];
  checkUpdatesAtLaunch: boolean;
  isChecking: boolean;
  // A transient, non-persisted notice when an explicit check just failed (offline,
  // rate-limited). The convention writes nothing to the facts on a failed check, so
  // this is the only surface it gets — and it auto-clears.
  checkNotice: string | null;
  onProvision: (name: ToolName) => void;
  onCheck: () => void;
  onToggleCheckUpdates: (value: boolean) => void;
  onClose: () => void;
}

const ROLE_CLASS: Record<StatusRole, string> = {
  none: "tools-role--ok",
  informational: "tools-role--info",
  warning: "tools-role--warning",
  error: "tools-role--error",
};

const STATUS_LABEL: Record<DependencyState, string> = {
  "not-installed": "Not installed",
  "update-available": "Update available",
  "up-to-date": "Up to date",
  "installed-unchecked": "Installed (not checked)",
};

// The one per-row action: Install when missing, Update when a newer version is
// known. Up-to-date and installed-unchecked offer no row action — the only move
// there is the set-wide Check.
function acquireLabel(state: DependencyState): string | null {
  if (state === "not-installed") return "Install";
  if (state === "update-available") return "Update";
  return null;
}

function relativeTime(utcMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - utcMs) / 1000));
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} h ago`;
  return `${Math.floor(diffSec / 86400)} days ago`;
}

function lastCheckedHint(dependencies: DependencyStatus[], isChecking: boolean): string {
  if (isChecking) return "Checking…";
  const stamps = dependencies
    .map((dep) => dep.lastCheckedAtUtc)
    .filter((value): value is number => value !== null);
  if (stamps.length === 0) return "Never checked for updates.";
  return `Last checked ${relativeTime(Math.max(...stamps))}.`;
}

export function AudioToolsModal({
  dependencies,
  checkUpdatesAtLaunch,
  isChecking,
  checkNotice,
  onProvision,
  onCheck,
  onToggleCheckUpdates,
  onClose,
}: AudioToolsModalProps): ReactElement {
  return (
    <ModalShell
      title="Audio Tools"
      onRequestClose={onClose}
      describedById="audio-tools-description"
      footer={
        <button type="button" className="button button--ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="modal-card__body">
        <p id="audio-tools-description" className="tools-intro">
          Mumbler uses ffmpeg and ffprobe to read and trim audio. They are downloaded as native
          builds, verified by checksum, and kept in your app data folder. Both are required.
        </p>

        <div className="tools-toolbar">
          <span className="field-hint">{lastCheckedHint(dependencies, isChecking)}</span>
          <button
            type="button"
            className="button button--ghost button--compact"
            onClick={onCheck}
            disabled={isChecking}
          >
            {isChecking ? "Checking…" : "Check for updates"}
          </button>
        </div>

        {checkNotice !== null && (
          <p className="banner banner--warning tools-error">{checkNotice}</p>
        )}

        <table className="tools-table">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Status</th>
              <th>Installed</th>
              <th>Latest</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {dependencies.map((status) => {
              const running = status.transient.kind === "running";
              const needsAttention = status.role === "warning" || status.role === "error";
              const action = acquireLabel(status.state);
              return (
                <tr key={status.name}>
                  <td className="tools-table__name">{status.name}</td>
                  <td>
                    <span className={ROLE_CLASS[status.role]}>{STATUS_LABEL[status.state]}</span>
                  </td>
                  <td>{status.installedVersion ?? "—"}</td>
                  <td>{status.desiredVersion ?? (isChecking ? "…" : "unknown")}</td>
                  <td className="tools-table__action">
                    {running ? (
                      <span className="field-hint">
                        {status.transient.kind === "running" && status.transient.percent !== null
                          ? `${status.transient.percent}%`
                          : "working…"}
                      </span>
                    ) : action === null ? null : (
                      <button
                        type="button"
                        className={`button button--compact ${needsAttention ? "button--primary" : "button--ghost"}`}
                        onClick={() => onProvision(status.name)}
                        title="Download and install the latest build"
                      >
                        {action}
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
            const message = status.transient.kind === "failed" ? status.transient.error : null;
            return message === null ? null : (
              <p key={status.name} className="banner banner--error tools-error">
                {status.name}: {message}
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
            <span>Check for tool updates on launch</span>
          </label>
        </div>
      </div>
    </ModalShell>
  );
}
