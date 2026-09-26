import {
  useEffect,
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
import { message, type Message } from "@shared/i18n/translate";

interface UseImportFlowOptions {
  snapshot: AppSnapshot | null;
  onSnapshotUpdate: (snapshot: AppSnapshot) => void;
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
  onSnapshotUpdate,
  onError,
}: UseImportFlowOptions): UseImportFlowResult {
  const [isImporting, setIsImporting] = useState(false);
  const [isConfirmingReview, setIsConfirmingReview] = useState(false);
  const [pendingReviewDrafts, setPendingReviewDrafts] = useState<PendingImportReviewItem[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const [importResult, setImportResult] = useState<ImportResultNotice | null>(null);

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
            "import-review-save",
            presentFailure(error, message("error.reviewSave"), "pending import review save failed"),
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
    // Each part is its own sentence, joined through one catalogue entry, so
    // every count keeps its own plural form and each language sets the spacing.
    const parts: Message[] = [];
    if (imported > 0) parts.push(message("import.imported", { count: imported }));
    if (result.duplicateImports.length > 0) {
      parts.push(message("import.repeated", { files: result.duplicateImports }));
    }
    if (failures.length > 0) {
      parts.push(message("import.failedCount", { count: failures.length }));
      for (const failure of failures) {
        parts.push(message("import.failureItem", {
          file: failure.sourcePath === "" ? message("import.unnamedItem") : failure.sourcePath,
          reason: failure.message,
        }));
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
      onSnapshotUpdate(result.snapshot);
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
    setIsConfirmingReview(true);
    try {
      const nextSnapshot = await window.mumbler.confirmPendingImports(pendingReviewDrafts);
      onSnapshotUpdate(nextSnapshot);
    } catch (error: unknown) {
      onError(
        "import-review-confirm",
        presentFailure(error, message("error.reviewConfirm"), "import timestamp confirmation failed"),
      );
    } finally {
      setIsConfirmingReview(false);
    }
  }

  async function handleCancelPendingImports(): Promise<void> {
    try {
      const nextSnapshot = await window.mumbler.cancelPendingImports(
        pendingReviewDrafts.map((item) => item.id),
      );
      onSnapshotUpdate(nextSnapshot);
      setPendingReviewDrafts([]);
    } catch (error: unknown) {
      // The drafts stay, so the review stays open for the retry the message offers.
      onError(
        "import-review-cancel",
        presentFailure(error, message("error.reviewCancel"), "pending import cancellation failed"),
      );
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
      onSnapshotUpdate(result.snapshot);
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
