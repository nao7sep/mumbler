// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecordsWindow } from "@renderer/records/RecordsWindow";
import type { MumblerShellApi } from "@shared/app-shell";
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

let root: Root | null = null;
const readRecordsPage = vi.fn<MumblerShellApi["readRecordsPage"]>();
const readRecordDetail = vi.fn<MumblerShellApi["readRecordDetail"]>();
const readRecordSources = vi.fn<MumblerShellApi["readRecordSources"]>();
const reportRendererDiagnostic = vi.fn<MumblerShellApi["reportRendererDiagnostic"]>();

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
  Object.defineProperty(window, "mumbler", {
    configurable: true,
    value: { readRecordsPage, readRecordDetail, readRecordSources, reportRendererDiagnostic } satisfies Partial<MumblerShellApi>,
  });
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

async function mount(): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(React.createElement(RecordsWindow)));
}

const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
const lastQuery = (): RecordsQuery => readRecordsPage.mock.calls.at(-1)![0];

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
    await act(async () => {
      options()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });

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

  it("continues the list from the last record shown", async () => {
    readRecordsPage.mockResolvedValueOnce({ records: [call], more: true });
    readRecordsPage.mockResolvedValueOnce({ records: [line], more: false });
    await mount();

    const more = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Show more")!;
    await act(async () => more.click());

    expect(lastQuery().after).toEqual({ time: call.time, kind: "provider-call", id: 4 });
    expect(options()).toHaveLength(2);
    expect(document.body.textContent).not.toContain("Show more");
  });

  it("says when the records cannot be read, without the raw error", async () => {
    readRecordsPage.mockRejectedValue(new Error("SQLITE_CORRUPT /Users/someone/.mumbler/records.sqlite3"));
    await mount();

    expect(document.body.textContent).toContain("The records could not be read.");
    expect(document.body.textContent).not.toContain("SQLITE_CORRUPT");
    expect(reportRendererDiagnostic).toHaveBeenCalled();
  });
});
