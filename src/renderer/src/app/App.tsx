import {
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type ReactElement,
} from "react";

import type {
  AppSnapshot,
  CardStatus,
  CommandDefinition,
  FailedImport,
  MumblerCard,
  PendingImportReviewItem,
} from "@shared/app-shell";
import {
  getLocalTimestampError,
  getUtcTimestampError,
  isSupportedTimezone,
  recomputeLocalFromUtc,
  recomputeUtcFromLocal,
} from "@shared/timestamps";

interface StatusChipProps {
  label: CardStatus;
}

function StatusChip({ label }: StatusChipProps): ReactElement {
  return <span className={`status-chip status-chip--${slugify(label)}`}>{label}</span>;
}

function slugify(value: string): string {
  return value.toLowerCase().replaceAll(" ", "-");
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDuration(value: number | null): string {
  if (value === null) {
    return "Unknown duration";
  }

  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function ShortcutList({ commands }: { commands: CommandDefinition[] }): ReactElement {
  return (
    <div className="shortcut-list">
      {commands.map((command) => (
        <div key={command.id} className="shortcut-item">
          <span>{command.label}</span>
          <kbd>{command.defaultShortcut}</kbd>
        </div>
      ))}
    </div>
  );
}

function QueueList({
  cards,
  selectedCardId,
  onSelect,
}: {
  cards: MumblerCard[];
  selectedCardId: string | null;
  onSelect: (cardId: string) => void;
}): ReactElement {
  return (
    <div className="queue-list">
      {cards.map((card) => (
        <button
          key={card.id}
          type="button"
          className={`queue-row${card.id === selectedCardId ? " queue-row--selected" : ""}`}
          onClick={() => onSelect(card.id)}
        >
          <div className="queue-row__top">
            <strong>{card.timestamps.effectiveUtc}</strong>
            <StatusChip label={card.status} />
          </div>
          <div className="queue-row__name">{card.originalFilename}</div>
          <div className="queue-row__meta">
            <span>{formatDuration(card.durationSec)}</span>
            <span>{card.language}</span>
            <span>{formatBytes(card.fileSizeBytes)}</span>
          </div>
          {card.lastError ? (
            <div className="queue-row__error">{card.lastError.message}</div>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function TimestampReviewModal({
  items,
  timezones,
  onChange,
  onApplyTimezoneToAll,
  onConfirm,
  isSubmitting,
}: {
  items: PendingImportReviewItem[];
  timezones: string[];
  onChange: (item: PendingImportReviewItem) => void;
  onApplyTimezoneToAll: (timezone: string) => void;
  onConfirm: () => void;
  isSubmitting: boolean;
}): ReactElement {
  const [bulkTimezone, setBulkTimezone] = useState("");

  const validationErrors = useMemo(
    () =>
      items.map((item) => {
        const timezoneError = isSupportedTimezone(item.timezone)
          ? null
          : "Enter a valid IANA timezone.";
        return (
          timezoneError ??
          getLocalTimestampError(item.localTimestampText) ??
          getUtcTimestampError(item.utcTimestampText)
        );
      }),
    [items],
  );

  const isConfirmDisabled = validationErrors.some((error) => error !== null);

  return (
    <div className="modal-backdrop">
      <section className="modal-card">
        <div className="modal-card__header">
          <div>
            <p className="section-kicker">Timestamp Review</p>
            <h2>Confirm Imported Timestamps</h2>
          </div>
          <span className="muted-tag">{items.length} pending</span>
        </div>

        <div className="modal-toolbar">
          <label className="field">
            <span>Set all timezones to</span>
            <input
              list="timezone-options"
              value={bulkTimezone}
              onChange={(event) => setBulkTimezone(event.target.value)}
              placeholder="Asia/Tokyo"
            />
          </label>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => onApplyTimezoneToAll(bulkTimezone)}
            disabled={bulkTimezone.trim().length === 0}
          >
            Apply to All
          </button>
        </div>

        <div className="review-table">
          {items.map((item, index) => {
            const timezoneError = isSupportedTimezone(item.timezone)
              ? null
              : "Enter a valid IANA timezone.";
            const localError = getLocalTimestampError(item.localTimestampText);
            const utcError = getUtcTimestampError(item.utcTimestampText);
            const rowError = timezoneError ?? localError ?? utcError;

            return (
              <div key={item.id} className="review-row">
                <div className="review-row__title">
                  <strong>{item.originalFilename}</strong>
                  <span className="muted-tag">
                    {item.parseStatus === "parsed" ? "Parsed" : "Manual"}
                  </span>
                </div>
                <div className="review-row__fields">
                  <label className="field">
                    <span>Local timestamp</span>
                    <input
                      value={item.localTimestampText}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        const utcResult = recomputeUtcFromLocal(nextValue, item.timezone);
                        onChange({
                          ...item,
                          localTimestampText: nextValue,
                          utcTimestampText:
                            utcResult.error === null ? utcResult.utcTimestampText : item.utcTimestampText,
                        });
                      }}
                    />
                  </label>
                  <label className="field">
                    <span>Timezone</span>
                    <input
                      list="timezone-options"
                      value={item.timezone}
                      onChange={(event) => {
                        const timezone = event.target.value;
                        if (getLocalTimestampError(item.localTimestampText) === null) {
                          const utcResult = recomputeUtcFromLocal(item.localTimestampText, timezone);
                          onChange({
                            ...item,
                            timezone,
                            utcTimestampText:
                              utcResult.error === null ? utcResult.utcTimestampText : item.utcTimestampText,
                          });
                          return;
                        }

                        if (getUtcTimestampError(item.utcTimestampText) === null) {
                          const localResult = recomputeLocalFromUtc(item.utcTimestampText, timezone);
                          onChange({
                            ...item,
                            timezone,
                            localTimestampText:
                              localResult.error === null ? localResult.localTimestampText : item.localTimestampText,
                          });
                          return;
                        }

                        onChange({ ...item, timezone });
                      }}
                    />
                  </label>
                  <label className="field">
                    <span>UTC timestamp</span>
                    <input
                      value={item.utcTimestampText}
                      onChange={(event) => {
                        const nextValue = event.target.value.toLowerCase();
                        const localResult = recomputeLocalFromUtc(nextValue, item.timezone);
                        onChange({
                          ...item,
                          utcTimestampText: nextValue,
                          localTimestampText:
                            localResult.error === null ? localResult.localTimestampText : item.localTimestampText,
                        });
                      }}
                    />
                  </label>
                </div>
                <div className="review-row__footer">
                  <span className="review-row__index">#{index + 1}</span>
                  {rowError ? <span className="row-error">{rowError}</span> : null}
                </div>
              </div>
            );
          })}
        </div>

        <div className="modal-actions">
          <button
            type="button"
            className="button button--primary"
            onClick={onConfirm}
            disabled={isConfirmDisabled || isSubmitting}
          >
            {isSubmitting ? "Confirming..." : "Confirm and Add to Queue"}
          </button>
        </div>

        <datalist id="timezone-options">
          {timezones.map((timezone) => (
            <option key={timezone} value={timezone} />
          ))}
        </datalist>
      </section>
    </div>
  );
}

export function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isConfirmingReview, setIsConfirmingReview] = useState(false);
  const [pendingReviewDrafts, setPendingReviewDrafts] = useState<PendingImportReviewItem[]>([]);
  const [importFailures, setImportFailures] = useState<FailedImport[]>([]);

  useEffect(() => {
    let cancelled = false;

    void window.mumbler
      .getSnapshot()
      .then((data) => {
        if (!cancelled) {
          setSnapshot(data);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setErrorMessage(
            error instanceof Error ? error.message : "Failed to load app snapshot.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setPendingReviewDrafts(snapshot?.state?.pendingImports ?? []);
  }, [snapshot?.state?.pendingImports]);

  const selectedCard =
    snapshot?.state?.cards.find((card) => card.id === snapshot.state?.selectedCardId) ?? null;

  async function handleImportClick(): Promise<void> {
    setIsImporting(true);
    try {
      const result = await window.mumbler.openImportDialog();
      setSnapshot(result.snapshot);
      setImportFailures(result.failedImports);
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setIsImporting(false);
    }
  }

  async function handleCardSelect(cardId: string): Promise<void> {
    try {
      const nextSnapshot = await window.mumbler.selectCard(cardId);
      setSnapshot(nextSnapshot);
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to select card.");
    }
  }

  async function handleConfirmPendingImports(): Promise<void> {
    setIsConfirmingReview(true);
    try {
      const nextSnapshot = await window.mumbler.confirmPendingImports(pendingReviewDrafts);
      setSnapshot(nextSnapshot);
      setImportFailures([]);
    } catch (error: unknown) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to confirm imported timestamps.",
      );
    } finally {
      setIsConfirmingReview(false);
    }
  }

  async function handleDroppedPaths(paths: string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }

    setIsImporting(true);
    try {
      const result = await window.mumbler.importDroppedPaths(paths);
      setSnapshot(result.snapshot);
      setImportFailures(result.failedImports);
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : "Dropped import failed.");
    } finally {
      setIsImporting(false);
    }
  }

  function onDragOver(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    setIsDragActive(true);
  }

  function onDragLeave(event: DragEvent<HTMLElement>): void {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setIsDragActive(false);
  }

  function onDrop(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    setIsDragActive(false);

    const paths = Array.from(event.dataTransfer.files)
      .map((file) => (file as File & { path?: string }).path ?? "")
      .filter((value) => value.length > 0);

    void handleDroppedPaths(paths);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Desktop Audio Transcription</p>
          <h1>Mumbler</h1>
        </div>
        <div className="topbar__meta">
          <span className="pill">Phase 3 Import Flow</span>
          {snapshot ? (
            <span className="pill pill--quiet">
              {snapshot.appVersion} · {snapshot.platform}
            </span>
          ) : (
            <span className="pill pill--quiet">Bootstrapping UI</span>
          )}
        </div>
      </header>

      <main
        className={`workspace${isDragActive ? " workspace--drag-active" : ""}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <aside className="queue-pane panel">
          <div className="panel__header">
            <div>
              <p className="section-kicker">Queue</p>
              <h2>Incoming Recordings</h2>
            </div>
            <div className="toolbar">
              <button
                type="button"
                className="button button--primary"
                onClick={() => void handleImportClick()}
                disabled={isImporting}
              >
                {isImporting ? "Importing..." : "Import"}
              </button>
              <button type="button" className="button button--ghost" disabled>
                Settings
              </button>
            </div>
          </div>

          {errorMessage ? (
            <section className="panel panel--nested banner banner--error">
              <p className="empty-state__title">Error</p>
              <p className="empty-state__body">{errorMessage}</p>
            </section>
          ) : null}

          {importFailures.length > 0 ? (
            <section className="panel panel--nested banner banner--warning">
              <p className="empty-state__title">Some imports failed.</p>
              <div className="failure-list">
                {importFailures.map((failure) => (
                  <p key={`${failure.sourcePath}:${failure.message}`}>
                    <strong>{failure.sourcePath}</strong>
                    <span>{failure.message}</span>
                  </p>
                ))}
              </div>
            </section>
          ) : null}

          {snapshot?.startupDiagnostic ? (
            <section className="panel panel--nested queue-empty">
              <p className="empty-state__title">{snapshot.startupDiagnostic.title}</p>
              <p className="empty-state__body">{snapshot.startupDiagnostic.message}</p>
            </section>
          ) : snapshot?.state?.cards.length ? (
            <QueueList
              cards={snapshot.state.cards}
              selectedCardId={snapshot.state.selectedCardId}
              onSelect={(cardId) => void handleCardSelect(cardId)}
            />
          ) : (
            <section className="panel panel--nested queue-empty">
              <p className="empty-state__title">
                {snapshot?.state?.pendingImports.length
                  ? "Pending timestamp review."
                  : "No recordings yet."}
              </p>
              <p className="empty-state__body">
                {snapshot?.state?.pendingImports.length
                  ? "Imported files are waiting for timestamp confirmation before they enter the queue."
                  : "Click Import or drop audio files here. Imported files are copied into working storage, then the outside originals are moved to trash."}
              </p>
            </section>
          )}

          <section className="panel panel--nested">
            <div className="detail-card__header">
              <h3>Startup Snapshot</h3>
              {snapshot?.queueSummary ? (
                <span className="muted-tag">
                  {snapshot.queueSummary.cardCount} cards · {snapshot.queueSummary.pendingImportCount} pending
                </span>
              ) : (
                <span className="muted-tag">Unavailable</span>
              )}
            </div>
            <dl className="meta-list compact-meta-list">
              <div>
                <dt>Recovered interrupted cards</dt>
                <dd>{snapshot?.queueSummary?.recoveredInterruptedCards ?? "—"}</dd>
              </div>
              <div>
                <dt>Default timezone</dt>
                <dd>{snapshot?.settingsSummary?.defaultTimezone ?? "—"}</dd>
              </div>
              <div>
                <dt>Gemini API key</dt>
                <dd>
                  {snapshot?.settingsSummary?.hasGeminiApiKey
                    ? "Configured"
                    : "Not configured"}
                </dd>
              </div>
            </dl>
          </section>
        </aside>

        <section className="detail-pane panel">
          <div className="panel__header">
            <div>
              <p className="section-kicker">Detail</p>
              <h2>Selection Workspace</h2>
            </div>
            <p className="panel__note">
              Phase 3 now handles destructive import, pending timestamp review, queue
              selection, and persisted queue state. Trim, ffmpeg, and Gemini still come
              later.
            </p>
          </div>

          {selectedCard ? (
            <div className="detail-grid">
              <section className="detail-card">
                <div className="detail-card__header">
                  <h3>Identity</h3>
                  <StatusChip label={selectedCard.status} />
                </div>
                <dl className="meta-list">
                  <div>
                    <dt>Original filename</dt>
                    <dd>{selectedCard.originalFilename}</dd>
                  </div>
                  <div>
                    <dt>Effective timestamp</dt>
                    <dd>{selectedCard.timestamps.effectiveLocal}</dd>
                  </div>
                  <div>
                    <dt>Effective UTC</dt>
                    <dd>{selectedCard.timestamps.effectiveUtc}</dd>
                  </div>
                  <div>
                    <dt>Confirmed local</dt>
                    <dd>{selectedCard.timestamps.confirmedLocal}</dd>
                  </div>
                  <div>
                    <dt>Confirmed UTC</dt>
                    <dd>{selectedCard.timestamps.confirmedUtc}</dd>
                  </div>
                  <div>
                    <dt>File size</dt>
                    <dd>{formatBytes(selectedCard.fileSizeBytes)}</dd>
                  </div>
                </dl>
              </section>

              <section className="detail-card">
                <div className="detail-card__header">
                  <h3>Language</h3>
                  <span className="muted-tag">Per-card override arrives next</span>
                </div>
                <div className="field-stack">
                  <label className="field">
                    <span>Language</span>
                    <select disabled value={selectedCard.language} onChange={() => undefined}>
                      <option value={selectedCard.language}>{selectedCard.language}</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Timezone</span>
                    <input disabled readOnly value={selectedCard.timestamps.timezone} />
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
                  <span className="muted-tag">Transcription comes later</span>
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
                  <h3>Storage and Defaults</h3>
                  <span className="muted-tag">Paths are now real</span>
                </div>
                <div className="storage-grid">
                  <label className="field">
                    <span>Settings file</span>
                    <input
                      disabled
                      readOnly
                      value={snapshot?.paths?.settingsPath ?? "Unavailable"}
                    />
                  </label>
                  <label className="field">
                    <span>State file</span>
                    <input
                      disabled
                      readOnly
                      value={snapshot?.paths?.statePath ?? "Unavailable"}
                    />
                  </label>
                  <label className="field">
                    <span>Logs directory</span>
                    <input
                      disabled
                      readOnly
                      value={snapshot?.paths?.logsDir ?? "Unavailable"}
                    />
                  </label>
                  <label className="field">
                    <span>Working directory</span>
                    <input
                      disabled
                      readOnly
                      value={snapshot?.paths?.workingDir ?? "Unavailable"}
                    />
                  </label>
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
                    <textarea rows={5} disabled readOnly value="Transcription not wired yet." />
                  </label>
                  <div className="result-grid">
                    <label className="field">
                      <span>Title</span>
                      <input disabled readOnly value="Pending Gemini pipeline" />
                    </label>
                    <label className="field">
                      <span>Slug</span>
                      <input disabled readOnly value="pending-gemini-pipeline" />
                    </label>
                  </div>
                </div>
              </section>
            </div>
          ) : (
            <section className="panel panel--nested queue-empty">
              <p className="empty-state__title">
                {snapshot?.state?.cards.length
                  ? "Select a recording from the list to view details."
                  : "No card selected."}
              </p>
              <p className="empty-state__body">
                {snapshot?.state?.cards.length
                  ? "The queue is now live. Timestamp-confirmed cards appear on the left."
                  : "Imported files enter the queue after timestamp confirmation."}
              </p>
            </section>
          )}

          <section className="detail-card detail-card--wide">
            <div className="detail-card__header">
              <h3>Command Registry</h3>
              <span className="muted-tag">Central default shortcuts</span>
            </div>
            <ShortcutList commands={snapshot?.commands ?? []} />
          </section>
        </section>
      </main>

      {pendingReviewDrafts.length > 0 ? (
        <TimestampReviewModal
          items={pendingReviewDrafts}
          timezones={snapshot?.supportedTimezones ?? []}
          onChange={(item) =>
            setPendingReviewDrafts((current) =>
              current.map((entry) => (entry.id === item.id ? item : entry)),
            )
          }
          onApplyTimezoneToAll={(timezone) =>
            setPendingReviewDrafts((current) =>
              current.map((entry) => {
                if (getLocalTimestampError(entry.localTimestampText) === null) {
                  const utcResult = recomputeUtcFromLocal(entry.localTimestampText, timezone);
                  return {
                    ...entry,
                    timezone,
                    utcTimestampText:
                      utcResult.error === null ? utcResult.utcTimestampText : entry.utcTimestampText,
                  };
                }

                if (getUtcTimestampError(entry.utcTimestampText) === null) {
                  const localResult = recomputeLocalFromUtc(entry.utcTimestampText, timezone);
                  return {
                    ...entry,
                    timezone,
                    localTimestampText:
                      localResult.error === null ? localResult.localTimestampText : entry.localTimestampText,
                  };
                }

                return {
                  ...entry,
                  timezone,
                };
              }),
            )
          }
          onConfirm={() => void handleConfirmPendingImports()}
          isSubmitting={isConfirmingReview}
        />
      ) : null}
    </div>
  );
}
