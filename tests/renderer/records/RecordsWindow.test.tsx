// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecordsWindow } from "@renderer/records/RecordsWindow";
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
const reportRendererDiagnostic = vi.fn<MumblerShellApi["reportRendererDiagnostic"]>();
const saveRecordsListWidth = vi.fn<MumblerShellApi["saveRecordsListWidth"]>();
let recordsChanged: (() => void) | null = null;
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
    currentSession: SESSION, sessions: [SESSION, "2026-10-01T08:00:00.000Z"], cards: [{ cardId: "card-1", name: "take.wav" }],
  });
  reportRendererDiagnostic.mockReset();
  reportRendererDiagnostic.mockResolvedValue();
  saveRecordsListWidth.mockReset();
  saveRecordsListWidth.mockImplementation(async (width) => width);
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
      readRecordsPage, readRecordDetail, readRecordSources, reportRendererDiagnostic, saveRecordsListWidth, onRecordsChanged,
    } satisfies Partial<MumblerShellApi>,
  });
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
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
const signal = async () => {
  await act(async () => recordsChanged!());
};
const cursorOf = (record: RecordSummary) => ({ time: record.time, kind: record.kind, id: record.id });

describe("RecordsWindow", () => {
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

  it("offers Needs attention first among the levels, with every filter off", async () => {
    await mount();
    const level = document.querySelectorAll("select")[3]!;
    expect(Array.from(level.options).map((option) => option.textContent)).toEqual([
      "All levels", "Needs attention", "Error", "Warning", "Info", "Debug",
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

  it("re-reads the newest page once for a burst of new records while at the top, keeping the rows shown", async () => {
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
