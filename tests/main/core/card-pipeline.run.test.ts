import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppPaths, MumblerCard } from "@shared/app-shell";
import type { AppLogger } from "@main/core/logger";

// Drive the real executeCardPipeline orchestration with the Gemini call mocked,
// so the multi-step metadata chain and the cancellation path are covered without
// a network or a key. Only the two external-call functions are replaced; the rest
// of the module (retry/cancel classifiers, helpers) stays real.
const { mockGenerateText, mockTranscribe } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockTranscribe: vi.fn(),
}));

vi.mock("@main/core/gemini-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@main/core/gemini-adapter")>();
  return { ...actual, generateTextWithGemini: mockGenerateText, transcribeWithGemini: mockTranscribe };
});

import { executeCardPipeline, type CardPipelineContext } from "@main/core/card-pipeline";
import { createDefaultSettings, createEmptyState } from "@main/core/settings-schema";

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
    transcription: { text: "hello world" },
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

function makeLogger(): AppLogger {
  return {
    debug: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
  };
}

function makePaths(): AppPaths {
  return {
    homeDir: "/tmp/.mumbler",
    settingsPath: "/tmp/.mumbler/config.json",
    statePath: "/tmp/.mumbler/state.json",
    layoutPath: "/tmp/.mumbler/layout.json",
    apiKeysPath: "/tmp/.mumbler/api-keys.json",
    logsDir: "/tmp/.mumbler/logs",
    workingDir: "/tmp/.mumbler/working",
    outputDir: "/tmp/.mumbler/output",
    backupsDir: "/tmp/.mumbler/backups",
    binDir: "/tmp/.mumbler/bin",
    dependenciesPath: "/tmp/.mumbler/dependencies.json",
    tempDir: "/tmp/.mumbler/temp",
  };
}

function makeContext(card: MumblerCard, signal: AbortSignal): CardPipelineContext {
  const state = createEmptyState();
  state.cards = [card];
  state.selectedCardId = card.id;
  const settings = createDefaultSettings("Asia/Tokyo");
  // The key is now resolved by the runtime and passed in via ctx.apiKey; a
  // non-empty value is all the pipeline's key guard needs.
  return {
    state,
    settings,
    paths: makePaths(),
    logger: makeLogger(),
    signal,
    apiKey: "test-key",
    persistState: vi.fn().mockResolvedValue(undefined),
    releaseTranscriptionSlot: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeCardPipeline", () => {
  it("runs the structured -> title -> slug metadata chain and marks the card ready", async () => {
    mockGenerateText.mockResolvedValue({ text: "result", modelVersion: "m", usageMetadata: null });
    const card = makeCard();
    const ctx = makeContext(card, new AbortController().signal);

    await executeCardPipeline(card.id, "structured", "generate", ctx);

    expect(mockGenerateText).toHaveBeenCalledTimes(3);
    expect(card.metadata.structured).toBe("result");
    expect(card.metadata.title).toBe("result");
    expect(card.metadata.slug).toBe("result");
    expect(card.status).toBe("Ready to Save");
    expect(card.lastError).toBeNull();
    expect(ctx.releaseTranscriptionSlot).toHaveBeenCalledTimes(1);
  });

  it("marks the card cancelled and makes no Gemini call when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const card = makeCard();
    const ctx = makeContext(card, controller.signal);

    await executeCardPipeline(card.id, "structured", "generate", ctx);

    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(card.status).toBe("Cancelled");
    expect(ctx.releaseTranscriptionSlot).toHaveBeenCalledTimes(1);
  });

  it("records an error outcome (not a throw) when a metadata step fails unrecoverably", async () => {
    // A non-retryable error (not network/timeout/cancel) ends the run as Error.
    mockGenerateText.mockRejectedValue(new Error("Gemini returned an empty text response."));
    const card = makeCard();
    const ctx = makeContext(card, new AbortController().signal);

    await executeCardPipeline(card.id, "structured", "generate", ctx);

    expect(card.status).toBe("Error");
    expect(card.lastError?.failedStep).toBe("structured");
    expect(ctx.releaseTranscriptionSlot).toHaveBeenCalledTimes(1);
  });
});
