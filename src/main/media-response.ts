import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

export type ByteRange = { start: number; end: number };

// Reads a single-range `Range: bytes=…` header against a file of `size` bytes.
// Returns null when the whole file should be served (no header, or a form this
// handler does not serve, such as several ranges), "unsatisfiable" when the range
// lies outside the file, and otherwise the inclusive byte span.
export function parseByteRange(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
  if (header === null) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) {
    return null;
  }
  const [, startText, endText] = match;
  if (startText === "" && endText === "") {
    return null;
  }

  if (startText === "") {
    // Suffix form: the last N bytes.
    const length = Number(endText);
    if (length === 0 || size === 0) {
      return "unsatisfiable";
    }
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(startText);
  const end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1);
  if (start >= size || end < start) {
    return "unsatisfiable";
  }
  return { start, end };
}

// Serves a recording as a stream, honouring a byte range, so the main process
// never holds the file in memory and a file of any size can be played. The body
// is read from disk as the renderer consumes it; when the renderer stops reading
// (a card switch), cancelling the body closes the file.
export async function createMediaResponse(
  filePath: string,
  rangeHeader: string | null,
  contentType: string,
): Promise<Response> {
  const { size } = await stat(filePath);
  const range = parseByteRange(rangeHeader, size);

  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
    });
  }

  const span = range ?? { start: 0, end: size - 1 };
  const length = size === 0 ? 0 : span.end - span.start + 1;
  const body = length === 0
    ? null
    : (Readable.toWeb(createReadStream(filePath, { start: span.start, end: span.end })) as ReadableStream<Uint8Array>);

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(length),
    "Accept-Ranges": "bytes",
  };
  if (range !== null) {
    headers["Content-Range"] = `bytes ${span.start}-${span.end}/${size}`;
  }
  return new Response(body, { status: range === null ? 200 : 206, headers });
}
