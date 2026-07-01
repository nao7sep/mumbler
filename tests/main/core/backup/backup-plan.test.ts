// The pure change decision: a file is captured when its size or modification time differs from the latest
// index entry for its archive path, with a two-second mtime tolerance and no content hashing.

import { describe, it, expect } from "vitest";
import { selectChanged } from "@main/core/backup/backup-plan.js";
import { toIsoSeconds } from "@main/core/backup/backup-time.js";
import type { BackupCandidate, BackupIndex, BackupIndexEntry } from "@main/core/backup/backup-types.js";

const BASE = Date.UTC(2026, 6, 1, 12, 0, 0); // 2026-07-01T12:00:00Z (month is 0-indexed)

function candidate(archivePath: string, sizeBytes: number, mtimeMs: number): BackupCandidate {
  return { sourcePath: `/abs/${archivePath}`, archivePath, sizeBytes, mtimeMs };
}

function entry(archivedAt: string, archivePath: string, sizeBytes: number, mtimeMs: number): BackupIndexEntry {
  return { archivedAt, archivePath, sizeBytes, lastWriteUtc: toIsoSeconds(mtimeMs) };
}

function index(...entries: BackupIndexEntry[]): BackupIndex {
  return { entries };
}

describe("selectChanged", () => {
  it("treats a file with no prior entry as new", () => {
    const changed = selectChanged([candidate("config.json", 10, BASE)], index());
    expect(changed.map((c) => c.archivePath)).toEqual(["config.json"]);
  });

  it("skips a file with the same size and mtime", () => {
    const changed = selectChanged(
      [candidate("config.json", 10, BASE)],
      index(entry("20260701-120000-utc", "config.json", 10, BASE)),
    );
    expect(changed).toEqual([]);
  });

  it("captures a file whose size differs", () => {
    const changed = selectChanged(
      [candidate("config.json", 11, BASE)],
      index(entry("20260701-120000-utc", "config.json", 10, BASE)),
    );
    expect(changed).toHaveLength(1);
  });

  it("treats an mtime within two seconds as unchanged", () => {
    const changed = selectChanged(
      [candidate("config.json", 10, BASE + 2000)],
      index(entry("20260701-120000-utc", "config.json", 10, BASE)),
    );
    expect(changed).toEqual([]);
  });

  it("captures a file whose mtime moved beyond two seconds", () => {
    const changed = selectChanged(
      [candidate("config.json", 10, BASE + 3000)],
      index(entry("20260701-120000-utc", "config.json", 10, BASE)),
    );
    expect(changed).toHaveLength(1);
  });

  it("compares against the latest entry for the path", () => {
    const idx = index(
      entry("20260701-120000-utc", "config.json", 10, BASE),
      entry("20260701-130000-utc", "config.json", 20, BASE),
    );
    expect(selectChanged([candidate("config.json", 20, BASE)], idx)).toEqual([]);
    expect(selectChanged([candidate("config.json", 10, BASE)], idx)).toHaveLength(1);
  });

  it("recaptures when the stored timestamp is unparseable", () => {
    const bad = entry("20260701-120000-utc", "config.json", 10, BASE);
    bad.lastWriteUtc = "not-a-timestamp";
    expect(selectChanged([candidate("config.json", 10, BASE)], index(bad))).toHaveLength(1);
  });
});
