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
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const player = {
    duration: 300,
    currentTime: 0,
    played: [] as Array<{ startSec: number; endSec: number }>,
    seekedTo: [] as number[],
    playPauseCalls: 0,
    destroyed: false,
    on(event: string, callback: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), callback]);
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== callback));
    },
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
    destroy: () => {
      player.destroyed = true;
    },
  };
  const regions = {
    added: [] as Array<Record<string, unknown>>,
    on: (event: string, callback: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), callback]);
      return () => undefined;
    },
    addRegion: (options: Record<string, unknown>) => {
      regions.added.push(options);
      return { ...options, setOptions: () => undefined, remove: () => undefined };
    },
  };
  return {
    listeners,
    player,
    regions,
    emit(event: string, ...args: unknown[]): void {
      for (const callback of listeners.get(event) ?? []) callback(...args);
    },
    reset(): void {
      listeners.clear();
      regions.added = [];
      Object.assign(player, {
        duration: 300,
        currentTime: 0,
        played: [],
        seekedTo: [],
        playPauseCalls: 0,
        destroyed: false,
      });
    },
  };
});

vi.mock("wavesurfer.js", () => ({ default: { create: () => wave.player } }));
vi.mock("wavesurfer.js/dist/plugins/regions.esm.js", () => ({ default: { create: () => wave.regions } }));

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
let onDuplicateCard: Mock<(cardId: string) => Promise<void>>;
let getCardMediaSource: Mock<(cardId: string) => Promise<string>>;
let handle: React.RefObject<WaveformEditorHandle | null>;

/** Mounts the editor on `trim` and brings the player to the state after load. */
async function mountEditor(options: { trim?: CardTrim; disabled?: boolean; ready?: boolean } = {}): Promise<void> {
  handle = createRef<WaveformEditorHandle>();
  root = createRoot(container);
  await act(async () => {
    root?.render(
      React.createElement(WaveformEditor, {
        ref: handle,
        card: { ...card, trim: options.trim ?? card.trim },
        previewSnippetSeconds: 10,
        skipIntervalSec: 5,
        disabled: options.disabled ?? false,
        onDuplicateCard,
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
  onDuplicateCard = vi.fn(async () => undefined);
  getCardMediaSource = vi.fn(async () => "mumbler-asset://media/card-1");
  (window as unknown as { mumbler: unknown }).mumbler = { getCardMediaSource };
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
    wave.player.duration = 425.5;
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

  it("puts the markers back and says so when the save is refused", async () => {
    onTrimCommit.mockRejectedValue(new Error("Front trim cannot exceed audio duration."));
    await mountEditor({ trim: { frontMarkerSec: 30, backMarkerSec: 200 } });

    await typeMarker("front", "1:00.0");

    expect(text()).toContain("The trim markers could not be saved. The previous markers remain in effect");
    expect(markerInput("front").value, "the markers in effect are shown again").toBe("0:30.0");
  });

  it("offers no marker editing while the card is busy", async () => {
    await mountEditor({ trim: { frontMarkerSec: 30, backMarkerSec: 200 }, disabled: true });

    expect(markerInput("front").disabled).toBe(true);
    expect(button("Set Front at Cursor").disabled).toBe(true);
    expect(button("Clear Markers").disabled).toBe(true);
    expect(button("Duplicate Card").disabled).toBe(true);
  });
});

describe("listening back", () => {
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

describe("duplicating the recording", () => {
  it("asks for a duplicate, and says so when that fails", async () => {
    await mountEditor();

    await click("Duplicate Card");
    expect(onDuplicateCard).toHaveBeenCalledExactlyOnceWith("card-1");

    onDuplicateCard.mockRejectedValue(new Error("no space"));
    await click("Duplicate Card");
    expect(text()).toContain("The recording could not be duplicated");
  });
});
