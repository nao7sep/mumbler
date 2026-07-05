/**
 * Runs one backup pass and returns a {@link BackupReport}. It never throws for an expected problem (a
 * fatal error is captured in the report) and never logs — the caller logs the report. See the data-backup
 * conventions: change is size + mtime, the archive mirrors `~/.mumbler/`, and the archive is written and
 * renamed into place *before* the index so a crash never records a phantom backup.
 */
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { nanoid } from "nanoid";
import yazl from "yazl";
import { formatUtcMarkerMs } from "@shared/timestamps";
import { writeJsonFile } from "../file-io.js";
import { collectRoots } from "./backup-collector.js";
import { selectChanged } from "./backup-plan.js";
import { toIsoSeconds } from "./backup-time.js";
import type { BackupCandidate, BackupIndex, BackupReport, BackupSkip } from "./backup-types.js";

/** Where a run reads and writes: the home root to walk, the backups directory, and the index file. */
export interface BackupLocations {
  homeDir: string;
  backupsDir: string;
  indexPath: string;
}

/** Captures everything changed since the last run. `now` is a parameter so the archive stamp is
 *  deterministic under test. */
export async function runBackup(locations: BackupLocations, now: Date): Promise<BackupReport> {
  try {
    return await runCore(locations, now);
  } catch (fatal) {
    return { nothingChanged: false, filesArchived: 0, skips: [], indexWasReset: false, fatal };
  }
}

async function runCore(locations: BackupLocations, now: Date): Promise<BackupReport> {
  const { index, indexWasReset } = await loadIndex(locations.indexPath);
  const { candidates, skips } = await collectRoots(locations.homeDir);

  const changed = selectChanged(candidates, index);
  if (changed.length === 0) {
    return { nothingChanged: true, filesArchived: 0, skips, indexWasReset };
  }

  const written = await writeArchive(locations.backupsDir, now, changed, skips);
  if (written === null) {
    // Every changed file vanished before it could be archived; nothing was written, nothing is recorded.
    return { nothingChanged: true, filesArchived: 0, skips, indexWasReset };
  }

  for (const item of written.archived) {
    index.entries.push({
      archivedAt: written.archivedAt,
      archivePath: item.archivePath,
      sizeBytes: item.sizeBytes,
      lastWriteUtc: toIsoSeconds(item.mtimeMs),
    });
  }
  // Index second: the archive is already in place, so a crash here just re-captures next run.
  await writeJsonFile(locations.indexPath, index);

  return {
    nothingChanged: false,
    archiveFileName: written.archiveFileName,
    filesArchived: written.archived.length,
    skips,
    indexWasReset,
  };
}

async function loadIndex(indexPath: string): Promise<{ index: BackupIndex; indexWasReset: boolean }> {
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, "utf-8");
  } catch (err) {
    // Absent index (first run, or freshly relocated root) is normal: back up everything.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { index: { entries: [] }, indexWasReset: false };
    }
    // Unreadable for another reason — treat as reset (full backup) rather than fail the run.
    return { index: { entries: [] }, indexWasReset: true };
  }

  try {
    const parsed = JSON.parse(raw) as BackupIndex;
    if (!parsed || !Array.isArray(parsed.entries)) throw new Error("malformed index");
    return { index: { entries: parsed.entries }, indexWasReset: false };
  } catch {
    // A corrupt index is deleted and treated as empty: the run becomes a full backup, costing one
    // redundant archive, never data.
    await tryDelete(indexPath);
    return { index: { entries: [] }, indexWasReset: true };
  }
}

/** Streams the changed files to a temp zip, then claims a free `backup-<archivedAt>.zip` name — advancing
 *  the millisecond stamp (the no-clobber rule from the data-backup conventions) when `now`'s stamp is
 *  already taken, e.g. by a second run landing in the same millisecond — and renames the temp file into
 *  place under that name. Returns the files actually archived (a file that vanished since collection is
 *  skipped, not recorded) together with the winning stamp and archive name, so the caller records index
 *  entries under the same stamp the zip actually landed at. Returns `null` when every changed file vanished
 *  before archiving, in which case nothing is written. */
async function writeArchive(
  backupsDir: string,
  now: Date,
  changed: readonly BackupCandidate[],
  skips: BackupSkip[],
): Promise<{ archived: BackupCandidate[]; archivedAt: string; archiveFileName: string } | null> {
  const dir = await ensureBackupsDir(backupsDir);
  const tempPath = path.join(dir, `backup-${formatUtcMarkerMs(now)}-${nanoid(8)}.tmp`);

  const zip = new yazl.ZipFile();
  const archived: BackupCandidate[] = [];
  for (const item of changed) {
    if (!(await exists(item.sourcePath))) {
      skips.push({ path: item.archivePath, reason: "vanished before archive" });
      continue;
    }
    zip.addFile(item.sourcePath, item.archivePath);
    archived.push(item);
  }
  if (archived.length === 0) {
    return null;
  }

  zip.end();
  try {
    await pipeline(zip.outputStream, createWriteStream(tempPath));
    const claimed = await claimArchiveName(dir, now);
    await fs.rename(tempPath, claimed.finalPath);
    return { archived, archivedAt: claimed.archivedAt, archiveFileName: claimed.archiveFileName };
  } catch (err) {
    await tryDelete(tempPath);
    throw err;
  }
}

/** Finds the first `backup-<archivedAt>.zip` name that does not yet exist, starting at `now` and advancing
 *  one millisecond at a time (each candidate re-formatted via {@link formatUtcMarkerMs}) until the name is
 *  free. This is the no-clobber create the data-backup conventions call for: a run whose stamp collides
 *  with an existing archive lands on the next free millisecond instead of overwriting it. */
async function claimArchiveName(
  dir: string,
  now: Date,
): Promise<{ archivedAt: string; archiveFileName: string; finalPath: string }> {
  let candidateMs = now.getTime();
  for (;;) {
    const archivedAt = formatUtcMarkerMs(new Date(candidateMs));
    const archiveFileName = `backup-${archivedAt}.zip`;
    const finalPath = path.join(dir, archiveFileName);
    if (!(await exists(finalPath))) {
      return { archivedAt, archiveFileName, finalPath };
    }
    candidateMs += 1;
  }
}

async function ensureBackupsDir(backupsDir: string): Promise<string> {
  await fs.mkdir(backupsDir, { recursive: true });
  return backupsDir;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function tryDelete(target: string): Promise<void> {
  try {
    await fs.rm(target, { force: true });
  } catch {
    // best effort: a leftover temp is harmless and lives under the excluded backups/ directory
  }
}
