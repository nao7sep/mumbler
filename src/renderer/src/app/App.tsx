import { useEffect, useState, type ReactElement } from "react";

import type { AppBootstrap, CardStatus } from "@shared/app-shell";

interface StatusChipProps {
  label: CardStatus;
}

function StatusChip({ label }: StatusChipProps): ReactElement {
  return <span className={`status-chip status-chip--${slugify(label)}`}>{label}</span>;
}

function slugify(value: string): string {
  return value.toLowerCase().replaceAll(" ", "-");
}

const PREVIEW_STATUSES: CardStatus[] = [
  "Pending Review",
  "Imported",
  "Transcribing",
  "Generating Metadata",
  "Ready to Save",
  "Error",
];

export function App(): ReactElement {
  const [bootstrap, setBootstrap] = useState<AppBootstrap | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void window.mumbler
      .getBootstrap()
      .then((data: AppBootstrap) => {
        if (!cancelled) {
          setBootstrap(data);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setErrorMessage(
            error instanceof Error ? error.message : "Failed to load app bootstrap.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Desktop Audio Transcription</p>
          <h1>Mumbler</h1>
        </div>
        <div className="topbar__meta">
          <span className="pill">Phase 1 Shell</span>
          {bootstrap ? (
            <span className="pill pill--quiet">
              {bootstrap.appVersion} · {bootstrap.platform}
            </span>
          ) : (
            <span className="pill pill--quiet">Bootstrapping UI</span>
          )}
        </div>
      </header>

      <main className="workspace">
        <aside className="queue-pane panel">
          <div className="panel__header">
            <div>
              <p className="section-kicker">Queue</p>
              <h2>Incoming Recordings</h2>
            </div>
            <div className="toolbar">
              <button type="button" className="button button--primary">
                Import
              </button>
              <button type="button" className="button button--ghost">
                Settings
              </button>
            </div>
          </div>

          <section className="panel panel--nested queue-empty">
            <p className="empty-state__title">No recordings yet.</p>
            <p className="empty-state__body">
              Click Import or drop audio files here. Timestamp review, queue state,
              and destructive import handling arrive in Phase 3.
            </p>
          </section>

          <section className="panel panel--nested">
            <div className="status-legend">
              {PREVIEW_STATUSES.map((status) => (
                <StatusChip key={status} label={status} />
              ))}
            </div>
          </section>
        </aside>

        <section className="detail-pane panel">
          <div className="panel__header">
            <div>
              <p className="section-kicker">Detail</p>
              <h2>Selection Workspace</h2>
            </div>
            {errorMessage ? (
              <p className="inline-error">{errorMessage}</p>
            ) : (
              <p className="panel__note">
                This shell intentionally stops before import, trim, persistence, and
                Gemini work.
              </p>
            )}
          </div>

          <div className="detail-grid">
            <section className="detail-card">
              <div className="detail-card__header">
                <h3>Identity</h3>
                <span className="muted-tag">No selection</span>
              </div>
              <dl className="meta-list">
                <div>
                  <dt>Original filename</dt>
                  <dd>None</dd>
                </div>
                <div>
                  <dt>Effective timestamp</dt>
                  <dd>Select a card to inspect it.</dd>
                </div>
                <div>
                  <dt>Confirmed timestamp</dt>
                  <dd>Phase 3 will populate timestamp-reviewed cards.</dd>
                </div>
              </dl>
            </section>

            <section className="detail-card">
              <div className="detail-card__header">
                <h3>Language</h3>
                <span className="muted-tag">Per-card override</span>
              </div>
              <div className="field-stack">
                <label className="field">
                  <span>Language</span>
                  <select disabled defaultValue="">
                    <option value="">No queue item selected</option>
                  </select>
                </label>
              </div>
            </section>

            <section className="detail-card detail-card--wide">
              <div className="detail-card__header">
                <h3>Mini Player and Trim</h3>
                <span className="muted-tag">Phase 4</span>
              </div>
              <div className="waveform-placeholder">
                <div className="waveform-placeholder__mesh" />
                <div className="waveform-placeholder__markers">
                  <span>Front marker</span>
                  <span>Back marker</span>
                </div>
              </div>
              <div className="control-row">
                <button type="button" className="button button--ghost" disabled>
                  Play / Pause
                </button>
                <button type="button" className="button button--ghost" disabled>
                  Set Front Marker
                </button>
                <button type="button" className="button button--ghost" disabled>
                  Set Back Marker
                </button>
                <button type="button" className="button button--ghost" disabled>
                  Clear Markers
                </button>
              </div>
            </section>

            <section className="detail-card">
              <div className="detail-card__header">
                <h3>Actions</h3>
                <span className="muted-tag">Sequential per card</span>
              </div>
              <div className="action-grid">
                <button type="button" className="button button--primary" disabled>
                  Transcribe
                </button>
                <button type="button" className="button button--ghost" disabled>
                  Save
                </button>
                <button type="button" className="button button--ghost" disabled>
                  Regenerate Title
                </button>
                <button type="button" className="button button--ghost" disabled>
                  Regenerate Slug
                </button>
                <button type="button" className="button button--ghost" disabled>
                  Duplicate
                </button>
                <button type="button" className="button button--danger" disabled>
                  Remove
                </button>
              </div>
            </section>

            <section className="detail-card detail-card--wide">
              <div className="detail-card__header">
                <h3>Results</h3>
                <span className="muted-tag">Transcript, title, slug</span>
              </div>
              <div className="result-stack">
                <label className="field">
                  <span>Transcript</span>
                  <textarea
                    rows={5}
                    disabled
                    value="The transcript field appears here after Gemini transcription is wired in."
                    readOnly
                  />
                </label>
                <div className="result-grid">
                  <label className="field">
                    <span>Title</span>
                    <input
                      disabled
                      readOnly
                      value="Generated metadata will appear here."
                    />
                  </label>
                  <label className="field">
                    <span>Slug</span>
                    <input
                      disabled
                      readOnly
                      value="ready-to-save-output-name"
                    />
                  </label>
                </div>
              </div>
            </section>
          </div>
        </section>
      </main>
    </div>
  );
}
