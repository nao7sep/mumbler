import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";

import type {
  AppSnapshot,
  MumblerCard,
  PendingImportReviewItem,
  SaveCardResult,
  TrimDecision,
} from "@shared/app-shell";
import { GEMINI_MODELS } from "@shared/app-shell";
import {
  formatUtcForDisplay,
  getLocalTimestampError,
  getUtcTimestampError,
  recomputeLocalFromUtc,
  recomputeUtcFromLocal,
} from "@shared/timestamps";

import { WaveformEditor, type WaveformEditorHandle } from "./WaveformEditor";
import { SettingsModal } from "./SettingsModal";
import { findMatchingCommand, isTypingTarget } from "./shortcut-utils";
import { TimestampReviewModal } from "./TimestampReviewModal";
import { QueueList, formatBytes, formatDuration, statusModifier } from "./QueueList";
import { DecisionModal } from "./DecisionModal";
import { AboutModal } from "./AboutModal";
import { ShortcutsHelpModal } from "./ShortcutsHelpModal";
import { useImportFlow } from "./useImportFlow";
import { useSettingsModal } from "./useSettingsModal";

function formatOptionalSeconds(value: number | null): string {
  if (value === null) {
    return "—";
  }

  return `${value.toFixed(3)}s`;
}

function describeTrimDecision(decision: TrimDecision | null): string {
  if (decision === null) {
    return "Not analyzed.";
  }

  if (decision.kind === "not-needed") {
    return "No markers set.";
  }

  if (decision.kind === "stream-copy") {
    return "Stream copy eligible.";
  }

  return "Re-encode required.";
}

function getTranscribeDisabledReason(params: {
  selectedCard: MumblerCard | null;
  hasGeminiKey: boolean;
  selectedCardIsBusy: boolean;
}): string | null {
  if (params.selectedCard === null) {
    return null;
  }

  if (!params.hasGeminiKey) {
    return "Gemini API key not configured.";
  }

  if (params.selectedCardIsBusy) {
    return "Processing.";
  }

  return null;
}

function getSaveDisabledReason(params: {
  selectedCard: MumblerCard | null;
  outputDirectory: string | null | undefined;
  selectedCardIsBusy: boolean;
}): string | null {
  if (params.selectedCard === null) {
    return null;
  }

  if (params.selectedCard.status !== "Ready to Save") {
    return "Not ready to save.";
  }

  if (params.selectedCardIsBusy) {
    return "Processing.";
  }

  if (params.outputDirectory == null || params.outputDirectory.trim().length === 0) {
    return "No output directory.";
  }

  return null;
}

function getRemoveConfirmBody(card: MumblerCard): string {
  const hasAiWork =
    (card.transcription.text ?? "").trim().length > 0 ||
    (card.metadata.title ?? "").trim().length > 0 ||
    (card.metadata.slug ?? "").trim().length > 0;

  if (hasAiWork) {
    return "This recording has been processed by AI. Removing it will permanently discard the transcript and generated metadata. Working audio will be moved to trash.";
  }

  const hasTrimWork =
    card.trim.frontMarkerSec !== null || card.trim.backMarkerSec !== null;

  if (hasTrimWork) {
    return "You've set trim markers on this recording. Removing it will discard that work. Working audio will be moved to trash.";
  }

  return "Working audio will be moved to trash. Saved output is not affected.";
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

interface AppNotification {
  id: string;
  message: string;
  kind: "toast" | "persistent";
  variant: "info" | "error";
}

export function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const snapshotRef = useRef<AppSnapshot | null>(null);

  const addToast = useCallback((message: string, variant: AppNotification["variant"] = "info") => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setNotifications(prev => [...prev, { id, message, kind: "toast", variant }]);
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 4000);
  }, []);

  const addPersistent = useCallback((message: string, variant: AppNotification["variant"] = "info") => {
    const id = `p-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setNotifications(prev => [...prev, { id, message, kind: "persistent", variant }]);
  }, []);

  const dismissNotification = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);
  const [activePipelineCards, setActivePipelineCards] = useState<string[]>([]);
  const [pendingSaveConflict, setPendingSaveConflict] = useState<{
    cardId: string;
    result: Extract<SaveCardResult, { kind: "conflict" }>;
  } | null>(null);
  const [pendingRemoveCardId, setPendingRemoveCardId] = useState<string | null>(null);
  const [isResettingState, setIsResettingState] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [showReviewDiscardConfirm, setShowReviewDiscardConfirm] = useState(false);
  const initialReviewDraftsRef = useRef<PendingImportReviewItem[] | null>(null);
  const waveformEditorRef = useRef<WaveformEditorHandle | null>(null);

  const importFlow = useImportFlow({
    snapshot,
    onSnapshotUpdate: setSnapshot,
    onError: (msg) => { if (msg !== null) addPersistent(msg, "error"); },
    onPersistentNotice: (msg) => addPersistent(msg, "error"),
  });

  const settingsModal = useSettingsModal({
    onSnapshotUpdate: setSnapshot,
    onError: (msg) => { if (msg !== null) addPersistent(msg, "error"); },
    onNotice: addToast,
  });

  useEffect(() => {
    if (importFlow.pendingReviewDrafts.length === 0) {
      initialReviewDraftsRef.current = null;
      setShowReviewDiscardConfirm(false);
      return;
    }
    if (initialReviewDraftsRef.current === null) {
      initialReviewDraftsRef.current = importFlow.pendingReviewDrafts;
    }
  }, [importFlow.pendingReviewDrafts]);

  function isReviewDirty(): boolean {
    const initial = initialReviewDraftsRef.current;
    if (initial === null) return false;
    const current = importFlow.pendingReviewDrafts;
    if (initial.length !== current.length) return true;
    const project = (item: PendingImportReviewItem): string =>
      JSON.stringify({
        id: item.id,
        localTimestampText: item.localTimestampText,
        timezone: item.timezone,
        utcTimestampText: item.utcTimestampText,
        deleteOriginalOnConfirm: item.deleteOriginalOnConfirm,
      });
    return initial.map(project).join("|") !== current.map(project).join("|");
  }

  function handleRequestCloseReview(): void {
    if (showReviewDiscardConfirm) return;
    if (isReviewDirty()) {
      setShowReviewDiscardConfirm(true);
      return;
    }
    void importFlow.handleCancelPendingImports();
  }

  function handleConfirmDiscardReview(): void {
    setShowReviewDiscardConfirm(false);
    void importFlow.handleCancelPendingImports();
  }

  function handleCancelDiscardReview(): void {
    setShowReviewDiscardConfirm(false);
  }

  useEffect(() => {
    let cancelled = false;

    void window.mumbler
      .getSnapshot()
      .then((data) => {
        if (!cancelled) {
          snapshotRef.current = data;
          setSnapshot(data);
          const recovered = data.queueSummary?.recoveredInterruptedCards ?? 0;
          if (recovered > 0) {
            addPersistent(`${recovered} recording${recovered === 1 ? "" : "s"} recovered from an interrupted session — retry to resume.`);
          }
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          addPersistent(
            error instanceof Error ? error.message : "Failed to load app snapshot.",
            "error",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return window.mumbler.onPipelineProgressUpdated(() => {
      const prevSnapshot = snapshotRef.current;
      void window.mumbler
        .getSnapshot()
        .then((nextSnapshot) => {
          if (prevSnapshot?.state?.cards) {
            for (const card of nextSnapshot.state?.cards ?? []) {
              const prevCard = prevSnapshot.state.cards.find((c) => c.id === card.id);
              if (prevCard && prevCard.status !== card.status) {
                if (card.status === "Ready to Save") {
                  addToast(`Ready to save: ${card.originalFilename}`);
                } else if (card.status === "Error") {
                  addToast(`Failed: ${card.originalFilename} — ${card.lastError?.message ?? "Unknown error"}`, "error");
                }
              }
            }
          }
          setSnapshot(nextSnapshot);
        })
        .catch((error: unknown) => {
          addPersistent(error instanceof Error ? error.message : "Failed to refresh card state.", "error");
        });
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
          addPersistent(
            error instanceof Error ? error.message : "Failed to refresh app-wide error state.",
            "error",
          );
        });
    });
  }, []);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    function reportRendererFault(message: string, source: string, stack?: string): void {
      void window.mumbler
        .reportRendererError({ message, source, stack })
        .then((nextSnapshot) => {
          setSnapshot(nextSnapshot);
        })
        .catch((error: unknown) => {
          addPersistent(
            error instanceof Error ? error.message : "Failed to report renderer error.",
            "error",
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
  const transcribeDisabledReason = getTranscribeDisabledReason({
    selectedCard,
    hasGeminiKey: snapshot?.settingsSummary?.hasGeminiApiKey ?? false,
    selectedCardIsBusy,
  });
  const saveDisabledReason = getSaveDisabledReason({
    selectedCard,
    outputDirectory: snapshot?.settingsSummary?.outputDirectory,
    selectedCardIsBusy,
  });
  const modalIsOpen =
    settingsModal.settingsDraft !== null ||
    importFlow.pendingReviewDrafts.length > 0 ||
    showReviewDiscardConfirm ||
    pendingSaveConflict !== null ||
    pendingRemoveCardId !== null ||
    showAbout ||
    showShortcutsHelp ||
    snapshot?.startupDiagnostic != null ||
    snapshot?.appWideError != null;
  async function handleCardSelect(cardId: string): Promise<void> {
    try {
      const nextSnapshot = await window.mumbler.selectCard(cardId);
      setSnapshot(nextSnapshot);
    } catch (error: unknown) {
      addPersistent(error instanceof Error ? error.message : "Failed to select card.", "error");
    }
  }

  async function handleDuplicateCard(cardId: string): Promise<void> {
    try {
      const nextSnapshot = await window.mumbler.duplicateCard(cardId);
      setSnapshot(nextSnapshot);
      addToast("Recording duplicated.");
    } catch (error: unknown) {
      addPersistent(error instanceof Error ? error.message : "Failed to duplicate card.", "error");
      throw error;
    }
  }

  async function handleTrimCommit(cardId: string, trim: MumblerCard["trim"]): Promise<void> {
    try {
      const nextSnapshot = await window.mumbler.updateCardTrim(cardId, trim);
      setSnapshot(nextSnapshot);
    } catch (error: unknown) {
      addPersistent(error instanceof Error ? error.message : "Failed to update trim.", "error");
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
      })
      .catch((error: unknown) => {
        addPersistent(error instanceof Error ? error.message : "Failed to transcribe card.", "error");
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
      })
      .catch((error: unknown) => {
        addPersistent(error instanceof Error ? error.message : "Failed to retry card.", "error");
      })
      .finally(() => {
        endCardOperation(cardId);
      });
  }

  async function handleChooseOutputDirectory(): Promise<void> {
    try {
      const nextSnapshot = await window.mumbler.chooseOutputDirectory();
      setSnapshot(nextSnapshot);
      addToast("Output directory set.");
    } catch (error: unknown) {
      addPersistent(
        error instanceof Error ? error.message : "Failed to choose output directory.",
        "error",
      );
    }
  }

  async function handleDetailModelChange(field: "transcriptionModel" | "metadataModel", value: string): Promise<void> {
    try {
      const draft = await window.mumbler.getSettingsDraft();
      const nextSnapshot = await window.mumbler.saveSettingsDraft({ ...draft, [field]: value });
      setSnapshot(nextSnapshot);
      addToast("Model updated.");
    } catch (error: unknown) {
      addPersistent(error instanceof Error ? error.message : "Failed to update model.", "error");
    }
  }

  async function handleCopyResult(label: string, value: string | null): Promise<void> {
    if (value === null || value.trim().length === 0) {
      return;
    }

    try {
      await copyTextToClipboard(value);
      addToast(`${label} copied.`);
    } catch (error: unknown) {
      addPersistent(error instanceof Error ? error.message : `Failed to copy ${label}.`, "error");
    }
  }

  async function handleDismissAppWideError(): Promise<void> {
    try {
      const nextSnapshot = await window.mumbler.dismissAppWideError();
      setSnapshot(nextSnapshot);
    } catch (error: unknown) {
      addPersistent(
        error instanceof Error ? error.message : "Failed to dismiss app-wide error.",
        "error",
      );
    }
  }

  async function handleResetState(): Promise<void> {
    setIsResettingState(true);
    try {
      const nextSnapshot = await window.mumbler.resetState();
      setSnapshot(nextSnapshot);
      addToast("Reset to defaults.");
    } catch (error: unknown) {
      addPersistent(error instanceof Error ? error.message : "Failed to reset state.", "error");
    } finally {
      setIsResettingState(false);
    }
  }

  async function handleShortcutCommand(commandId: string): Promise<void> {
    if (selectedCard === null) {
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
      if (event.key === "Escape") {
        if (snapshot?.appWideError) {
          void handleDismissAppWideError();
        } else if (isMenuOpen) {
          setIsMenuOpen(false);
        } else if (showAbout) {
          setShowAbout(false);
        } else if (showShortcutsHelp) {
          setShowShortcutsHelp(false);
        } else if (pendingRemoveCardId !== null) {
          setPendingRemoveCardId(null);
        } else if (pendingSaveConflict !== null) {
          setPendingSaveConflict(null);
        } else if (importFlow.pendingReviewDrafts.length > 0) {
          handleRequestCloseReview();
        } else if (settingsModal.settingsDraft !== null && !settingsModal.isSavingSettings) {
          settingsModal.handleRequestCloseSettings();
        }
        return;
      }

      const settingsSummary = snapshot?.settingsSummary;
      if (modalIsOpen || isTypingTarget(event.target) || settingsSummary == null) {
        return;
      }

      const commandId = findMatchingCommand(event);
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
  }, [modalIsOpen, isMenuOpen, showAbout, showShortcutsHelp, selectedCard, selectedCardIsBusy, snapshot, settingsModal.settingsDraft, settingsModal.isSavingSettings, settingsModal.setSettingsDraft, settingsModal.setSettingsErrorMessage, pendingRemoveCardId, pendingSaveConflict, importFlow.pendingReviewDrafts, importFlow.handleCancelPendingImports, showReviewDiscardConfirm]);

  async function handleSaveCard(
    cardId: string,
    resolution?: "overwrite" | "suffix" | "cancel",
  ): Promise<void> {
    try {
      const result = await window.mumbler.saveCard(cardId, resolution);
      setSnapshot(result.snapshot);

      if (result.kind === "conflict") {
        setPendingSaveConflict({ cardId, result });
        return;
      }

      if (result.kind === "cancelled") {
        setPendingSaveConflict(null);
        return;
      }

      setPendingSaveConflict(null);
      addToast(`Saved to ${result.audioPath}`);
      window.scrollTo({ top: 0 });
    } catch (error: unknown) {
      addPersistent(error instanceof Error ? error.message : "Failed to save card.", "error");
    }
  }

  async function confirmRemoveCard(cardId: string): Promise<void> {
    try {
      const nextSnapshot = await window.mumbler.removeCard(cardId);
      setSnapshot(nextSnapshot);
      addToast("Recording moved to trash.");
      window.scrollTo({ top: 0 });
    } catch (error: unknown) {
      addPersistent(error instanceof Error ? error.message : "Failed to remove card.", "error");
    } finally {
      setPendingRemoveCardId(null);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Mumbler</h1>
        </div>
        <div className="topbar__meta">
          <div className="app-menu-anchor">
            <button
              type="button"
              className="button button--ghost button--icon"
              aria-label="Open menu"
              onClick={() => setIsMenuOpen((prev) => !prev)}
            >
              ☰
            </button>
            {isMenuOpen && (
              <>
                <div className="app-menu-overlay" onClick={() => setIsMenuOpen(false)} />
                <div className="app-menu">
                  <button
                    type="button"
                    className="app-menu-item"
                    onClick={() => { setIsMenuOpen(false); void settingsModal.handleOpenSettings(); }}
                    disabled={importFlow.isImporting || settingsModal.isLoadingSettings}
                  >
                    Settings
                  </button>
                  <button
                    type="button"
                    className="app-menu-item"
                    onClick={() => { setIsMenuOpen(false); setShowShortcutsHelp(true); }}
                    disabled={snapshot === null}
                  >
                    Keyboard Shortcuts
                  </button>
                  <button
                    type="button"
                    className="app-menu-item"
                    onClick={() => { setIsMenuOpen(false); setShowAbout(true); }}
                  >
                    About
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {notifications.filter(n => n.kind === "persistent").length > 0 && (
        <div className="persistent-strip">
          {notifications.filter(n => n.kind === "persistent").map(n => (
            <div key={n.id} className={`persistent-notice persistent-notice--${n.variant}`}>
              <span className="persistent-notice__message">{n.message}</span>
              <button
                type="button"
                className="button button--ghost button--compact"
                onClick={() => dismissNotification(n.id)}
              >✕</button>
            </div>
          ))}
        </div>
      )}

      <main
        className={`workspace${importFlow.isDragActive ? " workspace--drag-active" : ""}`}
        onDragOver={importFlow.onDragOver}
        onDragLeave={importFlow.onDragLeave}
        onDrop={importFlow.onDrop}
      >
        <aside className="queue-pane panel">
          <div className="panel__header">
            <h2>Queue</h2>
            <div className="toolbar">
              <button
                type="button"
                className="button button--primary"
                onClick={() => void importFlow.handleImportClick()}
                disabled={importFlow.isImporting}
              >
                {importFlow.isImporting ? "Importing..." : "Import"}
              </button>
            </div>
          </div>

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
                  ? "Pending review"
                  : "Empty queue"}
              </p>
              <p className="empty-state__body">
                {snapshot?.state?.pendingImports.length
                  ? "Confirm timestamps to add files to the queue."
                  : "Import audio files or drop them into this window to get started."}
              </p>
            </section>
          )}
        </aside>

        <section className="detail-pane panel">
          <div className="panel__header">
            <h2>Detail</h2>
          </div>

          {selectedCard ? (
            <div className="detail-grid">

              {/* ── Group 1: Detail (3 columns) ─────────────────────── */}
              <div className="detail-row">
                <section className={`detail-card detail-card--status detail-card--${statusModifier(selectedCard.status)}`}>
                  <div className="detail-card__header">
                    <h3>Timestamps</h3>
                  </div>
                  <dl className="meta-list">
                    <div>
                      <dt>Original filename</dt>
                      <dd>{selectedCard.originalFilename}</dd>
                    </div>
                    <div>
                      <dt>Confirmed local</dt>
                      <dd>{selectedCard.timestamps.confirmedLocal}</dd>
                    </div>
                    {selectedCard.timestamps.frontTrimOffsetSec > 0 && (
                      <div>
                        <dt>Effective local</dt>
                        <dd>{selectedCard.timestamps.effectiveLocal}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Timezone</dt>
                      <dd>{selectedCard.timestamps.timezone}</dd>
                    </div>
                    <div>
                      <dt>Effective UTC</dt>
                      <dd>{formatUtcForDisplay(selectedCard.timestamps.effectiveUtc)}</dd>
                    </div>
                  </dl>
                </section>

                <section className="detail-card">
                  <div className="detail-card__header">
                    <h3>Audio</h3>
                  </div>
                  <dl className="meta-list">
                    <div>
                      <dt>Duration</dt>
                      <dd>{formatDuration(selectedCard.durationSec)}</dd>
                    </div>
                    <div>
                      <dt>Format</dt>
                      <dd>{(() => {
                        const codec = selectedCard.audioProfile?.codecName ?? null;
                        const container = selectedCard.audioProfile?.formatName ?? null;
                        if (!codec && !container) return "Unknown";
                        if (codec === container || !container) return codec ?? "Unknown";
                        if (!codec) return container ?? "Unknown";
                        return `${codec} (${container})`;
                      })()}</dd>
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
                      <dt>File size</dt>
                      <dd>{formatBytes(selectedCard.fileSizeBytes)}</dd>
                    </div>
                  </dl>
                </section>

                <section className="detail-card">
                  <div className="detail-card__header">
                    <h3>Options</h3>
                  </div>
                  <div className="field-stack">
                    <label className="field">
                      <span>Transcription Model</span>
                      <select
                        value={snapshot?.settingsSummary?.transcriptionModel ?? ""}
                        disabled={selectedCardIsBusy}
                        onChange={(event) => void handleDetailModelChange("transcriptionModel", event.target.value)}
                      >
                        {GEMINI_MODELS.map((m) => (
                          <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                        {snapshot?.settingsSummary?.transcriptionModel &&
                          !GEMINI_MODELS.some((m) => m.id === snapshot.settingsSummary?.transcriptionModel) && (
                          <option value={snapshot.settingsSummary.transcriptionModel}>
                            {snapshot.settingsSummary.transcriptionModel}
                          </option>
                        )}
                      </select>
                    </label>
                    <label className="field">
                      <span>Metadata Model</span>
                      <select
                        value={snapshot?.settingsSummary?.metadataModel ?? ""}
                        disabled={selectedCardIsBusy}
                        onChange={(event) => void handleDetailModelChange("metadataModel", event.target.value)}
                      >
                        {GEMINI_MODELS.map((m) => (
                          <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                        {snapshot?.settingsSummary?.metadataModel &&
                          !GEMINI_MODELS.some((m) => m.id === snapshot.settingsSummary?.metadataModel) && (
                          <option value={snapshot.settingsSummary.metadataModel}>
                            {snapshot.settingsSummary.metadataModel}
                          </option>
                        )}
                      </select>
                    </label>
                  </div>
                </section>
              </div>

              {/* ── Group 2: Player and Trim ─────────────────────────── */}
              <section className="detail-card detail-card--wide">
                <div className="detail-card__header">
                  <h3>Player and Trim</h3>
                </div>
                <WaveformEditor
                  ref={waveformEditorRef}
                  card={selectedCard}
                  previewSnippetSeconds={snapshot?.settingsSummary?.previewSnippetSeconds ?? 10}
                  disabled={selectedCardIsBusy}
                  onDuplicateCard={handleDuplicateCard}
                  onTrimCommit={handleTrimCommit}
                  onError={(message) => addPersistent(message, "error")}
                />
                <div className="trim-analysis">
                  <div className="trim-analysis__header">
                    <span className="trim-analysis__label">Trim Analysis</span>
                  </div>
                  <p className="panel__note">{describeTrimDecision(selectedCard.trimDecision)}</p>
                  <dl className="trim-analysis-grid">
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
                        {selectedCard.trimDecision?.searchStartFromSec === null || selectedCard.trimDecision?.searchStartFromSec === undefined
                          ? "—"
                          : `${formatOptionalSeconds(selectedCard.trimDecision.searchStartFromSec)} – ${formatOptionalSeconds(selectedCard.trimDecision.searchStartToSec ?? null)}`}
                      </dd>
                    </div>
                    <div>
                      <dt>End search window</dt>
                      <dd>
                        {selectedCard.trimDecision?.searchEndFromSec === null || selectedCard.trimDecision?.searchEndFromSec === undefined
                          ? "—"
                          : `${formatOptionalSeconds(selectedCard.trimDecision.searchEndFromSec)} – ${formatOptionalSeconds(selectedCard.trimDecision.searchEndToSec ?? null)}`}
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
                    <div className="trim-analysis-grid__reason">
                      <dt>Reason</dt>
                      <dd>{selectedCard.trimDecision?.reason ?? "No markers set yet."}</dd>
                    </div>
                  </dl>
                </div>
              </section>

              {/* ── Group 3: Transcription and Metadata ──────────────── */}
              <section className={`detail-card detail-card--wide detail-card--status detail-card--${statusModifier(selectedCard.status)}`}>
                <div className="detail-card__header">
                  <h3>Transcription and Metadata</h3>
                </div>
                <div className="action-toolbar">
                  <button
                    type="button"
                    className="button button--primary"
                    onClick={() => handleTranscribeCard(selectedCard.id)}
                    disabled={transcribeDisabledReason !== null}
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
                </div>
                {transcribeDisabledReason && !selectedCardIsBusy ? (
                  <p className="panel__note">{transcribeDisabledReason}</p>
                ) : null}
                <div className="result-grid">
                  <label className="field field--tall">
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
                      className="result-output result-output--tall"
                      value={selectedCard.transcription.text ?? ""}
                      placeholder=""
                    />
                  </label>
                  <div className="result-secondary">
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
                        placeholder=""
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
                        placeholder=""
                      />
                    </label>
                  </div>
                </div>
              </section>

              {/* ── Group 4: Output and Save ──────────────────────────── */}
              <section className="detail-card detail-card--wide">
                <div className="detail-card__header">
                  <h3>Output and Save</h3>
                </div>
                <dl className="meta-list compact-meta-list">
                  <div>
                    <dt>Output directory</dt>
                    <dd>{snapshot?.settingsSummary?.outputDirectory ?? "Not configured"}</dd>
                  </div>
                  {selectedCard.lastError ? (
                    <div>
                      <dt>Last failed step</dt>
                      <dd>{selectedCard.lastError.failedStep}</dd>
                    </div>
                  ) : null}
                </dl>
                <div className="action-toolbar">
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => void handleChooseOutputDirectory()}
                    disabled={selectedCardIsBusy}
                  >
                    Change Output Directory
                  </button>
                </div>
                <div className="action-toolbar">
                  <button
                    type="button"
                    className="button button--primary"
                    onClick={() => void handleSaveCard(selectedCard.id)}
                    disabled={saveDisabledReason !== null}
                  >
                    Save and Remove
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
                <p className="field-hint">Saving exports audio and metadata, then removes this recording from the queue.</p>
                {saveDisabledReason && !selectedCardIsBusy ? (
                  <p className="panel__note">{saveDisabledReason}</p>
                ) : null}
              </section>

            </div>
          ) : snapshot?.state?.cards.length ? (
            <section className="panel panel--nested queue-empty">
              <p className="empty-state__title">Select a recording</p>
            </section>
          ) : (
            <section className="panel panel--nested queue-empty">
              <p className="empty-state__title">No selection</p>
              <p className="empty-state__body">Import recordings to get started.</p>
            </section>
          )}
        </section>
      </main>

      {settingsModal.settingsDraft ? (
        <SettingsModal
          draft={settingsModal.settingsDraft}
          isSaving={settingsModal.isSavingSettings}
          isPickingOutputDirectory={settingsModal.isPickingSettingsOutputDirectory}
          errorMessage={settingsModal.settingsErrorMessage}
          onChange={settingsModal.setSettingsDraft}
          onClose={settingsModal.handleRequestCloseSettings}
          onPickOutputDirectory={() => void settingsModal.handlePickSettingsOutputDirectory()}
          onSave={() => void settingsModal.handleSaveSettings()}
        />
      ) : null}

      {settingsModal.showDiscardConfirm ? (
        <DecisionModal
          title="Discard Changes?"
          body="You have unsaved changes. Discard them and close settings?"
          actions={[
            {
              label: "Keep Editing",
              onClick: settingsModal.handleCancelDiscardSettings,
            },
            {
              label: "Discard",
              variant: "danger",
              onClick: settingsModal.handleConfirmDiscardSettings,
            },
          ]}
          onBackdropClick={settingsModal.handleCancelDiscardSettings}
        />
      ) : null}

      {importFlow.pendingReviewDrafts.length > 0 ? (
        <TimestampReviewModal
          items={importFlow.pendingReviewDrafts}
          defaultTimezone={snapshot?.settingsSummary?.defaultTimezone}
          onChange={(updatedItem) =>
            importFlow.setPendingReviewDrafts((current) =>
              current.map((item) => (item.id === updatedItem.id ? updatedItem : item)),
            )
          }
          onApplyTimezoneToAll={(timezone) =>
            importFlow.setPendingReviewDrafts((current) =>
              current.map((item) => {
                const localError = getLocalTimestampError(item.localTimestampText);
                const utcError = getUtcTimestampError(item.utcTimestampText);

                if (localError === null) {
                  const utcResult = recomputeUtcFromLocal(item.localTimestampText, timezone);
                  return {
                    ...item,
                    timezone,
                    utcTimestampText:
                      utcResult.error === null ? formatUtcForDisplay(utcResult.utcMs!) : item.utcTimestampText,
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
          onConfirm={() => void importFlow.handleConfirmPendingImports()}
          onCancel={handleRequestCloseReview}
          onSetDeleteOriginalForAll={(value) =>
            importFlow.setPendingReviewDrafts((current) =>
              current.map((item) => ({ ...item, deleteOriginalOnConfirm: value }))
            )
          }
          isSubmitting={importFlow.isConfirmingReview}
        />
      ) : null}

      {showReviewDiscardConfirm ? (
        <DecisionModal
          title="Discard Changes?"
          body="You have unsaved timestamp edits. Discard them and cancel the import?"
          actions={[
            {
              label: "Keep Editing",
              onClick: handleCancelDiscardReview,
            },
            {
              label: "Discard",
              variant: "danger",
              onClick: handleConfirmDiscardReview,
            },
          ]}
          onBackdropClick={handleCancelDiscardReview}
        />
      ) : null}

      {pendingSaveConflict ? (
        <DecisionModal
          title="File Exists"
          body={`${pendingSaveConflict.result.audioPath} already exists.`}
          actions={[
            {
              label: "Cancel",
              onClick: () => {
                setPendingSaveConflict(null);
              },
            },
            {
              label: "Overwrite",
              variant: "danger",
              onClick: () => {
                void handleSaveCard(pendingSaveConflict.cardId, "overwrite");
              },
            },
            {
              label: "Add Suffix",
              variant: "primary",
              onClick: () => {
                void handleSaveCard(pendingSaveConflict.cardId, "suffix");
              },
            },
          ]}
          onBackdropClick={() => setPendingSaveConflict(null)}
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
          onBackdropClick={() => void handleDismissAppWideError()}
        />
      ) : null}

      {pendingRemoveCardId ? (
        <DecisionModal
          title="Remove Recording?"
          body={getRemoveConfirmBody(
            snapshot?.state?.cards.find((c) => c.id === pendingRemoveCardId) ??
              ({ trim: {}, transcription: {}, metadata: {} } as unknown as MumblerCard),
          )}
          actions={[
            {
              label: "Cancel",
              onClick: () => {
                setPendingRemoveCardId(null);
              },
            },
            {
              label: "Remove",
              variant: "danger",
              onClick: () => {
                void confirmRemoveCard(pendingRemoveCardId);
              },
            },
          ]}
          onBackdropClick={() => setPendingRemoveCardId(null)}
        />
      ) : null}

      {showAbout ? (
        <AboutModal onClose={() => setShowAbout(false)} />
      ) : null}

      {showShortcutsHelp ? (
        <ShortcutsHelpModal onClose={() => setShowShortcutsHelp(false)} />
      ) : null}

      {notifications.filter(n => n.kind === "toast").length > 0 && (
        <div className="toast-container">
          {notifications.filter(n => n.kind === "toast").map(n => (
            <div
              key={n.id}
              className={`toast toast--${n.variant}`}
              onClick={() => dismissNotification(n.id)}
            >
              {n.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
