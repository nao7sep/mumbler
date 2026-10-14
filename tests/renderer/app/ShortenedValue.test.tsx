// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImportResultBody } from "@renderer/app/ImportResult";
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

// jsdom lays nothing out, so every part fits unless a test says it is cut.
function cutEveryPart(): void {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
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
  it("is plain text, not a control, while the value fits", async () => {
    const container = await render(<ShortenedValue kind="name" value="take.m4a" />);
    const value = container.querySelector(".shortened")!;
    expect(value.getAttribute("role")).toBeNull();
    expect(value.getAttribute("tabindex")).toBeNull();
    expect(value.textContent).toBe("take.m4a");
  });

  it("keeps a path's folders and final segment apart, so the folders give way first", async () => {
    const container = await render(<ShortenedValue kind="path" value="/Users/me/Mumbler/take.m4a" />);
    expect(container.querySelector(".shortened__head")?.textContent).toBe("/Users/me/Mumbler/");
    expect(container.querySelector(".shortened__tail")?.textContent).toBe("take.m4a");
    expect(container.textContent, "the element's text is the whole path").toBe("/Users/me/Mumbler/take.m4a");
  });

  it("shows a cut value whole by click or keyboard, and shortens it again", async () => {
    cutEveryPart();
    const onOuterClick = vi.fn();
    const container = await render(
      <div onClick={onOuterClick}>
        <ShortenedValue kind="path" value="/Users/me/Mumbler/take.m4a" />
      </div>,
    );
    const value = container.querySelector<HTMLElement>(".shortened")!;
    expect(value.getAttribute("role")).toBe("button");
    expect(value.tabIndex).toBe(0);
    expect(value.getAttribute("aria-expanded")).toBe("false");

    await act(async () => value.click());
    expect(value.getAttribute("aria-expanded")).toBe("true");
    expect(value.classList.contains("shortened--whole")).toBe(true);
    expect(container.querySelector(".shortened__text")?.textContent).toBe("/Users/me/Mumbler/take.m4a");
    expect(onOuterClick, "revealing the value does not dismiss what holds it").not.toHaveBeenCalled();

    await act(async () => value.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(value.getAttribute("aria-expanded")).toBe("false");
    await act(async () => value.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })));
    expect(value.getAttribute("aria-expanded")).toBe("true");
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

  it("shortens the file in a Ready to save toast, and the click on its value does not dismiss it", async () => {
    cutEveryPart();
    const card = { originalFilename: "a-very-long-recording-name.m4a", status: "Ready to Save" } as MumblerCard;
    const toast = pipelineCompletionNotification({ ...card, status: "Generating Metadata" }, card)!;
    const onDismiss = vi.fn();
    const container = await render(<ToastNotifications notifications={[{ id: "t", ...toast }]} onDismiss={onDismiss} />);
    const value = container.querySelector<HTMLElement>(".shortened")!;
    expect(value.textContent).toBe("a-very-long-recording-name.m4a");
    await act(async () => value.click());
    expect(onDismiss).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLElement>(".toast")!.click());
    expect(onDismiss).toHaveBeenCalledWith("t");
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

describe("ImportResultBody", () => {
  it("reveals every detail beneath the summary on request", async () => {
    const container = await render(
      <ImportResultBody result={{
        severity: "warning",
        message: message("import.notImported", { files: fewNames(["/a", "/b", "/c", "/d"].map(pathValue)) }),
        details: ["/a", "/b", "/c", "/d"].map((file) => message("import.failureItem", { file, reason: message("import.unsupportedType") })),
        issueKeys: [],
      }} />,
    );
    const toggle = container.querySelector<HTMLButtonElement>("button")!;
    const list = container.querySelector("ul")!;
    expect(toggle.textContent).toBe("Show details");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(list.id);
    expect(list.hidden).toBe(true);

    await act(async () => toggle.click());
    expect(toggle.textContent).toBe("Hide details");
    expect(list.hidden).toBe(false);
    expect([...list.querySelectorAll("li")].map((item) => item.textContent)).toEqual(
      ["/a", "/b", "/c", "/d"].map((file) => `${file}: Unsupported audio file type.`),
    );
  });

  it("offers nothing to reveal when the summary says it all", async () => {
    const container = await render(
      <ImportResultBody result={{ severity: "information", message: message("import.imported", { count: 2 }), issueKeys: [] }} />,
    );
    expect(container.querySelector("button")).toBeNull();
  });
});
