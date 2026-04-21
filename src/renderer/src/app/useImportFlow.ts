import { useEffect, useState, type Dispatch, type SetStateAction, type DragEvent } from "react";

import type { AppSnapshot, FailedImport, PendingImportReviewItem } from "@shared/app-shell";

interface UseImportFlowOptions {
  snapshot: AppSnapshot | null;
  onSnapshotUpdate: (snapshot: AppSnapshot) => void;
  onError: (message: string | null) => void;
}

interface UseImportFlowResult {
  isImporting: boolean;
  isConfirmingReview: boolean;
  pendingReviewDrafts: PendingImportReviewItem[];
  importFailures: FailedImport[];
  isDragActive: boolean;
  setPendingReviewDrafts: Dispatch<SetStateAction<PendingImportReviewItem[]>>;
  setImportFailures: Dispatch<SetStateAction<FailedImport[]>>;
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
  const [importFailures, setImportFailures] = useState<FailedImport[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);

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
          onSnapshotUpdate(nextSnapshot);
        })
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
  }, [pendingReviewDrafts, snapshot?.state]);

  async function handleImportClick(): Promise<void> {
    setIsImporting(true);
    try {
      const result = await window.mumbler.openImportDialog();
      onSnapshotUpdate(result.snapshot);
      setImportFailures(result.failedImports);
      onError(null);
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setIsImporting(false);
    }
  }

  async function handleConfirmPendingImports(): Promise<void> {
    setIsConfirmingReview(true);
    try {
      const nextSnapshot = await window.mumbler.confirmPendingImports(pendingReviewDrafts);
      onSnapshotUpdate(nextSnapshot);
      setImportFailures([]);
      onError(null);
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
      onError(null);
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : "Failed to cancel import.");
    }
    setPendingReviewDrafts([]);
  }

  async function handleDroppedPaths(paths: string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }

    setIsImporting(true);
    try {
      const result = await window.mumbler.importDroppedPaths(paths);
      onSnapshotUpdate(result.snapshot);
      setImportFailures(result.failedImports);
      onError(null);
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : "Dropped import failed.");
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
      .map((file) => ((file as any).path as string | undefined) ?? "")
      .filter((value) => value.length > 0);

    if (paths.length === 0) {
      onError("Drop could not read file paths. Please use the Import button instead.");
      return;
    }

    void handleDroppedPaths(paths);
  }

  return {
    isImporting,
    isConfirmingReview,
    pendingReviewDrafts,
    importFailures,
    isDragActive,
    setPendingReviewDrafts,
    setImportFailures,
    handleImportClick,
    handleConfirmPendingImports,
    handleCancelPendingImports,
    onDragOver,
    onDragLeave,
    onDrop,
  };
}
