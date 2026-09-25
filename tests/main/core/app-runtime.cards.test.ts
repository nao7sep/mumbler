import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSnapshot, MumblerCard, PendingImportReviewItem } from "@shared/app-shell";

// The card list as the user builds it: confirm what was dropped in, duplicate a
// card to trim it twice, move the markers, remove one, start over. This drives
// the real runtime against a real MUMBLER_HOME, so what is asserted is the state
// that survives on disk, not a mock's bookkeeping.
vi.mock("electron", () => ({
  app: { getName: () => "Mumbler Test", getVersion: () => "9.9.9-test", getPath: () => "/tmp", isPackaged: false },
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  dialog: {},
  shell: {},
  nativeTheme: { themeSource: "system" },
}));

// Managed ffmpeg/ffprobe are a separate boundary with their own tests; keeping
// them inert makes this a local, deterministic test of the card rules.
vi.mock("@main/core/binaries/manager", () => ({
  ToolManager: class {
    async reconcile(): Promise<void> {}
    listStatuses(): [] {
      return [];
    }
    checkIsStale(): boolean {
      return false;
    }
    resolveToolPath(name: string): string {
      return `/unused/${name}`;
    }
  },
}));

const probed = vi.hoisted(() => ({
  profile: { durationSec: 300, audioProfile: { formatName: "wav", codecName: "pcm_s16le", bitRateKbps: 1411, sampleRateHz: 44100, channels: 2 } },
}));
// A save's audio preparation can be held open, so a test can act while a save
// is still running, the way a long trim of an hour-long recording leaves it.
const audioGate = vi.hoisted(() => ({
  held: null as Promise<void> | null,
  entered: 0,
}));
// Confirming a review probes each recording; holding the probe keeps a confirm
// in flight while something else reaches the import boundary.
const probeGate = vi.hoisted(() => ({ held: null as Promise<void> | null }));
vi.mock("@main/core/audio-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@main/core/audio-tools")>();
  return {
    ...actual,
    prepareAudioForTranscription: async (params: Parameters<typeof actual.prepareAudioForTranscription>[0]) => {
      audioGate.entered += 1;
      if (audioGate.held !== null) {
        const aborted = new Promise<never>((_resolve, reject) => {
          params.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        await Promise.race([audioGate.held, aborted]);
      }
      return actual.prepareAudioForTranscription(params);
    },
    probeAudioProfile: async () => {
      if (probeGate.held !== null) await probeGate.held;
      return probed.profile;
    },
    analyzeTrimDecision: async (_path: string, trim: { frontMarkerSec: number | null; backMarkerSec: number | null }) => ({
      kind: "stream-copy" as const,
      toleranceSec: 3,
      requestedStartSec: trim.frontMarkerSec,
      requestedEndSec: trim.backMarkerSec,
      searchStartFromSec: null,
      searchStartToSec: null,
      searchEndFromSec: null,
      searchEndToSec: null,
      chosenStartBoundarySec: trim.frontMarkerSec,
      chosenEndBoundarySec: trim.backMarkerSec,
      startDeltaSec: 0,
      endDeltaSec: 0,
      reason: "Boundaries found.",
      analyzedAtUtc: Date.now(),
    }),
  };
});

const { ApplicationRuntime } = await import("@main/core/app-runtime");
const { createStateStore } = await import("@main/core/settings-schema");

type Runtime = Awaited<ReturnType<typeof ApplicationRuntime.initialize>>;

let root: string;
let home: string;
let sourceDir: string;
let previousHome: string | undefined;
let previousGeminiKey: string | undefined;
let runtime: Runtime;

/** The review the window sends back for a pending import, with edits applied. */
function review(item: PendingImportReviewItem, edits: Partial<PendingImportReviewItem> = {}): PendingImportReviewItem {
  // A dropped file rarely carries a readable time in its name, so the review
  // pane is where one is supplied; every case here starts from a valid one.
  return { ...item, localTimestampText: "2026-03-01 07:30:00", timezone: "Asia/Tokyo", ...edits };
}

function cards(snapshot: AppSnapshot): MumblerCard[] {
  return snapshot.state?.cards ?? [];
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** Drops `names` into the app and returns the pending imports awaiting review. */
async function dropIn(...names: string[]): Promise<PendingImportReviewItem[]> {
  const paths: string[] = [];
  for (const name of names) {
    const path = join(sourceDir, name);
    await writeFile(path, `audio for ${name}`);
    paths.push(path);
  }
  await runtime.importDroppedPaths(paths);
  return runtime.getSnapshot().state?.pendingImports ?? [];
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mumbler-cards-"));
  home = join(root, "profile");
  sourceDir = join(root, "sources");
  await mkdir(sourceDir, { recursive: true });
  previousHome = process.env.MUMBLER_HOME;
  process.env.MUMBLER_HOME = home;
  // A key in the developer's own environment resolves ahead of the stored one,
  // so these cases start from none; the rule itself is asserted below.
  previousGeminiKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  audioGate.held = null;
  audioGate.entered = 0;
  probeGate.held = null;
  runtime = await ApplicationRuntime.initialize();
});

afterEach(async () => {
  await runtime.shutdown();
  if (previousHome === undefined) delete process.env.MUMBLER_HOME;
  else process.env.MUMBLER_HOME = previousHome;
  if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = previousGeminiKey;
  await rm(root, { recursive: true, force: true });
});

describe("confirming what was dropped in", () => {
  it("turns each pending import into a card with the reviewed time, and selects the first", async () => {
    const [pending] = await dropIn("take.wav");

    const snapshot = await runtime.confirmPendingImports([
      review(pending, { localTimestampText: "2026-03-01 07:30:00", timezone: "Asia/Tokyo" }),
    ]);

    expect(snapshot.state?.pendingImports).toEqual([]);
    expect(cards(snapshot)).toHaveLength(1);
    const [card] = cards(snapshot);
    expect(card).toMatchObject({
      originalFilename: "take.wav",
      sourceFilePath: pending.workingFilePath,
      status: "Imported",
      durationSec: 300,
      audioProfile: { codecName: "pcm_s16le" },
    });
    expect(card.timestamps).toMatchObject({
      confirmedLocal: "2026-03-01 07:30:00",
      timezone: "Asia/Tokyo",
      effectiveLocal: "2026-03-01 07:30:00",
      frontTrimOffsetSec: 0,
    });
    expect(snapshot.queueSummary?.selectedCardId).toBe(card.id);

    const persisted = await createStateStore(join(home, "state.json")).load();
    expect(persisted.value.cards.map((entry) => entry.id)).toEqual([card.id]);
  });

  it("orders the cards by when they were recorded, not by when they were dropped in", async () => {
    const pending = await dropIn("later.wav", "earlier.wav");

    const snapshot = await runtime.confirmPendingImports([
      review(pending[0], { localTimestampText: "2026-03-02 10:00:00" }),
      review(pending[1], { localTimestampText: "2026-03-01 10:00:00" }),
    ]);

    expect(cards(snapshot).map((card) => card.originalFilename)).toEqual(["earlier.wav", "later.wav"]);
  });

  it("copies the original to the backup folder when the user asked for that", async () => {
    const [pending] = await dropIn("take.wav");

    await runtime.confirmPendingImports([review(pending, { copyToBackupOnConfirm: true })]);

    expect(await readFile(join(home, "backups", "take.wav"), "utf8")).toBe("audio for take.wav");
    expect(await exists(pending.originalSourcePath), "the original is left where it was").toBe(true);
  });

  it("deletes the original when the user asked for that", async () => {
    const [pending] = await dropIn("take.wav");

    await runtime.confirmPendingImports([review(pending, { deleteOriginalOnConfirm: true })]);

    expect(await exists(pending.originalSourcePath)).toBe(false);
    expect(await exists(pending.workingFilePath), "the app's own copy stays").toBe(true);
  });

  it("keeps the original when the backup it was told to make could not be written", async () => {
    const [pending] = await dropIn("take.wav");
    // A file where the backup directory should be: the copy cannot be made.
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), backupDirectory: join(root, "blocked") });
    await writeFile(join(root, "blocked"), "not a directory");

    await runtime.confirmPendingImports([
      review(pending, { copyToBackupOnConfirm: true, deleteOriginalOnConfirm: true }),
    ]);

    expect(await exists(pending.originalSourcePath), "nothing is thrown away unbacked").toBe(true);
    expect(cards(runtime.getSnapshot()), "the card is still made").toHaveLength(1);
  });

  it("confirms what was reviewed and leaves an import the review did not show pending", async () => {
    const pending = await dropIn("first.wav", "second.wav");

    const snapshot = await runtime.confirmPendingImports([review(pending[0])]);

    expect(cards(snapshot).map((card) => card.originalFilename)).toEqual(["first.wav"]);
    expect(snapshot.state?.pendingImports.map((item) => item.id)).toEqual([pending[1].id]);
  });

  it("keeps an import dropped in while the review is being confirmed", async () => {
    const [first] = await dropIn("first.wav");
    const laterPath = join(sourceDir, "later.wav");
    await writeFile(laterPath, "audio for later.wav");

    let release!: () => void;
    probeGate.held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const confirming = runtime.confirmPendingImports([review(first)]);
    const importing = runtime.importDroppedPaths([laterPath]);
    // Long enough for an unordered import to copy its file and land.
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await Promise.all([confirming, importing]);

    const snapshot = runtime.getSnapshot();
    expect(cards(snapshot).map((card) => card.originalFilename)).toEqual(["first.wav"]);
    expect(snapshot.state?.pendingImports.map((item) => item.originalFilename)).toEqual(["later.wav"]);
  });

  it("touches no original when one reviewed time cannot be used", async () => {
    const pending = await dropIn("first.wav", "second.wav");

    await expect(
      runtime.confirmPendingImports([
        review(pending[0], { deleteOriginalOnConfirm: true, copyToBackupOnConfirm: false }),
        review(pending[1], { timezone: "Not/AZone" }),
      ]),
    ).rejects.toThrow(/Invalid timezone/);

    expect(await exists(pending[0].originalSourcePath)).toBe(true);
    expect(runtime.getSnapshot().state?.pendingImports).toHaveLength(2);
    expect(cards(runtime.getSnapshot())).toEqual([]);
  });

  it("throws away the working copies when the review is cancelled", async () => {
    const pending = await dropIn("first.wav", "second.wav");

    const snapshot = await runtime.cancelPendingImports(pending.map((item) => item.id));

    expect(snapshot.state?.pendingImports).toEqual([]);
    for (const item of pending) expect(await exists(item.workingFilePath)).toBe(false);
    expect(await exists(pending[0].originalSourcePath), "the user's own files are untouched").toBe(true);
  });

  it("cancels only the imports the review showed", async () => {
    const [first] = await dropIn("first.wav");
    const laterPath = join(sourceDir, "later.wav");
    await writeFile(laterPath, "audio for later.wav");

    const cancelling = runtime.cancelPendingImports([first.id]);
    const importing = runtime.importDroppedPaths([laterPath]);
    await Promise.all([cancelling, importing]);

    const remaining = runtime.getSnapshot().state?.pendingImports ?? [];
    expect(remaining.map((item) => item.originalFilename)).toEqual(["later.wav"]);
    expect(await exists(remaining[0].workingFilePath)).toBe(true);
  });
});

describe("working with a card", () => {
  /** Gives a saved card the results of a finished run, and reopens the app on it. */
  async function transcribedOnDisk(cardId: string): Promise<void> {
    const run = { provider: "gemini" as const, model: "gemini-3.7-flash", generatedAtUtc: Date.now() };
    await runtime.shutdown();
    const store = createStateStore(join(home, "state.json"));
    const loaded = await store.load();
    await store.save({
      ...loaded.value,
      cards: loaded.value.cards.map((card) =>
        card.id === cardId
          ? {
              ...card,
              status: "Ready to Save" as const,
              transcription: { text: "the words from the old span" },
              metadata: { structured: "notes", title: "Old title", slug: "old-title" },
              ai: { transcription: run, structured: run, title: run, slug: run },
            }
          : card,
      ),
    });
    runtime = await ApplicationRuntime.initialize();
  }

  async function confirmed(): Promise<MumblerCard> {
    const [pending] = await dropIn("take.wav");
    const snapshot = await runtime.confirmPendingImports([review(pending)]);
    return cards(snapshot)[0];
  }

  it("holds a card that is being saved against every other change until the save ends", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    let release!: () => void;
    audioGate.held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const saving = runtime.saveCard(card.id);
    await vi.waitFor(() => expect(audioGate.entered).toBe(1));

    expect(cards(runtime.getSnapshot())[0].status).toBe("Saving");
    await expect(runtime.saveCard(card.id), "a second save").rejects.toThrow(/Ready to Save/);
    await expect(runtime.updateCardTrim(card.id, { frontMarkerSec: 1, backMarkerSec: null })).rejects.toThrow(
      /being processed/,
    );
    await expect(runtime.removeCard(card.id)).rejects.toThrow(/being processed/);
    await expect(runtime.duplicateCard(card.id)).rejects.toThrow(/being processed/);
    await runtime.setGeminiApiKey("AIza-test-key");
    await expect(runtime.generateCardStep(card.id, "title")).rejects.toThrow(/already being processed/);

    release();
    const result = await saving;

    expect(result.kind).toBe("saved");
    expect(cards(result.snapshot)).toEqual([]);
    expect(audioGate.entered, "only one save ran").toBe(1);
  });

  it("hands the card back as ready to save when a save stops at a conflict", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    const first = await runtime.duplicateCard(card.id);
    const copy = cards(first).find((entry) => entry.id !== card.id)!;
    await transcribedOnDisk(copy.id);

    expect((await runtime.saveCard(card.id)).kind).toBe("saved");
    const result = await runtime.saveCard(copy.id);

    expect(result.kind).toBe("conflict");
    expect(cards(result.snapshot)[0].status).toBe("Ready to Save");
  });

  it("selects a card, and refuses one that is gone", async () => {
    const card = await confirmed();

    expect((await runtime.selectCard(card.id)).queueSummary?.selectedCardId).toBe(card.id);
    expect((await runtime.selectCard(null)).queueSummary?.selectedCardId).toBeNull();
    await expect(runtime.selectCard("not-a-card")).rejects.toThrow(/no longer exists/);
  });

  it("duplicates a card onto its own copy of the audio, so the two trim apart", async () => {
    const card = await confirmed();

    const snapshot = await runtime.duplicateCard(card.id);

    const [, duplicate] = cards(snapshot);
    expect(cards(snapshot)).toHaveLength(2);
    expect(duplicate.sourceFilePath).not.toBe(card.sourceFilePath);
    expect(basename(duplicate.sourceFilePath)).not.toBe(basename(card.sourceFilePath));
    expect(await readFile(duplicate.sourceFilePath, "utf8")).toBe("audio for take.wav");
    expect(snapshot.queueSummary?.selectedCardId, "the copy is what the user works on next").toBe(duplicate.id);
    await expect(runtime.duplicateCard("not-a-card")).rejects.toThrow(/does not exist/);
  });

  it("keeps a duplicate made while another card's change is saved", async () => {
    const pending = await dropIn("first.wav", "second.wav");
    const [first, second] = cards(
      await runtime.confirmPendingImports(pending.map((item) => review(item))),
    );

    // The duplicate waits on a file copy; the trim on the other card saves the
    // queue in the meantime. Both changes have to survive.
    const duplicating = runtime.duplicateCard(first.id);
    const trimming = runtime.updateCardTrim(second.id, { frontMarkerSec: 1, backMarkerSec: null });
    await Promise.all([duplicating, trimming]);

    expect(cards(runtime.getSnapshot())).toHaveLength(3);
    await runtime.shutdown();
    const persisted = await createStateStore(join(home, "state.json")).load();
    expect(persisted.value.cards).toHaveLength(3);
    expect(persisted.value.cards.find((card) => card.id === second.id)?.trim.frontMarkerSec).toBe(1);
  });

  it("moves the recorded time forward by the front marker and clears what no longer applies", async () => {
    const card = await confirmed();
    // A card that has already been through the pipeline: its text and metadata
    // describe the old span, so moving a marker has to drop them.
    await transcribedOnDisk(card.id);

    const snapshot = await runtime.updateCardTrim(card.id, { frontMarkerSec: 65.5, backMarkerSec: 200 });

    const [updated] = cards(snapshot);
    expect(updated.trim).toEqual({ frontMarkerSec: 65.5, backMarkerSec: 200 });
    expect(updated.trimDecision).toMatchObject({ kind: "stream-copy", chosenStartBoundarySec: 65.5 });
    expect(updated.timestamps.frontTrimOffsetSec).toBe(65.5);
    // The instant moves by whole seconds; the tenths stay visible in the text.
    expect(updated.timestamps.effectiveUtc - updated.timestamps.confirmedUtc).toBe(65_000);
    expect(updated.timestamps.effectiveLocal).toBe("2026-03-01 07:31:05.5");
    expect(updated, "anything derived from the old span is dropped").toMatchObject({
      transcription: { text: null },
      metadata: { structured: null, title: null, slug: null },
      ai: { transcription: null, structured: null, title: null, slug: null },
      status: "Imported",
      lastError: null,
    });
  });

  it("refuses markers that fall outside the recording or cross each other", async () => {
    const card = await confirmed();

    await expect(runtime.updateCardTrim(card.id, { frontMarkerSec: -5, backMarkerSec: null })).rejects.toThrow(
      /positive numbers/,
    );
    await expect(runtime.updateCardTrim(card.id, { frontMarkerSec: null, backMarkerSec: 9_999 })).rejects.toThrow(
      /cannot exceed audio duration/,
    );
    await expect(runtime.updateCardTrim(card.id, { frontMarkerSec: 200, backMarkerSec: 100 })).rejects.toThrow(
      /earlier than back trim/,
    );
    expect(cards(runtime.getSnapshot())[0].trim, "a refused edit changes nothing").toEqual({
      frontMarkerSec: null,
      backMarkerSec: null,
    });
  });

  it("removes a card together with its audio", async () => {
    const card = await confirmed();

    const snapshot = await runtime.removeCard(card.id);

    expect(cards(snapshot)).toEqual([]);
    expect(await exists(card.sourceFilePath)).toBe(false);
    await expect(runtime.removeCard(card.id)).rejects.toThrow(/does not exist/);
  });

  it("removes the card even when its audio could not be deleted", async () => {
    const card = await confirmed();
    await rm(card.sourceFilePath, { force: true });

    expect(cards(await runtime.removeCard(card.id))).toEqual([]);
  });

  it("names the file the window should play", async () => {
    const card = await confirmed();

    expect(runtime.resolveCardSourcePath(card.id)).toBe(card.sourceFilePath);
    expect(runtime.resolveCardSourcePath("not-a-card")).toBeNull();
    await expect(runtime.getCardMediaSource(card.id)).resolves.toMatch(/^mumbler-asset:\/\/media\//);
    await expect(runtime.getCardMediaSource("not-a-card")).rejects.toThrow();
  });
});

describe("settings, secrets and the window's own state", () => {
  it("keeps the queue pane width the user dragged to, within what the window allows", async () => {
    expect((await runtime.saveLayout(420)).layout?.queueWidth).toBe(420);

    const clamped = (await runtime.saveLayout(10)).layout?.queueWidth ?? 0;
    expect(clamped).toBeGreaterThan(10);
    expect(JSON.parse(await readFile(join(home, "layout.json"), "utf8")).queueWidth).toBe(clamped);
  });

  it("saves an edited settings draft and reports it back", async () => {
    const draft = runtime.getSettingsDraft();

    const snapshot = await runtime.saveSettingsDraft({ ...draft, defaultTimezone: "Europe/Berlin", concurrencyLimit: 3 });

    expect(snapshot.settingsSummary).toMatchObject({ defaultTimezone: "Europe/Berlin" });
    expect(runtime.getSettingsDraft()).toMatchObject({ defaultTimezone: "Europe/Berlin" });
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8")).defaultTimezone).toBe("Europe/Berlin");
  });

  it("keeps the API key out of the settings file and out of the snapshot", async () => {
    const snapshot = await runtime.setGeminiApiKey("  AIza-secret-key  ");

    expect(snapshot.settingsSummary?.hasGeminiApiKey).toBe(true);
    expect(JSON.stringify(snapshot), "only the presence is reported").not.toContain("AIza-secret-key");
    expect(await readFile(join(home, "config.json"), "utf8")).not.toContain("AIza-secret-key");
    const secrets = await readFile(join(home, "api-keys.json"), "utf8");
    expect(secrets, "the key is not left lying in plain sight").not.toContain("AIza-secret-key");
    expect(JSON.parse(secrets).keys.gemini, "it is stored under its own id").toMatch(/^obf:/);

    expect((await runtime.clearGeminiApiKey()).settingsSummary?.hasGeminiApiKey).toBe(false);
    expect(JSON.parse(await readFile(join(home, "api-keys.json"), "utf8")).keys.gemini).toBeUndefined();
    await expect(runtime.setGeminiApiKey("   ")).rejects.toThrow(/Enter a Gemini API key/);
  });

  it("still reports a key when one comes from the environment, even after the stored one is cleared", async () => {
    process.env.GEMINI_API_KEY = "AIza-from-the-environment";
    try {
      await runtime.setGeminiApiKey("AIza-stored-key");

      const cleared = await runtime.clearGeminiApiKey();

      expect(cleared.settingsSummary?.hasGeminiApiKey, "the environment still supplies one").toBe(true);
      expect(JSON.parse(await readFile(join(home, "api-keys.json"), "utf8")).keys.gemini).toBeUndefined();
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  });

  it("shows the window an app-wide error and lets the user dismiss it", async () => {
    const reported = await runtime.reportRendererError({
      source: "QueueList",
      message: "Cannot read properties of undefined",
      stack: "at QueueList",
    });

    expect(reported.appWideError).toMatchObject({ title: "Mumbler could not continue" });
    expect((await runtime.dismissAppWideError()).appWideError).toBeNull();
  });

  it("starts over on request, keeping the files the user made", async () => {
    const [pending] = await dropIn("take.wav");
    await runtime.confirmPendingImports([review(pending)]);
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), defaultTimezone: "Europe/Berlin" });

    const snapshot = await runtime.resetState();

    expect(cards(snapshot)).toEqual([]);
    expect(snapshot.settingsSummary?.defaultTimezone).not.toBe("Europe/Berlin");
    expect(await exists(pending.workingFilePath), "the orphaned working copy is swept").toBe(false);
    expect(await exists(pending.originalSourcePath), "the user's own file is untouched").toBe(true);
  });
});
