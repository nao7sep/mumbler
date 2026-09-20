import { beforeEach, describe, expect, it, vi } from "vitest";

import { APP_SHELL_CHANNELS, type PendingImportReviewItem } from "@shared/app-shell";

// The boundary the window calls: every channel reaches its runtime method with
// the arguments it was given, a malformed argument is refused before the runtime
// sees it, and a failure is logged once in main and still reaches the renderer.
// Electron is the only substitution — the external-URL boundary is the real one,
// with the OS handler stubbed.
const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  window: null as unknown,
  openExternal: vi.fn(async () => {}),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
      electron.handlers.set(channel, fn);
    },
  },
  BrowserWindow: { fromWebContents: () => electron.window },
  shell: { openExternal: electron.openExternal },
}));

const { registerAppShellIpc } = await import("@main/ipc/app-shell");
const { OperationError } = await import("@main/core/operation-error");

const RUNTIME_METHODS = [
  "getSnapshot", "getSettingsDraft", "getDefaultPrompts", "getDefaultModels",
  "openImportDialog", "importDroppedPaths", "updatePendingImportDrafts", "confirmPendingImports",
  "selectCard", "duplicateCard", "updateCardTrim", "getCardMediaSource", "generateCardStep",
  "cancelCardProcessing", "pickOutputDirectory", "openOutputDirectory", "saveSettingsDraft",
  "setGeminiApiKey", "clearGeminiApiKey", "chooseOutputDirectory", "saveCard", "removeCard",
  "reportRendererError", "reportRendererDiagnostic", "dismissAppWideError", "resetState",
  "cancelPendingImports", "provisionTool", "cancelToolProvision", "checkTools", "cancelToolCheck",
  "saveToolSettings", "saveLayout",
] as const;

const logger = { debug: vi.fn(async () => {}), error: vi.fn(async () => {}) };
let runtime: Record<string, ReturnType<typeof vi.fn>>;

/** A draft as the review pane sends it back, with the fields main reads. */
function draft(overrides: Record<string, unknown> = {}): PendingImportReviewItem {
  return {
    id: "pending-1",
    localTimestampText: "2026-01-01 09:00:00",
    timezone: "UTC",
    utcTimestampText: "2026-01-01T00:00:00Z",
    deleteOriginalOnConfirm: false,
    copyToBackupOnConfirm: true,
    ...overrides,
  } as PendingImportReviewItem;
}

/** Invokes a channel the way the renderer does, through the registered handler. */
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = electron.handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler({ sender: {} }, ...args);
}

beforeEach(() => {
  electron.handlers.clear();
  electron.window = null;
  electron.openExternal.mockClear();
  logger.debug.mockClear();
  logger.error.mockClear();
  runtime = Object.fromEntries(RUNTIME_METHODS.map((name) => [name, vi.fn(async () => `${name} result`)]));
  runtime.currentLogger = vi.fn(() => logger);
  registerAppShellIpc(runtime as never);
});

describe("the app-shell IPC boundary", () => {
  it("registers exactly the channels the renderer knows", () => {
    expect([...electron.handlers.keys()].sort()).toEqual(Object.values(APP_SHELL_CHANNELS).sort());
  });

  // Each row: the channel, the runtime method it must reach, and the arguments
  // the renderer sends, which must arrive unchanged.
  it.each([
    ["getSnapshot", "getSnapshot", []],
    ["getSettingsDraft", "getSettingsDraft", []],
    ["getDefaultPrompts", "getDefaultPrompts", []],
    ["getDefaultModels", "getDefaultModels", []],
    ["importDroppedPaths", "importDroppedPaths", [["/tmp/a.flac", "/tmp/b.m4a"]]],
    ["updatePendingImportDrafts", "updatePendingImportDrafts", [[draft()]]],
    ["confirmPendingImports", "confirmPendingImports", [[draft({ deleteOriginalOnConfirm: true })]]],
    ["selectCard", "selectCard", ["card-1"]],
    ["selectCard", "selectCard", [null]],
    ["duplicateCard", "duplicateCard", ["card-1"]],
    ["updateCardTrim", "updateCardTrim", ["card-1", { frontMarkerSec: 1.5, backMarkerSec: null }]],
    ["getCardMediaSource", "getCardMediaSource", ["card-1"]],
    ["generateCardStep", "generateCardStep", ["card-1", "slug"]],
    ["cancelCardProcessing", "cancelCardProcessing", ["card-1"]],
    ["openOutputDirectory", "openOutputDirectory", []],
    ["saveSettingsDraft", "saveSettingsDraft", [{ model: "gemini-3.7-flash" }]],
    ["setGeminiApiKey", "setGeminiApiKey", ["a-key"]],
    ["clearGeminiApiKey", "clearGeminiApiKey", []],
    ["saveCard", "saveCard", ["card-1", undefined]],
    ["saveCard", "saveCard", ["card-1", "overwrite"]],
    ["removeCard", "removeCard", ["card-1"]],
    ["reportRendererError", "reportRendererError", [{ message: "boom" }]],
    ["reportRendererDiagnostic", "reportRendererDiagnostic", [{ message: "note" }]],
    ["dismissAppWideError", "dismissAppWideError", []],
    ["resetState", "resetState", []],
    ["cancelPendingImports", "cancelPendingImports", []],
    ["provisionTool", "provisionTool", ["ffmpeg"]],
    ["cancelToolProvision", "cancelToolProvision", ["ffprobe"]],
    ["checkTools", "checkTools", []],
    ["cancelToolCheck", "cancelToolCheck", []],
    ["saveToolSettings", "saveToolSettings", [true]],
    ["saveLayout", "saveLayout", [320]],
  ] as const)("carries %s to the runtime and answers with its result", async (channel, method, args) => {
    const result = await invoke(APP_SHELL_CHANNELS[channel], ...args);
    expect(runtime[method]).toHaveBeenCalledExactlyOnceWith(...args);
    expect(result).toBe(`${method} result`);
  });

  it.each(["openImportDialog", "pickOutputDirectory", "chooseOutputDirectory"] as const)(
    "gives %s the window that asked, and refuses when the sender has none",
    async (channel) => {
      const window = { id: 1 };
      electron.window = window;
      await invoke(APP_SHELL_CHANNELS[channel]);
      expect(runtime[channel]).toHaveBeenCalledExactlyOnceWith(window);

      electron.window = null;
      await expect(invoke(APP_SHELL_CHANNELS[channel])).rejects.toThrow(/requires an active window/);
      expect(runtime[channel]).toHaveBeenCalledOnce();
    },
  );

  it("opens an allowed external URL through the OS and refuses a local one", async () => {
    await invoke(APP_SHELL_CHANNELS.openExternal, "https://example.com");
    expect(electron.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com");
    await expect(invoke(APP_SHELL_CHANNELS.openExternal, "file:///etc/passwd")).rejects.toThrow();
    await expect(invoke(APP_SHELL_CHANNELS.openExternal, 7)).rejects.toThrow(/url must be a string/);
    expect(electron.openExternal).toHaveBeenCalledOnce();
  });

  // Each row: the channel, the arguments a wrong renderer could send, and the
  // parameter the refusal must name. The runtime never sees any of them.
  it.each([
    ["importDroppedPaths", ["/tmp/a.flac", 2], /paths must be a string array/],
    ["importDroppedPaths", ["not-an-array"], /paths must be a string array/],
    ["updatePendingImportDrafts", ["not-an-array"], /import drafts must be an array/],
    ["updatePendingImportDrafts", [[null]], /each import draft must be an object/],
    ["confirmPendingImports", [[draft({ id: 7 })]], /import draft id must be a string/],
    ["confirmPendingImports", [[draft({ localTimestampText: 1 })]], /localTimestampText must be a string/],
    ["confirmPendingImports", [[draft({ timezone: null })]], /timezone must be a string/],
    ["confirmPendingImports", [[draft({ utcTimestampText: false })]], /utcTimestampText must be a string/],
    ["confirmPendingImports", [[draft({ deleteOriginalOnConfirm: "yes" })]], /deleteOriginalOnConfirm must be a boolean/],
    ["confirmPendingImports", [[draft({ copyToBackupOnConfirm: 1 })]], /copyToBackupOnConfirm must be a boolean/],
    ["selectCard", [7], /cardId must be a string/],
    ["duplicateCard", [7], /cardId must be a string/],
    ["updateCardTrim", ["card-1", null], /trim must be an object/],
    ["updateCardTrim", ["card-1", { frontMarkerSec: "1", backMarkerSec: null }], /frontMarkerSec must be number or null/],
    ["updateCardTrim", ["card-1", { frontMarkerSec: null, backMarkerSec: "2" }], /backMarkerSec must be number or null/],
    ["getCardMediaSource", [7], /cardId must be a string/],
    ["generateCardStep", ["card-1", "everything"], /target must be a card processing step/],
    ["cancelCardProcessing", [7], /cardId must be a string/],
    ["setGeminiApiKey", [7], /apiKey must be a string/],
    ["saveCard", [7], /cardId must be a string/],
    ["removeCard", [7], /cardId must be a string/],
    ["provisionTool", ["sox"], /tool must be ffmpeg or ffprobe/],
    ["cancelToolProvision", ["sox"], /tool must be ffmpeg or ffprobe/],
    ["saveToolSettings", ["yes"], /checkUpdatesAtLaunch must be a boolean/],
    ["saveLayout", ["320"], /queueWidth must be a finite number/],
    ["saveLayout", [Number.NaN], /queueWidth must be a finite number/],
  ] as const)("refuses %s with a malformed argument, before the runtime", async (channel, args, message) => {
    await expect(invoke(APP_SHELL_CHANNELS[channel], ...args)).rejects.toThrow(message);
    expect(runtime[channel]).not.toHaveBeenCalled();
  });

  it("traces a rejection the user is meant to see, and still rejects", async () => {
    runtime.saveCard.mockRejectedValueOnce(new OperationError("That file already exists."));
    await expect(invoke(APP_SHELL_CHANNELS.saveCard, "card-1")).rejects.toThrow("That file already exists.");
    expect(logger.debug).toHaveBeenCalledExactlyOnceWith("ipc.rejected", "IPC operation rejected.", {
      channel: APP_SHELL_CHANNELS.saveCard,
      reason: "That file already exists.",
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs an unexpected failure with the error, and still rejects", async () => {
    const failure = new Error("disk gone");
    runtime.resetState.mockRejectedValueOnce(failure);
    await expect(invoke(APP_SHELL_CHANNELS.resetState)).rejects.toBe(failure);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith("ipc.failed", "Unhandled failure in IPC handler.", failure, {
      channel: APP_SHELL_CHANNELS.resetState,
    });
    expect(logger.debug).not.toHaveBeenCalled();
  });
});
