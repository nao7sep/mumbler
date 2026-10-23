import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WaveformCache } from "@main/core/waveform-cache";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "mumbler-waveform-cache-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it("releases completed arrays with the last consumer and recovers disk summaries on revisit", async () => {
  const compute = vi.fn(async () => Float32Array.of(0.25, 0.75));
  const cache = new WaveformCache(directory, compute);
  for (const file of ["first", "second", "third"]) {
    expect(await cache.acquire(file, file)).toEqual(Float32Array.of(0.25, 0.75));
    cache.release(file);
  }
  expect(await cache.acquire("first", "revisit")).toEqual(Float32Array.of(0.25, 0.75));
  expect(compute).toHaveBeenCalledTimes(3);
  cache.release("revisit");
  // With disk data removed, an old in-memory result must not mask the miss.
  await rm(directory, { recursive: true });
  await cache.acquire("first", "uncached");
  expect(compute).toHaveBeenCalledTimes(4);
  await cache.close();
});

it("discards stale results even if an aborted decoder returns and lets a new consumer proceed", async () => {
  const runs: Array<{ signal: AbortSignal; finish: (value: Float32Array) => void }> = [];
  const compute = vi.fn((_file: string, signal: AbortSignal) => new Promise<Float32Array>((finish) => runs.push({ signal, finish })));
  const cache = new WaveformCache(directory, compute);
  const first = cache.acquire("audio", "first");
  await vi.waitFor(() => expect(runs).toHaveLength(1));
  cache.release("first");
  const next = cache.acquire("audio", "next");
  await vi.waitFor(() => expect(runs).toHaveLength(2));
  expect(runs[0]!.signal.aborted).toBe(true);
  runs[1]!.finish(Float32Array.of(0.75));
  expect(await next).toEqual(Float32Array.of(0.75));
  runs[0]!.finish(Float32Array.of(0.1));
  expect(await first).toBeNull();
  cache.release("next");
  expect(await cache.acquire("audio", "revisit")).toEqual(Float32Array.of(0.75));
  expect(compute).toHaveBeenCalledTimes(2);
  await cache.close();
});

it("decodes again after a damaged cache and preserves playback data when cache storage is unavailable", async () => {
  const compute = vi.fn(async () => Float32Array.of(0.5));
  const cache = new WaveformCache(directory, compute);
  await cache.acquire("audio", "first");
  cache.release("first");
  const [name] = await readdir(directory);
  await writeFile(join(directory, name!), "broken");
  expect(await cache.acquire("audio", "second")).toEqual(Float32Array.of(0.5));
  cache.release("second");
  await rm(directory, { recursive: true });
  await writeFile(directory, "not a directory");
  expect(await cache.acquire("audio", "third")).toEqual(Float32Array.of(0.5));
  expect(compute).toHaveBeenCalledTimes(3);
  await cache.close();
});
