import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MumblerCard, MumblerState } from "@shared/app-shell";
import { CorruptStateError } from "@main/core/json-store";
import {
  createSettingsStore,
  createStateStore,
  recoverInterruptedCards,
} from "@main/core/settings-schema";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mumbler-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function statePath(): string {
  return join(dir, "state.json");
}

function settingsPath(): string {
  return join(dir, "settings.json");
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

function stateWith(cards: MumblerCard[]): MumblerState {
  return {
    schemaVersion: 1,
    pendingImports: [],
    cards,
    selectedCardId: cards[0]?.id ?? null,
    updatedAtUtc: 0,
  };
}

describe("state store", () => {
  it("returns an empty state in memory when no file exists, without writing it", async () => {
    const store = createStateStore(statePath());
    const { value, origin } = await store.load();
    expect(origin).toBe("created");
    expect(value.cards).toEqual([]);
    // load() is non-destructive: it must not have created the file.
    await expect(readFile(statePath(), "utf8")).rejects.toThrow();
  });

  it("normalizes a present state file on load", async () => {
    await writeFile(statePath(), JSON.stringify(stateWith([card({ id: "x" })])), "utf8");
    const { value, origin } = await createStateStore(statePath()).load();
    expect(origin).toBe("loaded");
    expect(value.cards.map((c) => c.id)).toEqual(["x"]);
  });

  it("writes UTC instants as canonical ISO strings and reads epoch-ms back", async () => {
    const store = createStateStore(statePath());
    await store.save(stateWith([card({ id: "x" })]));

    // On disk: every *Utc instant is the canonical exactly-3-digit Z form.
    const raw = JSON.parse(await readFile(statePath(), "utf8"));
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    expect(raw.cards[0].createdAtUtc).toMatch(ISO);
    expect(raw.cards[0].updatedAtUtc).toMatch(ISO);
    expect(raw.cards[0].timestamps.confirmedUtc).toMatch(ISO);
    expect(raw.cards[0].timestamps.effectiveUtc).toMatch(ISO);
    // Non-instant fields pass through untouched.
    expect(raw.cards[0].timestamps.confirmedLocal).toBe("2026-04-22 09:44:00");
    expect(raw.cards[0].queuedAtUtc).toBeNull();

    // Round-trips back to epoch-ms numbers in memory.
    const { value } = await store.load();
    expect(typeof value.cards[0].createdAtUtc).toBe("number");
    expect(value.cards[0].createdAtUtc).toBe(Date.UTC(2026, 3, 22, 0, 0, 0));
    expect(value.cards[0].timestamps.confirmedUtc).toBe(Date.UTC(2026, 3, 22, 0, 44, 0));
  });

  it("loads a legacy epoch-ms state.json and rewrites it as ISO on save", async () => {
    // Legacy on-disk shape: numeric *Utc fields.
    await writeFile(statePath(), JSON.stringify(stateWith([card({ id: "old" })])), "utf8");
    const store = createStateStore(statePath());

    const { value, origin } = await store.load();
    expect(origin).toBe("loaded");
    expect(value.cards[0].createdAtUtc).toBe(Date.UTC(2026, 3, 22, 0, 0, 0));

    // Saving canonicalizes the file to ISO without changing the instant.
    await store.save(value);
    const raw = JSON.parse(await readFile(statePath(), "utf8"));
    expect(raw.cards[0].createdAtUtc).toBe("2026-04-22T00:00:00.000Z");
  });

  it("refuses (does not overwrite) a state file from a newer schema version", async () => {
    const newer = JSON.stringify({ ...stateWith([card()]), schemaVersion: 99 });
    await writeFile(statePath(), newer, "utf8");
    await expect(createStateStore(statePath()).load()).rejects.toBeInstanceOf(CorruptStateError);
    expect(await readFile(statePath(), "utf8")).toBe(newer);
  });
});

describe("settings store", () => {
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

  it("is a no-op for already-settled cards", () => {
    const { recoveredInterruptedCards } = recoverInterruptedCards(
      stateWith([card({ id: "done", status: "Ready to Save" })]),
    );
    expect(recoveredInterruptedCards).toBe(0);
  });
});
