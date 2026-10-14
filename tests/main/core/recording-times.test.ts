import { describe, expect, it } from "vitest";

import { recordingTimesFromTags } from "@main/core/recording-times";

describe("recording times inside an audio file", () => {
  it("reads an MP4 creation time, which the format keeps in UTC, as exact", () => {
    expect(recordingTimesFromTags({ creation_time: "2026-10-14T06:30:12.000000Z" })).toEqual([
      { source: "embedded", utcMs: Date.UTC(2026, 9, 14, 6, 30, 12), localText: null },
    ]);
  });

  it("reads an Apple creation date with its offset as exact", () => {
    expect(recordingTimesFromTags({ "com.apple.quicktime.creationdate": "2026-10-14T15:30:12+0900" })).toEqual([
      { source: "embedded", utcMs: Date.UTC(2026, 9, 14, 6, 30, 12), localText: null },
    ]);
  });

  it("reads Broadcast Wave origination fields, either date separator, as local time", () => {
    expect(recordingTimesFromTags({ origination_date: "2026:10:14", origination_time: "15:30:12" })).toEqual([
      { source: "embedded", utcMs: null, localText: "2026-10-14 15:30:12" },
    ]);
    expect(recordingTimesFromTags({ origination_date: "2026-10-14", origination_time: "15:30" })[0]?.localText).toBe("2026-10-14 15:30:00");
  });

  it("reads an ID3 or RIFF date with a time as local, whatever the tag's case", () => {
    expect(recordingTimesFromTags({ DATE: "2026-10-14 15:30:12" })).toEqual([
      { source: "embedded", utcMs: null, localText: "2026-10-14 15:30:12" },
    ]);
  });

  it("offers nothing for a day or year alone, an unset MP4 time, or text", () => {
    expect(recordingTimesFromTags({
      date: "2026",
      icrd: "2026-10-14",
      creation_time: "1904-01-01T00:00:00.000000Z",
      tdrc: "yesterday",
      origination_date: "2026-10-14",
    })).toEqual([]);
  });

  it("offers each distinct time once", () => {
    expect(recordingTimesFromTags({ creation_time: "2026-10-14T06:30:12Z", date: "2026-10-14T06:30:12Z" })).toHaveLength(1);
  });
});
