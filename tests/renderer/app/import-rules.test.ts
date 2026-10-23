import { describe, expect, it, vi } from "vitest";

import type { PendingImportReviewItem } from "@shared/app-shell";
import {
  isFileDrag,
  inspectFileDragOffer,
  parseDroppedPaths,
  reconcilePendingReviewDrafts,
  chooseRecordingTime,
  foundTimes,
} from "@renderer/app/import-rules";
import { message } from "@shared/i18n/translate";
import { changeReviewTimezone } from "@shared/review-timestamps";

const item = (id: string, overrides: Partial<PendingImportReviewItem> = {}): PendingImportReviewItem => ({
  id,
  originalFilename: `${id}.wav`,
  importSource: "file-picker",
  originalSourcePath: `/sources/${id}.wav`,
  workingFilePath: `/working/${id}.wav`,
  fileSizeBytes: 1,
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
});

describe("parseDroppedPaths", () => {
  it("preserves duplicate paths and accounts for inaccessible entries", () => {
    const onDiagnostic = vi.fn();
    const files = [{ name: "a" }, { name: "b" }, { name: "c" }] as unknown as File[];
    const paths = parseDroppedPaths(files, (file) => {
      const name = (file as { name: string }).name;
      if (name === "b") {
        throw new Error("Error invoking remote method 'getPathForFile': EACCES /private/tmp/MUMBLER_SENTINEL");
      }
      return "/abs/audio.wav";
    }, onDiagnostic);
    expect(paths).toEqual({
      paths: ["/abs/audio.wav", "/abs/audio.wav"],
      unavailable: [{
        sourcePath: "b",
        message: message("import.pathUnreadable"),
      }],
    });
    expect(JSON.stringify(paths)).not.toMatch(/EACCES|private\/tmp|MUMBLER_SENTINEL|invoking remote method/i);
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("MUMBLER_SENTINEL") }),
      "dropped file path resolution failed",
    );
  });

  it("returns an empty array when nothing resolves", () => {
    const files = [{ name: "a" }] as unknown as File[];
    expect(parseDroppedPaths(files, () => "")).toEqual({
      paths: [],
      unavailable: [{
        sourcePath: "a",
        message: message("import.noLocalPath"),
      }],
    });
  });
});

describe("isFileDrag", () => {
  it("accepts the native Files transfer type", () => {
    expect(isFileDrag({ types: ["Files"], items: [] as unknown as DataTransferItemList })).toBe(
      true,
    );
  });

  it("accepts an explicitly file-kind item", () => {
    expect(
      isFileDrag({
        types: [],
        items: [{ kind: "file" }] as unknown as DataTransferItemList,
      }),
    ).toBe(true);
  });

  it("rejects text and other non-file payloads", () => {
    expect(
      isFileDrag({
        types: ["text/plain"],
        items: [{ kind: "string" }] as unknown as DataTransferItemList,
      }),
    ).toBe(false);
  });
});

describe("inspectFileDragOffer", () => {
  it("keeps a protected Files marker delivery-only", () => {
    expect(
      inspectFileDragOffer({ types: ["Files"], items: [] as unknown as DataTransferItemList }),
    ).toBe("delivery-only");
  });

  it("keeps an inspectable file item delivery-only until its local path resolves", () => {
    expect(
      inspectFileDragOffer({
        types: ["Files"],
        items: [{ kind: "file", getAsFile: () => ({ name: "audio.wav" }) }] as unknown as DataTransferItemList,
      }),
    ).toBe("delivery-only");
  });

  it("keeps a protected file item delivery-only", () => {
    expect(
      inspectFileDragOffer({
        types: ["Files"],
        items: [{ kind: "file", getAsFile: () => null }] as unknown as DataTransferItemList,
      }),
    ).toBe("delivery-only");
  });

  it("rejects an inspectable unsupported file item", () => {
    expect(
      inspectFileDragOffer({
        types: ["Files"],
        items: [{ kind: "file", getAsFile: () => ({ name: "notes.txt" }) }] as unknown as DataTransferItemList,
      }),
    ).toBe("rejected");
  });

  it("rejects non-file data", () => {
    expect(
      inspectFileDragOffer({
        types: ["text/plain"],
        items: [{ kind: "string" }] as unknown as DataTransferItemList,
      }),
    ).toBe("rejected");
  });
});

describe("reconcilePendingReviewDrafts", () => {
  const edits = {
    localTimestampText: "unfinished local time",
    timezone: "Europe/Berlin",
    utcTimestampText: "unfinished UTC time",
    copyToBackupOnConfirm: true,
    deleteOriginalOnConfirm: true,
  };

  it("keeps surviving editable drafts through additions, removals and reorderings", () => {
    const current = [item("a", edits), item("b", edits), item("removed", edits)];
    const added = item("new");
    const result = reconcilePendingReviewDrafts(current, [item("b"), added, item("a")]);
    expect(result.map((draft) => draft.id)).toEqual(["b", "new", "a"]);
    expect(result[0]).toMatchObject(edits);
    expect(result[1]).toBe(added);
    expect(result[2]).toMatchObject(edits);
  });

  it("accepts authoritative identity, paths and metadata while retaining only editable fields", () => {
    const current = [item("a", { ...edits, workingFilePath: "/stale/working.wav", originalSourcePath: "/stale/source.wav" })];
    const authoritative = item("a", {
      originalFilename: "renamed.wav",
      importSource: "drag-and-drop",
      workingFilePath: "/fresh/working.wav",
      originalSourcePath: "/fresh/source.wav",
      fileSizeBytes: 2,
      parseStatus: "manual-required",
      timeCandidates: [],
      createdAtUtc: 2,
      updatedAtUtc: 3,
    });
    expect(reconcilePendingReviewDrafts(current, [authoritative])).toEqual([{ ...authoritative, ...edits }]);
  });

  it("returns the current array when neither authoritative fields nor local edits change", () => {
    const current = [item("a", edits), item("b")];
    expect(reconcilePendingReviewDrafts(current, [item("a"), item("b")])).toBe(current);
  });

  it("adopts new items and removes drafts absent from the authoritative snapshot", () => {
    const snapshot = [item("a")];
    expect(reconcilePendingReviewDrafts([], snapshot)).toBe(snapshot);
    expect(reconcilePendingReviewDrafts([item("a", edits)], [])).toEqual([]);
  });
});

describe("choosing a found recording time", () => {
  const pending = item("pending", { timezone: "Asia/Tokyo", localTimestampText: "", utcTimestampText: "" });

  it("keeps an exact time's instant and shows it in the item's zone", () => {
    const chosen = chooseRecordingTime(pending, { source: "file-modified", utcMs: Date.UTC(2026, 9, 14, 6, 30, 12), localText: null });
    expect(chosen).toMatchObject({ localTimestampText: "2026-10-14 15:30:12", utcTimestampText: "2026-10-14 06:30:12" });
  });

  it("reads a local time in the item's zone", () => {
    const chosen = chooseRecordingTime(pending, { source: "file-name", utcMs: null, localText: "2026-10-14 15:30:12" });
    expect(chosen).toMatchObject({ localTimestampText: "2026-10-14 15:30:12", utcTimestampText: "2026-10-14 06:30:12" });
  });
});

describe("found times as the review offers them", () => {
  it("keeps both instants in a repeated wall-clock hour and retains exact authority on zone changes", () => {
    const pending = item("fold", { timezone: "America/New_York", timeCandidates: [
      { source: "embedded", utcMs: Date.UTC(2026, 10, 1, 5, 30), localText: null },
      { source: "embedded", utcMs: Date.UTC(2026, 10, 1, 6, 30), localText: null },
    ] });
    const times = foundTimes(pending);
    expect(times).toHaveLength(2);
    expect(times.map((time) => time.localText)).toEqual(["2026-11-01 01:30:00", "2026-11-01 01:30:00"]);
    expect(times[0]!.key).not.toBe(times[1]!.key);
    const chosen = chooseRecordingTime(pending, times[1]!.candidate);
    expect(chosen).toMatchObject({ timestampBasis: "utc", utcTimestampText: "2026-11-01 06:30:00" });
    expect(changeReviewTimezone(chosen, "UTC")).toMatchObject({ localTimestampText: "2026-11-01 06:30:00", utcTimestampText: "2026-11-01 06:30:00" });
    const local = chooseRecordingTime(chosen, { source: "file-name", utcMs: null, localText: "2026-11-01 01:30:00" });
    expect(local.timestampBasis).toBe("local");
    expect(changeReviewTimezone(local, "UTC").utcTimestampText).toBe("2026-11-01 01:30:00");
    expect(reconcilePendingReviewDrafts([chosen], [pending])[0]).toMatchObject({ timestampBasis: "utc", utcTimestampText: "2026-11-01 06:30:00" });
  });
  it("merges an exact and a local time that name the same moment in the item's zone, keeping the first to choose", () => {
    const exact = { source: "embedded" as const, utcMs: Date.UTC(2026, 9, 14, 6, 30, 12), localText: null };
    const times = foundTimes({ timezone: "Asia/Tokyo", timeCandidates: [
      { source: "file-name", utcMs: null, localText: "2026-10-14 15:30:12" },
      exact,
      { ...exact },
    ] });
    expect(times).toMatchObject([{ localText: "2026-10-14 15:30:12", sources: ["file-name", "embedded"], candidate: { source: "file-name", utcMs: null, localText: "2026-10-14 15:30:12" } }]);
  });

  it("splits the same exact time that two zones show differently", () => {
    const candidates = [{ source: "file-created" as const, utcMs: Date.UTC(2026, 9, 14, 15, 30, 0), localText: null }];
    expect(foundTimes({ timezone: "Asia/Tokyo", timeCandidates: candidates })[0]?.localText).toBe("2026-10-15 00:30:00");
    expect(foundTimes({ timezone: "UTC", timeCandidates: candidates })[0]?.localText).toBe("2026-10-14 15:30:00");
  });
});
