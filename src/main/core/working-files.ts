import { shell } from "electron";
import { copyFile, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

import type { AppPaths, MumblerCard, MumblerState, PendingImportReviewItem } from "@shared/app-shell";
import { fileExists, formatError } from "./file-io";

import { type AppLogger } from "./logger";

export interface WorkingReconciliationResult {
  state: MumblerState;
  droppedPendingImports: number;
  missingWorkingCards: number;
  trashedOrphanedFiles: number;
  retainedOrphanedFiles: number;
}

export async function moveImportedSourceToTrash(sourcePath: string, workingDir: string, logger?: AppLogger): Promise<void> {
  try {
    await shell.trashItem(sourcePath);
    return;
  } catch (directTrashError: unknown) {
    await logger?.warn("trash.fallback", "Direct trash of imported source failed; falling back to staged copy.", {
      sourcePath,
      error: directTrashError instanceof Error ? directTrashError.message : String(directTrashError),
    });
    const stagingDir = join(workingDir, "trash-staging");
    const stagedPath = join(stagingDir, basename(sourcePath));

    try {
      await copyFile(sourcePath, stagedPath);
      await access(stagedPath, fsConstants.R_OK);
      await rm(sourcePath);
    } catch (stageError: unknown) {
      await rm(stagedPath, { force: true });
      throw new Error(
        `Failed to stage imported source for trash after direct trash failed: ${formatError(stageError)}`,
      );
    }

    try {
      await shell.trashItem(stagedPath);
    } catch (trashError: unknown) {
      try {
        await copyFile(stagedPath, sourcePath);
        await rm(stagedPath, { force: true });
      } catch (restoreError: unknown) {
        throw new Error(
          `Failed to trash staged source and failed to restore it. Staged copy remains at ${stagedPath}. Trash error: ${formatError(trashError)}. Restore error: ${formatError(restoreError)}`,
        );
      }

      throw new Error(
        `Failed to move source to trash after local staging: ${formatError(trashError)}`,
      );
    }
  }
}

export async function cleanupOrphanedWorkingFiles(
  paths: AppPaths,
  referencedPaths: Set<string>,
  logger: AppLogger,
): Promise<{ trashedOrphanedFiles: number; retainedOrphanedFiles: number }> {
  let trashedOrphanedFiles = 0;
  let retainedOrphanedFiles = 0;
  const candidates = await listWorkingFiles(paths.workingDir);

  for (const candidate of candidates) {
    if (referencedPaths.has(candidate)) {
      continue;
    }

    try {
      await shell.trashItem(candidate);
      trashedOrphanedFiles += 1;
      await logger.info("working.cleanup", "Moved orphaned working file to trash.", {
        filePath: candidate,
      });
    } catch (error: unknown) {
      retainedOrphanedFiles += 1;
      await logger.warn("working.cleanup-failed", "Failed to trash orphaned working file.", {
        filePath: candidate,
        error: formatError(error),
      });
    }
  }

  return {
    trashedOrphanedFiles,
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

    if (entry.isDirectory() && (entry.name === "trash-staging" || entry.name === "derived")) {
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
    cleanupResult.trashedOrphanedFiles > 0 ||
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
    trashedOrphanedFiles: cleanupResult.trashedOrphanedFiles,
    retainedOrphanedFiles: cleanupResult.retainedOrphanedFiles,
  };
}

function markCardWorkingFileMissing(card: MumblerCard): MumblerCard {
  return {
    ...card,
    status: "Error",
    activeStep: null,
    lastError: {
      message: "Working audio is missing from working storage — remove this card or re-import the source audio.",
      occurredAtUtc: Date.now(),
      failedStep: "startup-recovery",
    },
    updatedAtUtc: Date.now(),
  };
}

function selectExistingCardId(state: MumblerState): string | null {
  if (state.selectedCardId !== null && state.cards.some((card) => card.id === state.selectedCardId)) {
    return state.selectedCardId;
  }

  return state.cards[0]?.id ?? null;
}
