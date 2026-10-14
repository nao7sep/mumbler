// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pipelineCompletionNotification, PersistentNotifications, ToastNotifications } from "@renderer/app/Notifications";
import { ShortenedValue, splitPath } from "@renderer/app/ShortenedValue";
import { createRendererTranslator } from "@renderer/i18n/I18nContext";
import type { MumblerCard } from "@shared/app-shell";
import { fewNames, message, nameValue, pathValue } from "@shared/i18n/translate";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function render(element: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

describe("splitPath", () => {
  it.each([
    ["/Users/me/Documents/Mumbler/take.m4a", "/Users/me/Documents/Mumbler/", "take.m4a"],
    ["C:\\Users\\me\\Mumbler\\take.m4a", "C:\\Users\\me\\Mumbler\\", "take.m4a"],
    ["/Users/me/Mumbler/", "/Users/me/", "Mumbler/"],
    ["take.m4a", "", "take.m4a"],
  ])("keeps the final segment of %s", (path, head, tail) => {
    expect(splitPath(path)).toEqual({ head, tail });
  });
});

describe("ShortenedValue", () => {
  it("shows a name whole in its text and tooltip", async () => {
    const container = await render(<ShortenedValue kind="name" value="take.m4a" />);
    const value = container.querySelector(".shortened")!;
    expect(value.textContent).toBe("take.m4a");
    expect(value.getAttribute("title")).toBe("take.m4a");
    expect(value.getAttribute("role"), "nothing to operate").toBeNull();
  });

  it("keeps a path's folders and final segment apart, so the folders give way first", async () => {
    const container = await render(<ShortenedValue kind="path" value="/Users/me/Mumbler/take.m4a" />);
    expect(container.querySelector(".shortened__head")?.textContent).toBe("/Users/me/Mumbler/");
    expect(container.querySelector(".shortened__tail")?.textContent).toBe("take.m4a");
    expect(container.textContent, "the element's text is the whole path").toBe("/Users/me/Mumbler/take.m4a");
  });
});

describe("messages on compact surfaces", () => {
  const english = createRendererTranslator("en");

  it("carries names and paths whole in plain text", () => {
    expect(english.text(message("notice.saved", { path: pathValue("/out/take.m4a") }))).toBe("Saved to /out/take.m4a");
  });

  it("names a few values and counts the rest", () => {
    expect(english.text(message("import.repeated", { files: fewNames(["a", "b", "c"].map(nameValue)) })))
      .toBe("Repeated in this import: a, b, c.");
    expect(english.text(message("import.repeated", { files: fewNames(["a", "b", "c", "d", "e"].map(nameValue)) })))
      .toBe("Repeated in this import: a, b, c and 2 more.");
  });

  it("renders each name and path in a message as a shortened value, in its place in the sentence", async () => {
    const container = await render(
      <p>{english.node(message("import.repeated", { files: fewNames(["/x/a.m4a", "/x/b.m4a", "/x/c.m4a", "/x/d.m4a"].map(pathValue)) }))}</p>,
    );
    expect(container.textContent).toBe("Repeated in this import: /x/a.m4a, /x/b.m4a, /x/c.m4a and 1 more.");
    expect([...container.querySelectorAll(".shortened")].map((value) => value.textContent)).toEqual(["/x/a.m4a", "/x/b.m4a", "/x/c.m4a"]);
  });

  it("shortens the file in a Ready to save toast", async () => {
    const card = { originalFilename: "a-very-long-recording-name.m4a", status: "Ready to Save" } as MumblerCard;
    const toast = pipelineCompletionNotification({ ...card, status: "Generating Metadata" }, card)!;
    const container = await render(<ToastNotifications notifications={[{ id: "t", ...toast }]} onDismiss={vi.fn()} />);
    expect(container.querySelector(".shortened")?.textContent).toBe("a-very-long-recording-name.m4a");
    expect(container.querySelector(".toast")?.textContent).toBe("Ready to save: a-very-long-recording-name.m4a");
  });

  it("shortens a folder in a persistent notice", async () => {
    const container = await render(
      <PersistentNotifications
        notifications={[{
          id: "n", owner: "o", kind: "persistent", variant: "warning",
          message: message("notice.saveCleanupFailed", { folder: pathValue("/Users/me/Documents/Mumbler") }),
        }]}
        onDismiss={vi.fn()}
      />,
    );
    expect(container.querySelector(".shortened__tail")?.textContent).toBe("Mumbler");
    expect(container.querySelector(".persistent-notice__message")?.textContent).toBe(
      "The recording was saved, but some temporary files could not be removed. Check /Users/me/Documents/Mumbler.",
    );
  });
});
