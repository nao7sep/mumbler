import type { TimestampParseStatus } from "./app-shell";

interface TimestampParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const LOCAL_TIMESTAMP_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2}) (?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})$/;
const UTC_MARKER_PATTERN =
  /^(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})-(?<hour>\d{2})(?<minute>\d{2})(?<second>\d{2})-utc$/;

export function getSupportedTimezones(): string[] {
  const intlWithSupportedValues = Intl as typeof Intl & {
    supportedValuesOf?: (key: string) => string[];
  };

  const supported = intlWithSupportedValues.supportedValuesOf?.("timeZone");
  return supported && supported.length > 0 ? supported : ["UTC"];
}

export function isSupportedTimezone(timezone: string): boolean {
  return getSupportedTimezones().includes(timezone);
}

export function parseTimestampFromFilename(
  filenameStem: string,
  patterns: string[],
): { localTimestampText: string; parseStatus: TimestampParseStatus } {
  for (const pattern of patterns) {
    try {
      const match = new RegExp(pattern).exec(filenameStem);
      if (!match?.groups) {
        continue;
      }

      const parts = groupsToTimestampParts(match.groups);
      if (parts === null) {
        continue;
      }

      return {
        localTimestampText: formatLocalTimestamp(parts),
        parseStatus: "parsed",
      };
    } catch {
      continue;
    }
  }

  return {
    localTimestampText: "",
    parseStatus: "manual-required",
  };
}

export function recomputeUtcFromLocal(
  localTimestampText: string,
  timezone: string,
): { utcTimestampText: string; error: string | null } {
  const localParts = parseLocalTimestamp(localTimestampText);
  if (localParts === null) {
    return { utcTimestampText: "", error: "Enter local time as YYYY-MM-DD HH:MM:SS." };
  }

  if (!isSupportedTimezone(timezone)) {
    return { utcTimestampText: "", error: "Enter a valid IANA timezone." };
  }

  const utcDate = zonedLocalToUtcDate(localParts, timezone);
  if (utcDate === null) {
    return { utcTimestampText: "", error: "Could not convert local time to UTC." };
  }

  return { utcTimestampText: formatUtcMarker(utcDate), error: null };
}

export function recomputeLocalFromUtc(
  utcTimestampText: string,
  timezone: string,
): { localTimestampText: string; error: string | null } {
  const utcDate = parseUtcMarker(utcTimestampText);
  if (utcDate === null) {
    return { localTimestampText: "", error: "Enter UTC as yyyymmdd-hhmmss-utc." };
  }

  if (!isSupportedTimezone(timezone)) {
    return { localTimestampText: "", error: "Enter a valid IANA timezone." };
  }

  return {
    localTimestampText: formatLocalTimestamp(getZonedParts(utcDate, timezone)),
    error: null,
  };
}

export function getLocalTimestampError(localTimestampText: string): string | null {
  return parseLocalTimestamp(localTimestampText) === null
    ? "Enter local time as YYYY-MM-DD HH:MM:SS."
    : null;
}

export function getUtcTimestampError(utcTimestampText: string): string | null {
  return parseUtcMarker(utcTimestampText) === null
    ? "Enter UTC as yyyymmdd-hhmmss-utc."
    : null;
}

export function formatLocalTimestamp(parts: TimestampParts): string {
  return `${parts.year.toString().padStart(4, "0")}-${parts.month
    .toString()
    .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")} ${parts.hour
    .toString()
    .padStart(2, "0")}:${parts.minute.toString().padStart(2, "0")}:${parts.second
    .toString()
    .padStart(2, "0")}`;
}

export function formatUtcMarker(date: Date): string {
  return `${date.getUTCFullYear().toString().padStart(4, "0")}${(date.getUTCMonth() + 1)
    .toString()
    .padStart(2, "0")}${date.getUTCDate().toString().padStart(2, "0")}-${date
    .getUTCHours()
    .toString()
    .padStart(2, "0")}${date.getUTCMinutes().toString().padStart(2, "0")}${date
    .getUTCSeconds()
    .toString()
    .padStart(2, "0")}-utc`;
}

export function nowUtcMarker(): string {
  return formatUtcMarker(new Date());
}

export function normalizeUtcMarkerText(value: string, fallback: string = nowUtcMarker()): string {
  const markerDate = parseUtcMarker(value.toLowerCase());
  if (markerDate !== null) {
    return formatUtcMarker(markerDate);
  }

  const parsedDate = new Date(value);
  if (!Number.isNaN(parsedDate.getTime())) {
    return formatUtcMarker(parsedDate);
  }

  return fallback;
}

function parseLocalTimestamp(value: string): TimestampParts | null {
  const match = LOCAL_TIMESTAMP_PATTERN.exec(value);
  if (!match?.groups) {
    return null;
  }
  return groupsToTimestampParts(match.groups);
}

function parseUtcMarker(value: string): Date | null {
  const match = UTC_MARKER_PATTERN.exec(value);
  if (!match?.groups) {
    return null;
  }

  const parts = groupsToTimestampParts(match.groups);
  if (parts === null) {
    return null;
  }

  return new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second),
  );
}

function groupsToTimestampParts(groups: Record<string, string>): TimestampParts | null {
  let year: number;
  const yearStr = groups.year;
  if (yearStr === undefined) return null;
  const yearNum = Number(yearStr);
  if (!Number.isInteger(yearNum) || Number.isNaN(yearNum)) return null;
  if (yearStr.length === 2) {
    year = yearNum < 70 ? 2000 + yearNum : 1900 + yearNum;
  } else {
    year = yearNum;
  }
  const month = Number(groups.month);
  const day = Number(groups.day);
  const hour = Number(groups.hour);
  const minute = Number(groups.minute);
  const secondRaw = groups.second !== undefined ? Number(groups.second) : 0;
  const second = Number.isInteger(secondRaw) && !Number.isNaN(secondRaw) ? secondRaw : 0;

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute)
  ) {
    return null;
  }

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }

  return { year, month, day, hour, minute, second };
}

function zonedLocalToUtcDate(parts: TimestampParts, timezone: string): Date | null {
  let candidateMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  for (let index = 0; index < 6; index += 1) {
    const zonedParts = getZonedParts(new Date(candidateMs), timezone);
    const deltaMs =
      Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
      Date.UTC(
        zonedParts.year,
        zonedParts.month - 1,
        zonedParts.day,
        zonedParts.hour,
        zonedParts.minute,
        zonedParts.second,
      );

    if (deltaMs === 0) {
      return new Date(candidateMs);
    }

    candidateMs += deltaMs;
  }

  return null;
}

function getZonedParts(date: Date, timezone: string): TimestampParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(date);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(lookup.get("year")),
    month: Number(lookup.get("month")),
    day: Number(lookup.get("day")),
    hour: Number(lookup.get("hour")),
    minute: Number(lookup.get("minute")),
    second: Number(lookup.get("second")),
  };
}
