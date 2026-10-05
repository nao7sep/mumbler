import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MumblerCard, MumblerQueue, MumblerSettings } from "@shared/app-shell";
import { CorruptStateError } from "@main/core/json-store";
import {
  buildSettingsDraft,
  createDefaultSettings,
  createSettingsStore,
  createQueueStore,
  recoverInterruptedCards,
} from "@main/core/settings-schema";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mumbler-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function queuePath(): string {
  return join(dir, "queue.json");
}

function settings(patch: Partial<MumblerSettings> = {}): MumblerSettings {
  return { ...createDefaultSettings(), ...patch };
}

function settingsPath(): string {
  return join(dir, "config.json");
}

function card(overrides: Partial<MumblerCard> = {}): MumblerCard {
  return {
    id: "c1",
    originalFilename: "a.m4a",
    importSource: "file-picker",
    sourceFilePath: "/tmp/a.m4a",
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

function stateWith(cards: MumblerCard[]): MumblerQueue {
  return {
    schemaVersion: 2,
    pendingImports: [],
    cards,
  };
}

describe("queue data store", () => {
  it("returns an empty state in memory when no file exists, without writing it", async () => {
    const store = createQueueStore(queuePath());
    const { value, origin } = await store.load();
    expect(origin).toBe("created");
    expect(value.cards).toEqual([]);
    // load() is non-destructive: it must not have created the file.
    await expect(readFile(queuePath(), "utf8")).rejects.toThrow();
  });

  it("normalizes a present state file on load", async () => {
    await writeFile(
      queuePath(),
      JSON.stringify({ ...stateWith([card({ id: "x" })]), selectedCardId: "x" }),
      "utf8",
    );
    const { value, origin } = await createQueueStore(queuePath()).load();
    expect(origin).toBe("loaded");
    expect(value.cards.map((c) => c.id)).toEqual(["x"]);
    expect(value).not.toHaveProperty("selectedCardId");
  });

  it("keeps each card's transcription and outline out of queue.json", async () => {
    const store = createQueueStore(queuePath());
    await store.save(
      stateWith([
        card({
          id: "x",
          transcription: { text: "every word of an hour" },
          metadata: { structured: "## the outline", title: "Title", slug: "title" },
        }),
      ]),
    );

    const raw = JSON.parse(await readFile(queuePath(), "utf8"));
    expect(raw.schemaVersion).toBe(2);
    expect(raw).not.toHaveProperty("updatedAtUtc");
    expect(raw.cards[0]).not.toHaveProperty("transcription");
    expect(raw.cards[0].metadata).toEqual({ title: "Title", slug: "title" });
    const { value } = await store.load();
    expect(value.cards[0].transcription).toEqual({ text: null });
    expect(value.cards[0].metadata.structured).toBeNull();
  });

  it("still reads a version-1 file whose cards carry their text", async () => {
    const legacy = {
      schemaVersion: 1,
      updatedAtUtc: "2026-04-22T00:00:00.000Z",
      pendingImports: [],
      cards: [{ ...card({ id: "old" }), transcription: { text: "old words" }, metadata: { structured: "old outline", title: "T", slug: "t" } }],
    };
    await writeFile(queuePath(), JSON.stringify(legacy), "utf8");

    const { value } = await createQueueStore(queuePath()).load();

    expect(value.cards[0].transcription.text).toBe("old words");
    expect(value.cards[0].metadata.structured).toBe("old outline");
  });

  it("writes UTC instants as canonical ISO strings and reads epoch-ms back", async () => {
    const store = createQueueStore(queuePath());
    await store.save(
      stateWith([
        card({
          id: "x",
          ai: {
            transcription: {
              provider: "gemini",
              model: "gemini-3.1-pro-preview",
              generatedAtUtc: Date.UTC(2026, 3, 22, 1, 0, 0),
            },
            structured: null,
            title: null,
            slug: null,
          },
        }),
      ]),
    );

    // On disk: every *Utc instant is the canonical exactly-3-digit Z form,
    // including a deeply nested one the generic serializer must recurse into.
    const raw = JSON.parse(await readFile(queuePath(), "utf8"));
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    expect(raw.cards[0].createdAtUtc).toMatch(ISO);
    expect(raw.cards[0].updatedAtUtc).toMatch(ISO);
    expect(raw.cards[0].timestamps.confirmedUtc).toMatch(ISO);
    expect(raw.cards[0].timestamps.effectiveUtc).toMatch(ISO);
    expect(raw.cards[0].ai.transcription.generatedAtUtc).toMatch(ISO);
    // Non-instant fields pass through untouched; null instants stay null.
    expect(raw.cards[0].timestamps.confirmedLocal).toBe("2026-04-22 09:44:00");
    expect(raw.cards[0].ai.transcription.model).toBe("gemini-3.1-pro-preview");
    expect(raw.cards[0].queuedAtUtc).toBeNull();

    // Round-trips back to epoch-ms numbers in memory, nested fields included.
    const { value } = await store.load();
    expect(typeof value.cards[0].createdAtUtc).toBe("number");
    expect(value.cards[0].createdAtUtc).toBe(Date.UTC(2026, 3, 22, 0, 0, 0));
    expect(value.cards[0].timestamps.confirmedUtc).toBe(Date.UTC(2026, 3, 22, 0, 44, 0));
    expect(value.cards[0].ai.transcription?.generatedAtUtc).toBe(Date.UTC(2026, 3, 22, 1, 0, 0));
  });

  it("keeps a queued card resumable across an ISO save/reload (regression)", async () => {
    const store = createQueueStore(queuePath());
    await store.save(
      stateWith([
        card({
          id: "q",
          status: "Queued",
          queuedMode: "generate",
          queuedAtUtc: Date.UTC(2026, 3, 22, 3, 0, 0),
        }),
      ]),
    );

    // On disk the queue time is the canonical ISO string...
    const raw = JSON.parse(await readFile(queuePath(), "utf8"));
    expect(raw.cards[0].queuedAtUtc).toBe("2026-04-22T03:00:00.000Z");

    // ...and it must round-trip back to a usable epoch-ms number — NOT null, or
    // selectNextQueuedCard would skip the card and it would stay stuck "Queued".
    const { value } = await store.load();
    expect(value.cards[0].queuedMode).toBe("generate");
    expect(value.cards[0].queuedAtUtc).toBe(Date.UTC(2026, 3, 22, 3, 0, 0));
  });

  it("loads a legacy epoch-ms queue.json and rewrites it as ISO on save", async () => {
    // Legacy on-disk shape: numeric *Utc fields.
    await writeFile(queuePath(), JSON.stringify(stateWith([card({ id: "old" })])), "utf8");
    const store = createQueueStore(queuePath());

    const { value, origin } = await store.load();
    expect(origin).toBe("loaded");
    expect(value.cards[0].createdAtUtc).toBe(Date.UTC(2026, 3, 22, 0, 0, 0));

    // Saving canonicalizes the file to ISO without changing the instant.
    await store.save(value);
    const raw = JSON.parse(await readFile(queuePath(), "utf8"));
    expect(raw.cards[0].createdAtUtc).toBe("2026-04-22T00:00:00.000Z");
  });

  describe("a time the file holds unreadable", () => {
    const UPDATED = Date.UTC(2026, 3, 23, 5, 0, 0);
    const EFFECTIVE = Date.UTC(2026, 3, 22, 0, 45, 5);

    async function loadRaw(raw: Record<string, unknown>): Promise<MumblerQueue> {
      await writeFile(queuePath(), JSON.stringify({ schemaVersion: 2, pendingImports: [], cards: [], ...raw }), "utf8");
      return (await createQueueStore(queuePath()).load()).value;
    }

    /** A card whose every time is missing or unreadable. */
    function undatedCard(sourceFilePath: string): Record<string, unknown> {
      const { createdAtUtc: _created, updatedAtUtc: _updated, ...rest } = card({ id: "u", sourceFilePath });
      return {
        ...rest,
        timestamps: { ...rest.timestamps, confirmedUtc: "not a time", effectiveUtc: null },
      };
    }

    it("takes it from the card's other recorded times, never from the moment of loading", async () => {
      const [loaded] = (
        await loadRaw({
          cards: [
            {
              ...card({ id: "x", status: "Queued", queuedMode: "generate" }),
              createdAtUtc: "garbled",
              updatedAtUtc: new Date(UPDATED).toISOString(),
              queuedAtUtc: "garbled",
              timestamps: { ...card().timestamps, frontTrimOffsetSec: 65.5, confirmedUtc: null, effectiveUtc: EFFECTIVE },
              trimDecision: { kind: "stream-copy", analyzedAtUtc: "garbled" },
              ai: { transcription: { provider: "gemini", model: "m", generatedAtUtc: null }, structured: null, title: null, slug: null },
              lastError: { message: "failed", occurredAtUtc: {}, failedStep: "transcription" },
            },
          ],
        })
      ).cards;

      expect(loaded.createdAtUtc).toBe(UPDATED);
      expect(loaded.updatedAtUtc).toBe(UPDATED);
      expect(loaded.queuedAtUtc).toBe(UPDATED);
      expect(loaded.trimDecision?.analyzedAtUtc).toBe(UPDATED);
      expect(loaded.ai.transcription?.generatedAtUtc).toBe(UPDATED);
      expect(loaded.lastError?.occurredAtUtc).toBe(UPDATED);
      // The recording time comes back from its effective twin, less the whole
      // seconds the front trim moved it.
      expect(loaded.timestamps.confirmedUtc).toBe(EFFECTIVE - 65_000);
      expect(loaded.timestamps.effectiveUtc).toBe(EFFECTIVE);
    });

    it("takes a missing updated time from the created time, and the effective time from the confirmed one", async () => {
      const [loaded] = (
        await loadRaw({
          cards: [
            {
              ...card({ id: "x" }),
              updatedAtUtc: null,
              timestamps: { ...card().timestamps, frontTrimOffsetSec: 3, effectiveUtc: "garbled" },
            },
          ],
        })
      ).cards;

      expect(loaded.updatedAtUtc).toBe(Date.UTC(2026, 3, 22, 0, 0, 0));
      expect(loaded.timestamps.effectiveUtc).toBe(Date.UTC(2026, 3, 22, 0, 44, 3));
    });

    it("takes a pending import's missing time from its other one", async () => {
      const item = {
        id: "p",
        originalFilename: "a.m4a",
        importSource: "file-picker",
        originalSourcePath: "/tmp/a.m4a",
        workingFilePath: "/tmp/a.m4a",
        fileSizeBytes: 1,
        localTimestampText: "",
        timezone: "Asia/Tokyo",
        utcTimestampText: "",
        parseStatus: "manual-required",
        deleteOriginalOnConfirm: false,
        copyToBackupOnConfirm: false,
      };
      const { pendingImports } = await loadRaw({
        pendingImports: [
          { ...item, id: "a", createdAtUtc: "garbled", updatedAtUtc: UPDATED },
          { ...item, id: "b", createdAtUtc: UPDATED },
        ],
      });

      expect(pendingImports.map((entry) => [entry.createdAtUtc, entry.updatedAtUtc])).toEqual([
        [UPDATED, UPDATED],
        [UPDATED, UPDATED],
      ]);
    });

    it("dates a card that recorded no time by its audio file's modified time", async () => {
      const audio = join(dir, "take.wav");
      await writeFile(audio, "audio");
      const modified = new Date(Date.UTC(2025, 0, 2, 3, 4, 5));
      await utimes(audio, modified, modified);

      const [loaded] = (await loadRaw({ cards: [undatedCard(audio)] })).cards;

      expect(loaded.createdAtUtc).toBe(modified.getTime());
      expect(loaded.updatedAtUtc).toBe(modified.getTime());
      expect(loaded.timestamps.confirmedUtc).toBe(modified.getTime());
      expect(loaded.timestamps.effectiveUtc).toBe(modified.getTime());
    });

    it("dates it by the queue file that recorded it when its audio file is gone too", async () => {
      await writeFile(
        queuePath(),
        JSON.stringify({ schemaVersion: 2, pendingImports: [], cards: [undatedCard(join(dir, "gone.wav"))] }),
        "utf8",
      );
      const modified = new Date(Date.UTC(2025, 5, 6, 7, 8, 9));
      await utimes(queuePath(), modified, modified);

      const [loaded] = (await createQueueStore(queuePath()).load()).value.cards;

      expect(loaded.createdAtUtc).toBe(modified.getTime());
      expect(loaded.timestamps.effectiveUtc).toBe(modified.getTime());
    });
  });

  it("refuses (does not overwrite) a state file from a newer schema version", async () => {
    const newer = JSON.stringify({ ...stateWith([card()]), schemaVersion: 99 });
    await writeFile(queuePath(), newer, "utf8");
    await expect(createQueueStore(queuePath()).load()).rejects.toBeInstanceOf(CorruptStateError);
    expect(await readFile(queuePath(), "utf8")).toBe(newer);
  });
});

describe("settings store", () => {
  it("reads every absent set as its built-in when the file holds only one set", async () => {
    const raw = JSON.stringify({ concurrencyLimit: 5 });
    await writeFile(settingsPath(), raw, "utf8");
    const store = createSettingsStore(settingsPath());

    expect((await store.load()).value).toEqual({ ...createDefaultSettings(), concurrencyLimit: 5 });
    expect(await readFile(settingsPath(), "utf8")).toBe(raw);
  });

  it("keeps a fresh install without a file when every set saved equals its built-in", async () => {
    const store = createSettingsStore(settingsPath());
    await store.save(createDefaultSettings());

    await expect(readFile(settingsPath(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.load()).value).toEqual(createDefaultSettings());
  });

  it("keeps the file as {} when its final set is saved equal to its built-in, dropping unknown keys too", async () => {
    await writeFile(settingsPath(), JSON.stringify({
      prompts: { structured: "custom", title: "custom", slug: "custom" },
      schemaVersion: 1,
      retired: true,
    }));
    const store = createSettingsStore(settingsPath());
    await store.save(createDefaultSettings());

    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({});
    expect((await store.load()).value).toEqual(createDefaultSettings());
  });

  it("removes a set's key when it changes back to its built-in and keeps the others", async () => {
    const store = createSettingsStore(settingsPath());
    await store.save(settings({ concurrencyLimit: 5, theme: "dark" }));
    await store.save(settings({ theme: "dark" }));
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ theme: "dark" });
  });

  it("compares a model id with its built-in trimmed and case-insensitively", async () => {
    const store = createSettingsStore(settingsPath());
    await store.save(settings({ "gemini.outline": "custom-model" }));
    await store.save(settings({ "gemini.outline": ` ${createDefaultSettings()["gemini.outline"].toUpperCase()} ` }));
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({});
  });

  it("stores a role's thinking only while it differs from the default for the role's model", async () => {
    const store = createSettingsStore(settingsPath());
    const defaults = createDefaultSettings();
    await store.save({ ...defaults, "gemini.metadata": "gemini-3.8-flash", "gemini.thinking.metadata": "medium", "gemini.thinking.outline": "high" });
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ "gemini.metadata": "gemini-3.8-flash", "gemini.thinking.outline": "high" });

    // The default follows the model's tier, not the role's: a fast model on the balanced role starts at minimal.
    await store.save({ ...defaults, "gemini.outline": "gemini-3.5-flash-lite", "gemini.thinking.outline": "minimal" });
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ "gemini.outline": "gemini-3.5-flash-lite" });

    // Under a model with no row the choice is kept, unsent, while it differs from the built-in.
    await store.save({ ...defaults, "gemini.outline": "custom-model", "gemini.thinking.outline": "high" });
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ "gemini.outline": "custom-model", "gemini.thinking.outline": "high" });
    await store.save({ ...defaults, "gemini.outline": "custom-model" });
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ "gemini.outline": "custom-model" });
  });

  it("keeps a thinking saved under a model with no row through a relaunch, in the settings and the draft", async () => {
    await createSettingsStore(settingsPath()).save(settings({ "gemini.metadata": "custom-model", "gemini.thinking.metadata": "high" }));
    const loaded = (await createSettingsStore(settingsPath()).load()).value;
    expect(loaded).toEqual(settings({ "gemini.metadata": "custom-model", "gemini.thinking.metadata": "high" }));
    expect(buildSettingsDraft(loaded, "", "", false)).toMatchObject({ metadataModel: "custom-model", metadataThinking: "high" });
  });

  it("reads a thinking the file does not hold as the selected model's own default after a relaunch", async () => {
    // The outline's built-in model is Flash (medium); Flash Lite's own default is minimal, so it is not stored.
    await createSettingsStore(settingsPath()).save(settings({ "gemini.outline": "gemini-3.5-flash-lite", "gemini.thinking.outline": "minimal" }));
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ "gemini.outline": "gemini-3.5-flash-lite" });
    const loaded = (await createSettingsStore(settingsPath()).load()).value;
    expect(loaded["gemini.thinking.outline"]).toBe("minimal");
    expect(buildSettingsDraft(loaded, "", "", false)).toMatchObject({ outlineModel: "gemini-3.5-flash-lite", outlineThinking: "minimal" });
  });

  it("writes nothing when the file already holds what the settings store", async () => {
    const raw = JSON.stringify({ concurrencyLimit: 5 });
    await writeFile(settingsPath(), raw, "utf8");
    await createSettingsStore(settingsPath()).save(settings({ concurrencyLimit: 5 }));
    expect(await readFile(settingsPath(), "utf8")).toBe(raw);
  });

  it("loads no file without seeding and writes just one changed set", async () => {
    const store = createSettingsStore(settingsPath());
    expect((await store.load()).value).toEqual(createDefaultSettings());
    await expect(readFile(settingsPath(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await store.save(settings({ concurrencyLimit: 5 }));
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ concurrencyLimit: 5 });
    expect((await store.load()).value).toEqual(settings({ concurrencyLimit: 5 }));
  });

  it("accepts an old version key and drops it and other unknown keys at the next write", async () => {
    await writeFile(settingsPath(), JSON.stringify({ schemaVersion: 99, version: 99, theme: "dark", retired: true }));
    const store = createSettingsStore(settingsPath());
    const loaded = (await store.load()).value;
    expect(loaded.theme).toBe("dark");
    await store.save({ ...loaded, concurrencyLimit: 5 });
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ theme: "dark", concurrencyLimit: 5 });
  });

  it("builds the file from the settings it is given, not onto the stored bytes, one save after another", async () => {
    const store = createSettingsStore(settingsPath());
    await store.load();
    await writeFile(settingsPath(), JSON.stringify({ theme: "dark" }));
    await Promise.all([store.save(settings({ concurrencyLimit: 5 })), store.save(settings({ skipIntervalSec: 20 }))]);
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ skipIntervalSec: 20 });
  });

  it("ignores an old timestampPatterns list and drops it at the next write", async () => {
    await writeFile(settingsPath(), JSON.stringify({ timestampPatterns: ["(?<year>\\d{4})"] }));
    const store = createSettingsStore(settingsPath());
    expect((await store.load()).value).toEqual(createDefaultSettings());
    await store.save(settings({ concurrencyLimit: 5 }));
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ concurrencyLimit: 5 });
  });

  it("drops retired model-selection keys without migrating them into role sets", async () => {
    await writeFile(settingsPath(), JSON.stringify({ geminiModels: ["old"], transcriptionModel: "old", metadataModel: "old" }));
    const store = createSettingsStore(settingsPath());
    expect((await store.load()).value).toEqual(createDefaultSettings());
    await store.save(settings({ "gemini.outline": "unknown-model" }));
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ "gemini.outline": "unknown-model" });
  });
  it("ignores the retired provider and extra-model keys and drops them at the next write", async () => {
    await writeFile(settingsPath(), JSON.stringify({ provider: "gemini", extraModelIds: { gemini: ["custom"] } }));
    const store = createSettingsStore(settingsPath());
    expect((await store.load()).value).toEqual(createDefaultSettings());
    await store.save(settings({ concurrencyLimit: 5 }));
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ concurrencyLimit: 5 });
  });

  it("falls back for a malformed whole set, warns with its key, and heals at the next save", async () => {
    const warnings: string[] = [];
    await writeFile(settingsPath(), JSON.stringify({
      prompts: { structured: "custom" },
      retryPolicy: { maxRetries: 5 },
      timeouts: { transcriptionMs: 10 },
      theme: "sepia",
    }));
    const store = createSettingsStore(settingsPath(), dir, (key) => warnings.push(key));
    const loaded = (await store.load()).value;
    expect(loaded).toEqual(createDefaultSettings());
    expect(warnings).toEqual(["theme", "prompts", "retryPolicy", "timeouts"]);
    await store.save({ ...loaded, concurrencyLimit: 5 });
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ concurrencyLimit: 5 });
  });

  it.each([
    ["timestampPattern", ""],
    ["timestampPattern", "(?<year>"],
    ["gemini.endpoint", "ftp://example.test"],
    ["gemini.endpoint", "https://user:secret@example.test"],
    ["gemini.outline", "  "],
    ["prompts", { structured: "No placeholder", title: "{transcript}", slug: "{title}" }],
    ["prompts", { structured: "{transcript}", title: "No placeholder", slug: "{title}" }],
    ["prompts", { structured: "{transcript}", title: "{structured}", slug: "No placeholder" }],
    ["retryPolicy", { maxRetries: 3, initialDelayMs: 5000, maxDelayMs: 1000, jitterRatio: 0.2 }],
  ])("reads %s %j, which Save refuses, as its built-in", async (key, value) => {
    const warnings: string[] = [];
    await writeFile(settingsPath(), JSON.stringify({ [key]: value }));
    expect((await createSettingsStore(settingsPath(), dir, (warned) => warnings.push(warned)).load()).value).toEqual(createDefaultSettings());
    expect(warnings).toEqual([key]);
  });

  it("keeps complete clusters without filling members from built-ins", async () => {
    const prompts = { structured: "{transcript}", title: "{structured}", slug: "{title}", extra: "kept" };
    await writeFile(settingsPath(), JSON.stringify({ prompts }));
    expect((await createSettingsStore(settingsPath()).load()).value.prompts).toEqual(prompts);
  });

  it("normalizes out-of-range settings values on load", async () => {
    await writeFile(
      settingsPath(),
      JSON.stringify({ schemaVersion: 1, concurrencyLimit: -5, skipIntervalSec: "nope" }),
      "utf8",
    );
    const { value } = await createSettingsStore(settingsPath()).load();
    expect(value.concurrencyLimit).toBeGreaterThan(0);
    expect(value.skipIntervalSec).toBeGreaterThan(0);
  });

  it("defaults the theme to System and keeps a saved Light or Dark", async () => {
    await writeFile(settingsPath(), JSON.stringify({ schemaVersion: 1 }), "utf8");
    expect((await createSettingsStore(settingsPath()).load()).value.theme).toBe("system");

    await writeFile(settingsPath(), JSON.stringify({ schemaVersion: 1, theme: "dark" }), "utf8");
    expect((await createSettingsStore(settingsPath()).load()).value.theme).toBe("dark");

    await writeFile(settingsPath(), JSON.stringify({ schemaVersion: 1, theme: "sepia" }), "utf8");
    expect((await createSettingsStore(settingsPath()).load()).value.theme).toBe("system");
  });

  it("defaults the launch update check on when absent, and preserves an explicit off", async () => {
    await writeFile(settingsPath(), JSON.stringify({ schemaVersion: 1 }), "utf8");
    expect((await createSettingsStore(settingsPath()).load()).value.checkUpdatesAtLaunch).toBe(true);

    await writeFile(
      settingsPath(),
      JSON.stringify({ schemaVersion: 1, checkUpdatesAtLaunch: false }),
      "utf8",
    );
    expect((await createSettingsStore(settingsPath()).load()).value.checkUpdatesAtLaunch).toBe(false);
  });

  it("resolves hand-edited configured paths against HOME rather than cwd", async () => {
    const home = join(dir, "home");
    await writeFile(
      settingsPath(),
      JSON.stringify({
        schemaVersion: 1,
        outputDirectory: "~/output",
        backupDirectory: "relative/backups",
      }),
      "utf8",
    );
    const settings = (await createSettingsStore(settingsPath(), home).load()).value;
    expect(settings.outputDirectory).toBe(join(home, "output"));
    expect(settings.backupDirectory).toBe(join(home, "relative", "backups"));
  });
});

describe("recoverInterruptedCards", () => {
  it("marks in-flight cards as errored and leaves settled cards intact", () => {
    const { state, recoveredInterruptedCards } = recoverInterruptedCards(
      stateWith([
        card({ id: "busy", status: "Transcribing", activeStep: "transcription" }),
        card({ id: "meta", status: "Generating Metadata", activeStep: "title" }),
        card({ id: "done", status: "Ready to Save" }),
      ]),
    );

    expect(recoveredInterruptedCards).toBe(2);
    const busy = state.cards.find((c) => c.id === "busy")!;
    expect(busy.status).toBe("Error");
    expect(busy.activeStep).toBeNull();
    expect(busy.lastError?.failedStep).toBe("startup-recovery");
    expect(busy.lastError?.message).toMatch(/interrupted/i);
    expect(state.cards.find((c) => c.id === "meta")!.status).toBe("Error");
    expect(state.cards.find((c) => c.id === "done")!.status).toBe("Ready to Save");
  });

  it("hands a card whose save was cut short back as ready to save", () => {
    const { state, recoveredInterruptedCards, restoredSavingCards } = recoverInterruptedCards(
      stateWith([card({ id: "saving", status: "Saving" })]),
    );

    expect(restoredSavingCards).toBe(1);
    expect(recoveredInterruptedCards, "no AI work was interrupted").toBe(0);
    expect(state.cards[0]).toMatchObject({ status: "Ready to Save", lastError: null });
  });

  it("is a no-op for already-settled cards", () => {
    const { recoveredInterruptedCards } = recoverInterruptedCards(
      stateWith([card({ id: "done", status: "Ready to Save" })]),
    );
    expect(recoveredInterruptedCards).toBe(0);
  });
});
