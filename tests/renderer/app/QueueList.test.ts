// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QueueList } from "@renderer/app/QueueList";
import type { MumblerCard } from "@shared/app-shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function card(id: string, status: MumblerCard["status"]): MumblerCard {
  return {
    id,
    originalFilename: `${id}.wav`,
    status,
    durationSec: 12,
    timestamps: { effectiveLocal: "2026-09-02 12:00" },
    lastError: {
      message: status === "Error" ? "Pipeline failed" : "AI work cancelled by user.",
      occurredAtUtc: 0,
      failedStep: "transcription",
    },
  } as MumblerCard;
}

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
});

describe("QueueList card results", () => {
  it("makes terminal pipeline failure authoritative without treating cancellation as an error", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(QueueList, {
        cards: [card("failed", "Error"), card("cancelled", "Cancelled")],
        selectedCardId: "failed",
        onSelect: vi.fn(),
      }));
    });

    const alerts = document.querySelectorAll<HTMLElement>('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain("Error: Pipeline failed");
    expect(document.body.textContent).toContain("AI work cancelled by user.");
  });
});
