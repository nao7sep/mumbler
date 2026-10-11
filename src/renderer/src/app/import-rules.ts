import type { PendingImportReviewItem } from "@shared/app-shell";
import { isSupportedAudioImportName } from "@shared/audio-import";
import { message, type Message } from "@shared/i18n/translate";

// The pure decisions behind useImportFlow, lifted out of the hook so they are
// testable without a DOM drag event or a React effect.

export interface DroppedPathAdmission {
  paths: string[];
  // An item with no name keeps an empty sourcePath, named when it is shown.
  unavailable: Array<{ sourcePath: string; message: Message }>;
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
        sourcePath: file.name,
        message: message("import.noLocalPath"),
      });
    } catch (error: unknown) {
      onDiagnostic?.(error, "dropped file path resolution failed");
      unavailable.push({
        sourcePath: file.name,
        message: message("import.pathUnreadable"),
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

/** Keep each surviving item's review edits while taking membership, ordering
 * and every non-editable field from the authoritative snapshot. */
export function reconcilePendingReviewDrafts(
  current: PendingImportReviewItem[],
  snapshotImports: PendingImportReviewItem[],
): PendingImportReviewItem[] {
  if (current.length === 0) return snapshotImports;
  const draftsById = new Map(current.map((item) => [item.id, item]));
  const next = snapshotImports.map((authoritative) => {
    const draft = draftsById.get(authoritative.id);
    if (!draft) return authoritative;
    const reconciled = {
      ...authoritative,
      localTimestampText: draft.localTimestampText,
      timezone: draft.timezone,
      utcTimestampText: draft.utcTimestampText,
      copyToBackupOnConfirm: draft.copyToBackupOnConfirm,
      deleteOriginalOnConfirm: draft.deleteOriginalOnConfirm,
    };
    return (Object.keys(reconciled) as (keyof PendingImportReviewItem)[]).every(
      (field) => reconciled[field] === draft[field],
    ) ? draft : reconciled;
  });
  return next.length === current.length && next.every((item, index) => item === current[index])
    ? current
    : next;
}
