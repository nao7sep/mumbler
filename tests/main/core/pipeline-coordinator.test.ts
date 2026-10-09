import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MumblerCard, MumblerQueue } from "@shared/app-shell";
import type { AppLogger } from "@main/core/logger";

// The coordinator spawns executeCardPipeline fire-and-forget; stub it with a
// per-card deferred so a test can hold a "pipeline" running and settle it when
// it chooses. Everything else in card-pipeline stays real (types only here).
const pipelineDeferreds = new Map<string, { resolve: () => void; promise: Promise<void> }>();
vi.mock("@main/core/card-pipeline", async (importOriginal) => {
  const original = await importOriginal<typeof import("@main/core/card-pipeline")>();
  return {
    ...original,
    executeCardPipeline: vi.fn(async (cardId: string, _step, _mode, ctx: import("@main/core/card-pipeline").CardPipelineContext) => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      pipelineDeferreds.set(cardId, { resolve, promise });
      ctx.signal.addEventListener("abort", resolve, { once: true });
      if (ctx.signal.aborted) resolve();
      try {
        await promise;
      } finally {
        ctx.signal.removeEventListener("abort", resolve);
      }
    }),
  };
});

const { PipelineCoordinator } = await import("@main/core/pipeline-coordinator");
const { createDefaultSettings, createEmptyQueue } = await import("@main/core/settings-schema");
const { OperationError } = await import("@main/core/operation-error");

const noopLogger: AppLogger = {
  debug: async () => {},
  info: async () => {},
  warn: async () => {},
  error: async () => {},
  providerCall: async () => {},
};

function makeCard(overrides: Partial<MumblerCard> = {}): MumblerCard {
  return {
    id: "card-1",
    originalFilename: "rec.m4a",
    importSource: "file-picker",
    sourceFilePath: "/tmp/rec.m4a",
    audioProfile: null,
    durationSec: 60,
    fileSizeBytes: 1024,
    timestamps: {
      confirmedLocal: "2026-04-22 09:44:00",
      confirmedUtc: Date.UTC(2026, 3, 22, 0, 44, 0),
      timezone: "Asia/Tokyo",
      frontTrimOffsetSec: 0,
      effectiveLocal: "2026-04-22 09:44:00",
      effectiveUtc: Date.UTC(2026, 3, 22, 0, 44, 0),
    },
    trim: { frontMarkerSec: null, backMarkerSec: null },
    trimDecision: null,
    transcribedTrim: null,
    transcription: { text: null },
    metadata: { structured: null, title: null, slug: null },
    ai: { transcription: null, structured: null, title: null, slug: null },
    status: "Imported",
    activeStep: null,
    queuedMode: null,
    queuedAtUtc: null,
    lastError: null,
    createdAtUtc: 1,
    updatedAtUtc: 1,
    ...overrides,
  };
}

// A settled pipeline finalizes on a microtask; flush enough turns for the
// finally → finalize → drain chain to complete.
async function settle(cardId: string): Promise<void> {
  pipelineDeferreds.get(cardId)?.resolve();
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

const coordinators = new Set<InstanceType<typeof PipelineCoordinator>>();

function harness(cards: MumblerCard[], concurrencyLimit = 1) {
  const state: MumblerQueue = { ...createEmptyQueue(), cards };
  const settings = { ...createDefaultSettings(), concurrencyLimit };
  const persistState = vi.fn(async () => {});
  const resolveApiKey = vi.fn(async (): Promise<string | null> => "test-key");
  const coordinator = new PipelineCoordinator(
    { state, settings, paths: null, logger: noopLogger },
    { persistState, resolveApiKey },
  );
  coordinators.add(coordinator);
  return { state, coordinator, persistState, resolveApiKey };
}

beforeEach(() => {
  pipelineDeferreds.clear();
});

afterEach(async () => {
  const shutdowns = [...coordinators].map((coordinator) => coordinator.shutdown());
  for (const deferred of pipelineDeferreds.values()) deferred.resolve();
  await Promise.all(shutdowns);
  coordinators.clear();
  pipelineDeferreds.clear();
});

describe("PipelineCoordinator.startOrEnqueue", () => {
  it("starts immediately when a transcription slot is free", async () => {
    const card = makeCard({ id: "a" });
    const { coordinator, persistState } = harness([card]);

    await coordinator.startOrEnqueue("a", "generate", "transcription");

    expect(card.status).toBe("Transcribing");
    expect(card.activeStep).toBe("transcription");
    expect(coordinator.hasRun("a")).toBe(true);
    expect(persistState).toHaveBeenCalled();
  });

  it("queues the card when every slot is taken", async () => {
    const first = makeCard({ id: "a" });
    const second = makeCard({ id: "b" });
    const { coordinator } = harness([first, second], 1);

    await coordinator.startOrEnqueue("a", "generate", "transcription");
    await coordinator.startOrEnqueue("b", "generate", "transcription");

    expect(second.status).toBe("Queued");
    expect(second.queuedMode).toBe("generate");
    expect(second.updatedAtUtc, "queueing is not a content edit").toBe(1);
    expect(coordinator.hasRun("b")).toBe(false);
  });

  it("starts a metadata-only step without taking a transcription slot", async () => {
    const first = makeCard({ id: "a" });
    const second = makeCard({ id: "b" });
    const { coordinator } = harness([first, second], 1);

    await coordinator.startOrEnqueue("a", "generate", "transcription");
    // The lone slot is held by "a", yet a structured-only run needs none.
    await coordinator.startOrEnqueue("b", "generate", "structured");

    expect(second.status).toBe("Generating Metadata");
    expect(coordinator.hasRun("b")).toBe(true);
  });

  it("refuses a busy card and a missing card", async () => {
    const busy = makeCard({ id: "a", status: "Queued", queuedMode: "generate", queuedAtUtc: 1 });
    const { coordinator } = harness([busy]);

    await expect(coordinator.startOrEnqueue("a", "generate")).rejects.toThrow(OperationError);
    await expect(coordinator.startOrEnqueue("missing", "generate")).rejects.toThrow(
      "Card to process does not exist.",
    );
  });

  it("claims the card before its first await, so nothing can slip in between check and claim", async () => {
    const card = makeCard({ id: "a" });
    const { coordinator } = harness([card]);

    const start = coordinator.startOrEnqueue("a", "generate", "transcription");
    try {
      expect(card.status).toBe("Transcribing");
      expect(() => coordinator.assertCardCanStart(card)).toThrow(OperationError);
    } finally {
      await start;
    }
  });

  it.each(["transcription", "structured"] as const)("settles a failed %s prestart claim without launching it", async (step) => {
    const first = makeCard({ id: "a", status: "Cancelled" });
    const second = makeCard({ id: "b" });
    const { coordinator, persistState } = harness([first, second], 1);
    const failure = new Error("prestart save failed");
    persistState.mockRejectedValueOnce(failure);
    await expect(coordinator.startOrEnqueue("a", "generate", step)).rejects.toBe(failure);
    expect(first).toMatchObject({ status: "Cancelled", activeStep: null, queuedMode: null, queuedAtUtc: null });
    expect(first.updatedAtUtc).toBe(1);
    expect(coordinator.hasRun("a")).toBe(false);
    expect(pipelineDeferreds.has("a")).toBe(false);
    await coordinator.startOrEnqueue("b", "generate", "transcription");
    expect(coordinator.hasRun("b")).toBe(true);
    expect(second.status).toBe("Transcribing");
    await coordinator.startOrEnqueue("a", "generate", step);
    expect(first.status).toBe(step === "transcription" ? "Queued" : "Generating Metadata");
  });

  it("retains the initial save failure when persisting the settled state also fails", async () => {
    const first = makeCard({ id: "a" });
    const second = makeCard({ id: "b" });
    const { coordinator, persistState } = harness([first, second], 1);
    const initial = new Error("initial save failed");
    const recovery = new Error("settled save failed");
    persistState.mockRejectedValueOnce(initial).mockRejectedValueOnce(recovery);
    const diagnostic = vi.spyOn(noopLogger, "error");
    try {
      await expect(coordinator.startOrEnqueue("a", "generate", "transcription")).rejects.toBe(initial);
      expect(first.status).toBe("Imported");
      expect(diagnostic).toHaveBeenCalledWith(
        "pipeline.prestart-recovery-failed",
        expect.any(String), recovery, { cardId: "a", startStep: "transcription" },
      );
      await coordinator.startOrEnqueue("b", "generate", "transcription");
      expect(coordinator.hasRun("b")).toBe(true);
    } finally {
      diagnostic.mockRestore();
    }
  });

  it("releases a failed prestart slot and admits a card queued during its save", async () => {
    const first = makeCard({ id: "a" });
    const second = makeCard({ id: "b" });
    const { coordinator, persistState } = harness([first, second], 1);
    let reject!: (error: Error) => void;
    const held = new Promise<void>((_resolve, fail) => { reject = fail; });
    persistState.mockReturnValueOnce(held);
    const pending = coordinator.startOrEnqueue("a", "generate", "transcription");
    const failure = new Error("held prestart failed");
    const rejected = expect(pending).rejects.toBe(failure);
    try {
      await coordinator.startOrEnqueue("b", "generate", "transcription");
      expect(second.status).toBe("Queued");
      reject(failure);
      await rejected;
      expect(first.status).toBe("Imported");
      expect(coordinator.hasRun("a")).toBe(false);
      expect(coordinator.hasRun("b")).toBe(true);
    } finally {
      reject(failure);
      await Promise.allSettled([pending, rejected]);
    }
  });

  it("does not restore a failed prestart claim over a replacement card", async () => {
    const first = makeCard({ id: "a" });
    const { state, coordinator, persistState } = harness([first]);
    let reject!: (error: Error) => void;
    const held = new Promise<void>((_resolve, fail) => { reject = fail; });
    persistState.mockReturnValueOnce(held);
    const pending = coordinator.startOrEnqueue("a", "generate", "transcription");
    const failure = new Error("prestart failed after replacement");
    const rejected = expect(pending).rejects.toBe(failure);
    try {
      const replacement = { ...first, status: "Cancelled" as const, activeStep: null };
      state.cards[0] = replacement;
      reject(failure);
      await rejected;
      expect(state.cards[0]).toBe(replacement);
      expect(state.cards[0].status).toBe("Cancelled");
    } finally {
      reject(failure);
      await Promise.allSettled([pending, rejected]);
    }
  });

});

describe("PipelineCoordinator drain on completion", () => {
  it("admits the earliest queued card when a running pipeline settles", async () => {
    const first = makeCard({ id: "a" });
    const second = makeCard({ id: "b" });
    const { coordinator } = harness([first, second], 1);

    await coordinator.startOrEnqueue("a", "generate", "transcription");
    await coordinator.startOrEnqueue("b", "generate", "transcription");
    expect(second.status).toBe("Queued");

    await settle("a");

    // Finalize released a's slot and the drain spawned b's pipeline.
    expect(coordinator.hasRun("a")).toBe(false);
    expect(coordinator.hasRun("b")).toBe(true);
  });
});

describe("PipelineCoordinator.detachAndAbort", () => {
  it("reports a card with no active run", () => {
    const { coordinator } = harness([makeCard({ id: "a" })]);
    expect(coordinator.detachAndAbort("a")).toBe(false);
  });

  it("takes the card from its run at once, and frees the slot only when the run's work settles", async () => {
    const first = makeCard({ id: "a" });
    const second = makeCard({ id: "b" });
    const { coordinator } = harness([first, second], 1);

    await coordinator.startOrEnqueue("a", "generate", "transcription");
    await coordinator.startOrEnqueue("b", "generate", "transcription");

    expect(coordinator.detachAndAbort("a")).toBe(true);
    expect(coordinator.hasRun("a")).toBe(false);
    expect(coordinator.hasRun("b"), "the cancelled run still holds its slot").toBe(false);

    await settle("a");
    await vi.waitFor(() => expect(coordinator.hasRun("b")).toBe(true));
  });
});

describe("PipelineCoordinator.shutdown", () => {
  it.each(["saved", "failed"] as const)("shutdown owns a %s prestart and prevents late pipeline admission", async (result) => {
    const card = makeCard({ id: "a" });
    const { coordinator, persistState } = harness([card]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const primary = new Error("prestart failed");
    persistState.mockImplementationOnce(async () => {
      await held;
      if (result === "failed") throw primary;
    });
    const work = coordinator.startOrEnqueue("a", "generate", "transcription");
    const outcome = work.catch((error: unknown) => error);
    const shutdown = coordinator.shutdown();
    let settled = false;
    void shutdown.then(() => { settled = true; });
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      await expect(coordinator.startOrEnqueue("a", "generate", "structured")).rejects.toThrow("closing");
      release();
      expect(await outcome).toBe(result === "failed" ? primary : undefined);
      await shutdown;
      expect(card.status).toBe(result === "failed" ? "Imported" : "Cancelled");
      expect(coordinator.hasRun("a")).toBe(false);
      expect(pipelineDeferreds.has("a")).toBe(false);
      await coordinator.resume();
      await coordinator.startOrEnqueue("a", "generate", "transcription");
      expect(coordinator.hasRun("a")).toBe(true);
    } finally {
      release();
      await Promise.allSettled([work, shutdown]);
    }
  });

  it("shutdown settles an owned run held in key lookup before executing a pipeline", async () => {
    const card = makeCard({ id: "a" });
    const { coordinator, resolveApiKey, persistState } = harness([card]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    resolveApiKey.mockImplementationOnce(async () => { await held; return "test key"; });
    await coordinator.startOrEnqueue("a", "generate", "transcription");
    const shutdown = coordinator.shutdown();
    let settled = false;
    void shutdown.then(() => { settled = true; });
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      await shutdown;
      expect(card).toMatchObject({ status: "Cancelled", activeStep: null, lastError: null });
      expect(persistState).toHaveBeenCalledTimes(2);
      expect(pipelineDeferreds.has("a")).toBe(false);
    } finally {
      release();
      await shutdown;
    }
  });

  it("resuming before an old prestart settles cannot revive that stopped claim", async () => {
    const card = makeCard({ id: "a" });
    const { coordinator, persistState } = harness([card]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    persistState.mockImplementationOnce(async () => held);
    const work = coordinator.startOrEnqueue("a", "generate", "transcription");
    const shutdown = coordinator.shutdown();
    try {
      await coordinator.resume();
      release();
      await Promise.all([work, shutdown]);
      expect(card.status).toBe("Cancelled");
      expect(pipelineDeferreds.has("a")).toBe(false);
      await coordinator.startOrEnqueue("a", "generate", "transcription");
      expect(coordinator.hasRun("a")).toBe(true);
    } finally {
      release();
      await Promise.allSettled([work, shutdown]);
    }
  });

  it("shutdown releases a stopped prestart even when saving Cancelled fails", async () => {
    const card = makeCard({ id: "a" });
    const { coordinator, persistState } = harness([card]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const primary = new Error("cancel save failed");
    persistState.mockImplementationOnce(async () => held).mockRejectedValueOnce(primary);
    const work = coordinator.startOrEnqueue("a", "generate", "transcription");
    const outcome = work.catch((error: unknown) => error);
    const shutdown = coordinator.shutdown();
    try {
      release();
      expect(await outcome).toBe(primary);
      await shutdown;
      expect(card.status).toBe("Cancelled");
      expect(pipelineDeferreds.has("a")).toBe(false);
      await coordinator.resume();
      await coordinator.startOrEnqueue("a", "generate", "transcription");
      expect(coordinator.hasRun("a")).toBe(true);
    } finally {
      release();
      await Promise.allSettled([work, shutdown]);
    }
  });

  it("waits for pipeline finalization before shutdown settles", async () => {
    const first = makeCard({ id: "a" });
    const second = makeCard({ id: "b" });
    const { coordinator } = harness([first, second], 1);
    await coordinator.startOrEnqueue("a", "generate", "transcription");
    await coordinator.startOrEnqueue("b", "generate", "transcription");
    const lifecycle = coordinator as unknown as {
      finalizeCardPipeline(cardId: string, run: unknown): Promise<void>;
    };
    const finalize = lifecycle.finalizeCardPipeline;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const finalizer = vi.spyOn(lifecycle, "finalizeCardPipeline").mockImplementation(async (...args) => {
      enter();
      await held;
      await finalize.apply(coordinator, args);
    });
    const shutdown = coordinator.shutdown();
    let settled = false;
    void shutdown.then(() => { settled = true; });
    try {
      await entered;
      expect(settled).toBe(false);
      release();
      await shutdown;
      expect(coordinator.hasRun("a")).toBe(false);
      expect(coordinator.hasRun("b")).toBe(false);
      expect(second.status).toBe("Queued");
    } finally {
      release();
      await shutdown;
      finalizer.mockRestore();
    }
  });

  it("stops the drain from admitting queued cards", async () => {
    const first = makeCard({ id: "a" });
    const second = makeCard({ id: "b" });
    const { coordinator } = harness([first, second], 1);

    await coordinator.startOrEnqueue("a", "generate", "transcription");
    await coordinator.startOrEnqueue("b", "generate", "transcription");

    // Shutdown aborts "a"; settle its stubbed pipeline so shutdown's await of
    // in-flight chains completes. The queued "b" must stay queued.
    const shutdown = coordinator.shutdown();
    await settle("a");
    await shutdown;

    expect(coordinator.hasRun("b")).toBe(false);
    expect(second.status).toBe("Queued");
  });
});
