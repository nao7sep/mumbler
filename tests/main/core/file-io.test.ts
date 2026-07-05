import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { capturedRenames } = vi.hoisted(() => ({
  capturedRenames: [] as Array<{ source: string; destination: string }>,
}));

// Observes (without altering) every rename the module under test performs, so the
// atomic-write temp-file and quarantine-file shapes can be pinned without new
// production-code hooks. Every other fs operation runs for real.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: (source: string, destination: string) => {
      capturedRenames.push({ source: String(source), destination: String(destination) });
      return actual.rename(source, destination);
    },
  };
});

const { preserveAside, uniquePathInDirectory, writeJsonFile } = await import("@main/core/file-io");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mumbler-file-io-"));
  capturedRenames.length = 0;
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

describe("writeJsonFile", () => {
  it("names its atomic-write temp file <stem>-<nanoid>.tmp in the target's own directory", async () => {
    const target = join(dir, "config.json");

    await writeJsonFile(target, { hello: "world" });

    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ hello: "world" });

    const tempRenames = capturedRenames.filter((r) => r.destination === target);
    expect(tempRenames).toHaveLength(1);
    expect(dirname(tempRenames[0]!.source)).toBe(dir);
    expect(basename(tempRenames[0]!.source)).toMatch(/^config-[\w-]{8}\.tmp$/);
  });
});

describe("preserveAside", () => {
  it("quarantines an existing file as <stem>-<yyyymmdd-hhmmss-fff-utc>.invalid in the same directory", async () => {
    const target = join(dir, "state.json");
    await writeFile(target, "not valid json");

    const preserved = await preserveAside(target);

    expect(preserved).not.toBeNull();
    expect(dirname(preserved!)).toBe(dir);
    expect(basename(preserved!)).toMatch(/^state-\d{8}-\d{6}-\d{3}-utc\.invalid$/);
    expect(await readFile(preserved!, "utf8")).toBe("not valid json");
  });

  it("returns null without renaming anything when the file does not exist", async () => {
    const target = join(dir, "missing.json");
    expect(await preserveAside(target)).toBeNull();
    expect(capturedRenames).toEqual([]);
  });
});
