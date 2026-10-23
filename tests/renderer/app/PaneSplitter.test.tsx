// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneSplitter } from "@renderer/app/PaneSplitter";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null;
let container: HTMLDivElement;
const onResize = vi.fn();
const onCommit = vi.fn();

beforeEach(async () => {
  onResize.mockReset();
  onCommit.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(React.createElement(PaneSplitter, {
    label: "Resize panes", width: 200, min: 100, max: 400, onResize, onCommit,
  })));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
});

async function startDrag(): Promise<void> {
  await act(async () => container.querySelector("[role=separator]")!.dispatchEvent(
    new MouseEvent("pointerdown", { bubbles: true, clientX: 100 }),
  ));
  await act(async () => window.dispatchEvent(new MouseEvent("pointermove", { clientX: 140 })));
  expect(onResize).toHaveBeenLastCalledWith(240);
  expect(document.body.style.cursor).toBe("col-resize");
  expect(document.body.style.userSelect).toBe("none");
}

describe("pane drag lifetime", () => {
  it.each(["pointerup", "pointercancel", "blur"])("finishes once on %s and removes all drag listeners", async (event) => {
    document.body.style.cursor = "crosshair";
    document.body.style.userSelect = "text";
    await startDrag();
    await act(async () => window.dispatchEvent(new Event(event)));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(240);
    expect(document.body.style.cursor).toBe("crosshair");
    expect(document.body.style.userSelect).toBe("text");
    onResize.mockClear();
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 180 }));
      window.dispatchEvent(new Event("pointerup"));
      window.dispatchEvent(new Event("pointercancel"));
      window.dispatchEvent(new Event("blur"));
    });
    expect(onResize).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("cleans up an active drag when unmounted", async () => {
    await startDrag();
    await act(async () => root?.unmount());
    root = null;
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(240);
    onResize.mockClear();
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 180 }));
      window.dispatchEvent(new Event("pointerup"));
      window.dispatchEvent(new Event("pointercancel"));
      window.dispatchEvent(new Event("blur"));
    });
    expect(onResize).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
