import type { RecordingTimeCandidate } from "@shared/app-shell";

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

function parse(value: string): RecordingTimeCandidate | null {
  const match = DATE_TIME.exec(value.trim());
  if (match === null) return null;
  const [, year, month, day, hour, minute, second = "00", zone] = match;
  const text = local(year!, month!, day!, hour!, minute!, second);
  if (zone === undefined) return { source: "embedded", utcMs: null, localText: text };
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
    add({ source: "embedded", utcMs: null, localText: local(date[1]!, date[2]!, date[3]!, time[1]!, time[2]!, time[3] ?? "00") });
  }
  return found;
}
