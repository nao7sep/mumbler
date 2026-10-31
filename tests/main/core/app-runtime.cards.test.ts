import { access, chmod, cp, link, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { dialog, shell } from "electron";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pathValue } from "@shared/i18n/translate";
import { CancelledError } from "@main/core/cancellation";

import type { AppSnapshot, MumblerCard, PendingImportReviewItem } from "@shared/app-shell";
import { hasStaleResults } from "@shared/card-status";
import { formatUtcMarker, getSystemTimezone, recomputeLocalFromUtc } from "@shared/timestamps";
import { readSavedQueue } from "../../support/saved-queue";
import { until } from "../../support/until";
import { header } from "../../support/file-header";

// The card list as the user builds it: confirm what was dropped in, duplicate a
// card to trim it twice, move the markers, remove one, start over. This drives
// the real runtime against a real MUMBLER_DATA_DIR, so what is asserted is the state
// that survives on disk, not a mock's bookkeeping.
vi.mock("electron", () => ({
  app: { getName: () => "Mumbler Test", getVersion: () => "9.9.9-test", getPath: () => "/tmp", isPackaged: false },
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(async () => "") },
  nativeTheme: { themeSource: "system" },
}));

// The filesystem is real; only a removal the OS refuses is simulated, for paths
// registered in `undeletable`, so the case runs the same on every platform.
const outputFaults = vi.hoisted(() => ({
  failTarget: null as string | null,
  refuseCleanup: false,
}));
const undeletable = vi.hoisted(() => new Set<string>());
// Paths a rename refuses to move, the way a folder held open by another program can.
const unmovable = vi.hoisted(() => new Set<string>());
const afterResetMove = vi.hoisted(() => ({ run: null as (() => Promise<void>) | null }));
// Files a write cannot replace, the way a full disk refuses them: an atomic
// write's final rename onto the file fails. A held write waits at that rename
// until released, so a test can act while it is in flight.
const unwritable = vi.hoisted(() => ({
  refuses: (_path: string): boolean => false,
  held: null as { path: string; release: Promise<void>; entered: number } | null,
}));
const secretReadGate = vi.hoisted(() => ({ held: null as { path: string; release: Promise<void>; entered: number } | null }));
const sourceChecks = vi.hoisted(() => ({
  paths: new Set<string>(), calls: [] as string[], active: 0, maximum: 0,
  held: null as Promise<void> | null, failure: null as Error | null,
}));
const catalogueGate = vi.hoisted(() => ({ held: null as Promise<void> | null, entered: 0 }));
vi.mock("@main/i18n", async (original) => {
  const actual = await original<typeof import("@main/i18n")>();
  return {
    ...actual,
    loadInterfaceCatalogue: async (...args: Parameters<typeof actual.loadInterfaceCatalogue>) => {
      if (catalogueGate.held !== null) {
        catalogueGate.entered += 1;
        await catalogueGate.held;
      }
      return actual.loadInterfaceCatalogue(...args);
    },
  };
});
// Runs while a refused removal is in flight, the way another card's save can.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      if (!sourceChecks.paths.has(String(args[0]))) return actual.realpath(...args);
      sourceChecks.calls.push(String(args[0]));
      sourceChecks.maximum = Math.max(sourceChecks.maximum, ++sourceChecks.active);
      try {
        await sourceChecks.held;
        if (sourceChecks.failure !== null) throw sourceChecks.failure;
        return await actual.realpath(...args);
      } finally { sourceChecks.active -= 1; }
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const held = secretReadGate.held;
      if (held !== null && held.path === String(args[0])) {
        held.entered += 1;
        await held.release;
      }
      return actual.readFile(...args);
    },
    rm: async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
      if (outputFaults.refuseCleanup && basename(String(path)).startsWith(".mumbler-save-")) throw new Error("staging cleanup denied");
      if (undeletable.has(String(path))) {
        throw new Error("EACCES: permission denied");
      }
      return actual.rm(path, options);
    },
    rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
      if (outputFaults.failTarget === String(to)) throw new Error("publish refused");
      if (unmovable.has(String(from))) throw new Error("EBUSY: resource busy or locked");
      const held = unwritable.held;
      if (held !== null && held.path === String(to)) {
        held.entered += 1;
        await held.release;
      }
      if (unwritable.refuses(String(to))) throw new Error("ENOSPC: no space left on device");
      const result = await actual.rename(from, to);
      if (basename(String(from)) === "config.json") {
        const run = afterResetMove.run;
        afterResetMove.run = null;
        await run?.();
      }
      return result;
    },
  };
});

// Managed ffmpeg/ffprobe are a separate boundary with their own tests; keeping
// them inert makes this a local, deterministic test of the card rules.
vi.mock("@main/core/binaries/manager", () => ({
  ToolManager: class {
    async reconcile(): Promise<void> {}
    cancelAll(): void {}
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
  cleanupFailure: false,
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
// No ffmpeg here: a tag rewrite hands the audio back as it was and reports the
// tags it was asked to write, as ffprobe would read them back.
// The waveform summary: each run is held until the test settles it.
const waveforms = vi.hoisted(() => ({
  runs: [] as Array<{ path: string; signal?: AbortSignal; settle: (peaks: Float32Array) => void; fail: (error: Error) => void }>,
}));
const tagWrites = vi.hoisted(() => ({
  calls: [] as string[][],
  failure: null as Error | null,
  readBack: new Map<string, Record<string, string>>(),
}));
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
      const prepared = await actual.prepareAudioForTranscription(params);
      if (audioGate.cleanupFailure) {
        await mkdir(params.scratchDir, { recursive: true });
        const preparedPath = join(params.scratchDir, "prepared-save.wav");
        await writeFile(preparedPath, await readFile(prepared.filePath));
        return { ...prepared, filePath: preparedPath, cleanup: async () => {
          throw new Error("prepared audio cleanup refused");
        } };
      }
      return prepared;
    },
    rewriteAudioTags: async (params: Parameters<typeof actual.rewriteAudioTags>[0]) => {
      tagWrites.calls.push(params.tagArgs);
      if (tagWrites.failure !== null) throw tagWrites.failure;
      const written: Record<string, string> = {};
      for (let index = 0; index < params.tagArgs.length - 1; index += 1) {
        if (params.tagArgs[index] !== "-metadata") continue;
        const [name, ...value] = params.tagArgs[index + 1]!.split("=");
        if (value.join("=") !== "") written[name === "origination_date" ? "date" : name === "origination_time" ? "creation_time" : name!] = value.join("=");
      }
      tagWrites.readBack.set(params.sourceFilePath, written);
      return { filePath: params.sourceFilePath, mimeType: "audio/wav", wasDerived: false, cleanup: async () => undefined };
    },
    computeWaveformPeaks: (path: string, signal?: AbortSignal) => new Promise<Float32Array>((resolve, reject) => {
      waveforms.runs.push({ path, signal, settle: resolve, fail: reject });
      signal?.addEventListener("abort", () => reject(new CancelledError("stopped")), { once: true });
    }),
    probeRecordingTags: async (path: string, signal?: AbortSignal) =>
      tagWrites.readBack.get(path) ?? tagWrites.readBack.get(basename(path)) ?? actual.probeRecordingTags(path, signal),
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

const { ApplicationRuntime, startupFailureDiagnostic } = await import("@main/core/app-runtime");
const { createDefaultSettings } = await import("@main/core/settings-schema");
const { QueueStore } = await import("@main/core/queue-store");
const cardPipeline = await import("@main/core/card-pipeline");
const backupStore = await import("@main/core/backupStore");

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
  return { ...item, copyToBackupOnConfirm: false, localTimestampText: "2026-03-01 07:30:00", timezone: "Asia/Tokyo", ...edits };
}

// First launch saves the computer's zone as the import zone, as a concrete zone
// (timestamp-conventions, Time zones); nothing else is written until the user
// changes a setting.
const FIRST_LAUNCH = { ...header("config"), defaultTimezone: getSystemTimezone() };

async function savedSettings(): Promise<unknown> {
  return JSON.parse(await readFile(join(home, "config.json"), "utf8"));
}

/** The queue as its files hold it; instants stay ISO text. */
function savedQueue(): ReturnType<typeof readSavedQueue> {
  return readSavedQueue({ cardsDir: join(home, "cards"), inboxDir: join(home, "inbox") });
}

/** The queue's own store on this test's data folder, for seeding saved state
 * while the app is shut down. */
function diskStore(): InstanceType<typeof QueueStore> {
  return new QueueStore({ cardsDir: join(home, "cards"), inboxDir: join(home, "inbox") });
}

const quietLogger = () => ({
  debug: vi.fn(async () => undefined), info: vi.fn(async () => undefined), warn: vi.fn(async () => undefined),
  error: vi.fn(async () => undefined), providerCall: vi.fn(async () => undefined),
});

/** The saved queue as a launch reads it. */
async function loadDisk(): Promise<{ cards: MumblerCard[]; pendingImports: PendingImportReviewItem[] }> {
  return (await diskStore().load(quietLogger())).state;
}

/** Writes each card's file, creating its folder. */
async function saveDiskCards(saved: MumblerCard[]): Promise<void> {
  const store = diskStore();
  for (const card of saved) {
    await mkdir(join(home, "cards", card.id), { recursive: true });
    await store.writeCard(card);
  }
}

/** A card's own file as it is on disk. */
async function savedCard(cardId: string): Promise<MumblerCard> {
  return JSON.parse(await readFile(join(home, "cards", cardId, "card.json"), "utf8")) as MumblerCard;
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
  outputFaults.failTarget = null;
  outputFaults.refuseCleanup = false;
  unmovable.clear();
  unwritable.refuses = () => false;
  unwritable.held = null;
  secretReadGate.held = null;
  sourceChecks.paths.clear();
  sourceChecks.calls = [];
  sourceChecks.active = sourceChecks.maximum = 0;
  sourceChecks.held = null;
  sourceChecks.failure = null;
  catalogueGate.held = null;
  catalogueGate.entered = 0;
  audioGate.cleanupFailure = false;
  audioGate.held = null;
  audioGate.entered = 0;
  probeGate.held = null;
  probeGate.entered = 0;
  probeGate.onEnter = null;
  importStarts.length = 0;
  trimGate.held = null;
  trimGate.entered = 0;
  waveforms.runs = [];
  tagWrites.calls = [];
  tagWrites.failure = null;
  tagWrites.readBack.clear();
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

describe("first-run setup and user-owned destinations", () => {
  it.each([
    ["pickOutputDirectory", "outputDirectory", "defaultOutputDirectory", "dialog.chooseOutputFolder"],
    ["pickBackupDirectory", "backupDirectory", "defaultBackupDirectory", "settings.backupDirectory"],
  ] as const)("initializes %s from current intent without saving", async (method, field, defaultField, title) => {
    const owner = {} as never;
    const saved = join(root, "saved", field);
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), [field]: saved });
    const before = await savedSettings();
    const selected = join(root, "$MUMBLER_PICKER_PART", "%MUMBLER_PICKER_PART%", "selected ");
    const picker = vi.mocked(dialog.showOpenDialog);
    const check = async (value: string | undefined, literal: string | undefined, expected: string) => {
      picker.mockResolvedValueOnce({ canceled: false, filePaths: [selected] });
      expect(await runtime[method](owner, value, literal)).toBe(selected);
      expect(picker).toHaveBeenLastCalledWith(owner, {
        title: runtime.translator().t(title), defaultPath: expected, properties: ["openDirectory", "createDirectory"],
      });
      expect(await savedSettings()).toEqual(before);
    };
    vi.stubEnv("MUMBLER_PICKER_PART", "expanded");
    try {
      await check(undefined, undefined, saved);
      await check("~/typed", saved, join(homedir(), "typed"));
      await check("$MUMBLER_PICKER_PART/relative", saved, join(homedir(), "expanded", "relative"));
      await check(selected, selected, selected);
      await check("", saved, runtime.getSettingsDraft()[defaultField]);
      picker.mockResolvedValueOnce({ canceled: true, filePaths: [selected] });
      expect(await runtime[method](owner, saved, saved)).toBeNull();
      picker.mockResolvedValueOnce({ canceled: false, filePaths: [] });
      expect(await runtime[method](owner, saved, saved)).toBeNull();
      expect(await savedSettings()).toEqual(before);
    } finally { vi.unstubAllEnvs(); }
  });

  it("keeps dismissed setup consumed in later window snapshots without writing skipped choices", async () => {
    expect(runtime.getSnapshot().firstRun).toBe(true);
    runtime.dismissFirstRunSetup();
    expect(runtime.getSnapshot().firstRun).toBe(false);
    expect(await savedSettings(), "only the first-launch zone is saved").toEqual(FIRST_LAUNCH);
    expect(await exists(join(home, "api-keys.json"))).toBe(false);
  });

  it.each([undefined, "redirected"])("preserves literal picker names through setup, originals selection and reopening (environment: %s)", async (value) => {
    vi.stubEnv("MUMBLER_TEST_PICKED", value);
    const output = join(root, "$MUMBLER_TEST_PICKED", "exports ");
    const originals = join(root, "%MUMBLER_TEST_PICKED%", "originals");
    const picker = vi.spyOn(runtime, "pickOutputDirectory").mockResolvedValueOnce(output);
    try {
      expect((await runtime.chooseOutputDirectory({} as never)).settingsSummary?.outputDirectory).toBe(output);
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [originals] });
      await runtime.chooseOriginalsDirectory({} as never);
      await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), theme: "dark" });
      await runtime.shutdown();
      runtime = await ApplicationRuntime.initialize();
      expect(runtime.getSnapshot().startupDiagnostic).toBeNull();
      expect(runtime.getSnapshot().settingsSummary).toMatchObject({ outputDirectory: output, backupDirectory: originals });
      await runtime.openOutputDirectory();
      expect(shell.openPath).toHaveBeenLastCalledWith(output);
    } finally { picker.mockRestore(); vi.unstubAllEnvs(); }
  });

  it("offers setup for a new root, saves only the first-launch zone, and offers it again until it is finished", async () => {
    expect(runtime.getSnapshot().firstRun).toBe(true);
    expect(await savedSettings(), "only the first-launch zone is saved").toEqual(FIRST_LAUNCH);
    // The electron stand-in reports /tmp as the Documents folder.
    expect(runtime.getSnapshot().settingsSummary?.defaultOutputDirectory).toBe(join("/tmp", "Mumbler"));
    await runtime.shutdown();
    runtime = await ApplicationRuntime.initialize();
    expect(runtime.getSnapshot().firstRun, "a quit partway through setup brings it back").toBe(true);
    await runtime.dismissFirstRunSetup();
    expect(runtime.getSnapshot().firstRun).toBe(false);
    await runtime.shutdown();
    runtime = await ApplicationRuntime.initialize();
    expect(runtime.getSnapshot().firstRun, "finished setup does not repeat").toBe(false);
    expect(await savedSettings(), "only the first-launch zone is saved").toEqual(FIRST_LAUNCH);
  });

  it("saves a chosen output folder alone, without moving or creating output files", async () => {
    const destination = join(root, "chosen");
    const snapshot = await runtime.saveSetupDirectory(destination);
    expect(snapshot.settingsSummary).toMatchObject({ outputDirectory: destination, backupDirectory: null });
    expect(await exists(destination)).toBe(false);
    const saved = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    expect(saved).toMatchObject({ outputDirectory: destination });
    expect(saved, "the output folder is an inbox; Recordings is never put inside it").not.toHaveProperty("backupDirectory");
  });

  it("saves setup's Recordings folder and confirmed time zone, refusing what it cannot use", async () => {
    const recordings = join(root, "Recordings");
    expect((await runtime.saveSetupRecordingsDirectory(recordings)).settingsSummary?.backupDirectory).toBe(recordings);
    expect((await runtime.saveSetupTimezone("Asia/Tokyo")).settingsSummary?.defaultTimezone).toBe("Asia/Tokyo");
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8"))).toMatchObject({ backupDirectory: recordings, defaultTimezone: "Asia/Tokyo" });
    await expect(runtime.saveSetupRecordingsDirectory("relative")).rejects.toThrow(/Recordings folder/);
    await expect(runtime.saveSetupTimezone("Mars/Olympus")).rejects.toThrow(/time zone/);
    expect((await runtime.saveSetupTimezone("system")).settingsSummary?.defaultTimezone, "System is offered").toBe("system");
    expect(await exists(recordings), "nothing is created until a recording is added").toBe(false);
  });

  it("keeps existing originals choices and unrelated unsupported settings during setup", async () => {
    await runtime.shutdown();
    const originals = join(root, "existing-originals");
    await writeFile(join(home, "config.json"), JSON.stringify({ ...header("config"), backupDirectory: originals, concurrencyLimit: "future", futureChoice: { keep: true } }));
    runtime = await ApplicationRuntime.initialize();
    expect(runtime.getSnapshot().firstRun, "setup the first launch left unfinished is still offered").toBe(true);
    await runtime.saveSetupDirectory(join(root, "chosen"));
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8"))).toMatchObject({ backupDirectory: originals, concurrencyLimit: "future", futureChoice: { keep: true } });
  });

  it("keeps a reviewed import and its original untouched until an originals folder is chosen", async () => {
    const [pending] = await dropIn("take.wav");
    await expect(runtime.confirmPendingImports([review(pending, { copyToBackupOnConfirm: true, deleteOriginalOnConfirm: true })])).rejects.toThrow(/Choose a Recordings folder/);
    expect(await readFile(pending.originalSourcePath, "utf8")).toBe("audio for take.wav");
    expect(runtime.getSnapshot().state?.pendingImports).toHaveLength(1);
    expect(cards(runtime.getSnapshot())).toEqual([]);
  });

  it("cancelling the folder picker writes no settings", async () => {
    const picker = vi.spyOn(runtime, "pickOutputDirectory").mockResolvedValueOnce(null);
    try {
      const snapshot = await runtime.chooseOutputDirectory({} as never);
      expect(snapshot.settingsSummary?.outputDirectory).toBeNull();
      expect(await savedSettings(), "only the first-launch zone is saved").toEqual(FIRST_LAUNCH);
    } finally { picker.mockRestore(); }
  });
});

describe("the durable queue store", () => {
  // A card's or pending import's folder, which a removal renames aside.
  const folderOf = (kind: "card" | "pending import", id: string) => join(home, kind === "card" ? "cards" : "inbox", id);

  it.each(["card", "pending import"] as const)("keeps %s audio when its folder cannot be renamed aside", async (kind) => {
    const [pending] = await dropIn("retain.wav");
    const card = kind === "card" ? cards((await runtime.confirmPendingImports([review(pending)])).snapshot)[0]! : null;
    const audio = card?.sourceFilePath ?? pending.workingFilePath;
    unmovable.add(folderOf(kind, pending.id));
    try {
      const removal = card ? runtime.removeCard(card.id) : runtime.cancelPendingImports([pending.id]);
      await expect(removal).rejects.toThrow();
      expect(await readFile(audio, "utf8")).toBe("audio for retain.wav");
      expect(card ? cards(runtime.getSnapshot()).some((entry) => entry.id === card.id)
        : runtime.getSnapshot().state?.pendingImports.some((entry) => entry.id === pending.id)).toBe(true);
    } finally { unmovable.clear(); }
    await runtime.shutdown();
    runtime = await ApplicationRuntime.initialize();
    expect(card ? cards(runtime.getSnapshot()).map((entry) => entry.id)
      : runtime.getSnapshot().state?.pendingImports.map((entry) => entry.id), "a relaunch still has it").toEqual([pending.id]);
  });

  it.each(["card", "pending import"] as const)("keeps %s audio until its folder's rename aside lands, then deletes the folder", async (kind) => {
    const [pending] = await dropIn("retain.wav");
    const card = kind === "card" ? cards((await runtime.confirmPendingImports([review(pending)])).snapshot)[0]! : null;
    const audio = card?.sourceFilePath ?? pending.workingFilePath;
    let release!: () => void;
    const aside = join(dirname(folderOf(kind, pending.id)), `.removed-${pending.id}`);
    unwritable.held = { path: aside, entered: 0, release: new Promise<void>((resolve) => { release = resolve; }) };
    const removal = card ? runtime.removeCard(card.id) : runtime.cancelPendingImports([pending.id]);
    try {
      await until(() => expect(unwritable.held!.entered).toBe(1));
      expect(await readFile(audio, "utf8")).toBe("audio for retain.wav");
    } finally { release(); await removal; unwritable.held = null; }
    expect(await exists(dirname(audio)), "the whole folder goes").toBe(false);
    expect(await exists(aside)).toBe(false);
  });

  it("restores audio-tool availability and surviving key presence after Reset from failed startup", async () => {
    await runtime.setGeminiApiKey("retained-test-key");
    await runtime.shutdown();
    // No card or import file halts launch as damaged, so the store's load stands in.
    const { QueueStore } = await import("@main/core/queue-store");
    const { CorruptStateError } = await import("@main/core/json-store");
    vi.spyOn(QueueStore.prototype, "load").mockRejectedValueOnce(new CorruptStateError(join(home, "cards"), "damaged"));
    runtime = await ApplicationRuntime.initialize();
    expect(runtime.getSnapshot().startupDiagnostic?.canReset).toBe(true);
    expect(runtime.getSnapshot().dependencies).toBeNull();

    const snapshot = await runtime.resetState();

    expect(snapshot.startupDiagnostic).toBeNull();
    expect(snapshot.dependencies).not.toBeNull();
    expect(snapshot.settingsSummary?.hasGeminiApiKey).toBe(true);
    expect(runtime.getSettingsDraft().hasGeminiApiKey).toBe(true);
    expect((await dropIn("after-reset.wav"))).toHaveLength(1);
  });

  it("reports completed reset moves when a later store becomes newer before its move", async () => {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), defaultTimezone: "Europe/Berlin" });
    const path = join(home, "cards", card.id, "card.json");
    const newer = JSON.stringify({ ...header("card", 99), id: card.id });
    afterResetMove.run = () => writeFile(path, newer);
    try {
      const snapshot = await runtime.resetState();
      expect(snapshot.startupDiagnostic).toEqual({
        title: { key: "diagnostic.resetTitle" },
        message: { key: "diagnostic.resetMovedBody", values: { items: ["config.json"], folder: home } },
        canReset: false,
      });
      expect(await readFile(path, "utf8")).toBe(newer);
      expect((await readdir(home)).filter((name) => name.endsWith(".invalid")).map((name) => name.replace(/-\d.*$/, ""))).toEqual(["config"]);
      expect(await exists(card.sourceFilePath)).toBe(true);
    } finally { afterResetMove.run = null; }
  });

  it("resets saved work around a newer layout.json, leaving it as it is and unwritten", async () => {
    const [pending] = await dropIn("take.wav");
    await runtime.confirmPendingImports([review(pending)]);
    const path = join(home, "layout.json");
    const newer = JSON.stringify({ ...header("layout", 2), queueWidth: 400 });
    await writeFile(path, newer);

    const snapshot = await runtime.resetState();

    expect(snapshot.startupDiagnostic).toBeNull();
    expect(cards(snapshot)).toEqual([]);
    await runtime.saveLayout(430);
    expect(await readFile(path, "utf8")).toBe(newer);
  });

  it.each(["config.json", "cards/lost/card.json", "inbox/lost/import.json"])(
    "refuses reset before moving any sibling when %s is newer", async (name) => {
      const [pending] = await dropIn("take.wav");
      const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
      await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), defaultTimezone: "Europe/Berlin" });
      const newerPath = join(home, name);
      await mkdir(dirname(newerPath), { recursive: true });
      const kind = name === "config.json" ? "config" : name.startsWith("cards/") ? "card" : "pendingImport";
      const text = JSON.stringify({ ...header(kind, 99), id: "lost", transcription: { text: "future words" } });
      await writeFile(newerPath, text);
      const storePaths = ["config.json", `cards/${card.id}/card.json`, "layout.json"].map((file) => join(home, file));
      const before = await Promise.all(storePaths.map((path) => readFile(path, "utf8").catch(() => null)));
      const snapshot = await runtime.resetState();
      expect(snapshot.startupDiagnostic).toEqual({
        title: { key: "diagnostic.newerTitle" },
        message: { key: "diagnostic.newerBody", values: { path: newerPath } },
        canReset: false,
      });
      expect(await Promise.all(storePaths.map((path) => readFile(path, "utf8").catch(() => null)))).toEqual(before);
      expect(await readFile(newerPath, "utf8")).toBe(text);
      expect((await readdir(home)).filter((file) => file.endsWith(".invalid"))).toEqual([]);
      expect(await exists(card.sourceFilePath)).toBe(true);
      expect(cards(snapshot)).toHaveLength(1);
    },
  );

  it("sets the queue's folders aside together on reset", async () => {
    const [pending, other] = await dropIn("take.wav", "other.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    await runtime.resetState();
    expect(await exists(join(home, "cards"))).toBe(false);
    expect(await exists(join(home, "inbox"))).toBe(false);
    const preserved = (await readdir(home)).find((name) => /^queue-.*\.invalid$/.test(name));
    expect(preserved).toBeDefined();
    expect(await readFile(join(home, preserved!, "cards", card.id, basename(card.sourceFilePath)), "utf8")).toBe("audio for take.wav");
    expect(await exists(join(home, preserved!, "inbox", other.id, "import.json"))).toBe(true);
  });

  it("names a damaged card at launch with its path, leaves it untouched and loads the others", async () => {
    const [first, second] = await dropIn("take.wav", "next.wav");
    const [kept, damaged] = cards((await runtime.confirmPendingImports([review(first), review(second, { localTimestampText: "2026-03-01 08:30:00" })])).snapshot);
    await runtime.shutdown();
    const path = join(home, "cards", damaged.id, "card.json");
    await writeFile(path, "{ half a card");
    runtime = await ApplicationRuntime.initialize();
    expect(cards(runtime.getSnapshot()).map((entry) => entry.id)).toEqual([kept.id]);
    expect(runtime.getSnapshot().appWideError?.message).toEqual({ key: "diagnostic.itemsUnreadableBody", values: { items: [path] } });
    expect(await readFile(path, "utf8")).toBe("{ half a card");
    expect(await readFile(damaged.sourceFilePath, "utf8")).toBe("audio for next.wav");
    await runtime.dismissAppWideError();
    expect(runtime.getSnapshot().appWideError).toBeNull();
  });

  it("shows the unreadable files after the settings notice, one after the other", async () => {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    await runtime.shutdown();
    const config = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    await writeFile(join(home, "config.json"), JSON.stringify({ ...config, concurrencyLimit: "future" }));
    await writeFile(join(home, "cards", card.id, "card.json"), "{ half a card");
    runtime = await ApplicationRuntime.initialize();

    expect(runtime.getSnapshot().appWideError?.title).toEqual({ key: "diagnostic.settingsUnusableTitle" });
    await runtime.dismissAppWideError();
    expect(runtime.getSnapshot().appWideError?.title).toEqual({ key: "diagnostic.itemsUnreadableTitle" });
    await runtime.dismissAppWideError();
    expect(runtime.getSnapshot().appWideError).toBeNull();
  });

  it("halts on a card file it cannot read, moving nothing and offering no Reset", async () => {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    await runtime.shutdown();
    const path = join(home, "cards", card.id, "card.json");
    await rm(path, { force: true });
    await mkdir(path);
    runtime = await ApplicationRuntime.initialize();
    expect(runtime.getSnapshot().startupDiagnostic).toEqual({
      title: { key: "diagnostic.unreadableTitle" },
      message: { key: "diagnostic.unreadableBody", values: { path } },
      canReset: false,
    });
    expect((await stat(path)).isDirectory()).toBe(true);
    expect((await readdir(home)).filter((entry) => entry.endsWith(".invalid"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("preserves saved work and names an import folder it cannot read", async () => {
    const [pending] = await dropIn("retained.wav");
    await runtime.shutdown();
    const folder = dirname(pending.workingFilePath);
    const before = await readFile(join(folder, "import.json"), "utf8");
    await chmod(folder, 0o000);
    try {
      runtime = await ApplicationRuntime.initialize();
      expect(runtime.getSnapshot().startupDiagnostic).toEqual({
        title: { key: "diagnostic.unreadableTitle" },
        message: { key: "diagnostic.unreadableBody", values: { path: join(folder, "import.json") } },
        canReset: false,
      });
      expect(runtime.getSnapshot().state).toBeNull();
    } finally { await chmod(folder, 0o700); }
    expect(await readFile(join(folder, "import.json"), "utf8")).toBe(before);
    expect(await readFile(pending.workingFilePath, "utf8")).toBe("audio for retained.wav");
    expect((await readdir(home)).filter((entry) => entry.endsWith(".invalid"))).toEqual([]);
  });

  it("names a cards folder it cannot list, removing nothing", async () => {
    await runtime.shutdown();
    // readdir on a file returns the real Node ENOTDIR/scandir error.
    await writeFile(join(home, "cards"), "not a folder");
    runtime = await ApplicationRuntime.initialize();
    expect(runtime.getSnapshot().startupDiagnostic).toEqual({
      title: { key: "diagnostic.unreadableTitle" },
      message: { key: "diagnostic.unreadableBody", values: { path: join(home, "cards") } },
      canReset: false,
    });
    expect(await readFile(join(home, "cards"), "utf8")).toBe("not a folder");
  });

  it("does not classify a logger failure carrying a path during the queue load as an unreadable saved file", async () => {
    const [pending] = await dropIn("missing.wav");
    await runtime.shutdown();
    await rm(pending.workingFilePath);
    const before = await readFile(join(dirname(pending.workingFilePath), "import.json"), "utf8");
    const { QueueStore } = await import("@main/core/queue-store");
    const load = QueueStore.prototype.load;
    const loggerFailure = await access(join(home, "records.sqlite3", "blocked-log"))
      .then(() => { throw new Error("The logger fixture unexpectedly became a directory."); }, (error: unknown) => error);
    expect(loggerFailure).toMatchObject({ syscall: "access", path: join(home, "records.sqlite3", "blocked-log") });
    let restoreWarn = (): void => undefined;
    const failingLogger = vi.spyOn(QueueStore.prototype, "load").mockImplementationOnce(async function (this: InstanceType<typeof QueueStore>, logger) {
      const warn = vi.spyOn(logger, "warn").mockRejectedValueOnce(loggerFailure);
      restoreWarn = () => warn.mockRestore();
      return load.call(this, logger);
    });
    try {
      runtime = await ApplicationRuntime.initialize();
      expect(runtime.getSnapshot().startupDiagnostic).toEqual({
        title: { key: "diagnostic.startupTitle" },
        message: { key: "diagnostic.startupBody" },
        canReset: false,
      });
      expect(await readFile(join(dirname(pending.workingFilePath), "import.json"), "utf8")).toBe(before);
    } finally { restoreWarn(); failingLogger.mockRestore(); }
  });

  it("offers no Reset for a startup failure that is not a damaged work file", () => {
    expect(startupFailureDiagnostic(new Error("storage could not be prepared"))).toEqual({
      title: { key: "diagnostic.startupTitle" },
      message: { key: "diagnostic.startupBody" },
      canReset: false,
    });
  });

  it("leaves an import folder a quit cut short in place at launch, and lists nothing from it", async () => {
    await runtime.shutdown();
    await mkdir(join(home, "inbox", "cutshort"), { recursive: true });
    await writeFile(join(home, "inbox", "cutshort", "take.wav"), "partial copy");

    runtime = await ApplicationRuntime.initialize();

    expect(runtime.getSnapshot().state!.pendingImports).toEqual([]);
    expect(await readFile(join(home, "inbox", "cutshort", "take.wav"), "utf8")).toBe("partial copy");
  });
});

describe("a crash between the queue's writes", () => {
  /** Copies the data folder as it is at this moment, the way a crash leaves
   * it, and points the next launch at the copy. */
  async function crashHere(): Promise<string> {
    const crashed = join(root, `crashed-${Date.now()}`);
    await cp(home, crashed, { recursive: true });
    return crashed;
  }

  async function launchOn(folder: string): Promise<void> {
    await runtime.shutdown();
    home = folder;
    process.env.MUMBLER_DATA_DIR = folder;
    runtime = await ApplicationRuntime.initialize();
  }

  /** Holds the atomic write onto `path` at its final rename until released. */
  function holdWrite(path: string): () => void {
    let release!: () => void;
    unwritable.held = { path, entered: 0, release: new Promise<void>((resolve) => { release = resolve; }) };
    return () => { release(); unwritable.held = null; };
  }

  it.each([
    ["while its card file is staged in the import's folder", "card"],
    ["after its card file was staged and before the folder's rename", "folder"],
  ] as const)("keeps an import for review when a confirmation is cut short %s", async (_moment, held) => {
    const [pending] = await dropIn("take.wav");
    const release = holdWrite(held === "card" ? join(home, "inbox", pending.id, "card.json") : join(home, "cards", pending.id));
    const confirming = runtime.confirmPendingImports([review(pending)]);
    let crashed: string;
    try {
      await until(() => expect(unwritable.held!.entered).toBe(1));
      expect(await exists(join(home, "cards", pending.id)), "the folder has not moved").toBe(false);
      crashed = await crashHere();
    } finally { release(); await confirming.catch(() => undefined); }

    await launchOn(crashed);

    const state = runtime.getSnapshot().state!;
    expect(state.cards).toEqual([]);
    expect(state.pendingImports.map((item) => item.id)).toEqual([pending.id]);
    expect(state.pendingImports[0].workingFilePath).toBe(join(crashed, "inbox", pending.id, "take.wav"));
    expect(await readFile(state.pendingImports[0].workingFilePath, "utf8")).toBe("audio for take.wav");
    expect((await readdir(join(crashed, "inbox", pending.id))).sort(), "no card file is left with the review").toEqual(["import.json", "take.wav"]);
    expect(await readdir(join(crashed, "cards")).catch(() => [])).toEqual([]);
    expect(cards((await runtime.confirmPendingImports([review(state.pendingImports[0])])).snapshot)).toHaveLength(1);
  });

  it("keeps the card when a confirmation is cut short after the folder's rename and before the import's file is removed", async () => {
    const [pending] = await dropIn("take.wav");
    const leftover = join(home, "cards", pending.id, "import.json");
    undeletable.add(leftover);
    try {
      expect(cards((await runtime.confirmPendingImports([review(pending)])).snapshot).map((card) => card.id)).toEqual([pending.id]);
      expect(await exists(leftover)).toBe(true);
    } finally { undeletable.clear(); }

    await launchOn(await crashHere());

    expect(cards(runtime.getSnapshot()).map((card) => card.id)).toEqual([pending.id]);
    expect(runtime.getSnapshot().state!.pendingImports).toEqual([]);
    expect((await readdir(join(home, "cards", pending.id))).sort(), "the import's file is cleared").toEqual(["card.json", "take.wav"]);
  });

  it("keeps the import for review when its folder cannot be renamed into cards/", async () => {
    const [pending] = await dropIn("take.wav");
    unmovable.add(join(home, "inbox", pending.id));
    try {
      await expect(runtime.confirmPendingImports([review(pending)])).rejects.toThrow();
    } finally { unmovable.clear(); }

    const [kept] = runtime.getSnapshot().state!.pendingImports;
    expect(kept.workingFilePath).toBe(pending.workingFilePath);
    expect((await readdir(join(home, "inbox", pending.id))).sort(), "the staged card file is gone").toEqual(["import.json", "take.wav"]);
    expect(cards((await runtime.confirmPendingImports([review(kept)])).snapshot).map((card) => card.id), "confirming again works").toEqual([pending.id]);
  });

  it("makes cards of the imports accepted before one that fails, and keeps that one and the rest for review", async () => {
    const [first, second, third] = await dropIn("one.wav", "two.wav", "three.wav");
    unmovable.add(join(home, "inbox", second.id));
    try {
      await expect(runtime.confirmPendingImports([review(first), review(second), review(third)])).rejects.toThrow();
    } finally { unmovable.clear(); }
    expect(cards(runtime.getSnapshot()).map((card) => card.id)).toEqual([first.id]);
    expect(runtime.getSnapshot().state!.pendingImports.map((item) => item.id)).toEqual([second.id, third.id]);
    await runtime.shutdown();
    runtime = await ApplicationRuntime.initialize();
    expect(cards(runtime.getSnapshot()).map((card) => card.id)).toEqual([first.id]);
    expect(runtime.getSnapshot().state!.pendingImports.map((item) => item.id).sort()).toEqual([second.id, third.id].sort());
  });

  it("clears scratch and staged card files a crash left in a listed card's folder, and nothing else", async () => {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    await runtime.shutdown();
    const folder = join(home, "cards", card.id);
    await mkdir(join(folder, "temp"), { recursive: true });
    await writeFile(join(folder, "temp", "cut-short.wav"), "trimmed audio");
    await writeFile(join(folder, "card-AbC_9-xy.tmp"), "half a card");

    runtime = await ApplicationRuntime.initialize();

    expect((await readdir(folder)).sort()).toEqual(["card.json", "take.wav"]);
    expect(cards(runtime.getSnapshot())[0].id).toBe(card.id);
  });

  it("writes only its own card when a pipeline step starts, so an interrupted card recovers", async () => {
    const [first, second] = await dropIn("one.wav", "two.wav");
    const [a, b] = cards((await runtime.confirmPendingImports([review(first), review(second, { localTimestampText: "2026-03-01 08:30:00" })])).snapshot);
    await runtime.setGeminiApiKey("test-key");
    const others = [join(home, "cards", b.id, "card.json")];
    const before = await Promise.all(others.map((path) => readFile(path, "utf8")));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.spyOn(cardPipeline, "executeCardPipeline").mockImplementation(async (_id, _step, _mode, ctx) => {
      await Promise.race([held, new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }))]);
    });
    try {
      await runtime.generateCardStep(a.id, "transcription");
      await until(() => expect(run).toHaveBeenCalledOnce());
      expect((await savedCard(a.id)).status).toBe("Transcribing");
      expect(await Promise.all(others.map((path) => readFile(path, "utf8"))), "nothing else is written").toEqual(before);
      const crashed = await crashHere();
      release();
      await launchOn(crashed);
      expect(cards(runtime.getSnapshot()).find((card) => card.id === a.id)).toMatchObject({ status: "Error", lastError: { failedStep: "startup-recovery" } });
    } finally { release(); run.mockRestore(); }
  });
});

describe("confirming what was dropped in", () => {
  it("retains the review and original actions after a refused acceptance", async () => {
    const [pending] = await dropIn("retry.wav");
    const originals = join(home, "originals");
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), backupDirectory: originals });
    const edited = review(pending, { copyToBackupOnConfirm: true, deleteOriginalOnConfirm: true });
    unmovable.add(join(home, "inbox", pending.id));
    try {
      await expect(runtime.confirmPendingImports([edited])).rejects.toThrow();
      expect(runtime.getSnapshot().state?.pendingImports.map((item) => item.id)).toEqual([pending.id]);
      expect(cards(runtime.getSnapshot())).toEqual([]);
      expect(await readFile(pending.originalSourcePath, "utf8")).toBe("audio for retry.wav");
      expect(await readdir(originals).catch(() => []), "no output copy precedes the failed primary import").toEqual([]);
    } finally { unmovable.clear(); }
    const result = await runtime.confirmPendingImports([edited]);
    expect(result.snapshot.state?.pendingImports).toEqual([]);
    expect(cards(result.snapshot)).toHaveLength(1);
    expect(result.originalWarnings).toEqual([]);
    expect(await exists(pending.originalSourcePath)).toBe(false);
    expect(await readdir(originals), "filed under its settled UTC time alone").toEqual(["20260228-223000-utc.wav"]);
  });

  it("preserves an embedded Ogg instant through initial review, confirmation and reopen", async () => {
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), defaultTimezone: "America/New_York" });
    // Keyed by name: the import's folder is named by an id not known yet.
    tagWrites.readBack.set("voice.ogg", { date: "2026-11-01T01:30:00-05:00" });
    const [pending] = await dropIn("voice.ogg");
    expect(pending).toMatchObject({ timestampBasis: "utc", localTimestampText: "2026-11-01 01:30:00", utcTimestampText: "2026-11-01 06:30:00" });
    const result = await runtime.confirmPendingImports([{ ...pending!, copyToBackupOnConfirm: false, deleteOriginalOnConfirm: false }]);
    expect(cards(result.snapshot)[0].timestamps.confirmedUtc).toBe(Date.UTC(2026, 10, 1, 6, 30));
    await runtime.shutdown();
    runtime = await ApplicationRuntime.initialize();
    expect(cards(runtime.getSnapshot())[0].timestamps.confirmedUtc).toBe(Date.UTC(2026, 10, 1, 6, 30));
  });

  it("turns each pending import into a card with the reviewed time, and selects the first", async () => {
    const [pending] = await dropIn("take.wav");

    const { snapshot } = await runtime.confirmPendingImports([
      review(pending, { localTimestampText: "2026-03-01 07:30:00", timezone: "Asia/Tokyo" }),
    ]);

    expect(snapshot.state?.pendingImports).toEqual([]);
    expect(cards(snapshot)).toHaveLength(1);
    const [card] = cards(snapshot);
    expect(card).toMatchObject({
      id: pending.id,
      originalFilename: "take.wav",
      sourceFilePath: join(home, "cards", pending.id, "take.wav"),
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

    const persisted = { value: await savedQueue() };
    expect(persisted.value.cards.map((entry) => entry.id)).toEqual([card.id]);
    expect(persisted.value.pendingImports).toEqual([]);
    expect(await readFile(card.sourceFilePath, "utf8"), "the import's folder became the card's").toBe("audio for take.wav");
    expect(await exists(dirname(pending.workingFilePath))).toBe(false);
  });

  it("orders the cards by when they were recorded, not by when they were dropped in", async () => {
    const pending = await dropIn("later.wav", "earlier.wav");

    const { snapshot } = await runtime.confirmPendingImports([
      review(pending[0], { localTimestampText: "2026-03-02 10:00:00" }),
      review(pending[1], { localTimestampText: "2026-03-01 10:00:00" }),
    ]);

    expect(cards(snapshot).map((card) => card.originalFilename)).toEqual(["earlier.wav", "later.wav"]);
  });

  // File dates a copy, an archive or an unset clock leaves are set here on real
  // files; Git keeps no file dates, so the shared corpus cannot carry them.
  it.each([
    ["Unix zero", Date.UTC(1970, 0, 1)],
    ["the 1980 floor of ZIP and FAT dates", Date.UTC(1980, 0, 1)],
    ["2099, an unset recorder clock", Date.UTC(2099, 11, 31)],
  ])("offers no file date left at %s, and prefills nothing from it", async (_case, ms) => {
    const path = join(sourceDir, "kitchen-table.m4a");
    await writeFile(path, "audio for kitchen-table.m4a");
    await utimes(path, new Date(ms), new Date(ms));
    await runtime.importDroppedPaths([path]);
    const [pending] = runtime.getSnapshot().state!.pendingImports;
    expect(pending!.timeCandidates.filter((candidate) => candidate.source === "file-modified")).toEqual([]);
    expect(pending!.timeCandidates.filter((candidate) => candidate.utcMs === Math.floor(ms / 1000) * 1000)).toEqual([]);
    expect(pending!.localTimestampText).toBe("");
    expect(pending!.parseStatus).toBe("manual-required");
  });

  it("offers a plausible file date as a choice, and still prefills only from the name", async () => {
    const path = join(sourceDir, "20261014-153012.m4a");
    await writeFile(path, "audio for 20261014-153012.m4a");
    const modified = Date.UTC(2026, 9, 15, 1, 0, 0);
    await utimes(path, new Date(modified), new Date(modified));
    await runtime.importDroppedPaths([path]);
    const [pending] = runtime.getSnapshot().state!.pendingImports;
    expect(pending!.timeCandidates).toContainEqual({ source: "file-modified", utcMs: modified, localText: null });
    expect(pending!.localTimestampText).toBe("2026-10-14 15:30:12");
  });

  it("offers the file's own times for review and plays a pending import from its working copy", async () => {
    const [pending] = await dropIn("Shibuya Station.wav");
    const modified = Math.floor((await stat(pending.originalSourcePath)).mtimeMs / 1000) * 1000;
    expect(pending.timeCandidates).toContainEqual({ source: "file-modified", utcMs: modified, localText: null });
    expect(pending.timeCandidates.every((candidate) => candidate.source !== "file-name"), "this name holds no time").toBe(true);
    expect(runtime.resolveCardSourcePath(pending.id)).toBe(pending.workingFilePath);
  });

  it("moves an original into Recordings by default, named by its settled UTC time, and never touches it again", async () => {
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), backupDirectory: join(home, "Recordings") });
    const [pending] = await dropIn("Shibuya Station.wav");
    expect(pending, "move is the default").toMatchObject({ copyToBackupOnConfirm: true, deleteOriginalOnConfirm: true });

    const { snapshot, originalWarnings } = await runtime.confirmPendingImports([
      { ...pending, localTimestampText: "2026-10-14 15:30:12", timezone: "Asia/Tokyo" },
    ]);

    expect(originalWarnings).toEqual([]);
    expect(await exists(pending.originalSourcePath), "the original left its folder").toBe(false);
    const archived = join(home, "Recordings", "20261014-063012-utc.wav");
    expect(await readFile(archived, "utf8")).toBe("audio for Shibuya Station.wav");
    const [card] = cards(snapshot);
    expect(card!.originalFilename, "the card keeps the original name").toBe("Shibuya Station.wav");

    await runtime.removeCard(card!.id);
    expect(await readFile(archived, "utf8"), "removing the card leaves Recordings alone").toBe("audio for Shibuya Station.wav");
  });

  it("files the same recording imported twice once, and still moves the second source away", async () => {
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), backupDirectory: join(home, "Recordings") });
    const time = { localTimestampText: "2026-10-14 15:30:12", timezone: "Asia/Tokyo" };
    const [first] = await dropIn("Shibuya Station.wav");
    await runtime.confirmPendingImports([{ ...first!, ...time }]);
    const [second] = await dropIn("Shibuya Station.wav");
    const { originalWarnings } = await runtime.confirmPendingImports([{ ...second!, ...time }]);

    expect(originalWarnings).toEqual([]);
    expect(await readdir(join(home, "Recordings")), "one copy, not a suffixed second").toEqual(["20261014-063012-utc.wav"]);
    expect(await exists(second!.originalSourcePath), "the source is safe in Recordings, so it goes").toBe(false);
    expect(cards(runtime.getSnapshot()), "each import is still its own card").toHaveLength(2);
  });

  it("copies the original to the backup folder when the user asked for that", async () => {
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), backupDirectory: join(home, "originals") });
    const [pending] = await dropIn("take.wav");

    await runtime.confirmPendingImports([review(pending, { copyToBackupOnConfirm: true, deleteOriginalOnConfirm: false })]);

    expect(await readFile(join(home, "originals", "20260228-223000-utc.wav"), "utf8")).toBe("audio for take.wav");
    expect(await exists(pending.originalSourcePath), "the original is left where it was").toBe(true);
  });

  it("deletes the original when the user asked for that", async () => {
    const [pending] = await dropIn("take.wav");

    const { snapshot } = await runtime.confirmPendingImports([review(pending, { deleteOriginalOnConfirm: true })]);

    expect(await exists(pending.originalSourcePath)).toBe(false);
    expect(await exists(cards(snapshot)[0].sourceFilePath), "the app's own copy stays").toBe(true);
  });

  it.each([
    [false, "replacement"], [true, "replacement"],
    [false, "identical replacement"], [true, "identical replacement"],
    [false, "rewrite"], [true, "rewrite"],
  ] as const)("preserves a changed source during review (archive=%s, %s)", async (copyToBackupOnConfirm, change) => {
    const archive = join(home, "Recordings");
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), backupDirectory: archive });
    const [pending] = await dropIn("changed.wav");
    const original = await readFile(pending.workingFilePath, "utf8");
    if (change !== "rewrite") await rename(pending.originalSourcePath, `${pending.originalSourcePath}.previous`);
    const replacement = change === "identical replacement" ? original : "newer source recording";
    await writeFile(pending.originalSourcePath, replacement);
    const { snapshot, originalWarnings } = await runtime.confirmPendingImports([
      review(pending, { copyToBackupOnConfirm, deleteOriginalOnConfirm: true }),
    ]);
    expect(originalWarnings.length).toBeGreaterThan(0);
    expect(await readFile(pending.originalSourcePath, "utf8")).toBe(replacement);
    expect(await readFile(cards(snapshot)[0]!.sourceFilePath, "utf8")).toBe(original);
    // Filing copies the imported working recording, never the changed source.
    const filed = await readdir(archive).catch(() => []);
    expect(filed).toHaveLength(copyToBackupOnConfirm ? 1 : 0);
    if (copyToBackupOnConfirm) expect(await readFile(join(archive, filed[0]!), "utf8")).toBe(original);
  });

  it.each([false, true])("keeps an archived recording when importing it again (directory alias=%s)", async (alias) => {
    const archive = join(home, "Recordings");
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), backupDirectory: archive });
    const [first] = await dropIn("take.wav");
    await runtime.confirmPendingImports([review(first, { copyToBackupOnConfirm: true, deleteOriginalOnConfirm: true })]);
    const archivedPath = join(archive, "20260228-223000-utc.wav");
    const aliasPath = join(home, "recordings-alias");
    if (alias) await symlink(archive, aliasPath, process.platform === "win32" ? "junction" : "dir");
    await runtime.importDroppedPaths([alias ? join(aliasPath, basename(archivedPath)) : archivedPath]);
    const pending = runtime.getSnapshot().state!.pendingImports[0]!;
    const { originalWarnings } = await runtime.confirmPendingImports([review(pending, { copyToBackupOnConfirm: true, deleteOriginalOnConfirm: true })]);
    expect(originalWarnings).toEqual([]);
    expect(await readFile(archivedPath, "utf8")).toBe("audio for take.wav");
    expect(await readdir(archive)).toEqual(["20260228-223000-utc.wav"]);
  });

  it("preserves sources from an older pending review without identity evidence", async () => {
    const [pending] = await dropIn("old-review.wav");
    await runtime.shutdown();
    const path = join(home, "inbox", pending.id, "import.json");
    const saved = JSON.parse(await readFile(path, "utf8"));
    delete saved.sourceIdentity;
    await writeFile(path, JSON.stringify(saved));
    runtime = await ApplicationRuntime.initialize();
    const { originalWarnings } = await runtime.confirmPendingImports([review(pending, { deleteOriginalOnConfirm: true })]);
    expect(originalWarnings).toHaveLength(1);
    expect(await exists(pending.originalSourcePath)).toBe(true);
    expect(cards(runtime.getSnapshot())).toHaveLength(1);
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
        values: { file: pathValue(pending.originalSourcePath), folder: pathValue(join(root, "blocked")) },
      },
    }]);
  });

  it("warns, naming both paths, when only the backup it was told to make could not be written", async () => {
    const [pending] = await dropIn("take.wav");
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), backupDirectory: join(root, "blocked") });
    await writeFile(join(root, "blocked"), "not a directory");

    const { originalWarnings } = await runtime.confirmPendingImports([review(pending, { copyToBackupOnConfirm: true, deleteOriginalOnConfirm: false })]);

    expect(originalWarnings).toEqual([{
      sourcePath: pending.originalSourcePath,
      message: { key: "import.backupFailed", values: { file: pathValue(pending.originalSourcePath), folder: pathValue(join(root, "blocked")) } },
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
      message: { key: "import.deleteFailed", values: { file: pathValue(pending.originalSourcePath) } },
    }]);
  });

  it("returns no warning when the original was backed up and deleted as asked", async () => {
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), backupDirectory: join(home, "originals") });
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

  it("moves an import's updated time and rewrites its file only when the review changes it", async () => {
    const [pending] = await dropIn("take.wav");
    const itemFile = join(home, "inbox", pending.id, "import.json");
    const stored = await readFile(itemFile, "utf8");

    const editedAt = pending.updatedAtUtc + 60_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(editedAt);
    try {
      const unchanged = await runtime.updatePendingImportDrafts([{ ...pending }]);

      expect(unchanged.state?.pendingImports[0].updatedAtUtc).toBe(pending.updatedAtUtc);
      expect(await readFile(itemFile, "utf8"), "an unchanged draft writes nothing").toBe(stored);

      const edited = await runtime.updatePendingImportDrafts([review(pending)]);

      expect(edited.state?.pendingImports[0].updatedAtUtc).toBe(editedAt);
      expect(await readFile(itemFile, "utf8")).not.toBe(stored);
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
    await importing;
    expect(importStarts).toContain(laterPath);
    expect(runtime.getSnapshot().state?.pendingImports.map((item) => item.originalFilename)).toContain("later.wav");
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
    await runtime.saveSetupDirectory(join(home, "output"));
    const run = { provider: "gemini" as const, model: "gemini-3.7-flash", generatedAtUtc: Date.now() };
    await runtime.shutdown();
    const loaded = await loadDisk();
    const transcribed = loaded.cards.map((card) =>
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
    await saveDiskCards(transcribed);
    runtime = await ApplicationRuntime.initialize();
  }

  async function confirmed(): Promise<MumblerCard> {
    const [pending] = await dropIn("take.wav");
    const { snapshot } = await runtime.confirmPendingImports([review(pending)]);
    return cards(snapshot)[0];
  }

  it.each(["transcription", "structured"] as const)("refuses an incomplete recovered export missing %s", async (missing) => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    await runtime.shutdown();
    const saved = cards(runtime.getSnapshot())[0];
    if (missing === "transcription") saved.transcription.text = null;
    else saved.metadata.structured = null;
    await diskStore().writeCard(saved);
    runtime = await ApplicationRuntime.initialize();
    await expect(runtime.saveCard(card.id)).rejects.toThrow();
    expect(await exists(saved.sourceFilePath)).toBe(true);
    expect(cards(runtime.getSnapshot())).toHaveLength(1);
    expect(await readdir(join(home, "output")).catch(() => [])).toEqual([]);
  });

  it("refuses export after a folder is cleared, retaining the ready card and working recording", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), outputDirectory: "" });
    await expect(runtime.saveCard(card.id)).rejects.toThrow(/Choose a save folder/);
    expect(cards(runtime.getSnapshot())[0].status).toBe("Ready to Save");
    expect(await exists(card.sourceFilePath)).toBe(true);
    expect(await exists(join(home, "output"))).toBe(false);
  });

  it("holds a card that is being saved against every other change until the save ends", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    let release!: () => void;
    audioGate.held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const saving = runtime.saveCard(card.id);
    await until(() => expect(audioGate.entered).toBe(1));

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
    await until(() => expect(trimGate.entered).toBe(1));

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

  it("preserves a saved remote HTTP endpoint and reports that generation cannot use it", async () => {
    await runtime.setGeminiApiKey("AIza-test-key");
    await runtime.shutdown();
    const path = join(home, "config.json");
    const stored = JSON.parse(await readFile(path, "utf8"));
    stored["gemini.endpoint"] = "http://provider.example/v1";
    await writeFile(path, JSON.stringify(stored));
    runtime = await ApplicationRuntime.initialize();
    expect(runtime.getSettingsDraft().geminiEndpoint).toBe(stored["gemini.endpoint"]);
    expect(runtime.getSnapshot().settingsSummary).toMatchObject({ hasGeminiApiKey: true, providerEndpointAllowed: false });
    expect(JSON.parse(await readFile(path, "utf8"))["gemini.endpoint"]).toBe(stored["gemini.endpoint"]);
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), geminiEndpoint: "https://provider.example/v1" });
    expect(runtime.getSnapshot().settingsSummary?.providerEndpointAllowed).toBe(true);
  });

  it("keeps the latest trim when an earlier one finishes analyzing after it", async () => {
    const card = await confirmed();
    let release!: () => void;
    trimGate.held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const earlier = runtime.updateCardTrim(card.id, { frontMarkerSec: 5, backMarkerSec: null });
    await until(() => expect(trimGate.entered).toBe(1));
    trimGate.held = null;
    await runtime.updateCardTrim(card.id, { frontMarkerSec: 9, backMarkerSec: null });
    release();
    await earlier;

    expect(cards(runtime.getSnapshot())[0].trim.frontMarkerSec).toBe(9);
    await runtime.shutdown();
    const persisted = { value: await savedQueue() };
    expect(persisted.value.cards[0].trim.frontMarkerSec).toBe(9);
  });

  it("dates the trim edit when received rather than when held analysis finishes", async () => {
    const card = await confirmed();
    const editedAtUtc = card.updatedAtUtc + 1_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(editedAtUtc);
    let release!: () => void;
    trimGate.held = new Promise<void>((resolve) => { release = resolve; });
    const editing = runtime.updateCardTrim(card.id, { frontMarkerSec: 5, backMarkerSec: null });
    try {
      await until(() => expect(trimGate.entered).toBe(1));
      now.mockReturnValue(editedAtUtc + 60_000);
      release();
      await editing;
      expect(cards(runtime.getSnapshot())[0].updatedAtUtc).toBe(editedAtUtc);
      const stored = { value: await loadDisk() };
      expect(stored.value.cards[0].updatedAtUtc).toBe(editedAtUtc);
    } finally {
      release();
      now.mockRestore();
      await editing.catch(() => undefined);
    }
  });

  it("leaves a card as it was when the trim it already holds is applied again", async () => {
    const card = await confirmed();
    const [trimmed] = cards(await runtime.updateCardTrim(card.id, { frontMarkerSec: 5, backMarkerSec: 200 }));
    const itemFile = join(home, "cards", card.id, "card.json");
    const stored = await readFile(itemFile, "utf8");
    const analyses = trimGate.entered;

    // A later clock, so a trim that stamped the card would show it.
    const now = vi.spyOn(Date, "now").mockReturnValue(trimmed.updatedAtUtc + 60_000);
    const [again] = cards(
      await runtime.updateCardTrim(card.id, { frontMarkerSec: 5, backMarkerSec: 200 }).finally(() => now.mockRestore()),
    );

    expect(trimGate.entered, "no second analysis").toBe(analyses);
    expect(again.updatedAtUtc).toBe(trimmed.updatedAtUtc);
    expect(again.trimDecision).toEqual(trimmed.trimDecision);
    expect(await readFile(itemFile, "utf8"), "nothing is written").toBe(stored);
  });

  it("keeps the held trim when the user returns to it while another is analyzing", async () => {
    const card = await confirmed();
    let release!: () => void;
    trimGate.held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const other = runtime.updateCardTrim(card.id, { frontMarkerSec: 5, backMarkerSec: null });
    await until(() => expect(trimGate.entered).toBe(1));
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
    await until(() => expect(audioGate.entered).toBe(1));
    await runtime.shutdown();

    expect(await outcome).toBe("stopped");
    const persisted = { value: await savedQueue() };
    expect(persisted.value.cards.map((entry) => entry.status)).toEqual(["Ready to Save"]);
    expect(await exists(card.sourceFilePath), "the working audio is kept").toBe(true);
    expect(await readdir(join(home, "output")).catch(() => []), "nothing was published").toEqual([]);
    await expect(runtime.saveCard(card.id), "no save starts while closing").rejects.toThrow(/closing/);
  });

  it("reports a save as saved once its files are out, and keeps the card ready when its folder then cannot be removed", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    // Renaming the card's folder aside is the removal; a cards/ that cannot
    // be written refuses it.
    await chmod(join(home, "cards"), 0o500);
    let result;
    try {
      result = await runtime.saveCard(card.id);
    } finally {
      await chmod(join(home, "cards"), 0o700);
    }

    expect(result.kind).toBe("saved");
    expect((await readdir(join(home, "output"))).length).toBe(3);
    expect(cards(result.snapshot).map((entry) => [entry.id, entry.status]), "the card stays, ready to save again").toEqual([[card.id, "Ready to Save"]]);
    expect(await exists(card.sourceFilePath)).toBe(true);
    expect((await savedQueue()).cards.map((entry) => entry.status)).toEqual(["Ready to Save"]);
  });

  it("preserves the primary save rejection when persisting its ready state also fails", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    const store = (runtime as unknown as { runtime: { queueStore: InstanceType<typeof QueueStore> } }).runtime.queueStore;
    const primary = new Error("saving claim refused");
    vi.spyOn(store, "writeCard").mockRejectedValueOnce(primary).mockRejectedValueOnce(new Error("ready settlement refused"));
    await expect(runtime.saveCard(card.id)).rejects.toBe(primary);
    expect(cards(runtime.getSnapshot())[0].status).toBe("Ready to Save");
    expect(await exists(card.sourceFilePath)).toBe(true);
    await runtime.shutdown();
    expect((await savedQueue()).cards[0].status).toBe("Ready to Save");
  });

  it("returns the partial publication result when persisting its ready state also fails", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    const file = join(home, "cards", card.id, "card.json");
    let writes = 0;
    // The first write claims the card as Saving; the second, handing it back
    // ready, is refused, and the quit writes it.
    unwritable.refuses = (path) => path === file && ++writes === 2;
    const ready = cards(runtime.getSnapshot())[0];
    const stem = `${formatUtcMarker(new Date(ready.timestamps.effectiveUtc))}-old-title`;
    outputFaults.failTarget = join(home, "output", `${stem}.md`);
    const result = await runtime.saveCard(card.id, "overwrite");
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.message.key).toBe("error.saveIncomplete");
      expect(result.files?.map((file) => file.status)).toEqual(["saved", "saved", "failed"]);
    }
    expect(cards(result.snapshot)[0]).toMatchObject({ status: "Ready to Save", metadata: { title: "Old title" } });
    expect(await exists(card.sourceFilePath)).toBe(true);
    await runtime.shutdown();
    expect((await savedQueue()).cards[0].status).toBe("Ready to Save");
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
    await until(() => expect(probeGate.entered).toBe(probesBefore + 1));
    await writeFile(target, "another save's audio");
    release();
    const result = await saving;

    expect(result.kind).toBe("conflict");
    expect(await readFile(target, "utf8")).toBe("another save's audio");
    expect(cards(result.snapshot)[0].status).toBe("Ready to Save");
    expect(await exists(card.sourceFilePath), "the working audio is kept").toBe(true);
    expect((await readdir(join(home, "output"))).sort()).toEqual([basename(target)]);
  });

  it("retains the working card and reports actual completed outputs after a later replacement fails", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    const saved = cards(runtime.getSnapshot())[0];
    const stem = join(home, "output", `${formatUtcMarker(new Date(saved.timestamps.effectiveUtc))}-old-title`);
    await mkdir(join(home, "output"), { recursive: true });
    await writeFile(`${stem}.wav`, "OLD AUDIO");
    await writeFile(`${stem}.json`, "OLD JSON");
    await writeFile(`${stem}.md`, "OLD MARKDOWN");
    outputFaults.failTarget = `${stem}.md`;
    const result = await runtime.saveCard(card.id, "overwrite");
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.message.key).toBe("error.saveIncomplete");
    expect(cards(result.snapshot)[0].status).toBe("Ready to Save");
    expect(await exists(card.sourceFilePath)).toBe(true);
    if (result.kind === "failed") expect(result.files).toEqual([
      { path: `${stem}.wav`, status: "saved" }, { path: `${stem}.json`, status: "saved" },
      { path: `${stem}.md`, status: "failed" },
    ]);
    expect(await readFile(`${stem}.wav`, "utf8")).toBe("audio for take.wav");
    expect(await readFile(`${stem}.md`, "utf8")).toBe("OLD MARKDOWN");
    expect((await readdir(join(home, "output"))).sort()).toEqual([basename(`${stem}.json`), basename(`${stem}.md`), basename(`${stem}.wav`)]);
  });

  it("shares a waveform run between players of one recording", async () => {
    const card = await confirmed();
    const first = runtime.getCardWaveformPeaks(card.id, "first");
    const second = runtime.getCardWaveformPeaks(card.id, "request-2");
    await until(() => expect(waveforms.runs).toHaveLength(1));
    expect(waveforms.runs[0]!.path).toBe(card.sourceFilePath);
    waveforms.runs[0]!.settle(Float32Array.of(0.5));
    expect([...(await first)!]).toEqual([0.5]);
    expect([...(await second)!]).toEqual([0.5]);
    expect(waveforms.runs, "one run for both players").toHaveLength(1);
    runtime.cancelCardWaveformPeaks("first");
    runtime.cancelCardWaveformPeaks("request-2");
  });

  it("stops a waveform run the player no longer waits for, and computes it afresh next time", async () => {
    const card = await confirmed();
    const waiting = runtime.getCardWaveformPeaks(card.id, "request-1");
    await until(() => expect(waveforms.runs).toHaveLength(1));
    runtime.cancelCardWaveformPeaks("request-1");
    expect(await waiting, "a stopped run is not a failure").toBeNull();
    expect(waveforms.runs[0]!.signal?.aborted).toBe(true);
    void runtime.getCardWaveformPeaks(card.id, "request-2").catch(() => undefined);
    await until(() => expect(waveforms.runs).toHaveLength(2));
  });

  it("starts afresh rather than joining a stopped run, as a player that closes and reopens at once does", async () => {
    const card = await confirmed();
    const first = runtime.getCardWaveformPeaks(card.id, "request-1");
    await until(() => expect(waveforms.runs).toHaveLength(1));
    runtime.cancelCardWaveformPeaks("request-1");
    const second = runtime.getCardWaveformPeaks(card.id, "request-2");
    await until(() => expect(waveforms.runs).toHaveLength(2));
    waveforms.runs[1]!.settle(Float32Array.of(0.25));
    expect([...(await second)!]).toEqual([0.25]);
    expect(await first).toBeNull();
  });

  it("joins a request for the recording being decoded, and stops that decode for another recording", async () => {
    const card = await confirmed();
    const first = runtime.getCardWaveformPeaks(card.id, "request-1");
    const second = runtime.getCardWaveformPeaks(card.id, "request-2");
    await until(() => expect(waveforms.runs).toHaveLength(1));
    waveforms.runs[0]!.settle(Float32Array.of(0.75));
    expect([...(await first)!]).toEqual([0.75]);
    expect([...(await second)!]).toEqual([0.75]);

    const copy = cards(await runtime.duplicateCard(card.id)).find((entry) => entry.id !== card.id)!;
    const other = runtime.getCardWaveformPeaks(copy.id, "request-3");
    await until(() => expect(waveforms.runs).toHaveLength(2));
    waveforms.runs[1]!.settle(Float32Array.of(0.5));
    expect([...(await other)!]).toEqual([0.5]);
  });

  it("releases a waveform acquisition after its card has been removed", async () => {
    const card = await confirmed();
    const waiting = runtime.getCardWaveformPeaks(card.id, "removed-card");
    await until(() => expect(waveforms.runs).toHaveLength(1));
    await runtime.removeCard(card.id);
    expect(runtime.resolveCardSourcePath(card.id)).toBeNull();
    runtime.cancelCardWaveformPeaks("removed-card");
    expect(waveforms.runs[0]!.signal?.aborted).toBe(true);
    expect(await waiting).toBeNull();
  });

  it("says the waveform could not be drawn when its run fails", async () => {
    const card = await confirmed();
    const waiting = runtime.getCardWaveformPeaks(card.id, "request-1");
    await until(() => expect(waveforms.runs).toHaveLength(1));
    waveforms.runs[0]!.fail(new Error("ffmpeg exited with code 1"));
    await expect(waiting).rejects.toThrow("The waveform could not be drawn.");
  });

  it("stops a waveform being drawn when Mumbler quits", async () => {
    const card = await confirmed();
    const waiting = runtime.getCardWaveformPeaks(card.id, "request-1").catch((error: unknown) => error);
    await until(() => expect(waveforms.runs).toHaveLength(1));
    await runtime.shutdown();
    expect(waveforms.runs[0]!.signal?.aborted).toBe(true);
    expect(await waiting).toBeNull();
    runtime = await ApplicationRuntime.initialize();
  });

  it("writes the recording's official start inside the saved audio", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    const ready = cards(runtime.getSnapshot())[0];
    const result = await runtime.saveCard(card.id);
    expect(result.kind).toBe("saved");
    if (result.kind === "saved") expect(result.warnings).toEqual([]);
    const local = recomputeLocalFromUtc(Math.floor(ready.timestamps.effectiveUtc / 1000) * 1000, ready.timestamps.timezone).localTimestampText;
    const [date, time] = local.split(" ");
    expect(tagWrites.calls).toHaveLength(1);
    expect(tagWrites.calls[0]).toEqual(expect.arrayContaining(["-write_bext", "1", `origination_date=${date}`, `origination_time=${time}`]));
  });

  it("saves the audio as it was, and says so, when its recording time cannot be written", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    tagWrites.failure = new Error("ffmpeg refused");
    const result = await runtime.saveCard(card.id);
    expect(result.kind).toBe("saved");
    if (result.kind === "saved") expect(result.warnings?.map((warning) => warning.key)).toEqual(["notice.saveTimeNotWritten"]);
    expect((await readdir(join(home, "output"))).length).toBe(3);
  });

  it("keeps a saved recording in the queue, ready to save again, when asked", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    const result = await runtime.saveCard(card.id, undefined, { removeAfterSave: false });
    expect(result.kind).toBe("saved");
    expect(cards(result.snapshot)).toMatchObject([{ id: card.id, status: "Ready to Save" }]);
    expect(await exists(card.sourceFilePath), "the kept recording keeps its audio").toBe(true);
    const again = await runtime.saveCard(card.id);
    expect(again.kind, "the same name is taken now").toBe("conflict");
    await runtime.shutdown();
    expect((await savedQueue()).cards[0].status).toBe("Ready to Save");
  });

  it("reports a committed save with cleanup warnings and removes its working card", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    const saved = cards(runtime.getSnapshot())[0];
    const stem = join(home, "output", `${formatUtcMarker(new Date(saved.timestamps.effectiveUtc))}-old-title`);
    await mkdir(join(home, "output"), { recursive: true });
    await writeFile(`${stem}.wav`, "OLD AUDIO");
    await writeFile(`${stem}.json`, "OLD JSON");
    await writeFile(`${stem}.md`, "OLD MARKDOWN");
    outputFaults.refuseCleanup = true;
    audioGate.cleanupFailure = true;
    const result = await runtime.saveCard(card.id, "overwrite");
    expect(result.kind).toBe("saved");
    if (result.kind === "saved") {
      expect(result.warnings?.map((warning) => warning.key)).toEqual(["notice.saveCleanupFailed", "notice.saveCleanupFailed"]);
      expect(result.warnings?.map((warning) => warning.values?.folder)).toEqual([pathValue(join(home, "output")), pathValue(join(home, "cards", card.id, "temp"))]);
    }
    expect(cards(result.snapshot)).toEqual([]);
    expect(await exists(card.sourceFilePath)).toBe(false);
    expect((await readdir(join(home, "output"))).filter((file) => file.startsWith(".mumbler-save-"))).toHaveLength(1);
  });

  it("keeps committed success and exposes prepared-audio cleanup failure separately", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    audioGate.cleanupFailure = true;
    const result = await runtime.saveCard(card.id);
    expect(result.kind).toBe("saved");
    if (result.kind === "saved") expect(result.warnings?.map((warning) => warning.key)).toEqual(["notice.saveCleanupFailed"]);
    expect(cards(result.snapshot)).toEqual([]);
    expect((await readdir(join(home, "output"))).length).toBe(3);
    expect(await exists(join(home, "cards", card.id)), "the scratch the save left goes with the removed card's folder").toBe(false);
  });

  it("overwrites output metadata from a newer build when the user chooses Overwrite", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    const saved = cards(runtime.getSnapshot())[0];
    const stem = join(home, "output", `${formatUtcMarker(new Date(saved.timestamps.effectiveUtc))}-old-title`);
    await mkdir(join(home, "output"), { recursive: true });
    await writeFile(`${stem}.json`, JSON.stringify(header("sidecar", 2)));
    const result = await runtime.saveCard(card.id, "overwrite");
    expect(result.kind).toBe("saved");
    expect(JSON.parse(await readFile(`${stem}.json`, "utf8"))).toMatchObject(header("sidecar"));
  });

  it.each([
    ["cards", false], ["cards", true],
    ["inbox", false], ["inbox", true],
    ["temp", false], ["temp", true],
    ["temp/exports", false], ["temp/exports", true],
  ] as const)("refuses the %s directory, whose contents Mumbler deletes (alias: %s)", async (directory, alias) => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    const disposable = join(home, directory);
    await mkdir(disposable, { recursive: true });
    const output = alias ? join(root, "disposable-alias") : disposable;
    if (alias) await symlink(disposable, output, "junction");
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), outputDirectory: output });
    const result = await runtime.saveCard(card.id, "overwrite");
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.message.key).toBe("error.saveOutputLocationUnsafe");
    expect((await readdir(disposable)).filter((name) => name !== card.id)).toEqual([]);
    expect(await exists(card.sourceFilePath)).toBe(true);
    expect(cards(result.snapshot)[0].status).toBe("Ready to Save");
  });

  it.each(["card", "pending", "original"] as const)("refuses an output alias of a %s input", async (input) => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    const pending = input === "card" ? null : (await dropIn("next.wav"))[0]!;
    const protectedPath = input === "card" ? card.sourceFilePath : input === "pending" ? pending!.workingFilePath : pending!.originalSourcePath;
    const saved = cards(runtime.getSnapshot())[0];
    const output = join(home, "output");
    await mkdir(output, { recursive: true });
    const target = join(output, `${formatUtcMarker(new Date(saved.timestamps.effectiveUtc))}-old-title.wav`);
    await link(protectedPath, target);
    const prior = await readFile(protectedPath, "utf8");
    const result = await runtime.saveCard(card.id, "overwrite");
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.message.key).toBe("error.saveOutputLocationUnsafe");
    expect(await readFile(protectedPath, "utf8")).toBe(prior);
    expect(await readdir(output)).toEqual([basename(target)]);
    expect(await exists(card.sourceFilePath)).toBe(true);
  });

  it("checks newly admitted pending inputs after a held final probe", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    const output = join(home, "output");
    await mkdir(output, { recursive: true });
    const saved = cards(runtime.getSnapshot())[0];
    const name = `${formatUtcMarker(new Date(saved.timestamps.effectiveUtc))}-old-title.wav`;
    let release!: () => void;
    probeGate.held = new Promise<void>((resolve) => { release = resolve; });
    const saving = runtime.saveCard(card.id, "overwrite");
    try {
      await until(() => expect(probeGate.entered).toBeGreaterThan(0));
      const [pending] = await dropIn(name);
      // The output the save is about to replace is the new import's copy.
      await link(pending!.workingFilePath, join(output, name));
      const prior = await readFile(pending!.workingFilePath, "utf8");
      release();
      const result = await saving;
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") expect(result.message.key).toBe("error.saveOutputLocationUnsafe");
      expect(await readFile(pending!.workingFilePath, "utf8")).toBe(prior);
      expect(cards(result.snapshot)[0].status).toBe("Ready to Save");
    } finally { release(); await saving.catch(() => undefined); }
  });

  it("refuses publishing over the card's own working filename, but permits a suffixed retry", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    const saved = cards(runtime.getSnapshot())[0]!;
    const output = join(home, "output");
    await mkdir(output, { recursive: true });
    // The output name the save takes already names the card's own audio.
    const target = join(output, `${formatUtcMarker(new Date(saved.timestamps.effectiveUtc))}-old-title.wav`);
    await link(saved.sourceFilePath, target);
    const refused = await runtime.saveCard(card.id, "overwrite");
    expect(refused.kind).toBe("failed");
    expect(await readFile(target, "utf8")).toBe("audio for take.wav");
    const retried = await runtime.saveCard(card.id, "suffix");
    expect(retried.kind).toBe("saved");
    if (retried.kind === "saved") expect(await readFile(retried.audioPath, "utf8")).toBe("audio for take.wav");
  });

  it("checks a large retained queue incrementally while a source check is held", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    await runtime.shutdown();
    const loaded = await loadDisk();
    const saved = loaded.cards[0]!;
    loaded.cards.push(...Array.from({ length: 256 }, (_, index) => ({
      ...saved, id: `retained-${index}`, sourceFilePath: join(home, "cards", `retained-${index}`, `missing-${index}.wav`),
    })));
    await saveDiskCards(loaded.cards);
    runtime = await ApplicationRuntime.initialize();
    for (const entry of cards(runtime.getSnapshot())) sourceChecks.paths.add(entry.sourceFilePath);
    let release!: () => void;
    sourceChecks.held = new Promise<void>((resolve) => { release = resolve; });
    const saving = runtime.saveCard(card.id, undefined, { removeAfterSave: false });
    try {
      await until(() => expect(sourceChecks.calls).toHaveLength(1));
      release();
      expect((await saving).kind).toBe("saved");
      expect(sourceChecks.maximum).toBe(1);
      expect(new Set(sourceChecks.calls).size).toBe(257);
    } finally { release(); await saving.catch(() => undefined); }
  });

  it("stops at a protected input collision before inspecting later sources", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    const [pending] = await dropIn("later.wav");
    const saved = cards(runtime.getSnapshot())[0];
    const output = join(home, "output");
    await mkdir(output, { recursive: true });
    await link(card.sourceFilePath, join(output, `${formatUtcMarker(new Date(saved.timestamps.effectiveUtc))}-old-title.wav`));
    sourceChecks.paths.add(card.sourceFilePath);
    sourceChecks.paths.add(pending!.workingFilePath);
    const result = await runtime.saveCard(card.id, "overwrite");
    expect(result.kind).toBe("failed");
    expect(sourceChecks.calls).toEqual([card.sourceFilePath]);
  });

  it("propagates a protected-source access failure", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    sourceChecks.paths.add(card.sourceFilePath);
    sourceChecks.failure = Object.assign(new Error("source access denied"), { code: "EACCES" });
    await expect(runtime.saveCard(card.id)).rejects.toThrow("source access denied");
    expect(cards(runtime.getSnapshot())[0].status).toBe("Ready to Save");
  });

  it("hands the card back as ready to save when a save stops at a conflict", async () => {
    const card = await confirmed();
    await transcribedOnDisk(card.id);
    const first = await runtime.duplicateCard(card.id);
    const copy = cards(first).find((entry) => entry.id !== card.id)!;
    await transcribedOnDisk(copy.id);

    expect((await runtime.saveCard(card.id)).kind).toBe("saved");
    const preparations = audioGate.entered;
    const rewrites = tagWrites.calls.length;
    const result = await runtime.saveCard(copy.id);

    expect(result.kind).toBe("conflict");
    expect(audioGate.entered).toBe(preparations);
    expect(tagWrites.calls).toHaveLength(rewrites);
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
    expect(dirname(duplicate.sourceFilePath), "in its own folder, under the same name").toBe(join(home, "cards", duplicate.id));
    expect(basename(duplicate.sourceFilePath)).toBe(basename(card.sourceFilePath));
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
    const persisted = { value: await savedQueue() };
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
      /zero or more seconds, in tenths/,
    );
    await expect(runtime.updateCardTrim(card.id, { frontMarkerSec: 1.25, backMarkerSec: null })).rejects.toThrow(
      /in tenths/,
    );
    await expect(runtime.updateCardTrim(card.id, { frontMarkerSec: null, backMarkerSec: 0 })).rejects.toThrow(
      /back trim cannot be 0/,
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

  it("removes the card when its renamed folder cannot be deleted, and the next launch deletes the folder", async () => {
    const card = await confirmed();
    const folder = join(home, "cards", `.removed-${card.id}`);
    undeletable.add(folder);

    expect(cards(await runtime.removeCard(card.id))).toEqual([]);
    expect(await exists(join(folder, basename(card.sourceFilePath))), "the folder waits for the next launch").toBe(true);
    undeletable.clear();
    await runtime.shutdown();
    runtime = await ApplicationRuntime.initialize();
    expect(await exists(folder)).toBe(false);
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

describe("each card in its own folder", () => {
  it("keeps the whole card, its text included, in its folder's card.json, with no list beside it", async () => {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    await runtime.shutdown();
    await diskStore().writeCard({ ...card, transcription: { text: "every word that was said" }, metadata: { ...card.metadata, structured: "## what it was about" } });
    runtime = await ApplicationRuntime.initialize();

    expect(cards(runtime.getSnapshot())[0]).toMatchObject({
      id: card.id,
      transcription: { text: "every word that was said" },
      metadata: { structured: "## what it was about" },
    });
    expect(await savedCard(card.id)).toMatchObject({ ...header("card"), id: card.id, transcription: { text: "every word that was said" } });
    expect((await readdir(join(home, "cards", card.id))).sort()).toEqual(["card.json", "take.wav"]);
  });

  it("writes only the changed card when one card changes", async () => {
    const [first, second] = await dropIn("one.wav", "two.wav");
    const [a, b] = cards((await runtime.confirmPendingImports([review(first), review(second, { localTimestampText: "2026-03-01 08:30:00" })])).snapshot);
    const others = [join(home, "cards", b.id, "card.json")];
    const times = async () => Promise.all(others.map(async (path) => (await stat(path)).mtimeMs));
    const before = await times();

    await runtime.updateCardTrim(a.id, { frontMarkerSec: null, backMarkerSec: 100 });

    expect((await savedCard(a.id)).trim.backMarkerSec).toBe(100);
    expect(await times(), "the other card was not written").toEqual(before);
  });

  it("deletes a removed card's whole folder", async () => {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);

    await runtime.removeCard(card.id);

    expect(await readdir(join(home, "cards"))).toEqual([]);
  });
});

describe("closing at quit", () => {
  it("closes the records alongside the backup history rather than after it", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const close = vi.spyOn(backupStore, "closeBackupStore").mockReturnValue(held);
    const query = { session: null, kind: null, level: null, cardId: null, search: "", after: null };
    try {
      await expect(runtime.readRecordsPage(query)).resolves.toBeDefined();
      const closing = runtime.closeForQuit({ origin: "user" });
      await until(() => expect(close).toHaveBeenCalledOnce());
      // The records are already closing while the backup history still drains.
      await expect(runtime.readRecordsPage(query)).rejects.toThrow("could not be read");
      release();
      await closing;
    } finally { close.mockRestore(); }
  });

  it("skips the backup history at an OS session end", async () => {
    const abandon = vi.spyOn(backupStore, "abandonBackupStore");
    const close = vi.spyOn(backupStore, "closeBackupStore");
    try {
      await runtime.closeForQuit({ origin: "session-end" });
      expect(abandon).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
    } finally { abandon.mockRestore(); close.mockRestore(); }
  });
});

describe("a store in a newer format", () => {
  /** Rewrites a JSON store as a newer build would have left it, returning its bytes. */
  async function makeNewer(path: string): Promise<string> {
    const current = (await exists(path)) ? JSON.parse(await readFile(path, "utf8")) : {};
    const kinds: Record<string, string> = { "config.json": "config", "card.json": "card", "import.json": "pendingImport", "dependencies.json": "dependencies", "layout.json": "layout" };
    const newer = JSON.stringify({ ...current, ...header(kinds[basename(path)]!, 99) });
    await writeFile(path, newer, "utf8");
    return newer;
  }

  async function confirmedCard(): Promise<MumblerCard> {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    return card;
  }

  it.each(["config.json"])(
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

  it.each(["card", "pending import"])("names a %s from a newer build at launch, leaves it untouched and loads the rest", async (name) => {
    const card = await confirmedCard();
    const [pending] = await dropIn("waiting.wav");
    await runtime.shutdown();
    const path = name === "card" ? join(home, "cards", card.id, "card.json") : join(home, "inbox", pending.id, "import.json");
    const newer = await makeNewer(path);

    runtime = await ApplicationRuntime.initialize();

    expect(runtime.getSnapshot().startupDiagnostic).toBeNull();
    expect(runtime.getSnapshot().appWideError?.message).toEqual({ key: "diagnostic.itemsUnreadableBody", values: { items: [path] } });
    expect(cards(runtime.getSnapshot()).map((entry) => entry.id)).toEqual(name === "card" ? [] : [card.id]);
    expect(runtime.getSnapshot().state!.pendingImports.map((entry) => entry.id)).toEqual(name === "pending import" ? [] : [pending.id]);
    await runtime.shutdown();
    expect(await readFile(path, "utf8")).toBe(newer);
  });

  it("opens on default tool facts and never writes a dependencies.json from a newer build", async () => {
    await confirmedCard();
    await runtime.shutdown();
    const path = join(home, "dependencies.json");
    const newer = await makeNewer(path);

    runtime = await ApplicationRuntime.initialize();

    expect(runtime.getSnapshot().startupDiagnostic).toBeNull();
    await runtime.shutdown();
    expect(await readFile(path, "utf8")).toBe(newer);
    expect((await readdir(home)).filter((entry) => entry.endsWith(".invalid"))).toEqual([]);
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
    ["without its format header", JSON.stringify({ concurrencyLimit: 5 })],
    ["of another kind", JSON.stringify({ ...header("layout"), concurrencyLimit: 5 })],
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
    expect(await savedSettings(), "only the first-launch zone is saved until the user changes a setting").toEqual(FIRST_LAUNCH);
    expect(snapshot.startupDiagnostic).toBeNull();
    expect(snapshot.appWideError).toEqual({
      title: { key: "diagnostic.settingsResetTitle" },
      message: { key: "diagnostic.settingsResetBody", values: { path: join(home, quarantined!) } },
    });
    expect(cards(snapshot).map((entry) => entry.id)).toEqual([card.id]);
    expect(await exists(card.sourceFilePath)).toBe(true);
  });

  it("names settings it cannot use at launch, keeps them through the updates switch and replaces them at a Settings save", async () => {
    await runtime.shutdown();
    const path = join(home, "config.json");
    const unusable = { structured: "no placeholder", title: "{transcript}", slug: "{title}" };
    await writeFile(path, JSON.stringify({ ...header("config"), prompts: unusable, addedLater: "kept" }));

    runtime = await ApplicationRuntime.initialize();

    expect(runtime.getSnapshot().appWideError).toEqual({
      title: { key: "diagnostic.settingsUnusableTitle" },
      message: { key: "diagnostic.settingsUnusableBody", values: { items: ["prompts"] } },
    });
    expect(runtime.getSettingsDraft().structuredPrompt).toBe(createDefaultSettings().prompts.structured);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...FIRST_LAUNCH, prompts: unusable, addedLater: "kept" });

    await runtime.saveToolSettings(false);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      ...FIRST_LAUNCH, checkUpdatesAtLaunch: false, prompts: unusable, addedLater: "kept",
    });

    await runtime.saveSettingsDraft(runtime.getSettingsDraft());
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...FIRST_LAUNCH, checkUpdatesAtLaunch: false, addedLater: "kept" });
  });

  it("halts on a config.json it cannot read, moving nothing and offering no Reset", async () => {
    await runtime.shutdown();
    await rm(join(home, "config.json"), { force: true });
    await mkdir(join(home, "config.json"));

    runtime = await ApplicationRuntime.initialize();

    expect(runtime.getSnapshot().startupDiagnostic).toEqual({
      title: { key: "diagnostic.unreadableTitle" },
      message: { key: "diagnostic.unreadableBody", values: { path: join(home, "config.json") } },
      canReset: false,
    });
    expect((await stat(join(home, "config.json"))).isDirectory()).toBe(true);
    expect((await readdir(home)).filter((entry) => entry.endsWith(".invalid"))).toEqual([]);
  });

  it("opens on a default layout over a damaged layout.json and replaces it at the next layout save", async () => {
    await runtime.shutdown();
    const path = join(home, "layout.json");
    await writeFile(path, "broken layout");

    runtime = await ApplicationRuntime.initialize();

    expect(runtime.getSnapshot().startupDiagnostic).toBeNull();
    expect(await readFile(path, "utf8"), "launch itself writes nothing").toBe("broken layout");
    await runtime.saveLayout(430);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ ...header("layout"), queueWidth: 430 });
    expect((await readdir(home)).filter((entry) => entry.endsWith(".invalid"))).toEqual([]);
  });

  it("opens over a damaged dependencies.json without setting it aside", async () => {
    await runtime.shutdown();
    await writeFile(join(home, "dependencies.json"), "broken facts");

    runtime = await ApplicationRuntime.initialize();

    expect(runtime.getSnapshot().startupDiagnostic).toBeNull();
    expect((await readdir(home)).filter((entry) => entry.endsWith(".invalid"))).toEqual([]);
  });

  it("does not materialize sets when an unchanged draft is saved", async () => {
    await runtime.saveSettingsDraft(runtime.getSettingsDraft());
    expect(await savedSettings(), "only the first-launch zone is saved").toEqual(FIRST_LAUNCH);
  });

  it("launches without a config file and writes only the edited set", async () => {
    expect(await savedSettings(), "only the first-launch zone is saved").toEqual(FIRST_LAUNCH);
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), concurrencyLimit: 5 });
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8"))).toEqual({ ...FIRST_LAUNCH, concurrencyLimit: 5 });
  });

  it("writes the Audio Tools update toggle with the other sets the app holds", async () => {
    await runtime.saveToolSettings(false);
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8"))).toEqual({ ...FIRST_LAUNCH, checkUpdatesAtLaunch: false });
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), concurrencyLimit: 5 });
    await runtime.saveToolSettings(true);
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8"))).toEqual({ ...FIRST_LAUNCH, concurrencyLimit: 5 });
  });

  it.each(["draft", "setup", "originals"] as const)("keeps a pending tool toggle through the next %s settings intent", async (intent) => {
    const configPath = join(home, "config.json");
    const destination = join(root, "chosen");
    let release!: () => void;
    unwritable.held = { path: configPath, release: new Promise((resolve) => { release = resolve; }), entered: 0 };
    const first = runtime.saveToolSettings(false);
    let second: Promise<AppSnapshot> | undefined;
    try {
      await until(() => expect(unwritable.held?.entered).toBe(1));
      expect(runtime.getSnapshot().settingsSummary?.checkUpdatesAtLaunch).toBe(true);
      if (intent === "draft") second = runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), theme: "dark" });
      else if (intent === "setup") second = runtime.saveSetupDirectory(destination);
      else {
        vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [destination] });
        second = runtime.chooseOriginalsDirectory({} as never);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      release();
      await Promise.all([first, second]);
      const stored = JSON.parse(await readFile(configPath, "utf8"));
      expect(stored.checkUpdatesAtLaunch).toBe(false);
      expect(runtime.getSnapshot().settingsSummary?.checkUpdatesAtLaunch).toBe(false);
      if (intent === "draft") {
        expect(stored.theme).toBe("dark");
        expect(runtime.themePreference()).toBe("dark");
      } else if (intent === "setup") {
        expect(stored.outputDirectory).toBe(destination);
        expect(runtime.getSnapshot().settingsSummary?.outputDirectory).toBe(destination);
      } else {
        expect(stored.backupDirectory).toBe(destination);
        expect(runtime.getSnapshot().settingsSummary?.backupDirectory).toBe(destination);
      }
    } finally {
      release();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      unwritable.held = null;
    }
  });

  it("prepares a catalogue outside settings ownership and derives the draft after a tool toggle commits", async () => {
    let release!: () => void;
    catalogueGate.held = new Promise((resolve) => { release = resolve; });
    const saving = runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), theme: "dark" });
    try {
      await until(() => expect(catalogueGate.entered).toBe(1));
      await runtime.saveToolSettings(false);
      expect(runtime.getSnapshot().settingsSummary?.checkUpdatesAtLaunch).toBe(false);
      release();
      await saving;
      expect(JSON.parse(await readFile(join(home, "config.json"), "utf8"))).toEqual({
        ...FIRST_LAUNCH, theme: "dark", checkUpdatesAtLaunch: false,
      });
      expect(runtime.getSnapshot().settingsSummary?.checkUpdatesAtLaunch).toBe(false);
      expect(runtime.themePreference()).toBe("dark");
    } finally {
      release();
      await Promise.allSettled([saving]);
      catalogueGate.held = null;
    }
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
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8"))).toEqual({ ...FIRST_LAUNCH, concurrencyLimit: 5 });
  });

  it("does not store a prompt that differs from its built-in only by line endings and trailing spaces", async () => {
    const { structured } = runtime.getDefaultPrompts();
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), structuredPrompt: `${structured.replaceAll("\n", "  \r\n")}\r\n` });
    expect(await savedSettings(), "only the first-launch zone is saved").toEqual(FIRST_LAUNCH);
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
    expect(await savedSettings(), "only the first-launch zone is saved").toEqual(FIRST_LAUNCH);
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
    await writeFile(join(home, "config.json"), JSON.stringify({ ...header("config"), theme: "sepia" }));
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
    await runtime.confirmPendingImports([review(pending, { deleteOriginalOnConfirm: false })]);
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), defaultTimezone: "Europe/Berlin" });

    const snapshot = await runtime.resetState();

    expect(cards(snapshot)).toEqual([]);
    expect(snapshot.settingsSummary?.defaultTimezone).not.toBe("Europe/Berlin");
    expect(await exists(join(home, "config.json"))).toBe(false);
    expect(await exists(join(home, "layout.json"))).toBe(false);
    expect(await exists(join(home, "cards"))).toBe(false);
    expect(await exists(pending.workingFilePath), "the recording left the working folder").toBe(false);
    expect(await exists(pending.originalSourcePath), "the user's own file is untouched").toBe(true);
  });

  it("moves every card and pending import aside together, and deletes none", async () => {
    const [kept, waiting] = await dropIn("take.wav", "waiting.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(kept)])).snapshot);

    await runtime.resetState();

    const setAside = (await readdir(home)).find((name) => /^queue-.*\.invalid$/.test(name));
    expect(setAside, "the queue is set aside").toBeDefined();
    expect(await readFile(join(home, setAside!, "cards", card.id, basename(card.sourceFilePath)), "utf8")).toBe("audio for take.wav");
    expect(await readFile(join(home, setAside!, "inbox", waiting.id, basename(waiting.workingFilePath)), "utf8")).toBe("audio for waiting.wav");
    expect((await readdir(join(home, setAside!))).sort()).toEqual(["cards", "inbox"]);
    expect(await exists(join(home, "cards")), "the new queue starts with no cards").toBe(false);
  });

  it("says what a reset that failed part-way had already set aside, and keeps the old queue", async () => {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    await runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), defaultTimezone: "Europe/Berlin" });
    unmovable.add(join(home, "cards"));

    const snapshot = await runtime.resetState();

    expect(snapshot.startupDiagnostic).toEqual({
      title: { key: "diagnostic.resetTitle" },
      message: { key: "diagnostic.resetMovedBody", values: { items: ["config.json"], folder: home } },
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
  it("names a card.json holding the JSON literal null at launch and keeps the working recording", async () => {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    await runtime.shutdown();
    const path = join(home, "cards", card.id, "card.json");
    await writeFile(path, "null", "utf8");

    runtime = await ApplicationRuntime.initialize();

    expect(runtime.getSnapshot().appWideError?.title).toEqual({ key: "diagnostic.itemsUnreadableTitle" });
    expect(cards(runtime.getSnapshot())).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("null");
    expect(await exists(card.sourceFilePath), "the working recording is kept").toBe(true);
  });
});

describe("the save a quit makes", () => {
  type Internals = { runtime: { state: { cards: MumblerCard[] } } };

  function observeFinalQueueWrite() {
    return vi.spyOn(QueueStore.prototype, "retryFailedWrites");
  }

  it("refuses new settings work once a quit has begun", async () => {
    const quit = runtime.saveForQuit();
    try {
      await expect(runtime.saveSettingsDraft(runtime.getSettingsDraft())).rejects.toThrow("Mumbler is closing");
      await expect(runtime.saveToolSettings(false)).rejects.toThrow("Mumbler is closing");
      await expect(runtime.setGeminiApiKey("new-key")).rejects.toThrow("Mumbler is closing");
      await expect(runtime.clearGeminiApiKey()).rejects.toThrow("Mumbler is closing");
      await expect(runtime.chooseOutputDirectory({} as never)).rejects.toThrow("Mumbler is closing");
      expect(await quit).toEqual([]);
    } finally {
      await quit;
    }
  });

  it.each(["set", "failed-clear"] as const)("drains an API-key %s held before its write and preserves its result", async (operation) => {
    await runtime.setGeminiApiKey("old-key");
    const secret = join(home, "api-keys.json");
    const before = await readFile(secret, "utf8");
    let release!: () => void;
    secretReadGate.held = { path: secret, release: new Promise((resolve) => { release = resolve; }), entered: 0 };
    if (operation === "failed-clear") unwritable.refuses = (path) => path === secret;
    const finalWrite = observeFinalQueueWrite();
    const saving = (operation === "set" ? runtime.setGeminiApiKey("new-key") : runtime.clearGeminiApiKey())
      .then(() => "saved", () => "failed");
    let quit: Promise<unknown> | undefined;
    try {
      await until(() => expect(secretReadGate.held?.entered).toBe(1));
      quit = runtime.saveForQuit();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finalWrite).not.toHaveBeenCalled();
      release();
      expect(await saving).toBe(operation === "set" ? "saved" : "failed");
      expect(await quit).toEqual([]);
      expect(finalWrite).toHaveBeenCalledOnce();
      if (operation === "failed-clear") expect(await readFile(secret, "utf8")).toBe(before);
      else {
        const { resolveApiKey } = await import("@main/core/api-keys");
        expect(await resolveApiKey(secret, "gemini", () => undefined)).toBe("new-key");
      }
    } finally {
      release();
      secretReadGate.held = null;
      unwritable.refuses = () => false;
      await Promise.allSettled([saving, ...(quit === undefined ? [] : [quit])]);
      finalWrite.mockRestore();
    }
  });

  it("writes the queue its last save could not write, and reports it while it still cannot", async () => {
    const [pending] = await dropIn("take.wav");
    unwritable.refuses = (path) => path === join(home, "inbox", pending.id, "import.json");
    await expect(runtime.updatePendingImportDrafts([review(pending)])).rejects.toThrow();

    expect(await runtime.saveForQuit()).toEqual(["queue"]);

    unwritable.refuses = () => false;
    expect(await runtime.saveForQuit(), "Retry").toEqual([]);
    const saved = { value: await savedQueue() };
    expect(saved.value.pendingImports).toEqual([expect.objectContaining({ id: pending.id, localTimestampText: "2026-03-01 07:30:00" })]);
  });

  it("writes a card whose last write failed, from what the app holds", async () => {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    const control = runtime as unknown as Internals & {
      command<T>(work: () => Promise<T>): Promise<T>;
      persist(change: { cards: MumblerCard[] }): Promise<void>;
    };
    const held = control.runtime.state.cards[0]!;
    held.transcription = { text: "words not on disk yet" };
    const file = join(home, "cards", card.id, "card.json");
    unwritable.refuses = (path) => path === file;
    await expect(control.command(() => control.persist({ cards: [held] }))).rejects.toThrow();

    expect(await runtime.saveForQuit()).toEqual(["queue"]);

    unwritable.refuses = () => false;
    expect(await runtime.saveForQuit()).toEqual([]);
    expect(await savedCard(card.id)).toMatchObject({ id: card.id, transcription: { text: "words not on disk yet" } });
  });

  it("writes nothing when everything is already on disk", async () => {
    const [pending] = await dropIn("take.wav");
    const [card] = cards((await runtime.confirmPendingImports([review(pending)])).snapshot);
    const file = join(home, "cards", card.id, "card.json");
    const before = await stat(file);

    expect(await runtime.saveForQuit()).toEqual([]);

    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it("retries a settings change that fails while the quit runs, with the value the user saved", async () => {
    const configPath = join(home, "config.json");
    let release!: () => void;
    unwritable.held = { path: configPath, release: new Promise((resolve) => { release = resolve; }), entered: 0 };
    unwritable.refuses = (path) => path === configPath;
    const saving = runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), defaultTimezone: "Europe/Berlin" })
      .then(() => "saved", () => "failed");
    await until(() => expect(unwritable.held?.entered).toBe(1));

    const quit = runtime.saveForQuit();
    release();

    expect(await quit).toEqual(["settings"]);
    expect(await saving).toBe("failed");
    unwritable.held = null;
    unwritable.refuses = () => false;
    expect(await runtime.saveForQuit(), "Retry").toEqual([]);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ defaultTimezone: "Europe/Berlin" });
    expect(runtime.getSettingsDraft().defaultTimezone).toBe("Europe/Berlin");
  });

  it.each(["targeted", "full"] as const)("keeps a retried %s settings commit authoritative after cancelling a failed quit", async (intent) => {
    const [pending] = await dropIn("take.wav");
    const itemFile = join(home, "inbox", pending.id, "import.json");
    const configPath = join(home, "config.json");
    let settingsWrites = 0;
    unwritable.refuses = (path) => path === itemFile || (path === configPath && ++settingsWrites === 1);
    await expect(runtime.updatePendingImportDrafts([review(pending)])).rejects.toThrow();

    let release!: () => void;
    unwritable.held = { path: configPath, release: new Promise((resolve) => { release = resolve; }), entered: 0 };
    const changedLanguage = vi.fn();
    runtime.onLanguageChanged(changedLanguage);
    const saving = (intent === "targeted"
      ? runtime.saveToolSettings(false)
      : runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), theme: "dark", language: "ja" }))
      .then(() => "saved", () => "failed");
    let quit: Promise<unknown> | undefined;
    try {
      await until(() => expect(unwritable.held?.entered).toBe(1));
      quit = runtime.saveForQuit();
      release();
      expect(await saving).toBe("failed");
      expect(await quit).toEqual(["queue"]);
      expect(settingsWrites).toBe(2);
      const stored = JSON.parse(await readFile(configPath, "utf8"));
      if (intent === "targeted") {
        expect(stored.checkUpdatesAtLaunch).toBe(false);
        expect(runtime.getSnapshot().settingsSummary?.checkUpdatesAtLaunch).toBe(false);
        expect(changedLanguage).not.toHaveBeenCalled();
      } else {
        expect(stored).toMatchObject({ theme: "dark", language: "ja" });
        expect(runtime.themePreference()).toBe("dark");
        expect(runtime.languagePreference()).toBe("ja");
        const { nativeTheme } = await import("electron");
        expect(nativeTheme.themeSource).toBe("dark");
        expect(changedLanguage).toHaveBeenCalledOnce();
      }

      unwritable.held = null;
      unwritable.refuses = () => false;
      await runtime.resumeAfterCancelledQuit();
      await runtime.saveSetupDirectory(join(root, "after-cancel"));
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject(stored);
      expect(changedLanguage).toHaveBeenCalledTimes(intent === "full" ? 1 : 0);
    } finally {
      release();
      await Promise.allSettled([saving, ...(quit ? [quit] : [])]);
      unwritable.held = null;
      unwritable.refuses = () => false;
    }
  });

  it("retries a settings change that failed before the quit, and reports it when it fails again", async () => {
    const configPath = join(home, "config.json");
    unwritable.refuses = (path) => path === configPath;
    await expect(runtime.saveSettingsDraft({ ...runtime.getSettingsDraft(), defaultTimezone: "Europe/Berlin" })).rejects.toThrow();

    expect(await runtime.saveForQuit()).toEqual(["settings"]);
    expect(await savedSettings(), "still refused").toEqual(FIRST_LAUNCH);

    unwritable.refuses = () => false;
    expect(await runtime.saveForQuit()).toEqual([]);
    expect(await savedSettings()).toMatchObject({ defaultTimezone: "Europe/Berlin" });
  });

  it("takes work again after a cancelled quit", async () => {
    const [pending] = await dropIn("take.wav");
    unwritable.refuses = (path) => path === join(home, "inbox", pending.id, "import.json");
    await expect(runtime.updatePendingImportDrafts([review(pending)])).rejects.toThrow();
    expect(await runtime.saveForQuit()).toEqual(["queue"]);

    unwritable.refuses = () => false;
    await runtime.resumeAfterCancelledQuit();
    const remaining = await dropIn("next.wav");
    await runtime.confirmPendingImports(remaining.map((item) => review(item)));

    const saved = { value: await savedQueue() };
    expect(saved.value.cards.map((card) => card.originalFilename).sort()).toEqual(["next.wav", "take.wav"]);
  });

  it("cancels managed-tool work when the quit save starts", async () => {
    const { ToolManager } = await import("@main/core/binaries/manager");
    const cancel = vi.spyOn(ToolManager.prototype, "cancelAll");
    try {
      const quitting = runtime.saveForQuit();
      expect(cancel).toHaveBeenCalledOnce();
      expect(await quitting).toEqual([]);
    } finally { cancel.mockRestore(); }
  });
});
