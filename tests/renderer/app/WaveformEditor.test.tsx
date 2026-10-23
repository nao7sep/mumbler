// @vitest-environment jsdom
import React, { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { CardTrim, MumblerCard } from "@shared/app-shell";

// The trimming screen. WaveSurfer needs Web Audio and a canvas, so it is stood
// in for by a player that records what it was asked to do and can be told to
// report what a real one reports — ready, playing, the cursor moving. What is
// under test is the component: the markers it commits, what it refuses, and
// what it tells the user when a save fails.
const wave = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  function subscriptions() {
    const listeners = new Map<string, Set<Listener>>();
    return {
      listeners,
      on(event: string, callback: Listener) {
        const callbacks = listeners.get(event) ?? new Set<Listener>();
        callbacks.add(callback);
        listeners.set(event, callbacks);
        return () => {
          callbacks.delete(callback);
          if (callbacks.size === 0) listeners.delete(event);
        };
      },
      emit(event: string, ...args: unknown[]): void {
        for (const callback of listeners.get(event) ?? []) callback(...args);
      },
    };
  }

  function makeRegions() {
    const regions = {
      ...subscriptions(),
      added: [] as Array<Record<string, unknown>>,
      addRegion: (options: Record<string, unknown>) => {
        const region = {
          ...options,
          setOptions: (next: Record<string, unknown>) => { Object.assign(region, next); },
          remove: () => regions.emit("region-removed", region),
        };
        regions.added.push(region);
        return region;
      },
    };
    return regions;
  }

  type PlayerOptions = { media?: HTMLMediaElement; peaks?: Float32Array[]; duration?: number };
  function makePlayer(url: string, regions: ReturnType<typeof makeRegions>, duration: number, options: PlayerOptions = {}) {
    const player = {
      ...subscriptions(),
      url,
      options,
      regions,
      duration,
      currentTime: 0,
      played: [] as Array<{ startSec: number; endSec: number }>,
      seekedTo: [] as number[],
      playPauseCalls: 0,
      destroyCalls: 0,
      get destroyed(): boolean { return player.destroyCalls > 0; },
      getDuration: () => player.duration,
      getCurrentTime: () => player.currentTime,
      setTime: (value: number) => {
        player.currentTime = value;
        player.seekedTo.push(value);
      },
      play: async (startSec: number, endSec: number) => {
        player.played.push({ startSec, endSec });
      },
      playPause: async () => {
        player.playPauseCalls += 1;
      },
      setOptions: () => undefined,
      loads: [] as Array<{ url: string; peaks: Float32Array[]; duration: number }>,
      load: async (url: string, peaks: Float32Array[], duration: number) => {
        player.loads.push({ url, peaks, duration });
      },
      // Do not erase listeners here: each actual unsubscribe must prove its
      // own disposal independently of the player's destruction.
      destroy: () => { player.destroyCalls += 1; },
    };
    return player;
  }

  const players: Array<ReturnType<typeof makePlayer>> = [];
  const regionInstances: Array<ReturnType<typeof makeRegions>> = [];
  let nextDuration = 300;
  return {
    players,
    regionInstances,
    get createdUrls(): string[] { return players.map((player) => player.url); },
    get player() {
      const player = players.at(-1);
      if (!player) throw new Error("No player has been created.");
      return player;
    },
    get regions() {
      const regions = regionInstances.at(-1);
      if (!regions) throw new Error("No Regions plugin has been created.");
      return regions;
    },
    set nextDuration(value: number) { nextDuration = value; },
    createPlayer(options: { url: string; plugins: Array<ReturnType<typeof makeRegions>>; media?: HTMLMediaElement; peaks?: Float32Array[]; duration?: number }) {
      const player = makePlayer(options.url, options.plugins[0]!, nextDuration, {
        media: options.media, peaks: options.peaks, duration: options.duration,
      });
      players.push(player);
      return player;
    },
    createRegions() {
      const regions = makeRegions();
      regionInstances.push(regions);
      return regions;
    },
    emit(event: string, ...args: unknown[]): void {
      this.player.emit(event, ...args);
      this.regions.emit(event, ...args);
    },
    reset(): void {
      players.length = 0;
      regionInstances.length = 0;
      nextDuration = 300;
    },
  };
});

vi.mock("wavesurfer.js", () => ({ default: { create: wave.createPlayer } }));
vi.mock("wavesurfer.js/dist/plugins/regions.esm.js", () => ({ default: { create: wave.createRegions } }));

import type { WaveformEditorHandle } from "@renderer/app/WaveformEditor";

const { WaveformEditor } = await import("@renderer/app/WaveformEditor");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card: MumblerCard = {
  id: "card-1",
  originalFilename: "take.wav",
  importSource: "file-picker",
  sourceFilePath: "/working/take.wav",
  audioProfile: null,
  durationSec: 300,
  fileSizeBytes: 1024,
  timestamps: {
    confirmedLocal: "2026-03-01 07:30:00",
    confirmedUtc: Date.UTC(2026, 2, 1, 0, 30, 0),
    timezone: "Asia/Tokyo",
    frontTrimOffsetSec: 0,
    effectiveLocal: "2026-03-01 07:30:00",
    effectiveUtc: Date.UTC(2026, 2, 1, 0, 30, 0),
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
  createdAtUtc: 1,
  updatedAtUtc: 1,
};

let root: Root | null = null;
let container: HTMLDivElement;
let onTrimCommit: Mock<(cardId: string, trim: CardTrim) => Promise<void>>;
let getCardMediaSource: Mock<(cardId: string) => Promise<string>>;
let getCardWaveformPeaks: Mock<(cardId: string, requestId: string) => Promise<Float32Array>>;
let cancelCardWaveformPeaks: Mock<(cardId: string) => Promise<void>>;
let handle: React.RefObject<WaveformEditorHandle | null>;

/** Mounts the editor on `trim` and brings the player to the state after load. */
async function mountEditor(options: { trim?: CardTrim; durationSec?: number | null; disabled?: boolean; ready?: boolean } = {}): Promise<void> {
  handle = createRef<WaveformEditorHandle>();
  root = createRoot(container);
  await act(async () => {
    root?.render(
      React.createElement(WaveformEditor, {
        ref: handle,
        card: { ...card, trim: options.trim ?? card.trim, durationSec: options.durationSec === undefined ? card.durationSec : options.durationSec },
        previewSnippetSeconds: 10,
        skipIntervalSec: 5,
        disabled: options.disabled ?? false,
        onTrimCommit,
      }),
    );
  });
  if (options.ready !== false) {
    await act(async () => wave.emit("ready", wave.player.duration));
  }
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
  if (!match) throw new Error(`No button labelled ${label}. Present: ${[...container.querySelectorAll("button")].map((entry) => entry.textContent).join(", ")}`);
  return match as HTMLButtonElement;
}

function markerInput(side: "front" | "back"): HTMLInputElement {
  const inputs = [...container.querySelectorAll("input")];
  return inputs[side === "front" ? 0 : 1] as HTMLInputElement;
}

async function click(label: string): Promise<void> {
  await act(async () => button(label).click());
}

/** Types into a marker field and commits it with Enter, as the user does. */
async function typeMarker(side: "front" | "back", value: string): Promise<void> {
  const input = markerInput(side);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

function text(): string {
  return container.textContent ?? "";
}

beforeEach(() => {
  wave.reset();
  onTrimCommit = vi.fn(async () => undefined);
  getCardMediaSource = vi.fn(async () => "mumbler-asset://media/card-1");
  getCardWaveformPeaks = vi.fn(async () => Float32Array.of(0.1, 0.5, 0.2));
  cancelCardWaveformPeaks = vi.fn(async () => undefined);
  (window as unknown as { mumbler: unknown }).mumbler = {
    getCardMediaSource, getCardWaveformPeaks, cancelCardWaveformPeaks,
    reportRendererDiagnostic: vi.fn(async () => undefined),
  };
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
});

describe("opening a recording", () => {
  it("asks main for the working audio and reports the length the file turned out to have", async () => {
    wave.nextDuration = 425.5;
    await mountEditor();

    expect(getCardMediaSource).toHaveBeenCalledExactlyOnceWith("card-1");
    expect(text()).toContain("Duration: 7:05.5");
    expect(text()).toContain("No trim markers");
  });

  it("says so, in words the user can act on, when the audio cannot be loaded", async () => {
    getCardMediaSource.mockRejectedValue(new Error("ENOENT"));

    await mountEditor({ ready: false });

    expect(text()).toContain("The working audio could not be loaded for playback");
  });

  it("passes a playback failure on rather than leaving the window silent", async () => {
    await mountEditor();

    await act(async () => wave.emit("error", new Error("decode failed")));

    expect(text()).toContain("The working audio could not be played");
  });

  it("marks out the kept range on the waveform when the card already has markers", async () => {
    await mountEditor({ trim: { frontMarkerSec: 30, backMarkerSec: 200 } });

    expect(wave.regions.added).toEqual([expect.objectContaining({ start: 30, end: 200, drag: false, resize: true })]);
    expect(text()).toContain("Keep 0:30.0 to 3:20.0");
  });
});

describe("player resource ownership", () => {
  it("repeatedly reopens with distinct players and disposes every retired player's subscriptions exactly once", async () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await mountEditor();
      const player = wave.player;
      const regions = wave.regions;
      expect(wave.players).toHaveLength(cycle + 1);
      expect(wave.regionInstances).toHaveLength(cycle + 1);
      expect(new Set(wave.players).size).toBe(cycle + 1);
      expect(new Set(wave.regionInstances).size).toBe(cycle + 1);
      expect(player.regions).toBe(regions);
      expect(player.destroyCalls).toBe(0);
      expect(player.listeners.size).toBeGreaterThan(0);
      expect(regions.listeners.size).toBeGreaterThan(0);
      expect(wave.players.slice(0, -1).every((retired) => retired.destroyCalls === 1 && retired.listeners.size === 0)).toBe(true);
      expect(wave.regionInstances.slice(0, -1).every((retired) => retired.listeners.size === 0)).toBe(true);

      await act(async () => root?.unmount());
      root = null;
      expect(player.destroyCalls).toBe(1);
      expect(player.listeners.size).toBe(0);
      expect(regions.listeners.size).toBe(0);
      await act(async () => {
        player.emit("timeupdate", 88);
        regions.emit("region-updated", { start: 42, end: 200 });
      });
      expect(onTrimCommit).not.toHaveBeenCalled();
    }
    expect(wave.players.every((player) => player.destroyCalls === 1)).toBe(true);
  });

  it("creates no player or Regions plugin when media finishes after the editor was unmounted", async () => {
    let finishLookup!: (url: string) => void;
    getCardMediaSource.mockImplementationOnce(() => new Promise<string>((resolve) => { finishLookup = resolve; }));
    await mountEditor({ ready: false });
    await act(async () => root?.unmount());
    root = null;
    await act(async () => finishLookup("mumbler-asset://media/retired-editor"));
    expect(wave.players).toHaveLength(0);
    expect(wave.regionInstances).toHaveLength(0);
  });

  it("creates no player from a media lookup that finishes after unmount and reopening", async () => {
    let finishLookup!: (url: string) => void;
    getCardMediaSource.mockImplementationOnce(() => new Promise<string>((resolve) => { finishLookup = resolve; }));
    await mountEditor({ ready: false });
    expect(wave.players).toHaveLength(0);
    expect(wave.regionInstances).toHaveLength(0);
    await act(async () => root?.unmount());
    root = null;

    await mountEditor();
    const reopened = wave.player;
    const reopenedRegions = wave.regions;
    expect(getCardMediaSource).toHaveBeenCalledTimes(2);
    expect(wave.players).toHaveLength(1);
    await act(async () => finishLookup("mumbler-asset://media/retired-editor"));
    expect(wave.players).toHaveLength(1);
    expect(wave.regionInstances).toHaveLength(1);
    expect(wave.player).toBe(reopened);
    expect(wave.regions).toBe(reopenedRegions);
    expect(reopened.destroyCalls).toBe(0);
    expect(reopened.url).toBe("mumbler-asset://media/card-1");

    await act(async () => root?.unmount());
    root = null;
    expect(reopened.destroyCalls).toBe(1);
    expect(reopened.listeners.size).toBe(0);
    expect(reopenedRegions.listeners.size).toBe(0);
  });
});

describe("setting the markers", () => {
  it("puts a marker where the cursor is", async () => {
    await mountEditor();
    await act(async () => wave.emit("timeupdate", 65.54));

    await click("Set Front at Cursor");

    expect(onTrimCommit).toHaveBeenCalledExactlyOnceWith("card-1", { frontMarkerSec: 65.5, backMarkerSec: null });
    expect(markerInput("front").value).toBe("1:05.5");
  });

  it("takes a time typed as mm:ss.s, and as plain seconds", async () => {
    await mountEditor();

    await typeMarker("back", "4:12.5");
    expect(onTrimCommit).toHaveBeenLastCalledWith("card-1", { frontMarkerSec: null, backMarkerSec: 252.5 });

    await typeMarker("front", "90");
    expect(onTrimCommit).toHaveBeenLastCalledWith("card-1", { frontMarkerSec: 90, backMarkerSec: 252.5 });
  });

  it("clears a marker when its field is emptied", async () => {
    await mountEditor({ trim: { frontMarkerSec: 30, backMarkerSec: 200 } });

    await typeMarker("front", "   ");

    expect(onTrimCommit).toHaveBeenLastCalledWith("card-1", { frontMarkerSec: null, backMarkerSec: 200 });
  });

  it.each([
    ["a time past the end of the recording", "9:00.0", /within the recording's duration/],
    ["a time that is not a time", "half past two", /within the recording's duration/],
  ])("refuses %s and saves nothing", async (_case, typed, message) => {
    await mountEditor();

    await typeMarker("front", typed);

    expect(onTrimCommit).not.toHaveBeenCalled();
    expect(text()).toMatch(message);
  });

  it("refuses a front marker that would sit after the back marker", async () => {
    await mountEditor({ trim: { frontMarkerSec: null, backMarkerSec: 100 } });

    await typeMarker("front", "2:30.0");

    expect(onTrimCommit).not.toHaveBeenCalled();
    expect(text()).toContain("Enter a marker within the recording's duration");
  });

  it("clears both markers on request, and offers nothing to clear when there are none", async () => {
    await mountEditor({ trim: { frontMarkerSec: 30, backMarkerSec: 200 } });

    await click("Clear Markers");

    expect(onTrimCommit).toHaveBeenCalledExactlyOnceWith("card-1", { frontMarkerSec: null, backMarkerSec: null });
    expect(button("Clear Markers").disabled).toBe(true);
  });

  it("keeps the submitted text and says the previous markers remain in effect when saving fails", async () => {
    onTrimCommit.mockRejectedValue(new Error("Front trim cannot exceed audio duration."));
    await mountEditor({ trim: { frontMarkerSec: 30, backMarkerSec: 200 } });

    await typeMarker("front", "1:00.0");

    expect(text()).toContain("The trim markers could not be saved. The previous markers remain in effect");
    expect(markerInput("front").value, "the failed input remains available for correction or retry").toBe("1:00.0");
    expect(text()).toContain("Keep 0:30.0 to 3:20.0");
  });

  it("offers no marker editing while the card is busy", async () => {
    await mountEditor({ trim: { frontMarkerSec: 30, backMarkerSec: 200 }, disabled: true });

    expect(markerInput("front").disabled).toBe(true);
    expect(button("Set Front at Cursor").disabled).toBe(true);
    expect(button("Clear Markers").disabled).toBe(true);
  });
});

describe("nudging markers", () => {
  it("nudges an unset back marker from the player's resolved duration", async () => {
    wave.nextDuration = 425.5;
    await mountEditor();
    const nudge = container.querySelectorAll(".nudge-grid")[1]!.querySelector("button")!;
    await act(async () => nudge.click());
    expect(onTrimCommit).toHaveBeenCalledExactlyOnceWith("card-1", { frontMarkerSec: null, backMarkerSec: 424.5 });
  });

  it("leaves an unset back marker alone until a duration is available", async () => {
    getCardWaveformPeaks.mockImplementationOnce(() => new Promise<Float32Array>(() => undefined));
    await mountEditor({ durationSec: null, ready: false });
    const nudge = container.querySelectorAll(".nudge-grid")[1]!.querySelectorAll("button")[2]!;
    await act(async () => nudge.click());
    expect(onTrimCommit).not.toHaveBeenCalled();
  });
});

describe("listening back", () => {
  it("keeps both previews inside a retained span shorter than the snippet", async () => {
    await mountEditor({ trim: { frontMarkerSec: 30, backMarkerSec: 34 } });
    await click("Play First 10s");
    await click("Play Last 10s");
    expect(wave.player.played).toEqual([
      { startSec: 30, endSec: 34 },
      { startSec: 30, endSec: 34 },
    ]);
  });

  it("plays the first seconds from the front marker, and the last seconds up to the back marker", async () => {
    await mountEditor({ trim: { frontMarkerSec: 30, backMarkerSec: 200 } });

    await click("Play First 10s");
    await click("Play Last 10s");

    expect(wave.player.played).toEqual([
      { startSec: 30, endSec: 40 },
      { startSec: 190, endSec: 200 },
    ]);
  });

  it("plays the ends of the whole recording when there are no markers", async () => {
    await mountEditor();

    await click("Play First 10s");
    await click("Play Last 10s");

    expect(wave.player.played).toEqual([
      { startSec: 0, endSec: 10 },
      { startSec: 290, endSec: 300 },
    ]);
  });

  it("shows which snippet is playing while it plays", async () => {
    await mountEditor();

    await click("Play First 10s");
    await act(async () => wave.emit("play"));
    expect(button("Play First 10s").getAttribute("aria-pressed")).toBe("true");
    expect(button("Pause"), "the transport shows it is playing").toBeTruthy();

    await act(async () => wave.emit("finish"));
    expect(button("Play First 10s").getAttribute("aria-pressed")).toBe("false");
  });

  it("skips by the configured interval and stops at both ends of the recording", async () => {
    await mountEditor();
    wave.player.currentTime = 100;

    await act(async () => handle.current?.skipForward());
    expect(wave.player.seekedTo.at(-1)).toBe(105);

    await act(async () => handle.current?.skipBackward());
    expect(wave.player.seekedTo.at(-1)).toBe(100);

    wave.player.currentTime = 2;
    await act(async () => handle.current?.skipBackward());
    expect(wave.player.seekedTo.at(-1), "never before the beginning").toBe(0);

    wave.player.currentTime = 299;
    await act(async () => handle.current?.skipForward());
    expect(wave.player.seekedTo.at(-1), "never past the end").toBe(300);
  });

  it("answers the window's own play and marker shortcuts", async () => {
    await mountEditor();
    await act(async () => wave.emit("timeupdate", 42));

    await act(async () => handle.current?.playPause());
    expect(wave.player.playPauseCalls).toBe(1);

    await act(async () => handle.current?.setBackMarkerAtCursor());
    expect(onTrimCommit).toHaveBeenLastCalledWith("card-1", { frontMarkerSec: null, backMarkerSec: 42 });
  });
});

describe("dragging the kept range on the waveform", () => {
  it("disables region resizing while busy and restores ignored geometry when reenabled", async () => {
    const trim = { frontMarkerSec: 30, backMarkerSec: 200 };
    await mountEditor({ trim });
    const region = wave.regions.added[0]!;
    const show = (disabled: boolean) => act(async () => {
      root?.render(React.createElement(WaveformEditor, {
        ref: handle, card: { ...card, trim }, previewSnippetSeconds: 10, skipIntervalSec: 5, disabled, onTrimCommit,
      }));
    });
    await show(true);
    expect(region).toMatchObject({ resize: false, resizeStart: false, resizeEnd: false });
    region.start = 45;
    region.end = 180;
    await act(async () => {
      wave.emit("region-update", region);
      wave.emit("region-updated", region);
    });
    expect(onTrimCommit).not.toHaveBeenCalled();
    expect(markerInput("front").value).toBe("0:30.0");
    await show(false);
    expect(region).toMatchObject({ start: 30, end: 200, resize: true, resizeStart: true, resizeEnd: true });
    expect(wave.regions.added).toHaveLength(1);
  });

  it("creates a nonresizable region when opened while busy", async () => {
    await mountEditor({ trim: { frontMarkerSec: 30, backMarkerSec: 200 }, disabled: true });
    expect(wave.regions.added[0]).toMatchObject({ resize: false, resizeStart: false, resizeEnd: false });
  });

  it("follows the drag in the fields, and saves it when the drag ends", async () => {
    await mountEditor({ trim: { frontMarkerSec: 30, backMarkerSec: 200 } });
    const dragged = { start: 45.04, end: 180.06 };

    await act(async () => wave.emit("region-update", dragged));
    expect(markerInput("front").value).toBe("0:45.0");
    expect(markerInput("back").value).toBe("3:00.1");
    expect(onTrimCommit, "nothing is saved mid-drag").not.toHaveBeenCalled();

    await act(async () => wave.emit("region-updated", dragged));
    expect(onTrimCommit).toHaveBeenCalledExactlyOnceWith("card-1", { frontMarkerSec: 45, backMarkerSec: 180.1 });
  });

  it("reads a range dragged to the very edges as no markers at all", async () => {
    await mountEditor({ trim: { frontMarkerSec: 30, backMarkerSec: 200 } });

    await act(async () => wave.emit("region-updated", { start: 0.01, end: 299.98 }));

    expect(onTrimCommit).toHaveBeenCalledExactlyOnceWith("card-1", { frontMarkerSec: null, backMarkerSec: null });
  });
});

describe("the player's own controls", () => {
  it("leaves duplicating the recording to the detail pane's header", async () => {
    await mountEditor();
    expect(text()).not.toContain("Duplicate");
  });
});

describe("text typed but not yet committed", () => {
  async function show(next: Partial<MumblerCard>): Promise<void> {
    await act(async () => {
      root?.render(
        React.createElement(WaveformEditor, {
          ref: handle,
          card: { ...card, ...next },
          previewSnippetSeconds: 10,
          skipIntervalSec: 5,
          disabled: false,
          onTrimCommit,
        }),
      );
    });
  }

  async function typeOnly(side: "front" | "back", value: string): Promise<void> {
    const input = markerInput(side);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("retains a pending front marker after leaving and returning before submitting the back marker", async () => {
    let settleFront!: () => void;
    let settleBack!: () => void;
    onTrimCommit
      .mockImplementationOnce(() => new Promise<void>((resolve) => { settleFront = resolve; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { settleBack = resolve; }));
    await mountEditor();
    await typeMarker("front", "30");
    await show({ id: "card-2" });
    await typeOnly("back", "another card's unfinished marker");
    await show({ id: "card-1" });
    await typeMarker("back", "200");
    try {
      expect(onTrimCommit).toHaveBeenNthCalledWith(2, "card-1", { frontMarkerSec: 30, backMarkerSec: 200 });
      await act(async () => settleFront());
      await show({ trim: { frontMarkerSec: 30, backMarkerSec: null } });
      expect(text()).toContain("Keep 0:30.0 to 3:20.0");
      expect(markerInput("back").value).toBe("200");
      await act(async () => settleBack());
      await show({ trim: { frontMarkerSec: 30, backMarkerSec: 200 } });
      expect(markerInput("front").value).toBe("0:30.0");
      expect(markerInput("back").value).toBe("3:20.0");
      await show({ id: "card-2" });
      expect(markerInput("back").value).toBe("another card's unfinished marker");
    } finally {
      await act(async () => { settleFront(); settleBack(); });
    }
  });

  it("keeps submitted raw text until success, and clears only that submitted version", async () => {
    let succeed!: () => void;
    onTrimCommit.mockImplementationOnce(() => new Promise<void>((resolve) => { succeed = resolve; }));
    await mountEditor();
    await typeMarker("front", "060");
    expect(markerInput("front").value).toBe("060");
    // A new edit can have the same characters; it still owns its own settlement.
    await typeOnly("front", "061");
    await typeOnly("front", "060");
    await act(async () => succeed());
    await show({ trim: { frontMarkerSec: 60, backMarkerSec: null } });
    expect(markerInput("front").value).toBe("060");
  });

  it("retires the old player immediately while another card's media is pending or fails", async () => {
    await mountEditor({ trim: { frontMarkerSec: 30, backMarkerSec: 200 } });
    await typeOnly("back", "4:12 unfinished");
    const staleTime = [...(wave.player.listeners.get("timeupdate") ?? [])];
    const staleReady = [...(wave.player.listeners.get("ready") ?? [])];
    const staleUpdate = [...(wave.regions.listeners.get("region-updated") ?? [])];
    let fail!: (error: Error) => void;
    getCardMediaSource.mockImplementationOnce(() => new Promise<string>((_resolve, reject) => { fail = reject; }));
    const staleHandle = handle.current!;
    await show({ id: "card-2", durationSec: 100 });
    expect(wave.player.destroyed).toBe(true);
    await act(async () => {
      for (const callback of staleTime) callback(88);
      for (const callback of staleReady) callback(999);
      for (const callback of staleUpdate) callback({ start: 45, end: 180 });
      await handle.current?.playPause();
      handle.current?.skipForward();
      await handle.current?.setFrontMarkerAtCursor();
      await handle.current?.playFirstSnippet();
      await staleHandle.setBackMarkerAtCursor();
    });
    expect(onTrimCommit).not.toHaveBeenCalled();
    expect(wave.player.playPauseCalls).toBe(0);
    expect(wave.player.seekedTo).toEqual([]);
    expect(wave.player.played).toEqual([]);
    expect(text()).toContain("Cursor: 0:00.0");
    expect(text()).toContain("Duration: 1:40.0");
    await act(async () => fail(new Error("cannot load card-2")));
    await act(async () => handle.current?.setBackMarkerAtCursor());
    expect(onTrimCommit).not.toHaveBeenCalled();
    expect(wave.createdUrls).toHaveLength(1);
    await show({ id: "card-1", trim: { frontMarkerSec: 30, backMarkerSec: 200 } });
    expect(markerInput("back").value).toBe("4:12 unfinished");
  });

  it("binds a replacement player to its loaded card even when media URLs are equal", async () => {
    await mountEditor();
    const retiredPlayer = wave.player;
    const retiredRegions = wave.regions;
    const staleUpdate = [...(retiredRegions.listeners.get("region-updated") ?? [])];
    await show({ id: "card-2" });
    expect(wave.createdUrls).toHaveLength(2);
    expect(wave.player).not.toBe(retiredPlayer);
    expect(wave.regions).not.toBe(retiredRegions);
    expect(retiredPlayer.destroyCalls).toBe(1);
    expect(retiredPlayer.listeners.size).toBe(0);
    expect(retiredRegions.listeners.size).toBe(0);
    expect(wave.player.destroyCalls).toBe(0);
    await act(async () => {
      for (const callback of staleUpdate) callback({ start: 99, end: 200 });
    });
    expect(onTrimCommit).not.toHaveBeenCalled();
    await act(async () => wave.emit("region-updated", { start: 42, end: 200 }));
    expect(onTrimCommit).toHaveBeenCalledExactlyOnceWith("card-2", { frontMarkerSec: 42, backMarkerSec: 200 });
  });

  it("settles only the submitted card's text after navigating away", async () => {
    let succeed!: () => void;
    onTrimCommit.mockImplementationOnce(() => new Promise<void>((resolve) => { succeed = resolve; }));
    await mountEditor();
    await typeMarker("front", "060");
    await show({ id: "card-2" });
    await typeOnly("front", "another unfinished marker");
    await act(async () => succeed());
    expect(markerInput("front").value).toBe("another unfinished marker");
    await show({ id: "card-1", trim: { frontMarkerSec: 60, backMarkerSec: null } });
    expect(markerInput("front").value).toBe("1:00.0");
  });

  it("retains a failed card's submitted draft when its save settles while another card is shown", async () => {
    let fail!: (error: Error) => void;
    onTrimCommit.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    await mountEditor({ trim: { frontMarkerSec: 30, backMarkerSec: null } });
    await typeMarker("front", "060");
    await show({ id: "card-2", trim: { frontMarkerSec: 10, backMarkerSec: null } });
    await act(async () => fail(new Error("save refused")));
    expect(markerInput("front").value).toBe("0:10.0");
    await show({ id: "card-1", trim: { frontMarkerSec: 30, backMarkerSec: null } });
    expect(markerInput("front").value).toBe("060");
    expect(text()).toContain("Keep 0:30.0 to the end");
  });

  it("survives the saved trim arriving for a commit of the other marker", async () => {
    await mountEditor();
    await typeOnly("back", "4:12");
    await typeMarker("front", "30");
    await show({ trim: { frontMarkerSec: 30, backMarkerSec: null } });
    expect(markerInput("back").value).toBe("4:12");
    expect(markerInput("front").value).toBe("0:30.0");
  });

  it("stays with its card across a switch to another card and back", async () => {
    await mountEditor();
    await typeMarker("front", "1:xx");
    await show({ id: "card-2" });
    expect(markerInput("front").value).toBe("");
    await show({ id: "card-1" });
    expect(markerInput("front").value).toBe("1:xx");
  });

  it("is not touched by a late failure of a commit made for another card", async () => {
    let fail!: (error: Error) => void;
    onTrimCommit.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    await mountEditor();
    await typeMarker("front", "30");
    await show({ id: "card-2", trim: { frontMarkerSec: 10, backMarkerSec: null } });
    await act(async () => fail(new Error("Cannot change trim markers while this card is being processed")));
    expect(markerInput("front").value).toBe("0:10.0");
    expect(text()).not.toContain("trim markers could not be saved");
  });
});


describe("the waveform summary and streamed playback", () => {
  function render(next: Partial<MumblerCard> = {}): Promise<void> {
    return act(async () => {
      root?.render(React.createElement(WaveformEditor, {
        ref: handle, card: { ...card, ...next }, previewSnippetSeconds: 10, skipIntervalSec: 5, disabled: false, onTrimCommit,
      }));
    });
  }

  beforeEach(() => {
    handle = createRef<WaveformEditorHandle>();
    root = createRoot(container);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  });

  it("builds the player on the summary and its own audio element, never on a download of the file", async () => {
    await render();
    const options = wave.player.options;
    expect(wave.player.url).toBe("mumbler-asset://media/card-1");
    expect(options.media).toBeInstanceOf(HTMLAudioElement);
    expect(options.duration).toBe(300);
    expect(options.peaks).toHaveLength(1);
    expect(getCardWaveformPeaks).toHaveBeenCalledExactlyOnceWith("card-1", expect.any(String));
  });

  it("draws a summary that arrives after the player in place, without rebuilding the player", async () => {
    let finish!: (peaks: Float32Array) => void;
    getCardWaveformPeaks.mockImplementationOnce(() => new Promise<Float32Array>((resolve) => { finish = resolve; }));
    await render();
    expect(text()).toContain("Drawing the waveform");
    expect(button("Play").disabled, "playback does not wait for the drawing").toBe(false);
    const summary = Float32Array.of(0.2, 0.9);
    await act(async () => finish(summary));
    expect(wave.players).toHaveLength(1);
    expect(wave.player.loads).toEqual([{ url: "mumbler-asset://media/card-1", peaks: [summary], duration: 300 }]);
    expect(text()).not.toContain("Drawing the waveform");
  });

  it("keeps playback and trimming when the waveform cannot be drawn", async () => {
    getCardWaveformPeaks.mockRejectedValueOnce(new Error("The waveform could not be drawn."));
    await render();
    expect(text()).toContain("The waveform could not be drawn. Playback and trimming still work.");
    expect(button("Play").disabled).toBe(false);
  });

  it("stops the summary run when another recording is opened before it arrives", async () => {
    getCardWaveformPeaks.mockImplementationOnce(() => new Promise<Float32Array>(() => undefined));
    await render();
    await render({ id: "card-2" });
    expect(cancelCardWaveformPeaks).toHaveBeenCalledExactlyOnceWith(getCardWaveformPeaks.mock.calls[0]![1]);
  });

  it("releases a completed summary by its own handle when navigation opens another recording", async () => {
    await render();
    const requestId = getCardWaveformPeaks.mock.calls[0]![1];
    await render({ id: "card-2" });
    expect(cancelCardWaveformPeaks).toHaveBeenCalledExactlyOnceWith(requestId);
    expect(getCardWaveformPeaks.mock.calls[1]![1]).not.toBe(requestId);
  });

  it("stops its audio element and lets go of the file when the player closes", async () => {
    await render();
    const media = wave.player.options.media as HTMLAudioElement;
    expect(media.getAttribute("src")).toBeNull();
    media.setAttribute("src", "mumbler-asset://media/card-1");
    await act(async () => root?.unmount());
    root = null;
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(media.getAttribute("src")).toBeNull();
  });
});
