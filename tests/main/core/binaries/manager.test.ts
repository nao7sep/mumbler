import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
vi.mock("@main/core/binaries/arch", () => ({
  assertArm64Slice: vi.fn(),
}));
vi.mock("@main/core/binaries/integrity", () => ({
  parseSha256Sidecar: vi.fn(() => "a".repeat(64)),
  verifySha256: vi.fn(async () => undefined),
}));
vi.mock("@main/core/binaries/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@main/core/binaries/registry")>();
  return { ...actual, resolveLatest: vi.fn() };
});

import { assertArm64Slice } from "@main/core/binaries/arch";
import { extractFileFromZip } from "@main/core/binaries/archive";
import { downloadToFile, fetchText } from "@main/core/binaries/http";
import { verifySha256 } from "@main/core/binaries/integrity";
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

  it("stages in temp/ and leaves it empty after publishing the binary to bin/", async () => {
    const manager = await makeManager();
    await manager.installTool("ffmpeg");

    expect(await readdir(binDir)).toEqual(["ffmpeg"]);
    expect(await readdir(tempDir)).toEqual([]); // archive + staged extract both cleaned
  });

  it("aborts on a checksum mismatch: nothing published, temp/ left clean (I5)", async () => {
    const manager = await makeManager();
    await manager.reconcile();
    vi.mocked(verifySha256).mockRejectedValueOnce(new Error("SHA-256 mismatch"));

    await manager.installTool("ffmpeg");

    const ffmpeg = manager.listStatuses().find((s) => s.name === "ffmpeg");
    expect(ffmpeg?.state).toBe("not-installed");
    expect(ffmpeg?.transient).toMatchObject({ kind: "failed", error: "SHA-256 mismatch" });
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
    expect(ffmpeg?.transient).toMatchObject({ kind: "failed", error: /not arm64-native/ });
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
    await vi.waitFor(() => {
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
});

describe("resolveToolPath", () => {
  it("throws a surface-pointing error when the tool is absent", async () => {
    const manager = await makeManager();
    await manager.reconcile();
    expect(() => manager.resolveToolPath("ffmpeg")).toThrow(/Audio Tools/);
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
