import { createRequire } from "node:module";
import { normalizeWindowsNormalBounds, type WindowsNormalBounds } from "@shared/windows-placement";

export interface WindowsPlacement {
  read(): WindowsNormalBounds;
  restoreHidden(bounds: WindowsNormalBounds): void;
}

type NativeWindow = { getNativeWindowHandle(): Buffer };
let nativeApi: ReturnType<typeof loadNativeApi> | undefined;

function loadNativeApi() {
  const koffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
  const hwnd = koffi.pointer(koffi.opaque());
  const point = koffi.struct({ x: "int32_t", y: "int32_t" });
  const rect = koffi.struct({ left: "int32_t", top: "int32_t", right: "int32_t", bottom: "int32_t" });
  // WinUser.h includes rcDevice only for _MAC, not the Windows ABI.
  const placement = koffi.struct({
    length: "uint32_t", flags: "uint32_t", showCmd: "uint32_t",
    ptMinPosition: point, ptMaxPosition: point, rcNormalPosition: rect,
  });
  if (koffi.sizeof(placement) !== 44 || koffi.offsetof(placement, "rcNormalPosition") !== 28) {
    throw new Error("Unsupported WINDOWPLACEMENT ABI");
  }
  const monitorInfo = koffi.struct({ cbSize: "uint32_t", rcMonitor: rect, rcWork: rect, dwFlags: "uint32_t" });
  if (koffi.sizeof(monitorInfo) !== 40 || koffi.offsetof(monitorInfo, "rcWork") !== 20) {
    throw new Error("Unsupported MONITORINFO ABI");
  }
  const user32 = koffi.load("user32.dll");
  const kernel32 = koffi.load("kernel32.dll");
  const get = user32.func("__stdcall", "GetWindowPlacement", "int", [hwnd, koffi.inout(koffi.pointer(placement))]);
  const set = user32.func("__stdcall", "SetWindowPlacement", "int", [hwnd, koffi.pointer(placement)]);
  const getClient = user32.func("__stdcall", "GetClientRect", "int", [hwnd, koffi.out(koffi.pointer(rect))]);
  const monitorFromWindow = user32.func("__stdcall", "MonitorFromWindow", hwnd, [hwnd, "uint32_t"]);
  const getMonitor = user32.func("__stdcall", "GetMonitorInfoW", "int", [hwnd, koffi.inout(koffi.pointer(monitorInfo))]);
  const lastError = kernel32.func("__stdcall", "GetLastError", "uint32_t", []);
  const handle = (win: NativeWindow): bigint => {
    const bytes = win.getNativeWindowHandle();
    if (bytes.length !== koffi.sizeof(hwnd)) throw new Error("Invalid native window handle size");
    const value: unknown = koffi.decode(bytes, hwnd);
    if (typeof value !== "bigint" || value === 0n) throw new Error("Invalid native window handle");
    return value;
  };
  const check = (operation: string, result: unknown): void => {
    if (!result) {
      const nativeCode: number = lastError();
      throw Object.assign(new Error(`${operation} failed (Win32 ${nativeCode})`), {
        code: "NATIVE_PLACEMENT_FAILED", operation, nativeCode,
      });
    }
  };
  return { get, set, getClient, monitorFromWindow, getMonitor, handle, check,
    size: koffi.sizeof(placement), monitorSize: koffi.sizeof(monitorInfo) };
}

/** Electron's Windows DIP round trip rounds outward on both legs. Use the native
 * workspace-coordinate pair, which also owns fully off-screen recovery. Never capture
 * fullscreen placement; stable mode remains the controller's separate concern.
 * https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-windowplacement
 */
export function createWindowsPlacement(win: NativeWindow): WindowsPlacement | undefined {
  if (process.platform !== "win32") return undefined;
  const api = nativeApi ??= loadNativeApi();
  const readPlacement = () => {
    const value: { length: number; rcNormalPosition?: WindowsNormalBounds } = { length: api.size };
    api.check("GetWindowPlacement", api.get(api.handle(win), value));
    return value;
  };
  return {
    read: () => {
      const bounds = normalizeWindowsNormalBounds(readPlacement().rcNormalPosition);
      if (!bounds) throw new Error("GetWindowPlacement returned invalid normal bounds");
      return bounds;
    },
    restoreHidden: (bounds) => {
      const normal = normalizeWindowsNormalBounds(bounds);
      if (!normal) throw new Error("Invalid saved Windows normal bounds");
      const opening = readPlacement();
      const handle = api.handle(win);
      const restoreOpening = () => api.check("SetWindowPlacement (opening fallback)",
        api.set(handle, { ...opening, flags: 0, showCmd: 0 }));
      let oversized: boolean;
      try {
        api.check("SetWindowPlacement", api.set(handle,
          { ...opening, flags: 0, showCmd: 0, rcNormalPosition: normal }));
        const client: Partial<WindowsNormalBounds> = {};
        api.check("GetClientRect", api.getClient(handle, client));
        const monitor: unknown = api.monitorFromWindow(handle, 2); // MONITOR_DEFAULTTONEAREST
        if (typeof monitor !== "bigint" || monitor === 0n) throw new Error("MonitorFromWindow returned no monitor");
        const info: { cbSize: number; rcWork?: WindowsNormalBounds } = { cbSize: api.monitorSize };
        // These monitor APIs do not document GetLastError; do not report a stale code.
        if (!api.getMonitor(monitor, info)) throw new Error("GetMonitorInfoW failed");
        const area = normalizeWindowsNormalBounds(info.rcWork);
        const content = normalizeWindowsNormalBounds(client);
        if (!area || !content) throw new Error("Invalid native client or work-area bounds");
        // Content alone cannot fit. Ignore invisible resize-border overflow;
        // this is not a full-frame visibility or screen-coordinate conversion engine.
        oversized = content.right - content.left > area.right - area.left
          || content.bottom - content.top > area.bottom - area.top;
      } catch (error) {
        try { restoreOpening(); } catch (fallbackError) {
          throw new AggregateError([error, fallbackError], "Native placement and opening fallback failed", { cause: error });
        }
        throw error;
      }
      if (oversized) restoreOpening();
    },
  };
}
