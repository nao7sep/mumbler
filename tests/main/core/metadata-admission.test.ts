import { describe, expect, it, vi } from "vitest";
import { MetadataAdmission } from "@main/core/metadata-admission";
import { CancelledError } from "@main/core/cancellation";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("metadata admission", () => {
  it("holds issued capacity after cancellation until physical settlement and removes cancelled waits", async () => {
    const admission = new MetadataAdmission(() => 1);
    const issued = deferred();
    const cancelled = new AbortController();
    const first = admission.run(cancelled.signal, () => issued.promise);
    await Promise.resolve();
    cancelled.abort();
    const waiting = new AbortController();
    const skipped = vi.fn(async () => undefined);
    const second = admission.run(waiting.signal, skipped).catch((error) => error);
    const last = vi.fn(async () => undefined);
    const third = admission.run(new AbortController().signal, last);
    waiting.abort();
    expect(await second).toBeInstanceOf(CancelledError);
    expect(skipped).not.toHaveBeenCalled();
    expect(last).not.toHaveBeenCalled();
    issued.resolve();
    await Promise.all([first, third]);
    expect(last).toHaveBeenCalledOnce();
  });

  it("adapts queued capacity to the preference without cancelling issued work", async () => {
    let limit = 1;
    const admission = new MetadataAdmission(() => limit);
    const holds = Array.from({ length: 4 }, deferred);
    const starts: number[] = [];
    const work = holds.map((hold, index) => admission.run(new AbortController().signal, () => {
      starts.push(index);
      return hold.promise;
    }));
    await Promise.resolve();
    expect(starts).toEqual([0]);
    limit = 2;
    admission.drain();
    await Promise.resolve();
    expect(starts).toEqual([0, 1]);
    limit = 1;
    holds[0]!.resolve();
    await work[0];
    expect(starts).toEqual([0, 1]);
    holds[1]!.resolve();
    await work[1];
    expect(starts).toEqual([0, 1, 2]);
    holds[2]!.resolve();
    await work[2];
    holds[3]!.resolve();
    await work[3];
  });

  it("releases a rejected call and never starts an already-cancelled one", async () => {
    const admission = new MetadataAdmission(() => 1);
    const cancelled = new AbortController();
    cancelled.abort();
    const skipped = vi.fn(async () => undefined);
    await expect(admission.run(cancelled.signal, skipped)).rejects.toBeInstanceOf(CancelledError);
    await expect(admission.run(new AbortController().signal, async () => { throw new Error("provider rejected"); })).rejects.toThrow("provider rejected");
    await expect(admission.run(new AbortController().signal, async () => "next")).resolves.toBe("next");
    expect(skipped).not.toHaveBeenCalled();
  });
});
