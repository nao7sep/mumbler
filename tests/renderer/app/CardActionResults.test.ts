// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CardActionResults } from "@renderer/app/CardActionResults";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
});

describe("CardActionResults", () => {
  it("shows only the selected card's independent failures", async () => {
    const onDismiss = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(CardActionResults, {
        cardId: "card-a",
        results: [
          { cardId: "card-a", operation: "save", message: "Save failed" },
          { cardId: "card-a", operation: "copy", message: "Copy failed" },
          { cardId: "card-b", operation: "save", message: "Other card failed" },
        ],
        onDismiss,
      }));
    });

    const alerts = Array.from(document.querySelectorAll<HTMLElement>('[role="alert"]'));
    expect(alerts).toHaveLength(2);
    expect(document.body.textContent).toContain("Save failed");
    expect(document.body.textContent).toContain("Copy failed");
    expect(document.body.textContent).not.toContain("Other card failed");

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Dismiss error"]')?.click();
    });
    expect(onDismiss).toHaveBeenCalledWith("save");
  });
});
