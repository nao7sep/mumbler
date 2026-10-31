import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MumblerCard, PendingImportReviewItem } from "@shared/app-shell";
import { NewerFormatError } from "@main/core/format-versions";
import type { AppLogger } from "@main/core/logger";
import { newItemId, QueueStore, recoverInterruptedCard } from "@main/core/queue-store";
import { header } from "../../support/file-header";

// Tables are built before any test runs, so dir starts as a placeholder.
let dir = tmpdir();
let store: QueueStore;
let logger: AppLogger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mumbler-queue-store-"));
  store = new QueueStore({
    cardsDir: join(dir, "cards"),
    inboxDir: join(dir, "inbox"),
  });
  logger = {
    debug: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    providerCall: vi.fn().mockResolvedValue(undefined),
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function card(overrides: Partial<MumblerCard> = {}): MumblerCard {
  const id = overrides.id ?? "c1";
  return {
    id,
    originalFilename: "a.m4a",
    importSource: "file-picker",
    sourceFilePath: join(dir, "cards", id, "a.m4a"),
    audioProfile: null,
    durationSec: 60,
    fileSizeBytes: 1,
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
    createdAtUtc: Date.UTC(2026, 3, 22, 0, 0, 0),
    updatedAtUtc: Date.UTC(2026, 3, 22, 0, 0, 0),
    ...overrides,
  };
}

function pending(id: string, overrides: Partial<PendingImportReviewItem> = {}): PendingImportReviewItem {
  return {
    id,
    originalFilename: "a.m4a",
    importSource: "file-picker",
    originalSourcePath: "/tmp/a.m4a",
    workingFilePath: join(dir, "inbox", id, "a.m4a"),
    fileSizeBytes: 1,
    localTimestampText: "",
    timezone: "UTC",
    utcTimestampText: "",
    parseStatus: "manual-required",
    timeCandidates: [],
    deleteOriginalOnConfirm: false,
    copyToBackupOnConfirm: false,
    createdAtUtc: Date.UTC(2026, 3, 22, 0, 0, 0),
    updatedAtUtc: Date.UTC(2026, 3, 22, 0, 0, 0),
    ...overrides,
  };
}

/** A card on disk as a command leaves it: its folder, audio and file. */
async function saveCards(cards: MumblerCard[]): Promise<void> {
  for (const entry of cards) {
    await mkdir(join(dir, "cards", entry.id), { recursive: true });
    await writeFile(entry.sourceFilePath, "audio");
    await store.writeCard(entry);
  }
}

async function savePending(items: PendingImportReviewItem[]): Promise<void> {
  for (const item of items) {
    await mkdir(join(dir, "inbox", item.id), { recursive: true });
    await writeFile(item.workingFilePath, "audio");
    await store.writeImport(item);
  }
}

const cardPath = (id: string) => join(dir, "cards", id, "card.json");
const importPath = (id: string) => join(dir, "inbox", id, "import.json");

describe("the queue on disk", () => {
  it("starts empty when nothing is saved, and writes nothing", async () => {
    const loaded = await store.load(logger);
    expect(loaded.state).toEqual({ cards: [], pendingImports: [] });
    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps each whole card, text included, in its own folder, and orders the cards by effective time", async () => {
    const at = (minute: number) => ({ ...card().timestamps, effectiveUtc: Date.UTC(2026, 3, 22, 0, minute, 0) });
    const first = card({ id: "z", timestamps: at(1), transcription: { text: "every word of an hour" }, metadata: { structured: "## outline", title: "Title", slug: "title" } });
    const second = card({ id: "a", timestamps: at(2) });
    // Same effective time: the earlier-made card comes first.
    const third = card({ id: "b", timestamps: at(2), createdAtUtc: Date.UTC(2026, 3, 21) });
    await saveCards([second, first, third]);

    expect(await readdir(dir)).toEqual(["cards"]);
    const raw = JSON.parse(await readFile(cardPath("z"), "utf8"));
    expect(raw).toMatchObject({ ...header("card"), id: "z", transcription: { text: "every word of an hour" }, metadata: { structured: "## outline" } });

    const { state } = await store.load(logger);
    expect(state.cards.map((entry) => entry.id)).toEqual(["z", "b", "a"]);
    expect(state.cards[0]).toEqual(first);
  });

  it("keeps each pending import's choices in its own folder beside its copy, ordered by when it was imported", async () => {
    await savePending([pending("p2", { createdAtUtc: Date.UTC(2026, 3, 23) }), pending("p1")]);
    expect(JSON.parse(await readFile(importPath("p1"), "utf8"))).toMatchObject({ ...header("pendingImport"), id: "p1" });
    const { state } = await store.load(logger);
    expect(state.pendingImports.map((item) => item.id)).toEqual(["p1", "p2"]);
    expect(state.pendingImports[0]).toEqual(pending("p1"));
  });

  it("writes UTC instants as canonical ISO strings and reads epoch-ms back, a queued card's included", async () => {
    const queued = card({
      id: "q", status: "Queued", queuedMode: "generate", queuedAtUtc: Date.UTC(2026, 3, 22, 3, 0, 0),
      ai: { transcription: { provider: "gemini", model: "m", generatedAtUtc: Date.UTC(2026, 3, 22, 1, 0, 0) }, structured: null, title: null, slug: null },
    });
    await saveCards([queued]);

    const raw = JSON.parse(await readFile(cardPath("q"), "utf8"));
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    expect(raw.createdAtUtc).toMatch(ISO);
    expect(raw.timestamps.effectiveUtc).toMatch(ISO);
    expect(raw.ai.transcription.generatedAtUtc).toMatch(ISO);
    expect(raw.queuedAtUtc).toBe("2026-04-22T03:00:00.000Z");
    expect(raw.timestamps.confirmedLocal).toBe("2026-04-22 09:44:00");

    const [loaded] = (await store.load(logger)).state.cards;
    expect(loaded.queuedAtUtc).toBe(Date.UTC(2026, 3, 22, 3, 0, 0));
    expect(loaded.ai.transcription?.generatedAtUtc).toBe(Date.UTC(2026, 3, 22, 1, 0, 0));
  });

  it("takes a card's audio from its own folder, whatever path the file recorded", async () => {
    const saved = card({ id: "a" });
    await saveCards([saved]);
    await writeFile(cardPath("a"), JSON.stringify({ ...JSON.parse(await readFile(cardPath("a"), "utf8")), sourceFilePath: "/elsewhere/a.m4a" }));

    const [loaded] = (await store.load(logger)).state.cards;
    expect(loaded.sourceFilePath).toBe(saved.sourceFilePath);
    expect(loaded.status).toBe("Imported");
  });

  it("leaves a folder that holds no item file in place, and deletes no folder but a removed one", async () => {
    await saveCards([card({ id: "kept" })]);
    await savePending([pending("waiting")]);
    await mkdir(join(dir, "cards", "orphan"), { recursive: true });
    await writeFile(join(dir, "cards", "orphan", "a.m4a"), "audio");
    await mkdir(join(dir, "inbox", "abandoned"), { recursive: true });
    await mkdir(join(dir, "cards", ".removed-gone", "temp"), { recursive: true });
    await writeFile(join(dir, "inbox", ".removed-gone"), "not a folder");
    await mkdir(join(dir, "inbox", ".removed-went"), { recursive: true });

    const loaded = await store.load(logger);

    expect(loaded.unlistedFolders).toBe(2);
    expect(loaded.removedFolders).toBe(2);
    expect(loaded.state.cards.map((entry) => entry.id)).toEqual(["kept"]);
    expect(loaded.state.pendingImports.map((entry) => entry.id)).toEqual(["waiting"]);
    expect((await readdir(join(dir, "cards"))).sort()).toEqual(["kept", "orphan"]);
    expect((await readdir(join(dir, "inbox"))).sort()).toEqual([".removed-gone", "abandoned", "waiting"]);
    expect(await readFile(join(dir, "cards", "orphan", "a.m4a"), "utf8")).toBe("audio");
    expect(logger.warn).toHaveBeenCalledWith("startup.folder-unlisted", expect.any(String), expect.objectContaining({ path: join(dir, "cards", "orphan") }));
  });

  it("errors a card whose audio is gone and leaves an import whose copy is gone in place, writing only the card", async () => {
    await saveCards([card({ id: "intact" }), card({ id: "lost" })]);
    await savePending([pending("p-intact"), pending("p-lost")]);
    await rm(join(dir, "cards", "lost", "a.m4a"));
    await rm(join(dir, "inbox", "p-lost", "a.m4a"));
    const intactBefore = await readFile(cardPath("intact"), "utf8");
    const lostImport = await readFile(importPath("p-lost"), "utf8");

    const loaded = await store.load(logger);

    expect(loaded.missingWorkingCards).toBe(1);
    expect(loaded.unlistedFolders).toBe(1);
    expect(loaded.state.cards.find((entry) => entry.id === "lost")).toMatchObject({ status: "Error", lastError: { failedStep: "startup-recovery" } });
    expect(JSON.parse(await readFile(cardPath("lost"), "utf8")).status).toBe("Error");
    expect(await readFile(cardPath("intact"), "utf8")).toBe(intactBefore);
    expect(loaded.state.pendingImports.map((item) => item.id)).toEqual(["p-intact"]);
    expect(await readFile(importPath("p-lost"), "utf8"), "its choices stay").toBe(lostImport);
  });

  it("recovers a card a previous session left mid-step, rewriting only that card", async () => {
    await saveCards([card({ id: "run", status: "Transcribing", activeStep: "transcription" }), card({ id: "save", status: "Saving" }), card({ id: "idle" })]);
    const idleBefore = await readFile(cardPath("idle"), "utf8");

    const loaded = await store.load(logger);

    expect(loaded.recoveredInterruptedCards).toBe(1);
    expect(loaded.restoredSavingCards).toBe(1);
    expect(JSON.parse(await readFile(cardPath("run"), "utf8")).status).toBe("Error");
    expect(JSON.parse(await readFile(cardPath("save"), "utf8")).status).toBe("Ready to Save");
    expect(await readFile(cardPath("idle"), "utf8")).toBe(idleBefore);
  });

  it.each([
    ["an empty identity", { ...pending("p1"), id: "" }],
    ["an id that is not its folder's", { ...pending("p1"), id: "other" }],
    ["an invalid source identity", { ...pending("p1"), sourceIdentity: { dev: "disk", ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1 } }],
    ["a null source identity", { ...pending("p1"), sourceIdentity: null }],
    ["an unknown timestamp basis", { ...pending("p1"), timestampBasis: "unknown" }],
    ["a delete choice that is not true or false", { ...pending("p1"), deleteOriginalOnConfirm: "false" }],
  ])("reports a pending import with %s as unreadable, leaves it untouched and loads the rest", async (_name, shape) => {
    await savePending([pending("p1"), pending("p2")]);
    const text = JSON.stringify({ ...header("pendingImport"), ...shape });
    await writeFile(importPath("p1"), text);
    const loaded = await store.load(logger);
    expect(loaded.state.pendingImports.map((item) => item.id)).toEqual(["p2"]);
    expect(loaded.unreadable.map((file) => file.path)).toEqual([importPath("p1")]);
    expect(await readFile(importPath("p1"), "utf8")).toBe(text);
  });

  it.each([
    ["no format header", { format: undefined }],
    ["another owner's header", { format: { owner: "otherapp", kind: "card", version: 1 } }],
    ["another kind's header", { format: { owner: "mumbler", kind: "pendingImport", version: 1 } }],
    ["a malformed header", { format: { owner: "mumbler", kind: "card", version: "1" } }],
    ["an id that is not its folder's", { id: "other" }],
    ["a working recording path that is not text", { sourceFilePath: 3 }],
    ["an unknown status", { status: "Busy" }],
    ["a text trim marker", { trim: { frontMarkerSec: "5", backMarkerSec: null } }],
    ["a negative trim marker", { trim: { frontMarkerSec: null, backMarkerSec: -1 } }],
    ["an invalid transcribed trim", { transcribedTrim: { frontMarkerSec: "5", backMarkerSec: null } }],
    ["a transcription that is not text", { transcription: { text: 4 } }],
    ["a missing transcription", { transcription: null }],
    ["an outline that is not text", { metadata: { structured: {}, title: null, slug: null } }],
    ["a title that is not text", { metadata: { structured: null, title: 4, slug: null } }],
    ["an AI result that is not an object", { ai: { ...card().ai, title: "words" } }],
    ["an object provider reason", { lastError: { message: "failed", failedStep: "title", providerReason: { text: "unsafe" } } }],
    ["an unknown failed step", { lastError: { message: "failed", failedStep: "other" } }],
    ["an invalid refusal flag", { lastError: { message: "failed", failedStep: "title", refused: "yes" } }],
    ["text audio channels", { audioProfile: { channels: "two" } }],
    ["a negative audio sample rate", { audioProfile: { sampleRateHz: -1 } }],
    ["an unknown trim decision", { trimDecision: { kind: "unknown" } }],
    ["an object trim reason", { trimDecision: { kind: "reencode", reason: {} } }],
    ["an object AI model", { ai: { ...card().ai, title: { model: {} } } }],
    ["an object front trim offset", { timestamps: { ...card().timestamps, frontTrimOffsetSec: {} } }],
  ])("reports a card file with %s as unreadable, leaves it untouched and loads the rest", async (_name, change) => {
    await saveCards([card(), card({ id: "c2" })]);
    const text = JSON.stringify({ ...JSON.parse(await readFile(cardPath("c1"), "utf8")), ...change });
    await writeFile(cardPath("c1"), text);
    const loaded = await store.load(logger);
    expect(loaded.state.cards.map((entry) => entry.id)).toEqual(["c2"]);
    expect(loaded.unreadable.map((file) => file.path)).toEqual([cardPath("c1")]);
    expect(await readFile(cardPath("c1"), "utf8")).toBe(text);
  });

  it.each([
    ["damaged JSON", "{ not json"],
    ["a trim number that overflows", null],
    ["a newer format", JSON.stringify({ ...header("card", 99) })],
  ])("reports a card file with %s with its path, without rewriting it", async (_name, replacement) => {
    await saveCards([card()]);
    const text = replacement ?? (await readFile(cardPath("c1"), "utf8")).replace('"frontMarkerSec": null', '"frontMarkerSec": 1e400');
    await writeFile(cardPath("c1"), text);
    const loaded = await store.load(logger);
    expect(loaded.state.cards).toEqual([]);
    expect(loaded.unreadable).toEqual([{ path: cardPath("c1"), reason: expect.any(String) }]);
    expect(await readFile(cardPath("c1"), "utf8")).toBe(text);
    expect(await readFile(card().sourceFilePath, "utf8"), "its audio stays").toBe("audio");
  });

  it("retains usable nested details and absent optional error fields without rewriting", async () => {
    const saved = card({
      audioProfile: { formatName: "ogg", codecName: "opus", bitRateKbps: null, sampleRateHz: 48000, channels: 2 },
      lastError: { message: "failed", failedStep: "title", occurredAtUtc: 1234 },
      ai: { ...card().ai, title: { provider: "gemini", model: "model", generatedAtUtc: 1234 } },
    });
    await saveCards([saved]);
    const before = await readFile(cardPath("c1"), "utf8");
    const [loaded] = (await store.load(logger)).state.cards;
    expect(loaded.audioProfile).toEqual(saved.audioProfile);
    expect(loaded.lastError).toEqual(saved.lastError);
    expect(loaded.ai).toEqual(saved.ai);
    expect(await readFile(cardPath("c1"), "utf8")).toBe(before);
  });

  describe("a time the file holds unreadable", () => {
    const UPDATED = Date.UTC(2026, 3, 23, 5, 0, 0);
    const EFFECTIVE = Date.UTC(2026, 3, 22, 0, 45, 5);

    const iso = (ms: number) => new Date(ms).toISOString();
    const timestamps = { ...card().timestamps, confirmedUtc: iso(card().timestamps.confirmedUtc), effectiveUtc: iso(card().timestamps.effectiveUtc) };

    async function loadCard(raw: Record<string, unknown>, saved = false): Promise<MumblerCard> {
      if (!saved) await saveCards([card()]);
      await writeFile(cardPath("c1"), JSON.stringify({ ...JSON.parse(await readFile(cardPath("c1"), "utf8")), ...raw }));
      return (await store.load(logger)).state.cards[0];
    }

    it("takes it from the card's other recorded times, never from the moment of loading", async () => {
      const loaded = await loadCard({
        status: "Queued", queuedMode: "generate",
        createdAtUtc: "garbled",
        updatedAtUtc: new Date(UPDATED).toISOString(),
        queuedAtUtc: "garbled",
        timestamps: { ...timestamps, frontTrimOffsetSec: 65.5, confirmedUtc: null, effectiveUtc: iso(EFFECTIVE) },
        trimDecision: { kind: "stream-copy", analyzedAtUtc: "garbled" },
        ai: { transcription: { provider: "gemini", model: "m", generatedAtUtc: null }, structured: null, title: null, slug: null },
        lastError: { message: "failed", occurredAtUtc: {}, failedStep: "transcription" },
      });

      expect(loaded.createdAtUtc).toBe(UPDATED);
      expect(loaded.queuedAtUtc).toBe(UPDATED);
      expect(loaded.trimDecision?.analyzedAtUtc).toBe(UPDATED);
      expect(loaded.ai.transcription?.generatedAtUtc).toBe(UPDATED);
      expect(loaded.lastError?.occurredAtUtc).toBe(UPDATED);
      expect(loaded.timestamps.confirmedUtc).toBe(EFFECTIVE - 65_500);
      expect(loaded.timestamps.effectiveUtc).toBe(EFFECTIVE);
    });

    it("takes a missing updated time from the created time, and the effective time from the confirmed one", async () => {
      const loaded = await loadCard({ updatedAtUtc: null, timestamps: { ...timestamps, frontTrimOffsetSec: 3, effectiveUtc: "garbled" } });
      expect(loaded.updatedAtUtc).toBe(Date.UTC(2026, 3, 22, 0, 0, 0));
      expect(loaded.timestamps.effectiveUtc).toBe(Date.UTC(2026, 3, 22, 0, 44, 3));
    });

    const undated = { createdAtUtc: undefined, updatedAtUtc: undefined, timestamps: { ...timestamps, confirmedUtc: "not a time", effectiveUtc: null } };

    it("dates a card that recorded no time by its audio file's modified time", async () => {
      await saveCards([card()]);
      const modified = new Date(Date.UTC(2025, 0, 2, 3, 4, 5));
      await utimes(card().sourceFilePath, modified, modified);
      const loaded = await loadCard(undated, true);
      expect(loaded.createdAtUtc).toBe(modified.getTime());
      expect(loaded.timestamps.effectiveUtc).toBe(modified.getTime());
    });

    it("dates it by its own file when its audio file is gone too", async () => {
      await saveCards([card()]);
      await rm(card().sourceFilePath);
      await writeFile(cardPath("c1"), JSON.stringify({ ...JSON.parse(await readFile(cardPath("c1"), "utf8")), ...undated }));
      const modified = new Date(Date.UTC(2025, 5, 6, 7, 8, 9));
      await utimes(cardPath("c1"), modified, modified);

      const [loaded] = (await store.load(logger)).state.cards;
      expect(loaded.createdAtUtc).toBe(modified.getTime());
      expect(loaded.timestamps.effectiveUtc).toBe(modified.getTime());
    });

    it("takes a pending import's missing time from its other one", async () => {
      await savePending([pending("a"), pending("b")]);
      const saved = async (id: string) => JSON.parse(await readFile(importPath(id), "utf8"));
      await writeFile(importPath("a"), JSON.stringify({ ...await saved("a"), createdAtUtc: "garbled", updatedAtUtc: new Date(UPDATED).toISOString() }));
      await writeFile(importPath("b"), JSON.stringify({ ...await saved("b"), createdAtUtc: new Date(UPDATED).toISOString(), updatedAtUtc: undefined }));

      const { pendingImports } = (await store.load(logger)).state;
      expect(pendingImports.map((entry) => [entry.createdAtUtc, entry.updatedAtUtc])).toEqual([[UPDATED, UPDATED], [UPDATED, UPDATED]]);
    });
  });
});

describe("accepting, removing and retrying", () => {
  it("accepts an import by writing its card into its folder and renaming the folder into cards/ under the same id", async () => {
    const item = pending("p1");
    await savePending([item]);
    const audio = store.acceptedAudioPath(item);
    expect(audio).toBe(join(dir, "cards", "p1", "a.m4a"));

    await store.acceptImport(item, card({ id: "p1", sourceFilePath: audio }));

    expect(await readdir(join(dir, "inbox"))).toEqual([]);
    expect((await readdir(join(dir, "cards", "p1"))).sort()).toEqual(["a.m4a", "card.json"]);
    const loaded = await store.load(logger);
    expect(loaded.state.cards.map((entry) => entry.id)).toEqual(["p1"]);
    expect(loaded.state.pendingImports).toEqual([]);
  });

  it("keeps the import as it was when its folder cannot be renamed into cards/", async () => {
    const item = pending("p1");
    await savePending([item]);
    await mkdir(join(dir, "cards"));
    await chmod(join(dir, "cards"), 0o500);
    try {
      await expect(store.acceptImport(item, card({ id: "p1" }))).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(join(dir, "cards"), 0o700);
    }
    expect((await readdir(join(dir, "inbox", "p1"))).sort(), "the staged card file is gone").toEqual(["a.m4a", "import.json"]);
    expect((await store.load(logger)).state.pendingImports.map((entry) => entry.id)).toEqual(["p1"]);
  });

  it("keeps the import when a crash cut its acceptance short before the rename, and the card after it", async () => {
    await savePending([pending("before")]);
    // Before the rename: the card file is staged in the import's folder.
    await saveCards([card({ id: "before" })]);
    await rename(cardPath("before"), join(dir, "inbox", "before", "card.json"));
    await rm(join(dir, "cards", "before"), { recursive: true });
    // After the rename: the import's file is left beside the card's.
    await saveCards([card({ id: "after" })]);
    await writeFile(join(dir, "cards", "after", "import.json"), await readFile(importPath("before"), "utf8"));

    const loaded = await store.load(logger);

    expect(loaded.state.pendingImports.map((entry) => entry.id)).toEqual(["before"]);
    expect(loaded.state.cards.map((entry) => entry.id)).toEqual(["after"]);
    expect((await readdir(join(dir, "inbox", "before"))).sort()).toEqual(["a.m4a", "import.json"]);
    expect((await readdir(join(dir, "cards", "after"))).sort()).toEqual(["a.m4a", "card.json"]);
  });

  it("removes a card by renaming its folder aside, then deleting it, scratch included", async () => {
    await saveCards([card()]);
    await mkdir(join(dir, "cards", "c1", "temp"), { recursive: true });
    await writeFile(join(dir, "cards", "c1", "temp", "trim.m4a"), "scratch");
    await store.removeCard("c1");
    expect(await readdir(join(dir, "cards"))).toEqual([]);
  });

  it("keeps a card whose folder cannot be renamed aside, and reports why", async () => {
    await saveCards([card()]);
    await chmod(join(dir, "cards"), 0o500);
    try {
      await expect(store.removeCard("c1")).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(join(dir, "cards"), 0o700);
    }
    expect((await store.load(logger)).state.cards.map((entry) => entry.id)).toEqual(["c1"]);
  });

  it("leaves no damaged card when a removal is cut short after the rename or during the delete", async () => {
    await saveCards([card({ id: "renamed" }), card({ id: "halfway" }), card({ id: "kept" })]);
    // Cut short after the rename: the whole folder is aside.
    await rename(join(dir, "cards", "renamed"), join(dir, "cards", ".removed-renamed"));
    // Cut short during the delete: the card file went first, the audio stays.
    await rename(join(dir, "cards", "halfway"), join(dir, "cards", ".removed-halfway"));
    await rm(join(dir, "cards", ".removed-halfway", "card.json"));

    const loaded = await store.load(logger);

    expect(loaded.state.cards.map((entry) => entry.id)).toEqual(["kept"]);
    expect(loaded.unreadable).toEqual([]);
    expect(loaded.unlistedFolders).toBe(0);
    expect(loaded.removedFolders).toBe(2);
    expect(await readdir(join(dir, "cards"))).toEqual(["kept"]);
  });

  it("removes a pending import the same way, its copy included", async () => {
    await savePending([pending("p1")]);
    await store.removeImport("p1");
    expect(await readdir(join(dir, "inbox"))).toEqual([]);
  });

  it("writes again, from the state it is given, only the files whose latest write failed", async () => {
    await saveCards([card({ id: "a" }), card({ id: "b" })]);
    // A folder in the card file's place makes its write fail.
    await rm(cardPath("b"));
    await mkdir(cardPath("b"));
    const changed = card({ id: "b", metadata: { structured: null, title: "Later", slug: null } });
    await expect(store.writeCard(changed)).rejects.toThrow();
    await rm(cardPath("b"), { recursive: true });
    const aBefore = await readFile(cardPath("a"), "utf8");

    await store.retryFailedWrites({ cards: [card({ id: "a", metadata: { structured: null, title: "unsaved", slug: null } }), changed], pendingImports: [] });

    expect(JSON.parse(await readFile(cardPath("b"), "utf8")).metadata.title).toBe("Later");
    expect(await readFile(cardPath("a"), "utf8"), "a card whose write landed is not rewritten").toBe(aBefore);
  });

  it("sets both folders aside for Reset, and refuses one from a newer Mumbler", async () => {
    await saveCards([card()]);
    await savePending([pending("p")]);
    const moved = await store.preserveExistingFiles();
    expect(moved).toHaveLength(2);
    const [aside] = await readdir(dir);
    expect(aside).toMatch(/^queue-.*\.invalid$/);
    expect((await readdir(join(dir, aside))).sort()).toEqual(["cards", "inbox"]);

    await saveCards([card()]);
    await writeFile(cardPath("c1"), JSON.stringify({ ...header("card", 99) }));
    await expect(store.preserveExistingFiles()).rejects.toBeInstanceOf(NewerFormatError);
    expect(await readFile(cardPath("c1"), "utf8")).toBe(JSON.stringify({ ...header("card", 99) }));
  });

  it("makes ids in one case, so no two name the same folder on any filesystem", () => {
    for (let i = 0; i < 50; i++) expect(newItemId()).toMatch(/^[0-9a-z]{21}$/);
  });
});

describe("interrupted cards", () => {
  it("marks an interrupted run as an error to generate again, not as a content edit", () => {
    const { card: recovered, recovered: kind } = recoverInterruptedCard(card({ status: "Generating Metadata", activeStep: "title" }));
    expect(kind).toBe("run");
    expect(recovered).toMatchObject({ status: "Error", activeStep: null, lastError: { failedStep: "startup-recovery", message: expect.stringMatching(/interrupted/i) } });
    expect(recovered.updatedAtUtc).toBe(card().updatedAtUtc);
  });

  it("hands a card whose save was cut short back as ready to save, and leaves a settled card alone", () => {
    expect(recoverInterruptedCard(card({ status: "Saving" }))).toMatchObject({ card: { status: "Ready to Save", lastError: null }, recovered: "save" });
    expect(recoverInterruptedCard(card({ status: "Ready to Save" })).recovered).toBeNull();
  });
});
