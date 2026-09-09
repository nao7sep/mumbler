import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureWindowPlacement, initializeWindowPlacement } from "@main/window-placement";
import { createWindowsPlacement, type WindowsPlacement } from "@main/windows-placement";
import type { WindowPlacementRecord } from "@shared/app-shell";

vi.mock("@main/windows-placement", () => ({ createWindowsPlacement: vi.fn() }));

const logical = { x: 89, y: 81, width: 1201, height: 749 };
const raw = { left: 111, top: 101, right: 1613, bottom: 1038 };
class Window extends EventEmitter {
  maximized = false;
  minimized = false;
  fullscreen = false;
  getBounds = vi.fn(() => ({ ...logical }));
  getNormalBounds = vi.fn(() => ({ ...logical }));
  setBounds = vi.fn();
  getNativeWindowHandle = () => Buffer.alloc(8);
  isMaximized = () => this.maximized;
  isMinimized = () => this.minimized;
  isFullScreen = () => this.fullscreen;
}
function native(): WindowsPlacement {
  return { read: vi.fn(() => ({ ...raw })), restoreHidden: vi.fn() };
}
beforeEach(() => { vi.mocked(createWindowsPlacement).mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("one Windows restoration owner", () => {
  it("uses the native pair exclusively and captures hidden state before transient modes", () => {
    const win = new Window();
    const windows = native();
    vi.mocked(createWindowsPlacement).mockReturnValue(windows);
    const saved: WindowPlacementRecord = { normalBounds: logical, mode: "maximized", windowsNormalBounds: raw };
    const onError = vi.fn();
    const result = initializeWindowPlacement(win, saved, saved, onError);
    expect(windows.restoreHidden).toHaveBeenCalledExactlyOnceWith(raw);
    expect(win.setBounds).not.toHaveBeenCalled();
    expect(result.initial).toEqual(saved);
    expect(onError).not.toHaveBeenCalled();
  });
  it("restores compatible legacy bounds once then captures native coordinates", () => {
    const win = new Window();
    const windows = native();
    vi.mocked(createWindowsPlacement).mockReturnValue(windows);
    const saved: WindowPlacementRecord = { normalBounds: logical, mode: "normal" };
    const result = initializeWindowPlacement(win, saved, saved, vi.fn());
    expect(win.setBounds).toHaveBeenCalledExactlyOnceWith(logical);
    expect(windows.restoreHidden).not.toHaveBeenCalled();
    expect(result.initial.windowsNormalBounds).toEqual(raw);
  });
  it("contains native restoration failure without introducing a competing setter", () => {
    const win = new Window();
    const windows = native();
    const failure = new Error("SetWindowPlacement failed");
    vi.mocked(windows.restoreHidden).mockImplementation(() => { throw failure; });
    vi.mocked(createWindowsPlacement).mockReturnValue(windows);
    const saved: WindowPlacementRecord = { normalBounds: logical, mode: "maximized", windowsNormalBounds: raw };
    const onError = vi.fn();
    const result = initializeWindowPlacement(win, saved, saved, onError);
    expect(win.setBounds).not.toHaveBeenCalled();
    expect(result.initial.mode).toBe("maximized");
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  });
  it("falls back to the toolkit if the native library cannot initialize", () => {
    const win = new Window();
    const failure = new Error("native library unavailable");
    vi.mocked(createWindowsPlacement).mockImplementation(() => { throw failure; });
    const saved: WindowPlacementRecord = { normalBounds: logical, mode: "maximized", windowsNormalBounds: raw };
    const onError = vi.fn();
    const result = initializeWindowPlacement(win, saved, saved, onError);
    expect(win.setBounds).toHaveBeenCalledExactlyOnceWith(logical);
    expect(result.initial.mode).toBe("maximized");
    expect(result.windows).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(failure);
  });
  it("preserves mode without inventing geometry when both initial reads fail", () => {
    const win = new Window();
    const windows = native();
    vi.mocked(createWindowsPlacement).mockReturnValue(windows);
    win.getNormalBounds.mockImplementation(() => { throw new Error("logical read failed"); });
    vi.mocked(windows.read).mockImplementation(() => { throw new Error("native read failed"); });
    const onError = vi.fn();
    const result = initializeWindowPlacement(win, null, { normalBounds: null, mode: "maximized" }, onError);
    expect(result.initial).toEqual({ normalBounds: null, mode: "maximized" });
    expect(onError).toHaveBeenCalledTimes(2);
  });
});

describe("native placement capture", () => {
  it("captures the latest native rectangle on immediate orderly close", async () => {
    const win = new Window();
    const windows = native();
    const latest = { ...raw, left: 135, right: 1637 };
    vi.mocked(windows.read).mockReturnValue(latest);
    const persist = vi.fn(async (_record: WindowPlacementRecord) => {});
    const controller = configureWindowPlacement(win, { normalBounds: logical, mode: "normal", windowsNormalBounds: raw }, persist, vi.fn(), windows);
    controller.start();
    await controller.flush();
    expect(persist).toHaveBeenLastCalledWith({ normalBounds: logical, mode: "normal", windowsNormalBounds: latest });
    controller.dispose();
  });
  it.each(["minimized", "fullscreen"] as const)("never captures %s geometry", async (field) => {
    const win = new Window();
    const windows = native();
    const persist = vi.fn(async (_record: WindowPlacementRecord) => {});
    const controller = configureWindowPlacement(win, { normalBounds: logical, mode: "maximized", windowsNormalBounds: raw }, persist, vi.fn(), windows);
    controller.start();
    win[field] = true;
    await controller.flush();
    expect(windows.read).not.toHaveBeenCalled();
    expect(persist).toHaveBeenLastCalledWith({ normalBounds: logical, mode: "maximized", windowsNormalBounds: raw });
    controller.dispose();
  });
  it("retains the pending native normal snapshot when fullscreen interrupts a debounce", async () => {
    vi.useFakeTimers();
    const win = new Window();
    const windows = native();
    const latest = { ...raw, left: 135, right: 1637 };
    vi.mocked(windows.read).mockReturnValue(latest);
    const persist = vi.fn(async (_record: WindowPlacementRecord) => {});
    const controller = configureWindowPlacement(win, { normalBounds: logical, mode: "normal", windowsNormalBounds: raw }, persist, vi.fn(), windows);
    controller.start();
    win.emit("move");
    win.fullscreen = true;
    win.emit("enter-full-screen");
    await controller.flush();
    await vi.runAllTimersAsync();
    expect(windows.read).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledExactlyOnceWith({ normalBounds: logical, mode: "normal", windowsNormalBounds: latest });
    controller.dispose();
  });
  it.each(["native", "logical"] as const)("persists maximized intent when the %s geometry query fails", async (source) => {
    const win = new Window();
    const windows = native();
    const failure = new Error("native read failed");
    if (source === "native") vi.mocked(windows.read).mockImplementation(() => { throw failure; });
    else win.getNormalBounds.mockImplementation(() => { throw failure; });
    const persist = vi.fn(async (_record: WindowPlacementRecord) => {});
    const onError = vi.fn();
    const controller = configureWindowPlacement(win, { normalBounds: logical, mode: "normal", windowsNormalBounds: raw }, persist, onError, windows);
    controller.start();
    win.maximized = true;
    win.emit("maximize");
    await controller.flush();
    expect(persist).toHaveBeenLastCalledWith({ normalBounds: logical, mode: "maximized", windowsNormalBounds: raw });
    expect(onError).toHaveBeenCalledWith(failure);
    controller.dispose();
  });
});
