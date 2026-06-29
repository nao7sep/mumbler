import type { ReactElement } from "react";

import type { DependencyStatus, StatusRole, ToolName } from "@shared/app-shell";

import { ModalShell } from "./modal/ModalShell";

// The management surface for mumbler's audio tools (ffmpeg/ffprobe), per the
// managed-dependency-status-conventions: one named, dismissible surface listing
// every tool with its state, version facts, the offered operation, live progress,
// and per-tool error — rendered through the semantic role each row derives, with
// the concrete colour left to the theme.

export interface AudioToolsModalProps {
  dependencies: DependencyStatus[];
  checkToolUpdates: boolean;
  autoDownloadTools: boolean;
  isChecking: boolean;
  onProvision: (name: ToolName) => void;
  onUpdate: (name: ToolName) => void;
  onVerify: (name: ToolName) => void;
  onCheck: () => void;
  onSaveGates: (checkToolUpdates: boolean, autoDownloadTools: boolean) => void;
  onClose: () => void;
}

// Map the semantic role to a theme class — the convention assigns the role; the
// theme owns the colour.
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

function actionLabel(operation: DependencyStatus["operation"]): string {
  switch (operation) {
    case "provision":
      return "Install";
    case "update":
      return "Update";
    case "verify":
      return "Reinstall";
    case "check":
      return "Check";
    default:
      return "Reinstall";
  }
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
  onProvision,
  onUpdate,
  onVerify,
  onCheck,
  onSaveGates,
  onClose,
}: AudioToolsModalProps): ReactElement {
  function runOperation(status: DependencyStatus): void {
    switch (status.operation) {
      case "provision":
        onProvision(status.name);
        return;
      case "update":
        onUpdate(status.name);
        return;
      case "verify":
        onVerify(status.name);
        return;
      case "check":
        onCheck();
        return;
      default:
        return;
    }
  }

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
              <th aria-label="Action" />
            </tr>
          </thead>
          <tbody>
            {dependencies.map((status) => {
              const running = status.transient.kind === "running";
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
                      <button
                        type="button"
                        className={
                          status.role === "warning" || status.role === "error"
                            ? "button button--primary button--compact"
                            : "button button--ghost button--compact"
                        }
                        onClick={() => runOperation(status)}
                      >
                        {actionLabel(status.operation)}
                      </button>
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
          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={checkToolUpdates}
              onChange={(event) => onSaveGates(event.target.checked, autoDownloadTools)}
            />
            <span>Check for tool updates on launch</span>
          </label>
          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={autoDownloadTools}
              onChange={(event) => onSaveGates(checkToolUpdates, event.target.checked)}
            />
            <span>Download missing required tools automatically</span>
          </label>
        </div>
      </div>
    </ModalShell>
  );
}
