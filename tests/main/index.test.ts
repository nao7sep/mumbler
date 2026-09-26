import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  initializeFailure: null as Error | null,
  windowLoadFailure: null as Error | null,
  dialogChoice: "close" as "restart" | "close",
  dialogFailure: null as Error | null,
  dialogCalls: 0,
  exits: [] as number[],
  relaunches: 0,
  loggerErrors: [] as unknown[][],
}));

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
}));


const runtime = vi.hoisted(() => ({
  currentLogger: () => ({ error: (...args: unknown[]) => { state.loggerErrors.push(args); } }),
  themePreference: () => "system",
  translator: () => ({ t: (key: string) => key, language: "en" }),
  onLanguageChanged: vi.fn(),
}));

vi.mock("@main/core/app-runtime", () => ({
  ApplicationRuntime: {
    initialize: () => state.initializeFailure ? Promise.reject(state.initializeFailure) : Promise.resolve(runtime),
  },
}));
vi.mock("@main/ipc/app-shell", () => ({ registerAppShellIpc: vi.fn() }));
vi.mock("@main/app-menu", () => ({ installApplicationMenu: vi.fn() }));
vi.mock("@main/core/theme", () => ({ applyThemePreference: vi.fn(), followOsThemeChanges: vi.fn() }));
vi.mock("@main/window", () => ({
  createMainWindow: () => state.windowLoadFailure ? Promise.reject(state.windowLoadFailure) : Promise.resolve({}),
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
