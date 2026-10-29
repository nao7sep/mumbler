import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppLogger } from "@main/core/logger";

interface ObservedChild {
  tool: string;
  child: ChildProcess;
  ready: Promise<void>;
  closed: Promise<void>;
}

const observed = vi.hoisted(() => ({
  children: [] as ObservedChild[],
  scripts: {} as Record<string, string>,
  onChild: undefined as ((entry: ObservedChild) => void) | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execute = promisify(actual.execFile);
  const execFile = vi.fn(actual.execFile);
  // Only substitute the interpreter: the promise, ChildProcess, timeout options
  // and physical signals remain Node's real implementation.
  Object.defineProperty(execFile, promisify.custom, {
    value: (...args: Parameters<typeof execute>) => {
      const [tool, toolArgs, options] = args;
      const pending = execute(process.execPath, [observed.scripts[tool] ?? tool, ...(toolArgs ?? [])], options);
      const child = pending.child;
      const entry: ObservedChild = {
        tool,
        child,
        ready: new Promise<void>((resolve) => { child.stdout!.once("data", () => resolve()); }),
        closed: new Promise<void>((resolve) => { child.once("close", () => resolve()); }),
      };
      observed.children.push(entry);
      observed.onChild?.(entry);
      return pending;
    },
  });
  return { ...actual, execFile };
});

vi.mock("@main/core/audio-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@main/core/audio-tools")>();
  return {
    ...actual,
    // The managed-tool callers keep their shipped bounds. Tests shorten only
    // the existing owner's deadline and escalation options.
    runTool: vi.fn((tool: string, args: string[], options: Parameters<typeof actual.runTool>[2]) =>
      actual.runTool(tool, args, { ...options, timeoutMs: 200, killEscalationMs: 50 })),
  };
});

// Acquisition bytes are disposable fixtures. The preparation and installed
// version subprocesses still run through their real production owners.
vi.mock("@main/core/binaries/http", () => ({ fetchText: vi.fn(), downloadToFile: vi.fn() }));
vi.mock("@main/core/binaries/archive", () => ({ extractFileFromZip: vi.fn() }));
vi.mock("@main/core/binaries/integrity", async (importOriginal) => ({
  ...await importOriginal<typeof import("@main/core/binaries/integrity")>(),
  verifySha256: vi.fn(async () => undefined),
}));
vi.mock("@main/core/binaries/registry", async (importOriginal) => ({
  ...await importOriginal<typeof import("@main/core/binaries/registry")>(),
  resolveLatest: vi.fn(),
}));

import { ToolTimeoutError } from "@main/core/audio-tools";
import { assertArm64Slice } from "@main/core/binaries/arch";
import { extractFileFromZip } from "@main/core/binaries/archive";
import { downloadToFile, fetchText } from "@main/core/binaries/http";
import { installedVersionSource, readInstalledVersion } from "@main/core/binaries/installed-version";
import { ToolManager } from "@main/core/binaries/manager";
import { resolveLatest } from "@main/core/binaries/registry";
import { createDefaultDependencies } from "@main/core/binaries/store";
import { isCancelledError } from "@main/core/cancellation";

let directory: string;
let binDir: string;
let tempDir: string;
let logger: AppLogger;

beforeEach(async () => {
  // Control the deadline trigger after fixture readiness. Child startup and
  // physical signals remain real; no startup speed allowance is needed.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  directory = await mkdtemp(join(tmpdir(), "mumbler-managed-process-"));
  binDir = join(directory, "bin");
  tempDir = join(directory, "temp");
  await mkdir(binDir);
  observed.children.length = 0;
  observed.scripts = {};
  observed.onChild = undefined;
  logger = {
    debug: vi.fn(async () => undefined),
    info: vi.fn(async () => undefined),
    warn: vi.fn(async () => undefined),
    error: vi.fn(async () => undefined),
    providerCall: vi.fn(async () => undefined),
  };
  vi.mocked(resolveLatest).mockResolvedValue({
    version: "8.2",
    tools: {
      ffmpeg: { downloadUrl: "u", sha256Url: "s", sha256AssetName: "ffmpeg.zip", innerName: "ffmpeg" },
      ffprobe: { downloadUrl: "u", sha256Url: "s", sha256AssetName: "ffprobe.zip", innerName: "ffprobe" },
    },
  });
  vi.mocked(fetchText).mockResolvedValue("a".repeat(64) + "  ffmpeg.zip\n");
  vi.mocked(downloadToFile).mockImplementation(async ({ destPath }) => { await writeFile(destPath, "archive"); });
  vi.mocked(extractFileFromZip).mockImplementation(async (_zip, name, destination) => {
    await writeFile(destination, `process.stdout.write('${name} version 8.2 Copyright\\n');\n`);
  });
  await systemTool("lipo", "process.stdout.write('arm64\\n');\n");
  await systemTool("xattr", "process.stdout.write('no quarantine attribute\\n');\nprocess.exitCode = 1;\n");
});

afterEach(async () => {
  // A negative proof must still clean up a child the old implementation leaves
  // alive, before removing any script or staging file that child owns.
  for (const { child } of observed.children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(observed.children.map(({ closed }) => closed));
  await rm(directory, { recursive: true, force: true });
  vi.useRealTimers();
  vi.clearAllMocks();
});

function manager(): ToolManager {
  return new ToolManager({
    binDir, tempDir, platform: "darwin", arch: "arm64",
    value: createDefaultDependencies(),
    store: { save: vi.fn(async () => undefined) },
    logger,
    notify: vi.fn(),
  });
}

async function systemTool(name: string, script: string): Promise<void> {
  const path = join(directory, `${name}.cjs`);
  await writeFile(path, script);
  observed.scripts[name] = path;
}

async function childFor(tool: string): Promise<ObservedChild & { child: ChildProcess & { pid: number } }> {
  const entry = observed.children.find((candidate) => candidate.tool === tool) ??
    await new Promise<ObservedChild>((resolve) => {
      observed.onChild = (candidate) => {
        if (candidate.tool !== tool) return;
        observed.onChild = undefined;
        resolve(candidate);
      };
    });
  expect(entry.child.pid).toBeGreaterThan(1);
  await entry.ready;
  return entry as ObservedChild & { child: ChildProcess & { pid: number } };
}

function expectProcessGone(pid: number): void {
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}

describe.skipIf(process.platform === "win32")("managed-tool subprocess settlement", () => {
  it("startup settles a version probe that ignores SIGTERM as installed but unversioned", async () => {
    const tool = join(binDir, "ffmpeg");
    await writeFile(tool,
      "process.on('SIGTERM', () => {});\n" +
      "process.stdout.write('ffmpeg version 8.2 Copyright\\n');\n" +
      "setInterval(() => {}, 1_000);\n");
    await writeFile(join(binDir, "ffprobe"), "process.stdout.write('ffprobe version 8.2 Copyright\\n');\n");
    const tools = manager();

    const reconciling = tools.reconcile();
    const { child, closed } = await childFor(tool);
    await vi.advanceTimersByTimeAsync(250);
    await closed;
    // The tools are probed one at a time.
    await (await childFor(join(binDir, "ffprobe"))).closed;
    await reconciling;

    expect(child.signalCode).toBe("SIGKILL");
    expectProcessGone(child.pid);
    expect(tools.listStatuses()).toMatchObject([
      { name: "ffmpeg", state: "installed-unchecked", installedVersion: null },
      { name: "ffprobe", state: "installed-unchecked", installedVersion: "8.2" },
    ]);
    expect(logger.warn).toHaveBeenCalledWith("tools.version-unreadable", expect.any(String), expect.objectContaining({ tool: "ffmpeg", path: tool, error: expect.objectContaining({ name: "ToolTimeoutError" }) }));
    expect(await readdir(binDir)).toEqual(["ffmpeg", "ffprobe"]);
  });

  it("an ordinary failed version probe preserves its cause after the child exits", async () => {
    const tool = join(binDir, "ffmpeg");
    await writeFile(tool, "process.stdout.write('ffmpeg version 8.2 Copyright\\n');\nprocess.exitCode = 1;\n");

    await expect(readInstalledVersion("ffmpeg", tool, binDir, installedVersionSource("darwin"))).rejects.toMatchObject({ code: 1 });

    expectProcessGone(observed.children[0]!.child.pid!);
  });

  it("architecture deadline preserves its timeout classification and the actual child failure", async () => {
    await systemTool("lipo", "process.stdout.write('ready\\n');\nsetInterval(() => {}, 1_000);\n");
    const checking = assertArm64Slice("staged binary").then(() => undefined, (error: unknown) => error);
    const { child } = await childFor("lipo");

    await vi.advanceTimersByTimeAsync(200);
    const error = await checking;
    expect(error).toBeInstanceOf(ToolTimeoutError);
    expect(error).toMatchObject({ cause: { signal: "SIGTERM" } });
    expectProcessGone(child.pid);
  });

  it("architecture cancellation settles the child and remains cancellation", async () => {
    await systemTool("lipo", "process.stdout.write('ready\\n');\nsetInterval(() => {}, 1_000);\n");
    const controller = new AbortController();
    const checking = assertArm64Slice("staged binary", controller.signal).then(() => undefined, (error: unknown) => error);
    const { child } = await childFor("lipo");

    controller.abort();
    expect(isCancelledError(await checking)).toBe(true);
    expectProcessGone(child.pid);
  });

  it("a clean architecture exit after the deadline still reports timeout", async () => {
    await systemTool("lipo",
      "process.on('SIGTERM', () => process.exit(0));\n" +
      "process.stdout.write('arm64\\n');\nsetInterval(() => {}, 1_000);\n");
    const checking = assertArm64Slice("staged binary").then(() => undefined, (error: unknown) => error);
    const { child } = await childFor("lipo");

    await vi.advanceTimersByTimeAsync(200);
    const error = await checking;
    expect(error).toBeInstanceOf(ToolTimeoutError);
    expect(error).not.toHaveProperty("cause");
    expect(child.exitCode).toBe(0);
    expectProcessGone(child.pid);
  });

  it("a clean architecture exit after cancellation still reports cancellation", async () => {
    await systemTool("lipo",
      "process.on('SIGTERM', () => process.exit(0));\n" +
      "process.stdout.write('arm64\\n');\nsetInterval(() => {}, 1_000);\n");
    const controller = new AbortController();
    const checking = assertArm64Slice("staged binary", controller.signal).then(() => undefined, (error: unknown) => error);
    const { child } = await childFor("lipo");

    controller.abort();
    expect(isCancelledError(await checking)).toBe(true);
    expect(child.exitCode).toBe(0);
    expectProcessGone(child.pid);
  });

  it("quarantine deadline refuses a clean exit's publication and removes staging after actual settlement", async () => {
    await systemTool("xattr",
      "process.on('SIGTERM', () => process.exit(0));\n" +
      "process.stdout.write('ready\\n');\nsetInterval(() => {}, 1_000);\n");
    const tools = manager();
    const installing = tools.installTool("ffmpeg");
    const { child } = await childFor("xattr");
    expect(await readdir(tempDir)).toHaveLength(2);
    expect(await readdir(binDir)).toEqual([]);

    await vi.advanceTimersByTimeAsync(200);
    await installing;

    expect(child.exitCode).toBe(0);
    expectProcessGone(child.pid);
    expect(tools.listStatuses()[0]).toMatchObject({
      state: "not-installed", installedVersion: null,
      transient: { kind: "failed", operation: "provision", error: { key: "tools.provisionFailed" } },
    });
    expect(await readdir(tempDir)).toEqual([]);
    expect(await readdir(binDir)).toEqual([]);
  });

  it("still tolerates ordinary quarantine command failure and reads the published binary version", async () => {
    const tools = manager();

    await tools.installTool("ffmpeg");

    expect(tools.listStatuses()[0]).toMatchObject({
      state: "up-to-date", installedVersion: "8.2", transient: { kind: "idle" },
    });
    expect(await readdir(tempDir)).toEqual([]);
    expect(await readdir(binDir)).toEqual(["ffmpeg"]);
    for (const { child } of observed.children) expectProcessGone(child.pid!);
  });
});
