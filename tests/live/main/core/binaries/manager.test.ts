import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ToolName } from "@shared/app-shell";

// The physical quarantine proof belongs in the full lane because it invokes
// macOS xattr. Acquisition bytes retain the ordinary fixture so this narrow
// permission check neither downloads tools again nor changes the live cache's
// install-only-when-missing/update-only-when-newer policy.
vi.mock("@main/core/binaries/http", () => ({ fetchText: vi.fn(), downloadToFile: vi.fn() }));
vi.mock("@main/core/binaries/archive", () => ({ extractFileFromZip: vi.fn() }));
vi.mock("@main/core/binaries/arch", () => ({ assertArm64Slice: vi.fn() }));
vi.mock("@main/core/binaries/integrity", async (importOriginal) => ({
  ...await importOriginal<typeof import("@main/core/binaries/integrity")>(),
  verifySha256: vi.fn(async () => undefined),
}));
vi.mock("@main/core/binaries/registry", async (importOriginal) => ({
  ...await importOriginal<typeof import("@main/core/binaries/registry")>(),
  resolveLatest: vi.fn(),
}));
vi.mock("@main/core/binaries/installed-version", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@main/core/binaries/installed-version")>();
  const { readFile } = await import("node:fs/promises");
  return {
    ...actual,
    probeToolVersion: async (name: ToolName, path: string) => {
      const version = actual.parseVersionBanner(name, await readFile(path, "utf8"));
      if (version === null) throw new Error("Unrecognized fixture version");
      return version;
    },
    readInstalledVersion: async (name: ToolName, path: string) => actual.parseVersionBanner(name, await readFile(path, "utf8")),
  };
});

import { runTool } from "@main/core/audio-tools";
import { extractFileFromZip } from "@main/core/binaries/archive";
import { downloadToFile, fetchText } from "@main/core/binaries/http";
import { ToolManager } from "@main/core/binaries/manager";
import { resolveLatest } from "@main/core/binaries/registry";
import { createDependenciesStore } from "@main/core/binaries/store";

describe.skipIf(process.platform !== "darwin")("native managed-tool permissions", () => {
  it("strips the quarantine flag from the binary it publishes on macOS", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mumbler-quarantine-"));
    try {
      const store = createDependenciesStore(join(directory, "dependencies.json"));
      const { value } = await store.load();
      const manager = new ToolManager({
        binDir: join(directory, "bin"), tempDir: join(directory, "temp"),
        platform: "darwin", arch: "arm64", value, store,
        logger: {
          debug: async () => undefined, info: async () => undefined,
          warn: async () => undefined, error: async () => undefined,
          providerCall: async () => undefined,
        },
        notify: () => undefined,
      });
      vi.mocked(resolveLatest).mockResolvedValue({
        version: "8.2",
        tools: {
          ffmpeg: { downloadUrl: "u", sha256Url: "s", sha256AssetName: "ffmpeg.zip", innerName: "ffmpeg" },
          ffprobe: { downloadUrl: "u", sha256Url: "s", sha256AssetName: "ffprobe.zip", innerName: "ffprobe" },
        },
      });
      vi.mocked(fetchText).mockResolvedValue("a".repeat(64) + "  ffmpeg.zip\n");
      vi.mocked(downloadToFile).mockImplementation(async ({ destPath }) => { await writeFile(destPath, "zip-bytes"); });
      vi.mocked(extractFileFromZip).mockImplementation(async (_zip, name, destination) => {
        await writeFile(destination, `${name} version 8.2 Copyright (c) 2000-2026 the FFmpeg developers\n`);
        await runTool("xattr", ["-w", "com.apple.quarantine", "0081;00000000;Mumbler;", destination], { timeoutMs: 30_000 });
        const { stdout } = await runTool("xattr", [destination], { timeoutMs: 30_000 });
        expect(stdout.split("\n")).toContain("com.apple.quarantine");
      });

      await manager.installTool("ffmpeg");

      const path = manager.resolveToolPath("ffmpeg");
      const { stdout } = await runTool("xattr", [path], { timeoutMs: 30_000 });
      expect(stdout.split("\n")).not.toContain("com.apple.quarantine");
      expect(await readFile(path, "utf8")).toContain("ffmpeg version 8.2");
    } finally {
      await rm(directory, { recursive: true, force: true });
      vi.clearAllMocks();
    }
  });
});
