import type { PendingImportReviewItem, RecordingTimeCandidate } from "@shared/app-shell";
import { recordingTimeDraft } from "@shared/review-timestamps";
import { getLocalTimestampError, recomputeLocalFromUtc } from "@shared/timestamps";

// The recording times an audio file carries inside it, as ffprobe reports its
// container tags. There is no one standard: MP4/M4A keeps `creation_time` in
// UTC by its format, Apple files may add `com.apple.quicktime.creationdate`
// with an offset, Broadcast Wave's origination date and time (local) reach
// ffprobe as a day-only `date` and a time-only `creation_time`, and ID3, RIFF
// INFO and Vorbis comments keep a `date` that is often a year or a day only. A
// time with a zone or `Z` is exact; one without is local and read in the import
// zone. Only full dates with a time are offered, since a day alone cannot
// settle a recording time.

// yyyy-mm-dd[ T]hh:mm[:ss][.fff][Z|±hh[:]mm], with "-" or ":" between date
// parts (Broadcast Wave allows either).
const DATE_TIME = /^(\d{4})[-:](\d{2})[-:](\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const DATE_ONLY = /^(\d{4})[-:](\d{2})[-:](\d{2})$/;
const TIME_ONLY = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

// Tags read in order of how directly they state the recording time.
const DATE_TIME_TAGS = ["com.apple.quicktime.creationdate", "creation_time", "date", "date_recorded", "tdrc", "icrd"];

function local(year: string, month: string, day: string, hour: string, minute: string, second = "00"): string {
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

// A local time is offered only when it names a real moment: no month 13,
// February 30 or hour 25, which a hand-edited or damaged tag can hold.
function localCandidate(text: string): RecordingTimeCandidate | null {
  return getLocalTimestampError(text) === null ? { source: "embedded", utcMs: null, localText: text } : null;
}

function parse(value: string): RecordingTimeCandidate | null {
  const match = DATE_TIME.exec(value.trim());
  if (match === null) return null;
  const [, year, month, day, hour, minute, second = "00", zone] = match;
  const text = local(year!, month!, day!, hour!, minute!, second);
  if (zone === undefined) return localCandidate(text);
  // The digits before an offset are a local time too; Date.parse would roll
  // February 30 over into March rather than refuse it.
  if (getLocalTimestampError(text) !== null) return null;
  const offset = zone.toUpperCase() === "Z" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const utcMs = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`);
  // MP4 writers that never set the time leave the format's epoch behind.
  if (!Number.isFinite(utcMs) || Number(year) < 1990) return null;
  return { source: "embedded", utcMs, localText: null };
}

export function recordingTimesFromTags(tags: Readonly<Record<string, unknown>>): RecordingTimeCandidate[] {
  const byName = new Map(Object.entries(tags).map(([name, value]) => [name.toLowerCase(), typeof value === "string" ? value : null]));
  const found: RecordingTimeCandidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: RecordingTimeCandidate | null): void => {
    if (candidate === null) return;
    const key = `${candidate.utcMs}|${candidate.localText}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(candidate);
  };
  for (const name of DATE_TIME_TAGS) {
    const value = byName.get(name);
    if (value) add(parse(value));
  }
  // Broadcast Wave: the day and the time arrive as two tags.
  const date = DATE_ONLY.exec(byName.get("date")?.trim() ?? "");
  const time = TIME_ONLY.exec(byName.get("creation_time")?.trim() ?? "");
  if (date !== null && time !== null) {
    add(localCandidate(local(date[1]!, date[2]!, date[3]!, time[1]!, time[2]!, time[3] ?? "00")));
  }
  return found;
}

// A file date a copy, an archive or an unset clock can leave behind is not a
// recording time: before 1990, which takes in Unix zero and the 1980 floor of
// ZIP and FAT dates, or more than a day after now.
const EARLIEST_FILE_TIME_MS = Date.UTC(1990, 0, 1);
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

/** Whether a file's created or modified time could be when it was recorded. */
export function isPlausibleFileTime(ms: number, nowMs: number): boolean {
  return Number.isFinite(ms) && ms >= EARLIEST_FILE_TIME_MS && ms <= nowMs + FUTURE_SLACK_MS;
}

/** The time draft the review starts with, in `timezone`: the file name's when
 * it has one, which every recorder but the iPad writes; otherwise the first
 * time stored inside the file; otherwise none. File dates are offered, never
 * chosen, since a copy or sync can change them. */
export function prefilledRecordingTime(candidates: readonly RecordingTimeCandidate[], timezone: string): Pick<PendingImportReviewItem, "localTimestampText" | "utcTimestampText" | "timestampBasis"> {
  const name = candidates.find((candidate) => candidate.source === "file-name");
  if (name?.localText) return recordingTimeDraft(name, timezone);
  for (const candidate of candidates) {
    if (candidate.source !== "embedded") continue;
    const draft = recordingTimeDraft(candidate, timezone);
    if (draft.localTimestampText !== "") return draft;
  }
  return recordingTimeDraft(null, timezone);
}

// A saved recording carries its official start inside it: the chosen time
// moved forward by the front trim, in whole seconds as the file name has it.
// Each container gets the place its own tools keep a recording time, and every
// time tag the import reads is cleared first, so no older time is left beside
// the new one. MP4 keeps UTC; ID3 and Broadcast Wave keep a local time with no
// zone; Vorbis comments take the local time with its offset. Raw AAC has no
// tags at all, so it gets none (null).
const CLEARED_TIME_TAGS = DATE_TIME_TAGS.flatMap((name) => ["-metadata", `${name}=`]);

interface OfficialTime {
  utc: string;
  localDate: string;
  localTime: string;
  offset: string;
}

function officialTime(utcMs: number, timezone: string): OfficialTime | null {
  const local = recomputeLocalFromUtc(utcMs, timezone);
  if (local.error !== null) return null;
  const [localDate, localTime] = local.localTimestampText.split(" ") as [string, string];
  const offsetMinutes = Math.round((Date.parse(`${localDate}T${localTime}Z`) - utcMs) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const hours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
  return { utc: new Date(utcMs).toISOString().replace(/\.\d{3}Z$/, "Z"), localDate, localTime, offset: `${sign}${hours}:${minutes}` };
}

/** The second a saved recording starts, as its tags record it. */
export function officialStartUtcMs(effectiveUtcMs: number): number {
  return Math.floor(effectiveUtcMs / 1000) * 1000;
}

/** The ffmpeg arguments that write `utcMs` as the recording time of a file
 * with `extension`, or null when that container has nowhere to keep one or
 * the time cannot be read in `timezone`. */
export function recordingTimeWriteArgs(extension: string, utcMs: number, timezone: string): string[] | null {
  const time = officialTime(utcMs, timezone);
  if (time === null) return null;
  const local = `${time.localDate}T${time.localTime}`;
  switch (extension.toLowerCase()) {
    case ".m4a":
    case ".mp4":
      return [...CLEARED_TIME_TAGS, "-metadata", `creation_time=${time.utc}`];
    case ".mp3":
      return [...CLEARED_TIME_TAGS, "-id3v2_version", "4", "-metadata", `date=${local}`];
    case ".aif":
    case ".aiff":
      return [...CLEARED_TIME_TAGS, "-write_id3v2", "1", "-metadata", `date=${local}`];
    case ".flac":
      return [...CLEARED_TIME_TAGS, "-metadata", `date=${local}${time.offset}`];
    case ".ogg":
    case ".oga":
      // Ogg keeps its comments with the stream, not the file.
      return [
        ...DATE_TIME_TAGS.flatMap((name) => ["-metadata:s:a:0", `${name}=`]),
        "-metadata:s:a:0", `date=${local}${time.offset}`,
      ];
    case ".wav":
      // One place only: RIFF INFO's date would reach ffprobe under the same
      // name as Broadcast Wave's.
      return [
        ...CLEARED_TIME_TAGS,
        "-write_bext", "1",
        "-metadata", `origination_date=${time.localDate}`,
        "-metadata", `origination_time=${time.localTime}`,
      ];
    default:
      return null;
  }
}

/** Whether the times read back from a saved file are the official start and
 * nothing else. */
export function carriesOnlyRecordingTime(
  candidates: readonly RecordingTimeCandidate[],
  utcMs: number,
  timezone: string,
): boolean {
  const local = recomputeLocalFromUtc(utcMs, timezone);
  return candidates.length > 0 && candidates.every((candidate) =>
    candidate.utcMs !== null ? candidate.utcMs === utcMs : candidate.localText === local.localTimestampText);
}
