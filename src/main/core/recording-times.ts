import type { RecordingTimeCandidate } from "@shared/app-shell";
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

/** The local time the review starts with, in `timezone`: the file name's when
 * it has one, which every recorder but the iPad writes; otherwise the first
 * time stored inside the file; otherwise none. File dates are offered, never
 * chosen, since a copy or sync can change them. */
export function prefilledRecordingTime(candidates: readonly RecordingTimeCandidate[], timezone: string): string {
  const name = candidates.find((candidate) => candidate.source === "file-name");
  if (name?.localText) return name.localText;
  for (const candidate of candidates) {
    if (candidate.source !== "embedded") continue;
    if (candidate.localText !== null) return candidate.localText;
    if (candidate.utcMs !== null) {
      const local = recomputeLocalFromUtc(candidate.utcMs, timezone);
      if (local.error === null) return local.localTimestampText;
    }
  }
  return "";
}
