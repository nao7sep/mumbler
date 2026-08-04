import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MumblerCard, MumblerState } from "@shared/app-shell";
import type { AppLogger } from "@main/core/logger";

// The coordinator spawns executeCardPipeline fire-and-forget; stub it with a
// per-card deferred so a test can hold a "pipeline" running and settle it when
// it chooses. Everything else in card-pipeline stays real (types only here).
const pipelineDeferreds = new Map<string, { resolve: () => void; promise: Promise<void> }>();
vi.mock("@main/core/card-pipeline", async (importOriginal) => {
  const original = await importOriginal<typeof import("@main/core/card-pipeline")>();
  return {
    ...original,
    executeCardPipeline: vi.fn(async (cardId: string) => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      pipelineDeferreds.set(cardId, { resolve, promise });
      await promise;
    }),
  };
});

const { PipelineCoordinator } = await import("@main/core/pipeline-coordinator");
const { createDefaultSettings, createEmptyState } = await import("@main/core/settings-schema");
const { OperationError } = await import("@main/core/operation-error");

const noopLogger: AppLogger = {
  debug: async () => {},
  info: async () => {},
  warn: async () => {},
  error: async () => {},
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

function harness(cards: MumblerCard[], concurrencyLimit = 1) {
  const state: MumblerState = { ...createEmptyState(), cards };
  const settings = { ...createDefaultSettings("Asia/Tokyo"), concurrencyLimit };
  const persistState = vi.fn(async () => {});
  const resolveApiKey = vi.fn(async (): Promise<string | null> => "test-key");
  const coordinator = new PipelineCoordinator(
    { state, settings, paths: null, logger: noopLogger },
    { persistState, resolveApiKey },
  );
  return { state, coordinator, persistState, resolveApiKey };
}

beforeEach(() => {
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

  it("refuses to start when no API key resolves, leaving the card untouched", async () => {
    const card = makeCard({ id: "a" });
    const { coordinator, resolveApiKey } = harness([card]);
    resolveApiKey.mockResolvedValue(null);

    await expect(coordinator.startOrEnqueue("a", "generate")).rejects.toThrow(
      "Gemini API key is not configured.",
    );
    expect(card.status).toBe("Imported");
    expect(coordinator.hasRun("a")).toBe(false);
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

describe("PipelineCoordinator.detachRun", () => {
  it("returns null for a card with no active run", () => {
    const { coordinator } = harness([makeCard({ id: "a" })]);
    expect(coordinator.detachRun("a")).toBeNull();
  });

  it("frees the slot and admits a queued card on abortAndRelease", async () => {
    const first = makeCard({ id: "a" });
    const second = makeCard({ id: "b" });
    const { coordinator } = harness([first, second], 1);

    await coordinator.startOrEnqueue("a", "generate", "transcription");
    await coordinator.startOrEnqueue("b", "generate", "transcription");

    const detached = coordinator.detachRun("a");
    expect(detached).not.toBeNull();
    expect(coordinator.hasRun("a")).toBe(false);

    await detached!.abortAndRelease();

    expect(coordinator.hasRun("b")).toBe(true);

    // The orphaned pipeline settling later must not disturb the bookkeeping the
    // replacement now owns (the finalize identity check).
    await settle("a");
    expect(coordinator.hasRun("b")).toBe(true);
  });
});

describe("PipelineCoordinator.shutdown", () => {
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
