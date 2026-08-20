import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureToolResolver, probeAudioProfile, runTool } from "@main/core/audio-tools";
import { isCancelledError } from "@main/core/cancellation";

// A wedged ffprobe/ffmpeg used to hang the await forever: there was no timeout,
// and the pipeline's own AbortSignal never reached these calls. Both are real
// failure modes on this app's inputs — a truncated recording, or a removable or
// network mount that stops answering mid-read.
//
// These drive the REAL runTool path with stand-in tools that never exit on their
// own, so what is under test is the bound and the signal rather than a mock of
// them. Two stand-ins, because the polite and the stubborn case differ:
// `sleeper` dies on SIGTERM (the normal tool), `stubborn` traps it.

let sleeper = "";
let stubborn = "";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "mumbler-tool-"));
  sleeper = join(dir, "sleeper");
  stubborn = join(dir, "stubborn");
  writeFileSync(sleeper, "#!/bin/sh\nwhile true; do sleep 1; done\n");
  writeFileSync(stubborn, "#!/bin/sh\ntrap '' TERM\nwhile true; do sleep 1; done\n");
  chmodSync(sleeper, 0o755);
  chmodSync(stubborn, 0o755);
  configureToolResolver(() => sleeper);
});

describe("audio tools are bounded and cancellable", () => {
  // Driven through runTool with a short bound so the timeout path is proven in
  // moments rather than at the shipped 60s/30min values. This bound is the ONLY
  // protection the import and save paths have: they are IPC handlers with no
  // controller, so there is nothing there to cancel with.
  it("kills a tool that never returns, and says the bound was hit", async () => {
    await expect(runTool(sleeper, [], { timeoutMs: 200 })).rejects.toThrow(
      /did not finish within/i,
    );
  }, 30_000);

  // The reason the kill escalates: a tool that ignores SIGTERM would otherwise
  // outlive the bound it was given, and the await would hang exactly as before.
  it("follows an ignored SIGTERM with SIGKILL", async () => {
    await expect(runTool(stubborn, [], { timeoutMs: 200 })).rejects.toThrow(
      /did not finish within/i,
    );
  }, 30_000);

  it("answers a cancel with the pipeline's cancelled error, not a failure", async () => {
    const controller = new AbortController();
    const pending = probeAudioProfile("/any/input.mp3", controller.signal);
    setTimeout(() => controller.abort(), 20);

    // The distinction that matters: card-pipeline records cancelled-versus-failed
    // by asking isCancelledError. Letting Node's raw abort error escape would
    // tell the user their audio broke when in fact they pressed Cancel.
    await expect(pending).rejects.toSatisfy(isCancelledError);
  }, 30_000);

  it("rejects an already-aborted signal without leaving the tool running", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(probeAudioProfile("/any/input.mp3", controller.signal)).rejects.toSatisfy(
      isCancelledError,
    );
  }, 30_000);
});
