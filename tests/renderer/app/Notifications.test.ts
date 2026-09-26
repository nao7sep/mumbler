// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PersistentNotifications,
  ToastNotifications,
  clearPersistentOwner,
  pipelineCompletionNotification,
  upsertPersistentNotification,
  type AppNotification,
} from "@renderer/app/Notifications";
import type { MumblerCard } from "@shared/app-shell";
import { createTranslator, message } from "@shared/i18n/translate";

const english = createTranslator("en");

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
  { id: "error-1", owner: "first", message: message("error.selectRecording"), kind: "persistent", variant: "error" },
  { id: "error-2", owner: "second", message: message("error.removeRecording"), kind: "persistent", variant: "error" },
  { id: "info", owner: "recovery", message: message("notice.recovered", { count: 1 }), kind: "persistent", variant: "info" },
  { id: "toast", message: message("notice.duplicated"), kind: "toast" },
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
  it("replaces a repeated persistent owner without clearing independent owners", () => {
    const next = upsertPersistentNotification(notifications, {
      id: "error-1-new",
      owner: "first",
      message: message("error.generate"),
      kind: "persistent",
      variant: "error",
    });

    expect(next.filter((notification) => notification.kind === "persistent"))
      .toHaveLength(3);
    expect(next.some((notification) => notification.id === "error-1")).toBe(false);
    expect(next.some((notification) => notification.id === "error-2")).toBe(true);
    expect(next.at(-1)).toMatchObject({
      id: "error-1-new",
      owner: "first",
      message: message("error.generate"),
    });
  });

  it("clears one persistent owner and leaves other owners and toasts", () => {
    const next = clearPersistentOwner(notifications, "first");

    expect(next.map((notification) => notification.id)).toEqual(["error-2", "info", "toast"]);
  });

  it("routes pipeline success transiently and leaves pipeline failure on the card", () => {
    const notice = pipelineCompletionNotification(card("Generating Metadata"), card("Ready to Save"));
    expect(notice?.kind).toBe("toast");
    expect(english.text(notice!.message)).toBe("Ready to save: recording.wav");
    expect(pipelineCompletionNotification(card("Transcribing"), card("Error"))).toBeNull();
  });

  it("stays quiet when a save hands its card back as ready to save", () => {
    expect(pipelineCompletionNotification(card("Saving"), card("Ready to Save"))).toBeNull();
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
    expect(statuses.some((status) => status.textContent === english.text(message("notice.recovered", { count: 1 })))).toBe(true);
    expect(statuses.some((status) => status.textContent === "Recording duplicated.")).toBe(true);
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
