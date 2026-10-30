// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecordsApp, RecordsWindow } from "@renderer/records/RecordsWindow";
import type { MumblerShellApi } from "@shared/app-shell";
import { RECORDS_DETAIL_MIN_WIDTH, RECORDS_GAP, RECORDS_LIST_WIDTH, RECORDS_PADDING } from "@shared/layout";
import type { RecordDetail, RecordsPage, RecordsQuery, RecordSummary } from "@shared/records";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = "2026-10-02T08:00:00.000Z";

const call: RecordSummary = {
  kind: "provider-call", id: 4, session: SESSION, time: "2026-10-02T08:01:00.000Z", level: "error",
  title: "gemini models.generateContent", text: "gemini-x", cardId: "card-1",
};
const line: RecordSummary = {
  kind: "log", id: 9, session: SESSION, time: "2026-10-02T08:00:30.000Z", level: "warn",
  title: "pipeline.step", text: "Gemini step attempt failed.", cardId: "card-1",
};
const callDetail: RecordDetail = {
  kind: "provider-call", id: 4, session: SESSION, startedAt: "2026-10-02T08:01:00.000Z",
  finishedAt: "2026-10-02T08:01:02.500Z", cardId: "card-1", step: "title", attempt: 2, provider: "gemini",
  operation: "models.generateContent", endpoint: null, model: "gemini-x",
  request: JSON.stringify({ contents: "say hello", apiKey: "sk-test" }), response: "null",
  error: JSON.stringify({ name: "Error", message: "quota" }),
};

const newer: RecordSummary = {
  kind: "log", id: 12, session: SESSION, time: "2026-10-02T08:02:00.000Z", level: "info",
  title: "app.later", text: "Arrived while the window was open.", cardId: null,
};

let root: Root | null = null;
const readRecordsPage = vi.fn<MumblerShellApi["readRecordsPage"]>();
const readRecordDetail = vi.fn<MumblerShellApi["readRecordDetail"]>();
const readRecordSources = vi.fn<MumblerShellApi["readRecordSources"]>();
const recordsMissing = vi.fn<MumblerShellApi["recordsMissing"]>();
const reportRendererDiagnostic = vi.fn<MumblerShellApi["reportRendererDiagnostic"]>();
const getSettingsDraft = vi.fn<MumblerShellApi["getSettingsDraft"]>();
const saveRecordsListWidth = vi.fn<MumblerShellApi["saveRecordsListWidth"]>();
let recordsChanged: ((missingRecords: boolean) => void) | null = null;
const interfaceListeners = new Set<() => void>();
const onRecordsChanged = vi.fn<MumblerShellApi["onRecordsChanged"]>((listener) => {
  recordsChanged = listener;
  return () => {
    recordsChanged = null;
  };
});

// jsdom lays nothing out, so the list's scroll box and the shell's width are
// set here. By default the list is scrolled to the top and far from its end.
const box = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200, shellWidth: 2000 };
const resizeCallbacks = new Set<() => void>();
class TestResizeObserver {
  private readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
  }
  observe(): void {
    resizeCallbacks.add(this.callback);
  }
  disconnect(): void {
    resizeCallbacks.delete(this.callback);
  }
}
const isScroll = (element: HTMLElement) => element.classList.contains("records-list-scroll");

beforeEach(() => {
  readRecordsPage.mockReset();
  readRecordsPage.mockResolvedValue({ records: [call, line], more: false } satisfies RecordsPage);
  readRecordDetail.mockReset();
  readRecordDetail.mockResolvedValue(callDetail);
  readRecordSources.mockReset();
  readRecordSources.mockResolvedValue({
    currentSession: SESSION, displayTimezone: "UTC", sessions: [SESSION, "2026-10-01T08:00:00.000Z"], cards: [{ cardId: "card-1", name: "take.wav" }],
  });
  recordsMissing.mockReset();
  recordsMissing.mockResolvedValue(false);
  reportRendererDiagnostic.mockReset();
  reportRendererDiagnostic.mockResolvedValue();
  saveRecordsListWidth.mockReset();
  saveRecordsListWidth.mockImplementation(async (width) => width);
  getSettingsDraft.mockReset();
  interfaceListeners.clear();
  onRecordsChanged.mockClear();
  recordsChanged = null;
  Object.assign(box, { scrollTop: 0, scrollHeight: 1000, clientHeight: 200, shellWidth: 2000 });
  resizeCallbacks.clear();
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  Object.defineProperties(HTMLElement.prototype, {
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) { return isScroll(this) ? box.scrollTop : 0; },
      set(this: HTMLElement, value: number) { if (isScroll(this)) box.scrollTop = value; },
    },
    scrollHeight: { configurable: true, get(this: HTMLElement) { return isScroll(this) ? box.scrollHeight : 0; } },
    clientHeight: { configurable: true, get(this: HTMLElement) { return isScroll(this) ? box.clientHeight : 0; } },
    clientWidth: {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains("records-shell") ? box.shellWidth : 0; },
    },
  });
  Object.defineProperty(window, "mumbler", {
    configurable: true,
    value: {
      recordsMissing, readRecordsPage, readRecordDetail, readRecordSources, reportRendererDiagnostic, saveRecordsListWidth, onRecordsChanged,
      getSettingsDraft,
      getInterfaceLanguage: async () => ({ language: "en", locale: "en" }),
      getRecordsListWidth: async () => RECORDS_LIST_WIDTH.default,
      onInterfaceLanguageChanged: (listener: () => void) => { interfaceListeners.add(listener); return () => interfaceListeners.delete(listener); },
    } satisfies Partial<MumblerShellApi>,
  });
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  document.documentElement.style.removeProperty("--font-ui");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const name of ["scrollTop", "scrollHeight", "clientHeight", "clientWidth"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

async function mount(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(React.createElement(RecordsWindow, { initialListWidth: RECORDS_LIST_WIDTH.default })));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
const titles = () => options().map((option) => option.querySelector(".records-row__title")?.textContent);
const lastQuery = (): RecordsQuery => readRecordsPage.mock.calls.at(-1)![0];
const scrollBox = () => document.querySelector<HTMLElement>(".records-list-scroll")!;
const scrollTo = async (top: number, events = 1) => {
  await act(async () => {
    box.scrollTop = top;
    for (let index = 0; index < events; index++) scrollBox().dispatchEvent(new Event("scroll"));
  });
};
const press = async (key: string) => {
  await act(async () => {
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
};
const signal = async (missingRecords = false) => {
  await act(async () => recordsChanged!(missingRecords));
};
const cursorOf = (record: RecordSummary) => ({ time: record.time, kind: record.kind, id: record.id });

describe("RecordsWindow", () => {
  it("shows initial missing-history health independently of read failures", async () => {
    recordsMissing.mockResolvedValue(true);
    readRecordSources.mockRejectedValue(new Error("unavailable"));
    await mount();
    expect(document.body.textContent).toContain("Some records may be missing.");
  });

  it("keeps health notices after subsequent successful writes even when live refresh is suspended", async () => {
    readRecordSources.mockRejectedValue(new Error("unavailable"));
    await mount();
    await signal(true);
    expect(document.body.textContent).toContain("Some records may be missing.");
    await signal(false);
    expect(document.body.textContent).toContain("Some records may be missing.");
  });

  it("lists the records newest first, with nothing selected yet", async () => {
    await mount();

    expect(options().map((option) => option.querySelector(".records-row__title")?.textContent)).toEqual([
      "gemini models.generateContent",
      "pipeline.step",
    ]);
    expect(lastQuery()).toEqual({ session: null, kind: null, level: null, cardId: null, search: "", after: null });
    expect(document.body.textContent).toContain("Select a record to see everything it holds.");
    expect(options()[0]!.tabIndex).toBe(0);
    expect(options()[1]!.tabIndex).toBe(-1);
  });

  // timestamp-conventions: the app's own event times show in the display zone.
  it("shows record times in the display zone, and reads it again when Settings change it", async () => {
    readRecordSources.mockResolvedValue({ currentSession: SESSION, displayTimezone: "Asia/Tokyo", sessions: [SESSION], cards: [] });
    await mount();
    const shown = new Intl.DateTimeFormat("en", { dateStyle: "short", timeStyle: "medium", timeZone: "Asia/Tokyo" }).format(new Date(call.time));
    expect(options()[0]!.textContent).toContain(shown);

    const reads = readRecordSources.mock.calls.length;
    await act(async () => { for (const listener of interfaceListeners) listener(); });
    expect(readRecordSources.mock.calls.length).toBe(reads + 1);
  });

  it("shows everything a selected provider call holds", async () => {
    await mount();
    await act(async () => options()[0]!.click());

    expect(readRecordDetail).toHaveBeenCalledWith("provider-call", 4);
    const blocks = Array.from(document.querySelectorAll(".records-block")).map((block) => [
      block.querySelector("h3")?.textContent,
      block.querySelector("pre")?.textContent,
    ]);
    expect(blocks).toEqual([
      ["Request", JSON.stringify({ contents: "say hello", apiKey: "sk-test" }, null, 2)],
      ["Response", "null"],
      ["Error", JSON.stringify({ name: "Error", message: "quota" }, null, 2)],
    ]);
    const body = document.querySelector(".records-detail__body")!.textContent!;
    expect(body).toContain("take.wav");
    expect(body).toContain("card-1");
    expect(body).toContain("Title");
    expect(body).toContain("2.500");
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("moves the selection with the arrow keys", async () => {
    await mount();
    await act(async () => options()[0]!.focus());
    await press("ArrowDown");

    expect(document.activeElement).toBe(options()[1]);
    expect(readRecordDetail).toHaveBeenLastCalledWith("log", 9);
  });

  it("pages by the visible viewport height rather than the full list height", async () => {
    const records = Array.from({ length: 30 }, (_, index): RecordSummary => ({ ...line, id: index + 1 }));
    readRecordsPage.mockResolvedValue({ records, more: false });
    await mount();
    const list = document.querySelector<HTMLElement>('[role="listbox"]')!;
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 1200 });
    Object.defineProperty(options()[0]!, "offsetHeight", { configurable: true, value: 40 });
    await act(async () => options()[0]!.focus());
    await press("PageDown");
    expect(document.activeElement).toBe(options()[5]);
    await press("PageDown");
    expect(document.activeElement).toBe(options()[10]);
    await press("PageUp");
    expect(document.activeElement).toBe(options()[5]);
  });

  it("reads again with each filter, and searches once typing pauses", async () => {
    await mount();
    const selects = Array.from(document.querySelectorAll("select"));
    expect(Array.from(selects[0]!.options).map((option) => option.textContent)).toEqual([
      "All launches",
      expect.stringContaining("(this launch)"),
      expect.not.stringContaining("(this launch)"),
    ]);

    const choose = async (select: HTMLSelectElement, value: string) => {
      await act(async () => {
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };
    await choose(selects[0]!, SESSION);
    await choose(selects[1]!, "card-1");
    await choose(selects[2]!, "provider-call");
    await choose(selects[3]!, "error");
    expect(lastQuery()).toEqual({ session: SESSION, kind: "provider-call", level: "error", cardId: "card-1", search: "", after: null });

    vi.useFakeTimers();
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(search, "quota");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(lastQuery().search).toBe("");
    await act(async () => vi.advanceTimersByTime(300));
    expect(lastQuery().search).toBe("quota");
  });

  it("shows a loading note while the first page is read, then the rows", async () => {
    const first = deferred<RecordsPage>();
    readRecordsPage.mockReturnValueOnce(first.promise);
    await mount();

    expect(document.body.textContent).toContain("Loading records…");
    expect(document.body.textContent).not.toContain("No records match these filters.");
    expect(options()).toHaveLength(0);

    await act(async () => first.resolve({ records: [call, line], more: false }));
    expect(options()).toHaveLength(2);
    expect(document.body.textContent).not.toContain("Loading records…");
  });

  it.each([false, true])("shows a failed live read after it supersedes a still-loading initial read (%s)", async (initialFails) => {
    const first = deferred<RecordsPage>();
    const newest = deferred<RecordsPage>();
    readRecordsPage.mockReturnValueOnce(first.promise).mockReturnValueOnce(newest.promise);
    await mount();
    vi.useFakeTimers();
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(readRecordsPage).toHaveBeenCalledTimes(2);

    await act(async () => {
      if (initialFails) first.reject(new Error("superseded initial read"));
      else first.resolve({ records: [call, line], more: false });
    });
    expect(document.body.textContent).toContain("Loading records…");
    expect(options()).toHaveLength(0);
    expect(reportRendererDiagnostic).not.toHaveBeenCalled();

    await act(async () => newest.reject(new Error("SQLITE_BUSY /internal/records.sqlite3 live-read-sentinel")));
    expect(document.body.textContent).toContain("The records could not be read.");
    expect(document.body.textContent).not.toContain("Loading records…");
    expect(document.body.textContent).not.toContain("live-read-sentinel");
    expect(scrollBox().getAttribute("aria-busy")).toBe("false");
    expect(reportRendererDiagnostic).toHaveBeenCalledOnce();
  });

  it("offers Warnings and errors first among the levels, with every filter off", async () => {
    await mount();
    const level = document.querySelectorAll("select")[3]!;
    expect(Array.from(level.options).map((option) => option.textContent)).toEqual([
      "All levels", "Warnings and errors", "Error", "Warning", "Info", "Debug",
    ]);
    expect(level.value).toBe("");
  });

  it("has no Refresh button", async () => {
    await mount();
    expect(Array.from(document.querySelectorAll("button")).map((button) => button.textContent)).not.toContain("Refresh");
  });

  it("reads the next page from the last row once the list is scrolled near its end", async () => {
    readRecordsPage.mockResolvedValueOnce({ records: [call], more: true });
    readRecordsPage.mockResolvedValueOnce({ records: [line], more: false });
    await mount();
    expect(readRecordsPage).toHaveBeenCalledOnce();

    await scrollTo(700);

    expect(readRecordsPage).toHaveBeenCalledTimes(2);
    expect(lastQuery().after).toEqual(cursorOf(call));
    expect(titles()).toEqual(["gemini models.generateContent", "pipeline.step"]);
    expect(document.body.textContent).not.toContain("Show more");
  });

  it("reads the next page when ArrowDown is pressed on the last row", async () => {
    readRecordsPage.mockResolvedValueOnce({ records: [call, line], more: true });
    readRecordsPage.mockResolvedValueOnce({ records: [], more: false });
    await mount();
    await act(async () => options()[1]!.focus());
    await press("ArrowDown");

    expect(readRecordsPage).toHaveBeenCalledTimes(2);
    expect(lastQuery().after).toEqual(cursorOf(line));
    expect(document.activeElement).toBe(options()[1]);
  });

  it("makes one request for two scroll events together", async () => {
    readRecordsPage.mockResolvedValueOnce({ records: [call, line], more: true });
    readRecordsPage.mockReturnValueOnce(new Promise<RecordsPage>(() => {}));
    await mount();

    await scrollTo(800, 2);

    expect(readRecordsPage).toHaveBeenCalledTimes(2);
    expect(options()).toHaveLength(2);
    expect(document.body.textContent).toContain("Loading records…");
  });

  it("reads the next page by itself while a page does not fill the list", async () => {
    box.scrollHeight = 150;
    readRecordsPage.mockResolvedValueOnce({ records: [call], more: true });
    readRecordsPage.mockResolvedValueOnce({ records: [line], more: false });
    await mount();

    expect(readRecordsPage).toHaveBeenCalledTimes(2);
    expect(titles()).toEqual(["gemini models.generateContent", "pipeline.step"]);
  });

  it("keeps a failed page's note at the end, and reads it again when the end is reached again", async () => {
    readRecordsPage.mockResolvedValueOnce({ records: [call], more: true });
    readRecordsPage.mockRejectedValueOnce(new Error("busy"));
    readRecordsPage.mockResolvedValueOnce({ records: [line], more: false });
    await mount();

    await scrollTo(700);
    expect(document.body.textContent).toContain("The records could not be read.");
    expect(options()).toHaveLength(1);
    expect(readRecordsPage).toHaveBeenCalledTimes(2);

    await scrollTo(750);
    expect(readRecordsPage).toHaveBeenCalledTimes(3);
    expect(lastQuery().after).toEqual(cursorOf(call));
    expect(titles()).toEqual(["gemini models.generateContent", "pipeline.step"]);
    expect(document.body.textContent).not.toContain("The records could not be read.");
  });

  it("re-reads the newest page once for a burst of new records while at the top, without a loading screen", async () => {
    await mount();
    vi.useFakeTimers();
    const next = deferred<RecordsPage>();
    readRecordsPage.mockReturnValueOnce(next.promise);

    await signal();
    await signal();
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));

    expect(readRecordsPage).toHaveBeenCalledTimes(2);
    expect(lastQuery()).toEqual({ session: null, kind: null, level: null, cardId: null, search: "", after: null });
    expect(readRecordSources).toHaveBeenCalledTimes(2);
    expect(options()).toHaveLength(2);
    expect(document.body.textContent).not.toContain("Loading records…");

    await act(async () => next.resolve({ records: [newer, call, line], more: false }));
    expect(titles()).toEqual(["app.later", "gemini models.generateContent", "pipeline.step"]);
  });

  it("leaves the list alone while scrolled down, and shows new records once back at the top", async () => {
    await mount();
    await scrollTo(300);
    vi.useFakeTimers();
    readRecordsPage.mockResolvedValueOnce({ records: [newer, call, line], more: false });

    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(readRecordsPage).toHaveBeenCalledOnce();
    expect(options()).toHaveLength(2);

    await scrollTo(0);
    expect(readRecordsPage).toHaveBeenCalledTimes(2);
    expect(titles()).toEqual(["app.later", "gemini models.generateContent", "pipeline.step"]);
  });

  it("reads every row across a gap larger than one page, keeping the selected detail", async () => {
    const rows = (count: number): RecordSummary[] => Array.from({ length: count }, (_, index) => ({
      kind: "log", id: count - index, session: SESSION, time: SESSION, level: "info",
      title: `record ${count - index}`, text: null, cardId: null,
    }));
    let stored = rows(100);
    readRecordsPage.mockImplementation(async (query) => {
      const after = query.after?.id;
      const following = after === undefined ? stored : stored.filter((record) => record.id < after);
      // A loaded page grows the scroll box, as the real list does.
      if (after !== undefined) box.scrollHeight += 1000;
      return { records: following.slice(0, 100), more: following.length > 100 };
    });
    readRecordDetail.mockResolvedValue({
      kind: "log", id: 75, session: SESSION, time: SESSION, op: "selected", message: "selected detail",
      level: "info", cardId: null, details: null, error: null,
    });
    await mount();
    await act(async () => options()[25]!.click());
    await scrollTo(300);
    vi.useFakeTimers();
    stored = rows(350);
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(options()).toHaveLength(100);

    await scrollTo(0);
    expect(options().map((option) => option.dataset.recordKey)).toEqual(stored.slice(0, 100).map((record) => `log:${record.id}`));
    expect(document.querySelector(".records-detail__title")?.textContent).toBe("selected detail");
    expect(readRecordDetail).toHaveBeenCalledOnce();
    for (let page = 0; page < 3; page++) await scrollTo(box.scrollHeight - 300);

    expect(options().map((option) => option.dataset.recordKey)).toEqual(stored.map((record) => `log:${record.id}`));
    expect(document.querySelector('[data-record-key="log:75"]')?.getAttribute("aria-selected")).toBe("true");
    expect(readRecordDetail).toHaveBeenCalledOnce();
  });

  it("finds a provider call that settles late inside an already-loaded older range", async () => {
    const time = (seconds: number) => new Date(Date.parse(SESSION) + seconds * 1000).toISOString();
    const stored: RecordSummary[] = Array.from({ length: 300 }, (_, index) => ({
      kind: "log", id: 300 - index, session: SESSION, time: time(300 - index), level: "info",
      title: `record ${300 - index}`, text: null, cardId: null,
    }));
    const key = (record: Pick<RecordSummary, "kind" | "id">) => `${record.kind}:${record.id}`;
    readRecordsPage.mockImplementation(async (query) => {
      const start = query.after === null ? 0 : stored.findIndex((record) => key(record) === key(query.after!)) + 1;
      const following = stored.slice(start);
      if (query.after !== null) box.scrollHeight += 1000;
      return { records: following.slice(0, 100), more: following.length > 100 };
    });
    readRecordDetail.mockResolvedValue({
      kind: "log", id: 150, session: SESSION, time: time(150), op: "selected", message: "selected older detail",
      level: "info", cardId: null, details: null, error: null,
    });
    await mount();
    await scrollTo(700);
    expect(options()).toHaveLength(200);
    await act(async () => document.querySelector<HTMLElement>('[data-record-key="log:150"]')!.click());
    await scrollTo(0);
    vi.useFakeTimers();
    // Calls are inserted when they finish, but sort by when they started.
    // This newly settled call belongs below the fresh first 100 rows and
    // above the older tail already loaded by the reader.
    stored.splice(150, 0, { ...call, time: time(150.5), title: "late provider call" });
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(document.body.textContent).not.toContain("Loading records…");
    expect(document.querySelector(".records-detail__title")?.textContent).toBe("selected older detail");
    for (let page = 0; page < 3; page++) await scrollTo(box.scrollHeight - 300);

    expect(options().map((option) => option.dataset.recordKey)).toEqual(stored.map(key));
    expect(document.querySelector('[data-record-key="log:150"]')?.getAttribute("aria-selected")).toBe("true");
    expect(readRecordDetail).toHaveBeenCalledOnce();
  });

  it("holds a pending newest page if the reader scrolls away before it arrives", async () => {
    const newest = deferred<RecordsPage>();
    const more = deferred<RecordsPage>();
    readRecordsPage.mockResolvedValueOnce({ records: [call], more: true });
    readRecordsPage.mockReturnValueOnce(newest.promise).mockReturnValueOnce(more.promise);
    await mount();
    vi.useFakeTimers();
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    await scrollTo(700);
    expect(lastQuery().after).toEqual(cursorOf(call));

    await act(async () => newest.resolve({ records: [newer, call], more: true }));
    expect(titles()).toEqual(["gemini models.generateContent"]);
    expect(document.body.textContent).toContain("Loading records…");
    await act(async () => more.resolve({ records: [line], more: false }));
    expect(titles()).toEqual(["gemini models.generateContent", "pipeline.step"]);
    expect(document.body.textContent).not.toContain("Loading records…");
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(readRecordsPage).toHaveBeenCalledTimes(3);

    readRecordsPage.mockResolvedValueOnce({ records: [newer, call, line], more: false });
    await scrollTo(0);
    expect(readRecordsPage).toHaveBeenCalledTimes(4);
    expect(lastQuery().after).toBeNull();
    expect(titles()).toEqual(["app.later", "gemini models.generateContent", "pipeline.step"]);
  });

  it.each([false, true])("uses the latest requested newest page whichever read settles first (%s)", async (olderFirst) => {
    readRecordsPage.mockResolvedValueOnce({ records: [line], more: false });
    await mount();
    vi.useFakeTimers();
    const earlier = deferred<RecordsPage>();
    const later = deferred<RecordsPage>();
    readRecordsPage.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(later.promise);
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));

    if (olderFirst) {
      await act(async () => earlier.resolve({ records: [call], more: true }));
      await act(async () => later.resolve({ records: [newer], more: false }));
    } else {
      await act(async () => later.resolve({ records: [newer], more: false }));
      await act(async () => earlier.resolve({ records: [call], more: true }));
    }
    expect(titles()).toEqual(["app.later"]);
  });

  it("discards a page still loading from a range replaced by a disconnected newest page", async () => {
    readRecordsPage.mockResolvedValueOnce({ records: [call], more: true });
    const oldMore = deferred<RecordsPage>();
    readRecordsPage.mockReturnValueOnce(oldMore.promise);
    await mount();
    await scrollTo(700);
    await scrollTo(0);
    vi.useFakeTimers();
    readRecordsPage.mockResolvedValueOnce({ records: [newer], more: true });
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    await act(async () => oldMore.resolve({ records: [line], more: false }));
    expect(titles()).toEqual(["app.later"]);
    expect(document.body.textContent).not.toContain("Loading records…");

    readRecordsPage.mockResolvedValueOnce({ records: [call, line], more: false });
    await scrollTo(700);
    expect(lastQuery().after).toEqual(cursorOf(newer));
    expect(titles()).toEqual(["app.later", "gemini models.generateContent", "pipeline.step"]);
  });

  it("ignores an earlier pagination result after restarting from an overlapping newest page", async () => {
    readRecordsPage.mockResolvedValueOnce({ records: [call], more: true });
    const more = deferred<RecordsPage>();
    readRecordsPage.mockReturnValueOnce(more.promise);
    await mount();
    await scrollTo(700);
    await scrollTo(0);
    vi.useFakeTimers();
    readRecordsPage.mockResolvedValueOnce({ records: [newer, call, line], more: false });
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    await act(async () => more.resolve({ records: [line], more: false }));

    expect(titles()).toEqual(["app.later", "gemini models.generateContent", "pipeline.step"]);
    expect(document.body.textContent).not.toContain("Loading records…");
  });

  it("keeps the selected record selected through an update", async () => {
    await mount();
    await act(async () => options()[1]!.click());
    vi.useFakeTimers();
    readRecordsPage.mockResolvedValueOnce({ records: [newer, call, line], more: false });

    await signal();
    await act(async () => vi.advanceTimersByTime(1000));

    expect(options()).toHaveLength(3);
    expect(options()[2]!.getAttribute("aria-selected")).toBe("true");
    expect(readRecordDetail).toHaveBeenCalledOnce();
  });

  it("stops reading on new-record signals after a failed read, so a logged failure cannot start the next read", async () => {
    await mount();
    vi.useFakeTimers();
    readRecordsPage.mockRejectedValueOnce(new Error("busy"));

    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(readRecordsPage).toHaveBeenCalledTimes(2);

    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(readRecordsPage).toHaveBeenCalledTimes(2);
    expect(options()).toHaveLength(2);
  });

  it.each(["records", "sources"])("keeps ready rows and selection when a %s refresh fails, and retries both reads explicitly", async (failure) => {
    await mount();
    await act(async () => options()[1]!.click());
    vi.useFakeTimers();
    if (failure === "records") readRecordsPage.mockRejectedValueOnce(new Error("refresh failed"));
    else readRecordSources.mockRejectedValueOnce(new Error("refresh failed"));
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(titles()).toEqual(["gemini models.generateContent", "pipeline.step"]);
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(document.body.textContent).toContain("The records could not be read.");
    const reads = readRecordsPage.mock.calls.length;
    const sourceReads = readRecordSources.mock.calls.length;
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(readRecordsPage).toHaveBeenCalledTimes(reads);
    expect(readRecordSources).toHaveBeenCalledTimes(sourceReads);

    const retryPage = deferred<RecordsPage>();
    const retrySources = deferred<Awaited<ReturnType<MumblerShellApi["readRecordSources"]>>>();
    readRecordsPage.mockReturnValueOnce(retryPage.promise);
    readRecordSources.mockReturnValueOnce(retrySources.promise);
    const retry = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Retry")!;
    await act(async () => retry.click());
    expect(retry.disabled).toBe(true);
    expect(readRecordsPage).toHaveBeenCalledTimes(reads + 1);
    expect(readRecordSources).toHaveBeenCalledTimes(sourceReads + 1);
    await act(async () => retryPage.resolve({ records: [newer, call, line], more: false }));
    expect(document.body.textContent).toContain("The records could not be read.");
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(readRecordsPage).toHaveBeenCalledTimes(reads + 1);
    await act(async () => retrySources.resolve({ currentSession: SESSION, displayTimezone: "UTC", sessions: [SESSION], cards: [] }));
    expect(document.body.textContent).not.toContain("The records could not be read.");
    expect(options()[2]!.getAttribute("aria-selected")).toBe("true");
    expect(readRecordDetail).toHaveBeenCalledOnce();
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(readRecordsPage).toHaveBeenCalledTimes(reads + 2);
  });

  it("keeps refresh failure visible after an unsuccessful explicit retry without a retry loop", async () => {
    await mount();
    vi.useFakeTimers();
    readRecordsPage.mockRejectedValueOnce(new Error("refresh failed"));
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    readRecordSources.mockRejectedValueOnce(new Error("sources still unavailable"));
    const retry = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Retry")!;
    await act(async () => retry.click());
    expect(retry.disabled).toBe(false);
    expect(document.body.textContent).toContain("The records could not be read.");
    const reads = readRecordsPage.mock.calls.length;
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(readRecordsPage).toHaveBeenCalledTimes(reads);
  });

  it("ignores an obsolete refresh failure after a successful explicit retry", async () => {
    await mount();
    vi.useFakeTimers();
    const obsolete = deferred<RecordsPage>();
    readRecordsPage.mockReturnValueOnce(obsolete.promise);
    readRecordSources.mockRejectedValueOnce(new Error("sources unavailable"));
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    const retry = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Retry")!;
    await act(async () => retry.click());
    expect(document.body.textContent).not.toContain("The records could not be read.");
    await act(async () => obsolete.reject(new Error("obsolete refresh failed")));
    expect(document.body.textContent).not.toContain("The records could not be read.");
    const reads = readRecordsPage.mock.calls.length;
    await signal();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(readRecordsPage).toHaveBeenCalledTimes(reads + 1);
  });

  it("stops listening for new records when it closes", async () => {
    await mount();
    expect(recordsChanged).not.toBeNull();
    await act(async () => root?.unmount());
    root = null;
    expect(recordsChanged).toBeNull();
  });

  it("saves the list width once when a drag ends, clamped to the pane's bounds", async () => {
    await mount();
    const splitter = document.querySelector<HTMLElement>('[role="separator"]')!;
    expect(splitter.getAttribute("aria-label")).toBe("Resize list pane");

    await act(async () => {
      splitter.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 0 }));
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 2000 }));
      window.dispatchEvent(new MouseEvent("pointerup"));
    });

    expect(saveRecordsListWidth).toHaveBeenCalledExactlyOnceWith(RECORDS_LIST_WIDTH.max);
    const shell = document.querySelector<HTMLElement>(".records-shell")!;
    expect(shell.style.getPropertyValue("--records-list-width")).toBe(`${RECORDS_LIST_WIDTH.max}px`);
  });

  it("resizes the list by keyboard, 16 px per arrow and to the bounds with Home and End, saving once after the last step", async () => {
    await mount();
    const splitter = document.querySelector<HTMLElement>('[role="separator"]')!;
    const shell = document.querySelector<HTMLElement>(".records-shell")!;
    const key = (type: "keydown" | "keyup", name: string) =>
      act(async () => { splitter.dispatchEvent(new KeyboardEvent(type, { key: name, bubbles: true })); });
    const press = async (name: string) => { await key("keydown", name); await key("keyup", name); };
    expect(splitter.tabIndex).toBe(0);
    expect(splitter.getAttribute("aria-valuemin")).toBe(String(RECORDS_LIST_WIDTH.min));

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await press("ArrowRight");
      await act(async () => { vi.advanceTimersByTime(400); });
      await press("ArrowRight");
      expect(shell.style.getPropertyValue("--records-list-width")).toBe(`${RECORDS_LIST_WIDTH.default + 32}px`);
      await act(async () => { vi.advanceTimersByTime(400); });
      expect(saveRecordsListWidth, "each step pushes the save back").not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(100); });
      expect(saveRecordsListWidth).toHaveBeenCalledExactlyOnceWith(RECORDS_LIST_WIDTH.default + 32);

      await press("Home");
      await act(async () => { splitter.dispatchEvent(new FocusEvent("blur")); splitter.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
      expect(saveRecordsListWidth, "losing focus saves at once").toHaveBeenLastCalledWith(RECORDS_LIST_WIDTH.min);
      await act(async () => { vi.advanceTimersByTime(1_000); });
      expect(saveRecordsListWidth).toHaveBeenCalledTimes(2);

      await press("End");
      await act(async () => root?.unmount());
      root = null;
      expect(saveRecordsListWidth, "closing the window saves at once").toHaveBeenLastCalledWith(RECORDS_LIST_WIDTH.max);
      expect(saveRecordsListWidth).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });

  it("narrows the list when the window narrows, saving nothing", async () => {
    await mount();
    const shell = document.querySelector<HTMLElement>(".records-shell")!;
    expect(shell.style.getPropertyValue("--records-list-width")).toBe(`${RECORDS_LIST_WIDTH.default}px`);

    await act(async () => {
      box.shellWidth = RECORDS_PADDING * 2 + RECORDS_GAP + RECORDS_DETAIL_MIN_WIDTH + RECORDS_LIST_WIDTH.min;
      for (const callback of resizeCallbacks) callback();
    });

    expect(shell.style.getPropertyValue("--records-list-width")).toBe(`${RECORDS_LIST_WIDTH.min}px`);
    expect(saveRecordsListWidth).not.toHaveBeenCalled();
  });

  it("says when the records cannot be read, without the raw error", async () => {
    readRecordsPage.mockRejectedValue(new Error("SQLITE_CORRUPT /Users/someone/.mumbler/records.sqlite3"));
    await mount();

    expect(document.body.textContent).toContain("The records could not be read.");
    expect(document.body.textContent).not.toContain("SQLITE_CORRUPT");
    expect(reportRendererDiagnostic).toHaveBeenCalled();
  });
});

describe("RecordsApp preferences", () => {
  it("keeps only the latest requested font and ignores pending reads after cleanup", async () => {
    type Draft = Awaited<ReturnType<MumblerShellApi["getSettingsDraft"]>>;
    const initial = deferred<Draft>();
    const newer = deferred<Draft>();
    const afterClose = deferred<Draft>();
    getSettingsDraft.mockReturnValueOnce(initial.promise).mockReturnValueOnce(newer.promise).mockReturnValueOnce(afterClose.promise);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<RecordsApp />));
    await act(async () => { for (const listener of interfaceListeners) listener(); });
    await act(async () => newer.resolve({ uiFontFamily: "Newest Sans" } as Draft));
    await act(async () => initial.resolve({ uiFontFamily: "Obsolete Sans" } as Draft));
    expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe("Newest Sans");
    await act(async () => { for (const listener of interfaceListeners) listener(); });
    await act(async () => root?.unmount());
    root = null;
    await act(async () => afterClose.resolve({ uiFontFamily: "Closed Sans" } as Draft));
    expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe("Newest Sans");
  });

  it("applies the saved UI family initially and rereads it on interface changes, including blank reset", async () => {
    // This surface reads only the appearance field from the existing settings API.
    const initial = deferred<Awaited<ReturnType<MumblerShellApi["getSettingsDraft"]>>>();
    getSettingsDraft.mockReturnValueOnce(initial.promise);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<RecordsApp />));
    expect(options()).toHaveLength(0);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => initial.resolve({ uiFontFamily: "  Example Sans, sans-serif  " } as Awaited<ReturnType<MumblerShellApi["getSettingsDraft"]>>));
    expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe("Example Sans, sans-serif");
    expect(options()).toHaveLength(2);

    getSettingsDraft.mockResolvedValue({ uiFontFamily: "Alternate Sans" } as Awaited<ReturnType<MumblerShellApi["getSettingsDraft"]>>);
    await act(async () => { for (const listener of interfaceListeners) listener(); });
    expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe("Alternate Sans");

    getSettingsDraft.mockResolvedValue({ uiFontFamily: "   " } as Awaited<ReturnType<MumblerShellApi["getSettingsDraft"]>>);
    await act(async () => { for (const listener of interfaceListeners) listener(); });
    expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe("");
    expect(getSettingsDraft).toHaveBeenCalledTimes(3);
  });
});
