// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppWideErrorModal } from "@renderer/app/DecisionModals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
});

describe("AppWideErrorModal", () => {
  it("uses a labelled Close action without a redundant Dismiss label", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(AppWideErrorModal, {
        title: "Mumbler could not continue",
        message: "Restart Mumbler to continue.",
        onDismiss: vi.fn(),
      }));
    });

    expect(document.querySelector('button')?.textContent).toBe("Close");
    expect(document.body.textContent).not.toContain("Dismiss");
  });
});
