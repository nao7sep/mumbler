// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShortcutsHelpModal } from "@renderer/app/ShortcutsHelpModal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("ShortcutsHelpModal catalogue", () => {
  it("lists both bindings for skip-backward/skip-forward, tightly joined", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(React.createElement(ShortcutsHelpModal, { onClose: vi.fn() })));

    const kbds = Array.from(document.querySelectorAll("kbd")).map((el) => el.textContent);
    expect(kbds).toContain("Left/J");
    expect(kbds).toContain("Right/L");
  });
});
