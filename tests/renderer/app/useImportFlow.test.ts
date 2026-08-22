/// <reference path="../../../src/renderer/src/vite-env.d.ts" />
// @vitest-environment jsdom
import React, { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, describe, expect, it, vi } from "vitest";

import { useImportFlow } from "@renderer/app/useImportFlow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

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

function dragEvent(type: string, offeredTypes: string[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: offeredTypes, items: [], files: [], dropEffect: "none" },
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
});

describe("useImportFlow drag acceptance", () => {
  it("ignores text drags without showing a file-import error", async () => {
    const onError = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(React.createElement(Harness, { onError })));

    const target = container.querySelector("main");
    const over = dragEvent("dragover", ["text/plain"]);
    await act(async () => target?.dispatchEvent(over));
    expect(over.defaultPrevented).toBe(false);
    expect(target?.getAttribute("data-active")).toBe("no");

    const drop = dragEvent("drop", ["text/plain"]);
    await act(async () => target?.dispatchEvent(drop));
    expect(drop.defaultPrevented).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it("clears a native file-drag affordance when drag events stop", async () => {
    vi.useFakeTimers();
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
    expect(target?.getAttribute("data-active")).toBe("yes");

    await act(async () => vi.advanceTimersByTime(1001));
    expect(target?.getAttribute("data-active")).toBe("no");
  });
});
