import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({ linkCode: null as string | null, failTarget: null as string | null, beforeRename: null as ((source: string, target: string) => Promise<void>) | null }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    link: async (source: string, target: string) => {
      if (faults.linkCode) throw Object.assign(new Error("hard links unavailable"), { code: faults.linkCode });
      return actual.link(source, target);
    },
    rename: async (source: string, target: string) => {
      await faults.beforeRename?.(source, target);
      if (target === faults.failTarget) throw new Error("publication refused");
      return actual.rename(source, target);
    },
  };
});
const { finalizeOutputs, OutputPartialFailureError, OutputConflictError } = await import("@main/core/file-output");
let directory: string;
let source: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mumbler-publication-"));
  source = join(directory, "source.wav");
  await writeFile(source, "NEW AUDIO");
  faults.linkCode = null;
  faults.failTarget = null;
  faults.beforeRename = null;
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const targets = () => ({ audioPath: join(directory, "out.wav"), jsonPath: join(directory, "out.json"), markdownPath: join(directory, "out.md") });
const save = (overwrite = false) => finalizeOutputs({ sourceAudioPath: source, targets: targets(), overwrite, jsonContent: "NEW JSON", markdownContent: "NEW MD" });

describe("independent output publication", () => {
  it("retains earlier replacements when a later ordinary replacement fails", async () => {
    const t = targets();
    for (const [path, text] of [[t.audioPath, "OLD AUDIO"], [t.jsonPath, "OLD JSON"], [t.markdownPath, "OLD MD"]]) await writeFile(path!, text!);
    faults.failTarget = t.markdownPath;
    const attempt = save(true);
    await expect(attempt).rejects.toBeInstanceOf(OutputPartialFailureError);
    await expect(attempt).rejects.toMatchObject({ files: [
      { path: t.audioPath, status: "saved" }, { path: t.jsonPath, status: "saved" }, { path: t.markdownPath, status: "failed" },
    ] });
    expect(await readFile(t.audioPath, "utf8")).toBe("NEW AUDIO");
    expect(await readFile(t.jsonPath, "utf8")).toBe("NEW JSON");
    expect(await readFile(t.markdownPath, "utf8")).toBe("OLD MD");
    expect((await readdir(directory)).sort()).toEqual(["out.json", "out.md", "out.wav", "source.wav"]);
  });
  it("serializes publication across cards after parallel staging, and releases a failed turn", async () => {
    const secondSource = join(directory, "second.wav");
    await writeFile(secondSource, "SECOND AUDIO");
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    faults.beforeRename = async (_source, target) => {
      if (first && target === targets().jsonPath) {
        first = false;
        entered();
        await held;
        throw new Error("first card JSON publication refused");
      }
    };
    const firstSave = save(true);
    const failedFirst = expect(firstSave).rejects.toBeInstanceOf(OutputPartialFailureError);
    await firstEntered;
    const secondSave = finalizeOutputs({ sourceAudioPath: secondSource, targets: targets(), overwrite: true, jsonContent: "SECOND JSON", markdownContent: "SECOND MD" });
    try {
      // Both staging directories exist while only the first has published audio.
      await vi.waitFor(async () => expect((await readdir(directory)).filter((name) => name.startsWith(".mumbler-save-"))).toHaveLength(2));
      expect(await readFile(targets().audioPath, "utf8")).toBe("NEW AUDIO");
      release();
      await failedFirst;
      await secondSave;
      expect(await readFile(targets().audioPath, "utf8")).toBe("SECOND AUDIO");
      expect(await readFile(targets().jsonPath, "utf8")).toBe("SECOND JSON");
      expect(await readFile(targets().markdownPath, "utf8")).toBe("SECOND MD");
    } finally { release(); await Promise.allSettled([firstSave, secondSave]); }
  });
  it.each(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"])("uses exclusive copy when hard links reject with %s", async (code) => {
    faults.linkCode = code;
    const earlier = new Date("2024-01-02T03:04:05Z");
    await utimes(source, earlier, earlier);
    await expect(save()).resolves.toEqual({ warnings: [] });
    expect(await readFile(targets().audioPath, "utf8")).toBe("NEW AUDIO");
    expect((await stat(targets().audioPath)).mtime.getTime()).toBe(earlier.getTime());
  });
  it("exclusive copy refuses an occupied fresh name without replacing it", async () => {
    faults.linkCode = "ENOTSUP";
    await writeFile(targets().audioPath, "OTHER AUDIO");
    await expect(save()).rejects.toBeInstanceOf(OutputConflictError);
    expect(await readFile(targets().audioPath, "utf8")).toBe("OTHER AUDIO");
    expect((await readdir(directory)).sort()).toEqual(["out.wav", "source.wav"]);
  });
});
