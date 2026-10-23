import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@main/core/binaries/http", () => ({ downloadToFile: vi.fn() }));
vi.mock("@main/core/binaries/integrity", () => ({ verifySha256: vi.fn() }));
import { downloadToFile } from "@main/core/binaries/http";
import { verifySha256 } from "@main/core/binaries/integrity";
import { VerifiedArchives } from "@main/core/binaries/verified-archives";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mumbler-archives-"));
  vi.mocked(verifySha256).mockReset().mockResolvedValue(undefined);
  vi.mocked(downloadToFile).mockReset().mockImplementation(async ({ destPath }) => { await writeFile(destPath, "archive"); });
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it("cancels one consumer without cancelling the other's shared download", async () => {
  const cache = new VerifiedArchives(directory);
  const first = new AbortController();
  const second = new AbortController();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let physicalSignal: AbortSignal | undefined;
  vi.mocked(downloadToFile).mockImplementationOnce(async ({ destPath, signal, onProgress }) => {
    physicalSignal = signal;
    onProgress?.(1, 2);
    await held;
    await writeFile(destPath, "archive");
  });
  const progress1 = vi.fn();
  const progress2 = vi.fn();
  const waiting1 = cache.acquire("url", "digest", first.signal, progress1).catch((error: unknown) => error);
  const waiting2 = cache.acquire("url", "digest", second.signal, progress2);
  await vi.waitFor(() => expect(physicalSignal).toBeDefined());
  first.abort(new Error("first cancelled"));
  expect(await waiting1).toEqual(first.signal.reason);
  expect(physicalSignal!.aborted).toBe(false);
  expect(progress1).toHaveBeenCalledOnce();
  expect(progress2).toHaveBeenCalledOnce();
  release();
  const acquired = await waiting2;
  acquired.release();
  const revisit = await cache.acquire("url", "digest", second.signal, vi.fn());
  expect(revisit.path).toBe(acquired.path);
  expect(downloadToFile).toHaveBeenCalledOnce();
  expect(verifySha256).toHaveBeenCalledOnce();
  revisit.release();
});

it("keeps the last cancelled consumer pending until the writer settles and cleans its partial archive", async () => {
  const cache = new VerifiedArchives(directory);
  const controller = new AbortController();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let physicalSignal: AbortSignal | undefined;
  vi.mocked(downloadToFile).mockImplementationOnce(async ({ destPath, signal }) => {
    physicalSignal = signal;
    await writeFile(destPath, "partial");
    await held;
    signal?.throwIfAborted();
  });
  let finished = false;
  const waiting = cache.acquire("url", "digest", controller.signal, vi.fn()).catch((error: unknown) => error).finally(() => { finished = true; });
  await vi.waitFor(() => expect(physicalSignal).toBeDefined());
  controller.abort();
  expect(physicalSignal!.aborted).toBe(true);
  await Promise.resolve();
  expect(finished).toBe(false);
  release();
  await waiting;
  expect(await readdir(directory)).toEqual([]);
  const retry = await cache.acquire("url", "digest", new AbortController().signal, vi.fn());
  expect(downloadToFile).toHaveBeenCalledTimes(2);
  retry.release();
});

it("never reuses a failed integrity check or a different digest", async () => {
  const cache = new VerifiedArchives(directory);
  const signal = new AbortController().signal;
  vi.mocked(verifySha256).mockRejectedValueOnce(new Error("checksum mismatch"));
  await expect(cache.acquire("url", "digest", signal, vi.fn())).rejects.toThrow("checksum mismatch");
  expect(await readdir(directory)).toEqual([]);
  (await cache.acquire("url", "digest", signal, vi.fn())).release();
  (await cache.acquire("url", "different", signal, vi.fn())).release();
  expect(downloadToFile).toHaveBeenCalledTimes(3);
});
