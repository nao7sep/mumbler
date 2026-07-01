// The home-root exclude list: managed durable data (config.json, state.json, api-keys.json,
// dependencies.json — including the secret) is kept; the working/output/bin/temp/backups/logs subtrees,
// volatile layout.json, atomic-write temporaries, and OS metadata sidecars are dropped.

import { describe, it, expect } from "vitest";
import { isExcludedFile, isExcludedDir } from "@main/core/backup/home-root-exclusions.js";

describe("isExcludedFile", () => {
  it.each(["config.json", "state.json", "api-keys.json", "dependencies.json"])(
    "includes managed file %s",
    (relativePath) => {
      expect(isExcludedFile(relativePath)).toBe(false);
    },
  );

  it.each([
    "layout.json",
    "working/rec.m4a",
    "output/2026-export.md",
    "bin/ffmpeg",
    "temp/download.part",
    "backups/index.json",
    "backups/backup-20260701-000000-utc.zip",
    "logs/20260701.log",
    ".config.json.abc123.tmp",
    ".DS_Store",
    "sub/.DS_Store",
    "Thumbs.db",
    "desktop.ini",
    "Desktop.ini", // OS-noise floor, matched case-insensitively
  ])("excludes %s", (relativePath) => {
    expect(isExcludedFile(relativePath)).toBe(true);
  });
});

describe("isExcludedDir", () => {
  it("prunes the working, output, bin, temp, backups, and logs directories", () => {
    for (const dir of ["working", "output", "bin", "temp", "backups", "logs"]) {
      expect(isExcludedDir(dir)).toBe(true);
    }
  });

  it("does not prune an unrelated directory", () => {
    expect(isExcludedDir("data")).toBe(false);
  });
});
