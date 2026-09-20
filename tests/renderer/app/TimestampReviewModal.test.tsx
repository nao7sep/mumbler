// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { PendingImportReviewItem } from "@shared/app-shell";
import { TimestampReviewModal } from "@renderer/app/TimestampReviewModal";

// The screen that decides when each recording was made — and whether the user's
// original files are backed up or deleted. The timestamp maths is shared code
// with its own tests; what is asserted here is what the screen does with it:
// the two clocks kept in step, a bad row blocking the import, and the two
// destructive options only ever applying to the whole batch.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeItem(overrides: Partial<PendingImportReviewItem> = {}): PendingImportReviewItem {
  return {
    id: "pending-1",
    originalFilename: "take.wav",
    importSource: "file-picker",
    originalSourcePath: "/sources/take.wav",
    workingFilePath: "/working/take.wav",
    fileSizeBytes: 1024,
    localTimestampText: "2026-03-01 07:30:00",
    timezone: "Asia/Tokyo",
    utcTimestampText: "2026-02-28 22:30:00",
    parseStatus: "parsed",
    deleteOriginalOnConfirm: false,
    copyToBackupOnConfirm: false,
    createdAtUtc: 1,
    updatedAtUtc: 1,
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement;
let onChange: Mock<(item: PendingImportReviewItem) => void>;
let onApplyTimezoneToAll: Mock<(timezone: string) => void>;
let onSetDeleteOriginalForAll: Mock<(value: boolean) => void>;
let onSetCopyToBackupForAll: Mock<(value: boolean) => void>;
let onConfirm: Mock<() => void>;
let onCancel: Mock<() => void>;

async function mountModal(
  items: PendingImportReviewItem[],
  options: { isSubmitting?: boolean; backupDirectoryLabel?: string } = {},
): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root?.render(
      React.createElement(TimestampReviewModal, {
        items,
        defaultTimezone: "Asia/Tokyo",
        backupDirectoryLabel: options.backupDirectoryLabel ?? "~/.mumbler/backups",
        onChange,
        onApplyTimezoneToAll,
        onSetDeleteOriginalForAll,
        onSetCopyToBackupForAll,
        onConfirm,
        onCancel,
        isSubmitting: options.isSubmitting ?? false,
      }),
    );
  });
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label);
  if (!match) throw new Error(`No button labelled ${label}`);
  return match as HTMLButtonElement;
}

function fields(row = 0): { local: HTMLInputElement; timezone: HTMLSelectElement; utc: HTMLInputElement } {
  const rows = [...document.querySelectorAll(".review-row")];
  const scope = rows[row];
  const inputs = [...scope.querySelectorAll("input")];
  return {
    local: inputs[0] as HTMLInputElement,
    timezone: scope.querySelector("select") as HTMLSelectElement,
    utc: inputs[1] as HTMLInputElement,
  };
}

function checkbox(label: string): HTMLInputElement {
  const match = [...document.querySelectorAll(".modal-checkbox")].find((entry) =>
    entry.textContent?.includes(label),
  );
  if (!match) throw new Error(`No checkbox labelled ${label}`);
  return match.querySelector("input") as HTMLInputElement;
}

/** Types into a field the way the user does, through React's own event. */
async function type(field: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  const prototype = field instanceof HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function toggle(field: HTMLInputElement, checked: boolean): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "checked")?.set?.call(field, checked);
    field.dispatchEvent(new Event("click", { bubbles: true }));
  });
}

beforeEach(() => {
  onChange = vi.fn();
  onApplyTimezoneToAll = vi.fn();
  onSetDeleteOriginalForAll = vi.fn();
  onSetCopyToBackupForAll = vi.fn();
  onConfirm = vi.fn();
  onCancel = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = "";
  document.body.style.overflow = "";
});

describe("reviewing what was imported", () => {
  it("lists each recording with the time it was read as", async () => {
    await mountModal([makeItem(), makeItem({ id: "pending-2", originalFilename: "second.m4a" })]);

    expect(document.body.textContent).toContain("take.wav");
    expect(document.body.textContent).toContain("second.m4a");
    expect(fields(0).local.value).toBe("2026-03-01 07:30:00");
    expect(fields(0).utc.value).toBe("2026-02-28 22:30:00");
  });

  it("keeps the UTC time in step when the local time is edited", async () => {
    await mountModal([makeItem()]);

    await type(fields().local, "2026-03-01 09:00:00");

    expect(onChange).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: "pending-1",
        localTimestampText: "2026-03-01 09:00:00",
        utcTimestampText: "2026-03-01 00:00:00",
      }),
    );
  });

  it("keeps the local time in step when the UTC time is edited", async () => {
    await mountModal([makeItem()]);

    await type(fields().utc, "2026-03-01 00:00:00");

    expect(onChange).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ utcTimestampText: "2026-03-01 00:00:00", localTimestampText: "2026-03-01 09:00:00" }),
    );
  });

  it("holds the keystrokes as typed while a half-finished time is unreadable", async () => {
    await mountModal([makeItem()]);

    await type(fields().utc, "2026-03-0");

    expect(onChange).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        utcTimestampText: "2026-03-0",
        localTimestampText: "2026-03-01 07:30:00",
      }),
    );
  });

  it("keeps the wall-clock time the user wrote when the zone changes, and moves the instant", async () => {
    await mountModal([makeItem()]);

    await type(fields().timezone, "Europe/Berlin");

    expect(onChange).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        timezone: "Europe/Berlin",
        localTimestampText: "2026-03-01 07:30:00",
        utcTimestampText: "2026-03-01 06:30:00",
      }),
    );
  });

  it("reads the local time from UTC when the local field is the unusable one", async () => {
    await mountModal([makeItem({ localTimestampText: "not a time" })]);

    await type(fields().timezone, "Europe/Berlin");

    expect(onChange).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ timezone: "Europe/Berlin", localTimestampText: "2026-02-28 23:30:00" }),
    );
  });

  it("applies one timezone to the whole batch", async () => {
    await mountModal([makeItem(), makeItem({ id: "pending-2" })]);
    const bulk = document.querySelector("select") as HTMLSelectElement;

    expect(button("Apply to All").disabled, "the default zone is offered ready to apply").toBe(false);
    await type(bulk, "Europe/Berlin");
    await act(async () => button("Apply to All").click());

    expect(onApplyTimezoneToAll).toHaveBeenCalledExactlyOnceWith("Europe/Berlin");
  });

  it("has nothing to apply until a zone is chosen", async () => {
    await mountModal([makeItem()]);
    const bulk = document.querySelector("select") as HTMLSelectElement;

    await type(bulk, "");

    expect(button("Apply to All").disabled).toBe(true);
  });
});

describe("what blocks the import", () => {
  it.each([
    ["an unreadable local time", { localTimestampText: "yesterday evening" }],
    ["an unreadable UTC time", { utcTimestampText: "soon" }],
    ["a timezone that is not one", { timezone: "Mars/Olympus" }],
  ])("refuses to confirm on %s, and says which row is wrong", async (_case, broken) => {
    await mountModal([makeItem(), makeItem({ id: "pending-2", originalFilename: "second.m4a", ...broken })]);

    expect(button("Confirm").disabled).toBe(true);
    expect(document.querySelectorAll(".row-error")).toHaveLength(1);

    await act(async () => button("Confirm").click());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirms when every row reads", async () => {
    await mountModal([makeItem(), makeItem({ id: "pending-2" })]);

    expect(document.querySelectorAll(".row-error")).toHaveLength(0);
    await act(async () => button("Confirm").click());

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("stops the user acting twice while the import is running", async () => {
    await mountModal([makeItem()], { isSubmitting: true });

    expect(button("Confirming…").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
  });

  it("cancels the whole review", async () => {
    await mountModal([makeItem()]);

    await act(async () => button("Cancel").click());

    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("what happens to the user's own files", () => {
  it("offers backup and deletion for the batch, unticked, and names where backups go", async () => {
    await mountModal([makeItem(), makeItem({ id: "pending-2" })], { backupDirectoryLabel: "/Volumes/Archive" });

    expect(checkbox("Copy originals to backup folder").checked).toBe(false);
    expect(checkbox("Permanently delete originals after import").checked).toBe(false);
    expect(document.body.textContent).toContain("/Volumes/Archive");
    expect(document.body.textContent, "the order of the two is stated").toContain(
      "A failed backup cancels the deletion for that file.",
    );
  });

  it("turns each option on for every recording at once", async () => {
    await mountModal([makeItem(), makeItem({ id: "pending-2" })]);

    await toggle(checkbox("Copy originals to backup folder"), true);
    await toggle(checkbox("Permanently delete originals after import"), true);

    expect(onSetCopyToBackupForAll).toHaveBeenCalledExactlyOnceWith(true);
    expect(onSetDeleteOriginalForAll).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("shows an option as on only when it holds for every recording", async () => {
    await mountModal([
      makeItem({ copyToBackupOnConfirm: true }),
      makeItem({ id: "pending-2", copyToBackupOnConfirm: false }),
    ]);

    expect(checkbox("Copy originals to backup folder").checked, "one of two is not the batch").toBe(false);

    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.append(container);
    await mountModal([makeItem({ copyToBackupOnConfirm: true }), makeItem({ id: "pending-2", copyToBackupOnConfirm: true })]);

    expect(checkbox("Copy originals to backup folder").checked).toBe(true);
  });
});
