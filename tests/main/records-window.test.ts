import { beforeEach, describe, expect, it, vi } from "vitest";

// window-conventions, Background visibility and activation: a window the user
// opens becomes the key window above the one it was opened from. Electron's
// show() activates the app and makes the window key on both platforms;
// showInactive() would leave focus behind it.
const created = vi.hoisted(() => [] as FakeWindow[]);

interface FakeWindow {
  handlers: Map<string, () => void>;
  calls: string[];
  minimized: boolean;
}

vi.mock("electron", () => ({
  BrowserWindow: class {
    handlers = new Map<string, () => void>();
    calls: string[] = [];
    minimized = false;
    webContents = { send: vi.fn() };
    constructor() { created.push(this as unknown as FakeWindow); }
    once(event: string, handler: () => void) { this.handlers.set(event, handler); return this; }
    on() { return this; }
    isDestroyed() { return false; }
    isMinimized() { return this.minimized; }
    restore() { this.calls.push("restore"); }
    show() { this.calls.push("show"); }
    showInactive() { this.calls.push("showInactive"); }
    focus() { this.calls.push("focus"); }
    destroy() {}
  },
  nativeTheme: { shouldUseDarkColors: false },
}));
vi.mock("@main/window", () => ({ loadRendererPage: vi.fn(async () => undefined) }));
vi.mock("@main/window-minimum", () => ({ configureWindowMinimum: vi.fn() }));
vi.mock("@main/window-state-recovery", () => ({
  createWindowWithUsablePersistedBounds: (_name: string, create: () => unknown) => create(),
}));

const runtime = {
  translator: () => ({ t: (key: string) => key }),
  currentLogger: () => ({ warn: vi.fn() }),
} as never;

beforeEach(() => {
  created.length = 0;
  vi.resetModules();
});

describe("the Records window", () => {
  it("opens activated, as the key window, once it is ready", async () => {
    const { openRecordsWindow } = await import("@main/records-window");
    await openRecordsWindow(runtime);
    const [window] = created;
    expect(window!.calls).toEqual([]);

    window!.handlers.get("ready-to-show")!();

    expect(window!.calls).toEqual(["show"]);
  });

  it("brings an open Records window forward and focuses it, restoring it first when minimized", async () => {
    const { openRecordsWindow } = await import("@main/records-window");
    await openRecordsWindow(runtime);
    const [window] = created;
    window!.minimized = true;

    await openRecordsWindow(runtime);

    expect(created).toHaveLength(1);
    expect(window!.calls).toEqual(["restore", "show", "focus"]);
  });
});
