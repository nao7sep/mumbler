import { access, copyFile, mkdir, readdir, rm, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, join } from "node:path";

import type { AppPaths, MumblerCard, MumblerQueue, PendingImportReviewItem } from "@shared/app-shell";
import { fileExists, formatError, isMissingFileError, keepSourceTimesAndMode, uniquePathInDirectory } from "./file-io";

import { type AppLogger } from "./logger";

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
    // not recorded: working/ contains managed audio binaries; queue.json records
    // the durable queue/work metadata that gives those copies meaning.
    await copyFile(sourcePath, workingFilePath);
    await keepSourceTimesAndMode(sourcePath, workingFilePath);
    await access(workingFilePath, fsConstants.R_OK);
  } catch (error: unknown) {
    // Best-effort removal of the partial copy; the wrapped error below is the
    // meaningful failure and is always thrown, so a failed cleanup is deliberately
    // not surfaced on top of it.
    await rm(workingFilePath, { force: true }).catch(() => undefined);
    throw new Error(
      `Failed to create a readable working copy for ${preferredName}: ${formatError(error)}`,
      { cause: error },
    );
  }

  return workingFilePath;
}

export async function copyOriginalToBackup(
  sourcePath: string,
  backupDir: string,
): Promise<string> {
  await mkdir(backupDir, { recursive: true });
  const targetPath = await uniquePathInDirectory(backupDir, basename(sourcePath));

  try {
    // not recorded: this is a user-requested copy of the original audio binary,
    // written as output and never reopened as Mumbler-managed state.
    await copyFile(sourcePath, targetPath);
    await keepSourceTimesAndMode(sourcePath, targetPath);
  } catch (error: unknown) {
    throw new Error(`Failed to copy ${sourcePath} to backup directory: ${formatError(error)}`, { cause: error });
  }

  return targetPath;
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
