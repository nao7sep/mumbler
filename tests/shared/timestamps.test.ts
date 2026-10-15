import { describe, expect, it } from "vitest";

import {
  formatLocalTimestamp,
  formatUtcIsoCompact,
  getLocalTimestampError,
  getSupportedTimezones,
  getUtcTimestampError,
  isValidTimezone,
  DEFAULT_TIMESTAMP_PATTERNS,
  parseUtcMs,
  parseTimestampFromFilename,
  recomputeLocalFromUtc,
  recomputeUtcFromLocal,
} from "@shared/timestamps";

describe("parseTimestampFromFilename", () => {
  it("parses a full four-digit-year stem with seconds", () => {
    const result = parseTimestampFromFilename("20260422-094400", DEFAULT_TIMESTAMP_PATTERNS);
    expect(result).toEqual({
      localTimestampText: "2026-04-22 09:44:00",
      parseStatus: "parsed",
    });
  });

  it("defaults the optional seconds group to 00", () => {
    const result = parseTimestampFromFilename("20260422-0944", DEFAULT_TIMESTAMP_PATTERNS);
    expect(result.localTimestampText).toBe("2026-04-22 09:44:00");
    expect(result.parseStatus).toBe("parsed");
  });

  it("expands a two-digit year below the 70 pivot into the 2000s", () => {
    const result = parseTimestampFromFilename("690101-0000", DEFAULT_TIMESTAMP_PATTERNS);
    expect(result.localTimestampText).toBe("2069-01-01 00:00:00");
  });

  it("expands a two-digit year at/above the 70 pivot into the 1900s", () => {
    const result = parseTimestampFromFilename("700101-0000", DEFAULT_TIMESTAMP_PATTERNS);
    expect(result.localTimestampText).toBe("1970-01-01 00:00:00");
  });

  it("rejects an out-of-range month and reports manual-required", () => {
    const result = parseTimestampFromFilename("20261322-0944", DEFAULT_TIMESTAMP_PATTERNS);
    expect(result).toEqual({ localTimestampText: "", parseStatus: "manual-required" });
  });

  it("tries an added pattern after the built-in ones", () => {
    const patterns = [...DEFAULT_TIMESTAMP_PATTERNS, String.raw`(?<day>\d{2})\.(?<month>\d{2})\.(?<year>\d{4}) (?<hour>\d{2})h(?<minute>\d{2})`];
    expect(parseTimestampFromFilename("20260422-094400", patterns).localTimestampText).toBe("2026-04-22 09:44:00");
    expect(parseTimestampFromFilename("rec 22.04.2026 09h44", patterns).localTimestampText).toBe("2026-04-22 09:44:00");
  });

  it("skips a pattern that does not compile, without throwing", () => {
    expect(parseTimestampFromFilename("20260422-094400", ["(", ...DEFAULT_TIMESTAMP_PATTERNS]).localTimestampText).toBe("2026-04-22 09:44:00");
    expect(parseTimestampFromFilename("20260422-094400", ["("])).toEqual({ localTimestampText: "", parseStatus: "manual-required" });
  });

  it("moves on to the next pattern when one finds no real date and time", () => {
    expect(parseTimestampFromFilename("x", [String.raw`(?<year>\d{4})`, ...DEFAULT_TIMESTAMP_PATTERNS]).parseStatus).toBe("manual-required");
    const impossibleFirst = [String.raw`(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})`, ...DEFAULT_TIMESTAMP_PATTERNS];
    expect(parseTimestampFromFilename("20261332_20261014-1530", impossibleFirst).parseStatus).toBe("manual-required");
    expect(parseTimestampFromFilename("+48123456789_240506_225406577", DEFAULT_TIMESTAMP_PATTERNS).localTimestampText).toBe("2024-05-06 22:54:06");
  });

  it("returns manual-required when no pattern matches", () => {
    const result = parseTimestampFromFilename("not-a-timestamp", DEFAULT_TIMESTAMP_PATTERNS);
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
    expect(result.error).toBe("timestamp.localFormat");
  });

  it("reports an error for an unsupported timezone", () => {
    const result = recomputeUtcFromLocal("2026-04-22 09:44:00", "Mars/Olympus");
    expect(result.utcMs).toBeNull();
    expect(result.error).toBe("timestamp.invalidZone");
  });

  it("accepts a numeric UTC input for recomputeLocalFromUtc", () => {
    const ms = Date.UTC(2026, 3, 22, 0, 44, 0);
    const result = recomputeLocalFromUtc(ms, "Asia/Tokyo");
    expect(result.error).toBeNull();
    expect(result.localTimestampText).toBe("2026-04-22 09:44:00");
  });
});

describe("formatUtcIsoCompact", () => {
  it("always emits exactly three fractional digits, even when milliseconds are zero", () => {
    expect(formatUtcIsoCompact(Date.UTC(2026, 3, 22, 0, 44, 0))).toBe("2026-04-22T00:44:00.000Z");
  });

  it("zero-pads nonzero milliseconds to three digits", () => {
    expect(formatUtcIsoCompact(Date.UTC(2026, 3, 22, 0, 44, 0, 123))).toBe(
      "2026-04-22T00:44:00.123Z",
    );
    expect(formatUtcIsoCompact(Date.UTC(2026, 3, 22, 0, 44, 0, 7))).toBe(
      "2026-04-22T00:44:00.007Z",
    );
  });
});

describe("calendar validity", () => {
  // As the shared corpus's audio/timestamps/ names: a day the month lacks is
  // refused like month 13 or hour 25.
  it.each(["20260230-153012", "20260431-0800", "20270229-1200", "20261314-153012", "20261032-153012", "20261014-253012", "20261014-156012"])(
    "refuses %s", (stem) => {
      expect(parseTimestampFromFilename(stem, DEFAULT_TIMESTAMP_PATTERNS)).toEqual({ localTimestampText: "", parseStatus: "manual-required" });
    },
  );

  it("reads a two-digit year 70 or later as 19xx, and earlier as 20xx", () => {
    expect(parseTimestampFromFilename("700101-0000", DEFAULT_TIMESTAMP_PATTERNS).localTimestampText).toBe("1970-01-01 00:00:00");
    expect(parseTimestampFromFilename("691231-2359", DEFAULT_TIMESTAMP_PATTERNS).localTimestampText).toBe("2069-12-31 23:59:00");
  });

  it("accepts February 29 in a leap year, and refuses it as typed text otherwise", () => {
    expect(parseTimestampFromFilename("20280229-1200", DEFAULT_TIMESTAMP_PATTERNS).localTimestampText).toBe("2028-02-29 12:00:00");
    expect(getLocalTimestampError("2027-02-29 12:00:00")).not.toBeNull();
    expect(getLocalTimestampError("2028-02-29 12:00:00")).toBeNull();
  });
});

describe("parseUtcMs", () => {
  it("reads a number as no stored time; instants are stored as text", () => {
    expect(parseUtcMs(1_700_000_000_000)).toBeNull();
  });

  it("reads the canonical ISO form it writes", () => {
    expect(parseUtcMs("2026-04-22T00:44:00.007Z")).toBe(Date.UTC(2026, 3, 22, 0, 44, 0, 7));
  });

  it.each([
    ["2026-04-22T00:44:00Z", 0],
    ["2026-04-22T00:44:00.000+00:00", 0],
    ["2026-04-22T00:44:00.1Z", 100],
    ["2026-04-22T00:44:00.1234567+00:00", 123],
  ])("reads explicit UTC %s at millisecond precision", (value, milliseconds) => {
    expect(parseUtcMs(value)).toBe(Date.UTC(2026, 3, 22, 0, 44, 0, milliseconds));
  });

  it("reads incompatible or invalid forms as no stored time", () => {
    for (const other of [
      "2026-04-22 00:44:00",
      "20260422-004400-utc",
      "2026-04-22T00:44:00.000+01:00",
      "2026-04-22T00:44:00.12345678Z",
      "2026-04-22T24:00:00Z",
      "2026-02-30T00:00:00.000Z",
    ]) {
      expect(parseUtcMs(other), other).toBeNull();
    }
  });

  it("reads a missing or unparseable value as null, never as the current time", () => {
    expect(parseUtcMs("nonsense")).toBeNull();
    expect(parseUtcMs(undefined)).toBeNull();
    expect(parseUtcMs(Number.NaN)).toBeNull();
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
    expect(getLocalTimestampError("2026-04-22 9:44")).toBe("timestamp.localFormat");
  });

  it("getUtcTimestampError accepts valid and rejects invalid", () => {
    expect(getUtcTimestampError("2026-04-22 09:44:00")).toBeNull();
    expect(getUtcTimestampError("garbage")).toBe("timestamp.utcFormat");
  });
});

// Names as recorders, phones and apps write them (company research
// recording-file-names), read by the built-in patterns.
describe("the built-in timestamp patterns", () => {
  it.each([
    ["191010_1010", "2019-10-10 10:10:00"], // Sony
    ["Important_191010_1010_01", "2019-10-10 10:10:00"], // Sony, prefixed and divided
    ["110531-130512", "2011-05-31 13:05:12"], // Zoom date option
    ["240101_000000_Tr1", "2024-01-01 00:00:00"], // Zoom H4essential
    ["TX01_MIC002_20250527_202904_orig", "2025-05-27 20:29:04"], // DJI Mic Mini 2S
    ["recording-20150607-120024", "2015-06-07 12:00:24"], // Hi-Q
    ["H2 FY2021 Review 20210615_140058-Meeting Recording", "2021-06-15 14:00:58"], // Teams
    ["20180105 060425", "2018-01-05 06:04:25"], // Voice Memos library
    ["CallRecord_20230619-121746_+12192826655", "2023-06-19 12:17:46"], // GrapheneOS
    ["+12025550123_230115_143022", "2023-01-15 14:30:22"], // a number before the date
    ["John@+391234567890_20240115143022", "2024-01-15 14:30:22"], // Huawei call recorder
    ["2026-10-15 14-03-22", "2026-10-15 14:03:22"], // OBS
    ["audio_2026-10-15_14-03-22", "2026-10-15 14:03:22"], // Telegram Desktop
    ["00000012-AUDIO-2024-03-15-09-14-22", "2024-03-15 09:14:22"], // WhatsApp iOS export
    ["WhatsApp Ptt 2021-07-28 at 12.00.11", "2021-07-28 12:00:11"], // WhatsApp Web
    ["signal-2026-10-15-14-03-22-123", "2026-10-15 14:03:22"], // Signal
    ["2026-06-23 09.30.00 Weekly Standup", "2026-06-23 09:30:00"], // Zoom local folder
    ["audio_1@15-10-2026_14-03-22", "2026-10-15 14:03:22"], // Telegram chat export
    ["2020_0101_0000", "2020-01-01 00:00:00"], // Zoom PodTrak
    ["20261014153012", "2026-10-14 15:30:12"], // OBS compact
  ])("reads %s", (stem, expected) => {
    expect(parseTimestampFromFilename(stem, DEFAULT_TIMESTAMP_PATTERNS)).toEqual({ localTimestampText: expected, parseStatus: "parsed" });
  });

  it.each(["ZOOM0001", "REC00001", "New Recording 3", "PTT-20250117-WA0008", "210101_001", "180101-T001", "Recording (14)", "My recording #1"])(
    "finds no time in %s", (stem) => {
      expect(parseTimestampFromFilename(stem, DEFAULT_TIMESTAMP_PATTERNS).parseStatus).toBe("manual-required");
    },
  );
});
