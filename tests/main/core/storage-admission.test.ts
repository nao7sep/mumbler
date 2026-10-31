import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPaths } from "@shared/app-shell";
import { admitStorageRoot, prepareFrameworkStorage } from "@main/core/storage-admission";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, chmod: vi.fn(actual.chmod), stat: vi.fn(actual.stat) };
});
let root: string;
let paths: AppPaths;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mumbler-admission-"));
  paths = { homeDir: join(root, "data"), profileDir: join(root, "data", "electron") } as AppPaths;
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("storage admission", () => {
  it("captures an empty first launch before framework files and redirects both framework paths", async () => {
    const admission = await admitStorageRoot(paths);
    expect(admission.firstRun).toBe(true);
    expect(await readdir(paths.homeDir)).toEqual([]);
    const setPath = vi.fn();
    await prepareFrameworkStorage(admission, { setPath });
    expect(setPath.mock.calls).toEqual([["userData", paths.profileDir], ["sessionData", paths.profileDir]]);
    expect((await stat(paths.profileDir)).isDirectory()).toBe(true);
    expect((await admitStorageRoot(paths)).firstRun).toBe(true);
  });

  it("does not mistake a root containing existing work for a first launch", async () => {
    await mkdir(paths.homeDir);
    await writeFile(join(paths.homeDir, "config.json"), "{}");
    expect((await admitStorageRoot(paths)).firstRun).toBe(false);
  });

  it.skipIf(process.platform === "win32")("rechecks the mode after a purportedly successful chmod", async () => {
    await mkdir(paths.homeDir);
    await chmod(paths.homeDir, 0o755);
    vi.mocked(chmod).mockResolvedValueOnce();
    await expect(admitStorageRoot(paths)).rejects.toThrow("owner-only");
    expect(await readdir(paths.homeDir)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("propagates a failed privacy inspection", async () => {
    vi.mocked(stat).mockRejectedValueOnce(new Error("stat refused"));
    await expect(admitStorageRoot(paths)).rejects.toThrow("stat refused");
    expect(await readdir(paths.homeDir)).toEqual([]);
  });
});
