import { access, copyFile, link, mkdir, mkdtemp, open, readdir, rm, stat, unlink } from "node:fs/promises";
import { constants as fsConstants, createReadStream } from "node:fs";
import { basename, join } from "node:path";

import type { AppPaths, MumblerCard, MumblerQueue, PendingImportReviewItem } from "@shared/app-shell";
import { fileExists, formatError, isMissingFileError, keepSourceTimesAndMode, syncDirectory, uniquePathInDirectory } from "./file-io";

import { type AppLogger, serializeError } from "./logger";

export interface WorkingReconciliationResult {
  state: MumblerQueue;
  droppedPendingImports: number;
  missingWorkingCards: number;
  deletedDerivedFiles: number;
  retainedDerivedFiles: number;
}

export async function deleteImportedSource(sourcePath: string): Promise<void> {
  await unlink(sourcePath);
}

export async function copyIntoWorking(
  sourcePath: string,
  workingDir: string,
  preferredName: string,
): Promise<string> {
  await mkdir(workingDir, { recursive: true });
  const workingFilePath = await uniquePathInDirectory(workingDir, preferredName);

  try {
    // Created exclusively, so a name taken after the directory scan fails
    // rather than being overwritten, and that file is never removed below.
    await copyFile(sourcePath, workingFilePath, fsConstants.COPYFILE_EXCL);
    await keepSourceTimesAndMode(sourcePath, workingFilePath);
    await access(workingFilePath, fsConstants.R_OK);
  } catch (error: unknown) {
    // Best-effort removal of this call's own partial copy; the wrapped error
    // below is the meaningful failure and is always thrown, so a failed cleanup
    // is deliberately not surfaced on top of it.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") await rm(workingFilePath, { force: true }).catch(() => undefined);
    throw new Error(
      `Failed to create a readable working copy for ${preferredName}: ${formatError(error)}`,
      { cause: error },
    );
  }

  return workingFilePath;
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

export async function copyOriginalToBackup(
  sourcePath: string,
  backupDir: string,
  logger?: Pick<AppLogger, "warn">,
): Promise<string> {
  let stageDir: string | undefined;
  let targetPath: string | undefined;
  try {
    await mkdir(backupDir, { recursive: true });
    targetPath = await uniquePathInDirectory(backupDir, basename(sourcePath));
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
    await syncDirectory(backupDir);
    return targetPath;
  } catch (error: unknown) {
    throw new Error(`Failed to copy ${sourcePath} to backup directory ${backupDir}${targetPath === undefined ? "" : ` (target ${targetPath})`}: ${formatError(error)}`, { cause: error });
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
