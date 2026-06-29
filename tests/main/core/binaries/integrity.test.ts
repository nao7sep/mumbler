import { describe, expect, it } from "vitest";

import { parseSha256Sidecar } from "@main/core/binaries/integrity";

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
