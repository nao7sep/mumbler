import { CardProjection } from "@shared/card-projection";
import type { AppSnapshot, MumblerCard } from "@shared/app-shell";
import { IPC_FAILURE } from "@shared/ipc-result";
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
  "getCardBody", "getSnapshot", "dismissFirstRunSetup", "getSettingsDraft", "getDefaultPrompts",
  "openImportDialog", "importDroppedPaths", "updatePendingImportDrafts", "confirmPendingImports",
  "selectCard", "duplicateCard", "updateCardTrim", "getCardMediaSource", "generateCardStep",
  "cancelCardProcessing", "pickOutputDirectory", "pickBackupDirectory", "openOutputDirectory", "saveSettingsDraft",
  "setGeminiApiKey", "clearGeminiApiKey", "chooseOutputDirectory", "saveCard", "removeCard",
  "reportRendererError", "reportRendererDiagnostic", "dismissAppWideError", "resetState",
  "cancelPendingImports", "provisionTool", "cancelToolProvision", "checkTools", "cancelToolCheck",
  "saveToolSettings", "saveLayout", "readRecordsPage", "readRecordDetail", "readRecordSources",
  "recordsListWidth", "saveRecordsListWidth",
] as const;

const logger = { debug: vi.fn(async () => {}), error: vi.fn(async () => {}) };
const windows = { openRecords: vi.fn(async () => {}) };
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

/** A records query as the records window sends it, with every filter off. */
function recordsQuery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { session: null, kind: null, level: null, cardId: null, search: "", after: null, ...overrides };
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
  runtime = Object.fromEntries(RUNTIME_METHODS.map((name) => [name, vi.fn(async () => ({ result: name, snapshot: { result: name } }))]));
  runtime.projectSnapshot = vi.fn((value) => value);
  runtime.currentLogger = vi.fn(() => logger);
  registerAppShellIpc(runtime as never, windows);
});

describe("the app-shell IPC boundary", () => {
  it("registers exactly the channels the renderer knows", () => {
    expect([...electron.handlers.keys()].sort()).toEqual(Object.values(APP_SHELL_CHANNELS).sort());
  });

  // Each row: the channel, the runtime method it must reach, and the arguments
  // the renderer sends, which must arrive unchanged.
  it.each([
    ["getCardBody", "getCardBody", ["card-1"]],
    ["getSnapshot", "getSnapshot", []],
    ["dismissFirstRunSetup", "dismissFirstRunSetup", []],
    ["getSettingsDraft", "getSettingsDraft", []],
    ["getDefaultPrompts", "getDefaultPrompts", []],
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
    ["saveCard", "saveCard", ["card-1", undefined, { removeAfterSave: true }]],
    ["saveCard", "saveCard", ["card-1", "overwrite", { removeAfterSave: false }]],
    ["removeCard", "removeCard", ["card-1"]],
    ["reportRendererError", "reportRendererError", [{ message: "boom" }]],
    ["reportRendererDiagnostic", "reportRendererDiagnostic", [{ message: "note" }]],
    ["dismissAppWideError", "dismissAppWideError", []],
    ["resetState", "resetState", []],
    ["cancelPendingImports", "cancelPendingImports", [["pending-1"]]],
    ["provisionTool", "provisionTool", ["ffmpeg"]],
    ["cancelToolProvision", "cancelToolProvision", ["ffprobe"]],
    ["checkTools", "checkTools", []],
    ["cancelToolCheck", "cancelToolCheck", []],
    ["saveToolSettings", "saveToolSettings", [true]],
    ["saveLayout", "saveLayout", [320]],
    ["readRecordsPage", "readRecordsPage", [recordsQuery()]],
    ["readRecordsPage", "readRecordsPage", [recordsQuery({ level: "attention" })]],
    ["readRecordsPage", "readRecordsPage", [recordsQuery({
      session: "2026-10-02T00:00:00.000Z", kind: "log", level: "warn", cardId: "card-1", search: "quota",
      after: { time: "2026-10-02T00:00:01.000Z", kind: "provider-call", id: 7 },
    })]],
    ["readRecordDetail", "readRecordDetail", ["provider-call", 7]],
    ["readRecordSources", "readRecordSources", []],
    ["getRecordsListWidth", "recordsListWidth", []],
    ["saveRecordsListWidth", "saveRecordsListWidth", [420]],
  ] as const)("carries %s to the runtime and answers with its result", async (channel, method, args) => {
    const result = await invoke(APP_SHELL_CHANNELS[channel], ...args);
    expect(runtime[method]).toHaveBeenCalledExactlyOnceWith(...args);
    expect(result).toEqual({ result: method, snapshot: { result: method } });
  });

  it.each([[undefined], [null], ["keep"], [{}], [{ removeAfterSave: "no" }]])(
    "removes a saved recording unless the renderer asks plainly to keep it (%j)",
    async (options) => {
      await invoke(APP_SHELL_CHANNELS.saveCard, "card-1", undefined, options);
      expect(runtime.saveCard).toHaveBeenCalledExactlyOnceWith("card-1", undefined, { removeAfterSave: true });
    },
  );

  it.each(["openImportDialog", "pickOutputDirectory", "pickBackupDirectory", "chooseOutputDirectory"] as const)(
    "gives %s the window that asked, and refuses when the sender has none",
    async (channel) => {
      const window = { id: 1 };
      electron.window = window;
      await invoke(APP_SHELL_CHANNELS[channel]);
      expect(runtime[channel]).toHaveBeenCalledExactlyOnceWith(
        ...(["pickOutputDirectory", "pickBackupDirectory"].includes(channel) ? [window, undefined, undefined] : [window]),
      );

      electron.window = null;
      await expect(invoke(APP_SHELL_CHANNELS[channel])).resolves.toEqual(IPC_FAILURE);
      expect(runtime[channel]).toHaveBeenCalledOnce();
    },
  );

  it.each(["pickOutputDirectory", "pickBackupDirectory"] as const)("carries and validates %s draft hints", async (channel) => {
    const window = { id: 1 };
    electron.window = window;
    await invoke(APP_SHELL_CHANNELS[channel], "~/draft", "/previous/$LITERAL");
    expect(runtime[channel]).toHaveBeenCalledExactlyOnceWith(window, "~/draft", "/previous/$LITERAL");
    await expect(invoke(APP_SHELL_CHANNELS[channel], 1)).resolves.toEqual(IPC_FAILURE);
    await expect(invoke(APP_SHELL_CHANNELS[channel], "draft", {})).resolves.toEqual(IPC_FAILURE);
    expect(runtime[channel]).toHaveBeenCalledOnce();
  });

  it("opens the records window through main's window owner", async () => {
    windows.openRecords.mockClear();
    await invoke(APP_SHELL_CHANNELS.openRecordsWindow);
    expect(windows.openRecords).toHaveBeenCalledOnce();
  });

  it("opens an allowed external URL through the OS and refuses a local one", async () => {
    await invoke(APP_SHELL_CHANNELS.openExternal, "https://example.com");
    expect(electron.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com");
    await expect(invoke(APP_SHELL_CHANNELS.openExternal, "file:///etc/passwd")).resolves.toEqual(IPC_FAILURE);
    await expect(invoke(APP_SHELL_CHANNELS.openExternal, 7)).resolves.toEqual(IPC_FAILURE);
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
    ["confirmPendingImports", [[draft({ timestampBasis: "unknown" })]], /timestampBasis must be local or utc/],
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
    ["readRecordsPage", [null], /query must be an object/],
    ["readRecordsPage", [recordsQuery({ session: 7 })], /query.session must be a string or null/],
    ["readRecordsPage", [recordsQuery({ kind: "notice" })], /kind must be a record kind/],
    ["readRecordsPage", [recordsQuery({ level: "fatal" })], /query.level must be a record level filter or null/],
    ["readRecordsPage", [recordsQuery({ search: null })], /query.search must be a string/],
    ["readRecordsPage", [recordsQuery({ after: { time: "t", kind: "log", id: 1.5 } })], /query.after must be a record cursor/],
    ["readRecordDetail", ["notice", 7], /kind must be a record kind/],
    ["readRecordDetail", ["log", "7"], /id must be an integer/],
    ["saveRecordsListWidth", ["420"], /width must be a finite number/],
  ] as const)("refuses %s with a malformed argument, before the runtime", async (channel, args, expectedMessage) => {
    await expect(invoke(APP_SHELL_CHANNELS[channel], ...args)).resolves.toEqual(IPC_FAILURE);
    expect(logger.error).toHaveBeenLastCalledWith("ipc.failed", expect.any(String), expect.objectContaining({ message: expect.stringMatching(expectedMessage) }), { channel: APP_SHELL_CHANNELS[channel] });
    expect(runtime[channel]).not.toHaveBeenCalled();
  });

  it("traces a rejection the user is meant to see, and returns a plain handled failure", async () => {
    runtime.saveCard.mockRejectedValueOnce(new OperationError("That file already exists."));
    await expect(invoke(APP_SHELL_CHANNELS.saveCard, "card-1")).resolves.toEqual(IPC_FAILURE);
    expect(logger.debug).toHaveBeenCalledExactlyOnceWith("ipc.rejected", "IPC operation rejected.", {
      channel: APP_SHELL_CHANNELS.saveCard,
      reason: "That file already exists.",
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs an unexpected failure with the error, and returns a plain handled failure", async () => {
    const failure = new Error("disk gone");
    runtime.resetState.mockRejectedValueOnce(failure);
    await expect(invoke(APP_SHELL_CHANNELS.resetState)).resolves.toEqual(IPC_FAILURE);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith("ipc.failed", "Unhandled failure in IPC handler.", failure, {
      channel: APP_SHELL_CHANNELS.resetState,
    });
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("keeps raw failure details out of the serialized reply", async () => {
    runtime.resetState.mockRejectedValueOnce(new Error("PRIVATE_PATH_AND_API_KEY_SENTINEL"));
    const reply = JSON.stringify(await invoke(APP_SHELL_CHANNELS.resetState));
    expect(reply).toBe(JSON.stringify(IPC_FAILURE));
    expect(reply).not.toContain("SENTINEL");
    expect(logger.error).toHaveBeenCalledOnce();
  });
});


it.each([
  ["getSnapshot", [], false], ["selectCard", ["selected"], false],
  ["updateCardTrim", ["selected", { frontMarkerSec: 1, backMarkerSec: null }], false],
  ["generateCardStep", ["selected", "title"], false], ["checkTools", [], false],
  ["importDroppedPaths", [["/recording.wav"]], true], ["saveCard", ["selected"], true],
] as const)("keeps all text bodies out of the actual %s bridge result", async (method, args, nested) => {
  const projection = new CardProjection();
  const cards = ["selected", "unselected"].map((id) => ({ id,
    transcription: { text: `${id} transcript`.repeat(100_000) },
    metadata: { structured: `${id} outline`.repeat(100_000), title: id, slug: id },
  } as MumblerCard));
  const snapshot = { state: { cards, pendingImports: [] }, queueSummary: { selectedCardId: "selected" } } as unknown as AppSnapshot;
  runtime[method].mockResolvedValue(nested ? { snapshot, kind: "saved" } : snapshot);
  runtime.projectSnapshot.mockImplementation((value: AppSnapshot) => projection.snapshot(value));
  runtime.getCardBody.mockImplementation((id: string) => projection.body(cards.find((card) => card.id === id)!));
  const result = await invoke(APP_SHELL_CHANNELS[method], ...args);
  expect(JSON.stringify(result).length).toBeLessThan(1000);
  const shell = (nested ? (result as { snapshot: unknown }).snapshot : result) as ReturnType<CardProjection["snapshot"]>;
  expect(shell.state!.cards).toHaveLength(2);
  expect(shell.state!.cards[0]).not.toHaveProperty("transcription");
  expect(shell.state!.cards[0].metadata).not.toHaveProperty("structured");
  const body = await invoke(APP_SHELL_CHANNELS.getCardBody, "selected");
  expect(body).toMatchObject({ cardId: "selected", revision: shell.state!.cards[0].bodyRevision, transcription: cards[0].transcription.text });
  expect(JSON.stringify(body)).not.toContain("unselected transcript");
});
