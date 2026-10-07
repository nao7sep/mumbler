import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDependenciesStore, launchCheckDue } from "@main/core/binaries/store";
import { NewerFormatError } from "@main/core/format-versions";
import { closeBackupStore } from "@main/core/backupStore";

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
  it.each(["2023-11-14T22:13:20", "2023-11-14T22:13:20.000+09:00", "2023-11-14", "2023-02-30T22:13:20.000Z"])(
    "ignores an invalid or non-UTC check fact: %s", async (time) => {
      await writeFile(storePath(), JSON.stringify({
        formatVersion: 1, lastCheckAttemptAtUtc: time,
        tools: { ffmpeg: { desiredVersion: "8.2", lastCheckedAtUtc: time } },
      }));
      const loaded = (await createDependenciesStore(storePath()).load()).value;
      expect(loaded.lastCheckAttemptAtUtc).toBeNull();
      expect(loaded.tools.ffmpeg.lastCheckedAtUtc).toBeNull();
      expect(launchCheckDue(loaded.lastCheckAttemptAtUtc, Date.now())).toBe(true);
    },
  );

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

  // The installed version is read from the binary, not from here; an unknown key
  // in the file is ignored and dropped on the next save.
  it("does not persist an installed version, and drops one the file holds", async () => {
    await writeFile(
      storePath(),
      JSON.stringify({
        formatVersion: 1,
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

  it("writes its format version, and refuses a newer file without touching it", async () => {
    const store = createDependenciesStore(storePath());
    await store.save((await store.load()).value);
    expect(JSON.parse(await readFile(storePath(), "utf8")).formatVersion).toBe(1);

    const newer = JSON.stringify({ formatVersion: 2, tools: {} });
    await writeFile(storePath(), newer);
    await expect(createDependenciesStore(storePath()).load()).rejects.toBeInstanceOf(NewerFormatError);
    expect(await readFile(storePath(), "utf8")).toBe(newer);
  });

  it("keeps a null check time null on disk and on reload", async () => {
    const store = createDependenciesStore(storePath());
    await store.save((await store.load()).value);
    expect((await onDisk()).tools.ffmpeg.lastCheckedAtUtc).toBeNull();
  });

  it("does not record re-derivable dependency facts in the backup history", async () => {
    process.env.MUMBLER_DATA_DIR = dir;
    const store = createDependenciesStore(storePath());
    await store.save((await store.load()).value);
    await closeBackupStore();
    expect(await readdir(dir)).not.toContain("backups.sqlite3");
  });
});

describe("the launch check's last attempt", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 1_700_000_000_000;

  it("is due when the attempt is missing, in the future, or at least a day old", () => {
    expect(launchCheckDue(null, NOW)).toBe(true);
    expect(launchCheckDue(NOW + 1, NOW)).toBe(true);
    expect(launchCheckDue(NOW - DAY, NOW)).toBe(true);
    expect(launchCheckDue(NOW - DAY + 1, NOW)).toBe(false);
    expect(launchCheckDue(NOW, NOW)).toBe(false);
  });

  it("is stored as canonical UTC and reads an invalid value as missing", async () => {
    const store = createDependenciesStore(storePath());
    const { value } = await store.load();
    await store.save({ ...value, lastCheckAttemptAtUtc: NOW });
    expect(JSON.parse(await readFile(storePath(), "utf8")).lastCheckAttemptAtUtc).toBe("2023-11-14T22:13:20.000Z");
    expect((await createDependenciesStore(storePath()).load()).value.lastCheckAttemptAtUtc).toBe(NOW);

    await writeFile(storePath(), JSON.stringify({ formatVersion: 1, tools: {}, lastCheckAttemptAtUtc: "not a time" }));
    expect((await createDependenciesStore(storePath()).load()).value.lastCheckAttemptAtUtc).toBeNull();
  });
});
