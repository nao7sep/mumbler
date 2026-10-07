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
const confirmPendingImports = vi.fn();
const getPathForFile = vi.fn((file: File) => `/fixtures/${file.name}`);

beforeEach(() => {
  Object.defineProperty(window, "mumbler", {
    configurable: true,
    value: { importDroppedPaths, openImportDialog, confirmPendingImports, getPathForFile, onFlushPendingEdits: () => () => undefined },
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
    React.createElement("button", {
      type: "button",
      onClick: () => void flow.handleConfirmPendingImports(),
      children: "Confirm",
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
  confirmPendingImports.mockReset();
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
        onFlushPendingEdits: () => () => undefined,
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

describe("useImportFlow at quit", () => {
  const pendingImport = {
    id: "pending-1",
    originalFilename: "take.wav",
    localTimestampText: "2026-03-01 07:30:00",
    timezone: "Asia/Tokyo",
  };
  const snapshot = { state: { pendingImports: [pendingImport] } } as unknown as Parameters<
    typeof useImportFlow
  >[0]["snapshot"];

  function EditHarness(): ReactElement {
    const flow = useImportFlow({ snapshot, onSnapshotUpdate: vi.fn(), onError: vi.fn() });
    return React.createElement("button", {
      type: "button",
      onClick: () => flow.setPendingReviewDrafts((drafts) => drafts.map((draft) => ({ ...draft, timezone: "Europe/Berlin" }))),
    }, "Edit");
  }

  async function mount(): Promise<{ edit: () => Promise<void>; flush: () => Promise<void>; sent: ReturnType<typeof vi.fn> }> {
    const sent = vi.fn().mockResolvedValue({});
    let flush: (() => Promise<void>) | null = null;
    Object.defineProperty(window, "mumbler", {
      configurable: true,
      value: {
        updatePendingImportDrafts: sent,
        onFlushPendingEdits: (registered: () => Promise<void>) => {
          flush = registered;
          return () => { flush = null; };
        },
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(React.createElement(EditHarness)));
    await act(async () => vi.advanceTimersByTime(250));
    sent.mockClear();
    return {
      edit: () => act(async () => container.querySelector("button")?.click()),
      flush: () => act(async () => flush!()),
      sent,
    };
  }

  it("sends a review edit still in its debounce at once, and only once", async () => {
    vi.useFakeTimers();
    const { edit, flush, sent } = await mount();

    await edit();
    await act(async () => vi.advanceTimersByTime(100));
    expect(sent).not.toHaveBeenCalled();
    await flush();

    expect(sent).toHaveBeenCalledOnce();
    expect(sent.mock.calls[0]![0]).toEqual([expect.objectContaining({ id: "pending-1", timezone: "Europe/Berlin" })]);
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(sent, "the debounce no longer sends it again").toHaveBeenCalledOnce();
  });

  it("rejects a failed quit flush and retains the draft for Retry", async () => {
    vi.useFakeTimers();
    const { edit, flush, sent } = await mount();
    const failure = new Error("review write failed");
    sent.mockRejectedValueOnce(failure);
    await edit();
    await expect(flush()).rejects.toBe(failure);
    await flush();
    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls[1]![0]).toEqual([expect.objectContaining({ timezone: "Europe/Berlin" })]);
  });

  it("joins an already admitted debounce save before acknowledging quit", async () => {
    vi.useFakeTimers();
    const { edit, flush, sent } = await mount();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    sent.mockReturnValueOnce(gate);
    await edit();
    await act(async () => vi.advanceTimersByTime(250));
    let done = false;
    const flushing = flush().then(() => { done = true; });
    try {
      await Promise.resolve();
      expect(done).toBe(false);
      expect(sent).toHaveBeenCalledOnce();
      release();
      await flushing;
    } finally { release(); await flushing; }
  });

  it("sends nothing when no edit is waiting", async () => {
    vi.useFakeTimers();
    const { flush, sent } = await mount();

    await flush();

    expect(sent).not.toHaveBeenCalled();
  });
});

describe("useImportFlow confirming a review", () => {
  async function confirmWith(originalWarnings: unknown[]): Promise<HTMLElement> {
    confirmPendingImports.mockResolvedValue({ snapshot: {}, originalWarnings });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(React.createElement(Harness, { onError: vi.fn() })));
    const confirm = [...container.querySelectorAll("button")].find((button) => button.textContent === "Confirm");
    await act(async () => confirm?.click());
    return container;
  }

  it("keeps a warning for each original that was not backed up or deleted as asked", async () => {
    const container = await confirmWith([
      {
        sourcePath: "/rec/a.wav",
        message: message("import.backupFailedNotDeleted", { file: "/rec/a.wav", folder: "/backups" }),
      },
      { sourcePath: "/rec/b.wav", message: message("import.deleteFailed", { file: "/rec/b.wav" }) },
    ]);

    const result = container.querySelector("[data-result]");
    expect(result?.getAttribute("data-result")).toBe("warning");
    expect(result?.textContent).toContain(
      "/rec/a.wav was added to the queue, but it could not be copied to the backup folder /backups, so it was not deleted.",
    );
    expect(result?.textContent).toContain("/rec/b.wav was added to the queue, but it could not be deleted.");
  });

  it("shows nothing when every original was handled as asked", async () => {
    const container = await confirmWith([]);
    expect(container.querySelector("[data-result]")).toBeNull();
  });
});
