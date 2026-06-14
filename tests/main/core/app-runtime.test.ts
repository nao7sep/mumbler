import { describe, expect, it, vi } from "vitest";

import type { PendingImportReviewItem } from "@shared/app-shell";

// app-runtime imports electron at module load; stub it so the module's exported
// pure helpers can be exercised under the node test environment. The helpers
// under test never touch electron.
vi.mock("electron", () => ({
  app: { getVersion: () => "9.9.9-test", getPath: () => "/tmp" },
  BrowserWindow: class {},
  dialog: {},
  shell: {},
}));

const { applyPendingImportDraft, buildConfirmedTimestamps, applyFrontTrimOffset } = await import(
  "@main/core/app-runtime"
);

function authoritativeItem(): PendingImportReviewItem {
  return {
    id: "import-1",
    originalFilename: "rec.m4a",
    importSource: "drag-and-drop",
    originalSourcePath: "/Users/me/Downloads/rec.m4a",
    workingFilePath: "/Users/me/.mumbler/working/rec.m4a",
    fileSizeBytes: 12345,
    localTimestampText: "",
    timezone: "Asia/Tokyo",
    utcTimestampText: "",
    parseStatus: "manual-required",
    deleteOriginalOnConfirm: false,
    copyToBackupOnConfirm: true,
    createdAtUtc: 1_700_000_000_000,
    updatedAtUtc: 1_700_000_000_000,
  };
}

describe("applyPendingImportDraft", () => {
  it("applies only the review-editable fields and never the renderer's paths/identity", () => {
    const authoritative = authoritativeItem();
    // A draft that, besides the legitimate edits, tries to repoint the main
    // process at attacker-chosen paths and rewrite server-established identity.
    const malicious: PendingImportReviewItem = {
      ...authoritative,
      originalSourcePath: "/Users/me/.ssh/id_rsa",
      workingFilePath: "/etc/passwd",
      fileSizeBytes: 0,
      originalFilename: "evil.m4a",
      importSource: "file-picker",
      parseStatus: "parsed",
      createdAtUtc: 0,
      // Legitimate edits the review screen is allowed to make:
      localTimestampText: "2026-04-22 09:44:00",
      timezone: "America/New_York",
      utcTimestampText: "2026-04-22 13:44:00",
      deleteOriginalOnConfirm: true,
      copyToBackupOnConfirm: false,
    };

    const result = applyPendingImportDraft(authoritative, malicious);

    // Server-established fields are kept from the authoritative item.
    expect(result.originalSourcePath).toBe(authoritative.originalSourcePath);
    expect(result.workingFilePath).toBe(authoritative.workingFilePath);
    expect(result.fileSizeBytes).toBe(authoritative.fileSizeBytes);
    expect(result.originalFilename).toBe(authoritative.originalFilename);
    expect(result.importSource).toBe(authoritative.importSource);
    expect(result.parseStatus).toBe(authoritative.parseStatus);
    expect(result.id).toBe(authoritative.id);
    expect(result.createdAtUtc).toBe(authoritative.createdAtUtc);

    // Review-editable fields are taken from the draft.
    expect(result.localTimestampText).toBe("2026-04-22 09:44:00");
    expect(result.timezone).toBe("America/New_York");
    expect(result.utcTimestampText).toBe("2026-04-22 13:44:00");
    expect(result.deleteOriginalOnConfirm).toBe(true);
    expect(result.copyToBackupOnConfirm).toBe(false);
  });
});

describe("buildConfirmedTimestamps", () => {
  it("derives confirmed and effective timestamps from a local timestamp", () => {
    const result = buildConfirmedTimestamps("2026-04-22 09:44:00", "Asia/Tokyo", "");
    // 09:44 JST is 00:44 UTC.
    const expectedUtc = Date.UTC(2026, 3, 22, 0, 44, 0);
    expect(result.confirmedLocal).toBe("2026-04-22 09:44:00");
    expect(result.confirmedUtc).toBe(expectedUtc);
    expect(result.effectiveLocal).toBe("2026-04-22 09:44:00");
    expect(result.effectiveUtc).toBe(expectedUtc);
    expect(result.timezone).toBe("Asia/Tokyo");
    expect(result.frontTrimOffsetSec).toBe(0);
  });

  it("falls back to the UTC timestamp when the local field is empty", () => {
    const result = buildConfirmedTimestamps("", "Asia/Tokyo", "2026-04-22 00:44:00");
    expect(result.confirmedUtc).toBe(Date.UTC(2026, 3, 22, 0, 44, 0));
    expect(result.confirmedLocal.length).toBeGreaterThan(0);
    expect(result.timezone).toBe("Asia/Tokyo");
  });

  it("rejects an invalid timezone", () => {
    expect(() => buildConfirmedTimestamps("2026-04-22 09:44:00", "Not/AZone", "")).toThrow();
  });

  it("rejects when neither the local nor the UTC field is usable", () => {
    expect(() => buildConfirmedTimestamps("", "Asia/Tokyo", "")).toThrow();
  });
});

describe("applyFrontTrimOffset", () => {
  const base = buildConfirmedTimestamps("2026-04-22 09:44:00", "Asia/Tokyo", "");

  it("leaves the effective timestamp equal to confirmed for a zero offset", () => {
    const result = applyFrontTrimOffset(base, 0);
    expect(result.frontTrimOffsetSec).toBe(0);
    expect(result.effectiveLocal).toBe("2026-04-22 09:44:00");
  });

  it("shifts the effective local time by a whole-second offset with no fractional suffix", () => {
    const result = applyFrontTrimOffset(base, 5);
    expect(result.frontTrimOffsetSec).toBe(5);
    expect(result.effectiveLocal).toBe("2026-04-22 09:44:05");
  });

  it("appends a tenths suffix for a fractional offset", () => {
    const result = applyFrontTrimOffset(base, 0.5);
    expect(result.effectiveLocal).toBe("2026-04-22 09:44:00.5");
  });

  it("returns the timestamps unchanged when the confirmed local time is unparseable", () => {
    const broken = { ...base, confirmedLocal: "not a timestamp" };
    expect(applyFrontTrimOffset(broken, 5)).toBe(broken);
  });
});
