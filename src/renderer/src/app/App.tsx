import { nanoid } from "nanoid";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";

import type {
  AppSnapshot,
  DependencyStatus,
  GenerateTarget,
  MumblerCard,
  PendingImportReviewItem,
  SaveCardResult,
  StatusRole,
  ToolName,
} from "@shared/app-shell";
import { DETAIL_MIN_WIDTH, QUEUE_WIDTH, WORKSPACE_GAP, WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT } from "@shared/layout";
import { rollUpRole } from "@shared/dependency-status";
import {
  formatUtcForDisplay,
  getLocalTimestampError,
  getUtcTimestampError,
  recomputeLocalFromUtc,
  recomputeUtcFromLocal,
} from "@shared/timestamps";

import { WaveformEditor, type WaveformEditorHandle } from "./WaveformEditor";
import { HamburgerIcon } from "./Icon";
import { Menu, MenuItem } from "./Menu";
import { SettingsModal } from "./SettingsModal";
import { findMatchingGlobalCommand, isActivationTarget, isShortcutsHelpChord, isTypingTarget } from "./shortcut-utils";
import { TimestampReviewModal } from "./TimestampReviewModal";
import { QueueList, formatDuration, statusModifier } from "./QueueList";
import { PaneSplitter } from "./PaneSplitter";
import { usePaneSize } from "./usePaneSize";
import {
  AppWideErrorModal,
  DiscardReviewModal,
  DiscardSettingsModal,
  GenerateConfirmModal,
  RemoveRecordingModal,
  SaveConflictModal,
} from "./DecisionModals";
import { AboutModal } from "./AboutModal";
import { AudioToolsModal } from "./AudioToolsModal";
import { ShortcutsHelpModal } from "./ShortcutsHelpModal";
import { useImportFlow } from "./useImportFlow";
import { useSettingsModal } from "./useSettingsModal";
import { formatCardStatusMessage, formatStepName, hasStaleResults, isCardBusy, staleResultsNote } from "./card-status";
import { useTablist } from "./useTablist";
import { CloseIcon } from "./Icon";
import { presentFailure, reportRendererDiagnostic } from "./presentFailure";
import { I18nProvider, useI18n } from "../i18n/I18nContext";
import { isLanguage, type InterfaceLanguage } from "@shared/i18n/languages";
import type { MessageKey } from "@shared/i18n/catalogues";
import { message, type Message } from "@shared/i18n/translate";
import { CardActionResults, type CardActionError } from "./CardActionResults";
import {
  PersistentNotifications,
  ToastNotifications,
  clearPersistentOwner,
  pipelineCompletionNotification,
  upsertPersistentNotification,
  type AppNotification,
} from "./Notifications";
import {
  describeTrimDecision,
  formatOptionalSeconds,
  getGenerateConfirmBody,
  getGenerateDisabledReason,
  getRemoveConfirmBody,
  getSaveDisabledReason,
  generateConfirmTitles,
  trimDecisionReason,
} from "./generate-rules";

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

// The topbar dependency roll-up (managed-runtime-dependencies-conventions): a
// single status message at the worst role present that opens the Audio Tools
// surface. It is deliberately a tinted status pill, not a plain button — a missing
// or outdated tool needs to read as a condition that wants attention.
//
// The informational state covers two different stories, and the chip can tell
// them apart, so it does: a tool whose own version could not be read needs the
// user to re-acquire it (the modal's Update), where a merely-unchecked one only
// needs a check.
function toolsChipMessage(role: StatusRole, dependencies: DependencyStatus[] | null): MessageKey {
  if (role !== "informational") {
    return "tools.chipAttention";
  }
  const unreadable = dependencies?.some(
    (dep) => dep.state === "installed-unchecked" && dep.installedVersion === null,
  );
  return unreadable ? "tools.chipVersionUnreadable" : "tools.chipUpdatesUnchecked";
}

const COPIED: Record<GenerateTarget, MessageKey> = {
  transcription: "notice.copied.transcription",
  structured: "notice.copied.structured",
  title: "notice.copied.title",
  slug: "notice.copied.slug",
};

const COPY_FAILED: Record<GenerateTarget, MessageKey> = {
  transcription: "error.copy.transcription",
  structured: "error.copy.structured",
  title: "error.copy.title",
  slug: "error.copy.slug",
};

// The detail pane's wizard tabs, in workflow order: check the loaded info,
// trim the audio, transcribe and review the metadata, then save. Every tab is
// freely revisitable; the Next button on each is a convenience for walking the
// flow forward, not a gate.
const DETAIL_TABS = ["info", "trim", "transcribe", "output"] as const;
type DetailTab = (typeof DETAIL_TABS)[number];
const DETAIL_TAB_LABELS: Record<DetailTab, MessageKey> = {
  info: "detail.tabInfo",
  trim: "detail.tabTrim",
  transcribe: "detail.tabTranscribe",
  output: "detail.tabOutput",
};

// The first text on screen is already in the interface language, so nothing is
// drawn until the main process has said which language that is.
export function App(): ReactElement {
  const [startupLanguage, setStartupLanguage] = useState<InterfaceLanguage | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.mumbler
      .getInterfaceLanguage()
      .then((resolved) => {
        if (!cancelled) setStartupLanguage(isLanguage(resolved?.language) ? resolved : ENGLISH);
      })
      .catch((error: unknown) => {
        reportRendererDiagnostic(error, "interface language load failed");
        if (!cancelled) setStartupLanguage(ENGLISH);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (startupLanguage === null) {
    return <main className="renderer-failure" role="status" aria-busy="true" />;
  }

  return (
    <I18nProvider language={startupLanguage.language} locale={startupLanguage.locale}>
      <StartupGate />
    </I18nProvider>
  );
}

const ENGLISH: InterfaceLanguage = { language: "en", locale: "en" };

function StartupGate(): ReactElement {
  const { t, text } = useI18n();
  const [startupLoad, setStartupLoad] = useState<
    | { status: "loading" }
    | { status: "failed"; retrying: boolean; message: Message }
    | { status: "ready"; snapshot: AppSnapshot }
  >({ status: "loading" });
  const startupAttemptRef = useRef(0);

  const loadStartupSnapshot = useCallback(async (): Promise<void> => {
    const attempt = ++startupAttemptRef.current;
    setStartupLoad((current) =>
      current.status === "failed"
        ? { ...current, retrying: true }
        : { status: "loading" },
    );
    try {
      const snapshot = await window.mumbler.getSnapshot();
      if (startupAttemptRef.current === attempt) {
        setStartupLoad({ status: "ready", snapshot });
      }
    } catch (error: unknown) {
      if (startupAttemptRef.current === attempt) {
        setStartupLoad({
          status: "failed",
          retrying: false,
          message: presentFailure(
            error,
            message("startup.loadFailed"),
            "app snapshot load failed",
          ),
        });
      }
    }
  }, []);

  useEffect(() => {
    void loadStartupSnapshot();
    return () => {
      startupAttemptRef.current += 1;
    };
  }, [loadStartupSnapshot]);

  if (startupLoad.status !== "ready") {
    return (
      <main
        className="renderer-failure"
        role={startupLoad.status === "failed" ? "alert" : "status"}
        aria-busy={startupLoad.status === "loading" || startupLoad.retrying ? "true" : undefined}
      >
        <div className="renderer-failure__card">
          <h1>{startupLoad.status === "failed" ? t("startup.loadFailedTitle") : t("startup.opening")}</h1>
          {startupLoad.status === "failed" ? <p>{text(startupLoad.message)}</p> : null}
          {startupLoad.status === "failed" ? (
            <button
              className="button button--primary"
              type="button"
              disabled={startupLoad.retrying}
              onClick={() => void loadStartupSnapshot()}
            >
              {startupLoad.retrying ? t("startup.retrying") : t("common.retry")}
            </button>
          ) : null}
        </div>
      </main>
    );
  }

  return <LoadedApp initialSnapshot={startupLoad.snapshot} />;
}

function LoadedApp({ initialSnapshot }: { initialSnapshot: AppSnapshot }): ReactElement {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(initialSnapshot);
  // Every snapshot carries the language the main process speaks, so a language
  // saved in Settings reaches the renderer with the snapshot that Save returns.
  const { language, locale } = snapshot.interfaceLanguage;
  return (
    <I18nProvider language={language} locale={locale}>
      <LoadedShell snapshot={snapshot} setSnapshot={setSnapshot} />
    </I18nProvider>
  );
}

function LoadedShell({
  snapshot,
  setSnapshot,
}: {
  snapshot: AppSnapshot;
  setSnapshot: (snapshot: AppSnapshot) => void;
}): ReactElement {
  const initialSnapshot = snapshot;
  const i18n = useI18n();
  const { t, text } = i18n;
  const [notifications, setNotifications] = useState<AppNotification[]>(() => {
    const recovered = initialSnapshot.queueSummary?.recoveredInterruptedCards ?? 0;
    return recovered > 0
      ? [{
          id: nanoid(),
          owner: "startup:recovered-interrupted",
          message: message("notice.recovered", { count: recovered }),
          kind: "persistent",
          variant: "info",
        }]
      : [];
  });
  const snapshotRef = useRef<AppSnapshot | null>(initialSnapshot);

  const addToast = useCallback((toast: Message) => {
    const id = nanoid();
    setNotifications(prev => [...prev, { id, message: toast, kind: "toast" }]);
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 4000);
  }, []);

  const addPersistent = useCallback((
    owner: string,
    notice: Message,
    variant: Extract<AppNotification, { kind: "persistent" }>["variant"] = "info",
  ) => {
    const id = nanoid();
    setNotifications(prev => upsertPersistentNotification(
      prev,
      { id, owner, message: notice, kind: "persistent", variant },
    ));
  }, []);

  const clearPersistent = useCallback((owner: string) => {
    setNotifications(prev => clearPersistentOwner(prev, owner));
  }, []);

  const dismissNotification = useCallback((id: string) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);
  const [activePipelineCards, setActivePipelineCards] = useState<string[]>([]);
  const [cardActionErrors, setCardActionErrors] = useState<CardActionError[]>([]);
  const [pendingSaveConflict, setPendingSaveConflict] = useState<{
    cardId: string;
    result: Extract<SaveCardResult, { kind: "conflict" }>;
  } | null>(null);
  const [saveConflictError, setSaveConflictError] = useState<Message | null>(null);
  const [pendingRemoveCardId, setPendingRemoveCardId] = useState<string | null>(null);
  const [removeCardError, setRemoveCardError] = useState<Message | null>(null);
  // Sticky across card switches: reviewing several cards on the same step (e.g.
  // arrowing through the queue on the Transcribe tab) should not snap back to
  // Info. Ephemeral UI state, deliberately not persisted.
  const [detailTab, setDetailTab] = useState<DetailTab>("info");
  const detailTablist = useTablist<DetailTab>({
    tabs: DETAIL_TABS,
    selected: detailTab,
    onSelect: setDetailTab,
    idBase: "detail",
  });
  const [pendingGenerate, setPendingGenerate] = useState<{
    cardId: string;
    target: GenerateTarget;
    body: Message;
  } | null>(null);
  const [isResettingState, setIsResettingState] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [showAudioTools, setShowAudioTools] = useState(false);
  const [isCheckingTools, setIsCheckingTools] = useState(false);
  const [toolCheckNotice, setToolCheckNotice] = useState<Message | null>(null);
  const [toolOperationError, setToolOperationError] = useState<Message | null>(null);
  const autoOpenedAudioToolsRef = useRef(false);
  const [showReviewDiscardConfirm, setShowReviewDiscardConfirm] = useState(false);
  const initialReviewDraftsRef = useRef<PendingImportReviewItem[] | null>(null);
  const waveformEditorRef = useRef<WaveformEditorHandle | null>(null);

  const importFlow = useImportFlow({
    snapshot,
    onSnapshotUpdate: setSnapshot,
    onError: (owner, msg) => addPersistent(owner, msg, "error"),
  });

  const settingsModal = useSettingsModal({
    onSnapshotUpdate: setSnapshot,
    onError: (msg) => addPersistent("settings-load", msg, "error"),
    onNotice: addToast,
  });

  // Apply the configured UI font by overriding the `--font-ui` CSS variable on :root; blank reverts
  // to the styles.css default. The string is handed to CSS verbatim (engine-resolved) per the
  // app-chrome-conventions; the read-only transcription views follow it as display surfaces.
  const uiFontFamily = snapshot?.settingsSummary?.uiFontFamily ?? "";
  useEffect(() => {
    const family = uiFontFamily.trim();
    const root = document.documentElement;
    if (family) root.style.setProperty("--font-ui", family);
    else root.style.removeProperty("--font-ui");
  }, [uiFontFamily]);

  // The queue (left) pane width. The persisted layout.queueWidth is the drag-set
  // INTENT; the DISPLAYED width is that intent clamped to the live workspace, so it
  // narrows toward the pane min when the window shrinks and returns to the intent
  // when it grows (display-only, never persisted). During an active drag the local
  // override follows the cursor without a per-move IPC round-trip; it is released
  // once the committed width lands back in a fresh snapshot. The far-side reserve
  // is the detail-pane minimum plus the workspace gap — the same sum the window
  // minimum and the splitter clamp use.
  const [queueDragWidth, setQueueDragWidth] = useState<number | null>(null);
  const queueWidthIntent = snapshot?.layout?.queueWidth ?? QUEUE_WIDTH.default;
  const { containerRef: workspaceRef, displayed: queueWidth } = usePaneSize<HTMLElement>(
    queueDragWidth ?? queueWidthIntent,
    false,
    { siblingMin: DETAIL_MIN_WIDTH + WORKSPACE_GAP, min: QUEUE_WIDTH.min, max: QUEUE_WIDTH.max },
  );

  const handleQueueSplitterCommit = useCallback(
    (nextWidth: number): void => {
      // Persist the dragged intent, then release the local override only once the
      // fresh snapshot (carrying the saved width) is in — so the pane never flickers
      // back to the pre-drag width between commit and snapshot.
      void window.mumbler
        .saveLayout(nextWidth)
        .then((next) => {
          snapshotRef.current = next;
          setSnapshot(next);
          setQueueDragWidth(null);
        })
        .catch((error: unknown) => {
          setQueueDragWidth(null);
          addPersistent(
            "layout-save",
            presentFailure(error, message("error.layoutSave"), "pane layout save failed"),
            "error",
          );
        });
    },
    [addPersistent],
  );

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
        copyToBackupOnConfirm: item.copyToBackupOnConfirm,
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
    return window.mumbler.onPipelineProgressUpdated(() => {
      const prevSnapshot = snapshotRef.current;
      void window.mumbler
        .getSnapshot()
        .then((nextSnapshot) => {
          if (prevSnapshot?.state?.cards) {
            for (const card of nextSnapshot.state?.cards ?? []) {
              const prevCard = prevSnapshot.state.cards.find((c) => c.id === card.id);
              if (prevCard && prevCard.status !== card.status) {
                const notification = pipelineCompletionNotification(prevCard, card);
                if (notification?.kind === "toast") {
                  addToast(notification.message);
                }
              }
            }
          }
          setSnapshot(nextSnapshot);
        })
        .catch((error: unknown) => {
          addPersistent(
            "snapshot-refresh:pipeline",
            presentFailure(error, message("error.refreshRecordings"), "card state refresh failed"),
            "error",
          );
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
            "snapshot-refresh:app-wide-error",
            presentFailure(error, message("error.refreshWindow"), "app error state refresh failed"),
            "error",
          );
        });
    });
  }, []);

  useEffect(() => {
    return window.mumbler.onDependenciesUpdated(() => {
      void window.mumbler
        .getSnapshot()
        .then((nextSnapshot) => setSnapshot(nextSnapshot))
        .catch((error: unknown) => {
          addPersistent(
            "snapshot-refresh:dependencies",
            presentFailure(error, message("error.refreshTools"), "audio tools state refresh failed"),
            "error",
          );
        });
    });
  }, []);

  const dependencies = snapshot?.dependencies ?? null;
  const toolsRollUp = dependencies ? rollUpRole(dependencies) : "none";

  // Blocking-first-run (managed-runtime-dependencies-conventions): a required tool
  // that is missing opens the Audio Tools modal once as an instruction — regardless
  // of the launch-check toggle, since the app cannot trim or probe without it. An
  // available update is NOT a reason to interrupt; it surfaces only via the status
  // chip. Open once, so a refresh can't reopen it against the user who just closed.
  useEffect(() => {
    if (dependencies === null) {
      return;
    }
    const requiredMissing = dependencies.some(
      (dep) => dep.required && dep.state === "not-installed",
    );
    if (requiredMissing && !autoOpenedAudioToolsRef.current) {
      autoOpenedAudioToolsRef.current = true;
      setShowAudioTools(true);
    }
  }, [dependencies]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    function reportRendererFault(detail: string, source: string, stack?: string): void {
      void window.mumbler
        .reportRendererError({ message: detail, source, stack })
        .then((nextSnapshot) => {
          setSnapshot(nextSnapshot);
        })
        .catch(() => {
          addPersistent(
            "renderer-error-report",
            message("error.recordWindowError"),
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
    snapshot?.state?.cards.find(
      (card) => card.id === snapshot.queueSummary?.selectedCardId,
    ) ?? null;
  const selectedCardIsBusy =
    selectedCard !== null &&
    (activePipelineCards.includes(selectedCard.id) || isCardBusy(selectedCard));
  const generateDisabledReason = getGenerateDisabledReason({
    selectedCard,
    hasGeminiKey: snapshot?.settingsSummary?.hasGeminiApiKey ?? false,
  });
  const saveDisabledReason = getSaveDisabledReason({
    selectedCard,
    selectedCardIsBusy,
  });
  const modalIsOpen =
    settingsModal.settingsDraft !== null ||
    importFlow.pendingReviewDrafts.length > 0 ||
    showReviewDiscardConfirm ||
    pendingSaveConflict !== null ||
    pendingRemoveCardId !== null ||
    pendingGenerate !== null ||
    showAbout ||
    showShortcutsHelp ||
    showAudioTools ||
    snapshot?.startupDiagnostic != null ||
    snapshot?.appWideError != null;

  function setCardActionError(cardId: string, operation: string, result: Message): void {
    setCardActionErrors((current) => [
      ...current.filter((entry) => entry.cardId !== cardId || entry.operation !== operation),
      { cardId, operation, message: result },
    ]);
  }

  function clearCardActionError(cardId: string, operation: string): void {
    setCardActionErrors((current) =>
      current.filter((result) => result.cardId !== cardId || result.operation !== operation),
    );
  }

  function clearCardActionErrors(cardId: string): void {
    setCardActionErrors((current) => current.filter((result) => result.cardId !== cardId));
  }

  async function handleCardSelect(cardId: string): Promise<void> {
    try {
      const nextSnapshot = await window.mumbler.selectCard(cardId);
      setSnapshot(nextSnapshot);
    } catch (error: unknown) {
      addPersistent(
        // The message does not name the recording, so a later failed selection of any
        // card supersedes this notice instead of stacking an identical one.
        "card-selection",
        presentFailure(error, message("error.selectRecording"), "card selection failed"),
        "error",
      );
    }
  }

  async function handleDuplicateCard(cardId: string): Promise<void> {
    const nextSnapshot = await window.mumbler.duplicateCard(cardId);
    setSnapshot(nextSnapshot);
    addToast(message("notice.duplicated"));
  }

  async function handleTrimCommit(cardId: string, trim: MumblerCard["trim"]): Promise<void> {
    const nextSnapshot = await window.mumbler.updateCardTrim(cardId, trim);
    setSnapshot(nextSnapshot);
  }

  function beginCardOperation(cardId: string): void {
    setActivePipelineCards((current) =>
      current.includes(cardId) ? current : [...current, cardId],
    );
  }

  function endCardOperation(cardId: string): void {
    setActivePipelineCards((current) => current.filter((value) => value !== cardId));
  }

  function executeGenerate(cardId: string, target: GenerateTarget): void {
    beginCardOperation(cardId);
    void window.mumbler
      .generateCardStep(cardId, target)
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        clearCardActionError(cardId, `generate-${target}`);
      })
      .catch((error: unknown) => {
        setCardActionError(
          cardId,
          `generate-${target}`,
          presentFailure(error, message("error.generate"), "AI generation failed"),
        );
      })
      .finally(() => {
        endCardOperation(cardId);
      });
  }

  function handleCancelCardProcessing(cardId: string): void {
    void window.mumbler
      .cancelCardProcessing(cardId)
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        clearCardActionError(cardId, "cancel-processing");
      })
      .catch((error: unknown) => {
        setCardActionError(
          cardId,
          "cancel-processing",
          presentFailure(error, message("error.cancelGeneration"), "AI cancellation failed"),
        );
      });
  }

  function handleRequestGenerate(card: MumblerCard, target: GenerateTarget): void {
    const body = getGenerateConfirmBody(card, target);
    if (body === null) {
      executeGenerate(card.id, target);
      return;
    }

    setPendingGenerate({
      cardId: card.id,
      target,
      body,
    });
  }

  function handleConfirmGenerate(): void {
    const pending = pendingGenerate;
    if (pending === null) {
      return;
    }

    setPendingGenerate(null);
    executeGenerate(pending.cardId, pending.target);
  }

  async function handleChooseOutputDirectory(): Promise<void> {
    const cardId = selectedCard?.id ?? null;
    try {
      const nextSnapshot = await window.mumbler.chooseOutputDirectory();
      setSnapshot(nextSnapshot);
      if (cardId !== null) {
        clearCardActionError(cardId, "choose-output-directory");
      }
      addToast(message("notice.outputDirectorySet"));
    } catch (error: unknown) {
      if (cardId !== null) {
        setCardActionError(
          cardId,
          "choose-output-directory",
          presentFailure(error, message("error.chooseOutputFolder"), "output folder selection failed"),
        );
      }
    }
  }

  async function handleDetailModelChange(field: "transcriptionModel" | "metadataModel", value: string): Promise<void> {
    const cardId = selectedCard?.id ?? null;
    try {
      const draft = await window.mumbler.getSettingsDraft();
      const nextSnapshot = await window.mumbler.saveSettingsDraft({ ...draft, [field]: value });
      setSnapshot(nextSnapshot);
      if (cardId !== null) {
        clearCardActionError(cardId, `model-${field}`);
      }
      addToast(message("notice.modelUpdated"));
    } catch (error: unknown) {
      if (cardId !== null) {
        setCardActionError(
          cardId,
          `model-${field}`,
          presentFailure(error, message("error.modelUpdate"), "model update failed"),
        );
      }
    }
  }

  async function handleCopyResult(target: GenerateTarget, value: string | null): Promise<void> {
    if (value === null || value.trim().length === 0) {
      return;
    }

    const cardId = selectedCard?.id ?? null;
    try {
      await copyTextToClipboard(value);
      if (cardId !== null) {
        clearCardActionError(cardId, `copy-${target}`);
      }
      addToast(message(COPIED[target]));
    } catch (error: unknown) {
      if (cardId !== null) {
        setCardActionError(
          cardId,
          `copy-${target}`,
          presentFailure(error, message(COPY_FAILED[target]), "clipboard copy failed"),
        );
      }
    }
  }

  async function handleDismissAppWideError(): Promise<void> {
    try {
      const nextSnapshot = await window.mumbler.dismissAppWideError();
      setSnapshot(nextSnapshot);
    } catch (error: unknown) {
      addPersistent(
        "app-wide-error-dismissal",
        presentFailure(error, message("error.dismissMessage"), "app error dismissal failed"),
        "error",
      );
    }
  }

  async function handleResetState(): Promise<void> {
    setIsResettingState(true);
    try {
      const nextSnapshot = await window.mumbler.resetState();
      setSnapshot(nextSnapshot);
      addToast(message("notice.reset"));
    } catch (error: unknown) {
      addPersistent(
        "state-reset",
        presentFailure(error, message("error.resetState"), "state reset failed"),
        "error",
      );
    } finally {
      setIsResettingState(false);
    }
  }

  // Audio-tool operations. The main process records per-tool progress/errors in
  // the snapshot (live, via onDependenciesUpdated), while a thrown failure (for
  // example an operation already in flight) belongs to the still-open modal that
  // initiated it. Keeping that error here leaves it above the backdrop and next
  // to the retry action instead of sending it to app chrome behind the modal.
  function applyToolSnapshot(promise: Promise<AppSnapshot>, failMessage: Message): void {
    setToolOperationError(null);
    void promise
      .then((nextSnapshot) => setSnapshot(nextSnapshot))
      .catch((error: unknown) => {
        setToolOperationError(presentFailure(error, failMessage, "audio tool operation failed"));
      });
  }

  // The single acquire action: Install when missing, Update when a newer version
  // is known — the same provision path, which always fetches and verifies the
  // latest build.
  function handleProvisionTool(name: ToolName): void {
    applyToolSnapshot(window.mumbler.provisionTool(name), message("tools.installFailed"));
  }

  function handleCancelToolProvision(name: ToolName): void {
    applyToolSnapshot(
      window.mumbler.cancelToolProvision(name),
      message("tools.cancelInstallFailed"),
    );
  }

  // An explicit check that fails writes nothing to the facts (the convention's
  // honest-state rule), so its application-owned terminal notice remains visible
  // across modal replacement until the next explicit check supersedes it.
  function handleCheckTools(): void {
    setIsCheckingTools(true);
    setToolCheckNotice(null);
    void window.mumbler
      .checkTools()
      .then((nextSnapshot) => setSnapshot(nextSnapshot))
      .catch((error: unknown) => {
        setToolCheckNotice(
          presentFailure(error, message("tools.checkFailed"), "audio tool update check failed"),
        );
      })
      .finally(() => setIsCheckingTools(false));
  }

  function handleCancelToolCheck(): void {
    applyToolSnapshot(window.mumbler.cancelToolCheck(), message("tools.cancelCheckFailed"));
  }

  function handleToggleCheckUpdates(checkUpdatesAtLaunch: boolean): void {
    applyToolSnapshot(
      window.mumbler.saveToolSettings(checkUpdatesAtLaunch),
      message("tools.saveSettingsFailed"),
    );
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
      case "skip-backward":
        waveformEditorRef.current?.skipBackward();
        return;
      case "skip-forward":
        waveformEditorRef.current?.skipForward();
        return;
      case "transcribe-selected":
        if (snapshot?.settingsSummary?.hasGeminiApiKey && !selectedCardIsBusy) {
          executeGenerate(selectedCard.id, "slug");
        }
        return;
      case "save-selected":
        if (selectedCard.status === "Ready to Save" && !selectedCardIsBusy) {
          await handleSaveCard(selectedCard.id);
        }
        return;
      default:
        return;
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        // Escape is owned by whatever is open: each modal/dialog handles it
        // through ModalShell and the app menu handles it itself (closing and
        // returning focus to its trigger), both stopping it before it reaches
        // here. The window has nothing left to close on Escape.
        return;
      }

      const isMac = snapshot == null || snapshot.platform === "darwin";
      if (!modalIsOpen && !isMenuOpen && isShortcutsHelpChord(event, isMac)) {
        event.preventDefault();
        setShowShortcutsHelp(true);
        return;
      }

      const settingsSummary = snapshot?.settingsSummary;
      // The open app menu is a composite that owns the arrow / type-ahead /
      // activation keys while it has focus; suppress the global command layer so
      // those keys don't also fire a queue/player shortcut (the key-bleed the
      // composite-control conventions warn against).
      if (
        modalIsOpen ||
        isMenuOpen ||
        isTypingTarget(event.target) ||
        settingsSummary == null
      ) {
        return;
      }

      // Space activates a focused button/link natively; let it, rather than
      // preventDefault-ing it into the global play/pause command.
      if (event.key === " " && isActivationTarget(event.target)) {
        return;
      }

      const commandId = findMatchingGlobalCommand(event);
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
  }, [modalIsOpen, isMenuOpen, selectedCard, selectedCardIsBusy, snapshot]);

  async function handleSaveCard(
    cardId: string,
    resolution?: "overwrite" | "suffix" | "cancel",
  ): Promise<void> {
    try {
      const result = await window.mumbler.saveCard(cardId, resolution);
      setSnapshot(result.snapshot);

      if (result.kind === "conflict") {
        setPendingSaveConflict({ cardId, result });
        setSaveConflictError(null);
        return;
      }

      if (result.kind === "cancelled") {
        setPendingSaveConflict(null);
        return;
      }

      setPendingSaveConflict(null);
      setSaveConflictError(null);
      clearCardActionErrors(cardId);
      addToast(message("notice.saved", { path: result.audioPath }));
      window.scrollTo({ top: 0 });
    } catch (error: unknown) {
      const failure = presentFailure(error, message("error.saveRecording"), "recording save failed");
      if (pendingSaveConflict?.cardId === cardId) {
        setSaveConflictError(failure);
      } else {
        setCardActionError(cardId, "save-card", failure);
      }
    }
  }

  async function confirmRemoveCard(cardId: string): Promise<void> {
    try {
      const nextSnapshot = await window.mumbler.removeCard(cardId);
      setSnapshot(nextSnapshot);
      clearCardActionErrors(cardId);
      setPendingRemoveCardId(null);
      setRemoveCardError(null);
      addToast(message("notice.removed"));
      window.scrollTo({ top: 0 });
    } catch (error: unknown) {
      setRemoveCardError(presentFailure(error, message("error.removeRecording"), "recording removal failed"));
    }
  }

  return (
    <div className="app-shell" style={{ minWidth: WINDOW_MIN_WIDTH, minHeight: `max(100vh, ${WINDOW_MIN_HEIGHT}px)` }}>
      <header className="topbar">
        <div>
          <h1>Mumbler</h1>
        </div>
        <div className="topbar__meta">
          {toolsRollUp !== "none" ? (
            <button
              type="button"
              className={`tools-chip tools-chip--${toolsRollUp}`}
              onClick={() => setShowAudioTools(true)}
              title={t("tools.openTitle")}
            >
              {t(toolsChipMessage(toolsRollUp, dependencies))}
            </button>
          ) : null}
          <div className="app-menu-anchor">
            <Menu
              open={isMenuOpen}
              onOpenChange={setIsMenuOpen}
              label={t("menu.label")}
              className="app-menu"
              trigger={(props) => (
                <button
                  {...props}
                  type="button"
                  className="button button--ghost button--icon"
                  aria-label={t("menu.open")}
                >
                  <HamburgerIcon />
                </button>
              )}
            >
              <MenuItem
                className="app-menu-item"
                onSelect={() => {
                  void window.mumbler
                    .openOutputDirectory()
                    .then(() => clearPersistent("output-folder-open"))
                    .catch((error: unknown) =>
                      addPersistent(
                        "output-folder-open",
                        presentFailure(error, message("error.openOutputFolder"), "output folder reveal failed"),
                        "error",
                      ),
                    );
                }}
              >
                {t("menu.openOutputDirectory")}
              </MenuItem>
              <MenuItem
                className="app-menu-item"
                disabled={importFlow.isImporting || settingsModal.isLoadingSettings}
                onSelect={() => void settingsModal.handleOpenSettings()}
              >
                {t("menu.settings")}
              </MenuItem>
              <MenuItem
                className="app-menu-item"
                disabled={snapshot === null || snapshot.dependencies === null}
                onSelect={() => setShowAudioTools(true)}
              >
                {t("menu.managedTools")}
              </MenuItem>
              <MenuItem
                className="app-menu-item"
                disabled={snapshot === null}
                onSelect={() => setShowShortcutsHelp(true)}
              >
                {t("menu.keyboardShortcuts")}
              </MenuItem>
              <MenuItem className="app-menu-item" onSelect={() => setShowAbout(true)}>
                {t("menu.about")}
              </MenuItem>
            </Menu>
          </div>
        </div>
      </header>

      <PersistentNotifications
        notifications={notifications}
        onDismiss={dismissNotification}
      />

      <main
        ref={workspaceRef}
        className="workspace"
        style={{ "--queue-width": `${queueWidth}px` } as CSSProperties}
      >
        <aside
          className={`queue-pane panel${importFlow.isDragActive ? " queue-pane--drag-delivery" : ""}`}
          onDragOver={importFlow.onDragOver}
          onDragLeave={importFlow.onDragLeave}
          onDrop={importFlow.onDrop}
        >
          <div className="panel__header">
            <h2>{t("queue.title")}</h2>
            <div className="toolbar">
              <button
                type="button"
                className="button button--primary"
                onClick={() => void importFlow.handleImportClick()}
                disabled={importFlow.isImporting}
              >
                {importFlow.isImporting ? t("queue.importing") : t("queue.import")}
              </button>
            </div>
          </div>

          <div className="panel__body">
          {importFlow.importResult ? (
            <div
              className={`queue-import-result queue-import-result--${importFlow.importResult.severity}`}
              role={importFlow.importResult.severity === "error" ? "alert" : "status"}
            >
              <span>{text(importFlow.importResult.message)}</span>
              <button
                type="button"
                className="result-close"
                onClick={importFlow.dismissImportResult}
                aria-label={t("import.closeResult")}
              >
                <CloseIcon />
              </button>
            </div>
          ) : null}

          {snapshot?.startupDiagnostic ? (
            <section className="panel panel--nested queue-empty">
              <p className="empty-state__title">{i18n.text(snapshot.startupDiagnostic.title)}</p>
              <p className="empty-state__body">{i18n.text(snapshot.startupDiagnostic.message)}</p>
              <div className="toolbar">
                <button
                  type="button"
                  className="button button--danger"
                  onClick={() => void handleResetState()}
                  disabled={isResettingState}
                >
                  {isResettingState ? t("queue.resetting") : t("queue.resetState")}
                </button>
              </div>
            </section>
          ) : snapshot?.state?.cards.length ? (
            <QueueList
              cards={snapshot.state.cards}
              selectedCardId={snapshot.queueSummary?.selectedCardId ?? null}
              onSelect={(cardId) => void handleCardSelect(cardId)}
            />
          ) : (
            <section className="panel panel--nested queue-empty">
              <p className="empty-state__title">
                {snapshot?.state?.pendingImports.length
                  ? t("queue.pendingTitle")
                  : t("queue.emptyTitle")}
              </p>
              <p className="empty-state__body">
                {snapshot?.state?.pendingImports.length
                  ? t("queue.pendingBody")
                  : t("queue.emptyBody")}
              </p>
            </section>
          )}
          </div>
        </aside>

        <PaneSplitter
          // Start the drag from the displayed width; the handle reports the new
          // INTENT (bounded by the pane's own min/max), which we hold locally while
          // dragging and persist on commit. The displayed width re-derives from that
          // intent against the live workspace, so a drag that overshoots the room is
          // held back visually while the intent is kept for when the window grows.
          width={queueWidth}
          min={QUEUE_WIDTH.min}
          max={QUEUE_WIDTH.max}
          onResize={setQueueDragWidth}
          onCommit={handleQueueSplitterCommit}
        />

        <section className="detail-pane panel">
          <div className="panel__header">
            <h2>{t("detail.title")}</h2>
          </div>

          {selectedCard ? (
            <>
              <div className="panel__strip">
              <div className="app-tabs" {...detailTablist.tablistProps} aria-label={t("detail.steps")}>
                {DETAIL_TABS.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    className={`app-tab${detailTab === tab ? " app-tab--active" : ""}`}
                    {...detailTablist.getTabProps(tab)}
                  >
                    {t(DETAIL_TAB_LABELS[tab])}
                  </button>
                ))}
              </div>
              </div>
              <div className="panel__body">
              <CardActionResults
                cardId={selectedCard.id}
                results={cardActionErrors}
                onDismiss={(operation) => clearCardActionError(selectedCard.id, operation)}
              />
              <div className="detail-grid">

              <div className="app-tabpanel" {...detailTablist.getPanelProps("info")} hidden={detailTab !== "info"}>
                {/* ── Group 1: Detail (3 columns) ─────────────────────── */}
                <div className="detail-row">
                  <section className={`detail-card detail-card--status detail-card--${statusModifier(selectedCard.status)}`}>
                    <div className="detail-card__header">
                      <h3>{t("info.timestamps")}</h3>
                    </div>
                    <dl className="meta-list">
                      <div>
                        <dt>{t("info.originalFilename")}</dt>
                        <dd>{selectedCard.originalFilename}</dd>
                      </div>
                      <div>
                        <dt>{t("info.confirmedLocal")}</dt>
                        <dd>{selectedCard.timestamps.confirmedLocal}</dd>
                      </div>
                      {selectedCard.timestamps.frontTrimOffsetSec > 0 && (
                        <div>
                          <dt>{t("info.effectiveLocal")}</dt>
                          <dd>{selectedCard.timestamps.effectiveLocal}</dd>
                        </div>
                      )}
                      <div>
                        <dt>{t("info.timezone")}</dt>
                        <dd>{selectedCard.timestamps.timezone}</dd>
                      </div>
                      <div>
                        <dt>{t("info.effectiveUtc")}</dt>
                        <dd>{formatUtcForDisplay(selectedCard.timestamps.effectiveUtc)}</dd>
                      </div>
                    </dl>
                  </section>

                  <section className="detail-card">
                    <div className="detail-card__header">
                      <h3>{t("audio.title")}</h3>
                    </div>
                    <dl className="meta-list">
                      <div>
                        <dt>{t("audio.duration")}</dt>
                        <dd>{selectedCard.durationSec === null ? t("common.unknown") : formatDuration(selectedCard.durationSec)}</dd>
                      </div>
                      <div>
                        <dt>{t("audio.format")}</dt>
                        <dd>{(() => {
                          const codec = selectedCard.audioProfile?.codecName ?? null;
                          const container = selectedCard.audioProfile?.formatName ?? null;
                          if (!codec && !container) return t("common.unknown");
                          if (codec === container || !container) return codec ?? t("common.unknown");
                          if (!codec) return container ?? t("common.unknown");
                          return t("audio.codecInContainer", { codec, container });
                        })()}</dd>
                      </div>
                      <div>
                        <dt>{t("audio.bitrate")}</dt>
                        <dd>
                          {selectedCard.audioProfile?.bitRateKbps == null
                            ? t("common.unknown")
                            : t("units.kbps", { value: selectedCard.audioProfile.bitRateKbps })}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("audio.sampleRate")}</dt>
                        <dd>
                          {selectedCard.audioProfile?.sampleRateHz == null
                            ? t("common.unknown")
                            : t("units.hertz", { value: selectedCard.audioProfile.sampleRateHz })}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("audio.channels")}</dt>
                        <dd>{selectedCard.audioProfile?.channels == null ? t("common.unknown") : i18n.number(selectedCard.audioProfile.channels)}</dd>
                      </div>
                      <div>
                        <dt>{t("audio.fileSize")}</dt>
                        <dd>{i18n.bytes(selectedCard.fileSizeBytes)}</dd>
                      </div>
                    </dl>
                  </section>

                  <section className="detail-card">
                    <div className="detail-card__header">
                      <h3>{t("options.title")}</h3>
                    </div>
                    <div className="field-stack">
                      <label className="field">
                        <span>{t("options.transcriptionModel")}</span>
                        <select
                          value={snapshot?.settingsSummary?.transcriptionModel ?? ""}
                          disabled={selectedCardIsBusy}
                          onChange={(event) => void handleDetailModelChange("transcriptionModel", event.target.value)}
                        >
                          {(snapshot?.settingsSummary?.geminiModels ?? []).map((id) => (
                            <option key={id} value={id}>{id}</option>
                          ))}
                          {snapshot?.settingsSummary?.transcriptionModel &&
                            !(snapshot?.settingsSummary?.geminiModels ?? []).includes(snapshot.settingsSummary.transcriptionModel) && (
                            <option value={snapshot.settingsSummary.transcriptionModel}>
                              {snapshot.settingsSummary.transcriptionModel}
                            </option>
                          )}
                        </select>
                      </label>
                      <label className="field">
                        <span>{t("options.metadataModel")}</span>
                        <select
                          value={snapshot?.settingsSummary?.metadataModel ?? ""}
                          disabled={selectedCardIsBusy}
                          onChange={(event) => void handleDetailModelChange("metadataModel", event.target.value)}
                        >
                          {(snapshot?.settingsSummary?.geminiModels ?? []).map((id) => (
                            <option key={id} value={id}>{id}</option>
                          ))}
                          {snapshot?.settingsSummary?.metadataModel &&
                            !(snapshot?.settingsSummary?.geminiModels ?? []).includes(snapshot.settingsSummary.metadataModel) && (
                            <option value={snapshot.settingsSummary.metadataModel}>
                              {snapshot.settingsSummary.metadataModel}
                            </option>
                          )}
                        </select>
                      </label>
                    </div>
                  </section>
                </div>
                <div className="app-tabpanel__footer">
                  <button type="button" className="button button--ghost" onClick={() => setDetailTab("trim")}>
                    {t("common.next")}
                  </button>
                </div>
              </div>

              <div className="app-tabpanel" {...detailTablist.getPanelProps("trim")} hidden={detailTab !== "trim"}>
                {/* ── Group 2: Player and Trim ─────────────────────────── */}
                <section className="detail-card detail-card--wide">
                  <div className="detail-card__header">
                    <h3>{t("trim.title")}</h3>
                  </div>
                  <WaveformEditor
                    ref={waveformEditorRef}
                    card={selectedCard}
                    previewSnippetSeconds={snapshot?.settingsSummary?.previewSnippetSeconds ?? 10}
                    skipIntervalSec={snapshot?.settingsSummary?.skipIntervalSec ?? 5}
                    disabled={selectedCardIsBusy}
                    onDuplicateCard={handleDuplicateCard}
                    onTrimCommit={handleTrimCommit}
                  />
                  <div className="trim-analysis">
                    <div className="trim-analysis__header">
                      <span className="trim-analysis__label">{t("trim.analysis")}</span>
                    </div>
                    <p className="panel__note">{text(describeTrimDecision(selectedCard.trimDecision))}</p>
                    <dl className="trim-analysis-grid">
                      <div>
                        <dt>{t("trim.requestedStart")}</dt>
                        <dd>{formatOptionalSeconds(i18n, selectedCard.trimDecision?.requestedStartSec ?? null)}</dd>
                      </div>
                      <div>
                        <dt>{t("trim.requestedEnd")}</dt>
                        <dd>{formatOptionalSeconds(i18n, selectedCard.trimDecision?.requestedEndSec ?? null)}</dd>
                      </div>
                      <div>
                        <dt>{t("trim.startSearchWindow")}</dt>
                        <dd>
                          {selectedCard.trimDecision?.searchStartFromSec === null || selectedCard.trimDecision?.searchStartFromSec === undefined
                            ? "—"
                            : `${formatOptionalSeconds(i18n, selectedCard.trimDecision.searchStartFromSec)} – ${formatOptionalSeconds(i18n, selectedCard.trimDecision.searchStartToSec ?? null)}`}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("trim.endSearchWindow")}</dt>
                        <dd>
                          {selectedCard.trimDecision?.searchEndFromSec === null || selectedCard.trimDecision?.searchEndFromSec === undefined
                            ? "—"
                            : `${formatOptionalSeconds(i18n, selectedCard.trimDecision.searchEndFromSec)} – ${formatOptionalSeconds(i18n, selectedCard.trimDecision.searchEndToSec ?? null)}`}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("trim.chosenStartBoundary")}</dt>
                        <dd>{formatOptionalSeconds(i18n, selectedCard.trimDecision?.chosenStartBoundarySec ?? null)}</dd>
                      </div>
                      <div>
                        <dt>{t("trim.chosenEndBoundary")}</dt>
                        <dd>{formatOptionalSeconds(i18n, selectedCard.trimDecision?.chosenEndBoundarySec ?? null)}</dd>
                      </div>
                      <div>
                        <dt>{t("trim.startDelta")}</dt>
                        <dd>{formatOptionalSeconds(i18n, selectedCard.trimDecision?.startDeltaSec ?? null)}</dd>
                      </div>
                      <div>
                        <dt>{t("trim.endDelta")}</dt>
                        <dd>{formatOptionalSeconds(i18n, selectedCard.trimDecision?.endDeltaSec ?? null)}</dd>
                      </div>
                      <div className="trim-analysis-grid__reason">
                        <dt>{t("trim.reason")}</dt>
                        <dd>{text(trimDecisionReason(selectedCard.trimDecision))}</dd>
                      </div>
                    </dl>
                  </div>
                </section>
                <div className="app-tabpanel__footer">
                  <button type="button" className="button button--ghost" onClick={() => setDetailTab("transcribe")}>
                    {t("common.next")}
                  </button>
                </div>
              </div>

              <div className="app-tabpanel" {...detailTablist.getPanelProps("transcribe")} hidden={detailTab !== "transcribe"}>
                {/* ── Group 3: Transcription and Metadata ──────────────── */}
                <section className={`detail-card detail-card--wide detail-card--status detail-card--${statusModifier(selectedCard.status)}`}>
                  <div className="detail-card__header">
                    <h3>{t("transcribe.title")}</h3>
                  </div>
                  <div className="action-toolbar">
                    <button
                      type="button"
                      className="button button--primary"
                      onClick={() => executeGenerate(selectedCard.id, "slug")}
                      disabled={selectedCardIsBusy || generateDisabledReason !== null}
                    >
                      {t("command.generateAll")}
                    </button>
                    <button
                      type="button"
                      className="button button--ghost"
                      onClick={() => handleCancelCardProcessing(selectedCard.id)}
                      disabled={!selectedCardIsBusy || selectedCard.status === "Saving"}
                    >
                      {t("common.cancel")}
                    </button>
                  </div>
                  {generateDisabledReason ? (
                    <p className="panel__note">{text(generateDisabledReason)}</p>
                  ) : null}
                  <p className={`panel__note status-text status-text--${statusModifier(selectedCard.status)}`}>
                    {text(formatCardStatusMessage(selectedCard))}
                  </p>
                  {hasStaleResults(selectedCard) ? <p className="panel__note">{text(staleResultsNote)}</p> : null}
                  <div className="result-grid">
                    <label className="field field--tall">
                      <span className="field-label-with-action">
                        <span>{t("result.transcription")}</span>
                        <span className="field-actions">
                          <button
                            type="button"
                            className="button button--ghost button--compact"
                            onClick={() => handleRequestGenerate(selectedCard, "transcription")}
                            disabled={selectedCardIsBusy}
                          >
                            {t("transcribe.generate")}
                          </button>
                          <button
                            type="button"
                            className="button button--ghost button--compact"
                            onClick={() => void handleCopyResult("transcription", selectedCard.transcription.text)}
                            disabled={(selectedCard.transcription.text ?? "").trim().length === 0}
                          >
                            {t("transcribe.copy")}
                          </button>
                        </span>
                      </span>
                      <textarea
                        readOnly
                        className="result-output result-output--tall"
                        value={selectedCard.transcription.text ?? ""}
                        placeholder=""
                      />
                    </label>
                    <div className="result-secondary">
                      <label className="field field--tall">
                        <span className="field-label-with-action">
                          <span>{t("result.structured")}</span>
                          <span className="field-actions">
                            <button
                              type="button"
                              className="button button--ghost button--compact"
                              onClick={() => handleRequestGenerate(selectedCard, "structured")}
                              disabled={selectedCardIsBusy}
                            >
                              {t("transcribe.generate")}
                            </button>
                            <button
                              type="button"
                              className="button button--ghost button--compact"
                              onClick={() => void handleCopyResult("structured", selectedCard.metadata.structured)}
                              disabled={(selectedCard.metadata.structured ?? "").trim().length === 0}
                            >
                              {t("transcribe.copy")}
                            </button>
                          </span>
                        </span>
                        <textarea
                          readOnly
                          className="result-output result-output--structured"
                          value={selectedCard.metadata.structured ?? ""}
                          placeholder=""
                        />
                      </label>
                      <label className="field">
                        <span className="field-label-with-action">
                          <span>{t("result.title")}</span>
                          <span className="field-actions">
                            <button
                              type="button"
                              className="button button--ghost button--compact"
                              onClick={() => handleRequestGenerate(selectedCard, "title")}
                              disabled={selectedCardIsBusy}
                            >
                              {t("transcribe.generate")}
                            </button>
                            <button
                              type="button"
                              className="button button--ghost button--compact"
                              onClick={() => void handleCopyResult("title", selectedCard.metadata.title)}
                              disabled={(selectedCard.metadata.title ?? "").trim().length === 0}
                            >
                              {t("transcribe.copy")}
                            </button>
                          </span>
                        </span>
                        <textarea
                          readOnly
                          className="result-output result-output--short"
                          value={selectedCard.metadata.title ?? ""}
                          placeholder=""
                        />
                      </label>
                      <label className="field">
                        <span className="field-label-with-action">
                          <span>{t("result.slug")}</span>
                          <span className="field-actions">
                            <button
                              type="button"
                              className="button button--ghost button--compact"
                              onClick={() => handleRequestGenerate(selectedCard, "slug")}
                              disabled={selectedCardIsBusy}
                            >
                              {t("transcribe.generate")}
                            </button>
                            <button
                              type="button"
                              className="button button--ghost button--compact"
                              onClick={() => void handleCopyResult("slug", selectedCard.metadata.slug)}
                              disabled={(selectedCard.metadata.slug ?? "").trim().length === 0}
                            >
                              {t("transcribe.copy")}
                            </button>
                          </span>
                        </span>
                        <textarea
                          readOnly
                          className="result-output result-output--slug"
                          value={selectedCard.metadata.slug ?? ""}
                          placeholder=""
                        />
                      </label>
                    </div>
                  </div>
                </section>
                <div className="app-tabpanel__footer">
                  <button type="button" className="button button--ghost" onClick={() => setDetailTab("output")}>
                    {t("common.next")}
                  </button>
                </div>
              </div>

              <div className="app-tabpanel" {...detailTablist.getPanelProps("output")} hidden={detailTab !== "output"}>
                {/* ── Group 4: Output and Save ──────────────────────────── */}
                <section className="detail-card detail-card--wide">
                  <div className="detail-card__header">
                    <h3>{t("output.title")}</h3>
                  </div>
                  <dl className="meta-list compact-meta-list">
                    <div>
                      <dt>{t("output.directory")}</dt>
                      <dd>
                        {snapshot?.settingsSummary?.outputDirectory ??
                          snapshot?.settingsSummary?.defaultOutputDirectory ??
                          ""}
                      </dd>
                    </div>
                    {selectedCard.lastError ? (
                      <div>
                        <dt>{t("output.lastStoppedStep")}</dt>
                        <dd>{text(formatStepName(selectedCard.lastError.failedStep))}</dd>
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
                      {t("output.changeDirectory")}
                    </button>
                  </div>
                  <div className="action-toolbar">
                    <button
                      type="button"
                      className="button button--primary"
                      onClick={() => void handleSaveCard(selectedCard.id)}
                      disabled={saveDisabledReason !== null}
                    >
                      {t("output.saveAndRemove")}
                    </button>
                    <button
                      type="button"
                      className="button button--danger"
                      onClick={() => {
                        setRemoveCardError(null);
                        setPendingRemoveCardId(selectedCard.id);
                      }}
                      disabled={selectedCardIsBusy}
                    >
                      {t("common.remove")}
                    </button>
                  </div>
                  <p className="field-hint">{t("output.hint")}</p>
                  {hasStaleResults(selectedCard) ? <p className="panel__note">{text(staleResultsNote)}</p> : null}
                  {saveDisabledReason && !selectedCardIsBusy ? (
                    <p className="panel__note">{text(saveDisabledReason)}</p>
                  ) : null}
                </section>
              </div>

              </div>
              </div>
            </>
          ) : snapshot?.state?.cards.length ? (
            <div className="panel__body">
              <section className="panel panel--nested queue-empty">
                <p className="empty-state__title">{t("detail.selectRecording")}</p>
              </section>
            </div>
          ) : (
            <div className="panel__body">
              <section className="panel panel--nested queue-empty">
                <p className="empty-state__title">{t("detail.noSelection")}</p>
                <p className="empty-state__body">{t("detail.noSelectionBody")}</p>
              </section>
            </div>
          )}
        </section>
      </main>

      {settingsModal.settingsDraft ? (
        <SettingsModal
          draft={settingsModal.settingsDraft}
          isDirty={settingsModal.isSettingsDirty}
          isSaving={settingsModal.isSavingSettings}
          isSavingApiKey={settingsModal.isSavingApiKey}
          isPickingOutputDirectory={settingsModal.isPickingSettingsOutputDirectory}
          isPickingBackupDirectory={settingsModal.isPickingSettingsBackupDirectory}
          errorMessage={settingsModal.settingsErrorMessage}
          onChange={settingsModal.setSettingsDraft}
          onClose={settingsModal.handleRequestCloseSettings}
          onPickOutputDirectory={() => void settingsModal.handlePickSettingsOutputDirectory()}
          onPickBackupDirectory={() => void settingsModal.handlePickSettingsBackupDirectory()}
          onSetApiKey={(apiKey) => void settingsModal.handleSetGeminiApiKey(apiKey)}
          onClearApiKey={() => void settingsModal.handleClearGeminiApiKey()}
          onRestoreDefaultPrompts={() => void settingsModal.handleRestoreDefaultPrompts()}
          onRestoreDefaultModels={() => void settingsModal.handleRestoreDefaultModels()}
          onSave={() => void settingsModal.handleSaveSettings()}
        />
      ) : null}

      {settingsModal.showDiscardConfirm ? (
        <DiscardSettingsModal
          onKeepEditing={settingsModal.handleCancelDiscardSettings}
          onDiscard={settingsModal.handleConfirmDiscardSettings}
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
          onSetCopyToBackupForAll={(value) =>
            importFlow.setPendingReviewDrafts((current) =>
              current.map((item) => ({ ...item, copyToBackupOnConfirm: value }))
            )
          }
          backupDirectoryLabel={
            snapshot?.settingsSummary?.backupDirectory ??
            snapshot?.settingsSummary?.defaultBackupDirectory ??
            "~/.mumbler/backups"
          }
          isSubmitting={importFlow.isConfirmingReview}
        />
      ) : null}

      {showReviewDiscardConfirm ? (
        <DiscardReviewModal
          onKeepEditing={handleCancelDiscardReview}
          onDiscard={handleConfirmDiscardReview}
        />
      ) : null}

      {pendingSaveConflict ? (
        <SaveConflictModal
          audioPath={pendingSaveConflict.result.audioPath}
          jsonPath={pendingSaveConflict.result.jsonPath}
          markdownPath={pendingSaveConflict.result.markdownPath}
          onCancel={() => {
            setPendingSaveConflict(null);
            setSaveConflictError(null);
          }}
          onOverwrite={() => void handleSaveCard(pendingSaveConflict.cardId, "overwrite")}
          onAddSuffix={() => void handleSaveCard(pendingSaveConflict.cardId, "suffix")}
          errorMessage={saveConflictError}
        />
      ) : null}

      {pendingGenerate ? (
        <GenerateConfirmModal
          title={generateConfirmTitles[pendingGenerate.target]}
          body={pendingGenerate.body}
          onCancel={() => setPendingGenerate(null)}
          onGenerate={handleConfirmGenerate}
        />
      ) : null}

      {snapshot?.appWideError ? (
        <AppWideErrorModal
          title={snapshot.appWideError.title}
          message={snapshot.appWideError.message}
          onDismiss={() => void handleDismissAppWideError()}
        />
      ) : null}

      {pendingRemoveCardId ? (
        <RemoveRecordingModal
          body={getRemoveConfirmBody(
            snapshot?.state?.cards.find((c) => c.id === pendingRemoveCardId) ??
              ({ trim: {}, transcription: {}, metadata: {} } as unknown as MumblerCard),
          )}
          onCancel={() => {
            setPendingRemoveCardId(null);
            setRemoveCardError(null);
          }}
          onRemove={() => void confirmRemoveCard(pendingRemoveCardId)}
          errorMessage={removeCardError}
        />
      ) : null}

      {showAbout ? (
        <AboutModal version={snapshot?.appVersion ?? ""} onClose={() => setShowAbout(false)} />
      ) : null}

      {showShortcutsHelp ? (
        <ShortcutsHelpModal onClose={() => setShowShortcutsHelp(false)} />
      ) : null}

      {showAudioTools && snapshot?.dependencies ? (
        <AudioToolsModal
          dependencies={snapshot.dependencies}
          checkUpdatesAtLaunch={snapshot.settingsSummary?.checkUpdatesAtLaunch ?? true}
          isChecking={
            isCheckingTools ||
            snapshot.dependencies.some(
              (dependency) =>
                dependency.transient.kind === "running" &&
                dependency.transient.operation === "check",
            )
          }
          checkNotice={toolCheckNotice}
          operationError={toolOperationError}
          onProvision={handleProvisionTool}
          onCancelProvision={handleCancelToolProvision}
          onCheck={handleCheckTools}
          onCancelCheck={handleCancelToolCheck}
          onToggleCheckUpdates={handleToggleCheckUpdates}
          onClose={() => {
            // Managed tools is replaceable presentation. Keep application-owned
            // terminal notices across close/reopen; their matching retry paths
            // clear them when a new operation supersedes the old result.
            setShowAudioTools(false);
          }}
        />
      ) : null}

      <ToastNotifications
        notifications={notifications}
        onDismiss={dismissNotification}
      />
    </div>
  );
}
