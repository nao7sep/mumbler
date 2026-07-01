/**
 * Runs one backup pass and returns a {@link BackupReport}. It never throws for an expected problem (a
 * fatal error is captured in the report) and never logs — the caller logs the report. See the data-backup
 * conventions: change is size + mtime, the archive mirrors `~/.mumbler/`, and the archive is written and
 * renamed into place *before* the index so a crash never records a phantom backup.
 */
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { formatUtcMarker } from "@shared/timestamps";
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

  const archivedAt = formatUtcMarker(now);
  const archiveFileName = `backup-${archivedAt}.zip`;
  const archived = await writeArchive(locations.backupsDir, archiveFileName, changed, skips);
  if (archived.length === 0) {
    // Every changed file vanished before it could be archived; nothing was written, nothing is recorded.
    return { nothingChanged: true, filesArchived: 0, skips, indexWasReset };
  }

  for (const item of archived) {
    index.entries.push({
      archivedAt,
      archivePath: item.archivePath,
      sizeBytes: item.sizeBytes,
      lastWriteUtc: toIsoSeconds(item.mtimeMs),
    });
  }
  // Index second: the archive is already in place, so a crash here just re-captures next run.
  await writeJsonFile(locations.indexPath, index);

  return { nothingChanged: false, archiveFileName, filesArchived: archived.length, skips, indexWasReset };
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

/** Streams the changed files to a temp zip and renames it into place, returning the files that were
 *  actually archived (a file that vanished since collection is skipped, not recorded). */
async function writeArchive(
  backupsDir: string,
  archiveFileName: string,
  changed: readonly BackupCandidate[],
  skips: BackupSkip[],
): Promise<BackupCandidate[]> {
  const dir = await ensureBackupsDir(backupsDir);
  const finalPath = path.join(dir, archiveFileName);
  const tempPath = path.join(dir, `.${process.pid}-${archiveFileName}.tmp`);

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
    return archived;
  }

  zip.end();
  try {
    await pipeline(zip.outputStream, createWriteStream(tempPath));
    await fs.rename(tempPath, finalPath);
  } catch (err) {
    await tryDelete(tempPath);
    throw err;
  }
  return archived;
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
