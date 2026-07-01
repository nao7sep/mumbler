// End-to-end backup runs over a throwaway home root: a first run captures the managed durable files at
// their mirror paths (and excludes layout.json, the secret api-keys.json, and the working tree); an
// unchanged run writes nothing; an edit captures only what changed; a corrupt index resets to a full
// backup; a case-collision is skipped without failing the run.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import unzipper from "unzipper";

import { runBackup, type BackupLocations } from "@main/core/backup/backup-engine.js";

const RUN1 = new Date("2026-07-01T00:00:00Z");
const RUN2 = new Date("2026-07-01T01:00:00Z");

let home: string;
let locations: BackupLocations;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mumbler-backup-"));
  locations = {
    homeDir: home,
    backupsDir: path.join(home, "backups"),
    indexPath: path.join(home, "backups", "index.json"),
  };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function backupsPath(name: string): string {
  return path.join(locations.backupsDir, name);
}

async function zipEntries(zipFile: string): Promise<string[]> {
  const directory = await unzipper.Open.file(zipFile);
  return directory.files
    .filter((file) => file.type === "File")
    .map((file) => file.path)
    .sort();
}

// Materializes the managed durable files plus the excluded volatile/working state a real launch leaves.
function seedHome(): void {
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ v: 1 }));
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({ cards: [] }));
  fs.writeFileSync(path.join(home, "api-keys.json"), JSON.stringify({ gemini: "secret" }));
  fs.writeFileSync(path.join(home, "dependencies.json"), JSON.stringify({ tools: [] }));
  // Excluded: volatile pane geometry and the disposable working tree.
  fs.writeFileSync(path.join(home, "layout.json"), JSON.stringify({ queueWidth: 300 }));
  fs.mkdirSync(path.join(home, "working"), { recursive: true });
  fs.writeFileSync(path.join(home, "working", "rec.m4a"), "audio");
}

describe("runBackup", () => {
  it("captures managed files and excludes layout.json, api-keys.json, and the working tree", async () => {
    seedHome();

    const report = await runBackup(locations, RUN1);

    expect(report.fatal).toBeUndefined();
    expect(report.nothingChanged).toBe(false);
    expect(report.archiveFileName).toBe("backup-20260701-000000-utc.zip");

    const entries = await zipEntries(backupsPath(report.archiveFileName!));
    expect(entries).toEqual(["config.json", "dependencies.json", "state.json"].sort());
    expect(entries).toContain("state.json"); // the card queue IS backed up
    expect(entries).not.toContain("layout.json"); // volatile UI state is NOT
    expect(entries).not.toContain("api-keys.json"); // the secret is NOT
    expect(entries.some((e) => e.startsWith("working/"))).toBe(false);
  });

  it("writes nothing on a second run with no changes", async () => {
    seedHome();

    await runBackup(locations, RUN1);
    const report = await runBackup(locations, RUN2);

    expect(report.nothingChanged).toBe(true);
    expect(report.filesArchived).toBe(0);
    expect(fs.existsSync(backupsPath("backup-20260701-010000-utc.zip"))).toBe(false);
  });

  it("captures only the changed file after an edit", async () => {
    seedHome();
    await runBackup(locations, RUN1);

    // Size differs, caught regardless of mtime.
    fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({ cards: [{ id: "a" }] }));

    const report = await runBackup(locations, RUN2);

    expect(report.filesArchived).toBe(1);
    const entries = await zipEntries(backupsPath("backup-20260701-010000-utc.zip"));
    expect(entries).toEqual(["state.json"]);
  });

  it("resets a corrupt index to a full backup", async () => {
    seedHome();
    await runBackup(locations, RUN1);

    fs.writeFileSync(locations.indexPath, "{ not valid json");

    const report = await runBackup(locations, RUN2);

    expect(report.indexWasReset).toBe(true);
    expect(report.filesArchived).toBe(3); // config + state + dependencies (api-keys excluded)
  });

  it.skipIf(process.platform === "win32")(
    "records a skip for an unreadable subdirectory but still backs up the readable files",
    async () => {
      seedHome();
      const locked = path.join(home, "data");
      fs.mkdirSync(locked, { recursive: true });
      fs.writeFileSync(path.join(locked, "inner.json"), "x");
      fs.chmodSync(locked, 0o000); // deny enumeration

      try {
        const report = await runBackup(locations, RUN1);

        expect(report.fatal).toBeUndefined();
        expect(report.nothingChanged).toBe(false);
        expect(report.skips.some((skip) => skip.path === locked)).toBe(true);
        // The three readable managed files are still captured despite the dead subdirectory.
        expect(report.filesArchived).toBe(3);
      } finally {
        fs.chmodSync(locked, 0o700); // restore so afterEach can clean up
      }
    },
  );
});
