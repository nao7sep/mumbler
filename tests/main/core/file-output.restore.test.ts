import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// finalizeOutputsAtomically's module imports electron; stub it so the module loads.
vi.mock("electron", () => ({ app: { getVersion: () => "9.9.9-test" } }));

const { capturedPublications, linkRefusal } = vi.hoisted(() => ({
  capturedPublications: [] as Array<{ source: string; destination: string }>,
  // When set, link() fails with this code, the way a filesystem without hard
  // links (FAT, exFAT) refuses it.
  linkRefusal: { code: null as string | null },
}));

// Fail the Markdown exclusive publication after earlier outputs committed.
// Backup/restore links and all other file operations run against real files.
// Capture link paths to verify each staged/backup name is distinct.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: (existing: string, created: string) => {
      capturedPublications.push({ source: existing, destination: created });
      if (linkRefusal.code === null && existing.endsWith(".tmp") && created.endsWith(".md")) {
        return Promise.reject(new Error("injected publication failure"));
      }
      if (linkRefusal.code !== null) {
        return Promise.reject(Object.assign(new Error(`link refused: ${linkRefusal.code}`), { code: linkRefusal.code }));
      }
      return actual.link(existing, created);
    },
  };
});

const { finalizeOutputsAtomically, OutputConflictError } = await import("@main/core/file-output");

let dir: string;
let sourceAudio: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mumbler-restore-"));
  sourceAudio = join(dir, "source.m4a");
  await writeFile(sourceAudio, "AUDIO-BYTES");
  capturedPublications.length = 0;
  linkRefusal.code = null;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("finalizeOutputsAtomically — restore from backup on failure", () => {
  it("restores the overwritten originals when a later publication fails mid-commit", async () => {
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
    const tempSources = capturedPublications.map((r) => r.source).filter((p) => p.endsWith(".tmp"));
    const backupDestinations = capturedPublications
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

describe("finalizeOutputsAtomically — a filesystem without hard links", () => {
  function targets() {
    return {
      audioPath: join(dir, "out.m4a"),
      jsonPath: join(dir, "out.json"),
      markdownPath: join(dir, "out.md"),
    };
  }

  it("replaces existing outputs with exclusive streamed backups on a filesystem without links", async () => {
    linkRefusal.code = "ENOTSUP";
    const t = targets();
    await writeFile(t.audioPath, "OLD-AUDIO");
    await writeFile(t.jsonPath, "OLD-JSON");
    await writeFile(t.markdownPath, "OLD-MD");
    const result = await finalizeOutputsAtomically({ sourceAudioPath: sourceAudio, targets: t,
      overwrite: true, jsonContent: "NEW-JSON", markdownContent: "NEW-MD" });
    expect(result.warnings).toEqual([]);
    expect(await readFile(t.audioPath, "utf8")).toBe("AUDIO-BYTES");
    expect(await readFile(t.jsonPath, "utf8")).toBe("NEW-JSON");
    expect((await readdir(dir)).filter((name) => /\.(bak|tmp)$/.test(name))).toEqual([]);
  });

  it("still publishes a new save, by exclusive copy that keeps the recording's modified time", async () => {
    linkRefusal.code = "ENOTSUP";
    const t = targets();
    const recorded = new Date(Date.UTC(2024, 4, 6, 7, 8, 9, 500));
    await utimes(sourceAudio, recorded, recorded);

    await finalizeOutputsAtomically({
      sourceAudioPath: sourceAudio,
      targets: t,
      overwrite: false,
      jsonContent: "J",
      markdownContent: "M",
    });

    expect(await readFile(t.audioPath, "utf8")).toBe("AUDIO-BYTES");
    expect(await readFile(t.jsonPath, "utf8")).toBe("J");
    expect(await readFile(t.markdownPath, "utf8")).toBe("M");
    expect((await stat(t.audioPath)).mtime.getTime()).toBe(recorded.getTime());
    expect((await readdir(dir)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("still refuses to replace a target that appeared after the check", async () => {
    linkRefusal.code = "EPERM";
    const t = targets();
    await writeFile(t.jsonPath, "SOMEONE-ELSE");

    await expect(
      finalizeOutputsAtomically({
        sourceAudioPath: sourceAudio,
        targets: t,
        overwrite: false,
        jsonContent: "J",
        markdownContent: "M",
      }),
    ).rejects.toBeInstanceOf(OutputConflictError);

    expect(await readFile(t.jsonPath, "utf8")).toBe("SOMEONE-ELSE");
    expect(await readdir(dir)).toEqual(["out.json", "source.m4a"]);
  });
});
