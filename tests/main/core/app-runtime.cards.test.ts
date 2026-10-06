import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSnapshot, MumblerCard, PendingImportReviewItem } from "@shared/app-shell";
import { hasStaleResults } from "@shared/card-status";
import { formatUtcMarker } from "@shared/timestamps";

// The card list as the user builds it: confirm what was dropped in, duplicate a
// card to trim it twice, move the markers, remove one, start over. This drives
// the real runtime against a real MUMBLER_DATA_DIR, so what is asserted is the state
// that survives on disk, not a mock's bookkeeping.
vi.mock("electron", () => ({
  app: { getName: () => "Mumbler Test", getVersion: () => "9.9.9-test", getPath: () => "/tmp", isPackaged: false },
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  dialog: {},
  shell: {},
  nativeTheme: { themeSource: "system" },
}));

// The filesystem is real; only a removal the OS refuses is simulated, for paths
// registered in `undeletable`, so the case runs the same on every platform.
const undeletable = vi.hoisted(() => new Set<string>());
// Paths a rename refuses to move, the way a folder held open by another program can.
const unmovable = vi.hoisted(() => new Set<string>());
// Files a write cannot replace, the way a full disk refuses them: an atomic
// write's final rename onto the file fails. A held write waits at that rename
// until released, so a test can act while it is in flight.
const unwritable = vi.hoisted(() => ({
  refuses: (_path: string): boolean => false,
  held: null as { path: string; release: Promise<void>; entered: number } | null,
}));
// Runs while a refused removal is in flight, the way another card's save can.
const duringRefusedRm = vi.hoisted(() => ({ run: null as (() => Promise<unknown>) | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      if (undeletable.has(String(path))) {
        await duringRefusedRm.run?.();
        throw new Error("EACCES: permission denied");
      }
      return actual.rm(path, options);
    },
    rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
      if (unmovable.has(String(from))) throw new Error("EBUSY: resource busy or locked");
      const held = unwritable.held;
      if (held !== null && held.path === String(to)) {
        held.entered += 1;
        await held.release;
      }
      if (unwritable.refuses(String(to))) throw new Error("ENOSPC: no space left on device");
      return actual.rename(from, to);
    },
  };
});

// Managed ffmpeg/ffprobe are a separate boundary with their own tests; keeping
// them inert makes this a local, deterministic test of the card rules.
vi.mock("@main/core/binaries/manager", () => ({
  ToolManager: class {
    async reconcile(): Promise<void> {}
    listStatuses(): [] {
      return [];
    }
    launchCheckDue(): boolean {
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
const probeGate = vi.hoisted(() => ({
  held: null as Promise<void> | null,
  entered: 0,
  onEnter: null as (() => void) | null,
}));
// Each source an import starts on, recorded the moment the import reaches it, so
// a test can tell whether an import has begun without waiting for one to finish.
const importStarts = vi.hoisted(() => [] as string[]);
vi.mock("@shared/audio-import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/audio-import")>();
  return {
    ...actual,
    isSupportedAudioImportName: (pathOrName: string) => {
      importStarts.push(pathOrName);
      return actual.isSupportedAudioImportName(pathOrName);
    },
  };
});
// Holding the silence analysis keeps a trim in flight, the way ffmpeg does on a
// long recording, while the user presses the next shortcut.
const trimGate = vi.hoisted(() => ({ held: null as Promise<void> | null, entered: 0 }));
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
      probeGate.entered += 1;
      probeGate.onEnter?.();
      if (probeGate.held !== null) await probeGate.held;
      return probed.profile;
    },
    analyzeTrimDecision: async (_path: string, trim: { frontMarkerSec: number | null; backMarkerSec: number | null }) => {
      trimGate.entered += 1;
      if (trimGate.held !== null) await trimGate.held;
      return {
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
      };
    },
  };
});

const { ApplicationRuntime } = await import("@main/core/app-runtime");
const { createQueueStore } = await import("@main/core/settings-schema");
const { TranscriptStore } = await import("@main/core/transcript-store");

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
  previousHome = process.env.MUMBLER_DATA_DIR;
  process.env.MUMBLER_DATA_DIR = home;
  // A key in the developer's own environment resolves ahead of the stored one,
  // so these cases start from none; the rule itself is asserted below.
  previousGeminiKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  undeletable.clear();
  unmovable.clear();
  unwritable.refuses = () => false;
  unwritable.held = null;
  duringRefusedRm.run = null;
  audioGate.held = null;
  audioGate.entered = 0;
  probeGate.held = null;
  probeGate.entered = 0;
  probeGate.onEnter = null;
  importStarts.length = 0;
  trimGate.held = null;
  trimGate.entered = 0;
  runtime = await ApplicationRuntime.initialize();
});

afterEach(async () => {
  await runtime.shutdown();
  if (previousHome === undefined) delete process.env.MUMBLER_DATA_DIR;
  else process.env.MUMBLER_DATA_DIR = previousHome;
  if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = previousGeminiKey;
  await rm(root, { recursive: true, force: true });
});

describe("the durable queue store", () => {
  it("sets queue.json aside on reset", async () => {
    const [pending] = await dropIn("take.wav");
    await runtime.confirmPendingImports([review(pending)]);
    const original = await readFile(join(home, "queue.json"), "utf8");
    await runtime.resetState();
    expect(await exists(join(home, "queue.json"))).toBe(false);
    const preserved = (await readdir(home)).find((name) => /^queue-.*\.invalid$/.test(name));
    expect(preserved).toBeDefined();
    expect(await readFile(join(home, preserved!), "utf8")).toBe(original);
  });

  it.each([
    ["unparseable", "broken queue"],
    ["without its format version", JSON.stringify({ pendingImports: [], cards: [] })],
  ])("halts on a queue.json that is %s and leaves it untouched", async (_kind, bytes) => {
    await runtime.shutdown();
    await writeFile(join(home, "queue.json"), bytes);
    runtime = await ApplicationRuntime.initialize();
    expect(runtime.getSnapshot().startupDiagnostic).toMatchObject({
      title: { key: "diagnostic.corruptTitle" },
      message: { key: "diagnostic.corruptBody", values: { path: join(home, "queue.json") } },
      canReset: false,
    });
    expect(await readFile(join(home, "queue.json"), "utf8")).toBe(bytes);
  });

  it("keeps the working recordings at a launch that finds no queue.json", async () => {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    await runtime.shutdown();
    await rm(join(home, "queue.json"));

    runtime = await ApplicationRuntime.initialize();

    expect(cards(runtime.getSnapshot())).toEqual([]);
    expect(await exists(card.sourceFilePath), "a fresh queue deletes no recording").toBe(true);
  });

  it("keeps a working recording that the queue.json it read does not refer to", async () => {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    await runtime.shutdown();
    const store = createQueueStore(join(home, "queue.json"));
    await store.save({ ...(await store.load()).value, cards: [] });

    runtime = await ApplicationRuntime.initialize();

    expect(await exists(card.sourceFilePath), "a queue that lost the card deletes no recording").toBe(true);
  });

  it("keeps the working recordings at a launch after a new queue was saved over a lost one", async () => {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    await runtime.shutdown();
    await rm(join(home, "queue.json"));
    runtime = await ApplicationRuntime.initialize();
    const [next] = await dropIn("next.wav");
    await runtime.confirmPendingImports([review(next)]);
    await runtime.shutdown();

    runtime = await ApplicationRuntime.initialize();

    expect(await exists(card.sourceFilePath), "the next launch still deletes no recording").toBe(true);
  });

  it("deletes audio a crash left in derived/ at launch", async () => {
    await runtime.shutdown();
    const leftover = join(home, "working", "derived", "cut-short.wav");
    await mkdir(join(home, "working", "derived"), { recursive: true });
    await writeFile(leftover, "trimmed audio");

    runtime = await ApplicationRuntime.initialize();

    expect(await exists(leftover)).toBe(false);
  });
});

describe("confirming what was dropped in", () => {
  it("turns each pending import into a card with the reviewed time, and selects the first", async () => {
    const [pending] = await dropIn("take.wav");

    const { snapshot } = await runtime.confirmPendingImports([
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

    const persisted = await createQueueStore(join(home, "queue.json")).load();
    expect(persisted.value.cards.map((entry) => entry.id)).toEqual([card.id]);
  });

  it("orders the cards by when they were recorded, not by when they were dropped in", async () => {
    const pending = await dropIn("later.wav", "earlier.wav");

    const { snapshot } = await runtime.confirmPendingImports([
      review(pending[0], { localTimestampText: "2026-03-02 10:00:00" }),
      review(pending[1], { localTimestampText: "2026-03-01 10:00:00" }),
    ]);

    expect(cards(snapshot).map((card) => card.originalFilename)).toEqual(["earlier.wav", "later.wav"]);
  });

  it("copies the original to the backup folder when the user asked for that", async () => {
    const [pending] = await dropIn("take.wav");

    await runtime.confirmPendingImports([review(pending, { copyToBackupOnConfirm: true })]);

    expect(await readFile(join(home, "originals", "take.wav"), "utf8")).toBe("audio for take.wav");
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

    const { originalWarnings } = await runtime.confirmPendingImports([
      review(pending, { copyToBackupOnConfirm: true, deleteOriginalOnConfirm: true }),
    ]);

    expect(await exists(pending.originalSourcePath), "nothing is thrown away unbacked").toBe(true);
    expect(cards(runtime.getSnapshot()), "the card is still made").toHaveLength(1);
    expect(originalWarnings).toEqual([{
      sourcePath: pending.originalSourcePath,
      message: {
        key: "import.backupFailedNotDeleted",
        values: { file: pending.originalSourcePath, folder: join(root, "blocked") },
      },
    }]);
  });

  it("warns, naming both paths, when only the backup it was told to make could not be written", async () => {
    const [pending] = await dropIn("take.wav");
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), backupDirectory: join(root, "blocked") });
    await writeFile(join(root, "blocked"), "not a directory");

    const { originalWarnings } = await runtime.confirmPendingImports([review(pending, { copyToBackupOnConfirm: true })]);

    expect(originalWarnings).toEqual([{
      sourcePath: pending.originalSourcePath,
      message: { key: "import.backupFailed", values: { file: pending.originalSourcePath, folder: join(root, "blocked") } },
    }]);
  });

  it("warns when the original it was told to delete could not be deleted, and still makes the card", async () => {
    const [pending] = await dropIn("take.wav");
    await rm(pending.originalSourcePath);

    const { snapshot, originalWarnings } = await runtime.confirmPendingImports([
      review(pending, { deleteOriginalOnConfirm: true, copyToBackupOnConfirm: false }),
    ]);

    expect(cards(snapshot)).toHaveLength(1);
    expect(originalWarnings).toEqual([{
      sourcePath: pending.originalSourcePath,
      message: { key: "import.deleteFailed", values: { file: pending.originalSourcePath } },
    }]);
  });

  it("returns no warning when the original was backed up and deleted as asked", async () => {
    const [pending] = await dropIn("take.wav");

    const { originalWarnings } = await runtime.confirmPendingImports([
      review(pending, { copyToBackupOnConfirm: true, deleteOriginalOnConfirm: true }),
    ]);

    expect(originalWarnings).toEqual([]);
  });

  it("confirms what was reviewed and leaves an import the review did not show pending", async () => {
    const pending = await dropIn("first.wav", "second.wav");

    const { snapshot } = await runtime.confirmPendingImports([review(pending[0])]);

    expect(cards(snapshot).map((card) => card.originalFilename)).toEqual(["first.wav"]);
    expect(snapshot.state?.pendingImports.map((item) => item.id)).toEqual([pending[1].id]);
  });

  it("moves an import's updated time and rewrites the queue only when the review changes it", async () => {
    const [pending] = await dropIn("take.wav");
    const queueFile = join(home, "queue.json");
    const stored = await readFile(queueFile, "utf8");

    const editedAt = pending.updatedAtUtc + 60_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(editedAt);
    try {
      const unchanged = await runtime.updatePendingImportDrafts([{ ...pending }]);

      expect(unchanged.state?.pendingImports[0].updatedAtUtc).toBe(pending.updatedAtUtc);
      expect(await readFile(queueFile, "utf8"), "an unchanged draft writes nothing").toBe(stored);

      const edited = await runtime.updatePendingImportDrafts([review(pending)]);

      expect(edited.state?.pendingImports[0].updatedAtUtc).toBe(editedAt);
      expect(await readFile(queueFile, "utf8")).not.toBe(stored);
    } finally {
      now.mockRestore();
    }
  });

  it("keeps an import dropped in while the review is being confirmed", async () => {
    const [first] = await dropIn("first.wav");
    const laterPath = join(sourceDir, "later.wav");
    await writeFile(laterPath, "audio for later.wav");

    let release!: () => void;
    probeGate.held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const probing = new Promise<void>((resolve) => {
      probeGate.onEnter = resolve;
    });

    const confirming = runtime.confirmPendingImports([review(first)]);
    await probing;
    const importing = runtime.importDroppedPaths([laterPath]);
    // An import not ordered behind the confirm would have reached its source by
    // the time the pending callbacks have run; this one waits for the confirm.
    await new Promise((resolve) => setImmediate(resolve));
    expect(importStarts, "the import waits for the confirm to end").not.toContain(laterPath);
    release();
    await Promise.all([confirming, importing]);
    expect(importStarts).toContain(laterPath);

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
    const store = createQueueStore(join(home, "queue.json"));
    const loaded = await store.load();
    const transcribed = loaded.value.cards.map((card) =>
        card.id === cardId
          ? {
              ...card,
              status: "Ready to Save" as const,
              transcription: { text: "the words from the old span" },
              metadata: { structured: "notes", title: "Old title", slug: "old-title" },
              transcribedTrim: { ...card.trim },
              ai: { transcription: run, structured: run, title: run, slug: run },
            }
          : card,
    );
    // The long text lives in each card's own file, not in queue.json.
    await new TranscriptStore(join(home, "transcripts")).writeChanged(transcribed);
    await store.save({ ...loaded.value, cards: transcribed });
    runtime = await ApplicationRuntime.initialize();
  }

  async function confirmed(): Promise<MumblerCard> {
    const [pending] = await dropIn("take.wav");
    const { snapshot } = await runtime.confirmPendingImports([review(pending)]);
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

  it("holds a card whose trim is still being applied against every other change", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    let release!: () => void;
    trimGate.held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const trimming = runtime.updateCardTrim(card.id, { frontMarkerSec: null, backMarkerSec: 200 });
    await vi.waitFor(() => expect(trimGate.entered).toBe(1));

    await expect(runtime.saveCard(card.id)).rejects.toThrow(/still being applied/);
    await expect(runtime.removeCard(card.id)).rejects.toThrow(/being processed/);
    await expect(runtime.duplicateCard(card.id)).rejects.toThrow(/being processed/);
    await runtime.setGeminiApiKey("AIza-test-key");
    await expect(runtime.generateCardStep(card.id, "title")).rejects.toThrow(/already being processed/);

    release();
    const [trimmed] = cards(await trimming);
    expect(trimmed.trim.backMarkerSec).toBe(200);
    expect(await exists(card.sourceFilePath), "the working audio is kept").toBe(true);
    expect(await readdir(join(home, "output")).catch(() => []), "nothing was saved").toEqual([]);
  });

  it("refuses to generate without an API key and leaves the card as it was", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);

    await expect(runtime.generateCardStep(card.id, "title")).rejects.toThrow(/not configured/);

    expect(cards(runtime.getSnapshot())[0]).toMatchObject({
      status: "Ready to Save",
      metadata: { title: "Old title", slug: "old-title" },
    });
  });

  it("keeps the latest trim when an earlier one finishes analyzing after it", async () => {
    const card = await confirmed();
    let release!: () => void;
    trimGate.held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const earlier = runtime.updateCardTrim(card.id, { frontMarkerSec: 5, backMarkerSec: null });
    await vi.waitFor(() => expect(trimGate.entered).toBe(1));
    trimGate.held = null;
    await runtime.updateCardTrim(card.id, { frontMarkerSec: 9, backMarkerSec: null });
    release();
    await earlier;

    expect(cards(runtime.getSnapshot())[0].trim.frontMarkerSec).toBe(9);
    await runtime.shutdown();
    const persisted = await createQueueStore(join(home, "queue.json")).load();
    expect(persisted.value.cards[0].trim.frontMarkerSec).toBe(9);
  });

  it("leaves a card as it was when the trim it already holds is applied again", async () => {
    const card = await confirmed();
    const [trimmed] = cards(await runtime.updateCardTrim(card.id, { frontMarkerSec: 5, backMarkerSec: 200 }));
    const queueFile = join(home, "queue.json");
    const stored = await readFile(queueFile, "utf8");
    const analyses = trimGate.entered;

    // A later clock, so a trim that stamped the card would show it.
    const now = vi.spyOn(Date, "now").mockReturnValue(trimmed.updatedAtUtc + 60_000);
    const [again] = cards(
      await runtime.updateCardTrim(card.id, { frontMarkerSec: 5, backMarkerSec: 200 }).finally(() => now.mockRestore()),
    );

    expect(trimGate.entered, "no second analysis").toBe(analyses);
    expect(again.updatedAtUtc).toBe(trimmed.updatedAtUtc);
    expect(again.trimDecision).toEqual(trimmed.trimDecision);
    expect(await readFile(queueFile, "utf8"), "nothing is written").toBe(stored);
  });

  it("keeps the held trim when the user returns to it while another is analyzing", async () => {
    const card = await confirmed();
    let release!: () => void;
    trimGate.held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const other = runtime.updateCardTrim(card.id, { frontMarkerSec: 5, backMarkerSec: null });
    await vi.waitFor(() => expect(trimGate.entered).toBe(1));
    await runtime.updateCardTrim(card.id, { frontMarkerSec: null, backMarkerSec: null });
    release();
    await other;

    const [kept] = cards(runtime.getSnapshot());
    expect(kept.trim).toEqual({ frontMarkerSec: null, backMarkerSec: null });
    expect(kept.updatedAtUtc).toBe(card.updatedAtUtc);
  });

  it("cancels a save cut short by quitting and leaves the card ready to save", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    audioGate.held = new Promise<void>(() => undefined);

    const saving = runtime.saveCard(card.id);
    const outcome = saving.then(() => "saved", () => "stopped");
    await vi.waitFor(() => expect(audioGate.entered).toBe(1));
    await runtime.shutdown();

    expect(await outcome).toBe("stopped");
    const persisted = await createQueueStore(join(home, "queue.json")).load();
    expect(persisted.value.cards.map((entry) => entry.status)).toEqual(["Ready to Save"]);
    expect(await exists(card.sourceFilePath), "the working audio is kept").toBe(true);
    expect(await readdir(join(home, "output")).catch(() => []), "nothing was published").toEqual([]);
    await expect(runtime.saveCard(card.id), "no save starts while closing").rejects.toThrow(/closing/);
  });

  it("reports a save as saved once its files are out, even when the queue then cannot be written", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    const queueStore = (runtime as unknown as { runtime: { queueStore: { save(value: unknown): Promise<void> } } })
      .runtime.queueStore;
    const realSave = queueStore.save.bind(queueStore);
    let saves = 0;
    vi.spyOn(queueStore, "save").mockImplementation(async (value) => {
      saves += 1;
      // The first write claims the card as Saving; the next one follows publication.
      if (saves === 2) throw new Error("disk full");
      return realSave(value);
    });

    const result = await runtime.saveCard(card.id);

    expect(result.kind).toBe("saved");
    expect(cards(result.snapshot), "the saved card is out of the queue").toEqual([]);
    expect((await readdir(join(home, "output"))).length).toBe(3);
    expect(await exists(card.sourceFilePath), "the working audio is gone").toBe(false);
  });

  it("keeps a file that took the save's name after its conflict check", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    const saved = cards(runtime.getSnapshot())[0];
    const target = join(home, "output", `${formatUtcMarker(new Date(saved.timestamps.effectiveUtc))}-old-title.wav`);
    let release!: () => void;
    probeGate.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probesBefore = probeGate.entered;

    const saving = runtime.saveCard(card.id);
    // The save probes its final audio only after it found the names free.
    await vi.waitFor(() => expect(probeGate.entered).toBe(probesBefore + 1));
    await writeFile(target, "another save's audio");
    release();
    const result = await saving;

    expect(result.kind).toBe("conflict");
    expect(await readFile(target, "utf8")).toBe("another save's audio");
    expect(cards(result.snapshot)[0].status).toBe("Ready to Save");
    expect(await exists(card.sourceFilePath), "the working audio is kept").toBe(true);
    expect((await readdir(join(home, "output"))).sort()).toEqual([basename(target)]);
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
      (await runtime.confirmPendingImports(pending.map((item) => review(item)))).snapshot,
    );

    // The duplicate waits on a file copy; the trim on the other card saves the
    // queue in the meantime. Both changes have to survive.
    const duplicating = runtime.duplicateCard(first.id);
    const trimming = runtime.updateCardTrim(second.id, { frontMarkerSec: 1, backMarkerSec: null });
    await Promise.all([duplicating, trimming]);

    expect(cards(runtime.getSnapshot())).toHaveLength(3);
    await runtime.shutdown();
    const persisted = await createQueueStore(join(home, "queue.json")).load();
    expect(persisted.value.cards).toHaveLength(3);
    expect(persisted.value.cards.find((card) => card.id === second.id)?.trim.frontMarkerSec).toBe(1);
  });

  it("moves the recorded time forward by the front marker and keeps the results, marked stale", async () => {
    const card = await confirmed();
    // A card that has already been through the pipeline: its text and metadata
    // describe the old span, so a trim keeps them and marks them stale.
    await transcribedOnDisk(card.id);
    expect(hasStaleResults(cards(runtime.getSnapshot())[0]), "results stored before a trim match it").toBe(false);

    const snapshot = await runtime.updateCardTrim(card.id, { frontMarkerSec: 65.5, backMarkerSec: 200 });

    const [updated] = cards(snapshot);
    expect(updated.trim).toEqual({ frontMarkerSec: 65.5, backMarkerSec: 200 });
    expect(updated.trimDecision).toMatchObject({ kind: "stream-copy", chosenStartBoundarySec: 65.5 });
    expect(updated.timestamps.frontTrimOffsetSec).toBe(65.5);
    // The instant moves by the exact trim; the local time shows its tenths and
    // the file name keeps whole seconds.
    expect(updated.timestamps.effectiveUtc - updated.timestamps.confirmedUtc).toBe(65_500);
    expect(updated.timestamps.effectiveLocal).toBe("2026-03-01 07:31:05.5");
    expect(formatUtcMarker(new Date(updated.timestamps.effectiveUtc))).toBe("20260228-223105-utc");
    expect(updated, "the paid results survive the trim").toMatchObject({
      transcription: { text: "the words from the old span" },
      metadata: { structured: "notes", title: "Old title", slug: "old-title" },
      status: "Ready to Save",
    });
    expect(hasStaleResults(updated)).toBe(true);

    const restored = await runtime.updateCardTrim(card.id, { frontMarkerSec: null, backMarkerSec: null });
    expect(hasStaleResults(cards(restored)[0]), "moving the markers back matches again").toBe(false);
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

  it("removes the card when its audio is already gone", async () => {
    const card = await confirmed();
    await rm(card.sourceFilePath, { force: true });

    expect(cards(await runtime.removeCard(card.id))).toEqual([]);
  });

  it("keeps the card in the queue when its audio cannot be deleted, so no recording is left behind", async () => {
    const card = await confirmed();
    undeletable.add(card.sourceFilePath);

    await expect(runtime.removeCard(card.id)).rejects.toThrow(/working audio/);

    expect(cards(runtime.getSnapshot()).map((entry) => entry.id)).toEqual([card.id]);
    expect(await exists(card.sourceFilePath)).toBe(true);
    undeletable.clear();
    expect(cards(await runtime.removeCard(card.id)), "removing it again deletes it").toEqual([]);
    expect(await exists(card.sourceFilePath)).toBe(false);
  });

  it("keeps the refused card in queue.json even when another save ran during the deletion", async () => {
    const card = await confirmed();
    const [otherPending] = await dropIn("other.wav");
    const [other] = cards((await runtime.confirmPendingImports([review(otherPending)])).snapshot).filter(
      (entry) => entry.id !== card.id,
    );
    undeletable.add(card.sourceFilePath);
    duringRefusedRm.run = () => runtime.duplicateCard(other.id);

    await expect(runtime.removeCard(card.id)).rejects.toThrow(/working audio/);
    await runtime.shutdown();
    runtime = await ApplicationRuntime.initialize();

    expect(cards(runtime.getSnapshot()).map((entry) => entry.id)).toContain(card.id);
  });

  it("deletes only the removed card's own audio, leaving its duplicate's", async () => {
    const card = await confirmed();
    const duplicate = cards(await runtime.duplicateCard(card.id)).find((entry) => entry.id !== card.id)!;

    await runtime.removeCard(duplicate.id);

    expect(await exists(duplicate.sourceFilePath)).toBe(false);
    expect(await exists(card.sourceFilePath), "the card it was duplicated from keeps its audio").toBe(true);
  });

  it("names the file the window should play", async () => {
    const card = await confirmed();

    expect(runtime.resolveCardSourcePath(card.id)).toBe(card.sourceFilePath);
    expect(runtime.resolveCardSourcePath("not-a-card")).toBeNull();
    await expect(runtime.getCardMediaSource(card.id)).resolves.toMatch(/^mumbler-asset:\/\/media\//);
    await expect(runtime.getCardMediaSource("not-a-card")).rejects.toThrow();
  });
});

describe("each card's text in its own file", () => {
  /** Gives the confirmed card text in its own file, the way a finished run leaves it. */
  async function withTextOnDisk(card: MumblerCard): Promise<void> {
    await runtime.shutdown();
    await new TranscriptStore(join(home, "transcripts")).writeChanged([
      { ...card, transcription: { text: "every word that was said" }, metadata: { ...card.metadata, structured: "## what it was about" } },
    ]);
    runtime = await ApplicationRuntime.initialize();
  }

  it("reads a card's text from its own file, never from queue.json", async () => {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    await withTextOnDisk(card);

    const [loaded] = cards(runtime.getSnapshot());
    expect(loaded).toMatchObject({
      id: card.id,
      transcription: { text: "every word that was said" },
      metadata: { structured: "## what it was about" },
    });
    expect(await readFile(join(home, "queue.json"), "utf8")).not.toContain("every word that was said");
    const [file] = await readdir(join(home, "transcripts"));
    expect(JSON.parse(await readFile(join(home, "transcripts", file), "utf8"))).toMatchObject({
      formatVersion: 1,
      cardId: card.id,
      transcription: "every word that was said",
    });
  });

  it("drops a card's text file when the card is removed", async () => {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    await withTextOnDisk(card);
    expect(await readdir(join(home, "transcripts"))).toHaveLength(1);

    await runtime.removeCard(card.id);

    expect(await readdir(join(home, "transcripts"))).toEqual([]);
  });

  it("keeps a lost queue's text files, at the launch that finds no queue and at every launch after it", async () => {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    await withTextOnDisk(card);
    const files = await readdir(join(home, "transcripts"));
    await runtime.shutdown();
    await rm(join(home, "queue.json"));

    runtime = await ApplicationRuntime.initialize();
    expect(cards(runtime.getSnapshot())).toEqual([]);
    expect(await readdir(join(home, "transcripts")), "no queue was read").toEqual(files);

    const [next] = await dropIn("next.wav");
    await runtime.confirmPendingImports([review(next)]);
    await runtime.shutdown();
    runtime = await ApplicationRuntime.initialize();
    expect(await readdir(join(home, "transcripts")), "the new queue never referred to them").toEqual(files);
  });
});

describe("a store in a newer format", () => {
  /** Rewrites a JSON store as a newer build would have left it, returning its bytes. */
  async function makeNewer(path: string): Promise<string> {
    const current = (await exists(path)) ? JSON.parse(await readFile(path, "utf8")) : {};
    const newer = JSON.stringify({ ...current, formatVersion: 2 });
    await writeFile(path, newer, "utf8");
    return newer;
  }

  async function confirmedCard(): Promise<MumblerCard> {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    return card;
  }

  it.each(["queue.json", "config.json", "dependencies.json"])(
    "halts launch naming %s, leaves it untouched and offers no reset",
    async (name) => {
      await confirmedCard();
      await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), concurrencyLimit: 5 });
      await runtime.shutdown();
      const path = join(home, name);
      const newer = await makeNewer(path);

      runtime = await ApplicationRuntime.initialize();

      expect(runtime.getSnapshot().startupDiagnostic).toEqual({
        title: { key: "diagnostic.newerTitle" },
        message: { key: "diagnostic.newerBody", values: { path } },
        canReset: false,
      });
      expect(runtime.getSnapshot().state).toBeNull();
      await runtime.shutdown();
      expect(await readFile(path, "utf8")).toBe(newer);
      expect((await readdir(home)).filter((entry) => entry.endsWith(".invalid"))).toEqual([]);
    },
  );

  it("halts launch naming a card's transcript file and leaves it untouched", async () => {
    const card = await confirmedCard();
    await runtime.shutdown();
    await new TranscriptStore(join(home, "transcripts")).writeChanged([
      { ...card, transcription: { text: "words" } },
    ]);
    const [file] = await readdir(join(home, "transcripts"));
    const path = join(home, "transcripts", file);
    const newer = await makeNewer(path);

    runtime = await ApplicationRuntime.initialize();

    expect(runtime.getSnapshot().startupDiagnostic).toMatchObject({
      message: { key: "diagnostic.newerBody", values: { path } },
      canReset: false,
    });
    expect(await readFile(path, "utf8")).toBe(newer);
  });

  it("opens on a default layout and never writes a layout.json from a newer build", async () => {
    const card = await confirmedCard();
    await runtime.saveLayout(420);
    await runtime.shutdown();
    const path = join(home, "layout.json");
    const newer = await makeNewer(path);

    runtime = await ApplicationRuntime.initialize();

    expect(runtime.getSnapshot().startupDiagnostic).toBeNull();
    expect(runtime.getSnapshot().layout?.queueWidth).not.toBe(420);
    await runtime.saveLayout(430);
    await runtime.saveRecordsListWidth(500);
    await runtime.selectCard(card.id);
    await runtime.shutdown();
    expect(await readFile(path, "utf8")).toBe(newer);
  });
});

describe("settings, secrets and the window's own state", () => {
  it.each([
    ["unparseable", "broken settings"],
    ["without its format version", JSON.stringify({ concurrencyLimit: 5 })],
  ])("sets aside a config.json that is %s, starts on the built-ins and keeps the queue", async (_kind, bytes) => {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    await runtime.shutdown();
    await writeFile(join(home, "config.json"), bytes);

    runtime = await ApplicationRuntime.initialize();

    const snapshot = runtime.getSnapshot();
    const quarantined = (await readdir(home)).find((name) => /^config-.*\.invalid$/.test(name));
    expect(quarantined).toBeDefined();
    expect(await readFile(join(home, quarantined!), "utf8")).toBe(bytes);
    expect(await exists(join(home, "config.json")), "nothing is written until the user changes a setting").toBe(false);
    expect(snapshot.startupDiagnostic).toBeNull();
    expect(snapshot.appWideError).toEqual({
      title: { key: "diagnostic.settingsResetTitle" },
      message: { key: "diagnostic.settingsResetBody", values: { path: join(home, quarantined!) } },
    });
    expect(cards(snapshot).map((entry) => entry.id)).toEqual([card.id]);
    expect(await exists(card.sourceFilePath)).toBe(true);
  });

  it("does not materialize sets when an unchanged draft is saved", async () => {
    await runtime.saveSettingsDraft(runtime.getSettingsDraft());
    expect(await exists(join(home, "config.json"))).toBe(false);
  });

  it("launches without a config file and writes only the edited set", async () => {
    expect(await exists(join(home, "config.json"))).toBe(false);
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), concurrencyLimit: 5 });
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8"))).toEqual({ formatVersion: 1, concurrencyLimit: 5 });
  });

  it("writes the Audio Tools update toggle with the other sets the app holds", async () => {
    await runtime.saveToolSettings(false);
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8"))).toEqual({ formatVersion: 1, checkUpdatesAtLaunch: false });
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), concurrencyLimit: 5 });
    await runtime.saveToolSettings(true);
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8"))).toEqual({ formatVersion: 1, concurrencyLimit: 5 });
  });

  it("removes model and prompt copies when Save holds their built-ins, as after a reset", async () => {
    const defaults = runtime.getSettingsDraft();
    await runtime.saveSettingsDraft({
      ...defaults, transcriptionModel: "custom-model", metadataModel: "custom-model",
      structuredPrompt: "Custom {transcript}", concurrencyLimit: 5,
    });
    const prompts = runtime.getDefaultPrompts();
    await runtime.saveSettingsDraft({
      ...runtime.getSettingsDraft(),
      transcriptionModel: defaults.transcriptionModel, metadataModel: defaults.metadataModel,
      structuredPrompt: prompts.structured, titlePrompt: prompts.title, slugPrompt: prompts.slug,
    });
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8"))).toEqual({ formatVersion: 1, concurrencyLimit: 5 });
  });

  it("does not store a prompt that differs from its built-in only by line endings and trailing spaces", async () => {
    const { structured } = runtime.getDefaultPrompts();
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), structuredPrompt: `${structured.replaceAll("\n", "  \r\n")}\r\n` });
    expect(await exists(join(home, "config.json"))).toBe(false);
  });

  it("keeps the queue pane width the user dragged to, within what the window allows", async () => {
    expect((await runtime.saveLayout(420)).layout?.queueWidth).toBe(420);

    const clamped = (await runtime.saveLayout(10)).layout?.queueWidth ?? 0;
    expect(clamped).toBeGreaterThan(10);
    expect(JSON.parse(await readFile(join(home, "layout.json"), "utf8")).queueWidth).toBe(clamped);
  });

  it("keeps the records list width beside the queue width, each save keeping the other", async () => {
    await runtime.saveLayout(420);
    expect(await runtime.saveRecordsListWidth(450)).toBe(450);
    await runtime.saveLayout(430);

    expect(runtime.recordsListWidth()).toBe(450);
    expect(JSON.parse(await readFile(join(home, "layout.json"), "utf8"))).toMatchObject({
      queueWidth: 430,
      recordsListWidth: 450,
    });
    expect(await runtime.saveRecordsListWidth(10)).toBeGreaterThan(10);
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
    expect(await exists(join(home, "config.json"))).toBe(false);
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

    expect(reported.appWideError).toMatchObject({ title: { key: "diagnostic.unexpectedTitle" } });
    expect((await runtime.dismissAppWideError()).appWideError).toBeNull();
  });

  it("logs an invalid settings set the store reads after a reset", async () => {
    await runtime.resetState();
    const warn = vi.spyOn(runtime.currentLogger(), "warn");
    await writeFile(join(home, "config.json"), JSON.stringify({ formatVersion: 1, theme: "sepia" }));
    const { settingsStore } = (runtime as unknown as { runtime: { settingsStore: { load(): Promise<unknown> } } }).runtime;

    await settingsStore.load();

    expect(warn).toHaveBeenCalledWith("settings.invalid-set", expect.any(String), { key: "theme" });
  });

  it("rebuilds what speaks the interface language when a reset returns to System", async () => {
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), language: "ja" });
    const languageChanged = vi.fn();
    runtime.onLanguageChanged(languageChanged);

    await runtime.resetState();

    expect(runtime.interfaceLanguage().language).toBe("en");
    expect(languageChanged).toHaveBeenCalledOnce();
  });

  it("returns the app to the System theme on a reset", async () => {
    const { nativeTheme } = await import("electron");
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), theme: "dark" });
    expect(nativeTheme.themeSource).toBe("dark");

    await runtime.resetState();

    expect(nativeTheme.themeSource).toBe("system");
  });

  it("starts over on request, keeping the files the user made", async () => {
    const [pending] = await dropIn("take.wav");
    await runtime.confirmPendingImports([review(pending)]);
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), defaultTimezone: "Europe/Berlin" });

    const snapshot = await runtime.resetState();

    expect(cards(snapshot)).toEqual([]);
    expect(snapshot.settingsSummary?.defaultTimezone).not.toBe("Europe/Berlin");
    expect(await exists(join(home, "config.json"))).toBe(false);
    expect(await exists(join(home, "layout.json"))).toBe(false);
    expect(await exists(join(home, "queue.json"))).toBe(false);
    expect(await exists(pending.workingFilePath), "the recording left the working folder").toBe(false);
    expect(await exists(pending.originalSourcePath), "the user's own file is untouched").toBe(true);
  });

  it("moves every working recording aside beside the set-aside queue, and deletes none", async () => {
    const [kept, waiting] = await dropIn("take.wav", "waiting.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(kept)])).snapshot);
    await mkdir(join(home, "working", "derived"), { recursive: true });
    await writeFile(join(home, "working", "derived", "cut-short.wav"), "trimmed audio");

    await runtime.resetState();

    const names = await readdir(home);
    expect(names.find((name) => /^queue-.*\.invalid$/.test(name)), "the queue is set aside").toBeDefined();
    const setAside = names.find((name) => /^working-.*\.invalid$/.test(name));
    expect(setAside, "the recordings are set aside in the same folder as the queue").toBeDefined();
    expect(await readFile(join(home, setAside!, basename(card.sourceFilePath)), "utf8")).toBe("audio for take.wav");
    expect(await readFile(join(home, setAside!, basename(waiting.workingFilePath)), "utf8")).toBe("audio for waiting.wav");
    expect(await readdir(join(home, "working")), "the new queue starts with an empty working folder").toEqual([]);
  });

  it("says what a reset that failed part-way had already set aside, and keeps the old queue", async () => {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), defaultTimezone: "Europe/Berlin" });
    unmovable.add(join(home, "working"));

    const snapshot = await runtime.resetState();

    expect(snapshot.startupDiagnostic).toEqual({
      title: { key: "diagnostic.resetTitle" },
      message: { key: "diagnostic.resetMovedBody", values: { items: ["config.json", "queue.json"], folder: home } },
      canReset: true,
    });
    const names = await readdir(home);
    expect(names.filter((name) => name.endsWith(".invalid")).map((name) => name.replace(/-\d.*$/, "")).sort())
      .toEqual(["config", "queue"]);
    expect(await exists(card.sourceFilePath), "the recording stays where it was").toBe(true);
    expect(cards(snapshot), "the session keeps the queue it had").toHaveLength(1);
  });

  it("says nothing was changed when a reset failed before moving anything", async () => {
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), defaultTimezone: "Europe/Berlin" });
    unmovable.add(join(home, "config.json"));

    const snapshot = await runtime.resetState();

    expect(snapshot.startupDiagnostic?.message).toEqual({ key: "diagnostic.resetBody" });
    expect((await readdir(home)).filter((name) => name.endsWith(".invalid"))).toEqual([]);
  });
});

describe("an unreadable work store", () => {
  it("halts launch on a queue.json holding the JSON literal null and keeps the working recordings", async () => {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    await runtime.shutdown();
    await writeFile(join(home, "queue.json"), "null", "utf8");

    runtime = await ApplicationRuntime.initialize();

    expect(runtime.getSnapshot().startupDiagnostic?.title).toEqual({ key: "diagnostic.corruptTitle" });
    expect(runtime.getSnapshot().state).toBeNull();
    expect(await readFile(join(home, "queue.json"), "utf8")).toBe("null");
    expect(await exists(card.sourceFilePath), "the working recording is kept").toBe(true);
  });
});

describe("the save a quit makes", () => {
  type Internals = { runtime: { state: { cards: MumblerCard[] } } };

  it("writes the queue its last save could not write, and reports it while it still cannot", async () => {
    const [pending] = await dropIn("take.wav");
    unwritable.refuses = (path) => path === join(home, "queue.json");
    await expect(runtime.confirmPendingImports([review(pending)])).rejects.toThrow();

    expect(await runtime.saveForQuit()).toEqual(["queue"]);

    unwritable.refuses = () => false;
    expect(await runtime.saveForQuit(), "Retry").toEqual([]);
    const saved = await createQueueStore(join(home, "queue.json")).load();
    expect(saved.value.cards.map((card) => card.originalFilename)).toEqual(["take.wav"]);
  });

  it("writes a card's text that is not in its file yet", async () => {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    (runtime as unknown as Internals).runtime.state.cards[0]!.transcription = { text: "words not on disk yet" };
    unwritable.refuses = (path) => path.startsWith(join(home, "transcripts"));

    expect(await runtime.saveForQuit()).toEqual(["transcripts"]);

    unwritable.refuses = () => false;
    expect(await runtime.saveForQuit()).toEqual([]);
    const [file] = await readdir(join(home, "transcripts"));
    expect(JSON.parse(await readFile(join(home, "transcripts", file!), "utf8"))).toMatchObject({
      cardId: card.id,
      transcription: "words not on disk yet",
    });
  });

  it("writes nothing when everything is already on disk", async () => {
    const [pending] = await dropIn("take.wav");
    await runtime.confirmPendingImports([review(pending)]);
    const before = await stat(join(home, "queue.json"));

    expect(await runtime.saveForQuit()).toEqual([]);

    expect((await stat(join(home, "queue.json"))).mtimeMs).toBe(before.mtimeMs);
  });

  it("retries a settings change that fails while the quit runs, with the value the user saved", async () => {
    const configPath = join(home, "config.json");
    let release!: () => void;
    unwritable.held = { path: configPath, release: new Promise((resolve) => { release = resolve; }), entered: 0 };
    unwritable.refuses = (path) => path === configPath;
    const saving = runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), defaultTimezone: "Europe/Berlin" })
      .then(() => "saved", () => "failed");
    await vi.waitFor(() => expect(unwritable.held?.entered).toBe(1));

    const quit = runtime.saveForQuit();
    release();

    expect(await quit).toEqual(["settings"]);
    expect(await saving).toBe("failed");
    unwritable.held = null;
    unwritable.refuses = () => false;
    expect(await runtime.saveForQuit(), "Retry").toEqual([]);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ defaultTimezone: "Europe/Berlin" });
  });

  it("leaves a settings change that failed before the quit to where it was reported", async () => {
    const configPath = join(home, "config.json");
    unwritable.refuses = (path) => path === configPath;
    await expect(runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), defaultTimezone: "Europe/Berlin" })).rejects.toThrow();
    unwritable.refuses = () => false;

    expect(await runtime.saveForQuit()).toEqual([]);

    expect(await exists(configPath)).toBe(false);
  });

  it("takes work again after a cancelled quit", async () => {
    const [pending] = await dropIn("take.wav");
    unwritable.refuses = (path) => path === join(home, "queue.json");
    await expect(runtime.confirmPendingImports([review(pending)])).rejects.toThrow();
    expect(await runtime.saveForQuit()).toEqual(["queue"]);

    unwritable.refuses = () => false;
    await runtime.resumeAfterCancelledQuit();
    const [next] = await dropIn("next.wav");
    await runtime.confirmPendingImports([review(next)]);

    const saved = await createQueueStore(join(home, "queue.json")).load();
    expect(saved.value.cards.map((card) => card.originalFilename).sort()).toEqual(["next.wav", "take.wav"]);
  });
});
