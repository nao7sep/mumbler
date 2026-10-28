import { link, mkdir, mkdtemp, open, readdir, rm, stat, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, extname, join } from "node:path";

import { nanoid } from "nanoid";
import type { ExternalFileContext } from "./external-file-operations";
import type { AppPaths, MumblerCard, MumblerQueue, PendingImportReviewItem, SourceFileIdentity } from "@shared/app-shell";
import { fileExists, formatError, isMissingFileError, sameFileBytes, uniquePathInDirectory } from "./file-io";

import { sha256OfFile } from "./binaries/integrity";
import { type AppLogger, serializeError } from "./logger";

export interface WorkingReconciliationResult {
  state: MumblerQueue;
  droppedPendingImports: number;
  missingWorkingCards: number;
  deletedDerivedFiles: number;
  retainedDerivedFiles: number;
}

export function sourceFileIdentity(info: SourceFileIdentity): SourceFileIdentity {
  const { dev, ino, size, mtimeMs, ctimeMs } = info;
  return { dev, ino, size, mtimeMs, ctimeMs };
}

function sameSourceIdentity(left: SourceFileIdentity, right: SourceFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export async function assertImportedSourceUnchanged(sourcePath: string, expectedCopy: string, expected: SourceFileIdentity | undefined, context?: ExternalFileContext): Promise<void> {
  context?.signal.throwIfAborted();
  if (expected === undefined || !sameSourceIdentity(await stat(sourcePath), expected) ||
      !(await sameFileBytes(sourcePath, expectedCopy, context)) || !sameSourceIdentity(await stat(sourcePath), expected)) {
    throw new Error("The source recording can no longer be verified as the imported file; it was left in place.");
  }
}

export async function deleteImportedSource(sourcePath: string, expectedCopy: string, expected: SourceFileIdentity | undefined, context?: ExternalFileContext): Promise<void> {
  await assertImportedSourceUnchanged(sourcePath, expectedCopy, expected, context);
  context?.signal.throwIfAborted();
  await unlink(sourcePath);
}

const reservedWorkingNames = new Set<string>();

export async function copyIntoWorking(
  sourcePath: string,
  workingDir: string,
  preferredName: string,
  signal?: AbortSignal,
  expectedSource?: SourceFileIdentity,
  progress?: () => void,
): Promise<string> {
  await mkdir(workingDir, { recursive: true });
  let workingFilePath = await uniquePathInDirectory(workingDir, preferredName);
  while (reservedWorkingNames.has(workingFilePath.toLowerCase())) {
    const extension = extname(preferredName);
    workingFilePath = join(workingDir, `${basename(preferredName, extension)}-${nanoid(8).toLowerCase()}${extension}`);
  }
  reservedWorkingNames.add(workingFilePath.toLowerCase());
  let owned = false;
  try {
    signal?.throwIfAborted();
    const before = await stat(sourcePath);
    signal?.throwIfAborted();
    progress?.();
    if (expectedSource && !sameSourceIdentity(before, expectedSource)) throw new Error("The source recording changed before it could be copied.");
    const handle = await open(workingFilePath, "wx", 0o600);
    owned = true;
    const stream = createReadStream(sourcePath, { signal });
    if (progress) stream.on("data", progress);
    stream.on("error", () => undefined);
    let primary: unknown;
    try {
      await handle.writeFile(stream);
      const after = await stat(sourcePath);
      signal?.throwIfAborted();
      if (!sameSourceIdentity(before, after)) {
        throw new Error("The source recording changed while it was being imported.");
      }
      await handle.utimes(before.atime, before.mtime);
      await handle.chmod(before.mode);
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
    signal?.throwIfAborted();
    return workingFilePath;
  } catch (error: unknown) {
    if (owned) await rm(workingFilePath, { force: true }).catch(() => undefined);
    throw new Error(`Failed to create a readable working copy for ${preferredName}: ${formatError(error)}`, { cause: error });
  } finally {
    reservedWorkingNames.delete(workingFilePath.toLowerCase());
  }
}

// Keep the descriptor writable through metadata and sync, including read-only
// source copies on Windows. An exclusive public fallback can be incomplete on
// failure; the caller reports failure and keeps the original recording.
async function copyBackupFile(source: string, destination: string, context?: ExternalFileContext): Promise<void> {
  context?.signal.throwIfAborted();
  const handle = await open(destination, "wx", 0o600);
  const stream = createReadStream(source, { signal: context?.signal });
  if (context) stream.on("data", context.progress);
  stream.on("error", () => undefined);
  let primary: unknown;
  try {
    await handle.writeFile(stream);
    const sourceInfo = await stat(source);
    context?.signal.throwIfAborted();
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
async function alreadyFiled(sourcePath: string, backupDir: string, targetName: string, context?: ExternalFileContext): Promise<string | null> {
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
    context?.signal.throwIfAborted();
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
    sourceHash ??= await sha256OfFile(sourcePath, context?.signal, context?.progress);
    if (await sha256OfFile(candidate, context?.signal, context?.progress) === sourceHash) return candidate;
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
  context?: ExternalFileContext,
): Promise<{ path: string; reused: boolean }> {
  let stageDir: string | undefined;
  let targetPath: string | undefined;
  try {
    context?.signal.throwIfAborted();
    await mkdir(backupDir, { recursive: true });
    context?.signal.throwIfAborted();
    context?.progress();
    const existing = await alreadyFiled(sourcePath, backupDir, targetName, context);
    if (existing !== null) return { path: existing, reused: true };
    targetPath = await uniquePathInDirectory(backupDir, targetName);
    context?.signal.throwIfAborted();
    stageDir = await mkdtemp(join(backupDir, ".mumbler-backup-"));
    const stagePath = join(stageDir, "audio");
    // not recorded: this is a user-requested copy of the original audio binary,
    // written as output and never reopened as Mumbler-managed state.
    await copyBackupFile(sourcePath, stagePath, context);
    context?.signal.throwIfAborted();
    try { await link(stagePath, targetPath); }
    catch (error) {
      if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await copyBackupFile(stagePath, targetPath, context);
    }
    context?.signal.throwIfAborted();
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

// Startup cleanup deletes only what is temporary by location: derived/ holds
// the trimmed audio a pipeline or save prepares and removes when it ends, so a
// file left there was cut short by a crash. A recording in working/ itself is
// never swept, whatever the queue says: a lost or reset queue is no reason to
// delete user audio, and a card's own audio is deleted when the card is.
export async function cleanupDerivedFiles(
  paths: AppPaths,
  logger: AppLogger,
): Promise<{ deletedDerivedFiles: number; retainedDerivedFiles: number }> {
  let deletedDerivedFiles = 0;
  let retainedDerivedFiles = 0;

  for (const candidate of await listDerivedFiles(paths.workingDir)) {
    try {
      await rm(candidate, { force: true });
      deletedDerivedFiles += 1;
      await logger.debug("working.cleanup", "Deleted leftover derived audio.", {
        filePath: candidate,
      });
    } catch (error: unknown) {
      retainedDerivedFiles += 1;
      await logger.warn("working.cleanup-failed", "Failed to delete leftover derived audio.", {
        filePath: candidate,
        error: formatError(error),
      });
    }
  }

  return {
    deletedDerivedFiles,
    retainedDerivedFiles,
  };
}

export async function listDerivedFiles(workingDir: string): Promise<string[]> {
  const derivedDir = join(workingDir, "derived");
  let entries;
  try {
    entries = await readdir(derivedDir, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
  return entries.filter((entry) => entry.isFile()).map((entry) => join(derivedDir, entry.name));
}

export async function reconcileWorkingState(
  paths: AppPaths,
  state: MumblerQueue,
  logger: AppLogger,
): Promise<WorkingReconciliationResult> {
  const nextPendingImports: PendingImportReviewItem[] = [];
  let droppedPendingImports = 0;

  for (const pendingImport of state.pendingImports) {
    if (await fileExists(pendingImport.workingFilePath)) {
      nextPendingImports.push(pendingImport);
      continue;
    }

    droppedPendingImports += 1;
    await logger.warn(
      "startup.pending-missing",
      "Dropped pending import because its working file is missing.",
      {
        pendingImportId: pendingImport.id,
        originalFilename: pendingImport.originalFilename,
        workingFilePath: pendingImport.workingFilePath,
      },
    );
  }

  let missingWorkingCards = 0;
  const nextCards: MumblerCard[] = [];

  for (const card of state.cards) {
    if (await fileExists(card.sourceFilePath)) {
      nextCards.push(card);
      continue;
    }

    missingWorkingCards += 1;
    nextCards.push(markCardWorkingFileMissing(card));
    await logger.warn(
      "startup.card-missing",
      "Marked card as errored because its working file is missing.",
      {
        cardId: card.id,
        originalFilename: card.originalFilename,
        sourceFilePath: card.sourceFilePath,
      },
    );
  }

  const cleanupResult = await cleanupDerivedFiles(paths, logger);
  const changed = droppedPendingImports > 0 || missingWorkingCards > 0;

  const nextState =
    !changed
      ? state
      : {
          ...state,
          pendingImports: nextPendingImports,
          cards: nextCards,
        };

  return {
    state: nextState,
    droppedPendingImports,
    missingWorkingCards,
    deletedDerivedFiles: cleanupResult.deletedDerivedFiles,
    retainedDerivedFiles: cleanupResult.retainedDerivedFiles,
  };
}

function markCardWorkingFileMissing(card: MumblerCard): MumblerCard {
  return {
    ...card,
    status: "Error",
    activeStep: null,
    queuedMode: null,
    queuedAtUtc: null,
    lastError: {
      message: "Working audio is missing from working storage — remove this card or re-import the source audio.",
      occurredAtUtc: Date.now(),
      failedStep: "startup-recovery",
    },
  };
}
