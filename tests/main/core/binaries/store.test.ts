import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDependenciesStore } from "@main/core/binaries/store";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mumbler-deps-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function storePath(): string {
  return join(dir, "dependencies.json");
}

async function onDisk(): Promise<{ tools: Record<string, { lastCheckedAtUtc: unknown }> }> {
  return JSON.parse(await readFile(storePath(), "utf8"));
}

describe("dependencies store — timestamp persistence", () => {
  it("writes lastCheckedAtUtc as canonical ISO-8601 and round-trips back to epoch-ms", async () => {
    const store = createDependenciesStore(storePath());
    const { value } = await store.load();
    value.tools.ffmpeg = { desiredVersion: "8.2", lastCheckedAtUtc: 1_700_000_000_000 };
    await store.save(value);

    expect((await onDisk()).tools.ffmpeg.lastCheckedAtUtc).toBe("2023-11-14T22:13:20.000Z");

    const reloaded = (await createDependenciesStore(storePath()).load()).value;
    expect(reloaded.tools.ffmpeg.lastCheckedAtUtc).toBe(1_700_000_000_000);
    expect(reloaded.tools.ffmpeg.desiredVersion).toBe("8.2");
  });

  // The installed version is read from the binary, not from here. An older file
  // carrying one drops it on the next save rather than being migrated.
  it("does not persist an installed version, and drops one an older file holds", async () => {
    await writeFile(
      storePath(),
      JSON.stringify({
        schemaVersion: 1,
        tools: {
          ffmpeg: { installedVersion: "8.1", desiredVersion: "8.1", lastCheckedAtUtc: null },
          ffprobe: {},
        },
      }),
      "utf8",
    );
    const store = createDependenciesStore(storePath());
    const { value } = await store.load();
    expect(value.tools.ffmpeg).not.toHaveProperty("installedVersion");
    await store.save(value);
    expect((await onDisk()).tools.ffmpeg).not.toHaveProperty("installedVersion");
  });

  it("keeps a null check time null on disk and on reload", async () => {
    const store = createDependenciesStore(storePath());
    await store.save((await store.load()).value);
    expect((await onDisk()).tools.ffmpeg.lastCheckedAtUtc).toBeNull();
  });

  it("still reads a legacy epoch-ms number from an older file", async () => {
    await writeFile(
      storePath(),
      JSON.stringify({
        schemaVersion: 1,
        tools: {
          ffmpeg: { installedVersion: "8.1", desiredVersion: "8.1", lastCheckedAtUtc: 1_699_000_000_000 },
          ffprobe: {},
        },
      }),
      "utf8",
    );
    const reloaded = (await createDependenciesStore(storePath()).load()).value;
    expect(reloaded.tools.ffmpeg.lastCheckedAtUtc).toBe(1_699_000_000_000);
    expect(reloaded.tools.ffprobe.lastCheckedAtUtc).toBeNull();
  });
});
