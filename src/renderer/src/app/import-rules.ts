import type { PendingImportReviewItem } from "@shared/app-shell";
import { isSupportedAudioImportName } from "@shared/audio-import";

// The pure decisions behind useImportFlow, lifted out of the hook so they are
// testable without a DOM drag event or a React effect.

export interface DroppedPathAdmission {
  paths: string[];
  unavailable: Array<{ sourcePath: string; message: string }>;
}

/** Resolve every delivered file once, preserving unavailable members for the
 * committed result. Duplicate paths deliberately remain in `paths`; the owning
 * main-process boundary applies and reports the shared duplicate policy. */
export function parseDroppedPaths(
  files: ArrayLike<File>,
  getPathForFile: (file: File) => string,
  onDiagnostic?: (error: unknown, source: string) => void,
): DroppedPathAdmission {
  const paths: string[] = [];
  const unavailable: DroppedPathAdmission["unavailable"] = [];
  for (const file of Array.from(files)) {
    try {
      const path = getPathForFile(file);
      if (path) paths.push(path);
      else unavailable.push({
        sourcePath: file.name || "Unavailable dropped item",
        message: "No usable local file path was available.",
      });
    } catch (error: unknown) {
      onDiagnostic?.(error, "dropped file path resolution failed");
      unavailable.push({
        sourcePath: file.name || "Unavailable dropped item",
        message: "The local file path could not be read.",
      });
    }
  }
  return { paths, unavailable };
}

/** Whether the current drag advertises file payloads eligible for delivery. */
export function isFileDrag(dataTransfer: Pick<DataTransfer, "types" | "items">): boolean {
  return (
    Array.from(dataTransfer.types).includes("Files") ||
    Array.from(dataTransfer.items).some((item) => item.kind === "file")
  );
}

export type FileDragOffer = "rejected" | "delivery-only";

/**
 * Classifies a drag without treating Chromium's protected `Files` marker as
 * proof that an importable file is already inspectable.
 */
export function inspectFileDragOffer(
  dataTransfer: Pick<DataTransfer, "types" | "items">,
): FileDragOffer {
  let protectedFile = false;
  let sawFile = false;
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") continue;
    sawFile = true;
    try {
      const file = item.getAsFile();
      if (!file) protectedFile = true;
      else if (isSupportedAudioImportName(file.name)) return "delivery-only";
    } catch {
      protectedFile = true;
    }
  }
  if (protectedFile || (!sawFile && Array.from(dataTransfer.types).includes("Files"))) {
    return "delivery-only";
  }
  return "rejected";
}

/**
 * Reconcile the local in-review drafts against a fresh snapshot's pending
 * imports: keep the user's local edits when the *set of items is unchanged*,
 * otherwise adopt the snapshot. The identity check is the id list joined in
 * order, so it is deliberately order-sensitive and — to protect an in-flight
 * timestamp edit from being clobbered by a snapshot echo — does NOT re-adopt a
 * same-id snapshot whose item *content* changed. Both are accepted trade-offs of
 * preferring the user's edits while the item set holds steady.
 */
export function reconcilePendingReviewDrafts(
  current: PendingImportReviewItem[],
  snapshotImports: PendingImportReviewItem[],
): PendingImportReviewItem[] {
  const currentIds = current.map((item) => item.id).join("|");
  const snapshotIds = snapshotImports.map((item) => item.id).join("|");
  if (currentIds === snapshotIds && current.length > 0) {
    return current;
  }
  return snapshotImports;
}
