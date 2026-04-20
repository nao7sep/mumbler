import { useEffect, useMemo, useState, type DragEvent, type ReactElement } from "react";

import type {
  AppSnapshot,
  CardStatus,
  FailedImport,
  MumblerCard,
  PendingImportReviewItem,
  TrimDecision,
} from "@shared/app-shell";
import {
  getLocalTimestampError,
  getUtcTimestampError,
  isSupportedTimezone,
  recomputeLocalFromUtc,
  recomputeUtcFromLocal,
} from "@shared/timestamps";
import { WaveformEditor } from "./WaveformEditor";

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
    return "Unknown";
  }

  const totalTenths = Math.round(value * 10);
  const totalSeconds = Math.floor(totalTenths / 10);
  const tenths = totalTenths % 10;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${tenths}`;
}

function formatOptionalSeconds(value: number | null): string {
  if (value === null) {
    return "—";
  }

  return `${value.toFixed(3)}s`;
}

function describeTrimDecision(decision: TrimDecision | null): string {
  if (decision === null) {
    return "Markers not analyzed yet.";
  }

  if (decision.kind === "not-needed") {
    return "No trim markers set.";
  }

  if (decision.kind === "stream-copy") {
    return "Boundaries found within tolerance. Stream copy is eligible.";
  }

  return "One or more boundaries fell outside tolerance. Re-encode will be required.";
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
            <strong>{card.timestamps.effectiveLocal}</strong>
            <StatusChip label={card.status} />
          </div>
          <div className="queue-row__name">{card.originalFilename}</div>
          <div className="queue-row__meta">
            <span>{formatDuration(card.durationSec)}</span>
            <span>{card.language}</span>
            <span>{card.audioProfile?.codecName ?? "Unknown codec"}</span>
          </div>
          <div className="queue-row__meta">
            <span>{card.timestamps.effectiveUtc}</span>
            <span>
              {card.timestamps.frontTrimOffsetSec > 0
                ? `Front trim +${card.timestamps.frontTrimOffsetSec.toFixed(1)}s`
                : "No front trim"}
            </span>
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
      setErrorMessage(null);
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
      setErrorMessage(null);
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
      setErrorMessage(null);
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
      setErrorMessage(null);
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : "Dropped import failed.");
    } finally {
      setIsImporting(false);
    }
  }

  async function handleDuplicateCard(cardId: string): Promise<void> {
    try {
      const nextSnapshot = await window.mumbler.duplicateCard(cardId);
      setSnapshot(nextSnapshot);
      setErrorMessage(null);
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to duplicate card.");
      throw error;
    }
  }

  async function handleTrimCommit(cardId: string, trim: MumblerCard["trim"]): Promise<void> {
    try {
      const nextSnapshot = await window.mumbler.updateCardTrim(cardId, trim);
      setSnapshot(nextSnapshot);
      setErrorMessage(null);
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update trim.");
      throw error;
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
          <span className="pill">Phase 4 Trim Workflow</span>
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
              <h3>Queue Snapshot</h3>
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
                <dt>Working directory</dt>
                <dd>{snapshot?.paths?.workingDir ?? "—"}</dd>
              </div>
              <div>
                <dt>Default timezone</dt>
                <dd>{snapshot?.settingsSummary?.defaultTimezone ?? "—"}</dd>
              </div>
              <div>
                <dt>Recovered interrupted cards</dt>
                <dd>{snapshot?.queueSummary?.recoveredInterruptedCards ?? "—"}</dd>
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
              Phase 4 adds the waveform player, marker editing, duplicate-card flow,
              front-trim timestamp shifting, and ffprobe-based trim decisions.
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
                    <dt>Effective local</dt>
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
                    <dt>Timezone</dt>
                    <dd>{selectedCard.timestamps.timezone}</dd>
                  </div>
                  <div>
                    <dt>Import source</dt>
                    <dd>{selectedCard.importSource}</dd>
                  </div>
                </dl>
              </section>

              <section className="detail-card">
                <div className="detail-card__header">
                  <h3>Audio Profile</h3>
                  <span className="muted-tag">Working source</span>
                </div>
                <dl className="meta-list">
                  <div>
                    <dt>Duration</dt>
                    <dd>{formatDuration(selectedCard.durationSec)}</dd>
                  </div>
                  <div>
                    <dt>Codec</dt>
                    <dd>{selectedCard.audioProfile?.codecName ?? "Unknown"}</dd>
                  </div>
                  <div>
                    <dt>Container</dt>
                    <dd>{selectedCard.audioProfile?.formatName ?? "Unknown"}</dd>
                  </div>
                  <div>
                    <dt>Bitrate</dt>
                    <dd>
                      {selectedCard.audioProfile?.bitRateKbps == null
                        ? "Unknown"
                        : `${selectedCard.audioProfile.bitRateKbps} kbps`}
                    </dd>
                  </div>
                  <div>
                    <dt>Sample rate</dt>
                    <dd>
                      {selectedCard.audioProfile?.sampleRateHz == null
                        ? "Unknown"
                        : `${selectedCard.audioProfile.sampleRateHz} Hz`}
                    </dd>
                  </div>
                  <div>
                    <dt>Channels</dt>
                    <dd>{selectedCard.audioProfile?.channels ?? "Unknown"}</dd>
                  </div>
                  <div>
                    <dt>Front trim offset</dt>
                    <dd>{selectedCard.timestamps.frontTrimOffsetSec.toFixed(1)}s</dd>
                  </div>
                  <div>
                    <dt>File size</dt>
                    <dd>{formatBytes(selectedCard.fileSizeBytes)}</dd>
                  </div>
                </dl>
              </section>

              <section className="detail-card detail-card--wide">
                <div className="detail-card__header">
                  <div>
                    <h3>Mini Player and Trim</h3>
                    <p className="panel__note">
                      Set markers only after listening. Front trim never moves forward past the requested cut;
                      back trim never moves backward before it.
                    </p>
                  </div>
                  <span className="muted-tag">Trim first, then transcribe</span>
                </div>
                <WaveformEditor
                  card={selectedCard}
                  previewSnippetSeconds={snapshot?.settingsSummary?.previewSnippetSeconds ?? 10}
                  onDuplicateCard={handleDuplicateCard}
                  onTrimCommit={handleTrimCommit}
                  onError={(message) => setErrorMessage(message)}
                />
              </section>

              <section className="detail-card detail-card--wide">
                <div className="detail-card__header">
                  <h3>Trim Analysis</h3>
                  <span className="muted-tag">
                    {selectedCard.trimDecision?.kind ?? "not-analyzed"}
                  </span>
                </div>
                <p className="panel__note">{describeTrimDecision(selectedCard.trimDecision)}</p>
                <dl className="meta-list">
                  <div>
                    <dt>Requested start</dt>
                    <dd>{formatOptionalSeconds(selectedCard.trimDecision?.requestedStartSec ?? null)}</dd>
                  </div>
                  <div>
                    <dt>Requested end</dt>
                    <dd>{formatOptionalSeconds(selectedCard.trimDecision?.requestedEndSec ?? null)}</dd>
                  </div>
                  <div>
                    <dt>Start search window</dt>
                    <dd>
                      {selectedCard.trimDecision?.searchStartFromSec === null
                        ? "—"
                        : `${formatOptionalSeconds(selectedCard.trimDecision?.searchStartFromSec ?? null)} to ${formatOptionalSeconds(selectedCard.trimDecision?.searchStartToSec ?? null)}`}
                    </dd>
                  </div>
                  <div>
                    <dt>End search window</dt>
                    <dd>
                      {selectedCard.trimDecision?.searchEndFromSec === null
                        ? "—"
                        : `${formatOptionalSeconds(selectedCard.trimDecision?.searchEndFromSec ?? null)} to ${formatOptionalSeconds(selectedCard.trimDecision?.searchEndToSec ?? null)}`}
                    </dd>
                  </div>
                  <div>
                    <dt>Chosen start boundary</dt>
                    <dd>{formatOptionalSeconds(selectedCard.trimDecision?.chosenStartBoundarySec ?? null)}</dd>
                  </div>
                  <div>
                    <dt>Chosen end boundary</dt>
                    <dd>{formatOptionalSeconds(selectedCard.trimDecision?.chosenEndBoundarySec ?? null)}</dd>
                  </div>
                  <div>
                    <dt>Start delta</dt>
                    <dd>{formatOptionalSeconds(selectedCard.trimDecision?.startDeltaSec ?? null)}</dd>
                  </div>
                  <div>
                    <dt>End delta</dt>
                    <dd>{formatOptionalSeconds(selectedCard.trimDecision?.endDeltaSec ?? null)}</dd>
                  </div>
                  <div>
                    <dt>Reason</dt>
                    <dd>{selectedCard.trimDecision?.reason ?? "No markers set yet."}</dd>
                  </div>
                </dl>
              </section>

              <section className="detail-card detail-card--wide">
                <div className="detail-card__header">
                  <h3>Next Pipeline Steps</h3>
                  <span className="muted-tag">Phase 5</span>
                </div>
                <p className="panel__note">
                  Gemini transcription, title generation, slug generation, retries, and status transitions come next.
                  This phase is focused on listening, splitting, and validating trim decisions.
                </p>
              </section>
            </div>
          ) : snapshot?.state?.cards.length ? (
            <section className="panel panel--nested queue-empty">
              <p className="empty-state__title">Select a recording.</p>
              <p className="empty-state__body">
                Pick a queue item to inspect its waveform, adjust trim markers, or duplicate it for a second extract.
              </p>
            </section>
          ) : (
            <section className="panel panel--nested queue-empty">
              <p className="empty-state__title">No queue item selected.</p>
              <p className="empty-state__body">
                Import recordings first. After timestamp review they will appear here for playback and trimming.
              </p>
            </section>
          )}
        </section>
      </main>

      {pendingReviewDrafts.length > 0 ? (
        <TimestampReviewModal
          items={pendingReviewDrafts}
          timezones={snapshot?.supportedTimezones ?? []}
          onChange={(updatedItem) =>
            setPendingReviewDrafts((current) =>
              current.map((item) => (item.id === updatedItem.id ? updatedItem : item)),
            )
          }
          onApplyTimezoneToAll={(timezone) =>
            setPendingReviewDrafts((current) =>
              current.map((item) => {
                const localError = getLocalTimestampError(item.localTimestampText);
                const utcError = getUtcTimestampError(item.utcTimestampText);

                if (localError === null) {
                  const utcResult = recomputeUtcFromLocal(item.localTimestampText, timezone);
                  return {
                    ...item,
                    timezone,
                    utcTimestampText:
                      utcResult.error === null ? utcResult.utcTimestampText : item.utcTimestampText,
                  };
                }

                if (utcError === null) {
                  const localResult = recomputeLocalFromUtc(item.utcTimestampText, timezone);
                  return {
                    ...item,
                    timezone,
                    localTimestampText:
                      localResult.error === null ? localResult.localTimestampText : item.localTimestampText,
                  };
                }

                return { ...item, timezone };
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
