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

// The tags exactly as ffprobe reports them for the shared corpus's
// audio/timestamps/ files (their manifest entries record them), each written
// by the program that owns its format; copied here so the default suite needs
// no corpus checkout. The live lane reads the files themselves.
const CORPUS_TAGS: Array<[file: string, tags: Record<string, string>, expected: { utc: string } | { local: string } | null]> = [
  ["20261014-153012-agrees.m4a", {"com.apple.quicktime.creationdate": "2026-10-14T15:30:12+0900"}, { utc: "2026-10-14T06:30:12Z" }],
  ["20261014-153012-minutes-apart.mp3", {"date": "2026-10-14T15:34:00"}, { local: "2026-10-14 15:34:00" }],
  ["20261014-153012-stored-broken.flac", {"DATE": "2026-13-14T15:30:12"}, null],
  ["20261014-153012-zone-apart.m4a", {"com.apple.quicktime.creationdate": "2026-10-14T15:30:12-0400"}, { utc: "2026-10-14T19:30:12Z" }],
  ["20261014_153012-agrees.mp3", {"date": "2026-10-14T15:30:12"}, { local: "2026-10-14 15:30:12" }],
  ["20261332-153012-name-broken.mp3", {"date": "2026-10-14T15:30:12"}, { local: "2026-10-14 15:30:12" }],
  ["apple-creationdate-month-13.m4a", {"com.apple.quicktime.creationdate": "2026-13-14T15:30:12+0900"}, null],
  ["apple-creationdate-new-york.m4a", {"com.apple.quicktime.creationdate": "2026-10-14T02:30:12-0400"}, { utc: "2026-10-14T06:30:12Z" }],
  ["apple-creationdate-tokyo.m4a", {"com.apple.quicktime.creationdate": "2026-10-14T15:30:12+0900"}, { utc: "2026-10-14T06:30:12Z" }],
  ["apple-creationdate-utc.m4a", {"com.apple.quicktime.creationdate": "2026-10-14T06:30:12+0000"}, { utc: "2026-10-14T06:30:12Z" }],
  ["avfoundation-udta-date.m4a", {"creation_time": "2026-10-14T06:30:12.000000Z"}, { utc: "2026-10-14T06:30:12Z" }],
  ["bwf-origination-hour-25.wav", {"date": "2026-10-14", "creation_time": "25:30:12"}, null],
  ["bwf-origination.wav", {"date": "2026-10-14", "creation_time": "15:30:12"}, { local: "2026-10-14 15:30:12" }],
  ["id3v23-tdat-day-32.mp3", {"date": "2026-10-32 15:30"}, null],
  ["id3v23-tyer-tdat-time.mp3", {"date": "2026-10-14 15:30"}, { local: "2026-10-14 15:30:00" }],
  ["id3v24-tdrc-february-30.mp3", {"date": "2026-02-30T15:30:12"}, null],
  ["id3v24-tdrc-month-13.mp3", {"date": "2026-13-14T15:30:12"}, null],
  ["id3v24-tdrc.mp3", {"date": "2026-10-14T15:30:12"}, { local: "2026-10-14 15:30:12" }],
  ["itunes-day.m4a", {"date": "2026-10-14T15:30:12"}, { local: "2026-10-14 15:30:12" }],
  ["mp4-header-1904.m4a", {"creation_time": "1970-01-01T00:00:01.000000Z"}, null],
  ["mp4-header-only.m4a", {"creation_time": "2026-10-14T06:30:12.000000Z"}, { utc: "2026-10-14T06:30:12Z" }],
  ["riff-icrd-truncated.wav", {"date": "2026-10-1"}, null],
  ["riff-icrd.wav", {"date": "2026-10-14 15:30:12"}, { local: "2026-10-14 15:30:12" }],
  ["vorbis-date-letter-o.flac", {"DATE": "2026-1O-14T15:30:12"}, null],
  ["vorbis-date.flac", {"DATE": "2026-10-14T15:30:12"}, { local: "2026-10-14 15:30:12" }],
];

describe("recording times in the shared corpus's tags", () => {
  it.each(CORPUS_TAGS)("%s", (_file, tags, expected) => {
    const found = recordingTimesFromTags(tags);
    if (expected === null) expect(found, "a broken or unset time is refused").toEqual([]);
    else if ("utc" in expected) expect(found).toEqual([{ source: "embedded", utcMs: Date.parse(expected.utc), localText: null }]);
    else expect(found).toEqual([{ source: "embedded", utcMs: null, localText: expected.local }]);
  });

  it("refuses a day the month does not have, even beside an offset", () => {
    expect(recordingTimesFromTags({ "com.apple.quicktime.creationdate": "2026-02-30T15:30:12+0900" })).toEqual([]);
    expect(recordingTimesFromTags({ date: "2026-04-31T08:00:00" })).toEqual([]);
    expect(recordingTimesFromTags({ date: "2028-02-29T08:00:00" }), "2028 is a leap year").toHaveLength(1);
  });
});
