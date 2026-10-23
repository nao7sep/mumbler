import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CancelledError } from "@main/core/cancellation";
import type { SaveTargetPaths } from "@main/core/file-output";

const effects = vi.hoisted(() => ({
  beforeRename: null as ((target: string) => Promise<void>) | null,
  beforeWrite: null as ((target: string) => Promise<void>) | null,
  linkCode: null as string | null,
  directoryFailure: null as string | null,
  staged: new Set<string>(),
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (source: string, target: string) => {
      await effects.beforeRename?.(target);
      return actual.rename(source, target);
    },
    link: async (source: string, target: string) => {
      if (effects.linkCode !== null) throw Object.assign(new Error("hard links unavailable"), { code: effects.linkCode });
      return actual.link(source, target);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (args[1] === "r" && String(args[0]) === effects.directoryFailure) throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
      const handle = await actual.open(...args);
      const path = String(args[0]);
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...writeArgs: Parameters<typeof handle.writeFile>) => {
        await effects.beforeWrite?.(path);
        await write(...writeArgs);
        if (basename(path) === "transcript.md") effects.staged.add(String(writeArgs[0]));
      };
      return handle;
    },
  };
});
const { finalizeOutputs, OutputLocationError, OutputPartialFailureError } = await import("@main/core/file-output");

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

let directory: string;
let source: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mumbler-reservations-"));
  source = join(directory, "source.wav");
  await writeFile(source, "AUDIO");
  effects.beforeRename = null;
  effects.beforeWrite = null;
  effects.linkCode = null;
  effects.directoryFailure = null;
  effects.staged.clear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function targets(name: string, root = directory): SaveTargetPaths {
  return { audioPath: join(root, `${name}.wav`), jsonPath: join(root, `${name}.json`), markdownPath: join(root, `${name}.md`) };
}
function save(name: string, output: SaveTargetPaths, options: { signal?: AbortSignal; isSafeLocation?: () => Promise<boolean>; overwrite?: boolean } = {}) {
  return finalizeOutputs({ sourceAudioPath: source, targets: output, overwrite: true, jsonContent: `JSON ${name}`, markdownContent: `MD ${name}`, ...options });
}

// Observe the public cancellation boundary after this attempt's real staging.
// Audio streaming also listens for abort, so earlier stream listeners do not
// establish that a publication reservation has been registered.
function watchReservation(controller: AbortController, name: string) {
  const entered = gate();
  let listener: EventListenerOrEventListenerObject | undefined;
  const add = controller.signal.addEventListener.bind(controller.signal);
  vi.spyOn(controller.signal, "addEventListener").mockImplementation((type, callback, options) => {
    add(type, callback, options);
    if (type === "abort" && effects.staged.has(`MD ${name}`)) {
      listener = callback;
      entered.release();
    }
  });
  const removed = vi.spyOn(controller.signal, "removeEventListener");
  return { entered: entered.promise, expectDisposed: () => expect(removed).toHaveBeenCalledWith("abort", listener) };
}

async function expectCompleteWhileHeld(attempt: Promise<unknown>, held: { released: boolean }) {
  let settled = false;
  void attempt.then(() => { settled = true; }, () => { settled = true; });
  // Poll only the completion being proved; the first filesystem effect remains
  // held until the assertion finishes, including on a regression failure.
  await vi.waitFor(() => expect(settled).toBe(true));
  expect(held.released).toBe(false);
  await attempt;
}

describe("output publication reservations", () => {
  it("reports completed outputs without claiming success when directory sync fails", async () => {
    const output = targets("unsynced");
    effects.directoryFailure = directory;
    const failure = await save("unsynced", output).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OutputPartialFailureError);
    expect(failure).toMatchObject({ cause: { code: "EIO" }, files: [
      { path: output.audioPath, status: "saved" },
      { path: output.jsonPath, status: "saved" },
      { path: output.markdownPath, status: "saved" },
    ] });
    expect(await readFile(source, "utf8")).toBe("AUDIO");
    expect(await readFile(output.audioPath, "utf8")).toBe("AUDIO");
    effects.directoryFailure = null;
    await save("retry", output);
    expect(await readFile(output.markdownPath, "utf8")).toBe("MD retry");
  });

  it.each(["location", "rename"] as const)("publishes an unrelated group while the first %s effect is held", async (boundary) => {
    const firstTargets = targets("first");
    const entered = gate();
    const held = gate();
    const state = { released: false };
    const hold = async () => { entered.release(); await held.promise; };
    if (boundary === "rename") effects.beforeRename = async (target) => { if (target === firstTargets.audioPath) await hold(); };
    const first = save("first", firstTargets, boundary === "location" ? { isSafeLocation: async () => { await hold(); return true; } } : {});
    await entered.promise;
    const secondTargets = targets("second");
    const second = save("second", secondTargets);
    try {
      await expectCompleteWhileHeld(second, state);
      expect(await readFile(secondTargets.jsonPath, "utf8")).toBe("JSON second");
      expect(await readFile(secondTargets.markdownPath, "utf8")).toBe("MD second");
    } finally { state.released = true; held.release(); await Promise.allSettled([first, second]); }
  });

  it("cancels a conflicting pending save and removes its private stage while the predecessor is held", async () => {
    const entered = gate();
    const held = gate();
    const state = { released: false };
    const output = targets("shared");
    const first = save("first", output, { isSafeLocation: async () => { entered.release(); await held.promise; return true; } });
    await entered.promise;
    const controller = new AbortController();
    const reservation = watchReservation(controller, "waiting");
    const waiting = save("waiting", output, { signal: controller.signal });
    const cancelled = expect(waiting).rejects.toBeInstanceOf(CancelledError);
    try {
      await reservation.entered;
      controller.abort();
      await expectCompleteWhileHeld(cancelled, state);
      reservation.expectDisposed();
      expect((await readdir(directory)).filter((name) => name.startsWith(".mumbler-save-"))).toHaveLength(1);
      expect(await readdir(directory)).not.toContain("shared.wav");
    } finally { state.released = true; held.release(); await Promise.allSettled([first, waiting]); }
  });

  it.each(["same targets", "shared member", "directory alias", "case and normalization"] as const)("orders groups with %s through the first complete trio", async (kind) => {
    const output = targets("first");
    let secondTargets = output;
    if (kind === "shared member") secondTargets = { ...targets("second"), jsonPath: output.jsonPath };
    if (kind === "directory alias") {
      const alias = join(directory, "alias");
      await symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
      secondTargets = targets("first", alias);
    }
    if (kind === "case and normalization") {
      output.jsonPath = join(directory, "Caf\u00e9.json");
      secondTargets = { ...targets("second"), jsonPath: join(directory, "CAFE\u0301.json") };
    }
    const entered = gate();
    const held = gate();
    const order: string[] = [];
    effects.beforeRename = async (target) => {
      order.push(target);
      if (target === output.markdownPath && order.length === 3) { entered.release(); await held.promise; }
    };
    const first = save("first", output);
    await entered.promise;
    const controller = new AbortController();
    const reservation = watchReservation(controller, "second");
    let secondEntered = false;
    const second = save("second", secondTargets, { signal: controller.signal, isSafeLocation: async () => { secondEntered = true; return true; } });
    try {
      await reservation.entered;
      // An independent complete save supplies progress while the first stays
      // held, rather than inferring exclusion from a short elapsed interval.
      await save("independent", targets("independent"));
      expect(secondEntered).toBe(false);
      expect(await readFile(output.jsonPath, "utf8")).toBe("JSON first");
      held.release();
      await Promise.all([first, second]);
      reservation.expectDisposed();
      expect(await readFile(secondTargets.jsonPath, "utf8")).toBe("JSON second");
      const firstMarkdownIndex = order.indexOf(output.markdownPath);
      const secondJsonIndex = order.lastIndexOf(secondTargets.jsonPath);
      expect(secondJsonIndex).toBeGreaterThan(firstMarkdownIndex);
    } finally { held.release(); await Promise.allSettled([first, second]); }
  });

  it.skipIf(process.platform === "win32")("reserves an existing target symlink together with its resolved target", async () => {
    const resolved = targets("resolved");
    await writeFile(resolved.jsonPath, "OLD JSON");
    const alias = targets("alias");
    await symlink(resolved.jsonPath, alias.jsonPath);
    const entered = gate();
    const held = gate();
    const first = save("alias", alias, { isSafeLocation: async () => { entered.release(); await held.promise; return true; } });
    await entered.promise;
    const controller = new AbortController();
    const reservation = watchReservation(controller, "resolved");
    let secondEntered = false;
    const second = save("resolved", resolved, { signal: controller.signal, isSafeLocation: async () => { secondEntered = true; return true; } });
    try {
      await reservation.entered;
      await save("independent", targets("independent"));
      expect(secondEntered).toBe(false);
      held.release();
      await Promise.all([first, second]);
      expect(await readFile(alias.jsonPath, "utf8")).toBe("JSON alias");
      expect(await readFile(resolved.jsonPath, "utf8")).toBe("JSON resolved");
    } finally { held.release(); await Promise.allSettled([first, second]); }
  });

  it("releases a cancelled bridge without losing the active predecessor on its other member", async () => {
    const x = targets("x");
    const y = targets("y");
    const entered = gate();
    const held = gate();
    const state = { released: false };
    const first = save("first", x, { isSafeLocation: async () => { entered.release(); await held.promise; return true; } });
    await entered.promise;
    const bridgeController = new AbortController();
    const bridgeReservation = watchReservation(bridgeController, "bridge");
    const bridge = save("bridge", { ...targets("bridge"), jsonPath: x.jsonPath, markdownPath: y.markdownPath }, { signal: bridgeController.signal });
    const bridgeCancelled = expect(bridge).rejects.toBeInstanceOf(CancelledError);
    await bridgeReservation.entered;
    const xController = new AbortController();
    const xReservation = watchReservation(xController, "after-x");
    let xEntered = false;
    const afterX = save("after-x", x, { signal: xController.signal, isSafeLocation: async () => { xEntered = true; return true; } });
    const yController = new AbortController();
    const yReservation = watchReservation(yController, "after-y");
    const afterY = save("after-y", y, { signal: yController.signal });
    try {
      await Promise.all([xReservation.entered, yReservation.entered]);
      bridgeController.abort();
      await expectCompleteWhileHeld(bridgeCancelled, state);
      await expectCompleteWhileHeld(afterY, state);
      bridgeReservation.expectDisposed();
      expect(xEntered).toBe(false);
      expect(await readFile(y.markdownPath, "utf8")).toBe("MD after-y");
      state.released = true;
      held.release();
      await Promise.all([first, afterX]);
      expect(await readFile(x.jsonPath, "utf8")).toBe("JSON after-x");
    } finally { state.released = true; held.release(); await Promise.allSettled([first, bridge, afterX, afterY]); }
  });

  it("releases a refused location reservation for the next conflicting save", async () => {
    const output = targets("shared");
    const entered = gate();
    const held = gate();
    const first = save("first", output, { isSafeLocation: async () => { entered.release(); await held.promise; return false; } });
    const refused = expect(first).rejects.toBeInstanceOf(OutputLocationError);
    await entered.promise;
    const controller = new AbortController();
    const reservation = watchReservation(controller, "second");
    const second = save("second", output, { signal: controller.signal });
    try {
      await reservation.entered;
      held.release();
      await refused;
      await second;
      expect(await readFile(output.jsonPath, "utf8")).toBe("JSON second");
      reservation.expectDisposed();
    } finally { held.release(); await Promise.allSettled([first, second]); }
  });

  it("keeps the partial publication contract when a later target directory is missing", async () => {
    const output = { ...targets("partial"), jsonPath: join(directory, "missing", "metadata.json") };
    const attempt = save("partial", output);
    await expect(attempt).rejects.toMatchObject({ primary: expect.objectContaining({ code: "ENOENT" }), files: [
      { path: output.audioPath, status: "saved" }, { path: output.jsonPath, status: "failed" }, { path: output.markdownPath, status: "pending" },
    ] });
    expect(await readFile(output.audioPath, "utf8")).toBe("AUDIO");
    expect((await readdir(directory)).filter((name) => name.startsWith(".mumbler-save-"))).toEqual([]);
  });

  it("keeps an issued fallback copy reserved through settlement after cancellation", async () => {
    effects.linkCode = "ENOTSUP";
    const output = targets("shared");
    const entered = gate();
    const held = gate();
    const state = { released: false };
    effects.beforeWrite = async (path) => { if (path === output.audioPath) { entered.release(); await held.promise; } };
    const firstController = new AbortController();
    const first = save("first", output, { signal: firstController.signal, overwrite: false });
    const partial = expect(first).rejects.toBeInstanceOf(OutputPartialFailureError);
    await entered.promise;
    const secondController = new AbortController();
    const reservation = watchReservation(secondController, "second");
    let secondEntered = false;
    const second = save("second", output, { signal: secondController.signal, isSafeLocation: async () => { secondEntered = true; return true; } });
    try {
      await reservation.entered;
      firstController.abort();
      const unrelated = save("independent", targets("independent"), { overwrite: false });
      await expectCompleteWhileHeld(unrelated, state);
      expect(secondEntered).toBe(false);
      state.released = true;
      held.release();
      await partial;
      await expect(first).rejects.toMatchObject({ primary: expect.any(CancelledError), files: [
        { path: output.audioPath, status: "failed" }, { path: output.jsonPath, status: "pending" }, { path: output.markdownPath, status: "pending" },
      ] });
      await second;
      expect(await readFile(output.jsonPath, "utf8")).toBe("JSON second");
    } finally { state.released = true; held.release(); await Promise.allSettled([first, second]); }
  });
});
