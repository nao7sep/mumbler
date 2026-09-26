/// <reference path="../../../src/renderer/src/vite-env.d.ts" />
// @vitest-environment jsdom
import React, { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useImportFlow } from "@renderer/app/useImportFlow";
import { createTranslator, message, type Message } from "@shared/i18n/translate";

const english = createTranslator("en");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const importDroppedPaths = vi.fn();
const openImportDialog = vi.fn();
const getPathForFile = vi.fn((file: File) => `/fixtures/${file.name}`);

beforeEach(() => {
  Object.defineProperty(window, "mumbler", {
    configurable: true,
    value: { importDroppedPaths, openImportDialog, getPathForFile },
  });
});

function Harness({ onError }: { onError: (owner: string, message: Message) => void }): ReactElement {
  const flow = useImportFlow({
    snapshot: null,
    onSnapshotUpdate: vi.fn(),
    onError,
  });
  return React.createElement(
    "main",
    {
      "data-active": flow.isDragActive ? "yes" : "no",
      onDragOver: flow.onDragOver,
      onDragLeave: flow.onDragLeave,
      onDrop: flow.onDrop,
    },
    React.createElement("textarea", { "aria-label": "Editor" }),
    React.createElement("button", {
      type: "button",
      onClick: () => void flow.handleImportClick(),
      children: "Import",
    }),
    flow.importResult
      ? React.createElement("p", {
          "data-result": flow.importResult.severity,
          children: english.text(flow.importResult.message),
        })
      : null,
  );
}

function dragEvent(
  type: string,
  offeredTypes: string[],
  items: Array<{ kind: string; getAsFile?: () => File | null }> = [],
  files: File[] = [],
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: offeredTypes, items, files, dropEffect: "none" },
  });
  return event;
}

afterEach(async () => {
  vi.useRealTimers();
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
  importDroppedPaths.mockReset();
  openImportDialog.mockReset();
  getPathForFile.mockClear();
  delete (window as unknown as { mumbler?: unknown }).mumbler;
});

describe("useImportFlow drag acceptance", () => {
  it("blocks browser defaults for text drags without accepting or importing them", async () => {
    const onError = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(React.createElement(Harness, { onError })));

    const target = container.querySelector("main");
    const over = dragEvent("dragover", ["text/plain"]);
    await act(async () => target?.dispatchEvent(over));
    expect(over.defaultPrevented).toBe(true);
    expect(
      (over as Event & { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect,
    ).toBe("none");
    expect(target?.getAttribute("data-active")).toBe("no");

    const drop = dragEvent("drop", ["text/plain"]);
    await act(async () => target?.dispatchEvent(drop));
    expect(drop.defaultPrevented).toBe(true);
    expect(importDroppedPaths).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("retains ordinary text drops in an editing control", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(React.createElement(Harness, { onError: vi.fn() })));

    const editor = container.querySelector("textarea");
    const over = dragEvent("dragover", ["text/plain"]);
    await act(async () => editor?.dispatchEvent(over));
    expect(over.defaultPrevented).toBe(false);
  });

  it("keeps a protected Files offer deliverable until drop", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(React.createElement(Harness, { onError: vi.fn() })),
    );

    const target = container.querySelector("main");
    const over = dragEvent("dragover", ["Files"]);
    await act(async () => target?.dispatchEvent(over));
    expect(over.defaultPrevented).toBe(true);
    expect(
      (over as Event & { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect,
    ).toBe("copy");
    expect(target?.getAttribute("data-active")).toBe("yes");
  });

  it("clears an inspectable file-drag affordance when the Queue is left", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(React.createElement(Harness, { onError: vi.fn() })),
    );

    const target = container.querySelector("main");
    const over = dragEvent("dragover", ["Files"], [
      { kind: "file", getAsFile: () => new File(["audio"], "sample.wav") },
    ]);
    await act(async () => target?.dispatchEvent(over));
    expect(over.defaultPrevented).toBe(true);
    expect(target?.getAttribute("data-active")).toBe("yes");

    await act(async () => target?.dispatchEvent(dragEvent("dragleave", ["Files"])));
    expect(target?.getAttribute("data-active")).toBe("no");
  });

  it("summarizes a partial committed drop once beside Queue", async () => {
    importDroppedPaths.mockResolvedValue({
      snapshot: {},
      attemptedPaths: ["/fixtures/sample.wav", "/fixtures/notes.txt"],
      importedCount: 1,
      failedImports: [{ sourcePath: "/fixtures/notes.txt", message: message("import.unsupportedType"), kind: "invalid" }],
      duplicateImports: [],
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(React.createElement(Harness, { onError: vi.fn() })));

    const target = container.querySelector("main");
    const audio = new File(["audio"], "sample.wav");
    const text = new File(["text"], "notes.txt");
    const drop = dragEvent("drop", ["Files"], [], [audio, text]);
    await act(async () => {
      target?.dispatchEvent(drop);
      await Promise.resolve();
    });

    expect(importDroppedPaths).toHaveBeenCalledWith([
      "/fixtures/sample.wav",
      "/fixtures/notes.txt",
    ]);
    expect(container.querySelector('[data-result="warning"]')?.textContent).toContain(
      "Imported 1 file. 1 item could not be imported.",
    );
  });

  it("keeps an unresolved import result after a later full success", async () => {
    importDroppedPaths
      .mockResolvedValueOnce({
        snapshot: {},
        attemptedPaths: ["/fixtures/notes.txt"],
        importedCount: 0,
        failedImports: [{ sourcePath: "/fixtures/notes.txt", message: message("import.unsupportedType"), kind: "invalid" }],
        duplicateImports: [],
      })
      .mockResolvedValueOnce({
        snapshot: {},
        attemptedPaths: ["/fixtures/sample.wav", "/fixtures/also-ready.wav"],
        importedCount: 2,
        failedImports: [],
        duplicateImports: [],
      });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(React.createElement(Harness, { onError: vi.fn() })));

    const target = container.querySelector("main");
    await act(async () => {
      target?.dispatchEvent(dragEvent("drop", ["Files"], [], [new File(["text"], "notes.txt")]));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-result="warning"]')).not.toBeNull();

    await act(async () => {
      target?.dispatchEvent(dragEvent("drop", ["Files"], [], [new File(["audio"], "sample.wav")]));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-result="warning"]')?.textContent).toContain("notes.txt");
  });

  it("clears an unresolved result after the exact failed source succeeds", async () => {
    importDroppedPaths
      .mockResolvedValueOnce({
        snapshot: {},
        attemptedPaths: ["/fixtures/sample.wav"],
        importedCount: 0,
        failedImports: [{ sourcePath: "/fixtures/sample.wav", message: message("import.failed"), kind: "failure" }],
        duplicateImports: [],
      })
      .mockResolvedValueOnce({
        snapshot: {},
        attemptedPaths: ["/fixtures/sample.wav"],
        importedCount: 1,
        failedImports: [],
        duplicateImports: [],
      });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(React.createElement(Harness, { onError: vi.fn() })));
    const target = container.querySelector("main");

    await act(async () => {
      target?.dispatchEvent(dragEvent("drop", ["Files"], [], [new File(["audio"], "sample.wav")]));
      await Promise.resolve();
    });
    await act(async () => {
      target?.dispatchEvent(dragEvent("drop", ["Files"], [], [
        new File(["audio"], "sample.wav"),
        new File(["audio"], "also-ready.wav"),
      ]));
      await Promise.resolve();
    });

    expect(container.querySelector("[data-result]")).toBeNull();
  });

  it("accounts for unavailable members of a mixed committed drop", async () => {
    getPathForFile
      .mockImplementationOnce(() => "/fixtures/sample.wav")
      .mockImplementationOnce(() => { throw new Error("path unavailable"); });
    importDroppedPaths.mockResolvedValue({
      snapshot: {},
      attemptedPaths: ["/fixtures/sample.wav"],
      importedCount: 1,
      failedImports: [],
      duplicateImports: [],
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(React.createElement(Harness, { onError: vi.fn() })));

    await act(async () => {
      container.querySelector("main")?.dispatchEvent(dragEvent("drop", ["Files"], [], [
        new File(["audio"], "sample.wav"),
        new File(["audio"], "unavailable.wav"),
      ]));
      await Promise.resolve();
    });

    expect(importDroppedPaths).toHaveBeenCalledWith(["/fixtures/sample.wav"]);
    expect(container.querySelector('[data-result="warning"]')?.textContent).toContain(
      "unavailable.wav: The local file path could not be read.",
    );
  });

  it("presents duplicate members as neutral information", async () => {
    importDroppedPaths.mockResolvedValue({
      snapshot: {},
      attemptedPaths: ["/fixtures/sample.wav", "/fixtures/sample.wav"],
      importedCount: 1,
      failedImports: [],
      duplicateImports: ["/fixtures/sample.wav"],
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(React.createElement(Harness, { onError: vi.fn() })));

    await act(async () => {
      container.querySelector("main")?.dispatchEvent(dragEvent("drop", ["Files"], [], [
        new File(["audio"], "sample.wav"),
        new File(["audio"], "sample.wav"),
      ]));
      await Promise.resolve();
    });

    expect(importDroppedPaths).toHaveBeenCalledWith([
      "/fixtures/sample.wav",
      "/fixtures/sample.wav",
    ]);
    expect(container.querySelector('[data-result="information"]')?.textContent).toContain(
      "Repeated in this import: /fixtures/sample.wav",
    );
  });

  it("uses the same committed-result presentation for the Import action", async () => {
    openImportDialog.mockResolvedValue({
      snapshot: {},
      attemptedPaths: ["/fixtures/notes.txt"],
      importedCount: 0,
      failedImports: [{ sourcePath: "/fixtures/notes.txt", message: message("import.unsupportedType"), kind: "invalid" }],
      duplicateImports: [],
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(React.createElement(Harness, { onError: vi.fn() })));

    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-result="warning"]')?.textContent).toContain(
      "/fixtures/notes.txt: Unsupported audio file type.",
    );
  });

  it("explains a committed non-file drop on Queue", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(React.createElement(Harness, { onError: vi.fn() })));

    const target = container.querySelector("main");
    await act(async () => target?.dispatchEvent(dragEvent("drop", ["text/plain"])));

    expect(container.querySelector('[data-result="warning"]')?.textContent).toContain(
      "Queue accepts local audio files",
    );
    expect(importDroppedPaths).not.toHaveBeenCalled();
  });

  it("presents an operational import failure as an error", async () => {
    importDroppedPaths.mockResolvedValue({
      snapshot: {},
      attemptedPaths: ["/fixtures/sample.wav"],
      importedCount: 0,
      failedImports: [{ sourcePath: "/fixtures/sample.wav", message: message("import.failed"), kind: "failure" }],
      duplicateImports: [],
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(React.createElement(Harness, { onError: vi.fn() })));

    const target = container.querySelector("main");
    await act(async () => {
      target?.dispatchEvent(dragEvent("drop", ["Files"], [], [new File(["audio"], "sample.wav")]));
      await Promise.resolve();
    });

    expect(container.querySelector('[data-result="error"]')?.textContent).toContain("Mumbler could not import this file.");
  });
});

describe("useImportFlow review cancel", () => {
  const pendingImport = {
    id: "pending-1",
    originalFilename: "take.wav",
    importSource: "drag-drop",
    originalSourcePath: "/fixtures/take.wav",
    workingFilePath: "/working/take.wav",
    fileSizeBytes: 5,
    localTimestampText: "2026-03-01 07:30:00",
    timezone: "Asia/Tokyo",
    utcTimestampText: "",
    parseStatus: "parsed",
    deleteOriginalOnConfirm: false,
    copyToBackupOnConfirm: true,
    createdAtUtc: 1,
    updatedAtUtc: 1,
  };

  // One snapshot object, as the window holds it until the next update arrives.
  const snapshot = { state: { pendingImports: [pendingImport] } } as unknown as Parameters<
    typeof useImportFlow
  >[0]["snapshot"];

  function ReviewHarness({ onError }: { onError: (owner: string, message: Message) => void }): ReactElement {
    const flow = useImportFlow({
      snapshot,
      onSnapshotUpdate: vi.fn(),
      onError,
    });
    return React.createElement(
      "button",
      {
        type: "button",
        "data-drafts": String(flow.pendingReviewDrafts.length),
        onClick: () => void flow.handleCancelPendingImports(),
      },
      "Cancel",
    );
  }

  it("keeps the review open when the cancel fails, as its message says", async () => {
    const cancelPendingImports = vi.fn().mockRejectedValue(new Error("disk full"));
    Object.defineProperty(window, "mumbler", {
      configurable: true,
      value: {
        cancelPendingImports,
        updatePendingImportDrafts: vi.fn().mockResolvedValue({}),
        reportRendererDiagnostic: vi.fn().mockResolvedValue(undefined),
      },
    });
    const onError = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(React.createElement(ReviewHarness, { onError })));
    const button = container.querySelector("button");
    expect(button?.dataset.drafts).toBe("1");

    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(cancelPendingImports).toHaveBeenCalledWith(["pending-1"]);
    expect(onError).toHaveBeenCalledWith("import-review-cancel", message("error.reviewCancel"));
    expect(english.text(message("error.reviewCancel"))).toContain("The review remains open");
    expect(button?.dataset.drafts, "the review is still shown").toBe("1");
  });
});
