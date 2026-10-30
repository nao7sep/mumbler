import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTool } from "@main/core/audio-tools";
import { isCancelledError } from "@main/core/cancellation";

const observed = vi.hoisted(() => ({ child: undefined as ChildProcess | undefined }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  // Node's real spawn and ChildProcess, observed so the test can see the child.
  const spawn = vi.fn((...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    observed.child = child;
    return child;
  });
  return { ...actual, spawn };
});

// A wedged ffprobe/ffmpeg used to hang the await forever: there was no timeout,
// and the pipeline's own AbortSignal never reached these calls. Both are real
// failure modes on this app's inputs — a truncated recording, or a removable or
// network mount that stops answering mid-read.
//
// These drive the REAL runTool path with stand-in tools that never exit on their
// own, so what is under test is the bound and the signal rather than a mock of
// them. Escalation of an ignored SIGTERM is covered by manager-subprocesses,
// whose stubborn child signals readiness before the test starts cancellation.

let sleeperScript = "";
let directory = "";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "mumbler-tool-"));
  directory = dir;
  sleeperScript = join(dir, "sleeper.cjs");
  writeFileSync(sleeperScript, "setInterval(() => {}, 1_000);\n");
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));
beforeEach(() => { observed.child = undefined; });

function spawnedChild(): ChildProcess & { pid: number } {
  const child = observed.child;
  const pid = child?.pid;
  expect(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid).toBe(true);
  return child as ChildProcess & { pid: number };
}

function expectProcessGone(pid: number): void {
  // kill(pid, 0) queries existence; it sends no signal. The rejected operation
  // must already own physical settlement, on Windows as well as POSIX.
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}

describe("audio tools are bounded and cancellable", () => {
  // Driven through runTool with a short bound so the timeout path is proven in
  // moments rather than at the shipped 60s/30min values. The deadline also
  // protects calls without a cancellation signal; saves have their own
  // cancellation controller.
  it("kills a tool that never returns, and says the bound was hit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = runTool(process.execPath, [sleeperScript], { timeoutMs: 200 });
      const rejected = expect(pending).rejects.toThrow(/did not finish within/i);
      const child = spawnedChild();
      await once(child, "spawn");
      await vi.advanceTimersByTimeAsync(200);
      await rejected;
      expectProcessGone(child.pid);
    } finally { vi.useRealTimers(); }
  });

  it("answers a cancel with the pipeline's cancelled error, not a failure", async () => {
    const controller = new AbortController();
    const pending = runTool(process.execPath, [sleeperScript], {
      timeoutMs: 30_000,
      signal: controller.signal,
    }).then(() => undefined, (error: unknown) => error);
    const child = spawnedChild();

    // The distinction that matters: card-pipeline records cancelled-versus-failed
    // by asking isCancelledError. Letting Node's raw abort error escape would
    // tell the user their audio broke when in fact they pressed Cancel.
    try {
      // Observe the actual OS spawn event, without requiring a child script to
      // start or write a file inside an arbitrary startup deadline.
      await once(child, "spawn");
      controller.abort();
      expect(await pending).toSatisfy(isCancelledError);
      expectProcessGone(child.pid);
    } finally {
      controller.abort();
      await pending;
    }
  });

  it("rejects an already-aborted signal without leaving the tool running", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runTool(process.execPath, [sleeperScript], { timeoutMs: 30_000, signal: controller.signal }),
    ).rejects.toSatisfy(isCancelledError);
  });

  // A tag probe prints embedded cover art; Node's collected-output default of
  // 1 MiB used to fail such a probe outright.
  it("returns printed output larger than 1 MiB whole", async () => {
    const printer = join(directory, "printer.cjs");
    writeFileSync(printer, "process.stdout.write('x'.repeat(3 * 1024 * 1024));\n");
    const { stdout } = await runTool(process.execPath, [printer], { timeoutMs: 30_000 });
    expect(stdout.length).toBe(3 * 1024 * 1024);
  });
});
