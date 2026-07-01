/**
 * The startup edge for the data backup: runs one pass without blocking startup and logs the outcome. This
 * is the only place the feature logs; the pass itself ({@link runBackup}) does not. Best-effort — it never
 * blocks the window, shows an error, or crashes the app.
 *
 * Electron's main process is single-threaded, so "background" here means fire-and-forget async on the
 * event loop after the window is created: the renderer is a separate process, so this never blocks the
 * UI's paint.
 */
import type { AppPaths } from "@shared/app-shell";
import { join } from "node:path";
import type { AppLogger } from "../logger.js";
import { runBackup, type BackupLocations } from "./backup-engine.js";
import type { BackupReport } from "./backup-types.js";

/** Runs one backup pass in the background and logs its outcome. Fire-and-forget; never throws. */
export function runBackupInBackground(paths: AppPaths, logger: AppLogger): void {
  void runOnce(paths, logger);
}

async function runOnce(paths: AppPaths, logger: AppLogger): Promise<void> {
  const locations: BackupLocations = {
    homeDir: paths.homeDir,
    backupsDir: paths.backupsDir,
    indexPath: join(paths.backupsDir, "index.json"),
  };
  try {
    await logReport(logger, await runBackup(locations, new Date()));
  } catch (err) {
    // The engine captures its own failures in the report; this is the final backstop so a bug here can
    // never surface to the user or take down the app.
    await logger.error("backup.unexpected", "Backup failed unexpectedly.", err);
  }
}

async function logReport(logger: AppLogger, report: BackupReport): Promise<void> {
  for (const skip of report.skips) {
    await logger.warn("backup.skip", "Skipped a file during backup.", {
      path: skip.path,
      reason: skip.reason,
    });
  }

  if (report.indexWasReset) {
    await logger.warn("backup.index-reset", "Backup index was unreadable and reset; this run is a full backup.");
  }

  if (report.fatal !== undefined) {
    await logger.error("backup.failed", "Backup run failed.", report.fatal);
    return;
  }

  if (report.nothingChanged) {
    await logger.debug("backup.nothing-changed", "Nothing changed; no archive written.");
    return;
  }

  await logger.info("backup.archived", "Backup archive written.", {
    archive: report.archiveFileName,
    files: report.filesArchived,
  });
}
