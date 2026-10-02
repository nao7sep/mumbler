import { describe, expect, it, vi } from "vitest";

const fetchText = vi.hoisted(() => vi.fn());
vi.mock("@main/core/binaries/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@main/core/binaries/http")>()),
  fetchText,
}));

import {
  martinMacArch,
  normalizeToolVersion,
  parseMartinBuildVersion,
  resolveLatest,
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

describe("toolFileName", () => {
  it("adds .exe on Windows only", () => {
    expect(toolFileName("ffmpeg", "win32")).toBe("ffmpeg.exe");
    expect(toolFileName("ffprobe", "darwin")).toBe("ffprobe");
  });
});

describe("Windows ffmpeg", () => {
  const asset = (name: string) => ({ name, browser_download_url: `https://example.test/${name}` });
  const release = (tag: string, zip: string) => ({
    tag_name: tag,
    assets: [asset(`ffmpeg-N-1-gabc-win64-gpl-shared.zip`), asset(zip), asset("checksums.sha256")],
  });

  it("resolves the newest immutable autobuild release and identifies it by its tag", async () => {
    fetchText.mockResolvedValueOnce(JSON.stringify([
      release("latest", "ffmpeg-master-latest-win64-gpl.zip"),
      release("autobuild-next", "ffmpeg-N-3-gccc-win64-gpl.zip"),
      release("autobuild-2026-09-26-13-03", "ffmpeg-N-126889-gb139ba11d8-win64-gpl.zip"),
      release("autobuild-2026-09-25-15-37", "ffmpeg-N-126800-gaaaaaaaaaa-win64-gpl.zip"),
    ]));
    const resolved = await resolveLatest("win32", "x64");

    expect(fetchText.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/BtbN/FFmpeg-Builds/releases?per_page=10");
    expect(resolved.version).toBe("autobuild-2026-09-26-13-03");
    expect(resolved.tools.ffmpeg).toEqual({
      downloadUrl: "https://example.test/ffmpeg-N-126889-gb139ba11d8-win64-gpl.zip",
      sha256Url: "https://example.test/checksums.sha256",
      sha256AssetName: "ffmpeg-N-126889-gb139ba11d8-win64-gpl.zip",
      innerName: "ffmpeg.exe",
    });
    expect(resolved.tools.ffprobe.innerName).toBe("ffprobe.exe");
  });

  it("refuses a list with no autobuild release", async () => {
    fetchText.mockResolvedValueOnce(JSON.stringify([release("latest", "ffmpeg-master-latest-win64-gpl.zip")]));
    await expect(resolveLatest("win32", "x64")).rejects.toThrow("No BtbN autobuild release found");
  });
});
