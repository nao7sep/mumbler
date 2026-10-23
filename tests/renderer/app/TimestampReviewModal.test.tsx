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
    timeCandidates: [],
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
        errorMessage: null,
        onDismissError: vi.fn(),
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
    await mountModal([makeItem({ timestampBasis: "utc" })]);

    await type(fields().local, "2026-03-01 09:00:00");

    expect(onChange).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: "pending-1",
        localTimestampText: "2026-03-01 09:00:00",
        utcTimestampText: "2026-03-01 00:00:00",
        timestampBasis: "local",
      }),
    );
  });

  it("keeps the local time in step when the UTC time is edited", async () => {
    await mountModal([makeItem()]);

    await type(fields().utc, "2026-03-01 00:00:00");

    expect(onChange).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ utcTimestampText: "2026-03-01 00:00:00", localTimestampText: "2026-03-01 09:00:00", timestampBasis: "utc" }),
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

  it("offers distinct repeated-hour instants and marks only the chosen instant", async () => {
    await mountModal([makeItem({
      timezone: "America/New_York", timestampBasis: "utc",
      localTimestampText: "2026-11-01 01:30:00", utcTimestampText: "2026-11-01 06:30:00",
      timeCandidates: [5, 6].map((hour) => ({ source: "embedded", utcMs: Date.UTC(2026, 10, 1, hour, 30), localText: null })),
    })]);
    const choices = [...document.querySelectorAll<HTMLButtonElement>(".review-row__times button")];
    expect(choices).toHaveLength(2);
    expect(choices[0]!.textContent).toContain("05:30:00 UTC");
    expect(choices[1]!.textContent).toContain("06:30:00 UTC");
    expect(choices.map((choice) => choice.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    await act(async () => choices[0]!.click());
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ utcTimestampText: "2026-11-01 05:30:00", timestampBasis: "utc" }));
    await type(fields().timezone, "UTC");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ localTimestampText: "2026-11-01 06:30:00", utcTimestampText: "2026-11-01 06:30:00" }));
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

  it("freezes every editable review control while submitting, including original-file choices", async () => {
    await mountModal([makeItem()], { isSubmitting: true });

    expect([...document.querySelectorAll("input, select")].every((field) => (field as HTMLInputElement).disabled)).toBe(true);
    expect(button("Apply to All").disabled).toBe(true);
    await act(async () => button("Apply to All").click());
    await act(async () => checkbox("Add to Recordings").click());
    await act(async () => checkbox("Delete the originals once they are in Recordings").click());
    expect(onApplyTimezoneToAll).not.toHaveBeenCalled();
    expect(onSetCopyToBackupForAll).not.toHaveBeenCalled();
    expect(onSetDeleteOriginalForAll).not.toHaveBeenCalled();
  });

  it("cancels the whole review", async () => {
    await mountModal([makeItem()]);

    await act(async () => button("Cancel").click());

    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("what happens to the user's own files", () => {
  it("offers adding to Recordings and deleting the originals for the batch, and names where recordings go", async () => {
    await mountModal([makeItem(), makeItem({ id: "pending-2" })], { backupDirectoryLabel: "/Volumes/Archive" });

    expect(checkbox("Add to Recordings").checked).toBe(false);
    expect(checkbox("Delete the originals once they are in Recordings").checked).toBe(false);
    expect(document.body.textContent).toContain("/Volumes/Archive");
    expect(document.body.textContent, "the order of the two is stated").toContain(
      "If the copy fails, the original is kept.",
    );
  });

  it("turns each option on for every recording at once", async () => {
    await mountModal([makeItem(), makeItem({ id: "pending-2" })]);

    await toggle(checkbox("Add to Recordings"), true);
    await toggle(checkbox("Delete the originals once they are in Recordings"), true);

    expect(onSetCopyToBackupForAll).toHaveBeenCalledExactlyOnceWith(true);
    expect(onSetDeleteOriginalForAll).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("shows an option as on only when it holds for every recording", async () => {
    await mountModal([
      makeItem({ copyToBackupOnConfirm: true }),
      makeItem({ id: "pending-2", copyToBackupOnConfirm: false }),
    ]);

    expect(checkbox("Add to Recordings").checked, "one of two is not the batch").toBe(false);

    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.append(container);
    await mountModal([makeItem({ copyToBackupOnConfirm: true }), makeItem({ id: "pending-2", copyToBackupOnConfirm: true })]);

    expect(checkbox("Add to Recordings").checked).toBe(true);
  });
});

describe("settling a recording's time", () => {
  it("lets the recording be heard from its working copy", async () => {
    await mountModal([makeItem({ id: "pending/1" })]);
    const player = document.querySelector<HTMLAudioElement>(".review-row audio")!;
    expect(player.getAttribute("src")).toBe("mumbler-asset://media/pending%2F1");
    expect(player.getAttribute("preload"), "nothing loads until played").toBe("none");
    expect(player.getAttribute("aria-label")).toContain("Listen to");
  });

  it("offers each distinct time once, in the item's zone, naming every source that found it", async () => {
    await mountModal([makeItem({
      localTimestampText: "2026-10-14 15:30:12",
      timezone: "Asia/Tokyo",
      timeCandidates: [
        { source: "file-name", utcMs: null, localText: "2026-10-14 15:30:12" },
        { source: "embedded", utcMs: Date.UTC(2026, 9, 14, 6, 30, 12), localText: null },
        { source: "file-created", utcMs: Date.UTC(2026, 9, 15, 1, 15, 0), localText: null },
        { source: "file-modified", utcMs: Date.UTC(2026, 9, 15, 1, 15, 0), localText: null },
      ],
    })]);

    const choices = [...document.querySelectorAll<HTMLButtonElement>(".review-row__times button")];
    expect(choices.map((choice) => choice.textContent)).toEqual([
      "Name, In file: 2026-10-14 15:30:12",
      "Created, Modified: 2026-10-15 10:15:00",
    ]);
    expect(choices.map((choice) => choice.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(document.querySelector(".review-row__times")?.getAttribute("aria-label")).toBe("Times found");
    expect(document.querySelector(".review-row__times")?.textContent, "no visible lead label").not.toContain("Times found");

    await act(async () => choices[1]!.click());
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      localTimestampText: "2026-10-15 10:15:00",
      utcTimestampText: "2026-10-15 01:15:00",
    }));
  });

  it("gives disagreeing sources a button each", async () => {
    await mountModal([makeItem({
      timezone: "Asia/Tokyo",
      timeCandidates: [
        { source: "file-name", utcMs: null, localText: "2026-10-14 15:30:12" },
        { source: "embedded", utcMs: null, localText: "2026-10-14 15:34:00" },
      ],
    })]);
    expect([...document.querySelectorAll(".review-row__times button")].map((choice) => choice.textContent)).toEqual([
      "Name: 2026-10-14 15:30:12",
      "In file: 2026-10-14 15:34:00",
    ]);
  });

  describe("the file-date caution", () => {
    const candidates = [
      { source: "file-name" as const, utcMs: null, localText: "2026-10-14 15:30:12" },
      { source: "file-modified" as const, utcMs: Date.UTC(2026, 9, 15, 1, 15, 0), localText: null },
    ];
    const caution = () => document.querySelector(".row-caution")?.textContent ?? null;

    it("shows only while a time the file dates alone gave is chosen", async () => {
      await mountModal([makeItem({ timezone: "Asia/Tokyo", localTimestampText: "2026-10-14 15:30:12", timeCandidates: candidates })]);
      expect(caution(), "the name's time is chosen").toBeNull();
      root?.unmount();
      await mountModal([makeItem({ timezone: "Asia/Tokyo", localTimestampText: "2026-10-15 10:15:00", timeCandidates: candidates })]);
      expect(caution()).toBe("File dates often change when a file is copied or synced. Make sure this time is right.");
      expect(button("Confirm").disabled, "the caution never blocks Confirm").toBe(false);
    });

    it("stays off for a file date the name agrees with, and shows for the same time typed by hand", async () => {
      const agreeing = [candidates[0]!, { source: "file-modified" as const, utcMs: Date.UTC(2026, 9, 14, 6, 30, 12), localText: null }];
      await mountModal([makeItem({ timezone: "Asia/Tokyo", localTimestampText: "2026-10-14 15:30:12", timeCandidates: agreeing })]);
      expect(caution(), "Name, Modified share a button").toBeNull();
      root?.unmount();
      await mountModal([makeItem({ timezone: "Asia/Tokyo", localTimestampText: "2026-10-15 10:15:00", utcTimestampText: "2026-10-15 01:15:00", timeCandidates: candidates })]);
      expect(caution()).not.toBeNull();
    });
  });

  it("says when no time was found, and shows no error for the empty time", async () => {
    await mountModal([makeItem({ timeCandidates: [], localTimestampText: "", utcTimestampText: "" })]);
    expect(document.querySelector(".review-row__times")).toBeNull();
    expect(document.body.textContent).toContain("No time found in this recording. Listen to it and enter one.");
    expect(document.querySelector(".row-error")).toBeNull();
    expect(button("Confirm").disabled, "an empty time still blocks Confirm").toBe(true);
  });

});
