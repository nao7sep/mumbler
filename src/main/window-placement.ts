import type { WindowBounds, WindowPlacementMode, WindowPlacementRecord } from "@shared/app-shell";

const CAPTURE_DEBOUNCE_MS = 400;

type PlacementWindow = {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  getBounds(): WindowBounds;
  setBounds(bounds: WindowBounds): void;
  isMaximized(): boolean;
  isMinimized(): boolean;
  isFullScreen(): boolean;
};

export function resolveWindowRestoration(
  saved: WindowPlacementRecord | null,
  minimum: { width: number; height: number },
  workAreas: readonly WindowBounds[],
): { normalBounds: WindowBounds | null; mode: WindowPlacementMode } {
  return {
    normalBounds:
      saved?.normalBounds && usableWindowBounds(saved.normalBounds, minimum, workAreas)
        ? { ...saved.normalBounds }
        : null,
    mode: saved?.mode === "normal" || saved?.mode === "maximized" ? saved.mode : "maximized",
  };
}

export function usableWindowBounds(
  bounds: WindowBounds,
  minimum: { width: number; height: number },
  workAreas: readonly WindowBounds[],
): boolean {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height];
  if (!values.every(Number.isFinite) || !values.every(Number.isInteger)) return false;
  if (bounds.width < minimum.width || bounds.height < minimum.height) return false;
  return workAreas.some((area) =>
    bounds.x >= area.x && bounds.y >= area.y &&
    bounds.x + bounds.width <= area.x + area.width &&
    bounds.y + bounds.height <= area.y + area.height
  );
}

export function applyRestoredBounds(
  win: Pick<PlacementWindow, "getBounds" | "setBounds">,
  bounds: WindowBounds,
  onError: (error: unknown) => void,
): boolean {
  const fallback = { ...win.getBounds() };
  try {
    win.setBounds(bounds);
    if (sameBounds(win.getBounds(), bounds)) return true;
    throw new Error("Electron adjusted the restored window bounds");
  } catch (error) {
    onError(error);
    try { win.setBounds(fallback); } catch (fallbackError) { onError(fallbackError); }
    return false;
  }
}

export function configureWindowPlacement(
  win: PlacementWindow,
  initial: { normalBounds: WindowBounds; mode: WindowPlacementMode },
  persist: (record: WindowPlacementRecord) => Promise<unknown>,
  onError: (error: unknown) => void,
): { start(): void; setInitialMode(mode: WindowPlacementMode): void; flush(): Promise<void>; dispose(): void } {
  let normalBounds = { ...initial.normalBounds };
  let mode = initial.mode;
  let enabled = false;
  let transient = false;
  let manualMove = false;
  let manualResize = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    manualMove = false;
    manualResize = false;
  };
  const ordinary = (): boolean =>
    !transient && !win.isMinimized() && !win.isFullScreen() && !win.isMaximized();
  const save = (): Promise<unknown> => persist({ normalBounds: { ...normalBounds }, mode });
  const saveBackground = (): void => { void save().catch(onError); };
  const capture = (): void => {
    if (!enabled || !ordinary()) return;
    normalBounds = { ...win.getBounds() };
    mode = "normal";
  };
  const schedule = (): void => {
    if (!enabled || !ordinary()) return;
    capture();
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      manualMove = false;
      manualResize = false;
      saveBackground();
    }, CAPTURE_DEBOUNCE_MS);
  };
  const enterTransient = (): void => { transient = true; cancel(); };
  const settle = (): void => {
    transient = true;
    cancel();
    timer = setTimeout(() => {
      timer = undefined;
      transient = false;
      if (!ordinary()) return;
      capture();
      saveBackground();
    }, CAPTURE_DEBOUNCE_MS);
  };
  const listeners: Array<[string, () => void]> = [
    ["will-move", () => { if (enabled && ordinary()) manualMove = true; }],
    ["move", () => { if (manualMove) schedule(); }],
    ["will-resize", () => { if (enabled && ordinary()) manualResize = true; }],
    ["resize", () => { if (manualResize) schedule(); }],
    ["maximize", () => {
      if (!enabled || transient || win.isMinimized() || win.isFullScreen()) return;
      cancel();
      mode = "maximized";
      saveBackground();
    }],
    ["unmaximize", settle],
    ["minimize", enterTransient],
    ["restore", settle],
    ["enter-full-screen", enterTransient],
    ["leave-full-screen", settle],
  ];
  for (const [event, listener] of listeners) win.on(event, listener);

  return {
    start: () => { enabled = true; transient = win.isMinimized() || win.isFullScreen(); },
    setInitialMode: (next) => { mode = next; },
    flush: async () => {
      try {
        cancel();
        if (!enabled) return;
        if (win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) mode = "maximized";
        await save();
      } catch (error) { onError(error); }
    },
    dispose: () => {
      enabled = false;
      cancel();
      for (const [event, listener] of listeners) win.off(event, listener);
    },
  };
}

function sameBounds(a: WindowBounds, b: WindowBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
