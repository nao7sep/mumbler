/**
 * Data-backup types (see the data-backup conventions).
 *
 * The index records one entry per captured file state, keyed for change detection by size + mtime
 * (no content hash). Fields are declared in the conventional order so a serialized record reads
 * `{ archivedAt, archivePath, sizeBytes, lastWriteUtc }`.
 */

/** One captured file state, as stored in `backups/index.json`. */
export interface BackupIndexEntry {
  /** The capturing run's UTC file stamp (`yyyymmdd-hhmmss-fff-utc`; older entries may still carry the
   *  whole-second `yyyymmdd-hhmmss-utc` form and remain valid as-is); also the stem of that run's archive,
   *  so the zip holding this entry is `backup-<archivedAt>.zip` — derived, never stored. */
  archivedAt: string;
  /** The file's full entry path within the zip, e.g. `state.json`. */
  archivePath: string;
  /** The file's size in bytes at capture time. */
  sizeBytes: number;
  /** The file's last-write time in UTC, truncated to the whole second (`yyyy-MM-ddTHH:mm:ssZ`). */
  lastWriteUtc: string;
}

/** The whole ledger. */
export interface BackupIndex {
  entries: BackupIndexEntry[];
}

/**
 * One file the selection has decided to consider, already stat'd. `sourcePath` is the absolute path on
 * disk (read only when the file is actually archived); `archivePath` is its mirror-layout entry path;
 * `sizeBytes` and `mtimeMs` are the change signal, `mtimeMs` truncated to the whole second.
 */
export interface BackupCandidate {
  sourcePath: string;
  archivePath: string;
  sizeBytes: number;
  mtimeMs: number;
}

/** A file or root the run could not capture, with the reason it was passed over. */
export interface BackupSkip {
  path: string;
  reason: string;
}

/**
 * The outcome of one run, returned by the engine so the caller — the only place that logs — can record
 * it. The engine never throws for an expected problem: a fatal error goes in `fatal`, a single unreadable
 * file becomes a skip.
 */
export interface BackupReport {
  /** Nothing changed since the last run, so no archive and no index write happened. */
  nothingChanged: boolean;
  /** The archive written this run (`backup-<archivedAt>.zip`), or undefined when nothing was written. */
  archiveFileName?: string;
  /** How many files the archive contains. */
  filesArchived: number;
  /** Files skipped (unreadable, missing, or a case-collision), each with a reason. */
  skips: BackupSkip[];
  /** A corrupt index was found, deleted, and treated as empty — this run is a full backup. */
  indexWasReset: boolean;
  /** An unexpected failure the engine caught rather than propagating; undefined on success. */
  fatal?: unknown;
}
