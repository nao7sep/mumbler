import type { WindowBounds, WindowPlacementMode, WindowPlacementRecord } from "@shared/app-shell";
import { createWindowsPlacement, type WindowsPlacement } from "./windows-placement";

export function resolveWindowRestoration(
  saved: WindowPlacementRecord | null,
  minimum: { width: number; height: number },
  workAreas: readonly WindowBounds[],
): { normalBounds: WindowBounds | null; mode: WindowPlacementMode } {
  return {
    normalBounds: saved?.normalBounds ? fitWindowBounds(saved.normalBounds, minimum, workAreas) : null,
    mode: saved?.mode === "normal" || saved?.mode === "maximized" ? saved.mode : "maximized",
  };
}

export function fitWindowBounds(
  bounds: WindowBounds,
  minimum: { width: number; height: number },
  workAreas: readonly WindowBounds[],
): WindowBounds | null {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger)
    || bounds.width <= 0 || bounds.height <= 0) return null;
  const area = workAreas.find((item) =>
    [item.x, item.y, item.width, item.height].every(Number.isFinite)
    && item.width > 0 && item.height > 0
    && bounds.x < item.x + item.width && bounds.y < item.y + item.height
    && bounds.x + bounds.width > item.x && bounds.y + bounds.height > item.y);
  if (!area) return null;
  const width = Math.min(area.width, Math.max(minimum.width, bounds.width));
  const height = Math.min(area.height, Math.max(minimum.height, bounds.height));
  return {
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
    width, height,
  };
}

export type PlacementWindow = {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  getBounds(): WindowBounds;
  getNormalBounds(): WindowBounds;
  setBounds(bounds: WindowBounds): void;
  isMaximized(): boolean;
  isMinimized(): boolean;
  isFullScreen(): boolean;
};

export function applyRestoredBounds(
  win: Pick<PlacementWindow, "getBounds" | "setBounds">,
  bounds: WindowBounds,
  onError: (error: unknown) => void,
): boolean {
  let opening: WindowBounds | undefined;
  try {
    opening = win.getBounds();
    win.setBounds(bounds);
    return true;
  } catch (error) {
    onError(error);
    if (opening) {
      try { win.setBounds(opening); } catch (fallbackError) { onError(fallbackError); }
    }
    return false;
  }
}

export function initializeWindowPlacement(
  win: PlacementWindow & { getNativeWindowHandle(): Buffer },
  saved: WindowPlacementRecord | null,
  restoration: { normalBounds: WindowBounds | null; mode: WindowPlacementMode },
  onError: (error: unknown) => void,
): { initial: WindowPlacementRecord; windows: WindowsPlacement | undefined } {
  let windows: WindowsPlacement | undefined;
  try { windows = createWindowsPlacement(win); } catch (error) { onError(error); }
  if (windows && saved?.windowsNormalBounds) {
    try { windows.restoreHidden(saved.windowsNormalBounds); } catch (error) { onError(error); }
  } else if (restoration.normalBounds) {
    applyRestoredBounds(win, restoration.normalBounds, onError);
  }
  // A geometry read failure leaves the useful opening window and valid mode
  // intact. It does not require inventing a rectangle to persist.
  const initial: WindowPlacementRecord = { normalBounds: null, mode: restoration.mode };
  try { initial.normalBounds = win.getNormalBounds(); } catch (error) { onError(error); }
  if (windows) {
    try { initial.windowsNormalBounds = windows.read(); } catch (error) { onError(error); }
  }
  return { initial, windows };
}

// electron-window-state overwrites maximized intent during transient states and
// owns a separate store. Keep matching platform geometry with our ordered store.
export function configureWindowPlacement(
  win: PlacementWindow,
  initial: WindowPlacementRecord,
  persist: (record: WindowPlacementRecord) => Promise<unknown>,
  onError: (error: unknown) => void,
  windows?: WindowsPlacement,
): { start(): void; flush(): Promise<void>; dispose(): void } {
  let normalBounds = initial.normalBounds ? { ...initial.normalBounds } : null;
  let windowsNormalBounds = initial.windowsNormalBounds ? { ...initial.windowsNormalBounds } : initial.windowsNormalBounds;
  let mode = initial.mode;
  let enabled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = (): void => { clearTimeout(timer); timer = undefined; };
  const capture = (): void => {
    if (win.isMinimized() || win.isFullScreen()) return;
    mode = win.isMaximized() ? "maximized" : "normal";
    // Native geometry is authoritative on Windows; logical bounds remain a
    // compatible legacy/non-Windows hint, never a second restoration setter.
    const nativeBounds = windows?.read();
    const logicalBounds = win.getNormalBounds();
    normalBounds = { ...logicalBounds };
    windowsNormalBounds = nativeBounds ? { ...nativeBounds } : undefined;
  };
  const save = async (): Promise<void> => {
    try { await persist({ normalBounds: normalBounds ? { ...normalBounds } : null, mode,
      ...(windows ? { windowsNormalBounds: windowsNormalBounds ? { ...windowsNormalBounds } : null } : {}),
    }); }
    catch (error) { onError(error); }
  };
  const schedule = (): void => {
    if (!enabled || win.isMinimized() || win.isFullScreen()) return;
    try { capture(); } catch (error) { onError(error); }
    cancel();
    timer = setTimeout(() => { timer = undefined; void save(); }, 400);
  };
  const onMaximize = (): void => {
    if (!enabled || win.isMinimized() || win.isFullScreen()) return;
    try { capture(); } catch (error) { onError(error); }
    cancel();
    void save();
  };
  const listeners: Array<[string, () => void]> = [
    ["move", schedule], ["resize", schedule], ["maximize", onMaximize],
    ["unmaximize", schedule], ["restore", schedule], ["leave-full-screen", schedule],
    ["minimize", cancel], ["enter-full-screen", cancel],
  ];
  for (const [event, listener] of listeners) win.on(event, listener);

  return {
    start: () => { enabled = true; },
    flush: async () => {
      cancel();
      if (!enabled) return;
      try { capture(); } catch (error) { onError(error); }
      await save();
    },
    dispose: () => {
      enabled = false;
      cancel();
      for (const [event, listener] of listeners) win.off(event, listener);
    },
  };
}
