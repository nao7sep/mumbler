import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { describe, expect, it } from "vitest";

import { ByteLimit } from "@main/core/binaries/archive";

describe("ByteLimit", () => {
  it("passes a stream at the extracted-byte ceiling", async () => {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });

    await pipeline(Readable.from([Buffer.from("12"), Buffer.from("345")]), new ByteLimit(5, "tool"), sink);

    expect(Buffer.concat(chunks).toString("utf8")).toBe("12345");
  });

  it("rejects the crossing chunk before it reaches the destination", async () => {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });

    await expect(
      pipeline(Readable.from([Buffer.from("1234"), Buffer.from("56")]), new ByteLimit(5, "tool"), sink),
    ).rejects.toThrow(/exceeded cap 5 bytes/);
    expect(Buffer.concat(chunks).toString("utf8")).toBe("1234");
  });
});
