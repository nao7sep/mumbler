import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// finalizeOutputsAtomically's module imports electron; stub it so the module loads.
vi.mock("electron", () => ({ app: { getVersion: () => "9.9.9-test" } }));

const { capturedRenames } = vi.hoisted(() => ({
  capturedRenames: [] as Array<{ source: string; destination: string }>,
}));

// Inject exactly one rename failure: the markdown finalize step, identified as a
// ".tmp" source renamed onto the final ".md" path. Every other fs operation —
// including the backup renames (dest ends ".bak") and the restore renames
// (source ".bak", dest ".md") — runs for real, so the restore-from-backup branch
// executes end to end. The whole node:fs/promises module is spread through
// unchanged apart from this single wrapped function. Every rename call is also
// recorded (source, destination), so the derived-filename shapes can be pinned
// below without any further production-code hooks.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: (source: string, destination: string) => {
      capturedRenames.push({ source: String(source), destination: String(destination) });
      if (String(source).includes(".tmp") && String(destination).endsWith(".md")) {
        return Promise.reject(new Error("injected rename failure"));
      }
      return actual.rename(source, destination);
    },
  };
});

const { finalizeOutputsAtomically } = await import("@main/core/file-output");

let dir: string;
let sourceAudio: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mumbler-restore-"));
  sourceAudio = join(dir, "source.m4a");
  await writeFile(sourceAudio, "AUDIO-BYTES");
  capturedRenames.length = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("finalizeOutputsAtomically — restore from backup on failure", () => {
  it("restores the overwritten originals when a later rename fails mid-commit", async () => {
    const targets = {
      audioPath: join(dir, "out.m4a"),
      jsonPath: join(dir, "out.json"),
      markdownPath: join(dir, "out.md"),
    };
    await writeFile(targets.audioPath, "OLD-AUDIO");
    await writeFile(targets.jsonPath, "OLD-JSON");
    await writeFile(targets.markdownPath, "OLD-MD");

    await expect(
      finalizeOutputsAtomically({
        sourceAudioPath: sourceAudio,
        targets,
        overwrite: true,
        jsonContent: "NEW-JSON",
        markdownContent: "NEW-MD",
      }),
    ).rejects.toThrow(/finalize/i);

    // Every original must be back in place — a failed overwrite leaves no data loss.
    expect(await readFile(targets.audioPath, "utf8")).toBe("OLD-AUDIO");
    expect(await readFile(targets.jsonPath, "utf8")).toBe("OLD-JSON");
    expect(await readFile(targets.markdownPath, "utf8")).toBe("OLD-MD");

    // No temp or backup files survive the rollback.
    const leftovers = (await readdir(dir)).filter(
      (name) => name.includes(".tmp") || name.includes(".bak"),
    );
    expect(leftovers).toEqual([]);

    // Pin the new derived-filename grammar: audio/json/markdown all share one
    // stem ("out"), so each temp/backup name must draw its own nanoid — never a
    // token shared across the three — or they would collide on disk.
    const tempSources = capturedRenames.map((r) => r.source).filter((p) => p.endsWith(".tmp"));
    const backupDestinations = capturedRenames
      .map((r) => r.destination)
      .filter((p) => p.endsWith(".bak"));
    expect(tempSources.length).toBeGreaterThanOrEqual(3);
    expect(backupDestinations.length).toBeGreaterThanOrEqual(3);
    for (const p of [...tempSources, ...backupDestinations]) {
      expect(dirname(p)).toBe(dir);
    }
    for (const p of tempSources) {
      expect(basename(p)).toMatch(/^out-[\w-]{8}\.tmp$/);
    }
    for (const p of backupDestinations) {
      expect(basename(p)).toMatch(/^out-[\w-]{8}\.bak$/);
    }
    // Same stem, same role extension, yet every name is distinct.
    expect(new Set(tempSources).size).toBe(tempSources.length);
    expect(new Set(backupDestinations).size).toBe(backupDestinations.length);
  });
});
