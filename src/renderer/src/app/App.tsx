import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from "react";

import type {
  AppSnapshot,
  CardStatus,
  FailedImport,
  MumblerCard,
  PendingImportReviewItem,
  SaveCardResult,
  SettingsDraft,
  TrimDecision,
} from "@shared/app-shell";
import {
  getLocalTimestampError,
  getUtcTimestampError,
  isSupportedTimezone,
  recomputeLocalFromUtc,
  recomputeUtcFromLocal,
} from "@shared/timestamps";
import { WaveformEditor, type WaveformEditorHandle } from "./WaveformEditor";
import { SettingsModal } from "./SettingsModal";
import { findMatchingCommand, isTypingTarget } from "./shortcut-utils";

interface StatusChipProps {
  label: CardStatus;
}

function StatusChip({ label }: StatusChipProps): ReactElement {
  return <span className={`status-chip status-chip--${slugify(label)}`}>{label}</span>;
}

function slugify(value: string): string {
  return value.toLowerCase().replaceAll(" ", "-");
}

function statusModifier(status: CardStatus): string {
  return slugify(status);
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

function DecisionModal({
  title,
  body,
  actions,
}: {
  title: string;
  body: string;
  actions: Array<{
    label: string;
    onClick: () => void;
    variant?: "primary" | "danger" | "ghost";
  }>;
}): ReactElement {
  return (
    <div className="modal-backdrop">
      <section className="modal-card modal-card--narrow">
        <div className="modal-card__header">
          <div>
            <p className="section-kicker">Confirm</p>
            <h2>{title}</h2>
          </div>
        </div>
        <p className="empty-state__body">{body}</p>
        <div className="modal-actions">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={`button button--${action.variant ?? "ghost"}`}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function describeCardStep(card: MumblerCard): string {
  if (card.status === "Transcribing") {
    return "Gemini transcription in progress.";
  }

  if (card.status === "Generating Metadata") {
    if (card.activeStep === "title") {
      return "Generating title.";
    }
    if (card.activeStep === "slug") {
      return "Generating slug.";
    }
    return "Generating metadata.";
  }

  if (card.status === "Ready to Save") {
    return "Transcript and metadata are ready.";
  }

  if (card.status === "Error") {
    return card.lastError?.message ?? "Processing failed.";
  }

  return "Ready for transcription.";
}

function formatAiRun(
  run: MumblerCard["ai"]["transcription"] | MumblerCard["ai"]["title"] | MumblerCard["ai"]["slug"],
): string {
  if (run === null) {
    return "—";
  }

  return `${run.provider} · ${run.model}`;
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();

  const copied = document.execCommand("copy");
  textarea.remove();

  if (!copied) {
    throw new Error("Clipboard is not available.");
  }
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
          className={`queue-row queue-row--${statusModifier(card.status)}${card.id === selectedCardId ? " queue-row--selected" : ""}`}
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
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isConfirmingReview, setIsConfirmingReview] = useState(false);
  const [pendingReviewDrafts, setPendingReviewDrafts] = useState<PendingImportReviewItem[]>([]);
  const [importFailures, setImportFailures] = useState<FailedImport[]>([]);
  const [activePipelineCards, setActivePipelineCards] = useState<string[]>([]);
  const [pendingSaveConflict, setPendingSaveConflict] = useState<{
    cardId: string;
    result: Extract<SaveCardResult, { kind: "conflict" }>;
  } | null>(null);
  const [pendingRemoveCardId, setPendingRemoveCardId] = useState<string | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft | null>(null);
  const [isLoadingSettings, setIsLoadingSettings] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isPickingSettingsOutputDirectory, setIsPickingSettingsOutputDirectory] = useState(false);
  const [settingsErrorMessage, setSettingsErrorMessage] = useState<string | null>(null);
  const [isResettingState, setIsResettingState] = useState(false);
  const [pendingCloseConfirmation, setPendingCloseConfirmation] = useState(false);
  const waveformEditorRef = useRef<WaveformEditorHandle | null>(null);

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

  useEffect(() => {
    const currentState = snapshot?.state;
    if (pendingReviewDrafts.length === 0 || currentState == null) {
      return;
    }

    const persistedJson = JSON.stringify(currentState.pendingImports);
    const draftJson = JSON.stringify(pendingReviewDrafts);
    if (persistedJson === draftJson) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void window.mumbler
        .updatePendingImportDrafts(pendingReviewDrafts)
        .then((nextSnapshot) => {
          setSnapshot(nextSnapshot);
        })
        .catch((error: unknown) => {
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Failed to persist pending timestamp review edits.",
          );
        });
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [pendingReviewDrafts, snapshot?.state]);

  useEffect(() => {
    if (activePipelineCards.length === 0) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void window.mumbler
        .getSnapshot()
        .then((nextSnapshot) => {
          setSnapshot(nextSnapshot);
        })
        .catch((error: unknown) => {
          setErrorMessage(error instanceof Error ? error.message : "Failed to refresh card state.");
        });
    }, 800);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activePipelineCards]);

  useEffect(() => {
    return window.mumbler.onWindowCloseRequested(() => {
      setPendingCloseConfirmation(true);
    });
  }, []);

  useEffect(() => {
    return window.mumbler.onAppWideErrorChanged(() => {
      void window.mumbler
        .getSnapshot()
        .then((nextSnapshot) => {
          setSnapshot(nextSnapshot);
        })
        .catch((error: unknown) => {
          setErrorMessage(
            error instanceof Error ? error.message : "Failed to refresh app-wide error state.",
          );
        });
    });
  }, []);

  useEffect(() => {
    function reportRendererFault(message: string, source: string, stack?: string): void {
      void window.mumbler
        .reportRendererError({ message, source, stack })
        .then((nextSnapshot) => {
          setSnapshot(nextSnapshot);
        })
        .catch((error: unknown) => {
          setErrorMessage(
            error instanceof Error ? error.message : "Failed to report renderer error.",
          );
        });
    }

    function onWindowError(event: ErrorEvent): void {
      event.preventDefault();
      reportRendererFault(
        event.message || "Unknown renderer error.",
        event.filename || "window.onerror",
        event.error instanceof Error ? event.error.stack : undefined,
      );
    }

    function onUnhandledRejection(event: PromiseRejectionEvent): void {
      event.preventDefault();
      const reason =
        event.reason instanceof Error ? event.reason.message : String(event.reason ?? "Unknown promise rejection.");
      reportRendererFault(
        reason,
        "window.unhandledrejection",
        event.reason instanceof Error ? event.reason.stack : undefined,
      );
    }

    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    return () => {
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  const selectedCard =
    snapshot?.state?.cards.find((card) => card.id === snapshot.state?.selectedCardId) ?? null;
  const selectedCardIsBusy =
    selectedCard !== null &&
    (activePipelineCards.includes(selectedCard.id) ||
      selectedCard.status === "Transcribing" ||
      selectedCard.status === "Generating Metadata");
  const modalIsOpen =
    settingsDraft !== null ||
    pendingReviewDrafts.length > 0 ||
    pendingSaveConflict !== null ||
    pendingRemoveCardId !== null ||
    pendingCloseConfirmation ||
    snapshot?.startupDiagnostic != null ||
    snapshot?.appWideError != null;
  const languageOptions = useMemo(() => {
    const configuredLanguages = snapshot?.settingsSummary?.languages ?? [];
    if (selectedCard === null) {
      return configuredLanguages;
    }

    return configuredLanguages.includes(selectedCard.language)
      ? configuredLanguages
      : [selectedCard.language, ...configuredLanguages];
  }, [selectedCard, snapshot?.settingsSummary?.languages]);

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
      setNoticeMessage(null);
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
      setNoticeMessage(null);
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update trim.");
      throw error;
    }
  }

  function beginCardOperation(cardId: string): void {
    setActivePipelineCards((current) =>
      current.includes(cardId) ? current : [...current, cardId],
    );
  }

  function endCardOperation(cardId: string): void {
    setActivePipelineCards((current) => current.filter((value) => value !== cardId));
  }

  function handleTranscribeCard(cardId: string): void {
    beginCardOperation(cardId);
    void window.mumbler
      .transcribeCard(cardId)
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        setErrorMessage(null);
        setNoticeMessage(null);
      })
      .catch((error: unknown) => {
        setErrorMessage(error instanceof Error ? error.message : "Failed to transcribe card.");
      })
      .finally(() => {
        endCardOperation(cardId);
      });
  }

  function handleRetryCard(cardId: string): void {
    beginCardOperation(cardId);
    void window.mumbler
      .retryCard(cardId)
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        setErrorMessage(null);
        setNoticeMessage(null);
      })
      .catch((error: unknown) => {
        setErrorMessage(error instanceof Error ? error.message : "Failed to retry card.");
      })
      .finally(() => {
        endCardOperation(cardId);
      });
  }

  async function handleChooseOutputDirectory(): Promise<void> {
    try {
      const nextSnapshot = await window.mumbler.chooseOutputDirectory();
      setSnapshot(nextSnapshot);
      setErrorMessage(null);
      setNoticeMessage(
        nextSnapshot.settingsSummary?.outputDirectory
          ? `Output directory set to ${nextSnapshot.settingsSummary.outputDirectory}`
          : null,
      );
    } catch (error: unknown) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to choose output directory.",
      );
    }
  }

  async function handleOpenSettings(): Promise<void> {
    setIsLoadingSettings(true);
    try {
      const draft = await window.mumbler.getSettingsDraft();
      setSettingsDraft(draft);
      setSettingsErrorMessage(null);
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load settings.");
    } finally {
      setIsLoadingSettings(false);
    }
  }

  async function handlePickSettingsOutputDirectory(): Promise<void> {
    setIsPickingSettingsOutputDirectory(true);
    try {
      const nextPath = await window.mumbler.pickOutputDirectory();
      if (nextPath !== null) {
        setSettingsDraft((current) =>
          current === null
            ? current
            : {
                ...current,
                outputDirectory: nextPath,
              },
        );
      }
      setSettingsErrorMessage(null);
    } catch (error: unknown) {
      setSettingsErrorMessage(
        error instanceof Error ? error.message : "Failed to choose output directory.",
      );
    } finally {
      setIsPickingSettingsOutputDirectory(false);
    }
  }

  async function handleSaveSettings(): Promise<void> {
    if (settingsDraft === null) {
      return;
    }

    setIsSavingSettings(true);
    try {
      const nextSnapshot = await window.mumbler.saveSettingsDraft(settingsDraft);
      setSnapshot(nextSnapshot);
      setSettingsDraft(null);
      setSettingsErrorMessage(null);
      setNoticeMessage("Settings saved.");
      setErrorMessage(null);
    } catch (error: unknown) {
      setSettingsErrorMessage(error instanceof Error ? error.message : "Failed to save settings.");
    } finally {
      setIsSavingSettings(false);
    }
  }

  async function handleCardLanguageChange(cardId: string, language: string): Promise<void> {
    try {
      const nextSnapshot = await window.mumbler.updateCardLanguage(cardId, language);
      setSnapshot(nextSnapshot);
      setErrorMessage(null);
      setNoticeMessage(null);
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update card language.");
    }
  }

  async function handleCopyResult(label: string, value: string | null): Promise<void> {
    if (value === null || value.trim().length === 0) {
      return;
    }

    try {
      await copyTextToClipboard(value);
      setNoticeMessage(`${label} copied to clipboard.`);
      setErrorMessage(null);
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : `Failed to copy ${label}.`);
    }
  }

  async function handleDismissAppWideError(): Promise<void> {
    try {
      const nextSnapshot = await window.mumbler.dismissAppWideError();
      setSnapshot(nextSnapshot);
      setErrorMessage(null);
    } catch (error: unknown) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to dismiss app-wide error.",
      );
    }
  }

  async function handleResetState(): Promise<void> {
    setIsResettingState(true);
    try {
      const nextSnapshot = await window.mumbler.resetState();
      setSnapshot(nextSnapshot);
      setErrorMessage(null);
      setNoticeMessage("State and settings were reset to defaults.");
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to reset state.");
    } finally {
      setIsResettingState(false);
    }
  }

  async function handleShortcutCommand(commandId: string): Promise<void> {
    if (selectedCard === null) {
      if (commandId === "select-previous" || commandId === "select-next") {
        return;
      }
      return;
    }

    switch (commandId) {
      case "play-pause":
        await waveformEditorRef.current?.playPause();
        return;
      case "set-front-marker":
        if (!selectedCardIsBusy) {
          await waveformEditorRef.current?.setFrontMarkerAtCursor();
        }
        return;
      case "set-back-marker":
        if (!selectedCardIsBusy) {
          await waveformEditorRef.current?.setBackMarkerAtCursor();
        }
        return;
      case "play-first-snippet":
        await waveformEditorRef.current?.playFirstSnippet();
        return;
      case "play-last-snippet":
        await waveformEditorRef.current?.playLastSnippet();
        return;
      case "transcribe-selected":
        if (snapshot?.settingsSummary?.hasGeminiApiKey && !selectedCardIsBusy) {
          handleTranscribeCard(selectedCard.id);
        }
        return;
      case "save-selected":
        if (
          selectedCard.status === "Ready to Save" &&
          !selectedCardIsBusy &&
          snapshot?.settingsSummary?.outputDirectory
        ) {
          await handleSaveCard(selectedCard.id);
        }
        return;
      case "retry-selected":
        if (selectedCard.status === "Error" && !selectedCardIsBusy) {
          handleRetryCard(selectedCard.id);
        }
        return;
      case "remove-selected":
        if (!selectedCardIsBusy) {
          setPendingRemoveCardId(selectedCard.id);
        }
        return;
      case "select-previous":
      case "select-next": {
        const cards = snapshot?.state?.cards ?? [];
        const currentIndex = cards.findIndex((card) => card.id === selectedCard.id);
        if (currentIndex === -1) {
          return;
        }

        const delta = commandId === "select-previous" ? -1 : 1;
        const nextCard = cards[currentIndex + delta];
        if (nextCard) {
          await handleCardSelect(nextCard.id);
        }
        return;
      }
      default:
        return;
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const settingsSummary = snapshot?.settingsSummary;
      if (modalIsOpen || isTypingTarget(event.target) || settingsSummary == null) {
        return;
      }

      const commandId = findMatchingCommand(event, settingsSummary.shortcuts);
      if (commandId === null) {
        return;
      }

      event.preventDefault();
      void handleShortcutCommand(commandId);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [modalIsOpen, selectedCard, selectedCardIsBusy, snapshot]);

  async function handleSaveCard(
    cardId: string,
    resolution?: "overwrite" | "suffix" | "cancel",
  ): Promise<void> {
    try {
      const result = await window.mumbler.saveCard(cardId, resolution);
      setSnapshot(result.snapshot);
      setErrorMessage(null);

      if (result.kind === "conflict") {
        setPendingSaveConflict({ cardId, result });
        setNoticeMessage(null);
        return;
      }

      if (result.kind === "cancelled") {
        setPendingSaveConflict(null);
        return;
      }

      setPendingSaveConflict(null);
      setNoticeMessage(`Saved audio and metadata to ${result.audioPath}`);
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to save card.");
    }
  }

  async function confirmRemoveCard(cardId: string): Promise<void> {
    try {
      const nextSnapshot = await window.mumbler.removeCard(cardId);
      setSnapshot(nextSnapshot);
      setErrorMessage(null);
      setNoticeMessage("Removed card and moved its working audio to trash.");
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to remove card.");
    } finally {
      setPendingRemoveCardId(null);
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
          <span className="pill">Phase 13 Visual States</span>
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
              <button
                type="button"
                className="button button--ghost"
                onClick={() => void handleOpenSettings()}
                disabled={isImporting || isLoadingSettings}
              >
                {isLoadingSettings ? "Loading..." : "Settings"}
              </button>
            </div>
          </div>

          {errorMessage ? (
            <section className="panel panel--nested banner banner--error">
              <p className="empty-state__title">Error</p>
              <p className="empty-state__body">{errorMessage}</p>
            </section>
          ) : null}

          {noticeMessage ? (
            <section className="panel panel--nested banner banner--notice">
              <p className="empty-state__title">Notice</p>
              <p className="empty-state__body">{noticeMessage}</p>
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
              <div className="toolbar">
                <button
                  type="button"
                  className="button button--danger"
                  onClick={() => void handleResetState()}
                  disabled={isResettingState}
                >
                  {isResettingState ? "Resetting..." : "Reset State"}
                </button>
              </div>
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
              <div>
                <dt>Output directory</dt>
                <dd>{snapshot?.settingsSummary?.outputDirectory ?? "Not configured"}</dd>
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
              Phase 13 strengthens status-driven color cues in the queue and detail pane while
              keeping the existing trim, Gemini, save, and remove workflow intact.
            </p>
          </div>

          {selectedCard ? (
            <div className="detail-grid">
              <section className={`detail-card detail-card--status detail-card--${statusModifier(selectedCard.status)}`}>
                <div className="detail-card__header">
                  <h3>Identity</h3>
                  <StatusChip label={selectedCard.status} />
                </div>
                <div className={`status-summary status-summary--${statusModifier(selectedCard.status)}`}>
                  <strong>{selectedCard.status}</strong>
                  <span>{describeCardStep(selectedCard)}</span>
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
                  <h3>Language and Models</h3>
                  <span className="muted-tag">Per card language</span>
                </div>
                <div className="field-stack">
                  <label className="field">
                    <span>Language</span>
                    <select
                      value={selectedCard.language}
                      disabled={selectedCardIsBusy}
                      onChange={(event) =>
                        void handleCardLanguageChange(selectedCard.id, event.target.value)
                      }
                    >
                      {languageOptions.map((language) => (
                        <option key={language} value={language}>
                          {language}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <dl className="meta-list compact-meta-list">
                  <div>
                    <dt>Transcription model</dt>
                    <dd>{snapshot?.settingsSummary?.transcriptionModel ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Metadata model</dt>
                    <dd>{snapshot?.settingsSummary?.metadataModel ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Configured languages</dt>
                    <dd>{snapshot?.settingsSummary?.languageCount ?? "—"}</dd>
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
                  ref={waveformEditorRef}
                  card={selectedCard}
                  previewSnippetSeconds={snapshot?.settingsSummary?.previewSnippetSeconds ?? 10}
                  disabled={selectedCardIsBusy}
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

              <section className={`detail-card detail-card--wide detail-card--status detail-card--${statusModifier(selectedCard.status)}`}>
                <div className="detail-card__header">
                  <div>
                    <h3>Actions and Status</h3>
                    <p className="panel__note">{describeCardStep(selectedCard)}</p>
                  </div>
                  <span className="muted-tag">
                    {snapshot?.settingsSummary?.hasGeminiApiKey
                      ? "Gemini key configured"
                      : "Gemini key missing"}
                  </span>
                </div>
                <div className="action-grid">
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => void handleChooseOutputDirectory()}
                    disabled={selectedCardIsBusy}
                  >
                    Choose Output Directory
                  </button>
                  <button
                    type="button"
                    className="button button--primary"
                    onClick={() => handleTranscribeCard(selectedCard.id)}
                    disabled={!snapshot?.settingsSummary?.hasGeminiApiKey || selectedCardIsBusy}
                  >
                    {selectedCardIsBusy ? "Processing..." : "Transcribe"}
                  </button>
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => handleRetryCard(selectedCard.id)}
                    disabled={selectedCard.status !== "Error" || selectedCardIsBusy}
                  >
                    Retry Failed Step
                  </button>
                  <button
                    type="button"
                    className="button button--primary"
                    onClick={() => void handleSaveCard(selectedCard.id)}
                    disabled={
                      selectedCard.status !== "Ready to Save" ||
                      selectedCardIsBusy ||
                      snapshot?.settingsSummary?.outputDirectory == null
                    }
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="button button--danger"
                    onClick={() => setPendingRemoveCardId(selectedCard.id)}
                    disabled={selectedCardIsBusy}
                  >
                    Remove
                  </button>
                </div>
                <dl className="meta-list compact-meta-list">
                  <div>
                    <dt>Output directory</dt>
                    <dd>{snapshot?.settingsSummary?.outputDirectory ?? "Not configured"}</dd>
                  </div>
                  <div>
                    <dt>Gemini API key</dt>
                    <dd>
                      {snapshot?.settingsSummary?.hasGeminiApiKey ? "Configured" : "Missing"}
                    </dd>
                  </div>
                  <div>
                    <dt>Last failed step</dt>
                    <dd>{selectedCard.lastError?.failedStep ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Active step</dt>
                    <dd>{selectedCard.activeStep ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Language</dt>
                    <dd>{selectedCard.language}</dd>
                  </div>
                </dl>
              </section>

              <section className="detail-card detail-card--wide">
                <div className="detail-card__header">
                  <h3>Results</h3>
                  <span className="muted-tag">Read-only</span>
                </div>
                <div className="result-grid">
                  <label className="field">
                    <span className="field-label-with-action">
                      <span>Transcript</span>
                      <button
                        type="button"
                        className="button button--ghost button--compact"
                        onClick={() => void handleCopyResult("Transcript", selectedCard.transcription.text)}
                        disabled={(selectedCard.transcription.text ?? "").trim().length === 0}
                      >
                        Copy
                      </button>
                    </span>
                    <textarea
                      readOnly
                      className="result-output"
                      value={selectedCard.transcription.text ?? ""}
                      placeholder="Transcript will appear here."
                    />
                  </label>
                  <label className="field">
                    <span className="field-label-with-action">
                      <span>Title</span>
                      <button
                        type="button"
                        className="button button--ghost button--compact"
                        onClick={() => void handleCopyResult("Title", selectedCard.metadata.title)}
                        disabled={(selectedCard.metadata.title ?? "").trim().length === 0}
                      >
                        Copy
                      </button>
                    </span>
                    <textarea
                      readOnly
                      className="result-output"
                      value={selectedCard.metadata.title ?? ""}
                      placeholder="Generated title will appear here."
                    />
                  </label>
                  <label className="field">
                    <span className="field-label-with-action">
                      <span>Slug</span>
                      <button
                        type="button"
                        className="button button--ghost button--compact"
                        onClick={() => void handleCopyResult("Slug", selectedCard.metadata.slug)}
                        disabled={(selectedCard.metadata.slug ?? "").trim().length === 0}
                      >
                        Copy
                      </button>
                    </span>
                    <textarea
                      readOnly
                      className="result-output"
                      value={selectedCard.metadata.slug ?? ""}
                      placeholder="Generated slug will appear here."
                    />
                  </label>
                  <section className="detail-card detail-card--nested">
                    <div className="detail-card__header">
                      <h3>Provenance</h3>
                      <span className="muted-tag">Per artifact</span>
                    </div>
                    <dl className="meta-list compact-meta-list">
                      <div>
                        <dt>Transcript</dt>
                        <dd>{formatAiRun(selectedCard.ai.transcription)}</dd>
                      </div>
                      <div>
                        <dt>Title</dt>
                        <dd>{formatAiRun(selectedCard.ai.title)}</dd>
                      </div>
                      <div>
                        <dt>Slug</dt>
                        <dd>{formatAiRun(selectedCard.ai.slug)}</dd>
                      </div>
                    </dl>
                  </section>
                </div>
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

      {settingsDraft ? (
        <SettingsModal
          draft={settingsDraft}
          timezones={snapshot?.supportedTimezones ?? []}
          commands={snapshot?.commands ?? []}
          isSaving={isSavingSettings}
          isPickingOutputDirectory={isPickingSettingsOutputDirectory}
          errorMessage={settingsErrorMessage}
          onChange={setSettingsDraft}
          onClose={() => {
            setSettingsDraft(null);
            setSettingsErrorMessage(null);
          }}
          onPickOutputDirectory={() => void handlePickSettingsOutputDirectory()}
          onSave={() => void handleSaveSettings()}
        />
      ) : null}

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

      {pendingSaveConflict ? (
        <DecisionModal
          title="File Name Collision"
          body={`The destination already contains ${pendingSaveConflict.result.audioPath} or its matching JSON sidecar. You can add a nanoid suffix, overwrite the existing pair, or cancel.`}
          actions={[
            {
              label: "Add Nanoid Suffix",
              variant: "primary",
              onClick: () => {
                void handleSaveCard(pendingSaveConflict.cardId, "suffix");
              },
            },
            {
              label: "Overwrite Existing",
              variant: "danger",
              onClick: () => {
                void handleSaveCard(pendingSaveConflict.cardId, "overwrite");
              },
            },
            {
              label: "Cancel",
              onClick: () => {
                setPendingSaveConflict(null);
              },
            },
          ]}
        />
      ) : null}

      {snapshot?.appWideError ? (
        <DecisionModal
          title={snapshot.appWideError.title}
          body={snapshot.appWideError.message}
          actions={[
            {
              label: "Dismiss",
              variant: "primary",
              onClick: () => {
                void handleDismissAppWideError();
              },
            },
          ]}
        />
      ) : null}

      {pendingCloseConfirmation ? (
        <DecisionModal
          title="Close Mumbler"
          body="Close the app window now? In-progress work will be restored as interrupted errors on next launch."
          actions={[
            {
              label: "Close App",
              variant: "danger",
              onClick: () => {
                setPendingCloseConfirmation(false);
                void window.mumbler.respondToWindowClose(true);
              },
            },
            {
              label: "Cancel",
              onClick: () => {
                setPendingCloseConfirmation(false);
                void window.mumbler.respondToWindowClose(false);
              },
            },
          ]}
        />
      ) : null}

      {pendingRemoveCardId ? (
        <DecisionModal
          title="Remove Recording"
          body="This removes the card from the queue and moves its app-managed working audio to trash. The finalized output, if any, is not touched."
          actions={[
            {
              label: "Remove",
              variant: "danger",
              onClick: () => {
                void confirmRemoveCard(pendingRemoveCardId);
              },
            },
            {
              label: "Cancel",
              onClick: () => {
                setPendingRemoveCardId(null);
              },
            },
          ]}
        />
      ) : null}
    </div>
  );
}
