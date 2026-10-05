// The format version of every store Mumbler writes, one integer per format
// (store-recovery-conventions). Imported with its extension by the SQLite worker
// engines, which Node runs with type stripping, so it holds erasable syntax only.
export const FORMAT_VERSIONS = {
  /** config.json */
  config: 1,
  /** queue.json */
  queue: 1,
  /** transcripts/<card>.json */
  transcript: 1,
  /** layout.json */
  layout: 1,
  /** api-keys.json */
  apiKeys: 1,
  /** dependencies.json */
  dependencies: 1,
  /** bin/<tool>.json, the installed version beside a managed tool */
  toolVersion: 1,
  /** records.sqlite3 */
  records: 1,
  /** backups.sqlite3 */
  backups: 1,
  /** The .json written beside a saved recording */
  outputJson: 1,
  /** The front matter of the .md written beside a saved recording */
  outputMarkdown: 1,
} as const;

/**
 * A store records a format version newer than this build reads. The data is
 * intact, so the file is left exactly as it is for the version that wrote it.
 */
export class NewerFormatError extends Error {
  readonly filePath: string;
  readonly recorded: number;
  readonly supported: number;

  constructor(filePath: string, recorded: number, supported: number) {
    super(`${filePath} records format version ${recorded}, newer than this build reads (${supported}).`);
    this.name = "NewerFormatError";
    this.filePath = filePath;
    this.recorded = recorded;
    this.supported = supported;
  }
}

/**
 * The format version a JSON document records in `formatVersion`. A missing
 * marker reads as 1; null means the marker is not a positive integer.
 */
export function recordedFormatVersion(document: Record<string, unknown>): number | null {
  const marker = document.formatVersion;
  if (marker === undefined) return 1;
  return typeof marker === "number" && Number.isSafeInteger(marker) && marker >= 1 ? marker : null;
}
