// The application runtime end to end with nothing substituted but Electron's
// window, dialog, and shell glue: the managed ffmpeg and ffprobe, acquired
// through the runtime's own tool manager, and the real Gemini API. Run only by
// npm run test:full, through vitest.live.config.ts.
//
// The tools are acquired into a cache that persists between runs and follow the
// app's own rule: install what is missing, and update only when the upstream
// check finds a newer build. Each test copies corpus audio into its own
// throwaway home, where the cached tools are hard-linked.

import { execFile } from "node:child_process";
import { copyFile, link, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { defaultModelFor } from "@shared/ai-models";
import type { MumblerCard } from "@shared/app-shell";
import type { LogRecordDetail, ProviderCallRecordDetail } from "@shared/records";

vi.mock("electron", () => ({
  app: {
    getName: () => "Mumbler Live Test",
    getVersion: () => "0.0.0-live",
    getPath: () => "/tmp",
    isPackaged: false,
  },
  BrowserWindow: class {},
  dialog: {},
  shell: {},
}));

const { ApplicationRuntime } = await import("@main/core/app-runtime");
const { closeBackupStore } = await import("@main/core/backupStore");
const { INLINE_AUDIO_LIMIT_BYTES } = await import("@main/core/gemini-adapter");
const { sanitizeSlug } = await import("@main/core/card-pipeline");
const { isSupportedAudioImportName } = await import("@shared/audio-import");

type Runtime = Awaited<ReturnType<typeof ApplicationRuntime.initialize>>;

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const CACHE = join(REPO, "node_modules", ".cache", "mumbler-live");
const TOOL_HOME = join(CACHE, "tools");
const CORPUS = join(REPO, "..", "company", "assets", "test-fixtures");
const TIMESTAMP = "2026-01-01 09:00:00";
const MINIMUM_RECALL = 0.9;
const GENERATION_TIMEOUT_MS = 10 * 60_000;
const execFileAsync = promisify(execFile);

interface ManifestEntry {
  path: string;
  probe?: { format?: { duration?: string } };
}

function corpusFile(relative: string): string {
  return join(CORPUS, relative);
}

async function manifest(): Promise<ManifestEntry[]> {
  const raw = await readFile(corpusFile("manifest.json"), "utf8").catch(() => {
    throw new Error(
      `The live lane reads the shared test-fixture corpus at ${CORPUS}; check out the company repository beside this one.`,
    );
  });
  return (JSON.parse(raw) as { fixtures: ManifestEntry[] }).fixtures;
}

function requireKey(name: string): void {
  if (!process.env[name]?.trim()) {
    throw new Error(`${name} is not set. The full run calls the real Gemini API; export ${name} and run it again.`);
  }
}

/** Opens the runtime on `home`, runs `body`, and shuts everything down again. */
async function withRuntime<T>(home: string, body: (runtime: Runtime) => Promise<T>): Promise<T> {
  process.env.MUMBLER_DATA_DIR = home;
  const runtime = await ApplicationRuntime.initialize();
  let result: T;
  try {
    result = await body(runtime);
  } finally {
    await runtime.shutdown();
    await closeBackupStore();
  }
  expect(await openAfterClosing(), "no child process outlives the runtime").not.toContain("ProcessWrap");
  return result;
}

/**
 * The process's open resources once pending closes finish: an exited child
 * releases its handle a turn of the event loop after its exit callback, so a
 * handle still open after two seconds really outlived its owner.
 */
async function openAfterClosing(): Promise<string[]> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const open = process.getActiveResourcesInfo();
    if (!open.includes("ProcessWrap") || Date.now() > deadline) return open;
    await delay(20);
  }
}

/** A throwaway home whose managed tools are the cached ones. */
async function freshHome(label: string): Promise<string> {
  const home = await mkdtemp(join(CACHE, `${label}-`));
  const bin = join(home, "bin");
  await mkdir(bin);
  for (const entry of await readdir(join(TOOL_HOME, "bin"), { withFileTypes: true })) {
    if (entry.isFile()) await link(join(TOOL_HOME, "bin", entry.name), join(bin, entry.name));
  }
  return home;
}

async function importAudio(runtime: Runtime, home: string, relatives: string[]): Promise<MumblerCard[]> {
  const sources = join(home, "sources");
  await mkdir(sources, { recursive: true });
  const copies: string[] = [];
  for (const relative of relatives) {
    const copy = join(sources, basename(relative));
    await copyFile(corpusFile(relative), copy);
    copies.push(copy);
  }
  return importFiles(runtime, copies);
}

async function importFiles(runtime: Runtime, files: string[]): Promise<MumblerCard[]> {
  const imported = await runtime.importDroppedPaths(files);
  expect(imported.failedImports).toEqual([]);
  const pending = runtime.getSnapshot().state!.pendingImports;
  await runtime.confirmPendingImports(
    pending.map((item) => ({ ...item, localTimestampText: TIMESTAMP, timezone: "UTC" })),
  );
  return runtime.getSnapshot().state!.cards;
}

async function settled(runtime: Runtime, cardId: string): Promise<MumblerCard> {
  const deadline = Date.now() + GENERATION_TIMEOUT_MS;
  for (;;) {
    const card = runtime.getSnapshot().state!.cards.find((entry) => entry.id === cardId)!;
    if (card.status === "Ready to Save" || card.status === "Error" || card.status === "Cancelled") return card;
    if (Date.now() > deadline) {
      await runtime.cancelCardProcessing(cardId);
      throw new Error(`The card was still ${card.status} after ${GENERATION_TIMEOUT_MS} ms.`);
    }
    await delay(500);
  }
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replaceAll("\u2019", "'")
    .split(/[^\p{L}\p{N}']+/u)
    .filter((word) => word.length > 0);
}

/** The share of `expected` words the transcript contains, each counted once. */
function recall(expected: string[], transcript: string[]): number {
  const available = new Map<string, number>();
  for (const word of transcript) available.set(word, (available.get(word) ?? 0) + 1);
  const found = expected.filter((word) => {
    const count = available.get(word) ?? 0;
    if (count === 0) return false;
    available.set(word, count - 1);
    return true;
  }).length;
  return found / expected.length;
}

let toolCheckFailure: string | null = null;

beforeAll(async () => {
  await mkdir(TOOL_HOME, { recursive: true });
  await withRuntime(TOOL_HOME, async (runtime) => {
    const tools = () => runtime.getSnapshot().dependencies!;
    for (const tool of tools().filter((entry) => entry.state === "not-installed")) {
      await runtime.provisionTool(tool.name);
    }
    // Opening the runtime may start the launch check in the background; the
    // explicit check below would be refused while it runs.
    const deadline = Date.now() + 2 * 60_000;
    while (tools().some((tool) => tool.transient.kind === "running" && tool.transient.operation === "check")) {
      if (Date.now() > deadline) throw new Error("The launch check was still running after two minutes.");
      await delay(100);
    }
    await runtime.checkTools();
    for (const tool of tools()) {
      if (tool.transient.kind === "failed") toolCheckFailure = JSON.stringify(tool.transient);
    }
    for (const tool of tools().filter((entry) => entry.state === "update-available")) {
      await runtime.provisionTool(tool.name);
    }
  });
});

describe("the live application runtime", () => {
  it("has its managed audio tools installed, verified, and current", async () => {
    expect(toolCheckFailure, "the upstream update check must succeed").toBeNull();
    await withRuntime(TOOL_HOME, async (runtime) => {
      for (const tool of runtime.getSnapshot().dependencies!) {
        expect(tool.installedVersion, `${tool.name} reports its version`).not.toBeNull();
        expect(tool.state, `${tool.name}`).toBe("up-to-date");
      }
    });
  });

  it("imports every accepted corpus audio format at its recorded duration", async () => {
    const audio = (await manifest()).filter(
      (entry) => entry.path.startsWith("audio/") && isSupportedAudioImportName(basename(entry.path)),
    );
    const home = await freshHome("import");
    try {
      await withRuntime(home, async (runtime) => {
        const cards = await importAudio(runtime, home, audio.map((entry) => entry.path));
        expect(cards).toHaveLength(audio.length);
        for (const entry of audio) {
          const card = cards.find((candidate) => candidate.originalFilename === basename(entry.path));
          expect(card?.audioProfile, `${entry.path} is probed`).not.toBeNull();
          const recorded = Number(entry.probe?.format?.duration);
          expect(Math.abs((card?.durationSec ?? Number.NaN) - recorded), entry.path).toBeLessThan(0.1);
        }
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("transcribes, describes, and saves English dialogue through the real Gemini API", async () => {
    requireKey("GEMINI_API_KEY");
    const name = "dialogue-english-with-noise";
    const oracle = JSON.parse(await readFile(corpusFile(`audio/dialogue/${name}.transcript.json`), "utf8")) as {
      segments: Array<{ text: string }>;
    };
    const home = await freshHome("gemini");
    try {
      await withRuntime(home, async (runtime) => {
        const [imported] = await importAudio(runtime, home, [`audio/dialogue/${name}.flac`]);
        await runtime.generateCardStep(imported!.id, "slug");
        const card = await settled(runtime, imported!.id);
        expect(card.lastError).toBeNull();
        expect(card.status).toBe("Ready to Save");

        const transcript = card.transcription.text ?? "";
        const recalled = recall(oracle.segments.flatMap((segment) => words(segment.text)), words(transcript));
        expect(recalled, `recovered ${recalled.toFixed(2)} of the spoken words:\n${transcript}`).toBeGreaterThanOrEqual(
          MINIMUM_RECALL,
        );
        expect(card.metadata.structured?.trim()).toBeTruthy();
        expect(card.metadata.title?.trim()).toBeTruthy();
        expect(card.metadata.slug).toBeTruthy();
        expect(card.metadata.slug).toBe(sanitizeSlug(card.metadata.slug!));

        const saved = await runtime.saveCard(card.id);
        if (saved.kind !== "saved") throw new Error(`Saving ended as ${saved.kind}.`);
        for (const path of [saved.audioPath, saved.jsonPath, saved.markdownPath]) {
          expect((await stat(path)).size, path).toBeGreaterThan(0);
        }
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("transcribes a recording over the inline limit through the Files API", async () => {
    requireKey("GEMINI_API_KEY");
    const name = "dialogue-english-alternating";
    const relative = `audio/dialogue/${name}.flac`;
    const oracle = JSON.parse(await readFile(corpusFile(`audio/dialogue/${name}.transcript.json`), "utf8")) as {
      segments: Array<{ text: string }>;
    };
    const clipSec = Number((await manifest()).find((entry) => entry.path === relative)?.probe?.format?.duration);
    expect(clipSec, `${relative} has a recorded duration`).toBeGreaterThan(0);

    // With no trim markers the pipeline sends the imported file itself, so the
    // limit is measured on the recording's own bytes. Uncompressed 96 kHz
    // stereo 16-bit PCM is the densest ordinary WAV, which keeps the duration
    // Gemini bills for as short as the limit allows; the corpus speech repeats
    // just often enough to pass it, so the whole recording stays real speech.
    const bytesPerSec = 96_000 * 2 * 2;
    const copies = Math.ceil((INLINE_AUDIO_LIMIT_BYTES + 1_000) / (bytesPerSec * clipSec));
    const home = await freshHome("files-api");
    try {
      const ffmpeg = (await readdir(join(home, "bin"))).find((entry) => entry.replace(/\.exe$/, "") === "ffmpeg");
      if (ffmpeg === undefined) throw new Error(`The cached tools in ${TOOL_HOME} hold no ffmpeg.`);
      const recordings = join(home, "recordings");
      await mkdir(recordings);
      const recording = join(recordings, "recording-over-inline-limit.wav");
      await execFileAsync(join(home, "bin", ffmpeg), [
        "-hide_banner", "-loglevel", "error", "-y",
        "-stream_loop", String(copies - 1), "-i", corpusFile(relative),
        "-vn", "-ar", "96000", "-ac", "2", "-c:a", "pcm_s16le", recording,
      ]);
      const builtBytes = (await stat(recording)).size;
      expect(builtBytes, "the built recording is over the inline limit").toBeGreaterThan(INLINE_AUDIO_LIMIT_BYTES);
      expect(
        builtBytes - bytesPerSec * clipSec,
        "one repetition fewer would be under the limit, so the paid audio is as short as it can be",
      ).toBeLessThanOrEqual(INLINE_AUDIO_LIMIT_BYTES);

      await withRuntime(home, async (runtime) => {
        const [imported] = await importFiles(runtime, [recording]);
        expect(Math.abs(imported!.durationSec! - copies * clipSec), "the recording is the repeated speech").toBeLessThan(0.5);
        expect((await stat(imported!.sourceFilePath)).size, "the imported file the pipeline sends").toBeGreaterThan(
          INLINE_AUDIO_LIMIT_BYTES,
        );
        await runtime.generateCardStep(imported!.id, "transcription");
        const card = await settled(runtime, imported!.id);
        expect(card.lastError).toBeNull();
        expect(card.status).toBe("Ready to Save");

        // The Files API path, read from what the app recorded.
        const recordsFor = (kind: "log" | "provider-call") =>
          runtime.readRecordsPage({ session: null, kind, level: null, cardId: card.id, search: "", after: null });
        const calls: ProviderCallRecordDetail[] = [];
        for (const summary of (await recordsFor("provider-call")).records) {
          const detail = await runtime.readRecordDetail("provider-call", summary.id);
          if (detail?.kind === "provider-call" && detail.step === "transcription") calls.push(detail);
        }
        const upload = calls.filter((call) => call.operation === "files.upload");
        const generate = calls.filter((call) => call.operation === "models.generateContent");
        expect(upload, "one upload to the Files API").toHaveLength(1);
        expect(generate, "one transcription request").toHaveLength(1);
        expect(upload[0]!.error).toBeNull();
        expect(JSON.parse(upload[0]!.request).file, "the upload is the imported recording").toBe(imported!.sourceFilePath);
        const uploaded = JSON.parse(upload[0]!.response!) as { uri?: string };
        expect(uploaded.uri).toBeTruthy();

        const request = JSON.parse(generate[0]!.request) as {
          model: string;
          contents: Array<{ parts: Array<{ fileData?: { fileUri?: string; mimeType?: string } }> }>;
        };
        expect(generate[0]!.error).toBeNull();
        expect(generate[0]!.request, "the audio does not travel inline").not.toContain("inlineData");
        const fileParts = request.contents.flatMap((content) => content.parts.flatMap((part) => part.fileData ?? []));
        expect(fileParts.map((part) => part.fileUri)).toEqual([uploaded.uri]);
        expect(fileParts[0]!.mimeType).toBe("audio/wav");
        expect(request.model, "the shipped default transcription model").toBe(defaultModelFor("gemini", "transcription"));
        expect(generate[0]!.model).toBe(defaultModelFor("gemini", "transcription"));

        const logs: LogRecordDetail[] = [];
        for (const summary of (await recordsFor("log")).records) {
          const detail = await runtime.readRecordDetail("log", summary.id);
          if (detail?.kind === "log") logs.push(detail);
        }
        const detailsOf = (op: string) => {
          const entry = logs.find((log) => log.op === op);
          expect(entry, `${op} is recorded`).toBeDefined();
          return JSON.parse(entry!.details!) as Record<string, unknown>;
        };
        expect(detailsOf("pipeline.audio-input")).toMatchObject({
          transportCandidate: "files-api",
          wasDerived: false,
          preparedFilePath: imported!.sourceFilePath,
        });
        expect(detailsOf("pipeline.transcription-complete")).toMatchObject({ transport: "files-api" });

        // Judged by word recovery: each repetition of the dialogue is expected.
        const spoken = oracle.segments.flatMap((segment) => words(segment.text));
        const transcript = card.transcription.text ?? "";
        const recalled = recall(Array.from({ length: copies }, () => spoken).flat(), words(transcript));
        expect(recalled, `recovered ${recalled.toFixed(2)} of the spoken words:\n${transcript}`).toBeGreaterThanOrEqual(
          MINIMUM_RECALL,
        );
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("the live lane's own word recall", () => {
  it("counts each spoken word once", () => {
    const expected = words("Thank you. Thank you, please.");
    expect(recall(expected, words("thank you please"))).toBe(0.6);
    expect(recall(expected, words("Thank you. Thank you, please!"))).toBe(1);
  });
});
