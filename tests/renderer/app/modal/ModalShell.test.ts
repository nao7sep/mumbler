// @vitest-environment jsdom
import React, { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModalShell } from "@renderer/app/modal/ModalShell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function mountRoot(): Root {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  return root;
}

function modal(title: string, onRequestClose: () => void): ReactElement {
  const children = React.createElement(
    "div",
    { className: "modal-card__body" },
    React.createElement("button", { type: "button" }, `${title} action`),
  );

  return React.createElement(
    ModalShell,
    { title, onRequestClose, children },
  );
}

function findBackdrop(title: string): HTMLElement {
  const heading = Array.from(document.querySelectorAll("h2")).find(
    (element) => element.textContent === title,
  );
  const backdrop = heading?.closest(".modal-backdrop");
  if (!(backdrop instanceof HTMLElement)) {
    throw new Error(`Modal backdrop for ${title} was not found.`);
  }
  return backdrop;
}

afterEach(async () => {
  if (root !== null) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  document.body.innerHTML = "";
  document.body.style.overflow = "";
});

describe("ModalShell layering", () => {
  it("paints the newly opened topmost modal above older modals even when JSX order is earlier", async () => {
    const closeExisting = vi.fn();
    const closeNew = vi.fn();
    const appRoot = mountRoot();

    await act(async () => {
      appRoot.render(
        React.createElement(
          React.Fragment,
          null,
          null,
          modal("Existing Modal", closeExisting),
        ),
      );
    });

    await act(async () => {
      appRoot.render(
        React.createElement(
          React.Fragment,
          null,
          modal("New App-Wide Error", closeNew),
          modal("Existing Modal", closeExisting),
        ),
      );
    });

    const newBackdrop = findBackdrop("New App-Wide Error");
    const existingBackdrop = findBackdrop("Existing Modal");

    expect(Number(newBackdrop.style.zIndex)).toBeGreaterThan(
      Number(existingBackdrop.style.zIndex),
    );
    expect(newBackdrop.dataset.modalLayer).toBe("1");
    expect(existingBackdrop.dataset.modalLayer).toBe("0");
    expect(newBackdrop.contains(document.activeElement)).toBe(true);

    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    expect(closeNew).toHaveBeenCalledTimes(1);
    expect(closeExisting).not.toHaveBeenCalled();
  });
});
