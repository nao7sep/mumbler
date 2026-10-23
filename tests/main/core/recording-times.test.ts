import { describe, expect, it } from "vitest";

import {
  carriesOnlyRecordingTime,
  isPlausibleFileTime,
  officialStartUtcMs,
  prefilledRecordingTime,
  recordingTimesFromTags,
  recordingTimeWriteArgs,
} from "@main/core/recording-times";

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

  // An iPad Voice Memo's layout, the one recorder that puts no time in its file
  // name: ffprobe reports only the movie header's creation time, the moment
  // recording started (its 3GPP date atom holds the same moment, unreported).
  // The value is the corpus's synthetic moment; only the layout is the device's.
  it("reads an iPad Voice Memo's creation time as exact", () => {
    expect(recordingTimesFromTags({ creation_time: "2026-10-14T06:30:12.000000Z" })).toEqual([
      { source: "embedded", utcMs: Date.UTC(2026, 9, 14, 6, 30, 12), localText: null },
    ]);
  });

  it("refuses a day the month does not have, even beside an offset", () => {
    expect(recordingTimesFromTags({ "com.apple.quicktime.creationdate": "2026-02-30T15:30:12+0900" })).toEqual([]);
    expect(recordingTimesFromTags({ date: "2026-04-31T08:00:00" })).toEqual([]);
    expect(recordingTimesFromTags({ date: "2028-02-29T08:00:00" }), "2028 is a leap year").toHaveLength(1);
  });
});

describe("the time the review starts with", () => {
  const name = { source: "file-name" as const, utcMs: null, localText: "2026-10-14 15:30:12" };
  const storedLocal = { source: "embedded" as const, utcMs: null, localText: "2026-10-14 15:34:00" };
  const storedExact = { source: "embedded" as const, utcMs: Date.UTC(2026, 9, 14, 6, 30, 12), localText: null };
  const modified = { source: "file-modified" as const, utcMs: Date.UTC(2026, 9, 15, 1, 0, 0), localText: null };
  // A broken name or tag never becomes a candidate, so "broken" here is "absent".
  it.each([
    ["no name, no stored time", [modified], ""],
    ["no name, a stored local time", [storedLocal, modified], "2026-10-14 15:34:00"],
    ["no name, a stored exact time, read in the import zone", [storedExact, modified], "2026-10-14 15:30:12"],
    ["a name and no stored time", [name, modified], "2026-10-14 15:30:12"],
    ["a name that disagrees with the stored time, which the name wins", [name, storedLocal, modified], "2026-10-14 15:30:12"],
    ["the first of several stored times", [storedLocal, storedExact], "2026-10-14 15:34:00"],
  ])("%s", (_case, candidates, expected) => {
    expect(prefilledRecordingTime(candidates, "Asia/Tokyo").localTimestampText).toBe(expected);
  });

  it("never starts from a file date", () => {
    expect(prefilledRecordingTime([modified, { ...modified, source: "file-created" }], "Asia/Tokyo").localTimestampText).toBe("");
  });

  it.each([5, 6])("prefills the exact repeated-hour instant at %s UTC", (hour) => {
    const draft = prefilledRecordingTime([{ source: "embedded", utcMs: Date.UTC(2026, 10, 1, hour, 30), localText: null }], "America/New_York");
    expect(draft).toEqual({ localTimestampText: "2026-11-01 01:30:00", utcTimestampText: `2026-11-01 0${hour}:30:00`, timestampBasis: "utc" });
  });
});

describe("plausible file dates", () => {
  const now = Date.UTC(2026, 9, 15, 3, 0, 0);
  it.each([
    ["Unix zero", Date.UTC(1970, 0, 1), false],
    ["the 1980 floor of ZIP and FAT dates", Date.UTC(1980, 0, 1), false],
    ["just before 1990", Date.UTC(1989, 11, 31, 23, 59, 59), false],
    ["1990", Date.UTC(1990, 0, 1), true],
    ["now", now, true],
    ["within a day ahead, a clock a little fast", now + 23 * 60 * 60 * 1000, true],
    ["more than a day ahead", now + 25 * 60 * 60 * 1000, false],
    ["2099, an unset recorder clock", Date.UTC(2099, 11, 31), false],
  ])("%s", (_case, ms, plausible) => {
    expect(isPlausibleFileTime(ms, now)).toBe(plausible);
  });
});

describe("writing the official start into a saved recording", () => {
  // 2026-10-15 13:30:22 in Tokyo.
  const utcMs = Date.UTC(2026, 9, 15, 4, 30, 22);
  const set = (args: string[] | null) => (args ?? []).filter((arg, index) => args![index - 1]?.startsWith("-metadata") && !arg.endsWith("="));

  it("starts on the whole second the file name has", () => {
    expect(officialStartUtcMs(utcMs + 999)).toBe(utcMs);
  });

  it("puts the time where each container's own tools keep it", () => {
    expect(set(recordingTimeWriteArgs(".m4a", utcMs, "Asia/Tokyo"))).toEqual(["creation_time=2026-10-15T04:30:22Z"]);
    expect(set(recordingTimeWriteArgs(".MP4", utcMs, "Asia/Tokyo"))).toEqual(["creation_time=2026-10-15T04:30:22Z"]);
    expect(set(recordingTimeWriteArgs(".mp3", utcMs, "Asia/Tokyo"))).toEqual(["date=2026-10-15T13:30:22"]);
    expect(set(recordingTimeWriteArgs(".aiff", utcMs, "Asia/Tokyo"))).toEqual(["date=2026-10-15T13:30:22"]);
    expect(set(recordingTimeWriteArgs(".flac", utcMs, "Asia/Tokyo"))).toEqual(["date=2026-10-15T13:30:22+09:00"]);
    expect(set(recordingTimeWriteArgs(".ogg", utcMs, "America/New_York"))).toEqual(["date=2026-10-15T00:30:22-04:00"]);
    expect(set(recordingTimeWriteArgs(".wav", utcMs, "Asia/Tokyo"))).toEqual(["origination_date=2026-10-15", "origination_time=13:30:22"]);
    expect(recordingTimeWriteArgs(".aac", utcMs, "Asia/Tokyo"), "raw AAC has no tags").toBeNull();
    expect(recordingTimeWriteArgs(".wav", utcMs, "Not/AZone")).toBeNull();
  });

  it("clears every time tag the import reads, so no older time is left beside it", () => {
    const args = recordingTimeWriteArgs(".mp3", utcMs, "Asia/Tokyo")!;
    for (const name of ["com.apple.quicktime.creationdate", "creation_time", "date", "date_recorded", "tdrc", "icrd"]) {
      expect(args).toContain(`${name}=`);
    }
    expect(recordingTimeWriteArgs(".ogg", utcMs, "Asia/Tokyo")!.filter((arg) => arg === "-metadata")).toEqual([]);
  });

  it("trusts a saved file only when every time it carries is the official one", () => {
    const exact = { source: "embedded" as const, utcMs, localText: null };
    const local = { source: "embedded" as const, utcMs: null, localText: "2026-10-15 13:30:22" };
    expect(carriesOnlyRecordingTime([exact, local], utcMs, "Asia/Tokyo")).toBe(true);
    expect(carriesOnlyRecordingTime([], utcMs, "Asia/Tokyo"), "nothing read back").toBe(false);
    expect(carriesOnlyRecordingTime([exact, { ...local, localText: "2026-10-15 13:30:12" }], utcMs, "Asia/Tokyo"), "an older time left").toBe(false);
    // What the wav writer stores reads back through the import's own reader.
    expect(carriesOnlyRecordingTime(recordingTimesFromTags({ date: "2026-10-15", creation_time: "13:30:22" }), utcMs, "Asia/Tokyo")).toBe(true);
    expect(carriesOnlyRecordingTime(recordingTimesFromTags({ creation_time: "2026-10-15T04:30:22.000000Z" }), utcMs, "Asia/Tokyo")).toBe(true);
  });
});
