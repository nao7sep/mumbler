import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppPaths } from "@shared/app-shell";
import { resolveStorageRoot } from "./storage-root";

export function getAppPaths(): AppPaths {
  const homeDir = resolveStorageRoot(process.env.MUMBLER_DATA_DIR, homedir());
  // The OS's own Documents folder, which follows a Windows or OneDrive
  // redirection that `~/Documents` would miss. The output folder is an inbox
  // the user empties, so the recordings kept for good sit beside it, never
  // inside it.
  const documents = app.getPath("documents");

  return {
    homeDir,
    profileDir: join(homeDir, "electron"),
    settingsPath: join(homeDir, "config.json"),
    queuePath: join(homeDir, "queue.json"),
    transcriptsDir: join(homeDir, "transcripts"),
    layoutPath: join(homeDir, "layout.json"),
    apiKeysPath: join(homeDir, "api-keys.json"),
    recordsPath: join(homeDir, "records.sqlite3"),
    logsDir: join(homeDir, "logs"),
    workingDir: join(homeDir, "working"),
    outputDir: join(documents, "Mumbler"),
    originalsDir: join(documents, "Recordings"),
    binDir: join(homeDir, "bin"),
    dependenciesPath: join(homeDir, "dependencies.json"),
    tempDir: join(homeDir, "temp"),
  };
}

