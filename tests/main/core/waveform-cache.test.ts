import { expect, it, vi } from "vitest";
import { WaveformCache } from "@main/core/waveform-cache";

it("releases a summary with its last consumer and computes it again on revisit", async () => {
  const compute = vi.fn(async () => Float32Array.of(0.25, 0.75));
  const cache = new WaveformCache(compute);
  for (const file of ["first", "second"]) {
    expect(await cache.acquire(file, file)).toEqual(Float32Array.of(0.25, 0.75));
    cache.release(file);
  }
  expect(await cache.acquire("first", "revisit")).toEqual(Float32Array.of(0.25, 0.75));
  expect(compute).toHaveBeenCalledTimes(3);
  cache.release("revisit");
  await cache.close();
});

it("discards stale results even if an aborted decoder returns and lets a new consumer proceed", async () => {
  const runs: Array<{ signal: AbortSignal; finish: (value: Float32Array) => void }> = [];
  const compute = vi.fn((_file: string, signal: AbortSignal) => new Promise<Float32Array>((finish) => runs.push({ signal, finish })));
  const cache = new WaveformCache(compute);
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
  await cache.close();
});
