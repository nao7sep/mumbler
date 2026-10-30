import { link, mkdir, mkdtemp, open, readdir, rm, stat, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, extname, join } from "node:path";

import type { SourceFileIdentity } from "@shared/app-shell";
import { formatError, isMissingFileError, uniquePathInDirectory } from "./file-io";

import { sha256OfFile } from "./binaries/integrity";
import { type AppLogger, serializeError } from "./logger";

export function sourceFileIdentity(info: SourceFileIdentity): SourceFileIdentity {
  const { dev, ino, size, mtimeMs, ctimeMs } = info;
  return { dev, ino, size, mtimeMs, ctimeMs };
}

function sameSourceIdentity(left: SourceFileIdentity, right: SourceFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

// Deleting the user's original is irreversible, so its one precondition is
// checked right before the unlink: the path still holds the file that was
// imported. A review without a recorded identity cannot be checked and keeps it.
export async function deleteImportedSource(sourcePath: string, expected: SourceFileIdentity | undefined): Promise<void> {
  if (expected === undefined || !sameSourceIdentity(await stat(sourcePath), expected)) {
    throw new Error("The source recording can no longer be verified as the imported file; it was left in place.");
  }
  await unlink(sourcePath);
}

/** Copies a recording to `workingFilePath`, a new file in its card's or
 * import's own folder, keeping the source's times and mode; a failed copy
 * removes what it wrote. */
export async function copyIntoWorking(sourcePath: string, workingFilePath: string): Promise<void> {
  let created = false;
  try {
    const handle = await open(workingFilePath, "wx", 0o600);
    created = true;
    const stream = createReadStream(sourcePath);
    stream.on("error", () => undefined);
    let primary: unknown;
    try {
      await handle.writeFile(stream);
      const source = await stat(sourcePath);
      await handle.utimes(source.atime, source.mtime);
      await handle.chmod(source.mode);
      await handle.sync();
    } catch (error) { primary = error; }
    finally {
      stream.destroy();
      try { await handle.close(); }
      catch (error) {
        if (primary !== undefined) throw new AggregateError([primary, error], "Working copy and close failed.", { cause: primary });
        throw error;
      }
    }
    if (primary !== undefined) throw primary;
  } catch (error: unknown) {
    if (created) await rm(workingFilePath, { force: true }).catch(() => undefined);
    throw new Error(`Failed to create a readable working copy for ${basename(workingFilePath)}: ${formatError(error)}`, { cause: error });
  }
}

// Keep the descriptor writable through metadata and sync, including read-only
// source copies on Windows. An exclusive public fallback can be incomplete on
// failure; the caller reports failure and keeps the original recording.
async function copyBackupFile(source: string, destination: string): Promise<void> {
  const handle = await open(destination, "wx", 0o600);
  const stream = createReadStream(source);
  stream.on("error", () => undefined);
  let primary: unknown;
  try {
    await handle.writeFile(stream);
    const sourceInfo = await stat(source);
    await handle.utimes(sourceInfo.atime, sourceInfo.mtime);
    await handle.chmod(sourceInfo.mode);
    await handle.sync();
  } catch (error) { primary = error; }
  finally {
    stream.destroy();
    try { await handle.close(); }
    catch (error) {
      if (primary !== undefined) throw new AggregateError([primary, error], "Backup copy and close failed.", { cause: primary });
      throw error;
    }
  }
  if (primary !== undefined) throw primary;
}

// A recording already filed under `targetName`, or under that name with the
// collision suffix, whose bytes equal the source: importing the same recording
// again finds it rather than filing a second copy.
async function alreadyFiled(sourcePath: string, backupDir: string, targetName: string): Promise<string | null> {
  const extension = extname(targetName).toLowerCase();
  const stem = targetName.slice(0, targetName.length - extension.length).toLowerCase();
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suffixed = new RegExp(`^${escaped}-[0-9a-z]{8}$`);
  let names: string[];
  try {
    names = await readdir(backupDir);
  } catch (error: unknown) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
  const { size } = await stat(sourcePath);
  let sourceHash: string | null = null;
  for (const name of names) {
    const lower = name.toLowerCase();
    if (extname(lower) !== extension) continue;
    const nameStem = lower.slice(0, lower.length - extension.length);
    if (nameStem !== stem && !suffixed.test(nameStem)) continue;
    const candidate = join(backupDir, name);
    const info = await stat(candidate).catch((error: unknown) => {
      if (isMissingFileError(error)) return null;
      throw error;
    });
    if (info === null || !info.isFile() || info.size !== size) continue;
    sourceHash ??= await sha256OfFile(sourcePath);
    if (await sha256OfFile(candidate) === sourceHash) return candidate;
  }
  return null;
}

/** Files the original in the Recordings folder under `targetName`, with a
 * suffix when a different recording holds that name, and returns where it is;
 * `reused` says an identical copy was already there and nothing was written. */
export async function copyOriginalToBackup(
  sourcePath: string,
  backupDir: string,
  targetName: string,
  logger?: Pick<AppLogger, "warn">,
): Promise<{ path: string; reused: boolean }> {
  let stageDir: string | undefined;
  let targetPath: string | undefined;
  try {
    await mkdir(backupDir, { recursive: true });
    const existing = await alreadyFiled(sourcePath, backupDir, targetName);
    if (existing !== null) return { path: existing, reused: true };
    targetPath = await uniquePathInDirectory(backupDir, targetName);
    stageDir = await mkdtemp(join(backupDir, ".mumbler-backup-"));
    const stagePath = join(stageDir, "audio");
    // not recorded: this is a user-requested copy of the original audio binary,
    // written as output and never reopened as Mumbler-managed state.
    await copyBackupFile(sourcePath, stagePath);
    try { await link(stagePath, targetPath); }
    catch (error) {
      if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await copyBackupFile(stagePath, targetPath);
    }
    return { path: targetPath, reused: false };
  } catch (error: unknown) {
    throw new Error(`Failed to copy ${sourcePath} into the Recordings folder ${backupDir}${targetPath === undefined ? "" : ` (target ${targetPath})`}: ${formatError(error)}`, { cause: error });
  } finally {
    if (stageDir !== undefined) {
      try { await rm(stageDir, { recursive: true, force: true }); }
      catch (error) {
        try {
          await logger?.warn("import.backup-cleanup", "Could not remove original-backup staging.", {
            sourcePath, targetPath, stageDir, error: serializeError(error),
          });
        } catch { /* Cleanup reporting cannot deny a committed backup or mask its failure. */ }
      }
    }
  }
}
