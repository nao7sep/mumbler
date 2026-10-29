import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppLogger } from "@main/core/logger";
import type { ToolName, ToolTransient } from "@shared/app-shell";

const { durabilityEvents } = vi.hoisted(() => ({
  durabilityEvents: [] as Array<{ kind: "file"; path: string }>,
}));
const discoveryFault = vi.hoisted(() => ({ path: "" }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, stat: (...args: Parameters<typeof actual.stat>) => {
    if (args[0] === discoveryFault.path) throw Object.assign(new Error("inspection refused"), { code: "EACCES" });
    return actual.stat(...args);
  } };
});

vi.mock("@main/core/file-io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@main/core/file-io")>();
  return {
    ...actual,
    syncFile: vi.fn(async (path: string) => {
      await actual.syncFile(path);
      durabilityEvents.push({ kind: "file", path });
    }),
  };
});

// The network/extraction edges are stubbed; everything else (the store, the facts
// transitions, the derivation, presence reconcile) runs for real against a temp
// directory. This covers the manager's I/O orchestration — that it applies the
// right transition and emits the right transient — without touching the network.
vi.mock("@main/core/binaries/http", () => ({
  fetchText: vi.fn(),
  downloadToFile: vi.fn(),
}));
vi.mock("@main/core/binaries/archive", () => ({
  extractFileFromZip: vi.fn(),
}));
vi.mock("@main/core/binaries/arch", () => ({
  assertArm64Slice: vi.fn(),
}));
// Native permission behavior is verified in the live lane.
// Ordinary manager fixtures stub the outbound command, just like architecture.
vi.mock("@main/core/audio-tools", async (importOriginal) => ({
  ...await importOriginal<typeof import("@main/core/audio-tools")>(),
  runTool: vi.fn(),
}));
vi.mock("@main/core/binaries/integrity", async (importOriginal) => ({
  ...await importOriginal<typeof import("@main/core/binaries/integrity")>(),
  parseSha256Sidecar: vi.fn(() => "a".repeat(64)),
  verifySha256: vi.fn(async () => undefined),
}));
vi.mock("@main/core/binaries/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@main/core/binaries/registry")>();
  return { ...actual, resolveLatest: vi.fn() };
});
// The real read SPAWNS the installed binary; the "binary" published here is a text
// file, so the stub reads its contents and runs them through the REAL banner parser
// instead. What is under test is unchanged and is the point of the whole design:
// the version travels with the artifact — it is whatever the file in bin/ says, and
// a file that says nothing recognizable has no version.
vi.mock("@main/core/binaries/installed-version", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@main/core/binaries/installed-version")>();
  const { readFile } = await import("node:fs/promises");
  return {
    ...actual,
    probeToolVersion: vi.fn(async (name: ToolName, toolPath: string, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const version = actual.parseVersionBanner(name, await readFile(toolPath, "utf8"));
      if (version === null) throw new Error("unrecognized version");
      return version;
    }),
    readInstalledVersion: vi.fn(async (name: ToolName, toolPath: string, binDir: string, source: import("@main/core/binaries/installed-version").InstalledVersionSource) => {
      if (source.kind === "sidecar") return actual.readInstalledVersion(name, toolPath, binDir, source);
      try {
        return actual.parseVersionBanner(name, await readFile(toolPath, "utf8"));
      } catch {
        return null;
      }
    }),
  };
});

import { runTool } from "@main/core/audio-tools";
import { assertArm64Slice } from "@main/core/binaries/arch";
import { extractFileFromZip } from "@main/core/binaries/archive";
import { downloadToFile, fetchText } from "@main/core/binaries/http";
import * as installedVersion from "@main/core/binaries/installed-version";
import { verifySha256 } from "@main/core/binaries/integrity";
import { ToolManager } from "@main/core/binaries/manager";
import { TOOL_EXTRACTED_MAX_BYTES, resolveLatest } from "@main/core/binaries/registry";
import { createDependenciesStore } from "@main/core/binaries/store";
import { JsonStore } from "@main/core/json-store";
import { until } from "../../../support/until";

const RESOLVED = {
  version: "8.2",
  tools: {
    ffmpeg: { downloadUrl: "u", sha256Url: "s", sha256AssetName: "ffmpeg.zip", innerName: "ffmpeg" },
    ffprobe: { downloadUrl: "u", sha256Url: "s", sha256AssetName: "ffprobe.zip", innerName: "ffprobe" },
  },
} as const;

// What ffmpeg/ffprobe print on their first line.
function banner(name: string, version: string): string {
  return `${name} version ${version} Copyright (c) 2000-2026 the FFmpeg developers\n`;
}

function fakeLogger(): AppLogger {
  return {
    debug: vi.fn(async () => undefined),
    info: vi.fn(async () => undefined),
    warn: vi.fn(async () => undefined),
    error: vi.fn(async () => undefined),
    providerCall: vi.fn(async () => undefined),
  };
}

let dir: string;
let binDir: string;
let tempDir: string;
const notify = vi.fn();

async function makeManager(platform = "darwin", logger = fakeLogger()): Promise<ToolManager> {
  const store = createDependenciesStore(join(dir, "dependencies.json"));
  const { value } = await store.load();
  return new ToolManager({
    binDir,
    tempDir,
    platform,
    arch: "arm64",
    value,
    store,
    logger,
    notify,
  });
}

beforeEach(async () => {
  discoveryFault.path = "";
  dir = await mkdtemp(join(tmpdir(), "mumbler-mgr-"));
  binDir = join(dir, "bin");
  tempDir = join(dir, "temp");
  notify.mockClear();
  durabilityEvents.length = 0;
  vi.mocked(runTool).mockResolvedValue({ stdout: "" });
  vi.mocked(fetchText).mockResolvedValue("a".repeat(64) + "  ffmpeg.zip\n");
  // downloadToFile lands the archive in temp/ and reports progress; the extractor
  // writes the executable to its staging path so the manager can publish it.
  vi.mocked(downloadToFile).mockImplementation(async (opts) => {
    await writeFile(opts.destPath, "zip-bytes");
    opts.onProgress?.(50, 100);
  });
  // The extracted "binary" is a stand-in whose contents are the version banner it
  // would print — see the installed-version mock above.
  vi.mocked(extractFileFromZip).mockImplementation(async (_zip, inner, dest) => {
    await writeFile(dest, banner(inner, RESOLVED.version));
  });
  vi.mocked(resolveLatest).mockResolvedValue(RESOLVED as never);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("reconcile", () => {
  it("records failed access distinctly from an absent tool without blocking the other tool", async () => {
    const logger = fakeLogger();
    const manager = await makeManager("darwin", logger);
    discoveryFault.path = join(binDir, "ffmpeg");
    await manager.reconcile();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("tools.discovery-failed", expect.any(String), expect.objectContaining({
      tool: "ffmpeg", error: expect.objectContaining({ code: "EACCES", message: "inspection refused" }),
    }));
  });

  it("keeps a present tool version unknown and records the exact probe failure once", async () => {
    const logger = fakeLogger();
    const manager = await makeManager("darwin", logger);
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "ffmpeg"), banner("ffmpeg", "8.2"));
    vi.mocked(installedVersion.readInstalledVersion).mockRejectedValueOnce(Object.assign(new Error("cannot launch"), { code: "ENOEXEC" }));
    await manager.reconcile();
    expect(manager.listStatuses()[0]).toMatchObject({ state: "installed-unchecked", installedVersion: null });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("tools.version-unreadable", expect.any(String), expect.objectContaining({ error: expect.objectContaining({ code: "ENOEXEC" }) }));
  });
  it("derives presence AND the installed version from disk, not from persisted facts", async () => {
    const manager = await makeManager();
    await manager.reconcile();
    expect(manager.listStatuses().map((s) => s.state)).toEqual(["not-installed", "not-installed"]);

    // installTool publishes a binary into binDir; a fresh manager that only
    // reconciles (no install) must see it present, and read its version off it,
    // purely from the on-disk scan.
    await manager.installTool("ffmpeg");
    const fresh = await makeManager();
    await fresh.reconcile();
    const ffmpeg = fresh.listStatuses().find((s) => s.name === "ffmpeg");
    expect(ffmpeg?.installedVersion).toBe("8.2");
    expect(ffmpeg?.state).toBe("up-to-date");
  });

  // The defect this design removes: a binary present with NOTHING recorded about
  // it. The facts store never learned of this one — it still reports its version,
  // and a check can still find it current.
  it("reads the version of a binary the facts store has never heard of", async () => {
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "ffmpeg"), banner("ffmpeg", "8.2"));

    const manager = await makeManager();
    await manager.reconcile();
    const before = manager.listStatuses().find((s) => s.name === "ffmpeg");
    expect(before?.installedVersion).toBe("8.2");
    expect(before?.state).toBe("installed-unchecked");

    await manager.checkTools();
    expect(manager.listStatuses().find((s) => s.name === "ffmpeg")?.state).toBe("up-to-date");
  });

  // A present binary whose version cannot be read is not absent and is never
  // dressed up as current — there is nothing to compare, so it holds at
  // installed-unchecked even after a successful check.
  it("holds a present-but-unreadable binary at installed-unchecked", async () => {
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "ffmpeg"), "not an ffmpeg banner");

    const manager = await makeManager();
    await manager.reconcile();
    await manager.checkTools();

    const ffmpeg = manager.listStatuses().find((s) => s.name === "ffmpeg");
    expect(ffmpeg?.installedVersion).toBeNull();
    expect(ffmpeg?.state).toBe("installed-unchecked");
  });
});

describe("installTool", () => {
  it.each(["darwin", "win32"])("retains the old %s executable when an integrity-valid stage cannot run", async (platform) => {
    const logger = fakeLogger();
    const manager = await makeManager(platform, logger);
    await mkdir(binDir, { recursive: true });
    const target = manager.toolPath("ffmpeg");
    await writeFile(target, "existing working executable");
    vi.mocked(installedVersion.probeToolVersion).mockImplementationOnce(async (_name, stage, signal) => {
      expect(stage.endsWith(platform === "win32" ? ".exe" : ".tmp")).toBe(true);
      expect(await readFile(target, "utf8")).toBe("existing working executable");
      expect(signal).toBeInstanceOf(AbortSignal);
      throw Object.assign(new Error("stage cannot launch"), { code: "ENOEXEC" });
    });
    await manager.installTool("ffmpeg");
    expect(await readFile(target, "utf8")).toBe("existing working executable");
    expect(await readdir(tempDir)).toEqual([]);
    expect(manager.listStatuses()[0]!.transient.kind).toBe("failed");
    expect(logger.warn).toHaveBeenCalledWith("tools.install-failed", expect.any(String), expect.objectContaining({ error: expect.objectContaining({ code: "ENOEXEC" }) }));
  });

  it("publishes the binary and reads its version back off it as up-to-date", async () => {
    const manager = await makeManager();
    await manager.reconcile();
    await manager.installTool("ffmpeg");

    const ffmpeg = manager.listStatuses().find((s) => s.name === "ffmpeg");
    expect(ffmpeg?.installedVersion).toBe("8.2");
    expect(ffmpeg?.desiredVersion).toBe("8.2");
    expect(ffmpeg?.state).toBe("up-to-date");
    expect(ffmpeg?.transient).toEqual({ kind: "idle" });
    expect(extractFileFromZip).toHaveBeenCalledWith(
      expect.any(String),
      "ffmpeg",
      expect.any(String),
      TOOL_EXTRACTED_MAX_BYTES,
      expect.any(AbortSignal),
    );
  });

  it("emits a running transient with progress while downloading", async () => {
    const manager = await makeManager();
    let seen: string | undefined;
    vi.mocked(downloadToFile).mockImplementationOnce(async (opts) => {
      await writeFile(opts.destPath, "zip-bytes");
      opts.onProgress?.(50, 100);
      const running = manager.listStatuses().find((s) => s.name === "ffmpeg");
      seen = running?.transient.kind === "running" ? `${running.transient.percent}` : undefined;
    });
    await manager.installTool("ffmpeg");
    expect(seen).toBe("50");
  });

  it("emits changed rounded progress and completion while suppressing repeated percentages", async () => {
    const manager = await makeManager();
    const seen: ToolTransient[] = [];
    notify.mockImplementation(() => {
      seen.push(manager.listStatuses()[0]!.transient);
    });
    vi.mocked(downloadToFile).mockImplementationOnce(async (opts) => {
      await writeFile(opts.destPath, "zip-bytes");
      opts.onProgress?.(501, 1_000);
      const afterFirst = notify.mock.calls.length;
      opts.onProgress?.(509, 1_000);
      expect(notify).toHaveBeenCalledTimes(afterFirst);
      opts.onProgress?.(510, 1_000);
      expect(notify).toHaveBeenCalledTimes(afterFirst + 1);
      expect(seen.slice(-2)).toEqual([
        { kind: "running", operation: "provision", percent: 50 },
        { kind: "running", operation: "provision", percent: 51 },
      ]);
    });

    try {
      await manager.installTool("ffmpeg");
      expect(seen[0]).toEqual({ kind: "running", operation: "provision", percent: null });
      expect(seen.at(-1)).toEqual({ kind: "idle" });
    } finally {
      notify.mockReset();
    }
  });

  it("emits a changed operation even when its progress is still unknown", async () => {
    const manager = await makeManager();
    let releaseCheck!: (value: typeof RESOLVED) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    vi.mocked(resolveLatest).mockImplementationOnce(async () => {
      markStarted();
      return new Promise((resolve) => { releaseCheck = resolve; });
    });
    const checking = manager.checkTools();
    await started;
    try {
      expect(manager.listStatuses()[0]!.transient).toEqual({ kind: "running", operation: "check", percent: null });
      const beforeInstall = notify.mock.calls.length;
      const installing = manager.installTool("ffmpeg");
      expect(notify).toHaveBeenCalledTimes(beforeInstall + 1);
      expect(manager.listStatuses()[0]!.transient).toEqual({ kind: "running", operation: "provision", percent: null });
      await installing;
    } finally {
      releaseCheck(RESOLVED);
      await checking;
    }
  });

  it("emits the failure after progress without suppressing its error", async () => {
    const manager = await makeManager();
    const seen: ToolTransient[] = [];
    notify.mockImplementation(() => {
      seen.push(manager.listStatuses()[0]!.transient);
    });
    vi.mocked(downloadToFile).mockImplementationOnce(async (opts) => {
      opts.onProgress?.(25, 100);
      throw new Error("network down");
    });

    try {
      await manager.installTool("ffmpeg");
      expect(seen).toEqual([
        { kind: "running", operation: "provision", percent: null },
        { kind: "running", operation: "provision", percent: 25 },
        { kind: "failed", operation: "provision", error: { key: "tools.provisionFailed", values: { tool: "ffmpeg" } } },
      ]);
    } finally {
      notify.mockReset();
    }
  });

  it("cancels an in-flight install without publishing or surfacing a failure", async () => {
    const manager = await makeManager();
    await manager.reconcile();
    let markDownloadStarted!: () => void;
    const downloadStarted = new Promise<void>((resolve) => {
      markDownloadStarted = resolve;
    });
    vi.mocked(downloadToFile).mockImplementationOnce(async (opts) => {
      await writeFile(opts.destPath, "partial-zip");
      markDownloadStarted();
      opts.signal?.throwIfAborted();
      await new Promise<void>((_resolve, reject) => {
        opts.signal?.addEventListener(
          "abort",
          () => reject(opts.signal?.reason ?? new Error("cancelled")),
          { once: true },
        );
      });
    });

    const installing = manager.installTool("ffmpeg");
    await downloadStarted;
    manager.cancelInstall("ffmpeg");
    await installing;

    const ffmpeg = manager.listStatuses().find((s) => s.name === "ffmpeg");
    expect(ffmpeg?.state).toBe("not-installed");
    expect(ffmpeg?.transient).toEqual({ kind: "idle" });
    expect(await readdir(binDir)).toEqual([]);
    expect(await readdir(tempDir)).toEqual([]);
  });

  it("quit cancels a running download through its controller", async () => {
    const manager = await makeManager();
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(downloadToFile).mockImplementationOnce(async (options) => {
      signal = options.signal;
      await held;
      options.signal?.throwIfAborted();
    });
    const installing = manager.installTool("ffmpeg");
    await until(() => expect(signal).toBeDefined());
    manager.cancelAll();
    expect(signal!.aborted).toBe(true);
    release();
    await installing;
    expect(await readdir(binDir)).toEqual([]);
    expect(await readdir(tempDir)).toEqual([]);
  });

  it("checks cancellation immediately before publishing", async () => {
    const manager = await makeManager();
    await manager.reconcile();
    vi.mocked(assertArm64Slice).mockImplementationOnce(async (_path, signal) => {
      manager.cancelInstall("ffmpeg");
      signal?.throwIfAborted();
    });

    await manager.installTool("ffmpeg");

    const ffmpeg = manager.listStatuses().find((s) => s.name === "ffmpeg");
    expect(ffmpeg?.state).toBe("not-installed");
    expect(ffmpeg?.transient).toEqual({ kind: "idle" });
    expect(await readdir(binDir)).toEqual([]);
    expect(await readdir(tempDir)).toEqual([]);
  });

  it("leaves persisted facts untouched and surfaces a failed transient when the download fails", async () => {
    const manager = await makeManager();
    await manager.reconcile();
    vi.mocked(downloadToFile).mockRejectedValueOnce(new Error("network down"));

    await manager.installTool("ffmpeg");

    const ffmpeg = manager.listStatuses().find((s) => s.name === "ffmpeg");
    expect(ffmpeg?.installedVersion).toBeNull(); // nothing published, nothing to read
    expect(ffmpeg?.state).toBe("not-installed");
    expect(ffmpeg?.transient).toMatchObject({
      kind: "failed",
      error: { key: "tools.provisionFailed", values: { tool: "ffmpeg" } },
    });
  });

  it("stages in temp/ and leaves it empty after publishing the binary to bin/", async () => {
    const manager = await makeManager();
    await manager.installTool("ffmpeg");

    expect(await readdir(binDir)).toEqual(["ffmpeg"]);
    expect(await readdir(tempDir)).toEqual([]); // archive + staged extract both cleaned
  });

  it("stages the archive and extracted binary under hyphen-joined, single-extension names", async () => {
    const manager = await makeManager();
    let archiveName = "";
    let stagedName = "";
    vi.mocked(downloadToFile).mockImplementationOnce(async (opts) => {
      archiveName = basename(opts.destPath);
      await writeFile(opts.destPath, "zip-bytes");
      opts.onProgress?.(50, 100);
    });
    vi.mocked(extractFileFromZip).mockImplementationOnce(async (_zip, _inner, dest) => {
      stagedName = basename(dest);
      await writeFile(dest, "binary-bytes");
    });

    await manager.installTool("ffmpeg");

    // House grammar: hyphen-joined discriminator, one final role extension — never
    // the dot-joined `name.token.ext` anti-pattern.
    expect(archiveName).toMatch(/^ffmpeg-[\w-]+\.zip$/);
    expect(stagedName).toMatch(/^ffmpeg-[\w-]+\.tmp$/);
  });

  it("aborts on a checksum mismatch: nothing published, temp/ left clean (I5)", async () => {
    const manager = await makeManager();
    await manager.reconcile();
    vi.mocked(verifySha256).mockRejectedValueOnce(new Error("SHA-256 mismatch"));

    await manager.installTool("ffmpeg");

    const ffmpeg = manager.listStatuses().find((s) => s.name === "ffmpeg");
    expect(ffmpeg?.state).toBe("not-installed");
    expect(ffmpeg?.transient).toMatchObject({
      kind: "failed",
      error: { key: "tools.provisionFailed", values: { tool: "ffmpeg" } },
    });
    expect(await readdir(binDir)).toEqual([]); // never made it out of staging
    expect(await readdir(tempDir)).toEqual([]); // staged archive cleaned on failure
  });

  it("rejects an x86_64-only build at the arch gate, before publishing", async () => {
    const manager = await makeManager();
    await manager.reconcile();
    vi.mocked(assertArm64Slice).mockRejectedValueOnce(
      new Error("downloaded binary is not arm64-native (lipo reports: x86_64)"),
    );

    await manager.installTool("ffmpeg");

    const ffmpeg = manager.listStatuses().find((s) => s.name === "ffmpeg");
    expect(ffmpeg?.state).toBe("not-installed");
    expect(ffmpeg?.transient).toMatchObject({
      kind: "failed",
      error: { key: "tools.provisionFailed", values: { tool: "ffmpeg" } },
    });
    expect(await readdir(binDir)).toEqual([]);
    expect(await readdir(tempDir)).toEqual([]);
  });

  it("a concurrent check does not disturb an in-flight install's transient", async () => {
    const manager = await makeManager();
    await manager.reconcile();

    // Hold the ffmpeg download open so the install stays busy while a check runs.
    let releaseDownload!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    vi.mocked(downloadToFile).mockImplementationOnce(async (opts) => {
      await writeFile(opts.destPath, "zip-bytes");
      opts.onProgress?.(30, 100);
      await gate;
    });

    const installing = manager.installTool("ffmpeg");
    await until(() => {
      const t = manager.listStatuses().find((s) => s.name === "ffmpeg")?.transient;
      expect(t).toMatchObject({ kind: "running", operation: "provision" });
    });

    // A check while ffmpeg is mid-install must not reset its transient to idle.
    await manager.checkTools();
    expect(manager.listStatuses().find((s) => s.name === "ffmpeg")?.transient).toMatchObject({
      kind: "running",
      operation: "provision",
    });

    releaseDownload();
    await installing;
    const ffmpeg = manager.listStatuses().find((s) => s.name === "ffmpeg");
    expect(ffmpeg?.transient).toEqual({ kind: "idle" });
    expect(ffmpeg?.state).toBe("up-to-date");
  });

  it("syncs the staged executable before publishing it", async () => {
    const manager = await makeManager();

    await manager.installTool("ffmpeg");

    expect(durabilityEvents).toHaveLength(1);
    expect(durabilityEvents[0]).toMatchObject({ kind: "file" });
    expect(dirname(durabilityEvents[0]!.path)).toBe(tempDir);
    expect(basename(durabilityEvents[0]!.path)).toMatch(/^ffmpeg-[\w-]+\.tmp$/);
  });

  it("requests quarantine removal on the staged Mac binary before publication", async () => {
    vi.mocked(runTool).mockImplementationOnce(async (tool, args, options) => {
      expect(tool).toBe("xattr");
      expect(args).toEqual(["-d", "com.apple.quarantine", expect.any(String)]);
      expect(dirname(args[2]!)).toBe(tempDir);
      expect(options).toEqual({ signal: expect.any(AbortSignal), timeoutMs: 30_000 });
      expect(await readdir(binDir)).toEqual([]);
      return { stdout: "" };
    });
    const manager = await makeManager();

    await manager.installTool("ffmpeg");

    expect(runTool).toHaveBeenCalledTimes(1);
    expect(manager.listStatuses()[0]).toMatchObject({ installedVersion: "8.2", transient: { kind: "idle" } });
  });
});

describe("resolveToolPath", () => {
  it("throws a surface-pointing error when the tool is absent", async () => {
    const manager = await makeManager();
    await manager.reconcile();
    expect(() => manager.resolveToolPath("ffmpeg")).toThrow(/Managed tools/);
  });

  it("returns the bin path once the tool is installed", async () => {
    const manager = await makeManager();
    await manager.installTool("ffmpeg");
    expect(manager.resolveToolPath("ffmpeg")).toBe(join(binDir, "ffmpeg"));
  });

});

describe("checkTools", () => {
  it("records the latest version and check time for every tool on success", async () => {
    const manager = await makeManager();
    await manager.checkTools();
    for (const status of manager.listStatuses()) {
      expect(status.desiredVersion).toBe("8.2");
      expect(status.lastCheckedAtUtc).not.toBeNull();
    }
  });

  it("writes only the attempt time and rethrows on failure (I3 — a failed check is honest)", async () => {
    const manager = await makeManager();
    vi.mocked(resolveLatest).mockRejectedValueOnce(new Error("offline"));
    expect(manager.launchCheckDue()).toBe(true);

    await expect(manager.checkTools()).rejects.toThrow("offline");

    expect(manager.launchCheckDue()).toBe(false);

    for (const status of manager.listStatuses()) {
      expect(status.desiredVersion).toBeNull();
      expect(status.lastCheckedAtUtc).toBeNull();
      expect(status.transient).toEqual({ kind: "idle" });
    }
  });

  it("goes ahead with the user's Check when the attempt time cannot be written, while the launch check skips", async () => {
    const store = createDependenciesStore(join(dir, "dependencies.json"));
    const { value } = await store.load();
    let refuse = true;
    const failing = { save: async (next: typeof value) => { if (refuse) { refuse = false; throw new Error("disk full"); } return store.save(next); } };
    const manager = new ToolManager({ binDir, tempDir, platform: "darwin", arch: "arm64", value, store: failing, logger: fakeLogger(), notify });

    await manager.checkTools();
    expect(manager.listStatuses().every((status) => status.desiredVersion === "8.2")).toBe(true);

    refuse = true;
    vi.mocked(resolveLatest).mockClear();
    await expect(manager.checkTools({ automatic: true })).rejects.toThrow("disk full");
    expect(resolveLatest).not.toHaveBeenCalled();
  });

  it("cancels an explicit check through its network edge without changing facts", async () => {
    const manager = await makeManager();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    vi.mocked(resolveLatest).mockImplementationOnce(
      async (_platform, _arch, signal) =>
        new Promise<never>((_resolve, reject) => {
          markStarted();
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

    const checking = manager.checkTools();
    await started;
    manager.cancelCheck();
    await checking;

    for (const status of manager.listStatuses()) {
      expect(status.desiredVersion).toBeNull();
      expect(status.lastCheckedAtUtc).toBeNull();
      expect(status.transient).toEqual({ kind: "idle" });
    }
  });

  it("quit cancels a running check through its controller", async () => {
    const manager = await makeManager();
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(resolveLatest).mockImplementationOnce(async (_platform, _arch, operationSignal) => {
      signal = operationSignal;
      await held;
      return RESOLVED as never;
    });
    const checking = manager.checkTools();
    await until(() => expect(signal).toBeDefined());
    manager.cancelAll();
    expect(signal!.aborted).toBe(true);
    release();
    await checking;
    expect(manager.listStatuses().every((status) => status.lastCheckedAtUtc === null)).toBe(true);
  });

  it("uses one save and applies no in-memory facts when that atomic save fails", async () => {
    const manager = await makeManager();
    const saveSpy = vi
      .spyOn(JsonStore.prototype, "save")
      .mockRejectedValueOnce(new Error("dependencies disk full"));

    await expect(manager.checkTools({ automatic: true })).rejects.toThrow("dependencies disk full");
    expect(saveSpy).toHaveBeenCalledTimes(1);
    for (const status of manager.listStatuses()) {
      expect(status.desiredVersion).toBeNull();
      expect(status.lastCheckedAtUtc).toBeNull();
      expect(status.transient).toEqual({ kind: "idle" });
    }

    saveSpy.mockRestore();
    await manager.checkTools();
    for (const status of manager.listStatuses()) {
      expect(status.desiredVersion).toBe("8.2");
      expect(status.lastCheckedAtUtc).not.toBeNull();
    }
  });
});


describe("committed binary and metadata outcome", () => {
  it("installs over a Windows sidecar a newer Mumbler wrote, replacing both", async () => {
    await mkdir(binDir, { recursive: true });
    const tool = join(binDir, "ffmpeg.exe");
    await writeFile(tool, "old binary");
    const sidecar = installedVersion.versionSidecarPath(binDir, "ffmpeg");
    await writeFile(sidecar, JSON.stringify({ formatVersion: 2, version: "future" }));
    const manager = await makeManager("win32");
    await manager.installTool("ffmpeg");
    expect(await readFile(tool, "utf8")).not.toBe("old binary");
    expect(JSON.parse(await readFile(sidecar, "utf8"))).toMatchObject({ formatVersion: 1 });
    expect(await readdir(tempDir)).toEqual([]);
  });

  it("keeps a committed Windows binary truthful when sidecar persistence fails", async () => {
    await mkdir(binDir, { recursive: true });
    const tool = join(binDir, "ffmpeg.exe");
    await writeFile(tool, "old binary");
    await installedVersion.writeVersionSidecar(binDir, "ffmpeg", "autobuild-2026-08-19-19-21", 0, tool);
    const logger = fakeLogger();
    const manager = await makeManager("win32", logger);
    const primary = new Error("sidecar disk full");
    const spy = vi.spyOn(installedVersion, "writeVersionSidecar").mockRejectedValueOnce(primary);
    try {
      await manager.installTool("ffmpeg");
      expect(await readFile(tool, "utf8")).not.toBe("old binary");
      expect(manager.listStatuses()[0]).toMatchObject({ state: "installed-unchecked", installedVersion: null, transient: { kind: "idle" } });
      const fresh = await makeManager("win32");
      await fresh.reconcile();
      expect(fresh.listStatuses()[0].installedVersion).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith("tools.install-metadata-failed", expect.any(String), expect.objectContaining({ error: expect.objectContaining({ message: primary.message }) }));
    } finally { spy.mockRestore(); }
  });

  it("keeps a committed binary installed when dependencies persistence fails", async () => {
    const logger = fakeLogger();
    const manager = await makeManager("darwin", logger);
    const spy = vi.spyOn(JsonStore.prototype, "save").mockRejectedValueOnce(new Error("facts disk full"));
    try {
      await manager.installTool("ffmpeg");
      expect(manager.listStatuses()[0]).toMatchObject({ installedVersion: "8.2", transient: { kind: "idle" } });
      expect(await readFile(join(binDir, "ffmpeg"), "utf8")).toBe(banner("ffmpeg", "8.2"));
      expect(logger.warn).toHaveBeenCalledWith("tools.install-metadata-failed", expect.any(String), expect.any(Object));
    } finally { spy.mockRestore(); }
  });
});
