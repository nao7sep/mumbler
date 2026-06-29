import type { ReactElement } from "react";

import type { DependencyStatus, StatusRole, ToolName } from "@shared/app-shell";

import { ModalShell } from "./modal/ModalShell";

// The management surface for mumbler's audio tools (ffmpeg/ffprobe), per the
// managed-dependency-status-conventions: one named, dismissible surface listing
// every tool with its state, version facts, live progress, and per-tool error.
// Each row offers two explicit actions — Verify (re-hash the installed file
// against the recorded checksum; never downloads) and Install/Reinstall
// ((re)download and (re)install regardless of what's there) — plus a single
// set-wide "Check for updates". Status is shown through the semantic role each row
// derives; the theme owns the concrete colour.

export interface AudioToolsModalProps {
  dependencies: DependencyStatus[];
  checkToolUpdates: boolean;
  autoDownloadTools: boolean;
  isChecking: boolean;
  onVerify: (name: ToolName) => void;
  onReinstall: (name: ToolName) => void;
  onCheck: () => void;
  onSaveGates: (checkToolUpdates: boolean, autoDownloadTools: boolean) => void;
  onClose: () => void;
}

const ROLE_CLASS: Record<StatusRole, string> = {
  none: "tools-role--ok",
  informational: "tools-role--info",
  warning: "tools-role--warning",
  error: "tools-role--error",
};

function statusLabel(status: DependencyStatus): string {
  if (status.lifecycle === "absent") return "Not installed";
  if (status.lifecycle === "faulted") return "Needs repair";
  switch (status.currency) {
    case "current":
      return "Up to date";
    case "stale":
      return "Update available";
    case "check-failed":
      return "Update check failed";
    default:
      return "Installed (not checked)";
  }
}

// The acquire action is one operation (re-acquire the latest), but its label is
// context-aware per the managed-dependency-status convention so it reads right for
// the state: Install when absent, Repair when faulted, Update when a newer version
// is known, Reinstall otherwise.
function acquireLabel(status: DependencyStatus): string {
  if (status.lifecycle === "absent") return "Install";
  if (status.lifecycle === "faulted") return "Repair";
  if (status.currency === "stale") return "Update";
  return "Reinstall";
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
  checkToolUpdates,
  autoDownloadTools,
  isChecking,
  onVerify,
  onReinstall,
  onCheck,
  onSaveGates,
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
        <p id="audio-tools-description" className="panel__note">
          mumbler uses ffmpeg and ffprobe to read and trim audio. They are downloaded as native
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
              return (
                <tr key={status.name}>
                  <td className="tools-table__name">{status.name}</td>
                  <td>
                    <span className={ROLE_CLASS[status.role]}>{statusLabel(status)}</span>
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
                    ) : (
                      <span className="tools-table__actions">
                        <button
                          type="button"
                          className="button button--ghost button--compact"
                          onClick={() => onVerify(status.name)}
                          disabled={!status.canVerify}
                          title="Compare the installed file against its recorded checksum"
                        >
                          Verify
                        </button>
                        <button
                          type="button"
                          className={`button button--compact ${needsAttention ? "button--primary" : "button--ghost"}`}
                          onClick={() => onReinstall(status.name)}
                          title="Download and install a fresh copy"
                        >
                          {acquireLabel(status)}
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {dependencies
          .filter((status) => status.error !== null || status.transient.kind === "failed")
          .map((status) => {
            const message =
              status.transient.kind === "failed" ? status.transient.error : status.error;
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
              checked={checkToolUpdates || autoDownloadTools}
              disabled={autoDownloadTools}
              onChange={(event) => onSaveGates(event.target.checked, autoDownloadTools)}
            />
            <span>
              Check for tool updates on launch
              {autoDownloadTools ? " (required while auto-download is on)" : ""}
            </span>
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={autoDownloadTools}
              onChange={(event) => onSaveGates(checkToolUpdates, event.target.checked)}
            />
            <span>Download missing required tools automatically (shown in this window)</span>
          </label>
        </div>
      </div>
    </ModalShell>
  );
}
