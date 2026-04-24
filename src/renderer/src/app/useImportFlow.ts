import { useEffect, useState, type Dispatch, type SetStateAction, type DragEvent } from "react";

import type { AppSnapshot, PendingImportReviewItem } from "@shared/app-shell";

interface UseImportFlowOptions {
  snapshot: AppSnapshot | null;
  onSnapshotUpdate: (snapshot: AppSnapshot) => void;
  onError: (message: string | null) => void;
  onPersistentNotice: (message: string) => void;
}

interface UseImportFlowResult {
  isImporting: boolean;
  isConfirmingReview: boolean;
  pendingReviewDrafts: PendingImportReviewItem[];
  isDragActive: boolean;
  setPendingReviewDrafts: Dispatch<SetStateAction<PendingImportReviewItem[]>>;
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
  onPersistentNotice,
}: UseImportFlowOptions): UseImportFlowResult {
  const [isImporting, setIsImporting] = useState(false);
  const [isConfirmingReview, setIsConfirmingReview] = useState(false);
  const [pendingReviewDrafts, setPendingReviewDrafts] = useState<PendingImportReviewItem[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);

  useEffect(() => {
    const snapshotImports = snapshot?.state?.pendingImports ?? [];
    setPendingReviewDrafts((current) => {
      const currentIds = current.map((item) => item.id).join("|");
      const snapshotIds = snapshotImports.map((item) => item.id).join("|");
      if (currentIds === snapshotIds && current.length > 0) {
        return current;
      }
      return snapshotImports;
    });
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

  async function handleImportClick(): Promise<void> {
    setIsImporting(true);
    try {
      const result = await window.mumbler.openImportDialog();
      onSnapshotUpdate(result.snapshot);
      for (const failure of result.failedImports) {
        onPersistentNotice(`Import failed: ${failure.sourcePath} — ${failure.message}`);
      }
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

  async function handleDroppedPaths(paths: string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }

    setIsImporting(true);
    try {
      const result = await window.mumbler.importDroppedPaths(paths);
      onSnapshotUpdate(result.snapshot);
      for (const failure of result.failedImports) {
        onPersistentNotice(`Import failed: ${failure.sourcePath} — ${failure.message}`);
      }
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
      .map((file) => window.mumbler.getPathForFile(file))
      .filter((value) => value.length > 0);

    if (paths.length === 0) {
      onError("No valid file paths found in the dropped items.");
      return;
    }

    void handleDroppedPaths(paths);
  }

  return {
    isImporting,
    isConfirmingReview,
    pendingReviewDrafts,
    isDragActive,
    setPendingReviewDrafts,
    handleImportClick,
    handleConfirmPendingImports,
    handleCancelPendingImports,
    onDragOver,
    onDragLeave,
    onDrop,
  };
}
