// The application runtime end to end with nothing substituted but Electron's
// window, dialog, and shell glue: the managed ffmpeg and ffprobe, acquired
// through the runtime's own tool manager, and the real Gemini API. Run only by
// npm run test:full, through vitest.live.config.ts.
//
// The tools are acquired into a cache that persists between runs and follow the
// app's own rule: install what is missing, and update only when the upstream
// check finds a newer build. Each test copies corpus audio into its own
// throwaway home, where the cached tools are hard-linked.

import { copyFile, link, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it, vi } from "vitest";

import type { MumblerCard } from "@shared/app-shell";

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
  process.env.MUMBLER_HOME = home;
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
  const imported = await runtime.importDroppedPaths(copies);
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
});

describe("the live lane's own word recall", () => {
  it("counts each spoken word once", () => {
    const expected = words("Thank you. Thank you, please.");
    expect(recall(expected, words("thank you please"))).toBe(0.6);
    expect(recall(expected, words("Thank you. Thank you, please!"))).toBe(1);
  });
});
