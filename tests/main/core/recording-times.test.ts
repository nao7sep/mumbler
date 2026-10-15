import { describe, expect, it } from "vitest";

import { recordingTimesFromTags } from "@main/core/recording-times";

// The tags below are as ffprobe 9 reports them for files written the way each
// format's recorders write them; the live lane writes such files and reads them
// with the managed ffprobe, so a change in its naming fails there.
describe("recording times inside an audio file", () => {
  it("reads ID3v2.3's year, day and time frames, which ffprobe joins into one date", () => {
    expect(recordingTimesFromTags({ date: "2026-10-14 09:16" })).toEqual([
      { source: "embedded", utcMs: null, localText: "2026-10-14 09:16:00" },
    ]);
  });

  it("reads a FLAC Vorbis DATE with a time", () => {
    expect(recordingTimesFromTags({ DATE: "2026-10-11T07:45:00", encoder: "Lavf63.1.102" })).toEqual([
      { source: "embedded", utcMs: null, localText: "2026-10-11 07:45:00" },
    ]);
  });

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

  // As ffprobe reports a Broadcast Wave file's origination date and time.
  it("reads Broadcast Wave's day-only date and time-only creation time, either date separator, as local time", () => {
    expect(recordingTimesFromTags({ date: "2026:10:14", creation_time: "15:30:12", time_reference: "0" })).toEqual([
      { source: "embedded", utcMs: null, localText: "2026-10-14 15:30:12" },
    ]);
    expect(recordingTimesFromTags({ date: "2026-10-14", creation_time: "15:30" })[0]?.localText).toBe("2026-10-14 15:30:00");
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
    })).toEqual([]);
  });

  it("offers each distinct time once", () => {
    expect(recordingTimesFromTags({ creation_time: "2026-10-14T06:30:12Z", date: "2026-10-14T06:30:12Z" })).toHaveLength(1);
  });
});
