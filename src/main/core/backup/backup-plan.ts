/**
 * The pure change decision: given the current candidates and the existing index, return the ones a run
 * must capture. A candidate is captured when its `(size, mtime)` differs from the latest recorded state
 * for its archive path — where two modification times within {@link MTIME_MATCH_TOLERANCE_MS} count as
 * equal. No content hashing (see the data-backup conventions): every real edit moves the mtime, and the
 * tolerance absorbs FAT/exFAT's two-second granularity on USB drives.
 */
import type { BackupCandidate, BackupIndex, BackupIndexEntry } from "./backup-types.js";

/**
 * The modification-time equality window, in milliseconds. Two seconds absorbs FAT/exFAT's 2-second mtime
 * granularity (data may live on a USB stick); it costs nothing in missed edits because the recorded time
 * is from a prior backup run, which any real edit moves well beyond two seconds past.
 */
export const MTIME_MATCH_TOLERANCE_MS = 2000;

/** Returns the candidates whose size or modification time differs from the latest index entry for their
 *  archive path (a candidate with no prior entry is always new). */
export function selectChanged(
  candidates: readonly BackupCandidate[],
  index: BackupIndex,
): BackupCandidate[] {
  const latest = latestByPath(index);
  return candidates.filter((candidate) => isChanged(candidate, latest));
}

function isChanged(candidate: BackupCandidate, latest: Map<string, BackupIndexEntry>): boolean {
  const entry = latest.get(candidate.archivePath);
  if (!entry) return true;
  if (entry.sizeBytes !== candidate.sizeBytes) return true;

  // A stored timestamp that cannot be parsed (a hand-mangled index) is treated as a mismatch, so the file
  // is recaptured rather than silently trusted.
  const recordedMs = Date.parse(entry.lastWriteUtc);
  if (Number.isNaN(recordedMs)) return true;

  return Math.abs(candidate.mtimeMs - recordedMs) > MTIME_MATCH_TOLERANCE_MS;
}

/** The latest entry per archive path. `archivedAt` is a `yyyymmdd-hhmmss-utc` stamp, so ordinal string
 *  comparison is chronological. */
function latestByPath(index: BackupIndex): Map<string, BackupIndexEntry> {
  const latest = new Map<string, BackupIndexEntry>();
  for (const entry of index.entries) {
    const current = latest.get(entry.archivePath);
    if (!current || entry.archivedAt >= current.archivedAt) {
      latest.set(entry.archivePath, entry);
    }
  }
  return latest;
}
