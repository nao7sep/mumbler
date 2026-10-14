import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  initializeFailure: null as Error | null,
  windowLoadFailure: null as Error | null,
  dialogChoice: "close" as "restart" | "close",
  dialogFailure: null as Error | null,
  dialogCalls: 0,
  exits: [] as number[],
  relaunches: 0,
  loggerErrors: [] as unknown[][],
  saveForQuit: () => Promise.resolve([]) as Promise<string[]>,
  quitChoice: "cancel" as "retry" | "quit-anyway" | "cancel",
  questions: [] as unknown[],
  dependenciesWatched: false,
  flushSucceeded: true,
  unsavedDrafts: [] as string[],
  draftsChoice: "cancel" as "discard" | "cancel",
  // Set to hold the window's drafts answer until the test chooses to send it.
  holdDraftsReply: false,
  heldDraftsReplies: [] as (() => void)[],
  ipcListeners: new Map<string, (event: { sender: unknown }, request: unknown, reply: unknown) => void>(),
  powerListeners: new Map<string, () => void>(),
}));

// The main window as main sees it: its handlers by event, and the edits request
// it answers the way the preload does.
const mainWindow = vi.hoisted(() => {
  const handlers = new Map<string, (event: { preventDefault: () => void }) => void>();
  const window = {
    handlers,
    flushRequests: 0,
    discards: 0,
    closes: 0,
    on: (event: string, handler: (event: { preventDefault: () => void }) => void) => { handlers.set(event, handler); return window; },
    once: () => window,
    isDestroyed: () => false,
    close: () => { window.closes += 1; },
    webContents: {
      once: vi.fn(),
      removeListener: vi.fn(),
      send: (channel: string, request: unknown) => {
        if (channel.endsWith("query-unsaved-drafts")) {
          const reply = () => state.ipcListeners.get(`${channel}:reply`)?.({ sender: window.webContents }, request, state.unsavedDrafts);
          if (state.holdDraftsReply) state.heldDraftsReplies.push(reply);
          else queueMicrotask(reply);
          return;
        }
        if (channel.endsWith("discard-unsaved-drafts")) {
          window.discards += 1;
          return;
        }
        window.flushRequests += 1;
        queueMicrotask(() => state.ipcListeners.get(`${channel}:reply`)?.({ sender: window.webContents }, request, state.flushSucceeded));
      },
    },
  };
  return window;
});

vi.mock("electron", () => ({
  app: {
    setName: vi.fn(),
    getName: () => "Mumbler",
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    on: vi.fn(),
    exit: (code: number) => state.exits.push(code),
    quit: vi.fn(),
    relaunch: () => { state.relaunches += 1; },
  },
  BrowserWindow: { getAllWindows: () => [] },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  // The window's reply arrives on the reply channel; the test keys it by the
  // request it answers.
  ipcMain: {
    on: (channel: string, listener: (event: { sender: unknown }, request: unknown, reply: unknown) => void) => {
      const asked = channel.replace("pending-edits-flushed", "flush-pending-edits").replace("unsaved-drafts-reported", "query-unsaved-drafts");
      state.ipcListeners.set(`${asked}:reply`, listener);
    },
    removeListener: vi.fn(),
  },
  powerMonitor: { on: (event: string, listener: () => void) => { state.powerListeners.set(event, listener); } },
}));


const runtime = vi.hoisted(() => ({
  currentLogger: () => ({ error: (...args: unknown[]) => { state.loggerErrors.push(args); }, warn: async () => undefined }),
  themePreference: () => "system",
  translator: () => ({ t: (key: string) => key, language: "en" }),
  onLanguageChanged: vi.fn(),
  alignAppKit: vi.fn(),
  onPipelineProgress: vi.fn(),
  onDependenciesChanged: () => { state.dependenciesWatched = true; },
  onRecordsChanged: vi.fn(),
  saveForQuit: vi.fn(() => state.saveForQuit()),
  resumeAfterCancelledQuit: vi.fn(async () => undefined),
  closeForQuit: vi.fn(async () => undefined),
}));

vi.mock("@main/core/app-runtime", () => ({
  ApplicationRuntime: {
    initialize: () => state.initializeFailure ? Promise.reject(state.initializeFailure) : Promise.resolve(runtime),
  },
}));
vi.mock("@main/ipc/app-shell", () => ({ registerAppShellIpc: vi.fn() }));
vi.mock("@main/app-menu", () => ({ installApplicationMenu: vi.fn() }));
const recordsWindow = vi.hoisted(() => ({ openRecordsWindow: vi.fn(), notifyRecordsChanged: vi.fn() }));
vi.mock("@main/records-window", () => recordsWindow);
vi.mock("@main/core/theme", () => ({ applyThemePreference: vi.fn(), followOsThemeChanges: vi.fn() }));
vi.mock("@main/window", () => ({
  createMainWindow: () => state.windowLoadFailure ? Promise.reject(state.windowLoadFailure) : Promise.resolve(mainWindow),
}));
vi.mock("@main/plain-dialog", () => ({
  showPlainDialog: (dialog: { actions: { choice: string }[] }) => {
    state.questions.push(dialog);
    const drafts = dialog.actions.some((action) => action.choice === "discard");
    return { choice: Promise.resolve(drafts ? state.draftsChoice : state.quitChoice), close: vi.fn() };
  },
}));
vi.mock("@main/startup-failure-dialog", () => ({
  showStartupFailureDialog: async () => {
    state.dialogCalls += 1;
    if (state.dialogFailure) throw state.dialogFailure;
    return state.dialogChoice;
  },
}));

beforeEach(() => {
  vi.resetModules();
  state.initializeFailure = null;
  state.windowLoadFailure = null;
  state.dialogChoice = "close";
  state.dialogFailure = null;
  state.dialogCalls = 0;
  state.exits.length = 0;
  state.relaunches = 0;
  state.loggerErrors.length = 0;
  state.saveForQuit = () => Promise.resolve([]);
  state.quitChoice = "cancel";
  state.questions.length = 0;
  state.dependenciesWatched = false;
  state.flushSucceeded = true;
  state.unsavedDrafts = [];
  state.draftsChoice = "cancel";
  state.holdDraftsReply = false;
  state.heldDraftsReplies.length = 0;
  state.ipcListeners.clear();
  state.powerListeners.clear();
  mainWindow.handlers.clear();
  mainWindow.flushRequests = 0;
  mainWindow.discards = 0;
  mainWindow.closes = 0;
  runtime.saveForQuit.mockClear();
  runtime.resumeAfterCancelledQuit.mockClear();
  runtime.closeForQuit.mockClear();
});

describe("main startup recovery", () => {
  it("shows the authored terminal surface when runtime bootstrap rejects", async () => {
    state.initializeFailure = new Error("EACCES /private/tmp/mumbler-state.json");
    await import("@main/index");
    await vi.waitFor(() => expect(state.dialogCalls).toBe(1));
    expect(state.exits).toEqual([1]);
    expect(state.relaunches).toBe(0);
  });

  it("preserves renderer-load diagnostics and can restart from the terminal surface", async () => {
    const hostile = new Error("EACCES /private/tmp/mumbler-renderer.html");
    state.windowLoadFailure = hostile;
    state.dialogChoice = "restart";
    await import("@main/index");
    await vi.waitFor(() => expect(state.dialogCalls).toBe(1));
    expect(state.loggerErrors[0]?.[2]).toBe(hostile);
    expect(state.relaunches).toBe(1);
    expect(state.exits).toEqual([1]);
  });

  it("still exits when the terminal recovery surface itself cannot be created", async () => {
    state.initializeFailure = new Error("startup failed");
    state.dialogFailure = new Error("dialog construction failed");
    await import("@main/index");
    await vi.waitFor(() => expect(state.exits).toEqual([1]));
    expect(state.relaunches).toBe(0);
  });
});

describe("quit", () => {
  type Handler = (event: { preventDefault: () => void }) => void;

  /** Boots main and returns its before-quit handler. */
  async function boot(): Promise<Handler> {
    vi.spyOn(process, "on").mockImplementation(() => process);
    await import("@main/index");
    await vi.waitFor(() => expect(state.dependenciesWatched).toBe(true));
    const { app } = await import("electron");
    const calls = vi.mocked(app.on).mock.calls as unknown as [string, Handler][];
    return calls.filter(([event]) => event === "before-quit").at(-1)![1];
  }

  function onPlatform(platform: NodeJS.Platform): void {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the window's edits, saves, closes and exits on the menu's or the Dock's Quit", async () => {
    const beforeQuit = await boot();
    const event = { preventDefault: vi.fn() };

    beforeQuit(event);
    await vi.waitFor(() => expect(state.exits).toEqual([0]));

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(mainWindow.flushRequests).toBe(1);
    expect(runtime.saveForQuit).toHaveBeenCalledOnce();
    expect(runtime.closeForQuit).toHaveBeenCalledOnce();
    expect(state.questions).toEqual([]);
  });

  it("holds a second quit during the save and exits once, after it finishes", async () => {
    let finishSave!: (failures: string[]) => void;
    state.saveForQuit = () => new Promise((resolve) => { finishSave = resolve; });
    const beforeQuit = await boot();

    const first = { preventDefault: vi.fn() };
    beforeQuit(first);
    const second = { preventDefault: vi.fn() };
    beforeQuit(second);
    await vi.waitFor(() => expect(runtime.saveForQuit).toHaveBeenCalledOnce());

    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(state.exits).toEqual([]);
    finishSave([]);
    await vi.waitFor(() => expect(state.exits).toEqual([0]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.exits).toEqual([0]);
  });

  it("asks when the save fails, and keeps running on Cancel", async () => {
    state.saveForQuit = () => Promise.resolve(["queue"]);
    const beforeQuit = await boot();

    beforeQuit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(runtime.resumeAfterCancelledQuit).toHaveBeenCalledOnce());

    expect(state.questions).toHaveLength(1);
    expect(state.exits).toEqual([]);
  });

  it("asks before discarding unsaved Settings changes, and keeps running with nothing saved on Cancel", async () => {
    state.unsavedDrafts = ["settings"];
    const beforeQuit = await boot();
    beforeQuit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(state.questions).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mainWindow.flushRequests).toBe(0);
    expect(runtime.saveForQuit).not.toHaveBeenCalled();
    expect(mainWindow.discards).toBe(0);
    expect(state.exits).toEqual([]);
  });

  it("discards unsaved Settings changes on Discard and quits through the ordinary save", async () => {
    state.unsavedDrafts = ["settings"];
    state.draftsChoice = "discard";
    const beforeQuit = await boot();
    beforeQuit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(state.exits).toEqual([0]));
    expect(mainWindow.discards).toBe(1);
    expect(runtime.saveForQuit).toHaveBeenCalledOnce();
  });

  it("keeps the Mac window open when the user keeps unsaved Settings changes", async () => {
    onPlatform("darwin");
    state.unsavedDrafts = ["settings"];
    await boot();
    mainWindow.handlers.get("close")!({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(state.questions).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mainWindow.closes).toBe(0);
    expect(mainWindow.flushRequests).toBe(0);
  });

  it("takes a macOS logout as a session end: saves, never asks, and exits", async () => {
    state.saveForQuit = () => Promise.resolve(["queue"]);
    const beforeQuit = await boot();

    state.powerListeners.get("shutdown")!();
    beforeQuit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(state.exits).toEqual([0]));

    expect(runtime.saveForQuit).toHaveBeenCalledOnce();
    expect(state.questions).toEqual([]);
  });

  it("starts the session-end quit on the macOS shutdown signal itself, before any quit arrives", async () => {
    state.saveForQuit = () => Promise.resolve(["queue"]);
    await boot();

    state.powerListeners.get("shutdown")!();
    await vi.waitFor(() => expect(state.exits).toEqual([0]));

    expect(state.questions).toEqual([]);
  });

  it("opens no unsaved-changes question when a session end arrives while the window is still being asked", async () => {
    state.unsavedDrafts = ["settings"];
    state.holdDraftsReply = true;
    const beforeQuit = await boot();

    beforeQuit({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(state.heldDraftsReplies).toHaveLength(1));
    state.powerListeners.get("shutdown")!();
    await vi.waitFor(() => expect(state.exits).toEqual([0]));
    // The window's late answer changes nothing.
    state.heldDraftsReplies[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.questions).toEqual([]);
    expect(mainWindow.discards).toBe(0);
    expect(runtime.saveForQuit).toHaveBeenCalledOnce();
    expect(state.exits).toEqual([0]);
  });

  it("opens no question for a Mac window close that a session end overtakes", async () => {
    onPlatform("darwin");
    state.unsavedDrafts = ["settings"];
    state.holdDraftsReply = true;
    await boot();

    mainWindow.handlers.get("close")!({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(state.heldDraftsReplies).toHaveLength(1));
    state.powerListeners.get("shutdown")!();
    await vi.waitFor(() => expect(state.exits).toEqual([0]));
    state.heldDraftsReplies[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.questions).toEqual([]);
    expect(mainWindow.closes).toBe(0);
    expect(runtime.saveForQuit).toHaveBeenCalledOnce();
  });

  it("lets Windows logout proceed and saves once without asking across both session-end events", async () => {
    onPlatform("win32");
    state.saveForQuit = () => Promise.resolve(["settings"]);
    state.unsavedDrafts = ["settings"];
    await boot();
    const query = { preventDefault: vi.fn() };

    mainWindow.handlers.get("query-session-end")!(query);
    mainWindow.handlers.get("session-end")!({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(state.exits).toEqual([0]));

    expect(query.preventDefault, "saving never vetoes Windows logout").not.toHaveBeenCalled();
    expect(mainWindow.flushRequests).toBe(1);
    expect(runtime.saveForQuit).toHaveBeenCalledOnce();
    expect(state.questions).toEqual([]);
  });

  it("starts the same save when Windows ends the session without asking first", async () => {
    onPlatform("win32");
    await boot();

    mainWindow.handlers.get("session-end")!({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(state.exits).toEqual([0]));

    expect(runtime.saveForQuit).toHaveBeenCalledOnce();
  });

  it("quits through the save when the main window is closed on Windows", async () => {
    onPlatform("win32");
    await boot();
    const close = { preventDefault: vi.fn() };

    mainWindow.handlers.get("close")!(close);
    await vi.waitFor(() => expect(state.exits).toEqual([0]));

    expect(close.preventDefault).toHaveBeenCalledOnce();
    expect(runtime.saveForQuit).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "discard"] as const)("handles %s for unsaved Settings on Windows window close", async (choice) => {
    onPlatform("win32");
    state.unsavedDrafts = ["settings"];
    state.draftsChoice = choice;
    await boot();
    const close = { preventDefault: vi.fn() };

    mainWindow.handlers.get("close")!(close);
    await vi.waitFor(() => expect(state.questions).toHaveLength(1));
    if (choice === "discard") {
      await vi.waitFor(() => expect(state.exits).toEqual([0]));
      expect(mainWindow.discards).toBe(1);
      expect(runtime.saveForQuit).toHaveBeenCalledOnce();
    } else {
      expect(state.exits).toEqual([]);
      expect(mainWindow.discards).toBe(0);
      expect(runtime.saveForQuit).not.toHaveBeenCalled();
    }
    expect(close.preventDefault).toHaveBeenCalledOnce();
    expect(mainWindow.closes).toBe(0);
  });

  it.each(["cancel", "retry", "quit-anyway"] as const)("honors %s after a failed save on Windows window close", async (choice) => {
    onPlatform("win32");
    let saves = 0;
    state.saveForQuit = async () => ++saves === 1 ? ["queue"] : [];
    state.quitChoice = choice;
    await boot();

    mainWindow.handlers.get("close")!({ preventDefault: vi.fn() });
    if (choice === "cancel") {
      await vi.waitFor(() => expect(runtime.resumeAfterCancelledQuit).toHaveBeenCalledOnce());
      expect(state.exits).toEqual([]);
      expect(runtime.closeForQuit).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(state.exits).toEqual([0]));
      expect(runtime.closeForQuit).toHaveBeenCalledOnce();
      expect(runtime.resumeAfterCancelledQuit).not.toHaveBeenCalled();
    }
    expect(state.questions).toHaveLength(1);
    expect(saves).toBe(choice === "retry" ? 2 : 1);
  });

  it("retains the Mac window when its edit save fails", async () => {
    onPlatform("darwin");
    state.flushSucceeded = false;
    await boot();
    mainWindow.handlers.get("close")!({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(state.questions).toHaveLength(1));
    expect(mainWindow.closes).toBe(0);
    expect(state.exits).toEqual([]);
    expect(runtime.saveForQuit).not.toHaveBeenCalled();
  });

  it("only closes the main window on macOS, after it sends its unsent edits", async () => {
    onPlatform("darwin");
    await boot();
    const close = { preventDefault: vi.fn() };

    mainWindow.handlers.get("close")!(close);
    await vi.waitFor(() => expect(mainWindow.closes).toBe(1));
    mainWindow.handlers.get("close")!({ preventDefault: close.preventDefault });

    expect(mainWindow.flushRequests).toBe(1);
    expect(close.preventDefault, "the second close goes through").toHaveBeenCalledOnce();
    expect(runtime.saveForQuit).not.toHaveBeenCalled();
    expect(state.exits).toEqual([]);
  });
});

describe("records", () => {
  it("passes each record the runtime stores on to the records window", async () => {
    vi.spyOn(process, "on").mockImplementation(() => process);
    runtime.onRecordsChanged.mockClear();
    try {
      await import("@main/index");
      await vi.waitFor(() =>
        expect(runtime.onRecordsChanged).toHaveBeenCalledExactlyOnceWith(recordsWindow.notifyRecordsChanged),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});
