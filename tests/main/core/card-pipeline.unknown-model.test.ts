import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppPaths, MumblerCard } from "@shared/app-shell";
import type { AppLogger } from "@main/core/logger";

// A failing transcription with a model id outside the supported list: the real
// pipeline, the real adapter and the real SDK, with only the outbound fetch and
// the ffmpeg-backed audio stage stubbed. The card must carry the provider's own
// words, not a message of Mumbler's.
vi.mock("@main/core/audio-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@main/core/audio-tools")>();
  return {
    ...actual,
    analyzeTrimDecision: async () => ({ kind: "not-needed" }),
    prepareAudioForTranscription: async (params: { sourceFilePath: string }) => ({
      filePath: params.sourceFilePath,
      mimeType: "audio/mp4",
      wasDerived: false,
      cleanup: async () => undefined,
    }),
  };
});

import { executeCardPipeline, type CardPipelineContext } from "@main/core/card-pipeline";
import { createDefaultSettings, createEmptyQueue } from "@main/core/settings-schema";

const UNKNOWN_MODEL = "gemini-9-imaginary";
const PROVIDER_TEXT = `models/${UNKNOWN_MODEL} is not found for API version v1beta, or is not supported for generateContent.`;

function makeCard(sourceFilePath: string): MumblerCard {
  return {
    id: "card-1",
    originalFilename: "rec.m4a",
    importSource: "file-picker",
    sourceFilePath,
    audioProfile: null,
    durationSec: 60,
    fileSizeBytes: 5,
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
  };
}

function makeLogger(): AppLogger {
  return {
    debug: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    providerCall: vi.fn().mockResolvedValue(undefined),
  };
}

function makeContext(card: MumblerCard, dir: string): CardPipelineContext {
  const state = createEmptyQueue();
  state.cards = [card];
  const settings = createDefaultSettings();
  settings["gemini.transcription"] = UNKNOWN_MODEL;
  return {
    state,
    settings,
    paths: { homeDir: dir, workingDir: join(dir, "working") } as AppPaths,
    logger: makeLogger(),
    signal: new AbortController().signal,
    apiKey: "fixture-key",
    persistState: vi.fn().mockResolvedValue(undefined),
    releaseTranscriptionSlot: vi.fn().mockResolvedValue(undefined),
  };
}

describe("a transcription with a model id the app does not list", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mumbler-unknown-model-"));
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it("puts the provider's own error text on the failed card, after one request that named the id", async () => {
    const source = join(dir, "rec.m4a");
    await writeFile(source, "audio");
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ error: { code: 404, message: PROVIDER_TEXT, status: "NOT_FOUND" } }),
      { status: 404, headers: { "content-type": "application/json" } },
    ));
    const card = makeCard(source);

    await executeCardPipeline(card.id, "transcription", "generate", makeContext(card, dir));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/models/${UNKNOWN_MODEL}:generateContent`);
    expect(card.status).toBe("Error");
    expect(card.lastError).toMatchObject({ failedStep: "transcription", providerReason: PROVIDER_TEXT });
  });
});
