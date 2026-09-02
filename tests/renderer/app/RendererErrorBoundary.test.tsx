// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RendererErrorBoundary } from "../../../src/renderer/src/app/RendererErrorBoundary";

const HOSTILE = "EACCES /Users/nao/.mumbler/quarantine/internal-state.json";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;

function Broken(): React.JSX.Element { throw new Error(HOSTILE); }

describe("RendererErrorBoundary", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(document.querySelector("#root")!);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
  });

  it("keeps a render diagnostic out of the authored recovery surface", () => {
    const reportRendererError = vi.fn().mockResolvedValue({});
    Object.defineProperty(window, "mumbler", { configurable: true, value: { reportRendererError } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    act(() => root.render(<RendererErrorBoundary><Broken /></RendererErrorBoundary>));

    const alert = document.querySelector<HTMLElement>('[role="alert"]');
    const reload = document.querySelector<HTMLButtonElement>("button");
    expect(alert?.textContent).toContain("Mumbler could not keep this window open.");
    expect(alert?.textContent).not.toContain(HOSTILE);
    expect(reload?.textContent).toBe("Reload window");
    expect(reload?.classList.contains("button")).toBe(true);
    expect(reload?.classList.contains("button--primary")).toBe(true);
    expect(reportRendererError).toHaveBeenCalledWith(expect.objectContaining({ message: HOSTILE }));
  });

  it("preserves a hostile cause chain in diagnostics only", () => {
    const reportRendererError = vi.fn().mockResolvedValue({});
    Object.defineProperty(window, "mumbler", { configurable: true, value: { reportRendererError } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cause = new TypeError("EACCES /private/tmp/MUMBLER-CAUSE-SENTINEL");

    function BrokenWithCause(): never {
      throw new Error("renderer wrapper", { cause });
    }
    act(() => root.render(<RendererErrorBoundary><BrokenWithCause /></RendererErrorBoundary>));

    expect(document.body.textContent).not.toContain("MUMBLER-CAUSE-SENTINEL");
    expect(reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: "renderer wrapper",
      cause: expect.objectContaining({ name: "TypeError", message: expect.stringContaining("MUMBLER-CAUSE-SENTINEL") }),
    }));
  });
});
