import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMediaResponse, parseByteRange } from "@main/media-response";

describe("parseByteRange", () => {
  it("serves the whole file without a usable single range", () => {
    expect(parseByteRange(null, 100)).toBeNull();
    expect(parseByteRange("bytes=-", 100)).toBeNull();
    expect(parseByteRange("bytes=0-1,5-9", 100), "several ranges").toBeNull();
    expect(parseByteRange("items=0-1", 100)).toBeNull();
  });

  it("reads open, closed and suffix ranges, clamped to the file", () => {
    expect(parseByteRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
    expect(parseByteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseByteRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange("bytes=-30", 100)).toEqual({ start: 70, end: 99 });
    expect(parseByteRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
  });

  it("refuses a range outside the file", () => {
    expect(parseByteRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=20-10", 100)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=-0", 100)).toBe("unsatisfiable");
  });
});

describe("createMediaResponse", () => {
  let dir: string;
  let file: string;
  const bytes = Buffer.from("0123456789abcdefghij");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mumbler-media-"));
    file = join(dir, "take.wav");
    await writeFile(file, bytes);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("streams the whole recording and says ranges are accepted", async () => {
    const response = await createMediaResponse(file, null, "audio/wav");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/wav");
    expect(response.headers.get("Content-Length")).toBe("20");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.body, "the body is a stream, not a buffer").toBeInstanceOf(ReadableStream);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it("answers a range with only those bytes", async () => {
    const response = await createMediaResponse(file, "bytes=5-9", "audio/wav");

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 5-9/20");
    expect(response.headers.get("Content-Length")).toBe("5");
    expect(await response.text()).toBe("56789");
  });

  it("refuses a range past the end", async () => {
    const response = await createMediaResponse(file, "bytes=40-", "audio/wav");

    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */20");
  });

  it("serves an empty recording without opening a stream", async () => {
    await writeFile(file, "");

    const response = await createMediaResponse(file, null, "audio/wav");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("0");
    expect(await response.text()).toBe("");
  });
});
