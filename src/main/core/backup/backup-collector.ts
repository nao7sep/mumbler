/**
 * Discovers what to back up by walking the home root under `~/.mumbler/` and producing the stat'd
 * candidates for {@link selectChanged}. Mumbler keeps all its managed data under this one root — there are
 * no external roots — so the collector is a single pruned walk. All I/O here is metadata only — directory
 * reads and `stat`; file contents are read later, when a changed file is archived. An unreadable directory
 * or file is a logged skip, not a throw, so the rest of the tree is still captured.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { forHomeFile, normalize } from "./archive-paths.js";
import { isExcludedDir, isExcludedFile } from "./home-root-exclusions.js";
import { truncateToSecondMs } from "./backup-time.js";
import type { BackupCandidate, BackupSkip } from "./backup-types.js";

export interface CollectedRoots {
  candidates: BackupCandidate[];
  skips: BackupSkip[];
}

/** Walks `homeDir`, pruning the excluded subtrees and files, and returns the stat'd candidates. */
export async function collectRoots(homeDir: string): Promise<CollectedRoots> {
  const candidates: BackupCandidate[] = [];
  const skips: BackupSkip[] = [];

  await walk(homeDir, homeDir, skips, async (fullPath, relative) => {
    if (!isExcludedFile(relative)) {
      await addCandidate(candidates, skips, fullPath, forHomeFile(relative));
    }
  });

  return { candidates: dedupeByCaseInsensitivePath(candidates, skips), skips };
}

/**
 * Recursively yields each file under `root` (relative path forward-slash normalized), skipping any
 * subdirectory {@link isExcludedDir} rejects.
 */
async function walk(
  root: string,
  dir: string,
  skips: BackupSkip[],
  onFile: (fullPath: string, relative: string) => Promise<void>,
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    skips.push({ path: dir, reason: `could not enumerate: ${errorMessage(err)}` });
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relative = normalize(path.relative(root, fullPath));
    if (entry.isDirectory()) {
      if (!isExcludedDir(relative)) {
        await walk(root, fullPath, skips, onFile);
      }
    } else if (entry.isFile()) {
      await onFile(fullPath, relative);
    }
  }
}

async function addCandidate(
  candidates: BackupCandidate[],
  skips: BackupSkip[],
  sourcePath: string,
  archivePath: string,
): Promise<void> {
  try {
    const stat = await fs.stat(sourcePath);
    candidates.push({
      sourcePath,
      archivePath,
      sizeBytes: stat.size,
      mtimeMs: truncateToSecondMs(stat.mtimeMs),
    });
  } catch (err) {
    skips.push({ path: sourcePath, reason: `could not stat: ${errorMessage(err)}` });
  }
}

/**
 * Enforces case-insensitive uniqueness of archive paths: if two candidates map to archive paths differing
 * only in case, one is kept and the other recorded as a skip. On a case-insensitive filesystem
 * (macOS/Windows) two such paths would clobber each other on unzip, so a stable choice is made here.
 */
function dedupeByCaseInsensitivePath(
  candidates: BackupCandidate[],
  skips: BackupSkip[],
): BackupCandidate[] {
  const kept: BackupCandidate[] = [];
  const seen = new Map<string, string>();
  for (const candidate of candidates) {
    const key = candidate.archivePath.toLowerCase();
    const existing = seen.get(key);
    if (existing !== undefined) {
      skips.push({
        path: candidate.archivePath,
        reason: `archive path collides case-insensitively with ${existing}`,
      });
      continue;
    }
    seen.set(key, candidate.archivePath);
    kept.push(candidate);
  }
  return kept;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
