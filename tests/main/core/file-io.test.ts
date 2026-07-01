import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { uniquePathInDirectory } from "@main/core/file-io";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mumbler-file-io-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("uniquePathInDirectory", () => {
  it("returns the requested name unchanged when the directory is empty", async () => {
    const path = await uniquePathInDirectory(dir, "clip.wav");
    expect(dirname(path)).toBe(dir);
    expect(basename(path)).toBe("clip.wav");
  });

  it("disambiguates a name that collides case-insensitively", async () => {
    // "Clip.wav" already on disk; "clip.wav" would silently clobber it on the
    // case-insensitive filesystems (macOS/Windows) the invariant guards against.
    await writeFile(join(dir, "Clip.wav"), "existing");

    const path = await uniquePathInDirectory(dir, "clip.wav");

    expect(basename(path).toLowerCase()).not.toBe("clip.wav");
    expect(basename(path)).toMatch(/^clip-[^.]+\.wav$/);
  });
});
