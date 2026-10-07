import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({
  created: [] as Array<{ path: string; mode: number; size: number }>,
  beforeLink: null as ((source: string, destination: string) => Promise<void>) | null,
  failCopyDestination: null as string | null,
  beforeRm: null as ((path: string) => Promise<void>) | null,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[1] === "wx") {
        const initial = await handle.stat();
        faults.created.push({ path: String(args[0]), mode: initial.mode & 0o777, size: initial.size });
      }
      if (String(args[0]) !== faults.failCopyDestination) return handle;
      return new Proxy(handle, { get(target, key) {
        if (key === "writeFile") return async () => {
          await target.writeFile("PARTIAL");
          throw new Error("copy interrupted after creation");
        };
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      } });
    },
    link: async (source: string, destination: string) => {
      await faults.beforeLink?.(source, destination);
      return actual.link(source, destination);
    },
    rm: async (path: string, options?: Parameters<typeof actual.rm>[1]) => {
      await faults.beforeRm?.(String(path));
      return actual.rm(path, options);
    },
  };
});
vi.mock("electron", () => ({ app: {} }));
const { finalizeOutputsAtomically, OutputPartialFailureError, OutputConflictError } = await import("@main/core/file-output");
const { NewerFormatError } = await import("@main/core/format-versions");
let directory: string;
let source: string;
let targets: { audioPath: string; jsonPath: string; markdownPath: string };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mumbler-output-safety-"));
  source = join(directory, "source.wav");
  targets = { audioPath: join(directory, "take.wav"), jsonPath: join(directory, "take.json"), markdownPath: join(directory, "take.md") };
  await writeFile(source, "NEW AUDIO");
  await writeFile(targets.audioPath, "OLD AUDIO");
  await writeFile(targets.jsonPath, "OLD JSON");
  await writeFile(targets.markdownPath, "OLD MARKDOWN");
  faults.created.length = 0;
  faults.beforeLink = null;
  faults.failCopyDestination = null;
  faults.beforeRm = null;
});
afterEach(async () => {
  faults.created.length = 0;
  faults.beforeLink = null;
  faults.failCopyDestination = null;
  faults.beforeRm = null;
  await rm(directory, { recursive: true, force: true });
});
function save() {
  return finalizeOutputsAtomically({ sourceAudioPath: source, targets, overwrite: true,
    jsonContent: '{"formatVersion":1}', markdownContent: "---\nformat_version: 1\n---\nNEW MARKDOWN" });
}
async function recoveryFiles() {
  return (await readdir(directory)).filter((name) => /\.(bak|tmp)$/.test(name));
}

describe("output ownership and partial outcomes", () => {
  it.each(["json", "markdown"] as const)("refuses a future %s marker before retiring any output", async (kind) => {
    const path = kind === "json" ? targets.jsonPath : targets.markdownPath;
    const future = kind === "json" ? '{"formatVersion":2,"future":true}' : "---\nformat_version: 2\n---\nfuture";
    await writeFile(path, future);
    await expect(save()).rejects.toBeInstanceOf(NewerFormatError);
    expect(await readFile(path, "utf8")).toBe(future);
    expect(await readFile(targets.audioPath, "utf8")).toBe("OLD AUDIO");
    expect(await recoveryFiles()).toEqual([]);
  });

  it("does not overwrite or delete a colliding backup name", async () => {
    let collision = "";
    faults.beforeLink = async (_source, destination) => {
      if (!destination.endsWith(".bak")) return;
      collision = destination;
      await writeFile(destination, "FOREIGN BACKUP");
    };
    await expect(save()).rejects.toBeInstanceOf(OutputConflictError);
    expect(await readFile(targets.audioPath, "utf8")).toBe("OLD AUDIO");
    expect(await readFile(collision, "utf8")).toBe("FOREIGN BACKUP");
    expect(await recoveryFiles()).toEqual([basename(collision)]);
  });

  it("keeps a contender appearing after retirement and retains its previous-output backup", async () => {
    faults.beforeLink = async (staged, destination) => {
      if (staged.endsWith(".tmp") && destination === targets.audioPath) await writeFile(destination, "CONTENDER");
    };
    const error = await save().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(OutputPartialFailureError);
    const partial = error as InstanceType<typeof OutputPartialFailureError>;
    expect(partial.primary).toBeInstanceOf(OutputConflictError);
    expect(partial.issues.some((issue) => issue.operation === "restore previous output")).toBe(true);
    expect(await readFile(targets.audioPath, "utf8")).toBe("CONTENDER");
    const backups = await recoveryFiles();
    expect(backups).toHaveLength(1);
    expect(await readFile(join(directory, backups[0]!), "utf8")).toBe("OLD AUDIO");
    expect(await readFile(targets.jsonPath, "utf8")).toBe("OLD JSON");
    expect(await readFile(source, "utf8")).toBe("NEW AUDIO");
  });

  it.each(["replace", "edit"] as const)("preserves a published output another writer did %s before rollback", async (change) => {
    const primary = new Error("markdown publication refused");
    faults.beforeLink = async (staged, destination) => {
      if (!staged.endsWith(".tmp") || destination !== targets.markdownPath) return;
      if (change === "replace") await rm(targets.audioPath);
      await writeFile(targets.audioPath, "USER CHANGED AUDIO");
      throw primary;
    };
    const error = await save().catch((error: unknown) => error) as InstanceType<typeof OutputPartialFailureError>;
    expect(error).toBeInstanceOf(OutputPartialFailureError);
    expect(error.primary).toBe(primary);
    expect(await readFile(targets.audioPath, "utf8")).toBe("USER CHANGED AUDIO");
    const backups = (await recoveryFiles()).filter((name) => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(directory, backups[0]!), "utf8")).toBe("OLD AUDIO");
    expect(await readFile(targets.jsonPath, "utf8")).toBe("OLD JSON");
  });

  it("keeps the original rejection and named recovery backup when restoration fails", async () => {
    const primary = new Error("markdown publish failed");
    const secondary = new Error("restore permission denied");
    faults.beforeLink = async (staged, destination) => {
      if (staged.endsWith(".tmp") && destination === targets.markdownPath) throw primary;
      if (staged.endsWith(".bak") && destination === targets.jsonPath) throw secondary;
    };
    const partial = await save().catch((error: unknown) => error) as InstanceType<typeof OutputPartialFailureError>;
    expect(partial).toBeInstanceOf(OutputPartialFailureError);
    expect(partial.cause).toBe(primary);
    const issue = partial.issues.find((issue) => issue.operation === "restore previous output");
    expect(issue?.error).toBe(secondary);
    expect(await readFile(issue!.path, "utf8")).toBe("OLD JSON");
    expect(await readFile(targets.audioPath, "utf8")).toBe("OLD AUDIO");
  });

  it("returns committed success with named cleanup warnings when backup deletion fails", async () => {
    const secondary = new Error("backup cleanup permission denied");
    faults.beforeRm = async (path) => { if (path.endsWith(".bak")) throw secondary; };
    const result = await save();
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.every((issue) => issue.error === secondary)).toBe(true);
    expect(await readFile(targets.audioPath, "utf8")).toBe("NEW AUDIO");
    expect(await readFile(targets.jsonPath, "utf8")).toBe('{"formatVersion":1}');
    expect(await recoveryFiles()).toHaveLength(3);
  });

  it("rolls back only its partial exclusive-copy creation when links are unsupported", async () => {
    faults.beforeLink = async (source) => {
      if (source.endsWith(".tmp")) throw Object.assign(new Error("links unsupported"), { code: "ENOTSUP" });
    };
    faults.failCopyDestination = targets.audioPath;
    await expect(save()).rejects.toThrow(/copy interrupted after creation/);
    expect(await readFile(targets.audioPath, "utf8")).toBe("OLD AUDIO");
    expect(await readFile(targets.jsonPath, "utf8")).toBe("OLD JSON");
    expect(await recoveryFiles()).toEqual([]);
  });

  it("does not adopt a staging file another writer replaces during an earlier publication", async () => {
    let contender = "";
    faults.beforeLink = async (source, destination) => {
      if (!source.endsWith(".tmp") || destination !== targets.audioPath) return;
      contender = faults.created.filter((file) => file.path.endsWith(".tmp"))[1]!.path;
      await rm(contender);
      await writeFile(contender, "FOREIGN STAGE");
    };
    await expect(save()).rejects.toBeInstanceOf(OutputPartialFailureError);
    expect(await readFile(contender, "utf8")).toBe("FOREIGN STAGE");
    expect(await readFile(targets.audioPath, "utf8")).toBe("OLD AUDIO");
    expect(await readFile(targets.jsonPath, "utf8")).toBe("OLD JSON");
    expect(await recoveryFiles()).toEqual([basename(contender)]);
  });

  it("refuses a replacement arriving during an unsupported hard-link attempt before fallback copy", async () => {
    let contender = "";
    faults.beforeLink = async (source, destination) => {
      if (!source.endsWith(".tmp") || destination !== targets.audioPath) return;
      contender = source;
      await rm(source);
      await writeFile(source, "FOREIGN FALLBACK SOURCE");
      throw Object.assign(new Error("links unsupported"), { code: "ENOTSUP" });
    };
    await expect(save()).rejects.toBeInstanceOf(OutputPartialFailureError);
    expect(await readFile(contender, "utf8")).toBe("FOREIGN FALLBACK SOURCE");
    expect(await readFile(targets.audioPath, "utf8")).toBe("OLD AUDIO");
    expect(await readFile(targets.jsonPath, "utf8")).toBe("OLD JSON");
    expect(await recoveryFiles()).toEqual([basename(contender)]);
  });

  it("does not treat a replaced stage as the requested unchanged output", async () => {
    let contender = "";
    faults.beforeLink = async (source, destination) => {
      if (source !== targets.audioPath || !destination.endsWith(".bak")) return;
      contender = faults.created.filter((file) => file.path.endsWith(".tmp"))[1]!.path;
      await rm(contender);
      await writeFile(contender, "OLD JSON");
    };
    await expect(save()).rejects.toBeInstanceOf(OutputPartialFailureError);
    expect(await readFile(contender, "utf8")).toBe("OLD JSON");
    expect(await readFile(targets.audioPath, "utf8")).toBe("OLD AUDIO");
    expect(await readFile(targets.jsonPath, "utf8")).toBe("OLD JSON");
    expect(await recoveryFiles()).toEqual([basename(contender)]);
  });

  it("takes replacement access mode after an earlier backup allows the destination to change", async () => {
    if (process.platform === "win32") return;
    await chmod(targets.jsonPath, 0o640);
    faults.beforeLink = async (source, destination) => {
      if (source === targets.audioPath && destination.endsWith(".bak")) await chmod(targets.jsonPath, 0o604);
    };
    await save();
    expect((await stat(targets.jsonPath)).mode & 0o777).toBe(0o604);
  });

  it("preserves ordinary new-output mode after private staging", async () => {
    if (process.platform === "win32") return;
    await rm(targets.jsonPath);
    await save();
    expect((await stat(targets.jsonPath)).mode & 0o777).toBe(0o666 & ~process.umask());
    const stages = faults.created.filter((file) => file.path.endsWith(".tmp"));
    expect(stages).toHaveLength(3);
    expect(stages.every((file) => file.mode === 0o600 && file.size === 0)).toBe(true);
  });

  it("does not claim an unchanged output durable after it changes during another publication", async () => {
    await writeFile(targets.audioPath, "NEW AUDIO");
    faults.beforeLink = async (source, destination) => {
      if (source.endsWith(".tmp") && destination === targets.markdownPath) await writeFile(targets.audioPath, "NEW USER AUDIO");
    };
    await expect(save()).rejects.toBeInstanceOf(OutputConflictError);
    expect(await readFile(targets.audioPath, "utf8")).toBe("NEW USER AUDIO");
    expect(await readFile(targets.jsonPath, "utf8")).toBe("OLD JSON");
    expect(await recoveryFiles()).toEqual([]);
  });

  it("retains the primary failure and owned staging path when temporary cleanup also fails", async () => {
    const primary = new Error("publish failed");
    faults.beforeLink = async (staged, destination) => {
      if (staged.endsWith(".tmp") && destination === targets.markdownPath) throw primary;
    };
    faults.beforeRm = async (path) => { if (path.endsWith(".tmp")) throw new Error("temp cleanup refused"); };
    const partial = await save().catch((error: unknown) => error) as InstanceType<typeof OutputPartialFailureError>;
    expect(partial.primary).toBe(primary);
    expect(partial.issues.filter((issue) => issue.operation === "remove staging file")).toHaveLength(3);
    expect(await readFile(targets.audioPath, "utf8")).toBe("OLD AUDIO");
  });
});
