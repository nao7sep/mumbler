import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppLogger } from "@main/core/logger";

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
vi.mock("@main/core/binaries/integrity", () => ({
  parseSha256Sidecar: vi.fn(() => "a".repeat(64)),
  verifySha256: vi.fn(async () => undefined),
}));
vi.mock("@main/core/binaries/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@main/core/binaries/registry")>();
  return { ...actual, resolveLatest: vi.fn() };
});

import { extractFileFromZip } from "@main/core/binaries/archive";
import { downloadToFile, fetchText } from "@main/core/binaries/http";
import { ToolManager } from "@main/core/binaries/manager";
import { resolveLatest } from "@main/core/binaries/registry";
import { createDependenciesStore } from "@main/core/binaries/store";

const RESOLVED = {
  version: "8.2",
  tools: {
    ffmpeg: { downloadUrl: "u", sha256Url: "s", sha256AssetName: "ffmpeg.zip", innerName: "ffmpeg" },
    ffprobe: { downloadUrl: "u", sha256Url: "s", sha256AssetName: "ffprobe.zip", innerName: "ffprobe" },
  },
} as const;

function fakeLogger(): AppLogger {
  return {
    debug: vi.fn(async () => undefined),
    info: vi.fn(async () => undefined),
    warn: vi.fn(async () => undefined),
    error: vi.fn(async () => undefined),
  };
}

let dir: string;
let binDir: string;
let tempDir: string;
const notify = vi.fn();

async function makeManager(): Promise<ToolManager> {
  const store = createDependenciesStore(join(dir, "dependencies.json"));
  const { value } = await store.load();
  return new ToolManager({
    binDir,
    tempDir,
    platform: "darwin",
    arch: "arm64",
    value,
    store,
    logger: fakeLogger(),
    notify,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mumbler-mgr-"));
  binDir = join(dir, "bin");
  tempDir = join(dir, "temp");
  notify.mockClear();
  vi.mocked(fetchText).mockResolvedValue("a".repeat(64) + "  ffmpeg.zip\n");
  // downloadToFile lands the archive in temp/ and reports progress; the extractor
  // writes the executable to its staging path so the manager can publish it.
  vi.mocked(downloadToFile).mockImplementation(async (opts) => {
    await writeFile(opts.destPath, "zip-bytes");
    opts.onProgress?.(50, 100);
  });
  vi.mocked(extractFileFromZip).mockImplementation(async (_zip, _inner, dest) => {
    await writeFile(dest, "binary-bytes");
  });
  vi.mocked(resolveLatest).mockResolvedValue(RESOLVED as never);
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("reconcile", () => {
  it("derives presence from disk, not from persisted facts", async () => {
    const manager = await makeManager();
    await manager.reconcile();
    expect(manager.listStatuses().map((s) => s.state)).toEqual(["not-installed", "not-installed"]);

    // installTool publishes a real binary into binDir; a fresh manager that only
    // reconciles (no install) must see it present purely from the on-disk scan.
    await manager.installTool("ffmpeg");
    const fresh = await makeManager();
    await fresh.reconcile();
    const ffmpeg = fresh.listStatuses().find((s) => s.name === "ffmpeg");
    expect(ffmpeg?.state).toBe("up-to-date");
  });
});

describe("installTool", () => {
  it("publishes the binary and records installed = latest as up-to-date", async () => {
    const manager = await makeManager();
    await manager.reconcile();
    await manager.installTool("ffmpeg");

    const ffmpeg = manager.listStatuses().find((s) => s.name === "ffmpeg");
    expect(ffmpeg?.installedVersion).toBe("8.2");
    expect(ffmpeg?.desiredVersion).toBe("8.2");
    expect(ffmpeg?.state).toBe("up-to-date");
    expect(ffmpeg?.transient).toEqual({ kind: "idle" });
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

  it("leaves persisted facts untouched and surfaces a failed transient when the download fails", async () => {
    const manager = await makeManager();
    await manager.reconcile();
    vi.mocked(downloadToFile).mockRejectedValueOnce(new Error("network down"));

    await manager.installTool("ffmpeg");

    const ffmpeg = manager.listStatuses().find((s) => s.name === "ffmpeg");
    expect(ffmpeg?.installedVersion).toBeNull(); // I5 — prior facts intact
    expect(ffmpeg?.state).toBe("not-installed");
    expect(ffmpeg?.transient).toMatchObject({ kind: "failed", error: "network down" });
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

  it("writes nothing and rethrows on failure (I3 — a failed check is honest)", async () => {
    const manager = await makeManager();
    vi.mocked(resolveLatest).mockRejectedValueOnce(new Error("offline"));

    await expect(manager.checkTools()).rejects.toThrow("offline");

    for (const status of manager.listStatuses()) {
      expect(status.desiredVersion).toBeNull();
      expect(status.lastCheckedAtUtc).toBeNull();
      expect(status.transient).toEqual({ kind: "idle" });
    }
  });
});
