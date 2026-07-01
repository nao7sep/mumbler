// The collector's case-insensitive uniqueness rule: when two files map to archive paths differing only in
// case (possible only on a case-sensitive filesystem the archive may later be unzipped onto a
// case-insensitive one), one candidate is kept and the other recorded as a skip. The walk is driven over
// a mocked fs so the case-colliding pair can be fabricated on any host filesystem.

import { describe, it, expect, vi, beforeEach } from "vitest";

const readdir = vi.fn();
const stat = vi.fn();

vi.mock("node:fs", () => ({
  promises: {
    readdir: (...args: unknown[]) => readdir(...args),
    stat: (...args: unknown[]) => stat(...args),
  },
}));

import { collectRoots } from "@main/core/backup/backup-collector.js";

const HOME = "/home/.mumbler";

function dirent(name: string, isDir: boolean): unknown {
  return { name, isDirectory: () => isDir, isFile: () => !isDir };
}

beforeEach(() => {
  readdir.mockReset();
  stat.mockReset();
  stat.mockResolvedValue({ size: 3, mtimeMs: 1_700_000_000_000 });
});

describe("collectRoots", () => {
  it("keeps one of two case-colliding archive paths and skips the other", async () => {
    readdir.mockImplementation(async (dir: string) => {
      if (dir === HOME) return [dirent("config.json", false), dirent("CONFIG.JSON", false)];
      return [];
    });

    const { candidates, skips } = await collectRoots(HOME);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].archivePath).toBe("config.json");
    expect(skips).toHaveLength(1);
    expect(skips[0].reason).toContain("collides case-insensitively");
  });

  it("excludes the working tree and layout.json during the walk", async () => {
    readdir.mockImplementation(async (dir: string) => {
      if (dir === HOME) {
        return [
          dirent("config.json", false),
          dirent("layout.json", false),
          dirent("working", true),
        ];
      }
      throw new Error(`unexpected descent into ${dir}`);
    });

    const { candidates } = await collectRoots(HOME);

    expect(candidates.map((c) => c.archivePath)).toEqual(["config.json"]);
  });
});
