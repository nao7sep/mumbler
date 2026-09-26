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

// The audio stage is replaced too, so a transcription run needs no ffmpeg: the
// prepared audio is the source file itself.
const { mockAnalyzeTrim } = vi.hoisted(() => ({ mockAnalyzeTrim: vi.fn() }));
vi.mock("@main/core/audio-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@main/core/audio-tools")>();
  return {
    ...actual,
    analyzeTrimDecision: mockAnalyzeTrim,
    prepareAudioForTranscription: async (params: { sourceFilePath: string }) => ({
      filePath: params.sourceFilePath,
      mimeType: "audio/mp4",
      wasDerived: false,
      cleanup: async () => undefined,
    }),
  };
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    transcribedTrim: null,
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
    transcriptsDir: "/tmp/.mumbler/transcripts",
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
  it("saves the queue only for real changes when the trim was already analyzed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mumbler-run-"));
    try {
      const source = join(dir, "rec.m4a");
      await writeFile(source, "audio");
      mockTranscribe.mockResolvedValue({ text: "words", modelVersion: "m", usageMetadata: null, transport: "inline" });
      mockGenerateText.mockResolvedValue({ text: "result", modelVersion: "m", usageMetadata: null });
      const analyzed = { kind: "not-needed" } as unknown as NonNullable<MumblerCard["trimDecision"]>;
      mockAnalyzeTrim.mockResolvedValue(analyzed);

      const fresh = makeCard({ sourceFilePath: source });
      const freshCtx = makeContext(fresh, new AbortController().signal);
      await executeCardPipeline(fresh.id, "transcription", "generate", freshCtx);

      expect(fresh.transcribedTrim, "the transcription records the trim it was made from").toEqual(fresh.trim);

      const known = makeCard({ sourceFilePath: source, trimDecision: analyzed });
      const knownCtx = makeContext(known, new AbortController().signal);
      await executeCardPipeline(known.id, "transcription", "generate", knownCtx);

      expect(known.status).toBe("Ready to Save");
      expect(mockAnalyzeTrim, "only the card without a decision is analyzed").toHaveBeenCalledOnce();
      // Analyzing the trim is one real change the fresh card saves; the known card
      // has nothing new to save there, so it saves once less.
      expect(vi.mocked(knownCtx.persistState).mock.calls.length).toBe(
        vi.mocked(freshCtx.persistState).mock.calls.length - 1,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });


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
