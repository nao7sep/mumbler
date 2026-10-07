import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({
  refuseCleanup: false,
  created: [] as Array<{ path: string; mode: number; size: number }>,
  beforePublish: null as ((source: string) => Promise<void>) | null,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[1] === "wx") {
        const initial = await handle.stat();
        faults.created.push({ path: String(args[0]), mode: initial.mode & 0o777, size: initial.size });
      }
      return handle;
    },
    link: async (source: string, target: string) => {
      await faults.beforePublish?.(source);
      return actual.link(source, target);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (faults.refuseCleanup && basename(String(args[0])).startsWith(".mumbler-save-")) throw new Error("staging cleanup denied");
      return actual.rm(...args);
    },
  };
});
const { finalizeOutputs, OutputPartialFailureError } = await import("@main/core/file-output");
const { NewerFormatError } = await import("@main/core/format-versions");
let directory: string;
let source: string;
const targets = () => ({ audioPath: join(directory, "out.wav"), jsonPath: join(directory, "out.json"), markdownPath: join(directory, "out.md") });
const save = (overwrite = true) => finalizeOutputs({ sourceAudioPath: source, targets: targets(), overwrite, jsonContent: "NEW JSON", markdownContent: "NEW MD" });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mumbler-output-safety-"));
  source = join(directory, "source.wav");
  await writeFile(source, "NEW AUDIO");
  faults.created.length = 0;
  faults.refuseCleanup = false;
  faults.beforePublish = null;
});
afterEach(async () => {
  faults.refuseCleanup = false;
  await rm(directory, { recursive: true, force: true });
});

describe("staging and supported output markers", () => {
  it.each(["json", "markdown"] as const)("refuses newer %s before publishing even audio", async (kind) => {
    const t = targets();
    const path = kind === "json" ? t.jsonPath : t.markdownPath;
    const future = kind === "json" ? '{"formatVersion":2}' : "---\nformat_version: 2\n---\nFuture body";
    await writeFile(path, future);
    await writeFile(t.audioPath, "OLD AUDIO");
    await expect(save()).rejects.toBeInstanceOf(NewerFormatError);
    expect(await readFile(path, "utf8")).toBe(future);
    expect(await readFile(t.audioPath, "utf8")).toBe("OLD AUDIO");
    expect((await readdir(directory)).filter((name) => name.startsWith(".mumbler-save-"))).toEqual([]);
  });
  it.skipIf(process.platform === "win32")("creates one private directory and complete private stages before publication", async () => {
    let publications = 0;
    faults.beforePublish = async (stage) => {
      publications += 1;
      const staging = dirname(stage);
      expect((await stat(staging)).mode & 0o777).toBe(0o700);
      expect((await readdir(staging)).sort()).toEqual(["audio", "metadata.json", "transcript.md"]);
      expect(await readFile(join(staging, "audio"), "utf8")).toBe("NEW AUDIO");
      expect(await readFile(join(staging, "metadata.json"), "utf8")).toBe("NEW JSON");
      expect(await readFile(join(staging, "transcript.md"), "utf8")).toBe("NEW MD");
    };
    await save(false);
    expect(publications).toBe(3);
    expect(faults.created).toHaveLength(3);
    expect(faults.created.every((entry) => entry.mode === 0o600 && entry.size === 0)).toBe(true);
    expect((await stat(targets().jsonPath)).mode & 0o777).toBe(0o666 & ~process.umask());
  });
  it("reports staging cleanup secondarily after committed outputs", async () => {
    faults.refuseCleanup = true;
    const result = await save(false);
    expect(result.warnings).toEqual([expect.objectContaining({ operation: "remove staging directory" })]);
    expect(await readFile(targets().audioPath, "utf8")).toBe("NEW AUDIO");
    expect(await readFile(targets().markdownPath, "utf8")).toBe("NEW MD");
  });
  it("retains the primary staging error alongside cleanup failure", async () => {
    faults.refuseCleanup = true;
    const attempt = finalizeOutputs({ sourceAudioPath: join(directory, "missing.wav"), targets: targets(), overwrite: false, jsonContent: "JSON", markdownContent: "MD" });
    await expect(attempt).rejects.toBeInstanceOf(OutputPartialFailureError);
    await expect(attempt).rejects.toMatchObject({ primary: expect.objectContaining({ code: "ENOENT" }), issues: [expect.objectContaining({ operation: "remove staging directory" })], files: [
      { path: targets().audioPath, status: "pending" }, { path: targets().jsonPath, status: "pending" }, { path: targets().markdownPath, status: "pending" },
    ] });
  });
  it("reports cancellation after an earlier publication as partial rather than nothing saved", async () => {
    const controller = new AbortController();
    faults.beforePublish = async () => { controller.abort(); };
    const attempt = finalizeOutputs({ sourceAudioPath: source, targets: targets(), overwrite: false, jsonContent: "JSON", markdownContent: "MD", signal: controller.signal });
    await expect(attempt).rejects.toMatchObject({ files: [
      { path: targets().audioPath, status: "saved" }, { path: targets().jsonPath, status: "failed" }, { path: targets().markdownPath, status: "pending" },
    ] });
    expect(await readFile(targets().audioPath, "utf8")).toBe("NEW AUDIO");
    expect((await readdir(directory)).sort()).toEqual(["out.wav", "source.wav"]);
  });
});
