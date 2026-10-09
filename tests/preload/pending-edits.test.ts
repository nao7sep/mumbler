import { afterEach, expect, it, vi } from "vitest";
import type { MumblerShellApi } from "@shared/app-shell";
import { APP_SHELL_EVENTS } from "@shared/app-shell";
const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  api: null as MumblerShellApi | null,
  send: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: MumblerShellApi) => { electron.api = api; } },
  ipcRenderer: { on: (channel: string, callback: (...args: unknown[]) => void) => electron.handlers.set(channel, callback), send: electron.send },
  webUtils: {},
}));
import "../../src/preload/index";
afterEach(() => electron.send.mockClear());
it("waits for every flusher and reports rejection instead of a successful acknowledgement", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const removeHeld = electron.api!.onFlushPendingEdits(() => gate);
  const removeFailed = electron.api!.onFlushPendingEdits(async () => { throw new Error("draft save failed"); });
  try {
    electron.handlers.get(APP_SHELL_EVENTS.flushPendingEdits)!({}, 41);
    await Promise.resolve(); await Promise.resolve();
    expect(electron.send).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(electron.send).toHaveBeenCalledWith(APP_SHELL_EVENTS.pendingEditsFlushed, 41, false));
  } finally { release(); removeHeld(); removeFailed(); }
});
it("captures synchronous flusher failure and acknowledges a subsequent successful request", async () => {
  const remove = electron.api!.onFlushPendingEdits(() => { throw new Error("synchronous failure"); });
  electron.handlers.get(APP_SHELL_EVENTS.flushPendingEdits)!({}, 42);
  await vi.waitFor(() => expect(electron.send).toHaveBeenCalledWith(APP_SHELL_EVENTS.pendingEditsFlushed, 42, false));
  remove();
  electron.handlers.get(APP_SHELL_EVENTS.flushPendingEdits)!({}, 43);
  await vi.waitFor(() => expect(electron.send).toHaveBeenCalledWith(APP_SHELL_EVENTS.pendingEditsFlushed, 43, true));
});
it("reports every registered session-only draft and discards them on request", () => {
  const discard = vi.fn();
  const remove = electron.api!.onUnsavedDrafts(() => ["settings"], discard);
  const removeClean = electron.api!.onUnsavedDrafts(() => [], vi.fn());
  electron.handlers.get(APP_SHELL_EVENTS.queryUnsavedDrafts)!({}, 7);
  expect(electron.send).toHaveBeenCalledWith(APP_SHELL_EVENTS.unsavedDraftsReported, 7, ["settings"]);
  electron.handlers.get(APP_SHELL_EVENTS.discardUnsavedDrafts)!({});
  expect(discard).toHaveBeenCalledOnce();
  remove(); removeClean();
  electron.handlers.get(APP_SHELL_EVENTS.queryUnsavedDrafts)!({}, 8);
  expect(electron.send).toHaveBeenCalledWith(APP_SHELL_EVENTS.unsavedDraftsReported, 8, []);
});
