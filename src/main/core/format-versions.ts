// The identity header of every file Mumbler writes in a format of its own
// (file-identity-conventions): `format` says what the file is, `writer` which
// release wrote it. Imported with its extension by the SQLite worker engines,
// which Node runs with type stripping, so it holds erasable syntax only.

export const FORMAT_OWNER = "mumbler";

/** One of Mumbler's formats: its kind and the version this build reads and writes. */
export interface FileFormat {
  readonly kind: string;
  readonly version: number;
}

export const FORMATS = {
  /** config.json */
  config: { kind: "config", version: 1 },
  /** cards/<id>/card.json */
  card: { kind: "card", version: 1 },
  /** inbox/<id>/import.json, a pending import's review choices */
  pendingImport: { kind: "pendingImport", version: 1 },
  /** layout.json */
  layout: { kind: "layout", version: 1 },
  /** api-keys.json */
  apiKeys: { kind: "apiKeys", version: 1 },
  /** dependencies.json */
  dependencies: { kind: "dependencies", version: 1 },
  /** bin/<tool>.json, the installed version beside a managed tool */
  toolVersion: { kind: "toolVersion", version: 1 },
  /** records.sqlite3 */
  records: { kind: "records", version: 1 },
  /** backups.sqlite3, one row per file per launch */
  backups: { kind: "backups", version: 1 },
  /** The .json written beside a saved recording */
  outputJson: { kind: "sidecar", version: 1 },
  /** The front matter of the .md written beside a saved recording */
  outputMarkdown: { kind: "transcript", version: 1 },
} as const satisfies Record<string, FileFormat>;

/** The program that serialized a file; written on every save and never read. */
export interface FileWriter {
  readonly name: string;
  readonly version: string;
}

/** This app as a file's writer. Not for the worker engines, which are not built with the define. */
export function appWriter(): FileWriter {
  return { name: "mumbler", version: __APP_VERSION__ };
}

/** The header that opens a file of `format`, its two objects first. */
export function fileHeader(format: FileFormat, writer: FileWriter = appWriter()): { format: { owner: string; kind: string; version: number }; writer: FileWriter } {
  return { format: { owner: FORMAT_OWNER, kind: format.kind, version: format.version }, writer: { name: writer.name, version: writer.version } };
}

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
 * The format version a document's header records when the header names it a
 * Mumbler file of `expected`'s kind, or null when the header is missing,
 * malformed or names another owner or kind, which makes the file unreadable.
 * `writer` is never read.
 */
export function recordedFormatVersion(document: Record<string, unknown>, expected: FileFormat): number | null {
  const format = document.format;
  if (format === null || typeof format !== "object" || Array.isArray(format)) return null;
  const { owner, kind, version } = format as Record<string, unknown>;
  if (typeof owner !== "string" || typeof kind !== "string" || owner !== FORMAT_OWNER || kind !== expected.kind) return null;
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 1 ? version : null;
}

/** A document's content: everything but its header. */
export function withoutHeader(document: Record<string, unknown>): Record<string, unknown> {
  const { format: _format, writer: _writer, ...content } = document;
  return content;
}
