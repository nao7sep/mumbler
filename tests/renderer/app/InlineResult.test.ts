// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InlineError } from "@renderer/app/InlineResult";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
});

describe("InlineError", () => {
  it("exposes an assertive result without redundant severity copy", async () => {
    const onDismiss = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(InlineError, { onDismiss, children: "Save failed" }));
    });

    const result = document.querySelector<HTMLElement>('[role="alert"]');
    expect(result?.textContent).toBe("Save failed");
    expect(result?.getAttribute("aria-atomic")).toBe("true");

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Close result"]')?.click();
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
