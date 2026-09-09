import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const hwnd = { kind: "pointer" };
  const get = vi.fn((_handle: bigint, output: Record<string, unknown>) => {
    // Koffi marshals inline structs on entry to an _Inout_ call; null is invalid.
    if (output.rcNormalPosition === null) throw new TypeError("Unexpected Null value, expected object");
    Object.assign(output, { flags: 2, showCmd: 3, ptMinPosition: { x: -1, y: -1 },
      ptMaxPosition: { x: -1, y: -1 }, rcNormalPosition: { left: 111, top: 101, right: 1613, bottom: 1038 } });
    return 1;
  });
  const set = vi.fn(() => 1);
  const getClient = vi.fn((_handle: bigint, output: Record<string, unknown>) => {
    Object.assign(output, { left: 0, top: 0, right: 1480, bottom: 880 });
    return 1;
  });
  const monitorFromWindow = vi.fn((_handle: bigint, _flags: number): unknown => 456n);
  const getMonitor = vi.fn((_handle: bigint, output: Record<string, unknown>) => {
    if (output.rcWork === null || output.rcMonitor === null) throw new TypeError("Invalid inline monitor rectangle");
    Object.assign(output, { rcMonitor: { left: -1920, top: -1200, right: 0, bottom: 0 },
      rcWork: { left: -1880, top: -1160, right: 0, bottom: 0 } });
    return 1;
  });
  const lastError = vi.fn(() => 1400);
  const koffi = {
    opaque: vi.fn(() => ({})),
    pointer: vi.fn(() => hwnd),
    struct: vi.fn((members: Record<string, unknown>) => ({ members })),
    sizeof: vi.fn((value: unknown) => value === hwnd ? 8
      : "cbSize" in (value as { members: Record<string, unknown> }).members ? 40 : 44),
    offsetof: vi.fn((_value: unknown, field: string): number => field === "rcWork" ? 20 : 28),
    inout: vi.fn((value: unknown) => value),
    out: vi.fn((value: unknown) => value),
    decode: vi.fn((): unknown => 123n),
    load: vi.fn(() => ({
      func: vi.fn((_abi: string, name: string) => {
        if (name === "GetWindowPlacement") return get;
        if (name === "SetWindowPlacement") return set;
        if (name === "GetClientRect") return getClient;
        if (name === "MonitorFromWindow") return monitorFromWindow;
        if (name === "GetMonitorInfoW") return getMonitor;
        if (name === "GetLastError") return lastError;
        throw new Error("Unexpected native function");
      }),
    })),
  };
  return { koffi, get, set, getClient, monitorFromWindow, getMonitor, lastError, require: vi.fn(() => koffi), hwnd };
});
vi.mock("node:module", () => ({ createRequire: () => mocks.require }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("process", { ...process, platform: "win32" });
});
afterEach(() => { vi.unstubAllGlobals(); });
const bytes = Buffer.alloc(8);
const win = { getNativeWindowHandle: () => bytes };
const normal = { left: 111, top: 101, right: 1613, bottom: 1038 };
const load = () => import("@main/windows-placement");

describe("Windows native placement binding", () => {
  it("does not load a Windows addon on other platforms", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    expect((await load()).createWindowsPlacement(win)).toBeUndefined();
    expect(mocks.require).not.toHaveBeenCalled();
  });
  it("decodes the borrowed HWND value and initializes the input/output ABI size", async () => {
    const native = (await load()).createWindowsPlacement(win)!;
    expect(native.read()).toEqual(normal);
    expect(mocks.koffi.decode).toHaveBeenCalledWith(bytes, mocks.hwnd);
    expect(mocks.get).toHaveBeenCalledWith(123n, expect.objectContaining({ length: 44 }));
    expect(mocks.get.mock.calls[0]?.[0]).not.toBe(bytes);
  });
  it("restores only the native rectangle while hidden, without replaying transient flags", async () => {
    const native = (await load()).createWindowsPlacement(win)!;
    native.restoreHidden(normal);
    expect(mocks.set).toHaveBeenCalledWith(123n, expect.objectContaining({
      length: 44, flags: 0, showCmd: 0, rcNormalPosition: normal,
    }));
    expect(mocks.set).toHaveBeenCalledOnce();
    expect(mocks.monitorFromWindow).toHaveBeenCalledWith(123n, 2);
    expect(mocks.getMonitor).toHaveBeenCalledWith(456n, expect.objectContaining({ cbSize: 40 }));
  });
  it("never queries work-area fit while capturing normal placement", async () => {
    const native = (await load()).createWindowsPlacement(win)!;
    native.read();
    expect(mocks.getClient).not.toHaveBeenCalled();
    expect(mocks.monitorFromWindow).not.toHaveBeenCalled();
    expect(mocks.getMonitor).not.toHaveBeenCalled();
  });
  it.each([{ right: 1881, bottom: 900 }, { right: 1000, bottom: 1161 }])(
    "restores the opening native pair once when content exceeds the nonzero-origin work area: %j", async (size) => {
      mocks.getClient.mockImplementationOnce((_handle, output) => {
        Object.assign(output, { left: 0, top: 0, ...size });
        return 1;
      });
      const native = (await load()).createWindowsPlacement(win)!;
      const saved = { left: 100, top: 100, right: 3300, bottom: 1900 };
      native.restoreHidden(saved);
      expect(mocks.set).toHaveBeenCalledTimes(2);
      expect(mocks.set).toHaveBeenNthCalledWith(1, 123n, expect.objectContaining({ rcNormalPosition: saved }));
      expect(mocks.set).toHaveBeenNthCalledWith(2, 123n, expect.objectContaining({
        rcNormalPosition: normal, flags: 0, showCmd: 0,
      }));
      expect(mocks.getClient).toHaveBeenCalledOnce();
    });
  it("accepts fitting client dimensions despite outer resize-border overflow", async () => {
    mocks.getClient.mockImplementationOnce((_handle, output) => {
      Object.assign(output, { left: 0, top: 0, right: 1880, bottom: 1160 });
      return 1;
    });
    const native = (await load()).createWindowsPlacement(win)!;
    native.restoreHidden({ left: -1888, top: -1168, right: 8, bottom: 8 });
    expect(mocks.set).toHaveBeenCalledOnce();
  });
  it.each(["getClient", "monitorFromWindow", "getMonitor"] as const)(
    "restores opening once and retains the original %s query failure", async (operation) => {
      const failure = new Error("native query failed", { cause: new Error("original cause") });
      mocks[operation].mockImplementationOnce(() => { throw failure; });
      const native = (await load()).createWindowsPlacement(win)!;
      expect(() => native.restoreHidden(normal)).toThrow(failure);
      expect(mocks.set).toHaveBeenCalledTimes(2);
      expect(mocks.set).toHaveBeenLastCalledWith(123n, expect.objectContaining({
        rcNormalPosition: normal, flags: 0, showCmd: 0,
      }));
    });
  it("preserves both failures when query recovery also fails", async () => {
    const failure = new Error("client query failed", { cause: new Error("query cause") });
    mocks.getClient.mockImplementationOnce(() => { throw failure; });
    mocks.set.mockReturnValueOnce(1).mockReturnValueOnce(0);
    const native = (await load()).createWindowsPlacement(win)!;
    let caught: unknown;
    try { native.restoreHidden(normal); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).cause).toBe(failure);
    expect((caught as AggregateError).errors).toEqual([failure, expect.objectContaining({
      operation: "SetWindowPlacement (opening fallback)", nativeCode: 1400,
    })]);
    expect(mocks.set).toHaveBeenCalledTimes(2);
  });
  it("does not retry a failed oversized-window fallback", async () => {
    mocks.getClient.mockImplementationOnce((_handle, output) => {
      Object.assign(output, { left: 0, top: 0, right: 3200, bottom: 1800 });
      return 1;
    });
    mocks.set.mockReturnValueOnce(1).mockReturnValueOnce(0);
    const native = (await load()).createWindowsPlacement(win)!;
    expect(() => native.restoreHidden(normal)).toThrow("opening fallback");
    expect(mocks.set).toHaveBeenCalledTimes(2);
  });
  it.each(["getClient", "monitorFromWindow", "getMonitor"] as const)(
    "contains a native %s failure return", async (operation) => {
      mocks[operation].mockReturnValueOnce(0);
      const native = (await load()).createWindowsPlacement(win)!;
      expect(() => native.restoreHidden(normal)).toThrow();
      expect(mocks.set).toHaveBeenCalledTimes(2);
      if (operation !== "getClient") expect(mocks.lastError).not.toHaveBeenCalled();
    });
  it("rejects invalid returned work-area geometry with one fallback", async () => {
    mocks.getMonitor.mockImplementationOnce((_handle, output) => {
      Object.assign(output, { rcWork: { left: 0, top: 0, right: 0, bottom: 100 } });
      return 1;
    });
    const native = (await load()).createWindowsPlacement(win)!;
    expect(() => native.restoreHidden(normal)).toThrow("Invalid native client or work-area bounds");
    expect(mocks.set).toHaveBeenCalledTimes(2);
  });
  it("rejects a mismatched monitor ABI before loading system libraries", async () => {
    mocks.koffi.offsetof.mockReturnValueOnce(28).mockReturnValueOnce(24);
    const module = await load();
    expect(() => module.createWindowsPlacement(win)).toThrow("Unsupported MONITORINFO ABI");
    expect(mocks.koffi.load).not.toHaveBeenCalled();
  });
  it("rejects a mismatched ABI before loading system libraries", async () => {
    mocks.koffi.offsetof.mockReturnValueOnce(32);
    const module = await load();
    expect(() => module.createWindowsPlacement(win)).toThrow("Unsupported WINDOWPLACEMENT ABI");
    expect(mocks.koffi.load).not.toHaveBeenCalled();
  });
  it("rejects invalid native handles rather than passing the buffer address", async () => {
    const native = (await load()).createWindowsPlacement({ getNativeWindowHandle: () => Buffer.alloc(4) })!;
    expect(() => native.read()).toThrow("Invalid native window handle size");
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it("rejects a null decoded HWND", async () => {
    mocks.koffi.decode.mockReturnValueOnce(0n);
    const native = (await load()).createWindowsPlacement(win)!;
    expect(() => native.read()).toThrow("Invalid native window handle");
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it.each(["get", "set"] as const)("surfaces %s failure with the Win32 code", async (operation) => {
    mocks[operation].mockReturnValueOnce(0);
    const native = (await load()).createWindowsPlacement(win)!;
    const action = operation === "get" ? () => native.read() : () => native.restoreHidden(normal);
    expect(action).toThrow(expect.objectContaining({
      code: "NATIVE_PLACEMENT_FAILED", nativeCode: 1400,
      operation: operation === "get" ? "GetWindowPlacement" : "SetWindowPlacement",
    }));
    expect(mocks.lastError).toHaveBeenCalledOnce();
  });
  it("rejects invalid native rectangles before the setter", async () => {
    const native = (await load()).createWindowsPlacement(win)!;
    expect(() => native.restoreHidden({ ...normal, right: normal.left })).toThrow("Invalid saved Windows normal bounds");
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
