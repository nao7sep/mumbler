import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppPaths, MumblerCard, MumblerState } from "@shared/app-shell";
import { loadSettings, loadState } from "@main/core/settings-schema";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mumbler-home-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function paths(): AppPaths {
  return {
    homeDir: home,
    settingsPath: join(home, "settings.json"),
    statePath: join(home, "state.json"),
    logsDir: join(home, "logs"),
    workingDir: join(home, "working"),
    outputDir: join(home, "output"),
    backupsDir: join(home, "backups"),
  };
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

async function writeState(state: MumblerState): Promise<void> {
  await writeFile(paths().statePath, JSON.stringify(state), "utf8");
}

describe("loadState — startup recovery", () => {
  it("creates an empty state file when none exists", async () => {
    const { state, recoveredInterruptedCards } = await loadState(paths());
    expect(state.cards).toEqual([]);
    expect(recoveredInterruptedCards).toBe(0);
    // The default state must have been persisted for the next launch.
    const persisted = JSON.parse(await readFile(paths().statePath, "utf8"));
    expect(persisted.schemaVersion).toBe(1);
  });

  it("marks interrupted in-flight cards as errored and leaves settled cards intact", async () => {
    await writeState({
      schemaVersion: 1,
      pendingImports: [],
      cards: [
        card({ id: "busy", status: "Transcribing", activeStep: "transcription" }),
        card({ id: "meta", status: "Generating Metadata", activeStep: "title" }),
        card({ id: "done", status: "Ready to Save" }),
      ],
      selectedCardId: "busy",
      updatedAtUtc: 0,
    });

    const { state, recoveredInterruptedCards } = await loadState(paths());
    expect(recoveredInterruptedCards).toBe(2);

    const busy = state.cards.find((c) => c.id === "busy")!;
    expect(busy.status).toBe("Error");
    expect(busy.activeStep).toBeNull();
    expect(busy.lastError?.failedStep).toBe("startup-recovery");
    expect(busy.lastError?.message).toMatch(/interrupted/i);

    expect(state.cards.find((c) => c.id === "meta")!.status).toBe("Error");
    expect(state.cards.find((c) => c.id === "done")!.status).toBe("Ready to Save");
  });

  it("persists the recovered state so a second load needs no recovery", async () => {
    await writeState({
      schemaVersion: 1,
      pendingImports: [],
      cards: [card({ id: "busy", status: "Transcribing", activeStep: "transcription" })],
      selectedCardId: "busy",
      updatedAtUtc: 0,
    });

    await loadState(paths());
    const second = await loadState(paths());
    expect(second.recoveredInterruptedCards).toBe(0);
    expect(second.state.cards[0].status).toBe("Error");
  });
});

describe("loadSettings", () => {
  it("writes defaults when no settings file exists", async () => {
    const settings = await loadSettings(paths());
    expect(settings.schemaVersion).toBe(1);
    expect(settings.timestampPatterns.length).toBeGreaterThan(0);
    const persisted = JSON.parse(await readFile(paths().settingsPath, "utf8"));
    expect(persisted.transcriptionModel).toBe(settings.transcriptionModel);
  });

  it("normalizes out-of-range values back to defaults on load", async () => {
    await writeFile(
      paths().settingsPath,
      JSON.stringify({ concurrencyLimit: -5, skipIntervalSec: "nope" }),
      "utf8",
    );
    const settings = await loadSettings(paths());
    expect(settings.concurrencyLimit).toBeGreaterThan(0);
    expect(settings.skipIntervalSec).toBeGreaterThan(0);
  });
});
