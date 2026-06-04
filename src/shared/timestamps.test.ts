import { describe, expect, it } from "vitest";

import {
  formatLocalTimestamp,
  formatUtcIsoCompact,
  getLocalTimestampError,
  getSupportedTimezones,
  getUtcTimestampError,
  isValidTimezone,
  normalizeUtcMs,
  parseTimestampFromFilename,
  parseUtcFromDisplay,
  recomputeLocalFromUtc,
  recomputeUtcFromLocal,
} from "./timestamps";

// The default filename pattern shipped in createDefaultSettings.
const DEFAULT_PATTERN =
  "(?<year>\\d{2}(?:\\d{2})?)(?<month>\\d{2})(?<day>\\d{2})[-_](?<hour>\\d{2})(?<minute>\\d{2})(?<second>\\d{2})?";

describe("parseTimestampFromFilename", () => {
  it("parses a full four-digit-year stem with seconds", () => {
    const result = parseTimestampFromFilename("20260422-094400", [DEFAULT_PATTERN]);
    expect(result).toEqual({
      localTimestampText: "2026-04-22 09:44:00",
      parseStatus: "parsed",
    });
  });

  it("defaults the optional seconds group to 00", () => {
    const result = parseTimestampFromFilename("20260422-0944", [DEFAULT_PATTERN]);
    expect(result.localTimestampText).toBe("2026-04-22 09:44:00");
    expect(result.parseStatus).toBe("parsed");
  });

  it("expands a two-digit year below the 70 pivot into the 2000s", () => {
    const result = parseTimestampFromFilename("690101-0000", [DEFAULT_PATTERN]);
    expect(result.localTimestampText).toBe("2069-01-01 00:00:00");
  });

  it("expands a two-digit year at/above the 70 pivot into the 1900s", () => {
    const result = parseTimestampFromFilename("700101-0000", [DEFAULT_PATTERN]);
    expect(result.localTimestampText).toBe("1970-01-01 00:00:00");
  });

  it("rejects an out-of-range month and reports manual-required", () => {
    const result = parseTimestampFromFilename("20261322-0944", [DEFAULT_PATTERN]);
    expect(result).toEqual({ localTimestampText: "", parseStatus: "manual-required" });
  });

  it("skips an invalid regex pattern without throwing", () => {
    const result = parseTimestampFromFilename("20260422-094400", ["(", DEFAULT_PATTERN]);
    expect(result.localTimestampText).toBe("2026-04-22 09:44:00");
    expect(result.parseStatus).toBe("parsed");
  });

  it("returns manual-required when no pattern matches", () => {
    const result = parseTimestampFromFilename("not-a-timestamp", [DEFAULT_PATTERN]);
    expect(result).toEqual({ localTimestampText: "", parseStatus: "manual-required" });
  });
});

describe("recomputeUtcFromLocal / recomputeLocalFromUtc", () => {
  it("converts a fixed-offset timezone (Asia/Tokyo, UTC+9)", () => {
    const { utcMs, error } = recomputeUtcFromLocal("2026-04-22 09:44:00", "Asia/Tokyo");
    expect(error).toBeNull();
    expect(utcMs).toBe(Date.UTC(2026, 3, 22, 0, 44, 0));
  });

  it("round-trips local -> UTC -> local for Asia/Tokyo", () => {
    const local = "2026-04-22 09:44:00";
    const { utcMs } = recomputeUtcFromLocal(local, "Asia/Tokyo");
    const back = recomputeLocalFromUtc(utcMs!, "Asia/Tokyo");
    expect(back.error).toBeNull();
    expect(back.localTimestampText).toBe(local);
  });

  it("applies EDT (UTC-4) for a summer New York time", () => {
    const { utcMs, error } = recomputeUtcFromLocal("2026-07-15 12:00:00", "America/New_York");
    expect(error).toBeNull();
    expect(utcMs).toBe(Date.UTC(2026, 6, 15, 16, 0, 0));
  });

  it("applies EST (UTC-5) for a winter New York time", () => {
    const { utcMs, error } = recomputeUtcFromLocal("2026-01-15 12:00:00", "America/New_York");
    expect(error).toBeNull();
    expect(utcMs).toBe(Date.UTC(2026, 0, 15, 17, 0, 0));
  });

  it("uses an offset one hour smaller in summer (DST) than in winter", () => {
    // Offset = how far the zone's wall clock leads UTC for the same noon.
    // EDT is UTC-4 in summer, EST is UTC-5 in winter — a one-hour DST shift.
    const summerUtc = recomputeUtcFromLocal("2026-07-15 12:00:00", "America/New_York").utcMs!;
    const winterUtc = recomputeUtcFromLocal("2026-01-15 12:00:00", "America/New_York").utcMs!;
    const summerOffsetMs = summerUtc - Date.UTC(2026, 6, 15, 12, 0, 0);
    const winterOffsetMs = winterUtc - Date.UTC(2026, 0, 15, 12, 0, 0);
    expect(summerOffsetMs).toBe(4 * 60 * 60 * 1000);
    expect(winterOffsetMs).toBe(5 * 60 * 60 * 1000);
    expect(winterOffsetMs - summerOffsetMs).toBe(60 * 60 * 1000);
  });

  it("round-trips through a DST-observing zone in both seasons", () => {
    for (const local of ["2026-07-15 12:00:00", "2026-01-15 12:00:00"]) {
      const { utcMs } = recomputeUtcFromLocal(local, "America/New_York");
      const back = recomputeLocalFromUtc(utcMs!, "America/New_York");
      expect(back.localTimestampText).toBe(local);
    }
  });

  it("reports an error for malformed local input", () => {
    const result = recomputeUtcFromLocal("2026/04/22 09:44", "Asia/Tokyo");
    expect(result.utcMs).toBeNull();
    expect(result.error).toMatch(/local time/i);
  });

  it("reports an error for an unsupported timezone", () => {
    const result = recomputeUtcFromLocal("2026-04-22 09:44:00", "Mars/Olympus");
    expect(result.utcMs).toBeNull();
    expect(result.error).toMatch(/timezone/i);
  });

  it("accepts a numeric UTC input for recomputeLocalFromUtc", () => {
    const ms = Date.UTC(2026, 3, 22, 0, 44, 0);
    const result = recomputeLocalFromUtc(ms, "Asia/Tokyo");
    expect(result.error).toBeNull();
    expect(result.localTimestampText).toBe("2026-04-22 09:44:00");
  });
});

describe("formatUtcIsoCompact", () => {
  it("omits the fractional part when milliseconds are zero", () => {
    expect(formatUtcIsoCompact(Date.UTC(2026, 3, 22, 0, 44, 0))).toBe("2026-04-22T00:44:00Z");
  });

  it("includes zero-padded milliseconds when nonzero", () => {
    expect(formatUtcIsoCompact(Date.UTC(2026, 3, 22, 0, 44, 0, 123))).toBe(
      "2026-04-22T00:44:00.123Z",
    );
    expect(formatUtcIsoCompact(Date.UTC(2026, 3, 22, 0, 44, 0, 7))).toBe(
      "2026-04-22T00:44:00.007Z",
    );
  });
});

describe("normalizeUtcMs", () => {
  it("returns a finite number input unchanged", () => {
    expect(normalizeUtcMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it("parses a display-format string", () => {
    expect(normalizeUtcMs("2026-04-22 00:44:00")).toBe(parseUtcFromDisplay("2026-04-22 00:44:00"));
  });

  it("parses a -utc marker string", () => {
    expect(normalizeUtcMs("20260422-004400-utc")).toBe(Date.UTC(2026, 3, 22, 0, 44, 0));
  });

  it("parses an ISO string via the Date fallback", () => {
    expect(normalizeUtcMs("2026-04-22T00:44:00Z")).toBe(Date.UTC(2026, 3, 22, 0, 44, 0));
  });

  it("falls back when the value is unparseable", () => {
    expect(normalizeUtcMs("nonsense", 999)).toBe(999);
    expect(normalizeUtcMs(undefined, 999)).toBe(999);
    expect(normalizeUtcMs(Number.NaN, 999)).toBe(999);
  });
});

describe("timezone validity", () => {
  it("accepts UTC and other usable zones even when omitted from the dropdown list", () => {
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Etc/UTC")).toBe(true);
    expect(isValidTimezone("Asia/Tokyo")).toBe(true);
    expect(isValidTimezone("US/Eastern")).toBe(true); // valid alias not in supportedValuesOf
  });

  it("rejects empty and nonsense zones", () => {
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone(undefined as unknown as string)).toBe(false);
  });

  it("always offers UTC in the supported-timezone list", () => {
    expect(getSupportedTimezones()).toContain("UTC");
  });
});

describe("validation helpers", () => {
  it("formatLocalTimestamp zero-pads every field", () => {
    expect(
      formatLocalTimestamp({ year: 26, month: 4, day: 2, hour: 9, minute: 4, second: 5 }),
    ).toBe("0026-04-02 09:04:05");
  });

  it("getLocalTimestampError accepts valid and rejects invalid", () => {
    expect(getLocalTimestampError("2026-04-22 09:44:00")).toBeNull();
    expect(getLocalTimestampError("2026-04-22 9:44")).toMatch(/local time/i);
  });

  it("getUtcTimestampError accepts valid and rejects invalid", () => {
    expect(getUtcTimestampError("2026-04-22 09:44:00")).toBeNull();
    expect(getUtcTimestampError("garbage")).toMatch(/UTC/i);
  });
});
