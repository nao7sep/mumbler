/// <reference path="../../../src/renderer/src/vite-env.d.ts" />
// @vitest-environment jsdom
import React, { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useImportFlow } from "@renderer/app/useImportFlow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const importDroppedPaths = vi.fn();

beforeEach(() => {
  Object.defineProperty(window, "mumbler", {
    configurable: true,
    value: { importDroppedPaths },
  });
});

function Harness({ onError }: { onError: (message: string | null) => void }): ReactElement {
  const flow = useImportFlow({
    snapshot: null,
    onSnapshotUpdate: vi.fn(),
    onError,
    onPersistentNotice: vi.fn(),
  });
  return React.createElement("main", {
    "data-active": flow.isDragActive ? "yes" : "no",
    onDragOver: flow.onDragOver,
    onDragLeave: flow.onDragLeave,
    onDrop: flow.onDrop,
  });
}

function dragEvent(type: string, offeredTypes: string[], items: Array<{ kind: string }> = []): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: offeredTypes, items, files: [], dropEffect: "none" },
  });
  return event;
}

afterEach(async () => {
  vi.useRealTimers();
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
  importDroppedPaths.mockReset();
  delete (window as unknown as { mumbler?: unknown }).mumbler;
});

describe("useImportFlow drag acceptance", () => {
  it("blocks browser defaults for text drags without accepting or importing them", async () => {
    const onError = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(React.createElement(Harness, { onError })));

    const target = container.querySelector("main");
    const over = dragEvent("dragover", ["text/plain"]);
    await act(async () => target?.dispatchEvent(over));
    expect(over.defaultPrevented).toBe(true);
    expect(
      (over as Event & { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect,
    ).toBe("none");
    expect(target?.getAttribute("data-active")).toBe("no");

    const drop = dragEvent("drop", ["text/plain"]);
    await act(async () => target?.dispatchEvent(drop));
    expect(drop.defaultPrevented).toBe(true);
    expect(importDroppedPaths).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps a protected Files offer delivery-only", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(React.createElement(Harness, { onError: vi.fn() })),
    );

    const target = container.querySelector("main");
    const over = dragEvent("dragover", ["Files"]);
    await act(async () => target?.dispatchEvent(over));
    expect(over.defaultPrevented).toBe(true);
    expect(
      (over as Event & { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect,
    ).toBe("none");
    expect(target?.getAttribute("data-active")).toBe("no");
  });

  it("clears an inspectable file-drag affordance when drag events stop", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(React.createElement(Harness, { onError: vi.fn() })),
    );

    const target = container.querySelector("main");
    const over = dragEvent("dragover", ["Files"], [{ kind: "file" }]);
    await act(async () => target?.dispatchEvent(over));
    expect(over.defaultPrevented).toBe(true);
    expect(target?.getAttribute("data-active")).toBe("yes");

    await act(async () => vi.advanceTimersByTime(1001));
    expect(target?.getAttribute("data-active")).toBe("no");
  });
});
