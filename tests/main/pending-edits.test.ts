import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_SHELL_EVENTS } from "@shared/app-shell";
const bus = vi.hoisted(() => ({ ipc: null as EventEmitter | null }));
vi.mock("electron", () => ({ ipcMain: {
  on: (...args: Parameters<EventEmitter["on"]>) => bus.ipc!.on(...args),
  removeListener: (...args: Parameters<EventEmitter["removeListener"]>) => bus.ipc!.removeListener(...args),
} }));
import { flushWindowEdits } from "@main/pending-edits";

afterEach(() => { expect(bus.ipc?.listenerCount(APP_SHELL_EVENTS.pendingEditsFlushed)).toBe(0); });
describe("pending edit acknowledgements", () => {
  function fixture() {
    bus.ipc = new EventEmitter();
    const contents = Object.assign(new EventEmitter(), { send: vi.fn() });
    const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
    return { contents, window, reply: (id: unknown, ok: boolean) => bus.ipc!.emit(APP_SHELL_EVENTS.pendingEditsFlushed, { sender: contents }, id, ok) };
  }
  it("disposes cancelled attempts and ignores their late acknowledgement on retry", async () => {
    const f = fixture();
    const first = new AbortController();
    const old = flushWindowEdits(f.window, first.signal).catch(() => "cancelled");
    const id = f.contents.send.mock.calls[0]![1];
    first.abort();
    expect(await old).toBe("cancelled");
    const retry = new AbortController();
    let settled = false;
    const next = flushWindowEdits(f.window, retry.signal).then(() => { settled = true; });
    f.reply(id, true);
    await Promise.resolve();
    expect(settled).toBe(false);
    f.reply(f.contents.send.mock.calls[1]![1], true);
    await next;
    expect(f.contents.listenerCount("destroyed")).toBe(0);
  });
  it("rejects a reported edit failure and removes its listeners", async () => {
    const f = fixture();
    const work = flushWindowEdits(f.window, new AbortController().signal);
    f.reply(f.contents.send.mock.calls[0]![1], false);
    await expect(work).rejects.toThrow("could not save");
    expect(f.contents.listenerCount("destroyed")).toBe(0);
  });
  it("settles a destroyed renderer rather than retaining an unanswerable listener", async () => {
    const f = fixture();
    const work = flushWindowEdits(f.window, new AbortController().signal);
    f.contents.emit("destroyed");
    await expect(work).rejects.toThrow("closed before");
  });
});
