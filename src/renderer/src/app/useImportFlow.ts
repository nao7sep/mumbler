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
import { isTextEditingDropTarget } from "./external-drop-boundary";

interface UseImportFlowOptions {
  snapshot: AppSnapshot | null;
  onSnapshotUpdate: (snapshot: AppSnapshot) => void;
  onError: (message: string | null) => void;
}

export interface ImportResultNotice {
  message: string;
  severity: "information" | "warning" | "error";
  issueKeys: string[];
}

interface UseImportFlowResult {
  isImporting: boolean;
  isConfirmingReview: boolean;
  pendingReviewDrafts: PendingImportReviewItem[];
  isDragActive: boolean;
  importResult: ImportResultNotice | null;
  setPendingReviewDrafts: Dispatch<SetStateAction<PendingImportReviewItem[]>>;
  dismissImportResult: () => void;
  handleImportClick: () => Promise<void>;
  handleConfirmPendingImports: () => Promise<void>;
  handleCancelPendingImports: () => Promise<void>;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}

export function useImportFlow({
  snapshot,
  onSnapshotUpdate,
  onError,
}: UseImportFlowOptions): UseImportFlowResult {
  const [isImporting, setIsImporting] = useState(false);
  const [isConfirmingReview, setIsConfirmingReview] = useState(false);
  const [pendingReviewDrafts, setPendingReviewDrafts] = useState<PendingImportReviewItem[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const [importResult, setImportResult] = useState<ImportResultNotice | null>(null);
  const dragResetTimerRef = useRef<number | null>(null);

  function clearDragResetTimer(): void {
    if (dragResetTimerRef.current !== null) {
      window.clearTimeout(dragResetTimerRef.current);
      dragResetTimerRef.current = null;
    }
  }

  function resetDragState(): void {
    clearDragResetTimer();
    setIsDragActive(false);
  }

  function scheduleDragReset(): void {
    clearDragResetTimer();
    dragResetTimerRef.current = window.setTimeout(() => {
      dragResetTimerRef.current = null;
      setIsDragActive(false);
    }, 1000);
  }

  useEffect(() => {
    const reset = (): void => resetDragState();
    window.addEventListener("blur", reset);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("blur", reset);
      window.removeEventListener("dragend", reset);
      clearDragResetTimer();
    };
  }, []);

  useEffect(() => {
    const snapshotImports = snapshot?.state?.pendingImports ?? [];
    setPendingReviewDrafts((current) => reconcilePendingReviewDrafts(current, snapshotImports));
  }, [snapshot?.state?.pendingImports]);

  useEffect(() => {
    if (pendingReviewDrafts.length === 0) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void window.mumbler
        .updatePendingImportDrafts(pendingReviewDrafts)
        .catch((error: unknown) => {
          onError(
            error instanceof Error
              ? error.message
              : "Failed to persist pending timestamp review edits.",
          );
        });
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [pendingReviewDrafts]);

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
    unavailable: Array<{ sourcePath: string; message: string }> = [],
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
    const failureText = failures
      .map((failure) => `${failure.sourcePath} — ${failure.message}`)
      .join("; ");
    const parts: string[] = [];
    if (imported > 0) parts.push(`Imported ${imported} file${imported === 1 ? "" : "s"}`);
    if (result.duplicateImports.length > 0) {
      parts.push(`Repeated in this import: ${result.duplicateImports.join(", ")}`);
    }
    if (failures.length > 0) {
      parts.push(
        `${failures.length} item${failures.length === 1 ? "" : "s"} could not be imported: ${failureText}`,
      );
    }
    setImportResult({
      severity: failures.some((failure) => failure.kind === "failure")
        ? "error"
        : failures.length > 0
          ? "warning"
          : "information",
      message: `${parts.join("; ")}.`,
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
      onSnapshotUpdate(result.snapshot);
      presentImportResult(result);
    } catch (error: unknown) {
      setImportResult({
        severity: "error",
        message: error instanceof Error ? error.message : "Import failed.",
        issueKeys: ["operation:file-picker"],
      });
    } finally {
      setIsImporting(false);
    }
  }

  async function handleConfirmPendingImports(): Promise<void> {
    setIsConfirmingReview(true);
    try {
      const nextSnapshot = await window.mumbler.confirmPendingImports(pendingReviewDrafts);
      onSnapshotUpdate(nextSnapshot);
    } catch (error: unknown) {
      onError(
        error instanceof Error ? error.message : "Failed to confirm imported timestamps.",
      );
    } finally {
      setIsConfirmingReview(false);
    }
  }

  async function handleCancelPendingImports(): Promise<void> {
    try {
      const nextSnapshot = await window.mumbler.cancelPendingImports();
      onSnapshotUpdate(nextSnapshot);
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : "Failed to cancel import.");
    }
    setPendingReviewDrafts([]);
  }

  async function handleDroppedPaths(
    paths: string[],
    unavailable: Array<{ sourcePath: string; message: string }> = [],
  ): Promise<void> {
    if (paths.length === 0) {
      return;
    }

    setIsImporting(true);
    try {
      const result = await window.mumbler.importDroppedPaths(paths);
      onSnapshotUpdate(result.snapshot);
      presentImportResult(result, unavailable);
    } catch (error: unknown) {
      setImportResult({
        severity: "error",
        message: error instanceof Error ? error.message : "Dropped import failed.",
        issueKeys: paths.map(resultKey),
      });
    } finally {
      setIsImporting(false);
    }
  }

  function onDragOver(event: DragEvent<HTMLElement>): void {
    const offer = inspectFileDragOffer(event.dataTransfer);
    if (offer === "rejected" && isTextEditingDropTarget(event.target)) return;
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
    scheduleDragReset();
  }

  function onDragLeave(event: DragEvent<HTMLElement>): void {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    resetDragState();
  }

  function onDrop(event: DragEvent<HTMLElement>): void {
    const acceptsDrop = isFileDrag(event.dataTransfer);
    if (!acceptsDrop && isTextEditingDropTarget(event.target)) return;
    // Consume the browser default for every remaining payload; acceptance below
    // controls only Mumbler's import behavior and visual affordance.
    event.preventDefault();
    event.stopPropagation();
    resetDragState();
    if (!acceptsDrop) {
      setImportResult({
        severity: "warning",
        message: "Queue accepts local audio files from Finder or Import.",
        issueKeys: ["offer:non-file"],
      });
      return;
    }

    const admission = parseDroppedPaths(event.dataTransfer.files, (file) =>
      window.mumbler.getPathForFile(file),
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
