/**
 * Whole-second UTC time helpers for the backup index. Sub-second precision is deliberately dropped: the
 * modification time is compared with a two-second tolerance (see the data-backup conventions), so it
 * carries no fractional component and stays portable across filesystems (FAT/exFAT are 2-second).
 */

/** A whole-second UTC ISO-8601 stamp (`yyyy-MM-ddTHH:mm:ssZ`) from an epoch-milliseconds value. */
export function toIsoSeconds(msSinceEpoch: number): string {
  return new Date(msSinceEpoch).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Truncate an epoch-milliseconds value to the whole second. */
export function truncateToSecondMs(msSinceEpoch: number): number {
  return Math.floor(msSinceEpoch / 1000) * 1000;
}
