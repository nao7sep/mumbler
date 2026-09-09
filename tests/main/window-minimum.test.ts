import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const monitor = vi.hoisted(() => ({ workAreaSize: { width: 1920, height: 1040 } }));
const screenEvents = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn() }));
vi.mock("electron", () => ({
  screen: { getDisplayMatching: () => monitor, ...screenEvents },
}));
import { configureWindowMinimum, fitNativeMinimum } from "@main/window-minimum";

class FakeWindow extends EventEmitter {
  maximized = false;
  minimized = false;
  fullScreen = false;
  minimum = [0, 0];
  size = [1000, 800];
  isDestroyed = () => false;
  isMaximized = () => this.maximized;
  isMinimized = () => this.minimized;
  isFullScreen = () => this.fullScreen;
  getBounds = () => ({ x: 0, y: 0, width: this.size[0]!, height: this.size[1]! });
  getContentBounds = () => this.getBounds();
  getMinimumSize = () => this.minimum;
  getSize = () => this.size;
  setMinimumSize = vi.fn((width: number, height: number) => { this.minimum = [width, height]; });
  setSize = vi.fn((width: number, height: number) => { this.size = [width, height]; });
  center = vi.fn();
}
const floor = { width: 1200, height: 900 };
beforeEach(() => { monitor.workAreaSize = { width: 1920, height: 1040 }; vi.clearAllMocks(); });

describe("native content minimum", () => {
  it("caps only native constraints, preserving the complete content floor", () => {
    expect(fitNativeMinimum(floor, { width: 1000, height: 700 })).toEqual({ width: 1000, height: 700 });
    expect(floor).toEqual({ width: 1200, height: 900 });
    expect(fitNativeMinimum(floor, { width: 1920, height: 1040 }, { width: 16, height: 39 }))
      .toEqual({ width: 1216, height: 939 });
  });
  it("fits the designed opening to a constrained work area", () => {
    monitor.workAreaSize = { width: 1000, height: 700 };
    const win = new FakeWindow();
    configureWindowMinimum(win as never, () => floor, vi.fn());
    expect(win.minimum).toEqual([1000, 700]);
    expect(win.size).toEqual([1000, 700]);
    expect(win.center).toHaveBeenCalledOnce();
  });
  it("prepares useful opening bounds, then restores the full floor without recentering", () => {
    monitor.workAreaSize = { width: 1000, height: 700 };
    const win = new FakeWindow();
    const refresh = configureWindowMinimum(win as never, () => floor, vi.fn());
    expect(win.size).toEqual([1000, 700]);
    expect(win.center).toHaveBeenCalledOnce();
    win.center.mockClear();
    monitor.workAreaSize = { width: 1920, height: 1040 };
    refresh();
    expect(win.minimum).toEqual([1200, 900]);
    expect(win.size).toEqual([1200, 900]);
    win.setMinimumSize.mockClear();
    refresh();
    expect(win.setMinimumSize).not.toHaveBeenCalled();
    win.emit("move");
    expect(win.center).not.toHaveBeenCalled();
  });
  it.each(["maximized", "minimized", "fullScreen"] as const)("defers sizing while %s", (mode) => {
    const win = new FakeWindow();
    const refresh = configureWindowMinimum(win as never, () => floor, vi.fn());
    win[mode] = true;
    win.setMinimumSize.mockClear();
    win.setSize.mockClear();
    monitor.workAreaSize = { width: 800, height: 600 };
    refresh();
    expect(win.setMinimumSize).not.toHaveBeenCalled();
    expect(win.setSize).not.toHaveBeenCalled();
    win[mode] = false;
    win.emit("restore");
    expect(win.minimum).toEqual([800, 600]);
  });
  it("contains native errors and removes display listeners on close", () => {
    const win = new FakeWindow();
    const onError = vi.fn();
    win.setMinimumSize.mockImplementationOnce(() => { throw new Error("native size failed"); });
    configureWindowMinimum(win as never, () => floor, onError);
    expect(onError).toHaveBeenCalledOnce();
    win.emit("closed");
    expect(screenEvents.off).toHaveBeenCalledWith("display-metrics-changed", expect.any(Function));
    expect(win.eventNames()).toEqual([]);
  });
});
