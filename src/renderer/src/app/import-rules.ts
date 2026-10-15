import type { PendingImportReviewItem, RecordingTimeCandidate } from "@shared/app-shell";
import { isSupportedAudioImportName } from "@shared/audio-import";
import { message, type Message } from "@shared/i18n/translate";
import { formatUtcForDisplay, recomputeLocalFromUtc, recomputeUtcFromLocal } from "@shared/timestamps";

/** A found time as the item's zone shows it, or null when it cannot be shown there. */
export function candidateLocalText(item: Pick<PendingImportReviewItem, "timezone">, candidate: RecordingTimeCandidate): string | null {
  if (candidate.utcMs === null) return candidate.localText;
  const local = recomputeLocalFromUtc(candidate.utcMs, item.timezone);
  return local.error === null ? local.localTimestampText : null;
}

export interface FoundTime {
  /** The time as the item's zone shows it. */
  localText: string;
  /** Where it was found, each once, in the order the review lists them. */
  sources: RecordingTimeCandidate["source"][];
  /** The candidate that choosing this time applies. */
  candidate: RecordingTimeCandidate;
}

/** The found times as the review offers them: one per distinct time in the
 * item's zone, naming every source that found it, so agreeing sources share a
 * button and only disagreeing ones add another. */
export function foundTimes(item: Pick<PendingImportReviewItem, "timezone" | "timeCandidates">): FoundTime[] {
  const times = new Map<string, FoundTime>();
  for (const candidate of item.timeCandidates) {
    const localText = candidateLocalText(item, candidate);
    if (localText === null) continue;
    const found = times.get(localText);
    if (found === undefined) times.set(localText, { localText, sources: [candidate.source], candidate });
    else if (!found.sources.includes(candidate.source)) found.sources.push(candidate.source);
  }
  return [...times.values()];
}

/** Whether the item's time is one only the file's own dates gave: copying or
 * syncing often changes them, so the review warns while such a time is chosen.
 * A file date that the name or a stored time agrees with shares their button,
 * and is not warned about. */
export function usesOnlyFileDates(item: Pick<PendingImportReviewItem, "timezone" | "timeCandidates" | "localTimestampText">): boolean {
  return foundTimes(item).some((found) => found.localText === item.localTimestampText
    && found.sources.every((source) => source === "file-created" || source === "file-modified"));
}

/** The review item with a found time chosen: an exact time keeps its instant
 * and shows it in the item's zone; a local one is read in that zone. */
export function chooseRecordingTime(item: PendingImportReviewItem, candidate: RecordingTimeCandidate): PendingImportReviewItem {
  const localText = candidateLocalText(item, candidate);
  if (localText === null) return item;
  if (candidate.utcMs !== null) {
    return { ...item, localTimestampText: localText, utcTimestampText: formatUtcForDisplay(candidate.utcMs) };
  }
  const utc = recomputeUtcFromLocal(localText, item.timezone);
  return {
    ...item,
    localTimestampText: localText,
    utcTimestampText: utc.error === null && utc.utcMs !== null ? formatUtcForDisplay(utc.utcMs) : item.utcTimestampText,
  };
}

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
    // The found times arrive as a new array with every snapshot; they are
    // facts of the file, so equal contents are the same.
    return (Object.keys(reconciled) as (keyof PendingImportReviewItem)[]).every(
      (field) => field === "timeCandidates"
        ? JSON.stringify(reconciled.timeCandidates) === JSON.stringify(draft.timeCandidates)
        : reconciled[field] === draft[field],
    ) ? draft : reconciled;
  });
  return next.length === current.length && next.every((item, index) => item === current[index])
    ? current
    : next;
}
