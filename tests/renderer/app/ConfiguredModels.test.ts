// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ConfiguredModels } from "@renderer/app/ConfiguredModels";
import type { SettingsSummary } from "@shared/app-shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
});

describe("ConfiguredModels", () => {
  it("shows the three configured model names as text, with no control to change them", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const summary = { transcriptionModel: "gemini-3.8-flash", outlineModel: "custom-outline", metadataModel: "gemini-3.5-flash-lite" } as SettingsSummary;

    await act(async () => root?.render(React.createElement(ConfiguredModels, { summary })));

    const pairs = Array.from(container.querySelectorAll("dl > div")).map((row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent]);
    expect(pairs).toEqual([
      ["Transcription Model", "gemini-3.8-flash"],
      ["Structured Transcription Model", "custom-outline"],
      ["Metadata Model", "gemini-3.5-flash-lite"],
    ]);
    expect(container.querySelector("select, input")).toBeNull();
  });
});
