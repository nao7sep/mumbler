// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PersistentNotifications,
  ToastNotifications,
  pipelineCompletionNotification,
  type AppNotification,
} from "@renderer/app/Notifications";
import type { MumblerCard } from "@shared/app-shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

async function render(element: React.ReactNode): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
}

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
});

const notifications: AppNotification[] = [
  { id: "error-1", message: "First failure", kind: "persistent", variant: "error" },
  { id: "error-2", message: "Second failure", kind: "persistent", variant: "error" },
  { id: "info", message: "Recovered recording", kind: "persistent", variant: "info" },
  { id: "toast", message: "Recording duplicated", kind: "toast" },
];

function card(status: MumblerCard["status"]): MumblerCard {
  return {
    id: "card-1",
    originalFilename: "recording.wav",
    status,
    lastError: status === "Error"
      ? { message: "Transcription failed", occurredAtUtc: 0, stage: "transcribe" }
      : null,
  } as MumblerCard;
}

describe("notification lifetime and severity surfaces", () => {
  it("routes pipeline success transiently and leaves pipeline failure on the card", () => {
    expect(pipelineCompletionNotification(card("Ready to Save"))).toEqual({
      message: "Ready to save: recording.wav",
      kind: "toast",
    });
    expect(pipelineCompletionNotification(card("Error"))).toBeNull();
  });

  it("stacks persistent results independently from the transient success", async () => {
    await render(React.createElement(
      React.Fragment,
      null,
      React.createElement(PersistentNotifications, { notifications, onDismiss: vi.fn() }),
      React.createElement(ToastNotifications, { notifications, onDismiss: vi.fn() }),
    ));

    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(2);
    expect(Array.from(document.querySelectorAll(".persistent-notice__severity")))
      .toHaveLength(0);
    const statuses = Array.from(document.querySelectorAll<HTMLElement>('[role="status"]'));
    expect(statuses.some((status) => status.textContent === "Recovered recording")).toBe(true);
    expect(statuses.some((status) => status.textContent === "Recording duplicated")).toBe(true);
  });

  it("dismisses only the chosen persistent result", async () => {
    const onDismiss = vi.fn();
    await render(React.createElement(PersistentNotifications, { notifications, onDismiss }));

    const buttons = document.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Close notification"]',
    );
    await act(async () => buttons[1]!.click());
    expect(onDismiss).toHaveBeenCalledWith("error-2");
  });
});
