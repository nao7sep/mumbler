import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MumblerCard, PendingImportReviewItem } from "@shared/app-shell";
import { NewerFormatError } from "@main/core/format-versions";
import { CorruptStateError } from "@main/core/json-store";
import type { AppLogger } from "@main/core/logger";
import { newItemId, QueueStore, recoverInterruptedCard } from "@main/core/queue-store";

// Tables are built before any test runs, so dir starts as a placeholder.
let dir = tmpdir();
let store: QueueStore;
let logger: AppLogger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mumbler-queue-store-"));
  store = new QueueStore({
    queuePath: join(dir, "queue.json"),
    inboxPath: join(dir, "inbox.json"),
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

/** A card on disk as a command leaves it: its folder, audio and file, listed in the order. */
async function saveCards(cards: MumblerCard[]): Promise<void> {
  for (const entry of cards) {
    await mkdir(join(dir, "cards", entry.id), { recursive: true });
    await writeFile(entry.sourceFilePath, "audio");
    await store.writeCard(entry);
  }
  await store.writeOrder(cards);
}

async function savePending(items: PendingImportReviewItem[]): Promise<void> {
  for (const item of items) {
    await mkdir(join(dir, "inbox", item.id), { recursive: true });
    await writeFile(item.workingFilePath, "audio");
  }
  await store.writeInbox(items);
}

const cardPath = (id: string) => join(dir, "cards", id, "card.json");

describe("the queue on disk", () => {
  it("starts empty when nothing is saved, and writes nothing", async () => {
    const loaded = await store.load(logger);
    expect(loaded.state).toEqual({ cards: [], pendingImports: [] });
    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps the order in queue.json and each whole card, text included, in its own folder", async () => {
    const first = card({ id: "a", transcription: { text: "every word of an hour" }, metadata: { structured: "## outline", title: "Title", slug: "title" } });
    const second = card({ id: "b" });
    await saveCards([second, first]);

    expect(JSON.parse(await readFile(join(dir, "queue.json"), "utf8"))).toEqual({ formatVersion: 2, cardIds: ["b", "a"] });
    const raw = JSON.parse(await readFile(cardPath("a"), "utf8"));
    expect(raw).toMatchObject({ formatVersion: 1, id: "a", transcription: { text: "every word of an hour" }, metadata: { structured: "## outline" } });

    const { state } = await store.load(logger);
    expect(state.cards.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(state.cards[1]).toEqual(first);
  });

  it("keeps the pending imports in inbox.json, each copy in its own folder", async () => {
    await savePending([pending("p1"), pending("p2")]);
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

  it("removes every folder neither list names, and keeps the listed ones", async () => {
    await saveCards([card({ id: "kept" })]);
    await savePending([pending("waiting")]);
    await mkdir(join(dir, "cards", "orphan", "temp"), { recursive: true });
    await writeFile(join(dir, "cards", "orphan", "a.m4a"), "audio");
    await mkdir(join(dir, "inbox", "abandoned"), { recursive: true });

    const loaded = await store.load(logger);

    expect(loaded.removedFolders).toBe(2);
    expect(await readdir(join(dir, "cards"))).toEqual(["kept"]);
    expect(await readdir(join(dir, "inbox"))).toEqual(["waiting"]);
  });

  it("drops a pending import whose copy is gone and errors a card whose audio is gone, writing only those", async () => {
    await saveCards([card({ id: "intact" }), card({ id: "lost" })]);
    await savePending([pending("p-intact"), pending("p-lost")]);
    await rm(join(dir, "cards", "lost", "a.m4a"));
    await rm(join(dir, "inbox", "p-lost", "a.m4a"));
    const intactBefore = await readFile(cardPath("intact"), "utf8");

    const loaded = await store.load(logger);

    expect(loaded.missingWorkingCards).toBe(1);
    expect(loaded.droppedPendingImports).toBe(1);
    expect(loaded.state.cards.find((entry) => entry.id === "lost")).toMatchObject({ status: "Error", lastError: { failedStep: "startup-recovery" } });
    expect(JSON.parse(await readFile(cardPath("lost"), "utf8")).status).toBe("Error");
    expect(await readFile(cardPath("intact"), "utf8")).toBe(intactBefore);
    expect(JSON.parse(await readFile(join(dir, "inbox.json"), "utf8")).pendingImports.map((item: { id: string }) => item.id)).toEqual(["p-intact"]);
    expect(await readdir(join(dir, "inbox")), "the dropped import's empty folder goes too").toEqual(["p-intact"]);
  });

  it("drops a listed card whose file is missing and rewrites the order", async () => {
    await saveCards([card({ id: "a" }), card({ id: "b" })]);
    await rm(cardPath("b"));

    const loaded = await store.load(logger);

    expect(loaded.droppedCards).toBe(1);
    expect(loaded.state.cards.map((entry) => entry.id)).toEqual(["a"]);
    expect(JSON.parse(await readFile(join(dir, "queue.json"), "utf8")).cardIds).toEqual(["a"]);
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

  it("refuses an order from the previous layout, which held whole cards, and leaves it untouched", async () => {
    const old = JSON.stringify({ formatVersion: 1, pendingImports: [], cards: [card()] });
    await writeFile(join(dir, "queue.json"), old);
    await expect(store.load(logger)).rejects.toBeInstanceOf(CorruptStateError);
    expect(await readFile(join(dir, "queue.json"), "utf8")).toBe(old);
  });

  it.each([
    ["an order that is not a list", { cardIds: { a: 1 } }],
    ["an order naming an id twice", { cardIds: ["a", "a"] }],
    ["an order naming an id that cannot be a folder", { cardIds: ["../x"] }],
    ["an order naming a mixed-case id", { cardIds: ["Ab"] }],
  ])("refuses %s as damaged, and leaves it untouched", async (_name, shape) => {
    const text = JSON.stringify({ formatVersion: 2, ...shape });
    await writeFile(join(dir, "queue.json"), text);
    await expect(store.load(logger)).rejects.toBeInstanceOf(CorruptStateError);
    expect(await readFile(join(dir, "queue.json"), "utf8")).toBe(text);
  });

  it.each([
    ["pending imports that are not a list", { pendingImports: "none" }],
    ["an empty pending import identity", { pendingImports: [pending("")] }],
    ["duplicate pending import identities", { pendingImports: [pending("p"), pending("p")] }],
    ["an invalid source identity", { pendingImports: [{ ...pending("p"), sourceIdentity: { dev: "disk", ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1 } }] }],
    ["a null source identity", { pendingImports: [{ ...pending("p"), sourceIdentity: null }] }],
    ["an unknown timestamp basis", { pendingImports: [{ ...pending("p"), timestampBasis: "unknown" }] }],
    ["a delete choice that is not true or false", { pendingImports: [{ ...pending("p"), deleteOriginalOnConfirm: "false" }] }],
  ])("refuses an inbox with %s as damaged, and leaves it untouched", async (_name, shape) => {
    const text = JSON.stringify({ formatVersion: 1, ...shape });
    await writeFile(join(dir, "inbox.json"), text);
    await expect(store.load(logger)).rejects.toBeInstanceOf(CorruptStateError);
    expect(await readFile(join(dir, "inbox.json"), "utf8")).toBe(text);
  });

  it.each([
    ["no format version", { formatVersion: undefined }],
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
  ])("refuses a card file with %s as damaged, and leaves it untouched", async (_name, change) => {
    await saveCards([card()]);
    const text = JSON.stringify({ ...JSON.parse(await readFile(cardPath("c1"), "utf8")), ...change });
    await writeFile(cardPath("c1"), text);
    await expect(store.load(logger)).rejects.toBeInstanceOf(CorruptStateError);
    expect(await readFile(cardPath("c1"), "utf8")).toBe(text);
  });

  it("refuses a card file whose trim number overflows, without rewriting it", async () => {
    await saveCards([card()]);
    const text = (await readFile(cardPath("c1"), "utf8")).replace('"frontMarkerSec": null', '"frontMarkerSec": 1e400');
    await writeFile(cardPath("c1"), text);
    await expect(store.load(logger)).rejects.toBeInstanceOf(CorruptStateError);
    expect(await readFile(cardPath("c1"), "utf8")).toBe(text);
  });

  it.each(["queue.json", "inbox.json", "card.json"])("leaves a %s from a newer Mumbler untouched and stops", async (name) => {
    await saveCards([card()]);
    const path = name === "card.json" ? cardPath("c1") : join(dir, name);
    const newer = JSON.stringify({ formatVersion: 99 });
    await writeFile(path, newer);
    await expect(store.load(logger)).rejects.toBeInstanceOf(NewerFormatError);
    expect(await readFile(path, "utf8")).toBe(newer);
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
      const inbox = JSON.parse(await readFile(join(dir, "inbox.json"), "utf8"));
      inbox.pendingImports[0] = { ...inbox.pendingImports[0], createdAtUtc: "garbled", updatedAtUtc: new Date(UPDATED).toISOString() };
      inbox.pendingImports[1] = { ...inbox.pendingImports[1], createdAtUtc: new Date(UPDATED).toISOString(), updatedAtUtc: undefined };
      await writeFile(join(dir, "inbox.json"), JSON.stringify(inbox));

      const { pendingImports } = (await store.load(logger)).state;
      expect(pendingImports.map((entry) => [entry.createdAtUtc, entry.updatedAtUtc])).toEqual([[UPDATED, UPDATED], [UPDATED, UPDATED]]);
    });
  });
});

describe("accepting, removing and retrying", () => {
  it("moves an accepted import's folder into cards/ under the same id, and back when it could not be saved", async () => {
    const item = pending("p1");
    await savePending([item]);

    const audio = await store.acceptImport(item);
    expect(audio).toBe(join(dir, "cards", "p1", "a.m4a"));
    expect(await readFile(audio, "utf8")).toBe("audio");
    await store.writeCard(card({ id: "p1", sourceFilePath: audio }));

    await store.returnImport(item);
    expect(await readdir(join(dir, "inbox", "p1"))).toEqual(["a.m4a"]);
    expect(await readdir(join(dir, "cards"))).toEqual([]);
  });

  it("deletes a card's whole folder, its scratch included", async () => {
    await saveCards([card()]);
    await mkdir(join(dir, "cards", "c1", "temp"), { recursive: true });
    await writeFile(join(dir, "cards", "c1", "temp", "trim.m4a"), "scratch");
    await store.removeCardFolder("c1");
    expect(await readdir(join(dir, "cards"))).toEqual([]);
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

  it("sets the lists and both folders aside for Reset, and refuses one from a newer Mumbler", async () => {
    await saveCards([card()]);
    await savePending([pending("p")]);
    const moved = await store.preserveExistingFiles();
    expect(moved).toHaveLength(4);
    const [aside] = await readdir(dir);
    expect(aside).toMatch(/^queue-.*\.invalid$/);
    expect((await readdir(join(dir, aside))).sort()).toEqual(["cards", "inbox", "inbox.json", "queue.json"]);

    await saveCards([card()]);
    await writeFile(cardPath("c1"), JSON.stringify({ formatVersion: 99 }));
    await expect(store.preserveExistingFiles()).rejects.toBeInstanceOf(NewerFormatError);
    expect(await readFile(cardPath("c1"), "utf8")).toBe(JSON.stringify({ formatVersion: 99 }));
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
