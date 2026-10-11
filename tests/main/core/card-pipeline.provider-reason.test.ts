import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppPaths, MumblerCard } from "@shared/app-shell";
import type { AppLogger } from "@main/core/logger";

// The actual pipeline, adapter and SDK publish provider reasons into the actual
// queue store. Only network delivery and the native audio preparation are stubbed.
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
import { createDefaultSettings, createEmptyQueue, createQueueStore } from "@main/core/settings-schema";

const API_KEY = "fixture-key.$[exact]";
const ECHOED_REASON = `The credential ${API_KEY} was refused. Replace ${API_KEY}, then retry.`;
const MASKED_REASON = "The credential [REDACTED] was refused. Replace [REDACTED], then retry.";
const USEFUL_REASON = "This model cannot accept the input. Please use different audio.";

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
    transcription: { text: "previous transcript" },
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

const structuredError = (reason: string) => new Response(
  JSON.stringify({ error: { code: 400, message: reason, status: "INVALID_ARGUMENT" } }),
  { status: 400, headers: { "content-type": "application/json" } },
);
const promptRefusal = (reason: string) => new Response(
  JSON.stringify({ promptFeedback: { blockReason: "PROHIBITED_CONTENT", blockReasonMessage: reason } }),
  { headers: { "content-type": "application/json" } },
);

describe("provider reasons published by the pipeline", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mumbler-provider-reason-"));
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    { step: "transcription", response: structuredError, reason: ECHOED_REASON, expected: MASKED_REASON, refused: false, kind: "structured error" },
    { step: "structured", response: structuredError, reason: ECHOED_REASON, expected: MASKED_REASON, refused: false, kind: "structured error" },
    { step: "transcription", response: promptRefusal, reason: ECHOED_REASON, expected: MASKED_REASON, refused: true, kind: "prompt refusal" },
    { step: "structured", response: promptRefusal, reason: ECHOED_REASON, expected: MASKED_REASON, refused: true, kind: "prompt refusal" },
    { step: "structured", response: structuredError, reason: USEFUL_REASON, expected: USEFUL_REASON, refused: false, kind: "ordinary useful reason" },
  ] as const)("publishes and persists the safe $kind reason for $step", async ({ step, response, reason, expected, refused }) => {
    const source = join(dir, "rec.m4a");
    await writeFile(source, "audio");
    const card = makeCard(source);
    const state = createEmptyQueue();
    state.cards = [card];
    const queuePath = join(dir, "queue.json");
    const queue = createQueueStore(queuePath);
    const publications: string[] = [];
    const settings = createDefaultSettings();
    settings["gemini.endpoint"] = "https://proxy.example/gemini";
    settings["gemini.transcription"] = "custom";
    settings["gemini.outline"] = "custom";
    const ctx: CardPipelineContext = {
      state,
      settings,
      paths: { homeDir: dir, workingDir: join(dir, "working"), queuePath } as AppPaths,
      logger: makeLogger(),
      signal: new AbortController().signal,
      apiKey: API_KEY,
      persistState: async () => {
        await queue.save(state);
        publications.push(JSON.stringify(state));
      },
      releaseTranscriptionSlot: async () => undefined,
      ownsCard: () => true,
      trackWork: () => undefined,
    };
    fetchMock.mockResolvedValue(response(reason));

    await executeCardPipeline(card.id, step, "generate", ctx);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("x-goog-api-key")).toBe(API_KEY);
    expect(card.status).toBe("Error");
    expect(card.lastError).toMatchObject({ failedStep: step, providerReason: expected });
    expect(card.lastError?.refused === true).toBe(refused);
    expect(publications.length).toBeGreaterThan(0);
    expect(publications.at(-1)).toContain(expected);
    expect(publications.every((snapshot) => !snapshot.includes(API_KEY))).toBe(true);
    const persisted = await readFile(queuePath, "utf8");
    expect(persisted).toContain(expected);
    expect(persisted).not.toContain(API_KEY);
    const reloaded = (await createQueueStore(queuePath).load()).value;
    expect(reloaded.cards[0]?.lastError?.providerReason).toBe(expected);
  });
});
