import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type DragEvent,
} from "react";

import type {
  AppSnapshot,
  ImportOperationResult,
  PendingImportReviewItem,
} from "@shared/app-shell";

import {
  inspectFileDragOffer,
  isFileDrag,
  parseDroppedPaths,
  reconcilePendingReviewDrafts,
} from "./import-rules";
import { isTextEditingTarget } from "./shortcut-utils";
import { presentFailure, reportRendererDiagnostic } from "./presentFailure";
import { fewNames, message, pathValue, type Message } from "@shared/i18n/translate";

interface UseImportFlowOptions {
  snapshot: AppSnapshot | null;
  // The latest snapshot from the window's subscription, which has already
  // arrived when a reply resolves.
  latestSnapshot: () => AppSnapshot | null;
  onError: (owner: string, message: Message) => void;
}

export interface ImportResultNotice {
  message: Message;
  severity: "information" | "warning" | "error";
  issueKeys: string[];
}

interface UseImportFlowResult {
  isImporting: boolean;
  isConfirmingReview: boolean;
  pendingReviewDrafts: PendingImportReviewItem[];
  isDragActive: boolean;
  importResult: ImportResultNotice | null;
  errorMessage: Message | null;
  dismissReviewError: () => void;
  setPendingReviewDrafts: Dispatch<SetStateAction<PendingImportReviewItem[]>>;
  dismissImportResult: () => void;
  handleImportClick: () => Promise<void>;
  handleConfirmPendingImports: () => Promise<void>;
  handleCancelPendingImports: () => Promise<void>;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}

function joinSentences(parts: Message[]): Message {
  return parts.reduceRight((rest, first) => message("common.sentences", { first, rest }));
}

export function useImportFlow({
  snapshot,
  latestSnapshot,
  onError,
}: UseImportFlowOptions): UseImportFlowResult {
  const [isImporting, setIsImporting] = useState(false);
  const [isConfirmingReview, setIsConfirmingReview] = useState(false);
  const [pendingReviewDrafts, updatePendingReviewDrafts] = useState<PendingImportReviewItem[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const [importResult, setImportResult] = useState<ImportResultNotice | null>(null);
  const [errorMessage, setErrorMessage] = useState<Message | null>(null);
  // Claim submission synchronously: React's busy render follows the event, but
  // the native picker and the exact submitted intent already have one owner.
  const confirmingReviewRef = useRef(false);
  const setPendingReviewDrafts: Dispatch<SetStateAction<PendingImportReviewItem[]>> = (action) => {
    if (!confirmingReviewRef.current) {
      setErrorMessage(null);
      updatePendingReviewDrafts(action);
    }
  };
  // The review edits still waiting out the debounce, and what sends them.
  const unsentDrafts = useRef<{ timer: number; send: () => Promise<void> } | null>(null);

  function resetDragState(): void {
    setIsDragActive(false);
  }

  useEffect(() => {
    const reset = (): void => resetDragState();
    window.addEventListener("blur", reset);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("blur", reset);
      window.removeEventListener("dragend", reset);
    };
  }, []);

  useEffect(() => {
    const snapshotImports = snapshot?.state?.pendingImports ?? [];
    updatePendingReviewDrafts((current) => reconcilePendingReviewDrafts(current, snapshotImports));
  }, [snapshot?.state?.pendingImports]);

  useEffect(() => {
    if (pendingReviewDrafts.length === 0) {
      return;
    }

    let sending: Promise<void> | null = null;
    const send = (): Promise<void> => {
      sending ??= window.mumbler.updatePendingImportDrafts(pendingReviewDrafts).then(() => {
        if (unsentDrafts.current?.send === send) unsentDrafts.current = null;
      }, (error: unknown) => {
        sending = null;
        onError(
          "import-review-save",
          presentFailure(error, message("error.reviewSave"), "pending import review save failed"),
        );
        throw error;
      });
      return sending;
    };
    const timer = window.setTimeout(() => {
      void send().catch(() => undefined);
    }, 250);
    unsentDrafts.current = { timer, send };

    return () => {
      window.clearTimeout(timer);
      if (unsentDrafts.current?.timer === timer) unsentDrafts.current = null;
    };
  }, [pendingReviewDrafts]);

  // A quit sends the edits the debounce still holds, instead of dropping them
  // (unsaved-edits conventions, Quitting).
  useEffect(() => window.mumbler.onFlushPendingEdits(async () => {
    const unsent = unsentDrafts.current;
    if (unsent === null) return;
    window.clearTimeout(unsent.timer);
    await unsent.send();
  }), []);

  function resultKey(sourcePath: string): string {
    return `source:${sourcePath}`;
  }

  function coversKeys(resolved: readonly string[], issues: readonly string[]): boolean {
    const resolvedSet = new Set(resolved);
    const issueSet = new Set(issues);
    return issueSet.size > 0 && [...issueSet].every((key) => resolvedSet.has(key));
  }

  function presentImportResult(
    result: Pick<
      ImportOperationResult,
      "attemptedPaths" | "importedCount" | "failedImports" | "duplicateImports"
    >,
    unavailable: Array<{ sourcePath: string; message: Message }> = [],
  ): void {
    const failures = [...result.failedImports, ...unavailable.map((failure) => ({
      ...failure,
      kind: "invalid" as const,
    }))];
    const attemptedKeys = [
      ...result.attemptedPaths.map(resultKey),
      ...unavailable.map((failure) => resultKey(failure.sourcePath)),
    ];
    if (failures.length === 0 && result.duplicateImports.length === 0) {
      if (attemptedKeys.length > 0) {
        setImportResult((current) =>
          current !== null && coversKeys(attemptedKeys, current.issueKeys) ? null : current
        );
      }
      return;
    }
    const imported = result.importedCount;
    const fileName = (sourcePath: string) => sourcePath === "" ? message("import.unnamedItem") : pathValue(sourcePath);
    // Each part is its own sentence, joined through one catalogue entry, so
    // every count keeps its own plural form and each language sets the spacing.
    // Repeated files are named a few and counted (interface-styling-
    // conventions, Labels); each failure is read with its reason, the strip
    // scrolling once they pass a few lines.
    const parts: Message[] = [];
    if (imported > 0) parts.push(message("import.imported", { count: imported }));
    if (result.duplicateImports.length > 0) {
      parts.push(message("import.repeated", { files: fewNames(result.duplicateImports.map(pathValue)) }));
    }
    if (failures.length > 0) {
      parts.push(message("import.failedCount", { count: failures.length }));
      for (const failure of failures) {
        parts.push(message("import.failureItem", { file: fileName(failure.sourcePath), reason: failure.message }));
      }
    }
    setImportResult({
      severity: failures.some((failure) => failure.kind === "failure")
        ? "error"
        : failures.length > 0
          ? "warning"
          : "information",
      message: joinSentences(parts),
      issueKeys: [
        ...failures.map((failure) => resultKey(failure.sourcePath)),
        ...result.duplicateImports.map(resultKey),
      ],
    });
  }

  async function handleImportClick(): Promise<void> {
    setIsImporting(true);
    try {
      const result = await window.mumbler.openImportDialog();
      presentImportResult(result);
    } catch (error: unknown) {
      setImportResult({
        severity: "error",
        message: presentFailure(error, message("error.importPicker"), "file picker import failed"),
        issueKeys: ["operation:file-picker"],
      });
    } finally {
      setIsImporting(false);
    }
  }

  async function handleConfirmPendingImports(): Promise<void> {
    if (confirmingReviewRef.current) return;
    confirmingReviewRef.current = true;
    setErrorMessage(null);
    const submittedDrafts = pendingReviewDrafts.map((item) => ({ ...item }));
    setIsConfirmingReview(true);
    try {
      if (submittedDrafts.some((item) => item.copyToBackupOnConfirm) && snapshot?.settingsSummary?.backupDirectory == null) {
        await window.mumbler.chooseOriginalsDirectory();
        if (latestSnapshot()?.settingsSummary?.backupDirectory == null) return;
      }
      const result = await window.mumbler.confirmPendingImports(submittedDrafts);
      // The recordings are in the queue; an original that was not backed up or
      // deleted as asked is a warning on that success, kept until dismissed.
      if (result.originalWarnings.length > 0) {
        setImportResult({
          severity: "warning",
          message: joinSentences(result.originalWarnings.map((warning) => warning.message)),
          issueKeys: result.originalWarnings.map((warning) => resultKey(warning.sourcePath)),
        });
      }
    } catch (error: unknown) {
      setErrorMessage(presentFailure(error, message("error.reviewConfirm"), "import timestamp confirmation failed"));
    } finally {
      confirmingReviewRef.current = false;
      setIsConfirmingReview(false);
    }
  }

  async function handleCancelPendingImports(): Promise<void> {
    setErrorMessage(null);
    try {
      await window.mumbler.cancelPendingImports(
        pendingReviewDrafts.map((item) => item.id),
      );
      setPendingReviewDrafts([]);
    } catch (error: unknown) {
      // The drafts stay, so the review stays open for the retry the message offers.
      setErrorMessage(presentFailure(error, message("error.reviewCancel"), "pending import cancellation failed"));
    }
  }

  async function handleDroppedPaths(
    paths: string[],
    unavailable: Array<{ sourcePath: string; message: Message }> = [],
  ): Promise<void> {
    if (paths.length === 0) {
      return;
    }

    setIsImporting(true);
    try {
      const result = await window.mumbler.importDroppedPaths(paths);
      presentImportResult(result, unavailable);
    } catch (error: unknown) {
      setImportResult({
        severity: "error",
        message: presentFailure(error, message("error.importDrop"), "dropped import failed"),
        issueKeys: paths.map(resultKey),
      });
    } finally {
      setIsImporting(false);
    }
  }

  function onDragOver(event: DragEvent<HTMLElement>): void {
    const offer = inspectFileDragOffer(event.dataTransfer);
    if (offer === "rejected" && isTextEditingTarget(event.target)) return;
    // Queue owns every remaining drop boundary so Chromium cannot
    // navigate or open rejected data.
    event.preventDefault();
    event.stopPropagation();
    if (offer === "rejected") {
      event.dataTransfer.dropEffect = "none";
      resetDragState();
      return;
    }

    // Chromium needs the transport action to deliver the native offer. Browser
    // file items are not local-path provenance, so presentation stays neutral.
    event.dataTransfer.dropEffect = "copy";
    setIsDragActive(true);
  }

  function onDragLeave(event: DragEvent<HTMLElement>): void {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    resetDragState();
  }

  function onDrop(event: DragEvent<HTMLElement>): void {
    const acceptsDrop = isFileDrag(event.dataTransfer);
    if (!acceptsDrop && isTextEditingTarget(event.target)) return;
    // Consume the browser default for every remaining payload; acceptance below
    // controls only Mumbler's import behavior and visual affordance.
    event.preventDefault();
    event.stopPropagation();
    resetDragState();
    if (!acceptsDrop) {
      setImportResult({
        severity: "warning",
        message: message("import.nonFileDrop"),
        issueKeys: ["offer:non-file"],
      });
      return;
    }

    const admission = parseDroppedPaths(event.dataTransfer.files, (file) =>
      window.mumbler.getPathForFile(file),
      reportRendererDiagnostic,
    );

    if (admission.paths.length === 0) {
      presentImportResult({
        attemptedPaths: [],
        importedCount: 0,
        failedImports: [],
        duplicateImports: [],
      }, admission.unavailable);
      return;
    }

    void handleDroppedPaths(admission.paths, admission.unavailable);
  }

  return {
    isImporting,
    isConfirmingReview,
    pendingReviewDrafts,
    isDragActive,
    importResult,
    errorMessage,
    dismissReviewError: () => setErrorMessage(null),
    setPendingReviewDrafts,
    dismissImportResult: () => setImportResult(null),
    handleImportClick,
    handleConfirmPendingImports,
    handleCancelPendingImports,
    onDragOver,
    onDragLeave,
    onDrop,
  };
}
