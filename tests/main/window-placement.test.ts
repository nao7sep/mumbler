import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyRestoredBounds, configureWindowPlacement, fitWindowBounds, resolveWindowRestoration } from "@main/window-placement";
import type { WindowBounds, WindowPlacementRecord } from "@shared/app-shell";

const opening = { x: 10, y: 30, width: 1200, height: 800 };
class FakeWindow extends EventEmitter {
  bounds: WindowBounds = { ...opening };
  normalBounds: WindowBounds = { ...opening };
  maximized = false;
  minimized = false;
  fullScreen = false;
  getBounds(): WindowBounds { return { ...this.bounds }; }
  getNormalBounds(): WindowBounds {
    return { ...(this.maximized || this.minimized || this.fullScreen ? this.normalBounds : this.bounds) };
  }
  setBounds(bounds: WindowBounds): void { this.bounds = { ...bounds }; }
  isMaximized(): boolean { return this.maximized; }
  isMinimized(): boolean { return this.minimized; }
  isFullScreen(): boolean { return this.fullScreen; }
}

function setup(
  mode: "normal" | "maximized" = "normal",
  write?: (record: WindowPlacementRecord) => Promise<unknown>,
) {
  const win = new FakeWindow();
  const saved: WindowPlacementRecord[] = [];
  const onError = vi.fn();
  const persist = write ?? (async (record: WindowPlacementRecord) => { saved.push(record); });
  const controller = configureWindowPlacement(win, { normalBounds: win.getBounds(), mode }, persist, onError);
  return { win, saved, controller, onError };
}
afterEach(() => vi.useRealTimers());

describe("window restoration", () => {
  const minimum = { width: 600, height: 400 };
  const areas = [{ x: 0, y: 30, width: 1920, height: 1010 }, { x: -1280, y: 30, width: 1280, height: 950 }];
  it("uses the approved default when state is absent", () => {
    expect(resolveWindowRestoration(null, minimum, areas)).toEqual({ normalBounds: null, mode: "maximized" });
  });
  it.each([640, 960])("preserves useful split placement at width %i", (width) => {
    const saved: WindowPlacementRecord = { normalBounds: { x: 0, y: 30, width, height: 1010 }, mode: "normal" };
    expect(resolveWindowRestoration(saved, minimum, areas)).toEqual(saved);
  });
  it("preserves a usable negative-origin display placement", () => {
    const saved: WindowPlacementRecord = { normalBounds: { x: -1200, y: 60, width: 1000, height: 700 }, mode: "normal" };
    expect(resolveWindowRestoration(saved, minimum, areas)).toEqual(saved);
  });
  it("fits partially visible and undersized bounds using work-area origins", () => {
    expect(fitWindowBounds({ x: -1200, y: 10, width: 500, height: 1000 }, minimum, [areas[1]!]))
      .toEqual({ x: -1200, y: 30, width: 600, height: 950 });
    expect(fitWindowBounds({ x: 1800, y: 900, width: 900, height: 700 }, minimum, areas))
      .toEqual({ x: 1020, y: 340, width: 900, height: 700 });
  });
  it("caps a minimum larger than the work area without inventing spare-space rules", () => {
    expect(fitWindowBounds({ x: 0, y: 30, width: 1200, height: 800 }, { width: 1400, height: 900 },
      [{ x: 0, y: 30, width: 1000, height: 700 }])).toEqual({ x: 0, y: 30, width: 1000, height: 700 });
  });
  it("does not drift when adjusted placement is restored repeatedly", () => {
    let bounds = { x: 1800, y: 900, width: 900, height: 700 };
    const adjusted = fitWindowBounds(bounds, minimum, areas)!;
    for (let restart = 0; restart < 5; restart++) bounds = fitWindowBounds(bounds, minimum, areas)!;
    expect(bounds).toEqual(adjusted);
  });
  it.each([NaN, Infinity, 0.5])("rejects malformed coordinate %s", (x) => {
    expect(fitWindowBounds({ x, y: 30, width: 900, height: 700 }, minimum, areas)).toBeNull();
  });
  it.each([0, -1])("rejects invalid size %s", (width) => {
    expect(fitWindowBounds({ x: 0, y: 30, width, height: 700 }, minimum, areas)).toBeNull();
  });
  it.each(["normal", "maximized"] as const)("preserves %s mode when the saved display is unavailable", (mode) => {
    expect(resolveWindowRestoration({ normalBounds: { x: 9999, y: 9999, width: 1200, height: 800 }, mode }, minimum, areas))
      .toEqual({ normalBounds: null, mode });
  });
});

describe("applying restored bounds", () => {
  it("accepts an OS-adjusted rectangle without a correction loop", () => {
    const win = new FakeWindow();
    const target = { x: 100, y: 100, width: 1300, height: 850 };
    const setter = vi.spyOn(win, "setBounds").mockImplementationOnce((bounds) => {
      win.bounds = { ...bounds, width: bounds.width - 1 };
    });
    const onError = vi.fn();
    expect(applyRestoredBounds(win, target, onError)).toBe(true);
    expect(setter).toHaveBeenCalledOnce();
    expect(win.bounds).toEqual({ ...target, width: 1299 });
    expect(onError).not.toHaveBeenCalled();
  });
  it("contains an actual setter failure and uses the opening bounds", () => {
    const win = new FakeWindow();
    const failure = new Error("native setter failed");
    vi.spyOn(win, "setBounds").mockImplementationOnce(() => { throw failure; });
    const onError = vi.fn();
    expect(applyRestoredBounds(win, { x: 50, y: 60, width: 1300, height: 850 }, onError)).toBe(false);
    expect(win.bounds).toEqual(opening);
    expect(onError).toHaveBeenCalledWith(failure);
  });
});

describe("window placement capture", () => {
  it("excludes initialization but accepts later normal events without manual flags", async () => {
    vi.useFakeTimers();
    const { win, saved, controller } = setup();
    win.bounds = { x: 50, y: 60, width: 1300, height: 850 };
    win.emit("move");
    await controller.flush();
    await vi.runAllTimersAsync();
    expect(saved).toEqual([]);
    controller.start();
    win.emit("move");
    win.emit("resize");
    await vi.runAllTimersAsync();
    expect(saved).toEqual([{ normalBounds: win.bounds, mode: "normal" }]);
  });
  it("coalesces a move and resize into the latest geometry", async () => {
    vi.useFakeTimers();
    const { win, saved, controller } = setup();
    controller.start();
    win.bounds = { x: 50, y: 60, width: 1300, height: 850 };
    win.emit("move");
    win.bounds = { x: 70, y: 80, width: 1350, height: 875 };
    win.emit("resize");
    await vi.runAllTimersAsync();
    expect(saved).toEqual([{ normalBounds: win.bounds, mode: "normal" }]);
  });
  it("uses Electron normal bounds while maximized and lands after unmaximize", async () => {
    vi.useFakeTimers();
    const { win, saved, controller } = setup();
    controller.start();
    win.normalBounds = { x: 80, y: 90, width: 1400, height: 900 };
    win.maximized = true;
    win.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    win.emit("maximize");
    await controller.flush();
    expect(saved.at(-1)).toEqual({ normalBounds: win.normalBounds, mode: "maximized" });
    win.maximized = false;
    win.bounds = { ...win.normalBounds };
    win.emit("unmaximize");
    await vi.runAllTimersAsync();
    expect(saved.at(-1)).toEqual({ normalBounds: win.bounds, mode: "normal" });
  });
  it.each(["minimized", "fullScreen"] as const)("preserves either stable mode on %s close", async (field) => {
    for (const mode of ["normal", "maximized"] as const) {
      const { win, saved, controller } = setup(mode);
      controller.start();
      win[field] = true;
      win.bounds = { x: 0, y: 0, width: 300, height: 200 };
      win.emit(field === "minimized" ? "minimize" : "enter-full-screen");
      win.emit("move");
      win.emit("resize");
      await controller.flush();
      expect(saved.at(-1)).toEqual({ normalBounds: opening, mode });
      controller.dispose();
    }
  });
  it("keeps the pending normal snapshot when fullscreen interrupts capture", async () => {
    vi.useFakeTimers();
    const { win, saved, controller } = setup();
    controller.start();
    const latest = { x: 45, y: 55, width: 1320, height: 850 };
    win.bounds = latest;
    win.emit("move");
    win.fullScreen = true;
    win.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    win.emit("enter-full-screen");
    await controller.flush();
    expect(saved).toEqual([{ normalBounds: latest, mode: "normal" }]);
  });
  it("resumes normal capture after leaving a transient mode", async () => {
    vi.useFakeTimers();
    const { win, saved, controller } = setup();
    controller.start();
    win.minimized = true;
    win.emit("minimize");
    win.minimized = false;
    win.bounds = { x: 90, y: 100, width: 1350, height: 860 };
    win.emit("restore");
    await vi.runAllTimersAsync();
    expect(saved).toEqual([{ normalBounds: win.bounds, mode: "normal" }]);
  });
  it("reads the latest rectangle on immediate close even before a move event", async () => {
    vi.useFakeTimers();
    const { win, saved, controller } = setup();
    controller.start();
    win.emit("move");
    win.bounds = { x: 110, y: 120, width: 1500, height: 920 };
    await controller.flush();
    await vi.runAllTimersAsync();
    expect(saved).toEqual([{ normalBounds: win.bounds, mode: "normal" }]);
  });
  it("removes pending saves and listeners on disposal", async () => {
    vi.useFakeTimers();
    const { win, saved, controller } = setup();
    controller.start();
    win.emit("move");
    controller.dispose();
    win.emit("move");
    await controller.flush();
    await vi.runAllTimersAsync();
    expect(saved).toEqual([]);
    expect(win.eventNames()).toEqual([]);
  });
  it("contains a persistence failure", async () => {
    const failure = new Error("state write failed");
    const { controller, onError } = setup("normal", async () => { throw failure; });
    controller.start();
    await controller.flush();
    expect(onError).toHaveBeenCalledWith(failure);
  });
  it("waits for close-time persistence", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { controller } = setup("normal", async () => blocked);
    controller.start();
    let finished = false;
    const flush = controller.flush().then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await flush;
    expect(finished).toBe(true);
  });
});
