import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppPaths } from "@shared/app-shell";
import { cleanInterruptedJsonWrites, ensureJsonStagingDirectory } from "@main/core/json-staging";
import { writeJsonFile } from "@main/core/file-io";
import { clearApiKey, resolveApiKey, writeApiKey } from "@main/core/api-keys";
let root: string;
let paths: AppPaths;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mumbler-json-staging-"));
  paths = { homeDir: root, transcriptsDir: join(root, "transcripts"), binDir: join(root, "bin") } as AppPaths;
  await mkdir(paths.transcriptsDir);
  await mkdir(paths.binDir);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("interrupted JSON staging ownership", () => {
  it("cleans only regular generated stages in owned directories, both current and legacy", async () => {
    for (const [parent, stem] of [[root, "api-keys"], [paths.transcriptsDir, "63617264"], [paths.binDir, "ffmpeg"]]) {
      const staging = await ensureJsonStagingDirectory(parent!);
      const name = `${stem}-aB_123-4.tmp`;
      await writeFile(join(parent!, name), "legacy partial");
      await writeFile(join(staging, name), "new partial");
      await writeFile(join(parent!, `${stem}-20261023-120000-utc.invalid`), "keep invalid");
      await writeFile(join(staging, "unrelated.tmp"), "keep unknown");
    }
    await mkdir(join(root, "config-12345678.tmp"));
    await writeFile(join(root, "config-short.tmp"), "keep lookalike");
    await mkdir(join(root, "working"));
    await writeFile(join(root, "working", "config-12345678.tmp"), "keep audio");
    await cleanInterruptedJsonWrites(paths);
    expect(await readdir(join(root, ".json-staging"))).toEqual(["unrelated.tmp"]);
    expect(await readFile(join(root, "working", "config-12345678.tmp"), "utf8")).toBe("keep audio");
    expect(await readFile(join(root, "config-short.tmp"), "utf8")).toBe("keep lookalike");
    expect((await stat(join(root, "config-12345678.tmp"))).isDirectory()).toBe(true);
    for (const [parent, stem] of [[root, "api-keys"], [paths.transcriptsDir, "63617264"], [paths.binDir, "ffmpeg"]]) {
      expect(await readdir(parent!)).not.toContain(`${stem}-aB_123-4.tmp`);
      expect(await readFile(join(parent!, `${stem}-20261023-120000-utc.invalid`), "utf8")).toBe("keep invalid");
    }
  });

  it.skipIf(process.platform === "win32")("does not follow a staging directory or stage-file symlink", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    const target = join(outside, "api-keys-12345678.tmp");
    await writeFile(target, "keep target");
    await symlink(outside, join(root, ".json-staging"));
    await symlink(target, join(root, "api-keys-12345678.tmp"));
    await cleanInterruptedJsonWrites(paths);
    expect(await readFile(target, "utf8")).toBe("keep target");
    await expect(ensureJsonStagingDirectory(root)).rejects.toThrow("owned directory");
  });

  it("never restores a cleared key from abandoned stages or records it as backup history", async () => {
    const keyFile = join(root, "api-keys.json");
    await writeApiKey(keyFile, "gemini", "fixture-secret");
    const staging = join(root, ".json-staging");
    await writeFile(join(staging, "api-keys-12345678.tmp"), await readFile(keyFile));
    await cleanInterruptedJsonWrites(paths);
    await clearApiKey(keyFile, "gemini");
    expect(await resolveApiKey(keyFile, "gemini")).toBeNull();
    expect(await readdir(staging)).toEqual([]);
    expect(await readdir(root)).not.toContain("backups.sqlite3");
  });

  it.skipIf(process.platform === "win32")("keeps new JSON and its staging directory private", async () => {
    await writeJsonFile(join(root, "config.json"), { value: "kept" });
    expect((await stat(join(root, ".json-staging"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "config.json"))).mode & 0o777).toBe(0o600);
  });
});
