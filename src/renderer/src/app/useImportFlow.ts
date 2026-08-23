import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type DragEvent,
} from "react";

import type { AppSnapshot, PendingImportReviewItem } from "@shared/app-shell";

import { isFileDrag, parseDroppedPaths, reconcilePendingReviewDrafts } from "./import-rules";

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
    // The workspace owns every drop boundary so Chromium cannot navigate or open a
    // rejected URL/text payload. Rejected data still advertises no accepted action.
    event.preventDefault();
    if (!isFileDrag(event.dataTransfer)) {
      event.dataTransfer.dropEffect = "none";
      resetDragState();
      return;
    }

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
    // Consume the browser default even for rejected payloads; acceptance below
    // controls only Mumbler's import behavior and visual affordance.
    event.preventDefault();
    const acceptsDrop = isFileDrag(event.dataTransfer);
    resetDragState();
    if (!acceptsDrop) {
      return;
    }

    const paths = parseDroppedPaths(event.dataTransfer.files, (file) =>
      window.mumbler.getPathForFile(file),
    );

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
