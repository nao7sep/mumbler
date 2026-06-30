import type { ToolName } from "@shared/app-shell";

import { fetchText, resolveRedirectLocation } from "./http";

// The source registry for mumbler's audio tools. ffmpeg and ffprobe are fetched
// as native arm64 builds from martin-riedl.de on macOS and from BtbN on Windows,
// each verified against the vendor's published SHA-256. Both sources are
// single-/community-maintainer (a deliberate Tier-3 acceptance under the
// native-binary-and-model-delivery-conventions' warn-and-escalate rule; a
// fleet-owned re-host is the named future escalation). The npm `ffmpeg-static`/
// `ffprobe-static` wrappers are not used — they freeze years behind upstream and
// ship an x86_64 ffprobe that fails the arm64/lipo gate.

export const TOOL_NAMES: readonly ToolName[] = ["ffmpeg", "ffprobe"];

// A generous per-archive cap; the real builds are ~28 MB.
export const TOOL_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;

// What `resolveLatest` yields for one tool: where to download it, where its
// checksum lives, the asset name to match inside that checksum file, and the file
// to extract from the archive.
export interface ResolvedTool {
  downloadUrl: string;
  sha256Url: string;
  sha256AssetName: string;
  innerName: string;
}

export interface ResolvedTools {
  version: string; // normalized; shared by both tools (one upstream build)
  tools: Record<ToolName, ResolvedTool>;
}

// A managed dependency's runtime version strings carry vendor noise — martin-riedl
// appends `-https://www.martin-riedl.de`, some tools prefix `v`. Normalize before
// storing/comparing so the update check never reports a phantom update.
export function normalizeToolVersion(raw: string): string {
  let value = raw.trim();
  value = value.replace(/-https?:\/\/\S+$/i, "");
  value = value.replace(/^v/i, "");
  return value.trim();
}

// martin-riedl maps Apple Silicon to `arm64`; Intel would be `amd64` (unsupported
// here — the whole point is native arm64).
export function martinMacArch(arch: string): string {
  if (arch === "arm64") {
    return "arm64";
  }
  throw new Error(
    `Mumbler ships native Apple Silicon only; unsupported macOS architecture "${arch}". ` +
      `Install ffmpeg/ffprobe yourself and place them on PATH, or run on Apple Silicon.`,
  );
}

// A resolved download Location is `.../download/<os>/<arch>/<buildId>_<version>/<file>`.
// Pull the version out of the `<buildId>_<version>` segment. Throws on an
// unparseable Location rather than inventing a version.
export function parseMartinBuildVersion(location: string): string {
  const match = /\/download\/[^/]+\/[^/]+\/(\d+)_([^/]+)\//.exec(location);
  if (!match) {
    throw new Error(`could not parse a martin-riedl build version from: ${location}`);
  }
  return normalizeToolVersion(match[2]);
}

async function resolveMartinMac(arch: string): Promise<ResolvedTools> {
  const a = martinMacArch(arch);
  const base = `https://ffmpeg.martin-riedl.de/redirect/latest/macos/${a}/release`;

  // Resolve ffmpeg's redirect to get the versioned directory + version; ffprobe
  // lives in the same build directory, so derive its URL from the same dir.
  const ffmpegLocation = await resolveRedirectLocation(`${base}/ffmpeg.zip`);
  const version = parseMartinBuildVersion(ffmpegLocation);
  const dir = ffmpegLocation.replace(/\/ffmpeg\.zip$/, "");

  const tool = (name: ToolName): ResolvedTool => ({
    downloadUrl: `${dir}/${name}.zip`,
    sha256Url: `${dir}/${name}.zip.sha256`,
    sha256AssetName: `${name}.zip`,
    innerName: name,
  });

  return { version, tools: { ffmpeg: tool("ffmpeg"), ffprobe: tool("ffprobe") } };
}

interface GithubAsset {
  name: string;
  browser_download_url: string;
}
interface GithubRelease {
  tag_name: string;
  assets: GithubAsset[];
}

async function resolveBtbNWindows(arch: string): Promise<ResolvedTools> {
  if (arch !== "x64") {
    throw new Error(`Mumbler ships Windows x64 only; unsupported Windows architecture "${arch}".`);
  }
  // BtbN publishes a rolling `latest` release; one GPL zip carries both .exe's.
  const raw = await fetchText("https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest", {
    "User-Agent": "mumbler",
    Accept: "application/vnd.github+json",
  });
  const release = JSON.parse(raw) as GithubRelease;
  const zipName = "ffmpeg-master-latest-win64-gpl.zip";
  const zip = release.assets.find((asset) => asset.name === zipName);
  const sums = release.assets.find((asset) => asset.name === "checksums.sha256");
  if (!zip || !sums) {
    throw new Error(`BtbN latest release is missing ${zipName} or checksums.sha256`);
  }
  const tool = (exe: string): ResolvedTool => ({
    downloadUrl: zip.browser_download_url,
    sha256Url: sums.browser_download_url,
    sha256AssetName: zipName,
    innerName: exe,
  });
  return {
    version: normalizeToolVersion(release.tag_name),
    tools: { ffmpeg: tool("ffmpeg.exe"), ffprobe: tool("ffprobe.exe") },
  };
}

// Resolve the latest available build for the running platform/arch. Throws a
// clear, actionable error on an unsupported target (Intel macOS, Linux) — there
// is no trustworthy native-arm64 automatic source wired for those.
export async function resolveLatest(platform: string, arch: string): Promise<ResolvedTools> {
  if (platform === "darwin") {
    return resolveMartinMac(arch);
  }
  if (platform === "win32") {
    return resolveBtbNWindows(arch);
  }
  throw new Error(
    `no managed ffmpeg/ffprobe source for platform "${platform}"; install them yourself and place them on PATH.`,
  );
}

// Whether the running platform has a wired managed source at all (used to decide
// whether to even surface the Audio Tools provisioning flow).
export function platformIsSupported(platform: string, arch: string): boolean {
  try {
    if (platform === "darwin") {
      martinMacArch(arch);
      return true;
    }
    return platform === "win32" && arch === "x64";
  } catch {
    return false;
  }
}

// The on-disk executable name for a tool on this platform.
export function toolFileName(name: ToolName, platform: string): string {
  return platform === "win32" ? `${name}.exe` : name;
}
