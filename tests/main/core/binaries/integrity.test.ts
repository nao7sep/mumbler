import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  IntegrityError,
  parseSha256Sidecar,
  sha256OfFile,
  verifySha256,
} from "@main/core/binaries/integrity";

const HASH = "a05b1a47bb3ac89a95a55eec713f8bbb347051bb07015f3b7d08fb62ed81a21e";

describe("parseSha256Sidecar", () => {
  it("reads a martin-riedl single-asset sidecar", () => {
    expect(parseSha256Sidecar(`${HASH}  ffmpeg.zip\n`, "ffmpeg.zip")).toBe(HASH);
  });

  it("finds the named asset in a combined checksums file (BtbN shape)", () => {
    const text = [
      `${"0".repeat(64)}  ffmpeg-master-latest-linux64-gpl.tar.xz`,
      `${HASH}  ffmpeg-master-latest-win64-gpl.zip`,
    ].join("\n");
    expect(parseSha256Sidecar(text, "ffmpeg-master-latest-win64-gpl.zip")).toBe(HASH);
  });

  it("tolerates a binary-mode asterisk marker", () => {
    expect(parseSha256Sidecar(`${HASH} *ffmpeg.zip`, "ffmpeg.zip")).toBe(HASH);
  });

  it("returns null when the asset is not listed", () => {
    expect(parseSha256Sidecar(`${HASH}  other.zip\n`, "ffmpeg.zip")).toBeNull();
  });
});

describe("verifySha256", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mumbler-integrity-"));
    file = join(dir, "asset.bin");
    await writeFile(file, "the downloaded bytes");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("passes when the file matches its own SHA-256 (case-insensitive)", async () => {
    const actual = await sha256OfFile(file);
    await expect(verifySha256(file, actual)).resolves.toBeUndefined();
    await expect(verifySha256(file, actual.toUpperCase())).resolves.toBeUndefined();
  });

  it("throws IntegrityError on a mismatch", async () => {
    await expect(verifySha256(file, "b".repeat(64))).rejects.toBeInstanceOf(IntegrityError);
  });

  it("throws IntegrityError on a malformed expected digest rather than passing it through", async () => {
    await expect(verifySha256(file, "not-a-sha")).rejects.toBeInstanceOf(IntegrityError);
  });
});
