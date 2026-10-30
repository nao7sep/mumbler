import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MumblerCard, MumblerQueue } from "@shared/app-shell";
import type { AppLogger } from "@main/core/logger";

// The coordinator starts executeCardPipeline without awaiting it; the stub
// holds each run until the test ends it or the run is aborted, and announces
// that it started, so a test waits for the start it expects.
interface StubRun { started: Promise<void>; markStarted(): void; end(): void; ended: Promise<void> }
const runs = new Map<string, StubRun[]>();
// Provider work a stubbed run hands to the coordinator, as an upload the SDK
// cannot abort is.
const untrackedWork = new Map<string, Promise<unknown>>();

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function stubRun(cardId: string, index = 0): StubRun {
  const list = runs.get(cardId) ?? [];
  runs.set(cardId, list);
  while (list.length <= index) {
    const started = deferred();
    const ended = deferred();
    list.push({ started: started.promise, markStarted: started.resolve, end: ended.resolve, ended: ended.promise });
  }
  return list[index]!;
}

const startCounts = new Map<string, number>();
vi.mock("@main/core/card-pipeline", async (importOriginal) => {
  const original = await importOriginal<typeof import("@main/core/card-pipeline")>();
  return {
    ...original,
    executeCardPipeline: vi.fn(async (cardId: string, _step, _mode, ctx: import("@main/core/card-pipeline").CardPipelineContext) => {
      const index = startCounts.get(cardId) ?? 0;
      startCounts.set(cardId, index + 1);
      const run = stubRun(cardId, index);
      const work = untrackedWork.get(cardId);
      if (work !== undefined) ctx.trackWork(work);
      run.markStarted();
      const aborted = new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await Promise.race([run.ended, aborted]);
      await ctx.settle((card) => { card.status = ctx.signal.aborted ? "Cancelled" : "Ready to Save"; card.activeStep = null; });
    }),
  };
});

const { PipelineCoordinator } = await import("@main/core/pipeline-coordinator");
const { executeCardPipeline } = await import("@main/core/card-pipeline");
const { createDefaultSettings } = await import("@main/core/settings-schema");
const { createEmptyQueue } = await import("@main/core/queue-store");
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

// The coordinator with the runtime's queue owner reduced to its one rule:
// commands run one at a time, in order.
function harness(cards: MumblerCard[], concurrencyLimit = 1) {
  const state: MumblerQueue = { ...createEmptyQueue(), cards };
  const settings = { ...createDefaultSettings(), concurrencyLimit };
  const persistState = vi.fn(async () => {});
  const resolveApiKey = vi.fn(async (): Promise<string | null> => "test-key");
  let tail: Promise<void> = Promise.resolve();
  const command = <T,>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
  const coordinator = new PipelineCoordinator(
    { state, settings, paths: null, logger: noopLogger },
    { persistCards: persistState, resolveApiKey, command },
  );
  const card = (id: string): MumblerCard => state.cards.find((entry) => entry.id === id)!;
  const start = (id: string, step: "transcription" | "structured" | "title" | "slug" = "transcription") =>
    command(() => coordinator.startOrEnqueue(id, "generate", step));
  return { state, settings, coordinator, persistState, resolveApiKey, command, card, start };
}

beforeEach(() => {
  runs.clear();
  startCounts.clear();
  untrackedWork.clear();
  vi.mocked(executeCardPipeline).mockClear();
});

describe("PipelineCoordinator", () => {
  it("runs up to Concurrent transcriptions and queues the rest, metadata-only starts included", async () => {
    const h = harness([makeCard({ id: "a" }), makeCard({ id: "b" }), makeCard({ id: "c" })], 2);
    await h.start("a");
    await h.start("b", "title");
    await h.start("c", "structured");

    expect([h.card("a").status, h.card("b").status, h.card("c").status]).toEqual(["Transcribing", "Generating Metadata", "Queued"]);
    expect(h.card("c").activeStep, "a queued card keeps the step it starts from").toBe("structured");
    expect(executeCardPipeline).toHaveBeenCalledTimes(2);
  });

  it("saves a start's status before its run exists, and a failed save starts nothing and restores the card", async () => {
    const h = harness([makeCard({ id: "a", status: "Error" })]);
    const failure = new Error("disk full");
    h.persistState.mockRejectedValueOnce(failure);

    await expect(h.start("a")).rejects.toBe(failure);

    expect(h.card("a").status).toBe("Error");
    expect(h.card("a").activeStep).toBeNull();
    expect(executeCardPipeline).not.toHaveBeenCalled();
    expect(h.coordinator.hasRun("a")).toBe(false);
  });

  it("keeps a run's place through its outline, title and slug, then starts the earliest queued card", async () => {
    const h = harness([makeCard({ id: "a" }), makeCard({ id: "late" }), makeCard({ id: "early" })]);
    await h.start("a", "structured");
    await h.command(() => h.coordinator.startOrEnqueue("early", "generate", "transcription"));
    h.card("early").queuedAtUtc = 1;
    await h.start("late");
    h.card("late").queuedAtUtc = 2;

    stubRun("a").end();
    await stubRun("early").started;

    expect(h.card("early").status).toBe("Transcribing");
    expect(h.card("late").status).toBe("Queued");
    expect(h.card("a").status).toBe("Ready to Save");
  });

  it("leaves queued cards queued when saving their start fails", async () => {
    const h = harness([makeCard({ id: "b", status: "Queued", activeStep: "transcription", queuedMode: "generate", queuedAtUtc: 1 })]);
    h.persistState.mockRejectedValueOnce(new Error("disk full"));

    await h.command(() => h.coordinator.drainQueued());

    expect(h.card("b")).toMatchObject({ status: "Queued", queuedMode: "generate", queuedAtUtc: 1 });
    expect(executeCardPipeline).not.toHaveBeenCalled();
    await h.command(() => h.coordinator.drainQueued());
    await stubRun("b").started;
    expect(h.card("b").status).toBe("Transcribing");
  });

  it("refuses a busy card and a missing one", async () => {
    const h = harness([makeCard({ id: "a", status: "Saving" })]);
    await expect(h.start("a")).rejects.toThrow(OperationError);
    await expect(h.start("missing")).rejects.toThrow("does not exist");
  });

  it("detaches a cancelled run at once, keeping its place until its upload settles", async () => {
    const upload = deferred();
    untrackedWork.set("a", upload.promise);
    const h = harness([makeCard({ id: "a" }), makeCard({ id: "b" })]);
    await h.start("a");
    await stubRun("a").started;

    expect(h.coordinator.detachAndAbort("a")).toBe(true);
    h.card("a").status = "Cancelled";
    expect(h.coordinator.hasRun("a")).toBe(false);
    await h.start("a");
    expect(h.card("a").status, "the upload still holds the only place").toBe("Queued");
    expect(h.card("a").activeStep).toBe("transcription");

    upload.resolve();
    await stubRun("a", 1).started;
    expect(h.card("a").status).toBe("Transcribing");
  });

  it("drops what a detached run reports", async () => {
    const h = harness([makeCard({ id: "a" })]);
    await h.start("a");
    await stubRun("a").started;
    h.coordinator.detachAndAbort("a");
    h.card("a").status = "Cancelled";
    await h.command(async () => undefined);
    await h.command(async () => undefined);
    expect(h.card("a").status).toBe("Cancelled");
  });

  it("stops every run at quit, admits nothing more, and starts queued cards again on resume", async () => {
    const h = harness([makeCard({ id: "a" }), makeCard({ id: "b" })]);
    await h.start("a");
    await h.start("b");
    await stubRun("a").started;

    const stopped = await h.command(async () => h.coordinator.stop());
    await stopped.settled;
    expect(h.card("a").status).toBe("Cancelled");
    expect(h.card("b").status, "a queued card stays queued for the next launch").toBe("Queued");
    await expect(h.start("a")).rejects.toThrow("closing");

    await h.command(() => h.coordinator.resume());
    await stubRun("b").started;
    expect(h.card("b").status).toBe("Transcribing");
  });
});
