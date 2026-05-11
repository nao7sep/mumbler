import { copyFile, mkdir, readdir, rm, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

import type { AppPaths, MumblerCard, MumblerState, PendingImportReviewItem } from "@shared/app-shell";
import { fileExists, formatError, uniquePathInDirectory } from "./file-io";

import { type AppLogger } from "./logger";

export interface WorkingReconciliationResult {
  state: MumblerState;
  droppedPendingImports: number;
  missingWorkingCards: number;
  deletedOrphanedFiles: number;
  retainedOrphanedFiles: number;
}

export async function deleteImportedSource(sourcePath: string): Promise<void> {
  await unlink(sourcePath);
}

export async function copyOriginalToBackup(
  sourcePath: string,
  backupDir: string,
): Promise<string> {
  await mkdir(backupDir, { recursive: true });
  const targetPath = await uniquePathInDirectory(backupDir, basename(sourcePath));

  try {
    await copyFile(sourcePath, targetPath);
  } catch (error: unknown) {
    throw new Error(`Failed to copy ${sourcePath} to backup directory: ${formatError(error)}`);
  }

  return targetPath;
}

export async function cleanupOrphanedWorkingFiles(
  paths: AppPaths,
  referencedPaths: Set<string>,
  logger: AppLogger,
): Promise<{ deletedOrphanedFiles: number; retainedOrphanedFiles: number }> {
  let deletedOrphanedFiles = 0;
  let retainedOrphanedFiles = 0;
  const candidates = await listWorkingFiles(paths.workingDir);

  for (const candidate of candidates) {
    if (referencedPaths.has(candidate)) {
      continue;
    }

    try {
      await rm(candidate, { force: true });
      deletedOrphanedFiles += 1;
      await logger.info("working.cleanup", "Deleted orphaned working file.", {
        filePath: candidate,
      });
    } catch (error: unknown) {
      retainedOrphanedFiles += 1;
      await logger.warn("working.cleanup-failed", "Failed to delete orphaned working file.", {
        filePath: candidate,
        error: formatError(error),
      });
    }
  }

  return {
    deletedOrphanedFiles,
    retainedOrphanedFiles,
  };
}

export async function listWorkingFiles(workingDir: string): Promise<string[]> {
  const entries = await readdir(workingDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(workingDir, entry.name);
    if (entry.isFile()) {
      files.push(entryPath);
      continue;
    }

    if (entry.isDirectory() && entry.name === "derived") {
      const subEntries = await readdir(entryPath, { withFileTypes: true });
      for (const subEntry of subEntries) {
        if (subEntry.isFile()) {
          files.push(join(entryPath, subEntry.name));
        }
      }
    }
  }

  return files;
}

export async function reconcileWorkingState(
  paths: AppPaths,
  state: MumblerState,
  logger: AppLogger,
): Promise<WorkingReconciliationResult> {
  const referencedPaths = new Set<string>();
  const nextPendingImports: PendingImportReviewItem[] = [];
  let droppedPendingImports = 0;

  for (const pendingImport of state.pendingImports) {
    if (await fileExists(pendingImport.workingFilePath)) {
      nextPendingImports.push(pendingImport);
      referencedPaths.add(pendingImport.workingFilePath);
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
      referencedPaths.add(card.sourceFilePath);
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

  const cleanupResult = await cleanupOrphanedWorkingFiles(paths, referencedPaths, logger);
  const changed =
    droppedPendingImports > 0 ||
    missingWorkingCards > 0 ||
    cleanupResult.deletedOrphanedFiles > 0 ||
    cleanupResult.retainedOrphanedFiles > 0;

  const nextState =
    !changed
      ? state
      : {
          ...state,
          pendingImports: nextPendingImports,
          cards: nextCards,
          selectedCardId: selectExistingCardId({
            ...state,
            pendingImports: nextPendingImports,
            cards: nextCards,
          }),
          updatedAtUtc: Date.now(),
        };

  return {
    state: nextState,
    droppedPendingImports,
    missingWorkingCards,
    deletedOrphanedFiles: cleanupResult.deletedOrphanedFiles,
    retainedOrphanedFiles: cleanupResult.retainedOrphanedFiles,
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
    updatedAtUtc: Date.now(),
  };
}

export function selectExistingCardId(state: MumblerState): string | null {
  if (state.selectedCardId !== null && state.cards.some((card) => card.id === state.selectedCardId)) {
    return state.selectedCardId;
  }

  return state.cards[0]?.id ?? null;
}
