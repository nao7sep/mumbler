import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExternalFileOperations, EXTERNAL_FILE_DEADLINE_MS, EXTERNAL_FILE_IDLE_MS } from "@main/core/external-file-operations";
function gate() {
  let release!: () => void;
  return { wait: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("releases an idle caller but retains finite physical capacity through late cleanup", async () => {
  const owner = new ExternalFileOperations(1);
  const held = gate();
  const cleanup = gate();
  const events: string[] = [];
  const result = owner.run(async ({ signal }) => {
    await held.wait;
    try { signal.throwIfAborted(); events.push("publish"); }
    finally { events.push("cleanup"); await cleanup.wait; }
  }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(EXTERNAL_FILE_IDLE_MS);
  expect(await result).toMatchObject({ message: expect.stringContaining("progress") });
  await expect(owner.run(async () => undefined)).rejects.toThrow("still settling");
  held.release();
  await vi.advanceTimersByTimeAsync(0);
  expect(events).toEqual(["cleanup"]);
  await expect(owner.run(async () => undefined)).rejects.toThrow("still settling");
  cleanup.release();
  await owner.cancelAndDrain();
  owner.resume();
  await expect(owner.run(async () => "next")).resolves.toBe("next");
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds total duration even when progress keeps the idle deadline alive", async () => {
  const owner = new ExternalFileOperations(1);
  const held = gate();
  let progress!: () => void;
  const result = owner.run(async (context) => { progress = context.progress; await held.wait; }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  for (let elapsed = 0; elapsed < EXTERNAL_FILE_DEADLINE_MS; elapsed += 10_000) {
    progress();
    await vi.advanceTimersByTimeAsync(10_000);
  }
  expect(await result).toMatchObject({ message: expect.stringContaining("deadline") });
  held.release();
  await owner.cancelAndDrain();
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels callers on quit while draining the still-running native work", async () => {
  const owner = new ExternalFileOperations(2);
  const held = gate();
  const entered = gate();
  const result = owner.run(async () => { entered.release(); await held.wait; }).catch((error: unknown) => error);
  await entered.wait;
  let drained = false;
  const drain = owner.cancelAndDrain().then(() => { drained = true; });
  expect(await result).toMatchObject({ message: expect.stringContaining("quit") });
  expect(drained).toBe(false);
  held.release();
  await drain;
  expect(vi.getTimerCount()).toBe(0);
});

it("releases settled capacity before admitting the caller's next operation", async () => {
  const owner = new ExternalFileOperations(1);
  await expect(owner.run(async () => "first")).resolves.toBe("first");
  await expect(owner.run(async () => "second")).resolves.toBe("second");
  expect(vi.getTimerCount()).toBe(0);
});

it("retains source exclusion after timeout until physical settlement", async () => {
  const owner = new ExternalFileOperations(2);
  const held = gate();
  const first = owner.run(async ({ claimSource }) => { claimSource("source"); await held.wait; }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(EXTERNAL_FILE_IDLE_MS);
  await first;
  await expect(owner.run(async ({ claimSource }) => { claimSource("source"); })).rejects.toThrow("still in use");
  held.release();
  await owner.cancelAndDrain();
  await expect(owner.run(async () => undefined)).rejects.toThrow("quit");
  owner.resume();
  await expect(owner.run(async ({ claimSource }) => { claimSource("source"); })).resolves.toBeUndefined();
});
