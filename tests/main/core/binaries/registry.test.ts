import { describe, expect, it } from "vitest";

import {
  martinMacArch,
  normalizeToolVersion,
  parseMartinBuildVersion,
  platformIsSupported,
  toolFileName,
} from "@main/core/binaries/registry";

describe("normalizeToolVersion", () => {
  it("strips martin-riedl's URL suffix", () => {
    expect(normalizeToolVersion("8.1.1-https://www.martin-riedl.de")).toBe("8.1.1");
  });

  it("strips a leading v", () => {
    expect(normalizeToolVersion("v8.1.1")).toBe("8.1.1");
  });

  it("leaves a clean version untouched", () => {
    expect(normalizeToolVersion("8.1.1")).toBe("8.1.1");
  });
});

describe("martinMacArch", () => {
  it("maps Apple Silicon to arm64", () => {
    expect(martinMacArch("arm64")).toBe("arm64");
  });

  it("throws on Intel — mumbler ships native arm64 only", () => {
    expect(() => martinMacArch("x64")).toThrow();
  });
});

describe("parseMartinBuildVersion", () => {
  it("extracts the version from a resolved download Location", () => {
    expect(
      parseMartinBuildVersion(
        "https://ffmpeg.martin-riedl.de/download/macos/arm64/1778761665_8.1.1/ffmpeg.zip",
      ),
    ).toBe("8.1.1");
  });

  it("throws on an unparseable Location rather than inventing a version", () => {
    expect(() => parseMartinBuildVersion("https://example.com/nope/ffmpeg.zip")).toThrow();
  });
});

describe("platformIsSupported", () => {
  it("supports macOS arm64 and Windows x64 only", () => {
    expect(platformIsSupported("darwin", "arm64")).toBe(true);
    expect(platformIsSupported("win32", "x64")).toBe(true);
    expect(platformIsSupported("darwin", "x64")).toBe(false);
    expect(platformIsSupported("win32", "arm64")).toBe(false);
    expect(platformIsSupported("linux", "arm64")).toBe(false);
  });
});

describe("toolFileName", () => {
  it("adds .exe on Windows only", () => {
    expect(toolFileName("ffmpeg", "win32")).toBe("ffmpeg.exe");
    expect(toolFileName("ffprobe", "darwin")).toBe("ffprobe");
  });
});
