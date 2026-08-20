import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  installedVersionSource,
  parseVersionBanner,
  readInstalledVersion,
  versionSidecarPath,
  writeVersionSidecar,
} from "@main/core/binaries/installed-version";

// The installed version is read from the artifact, never from the facts store
// (managed-runtime-dependencies-conventions): what the binary says it is, or —
// where its version and the source's "latest" live in different namespaces — what
// the install recorded beside it.

let binDir: string;

beforeEach(async () => {
  binDir = await mkdtemp(join(tmpdir(), "mumbler-ver-"));
});

afterEach(async () => {
  await rm(binDir, { recursive: true, force: true });
});

describe("parseVersionBanner", () => {
  it("reads ffmpeg's real banner and drops the martin-riedl builder suffix", () => {
    const stdout =
      "ffmpeg version 8.1.1-https://www.martin-riedl.de Copyright (c) 2000-2026 the FFmpeg developers\n" +
      "built with Apple clang version 14.0.0\n";
    expect(parseVersionBanner("ffmpeg", stdout)).toBe("8.1.1");
  });

  it("reads ffprobe's, which names itself", () => {
    const stdout = "ffprobe version 8.1.1-https://www.martin-riedl.de Copyright (c) 2007-2026\n";
    expect(parseVersionBanner("ffprobe", stdout)).toBe("8.1.1");
  });

  it("refuses the other tool's banner, so a mixed-up path can't report a version", () => {
    expect(parseVersionBanner("ffprobe", "ffmpeg version 8.1.1 Copyright")).toBeNull();
  });

  it("refuses unrecognized output rather than inventing a version", () => {
    expect(parseVersionBanner("ffmpeg", "not an ffmpeg banner")).toBeNull();
    expect(parseVersionBanner("ffmpeg", "")).toBeNull();
  });
});

describe("installedVersionSource", () => {
  // macOS builds carry a numbered upstream release the binary itself names;
  // BtbN's Windows builds are rolling master (`N-119123-g…`) under a release named
  // by build time, so only what the install recorded is comparable.
  it("probes the binary everywhere but Windows, which reads its sidecar", () => {
    expect(installedVersionSource("darwin")).toEqual({ kind: "probe", args: ["-version"] });
    expect(installedVersionSource("win32")).toEqual({ kind: "sidecar" });
  });
});

describe("the sidecar", () => {
  it("is <stem>.json beside the binary, not a suffix on its full filename", () => {
    expect(versionSidecarPath(binDir, "ffmpeg")).toBe(join(binDir, "ffmpeg.json"));
  });

  it("round-trips the recorded version", async () => {
    await writeVersionSidecar(binDir, "ffmpeg", "Latest Auto-Build (2026-08-19 19:21)", 1_700_000_000_000);
    const read = await readInstalledVersion("ffmpeg", join(binDir, "ffmpeg.exe"), binDir, {
      kind: "sidecar",
    });
    expect(read).toBe("Latest Auto-Build (2026-08-19 19:21)");
  });

  it("records when it was installed, in canonical UTC", async () => {
    await writeVersionSidecar(binDir, "ffmpeg", "8.2", 1_700_000_000_000);
    const raw: unknown = JSON.parse(await readFile(versionSidecarPath(binDir, "ffmpeg"), "utf8"));
    expect(raw).toEqual({ version: "8.2", installedAt: "2023-11-14T22:13:20.000Z" });
  });

  it("leaves no staging file behind", async () => {
    await writeVersionSidecar(binDir, "ffmpeg", "8.2", 1_700_000_000_000);
    expect(await readdir(binDir)).toEqual(["ffmpeg.json"]);
  });

  it("is null when absent — a hand-placed binary is unversioned, never assumed current", async () => {
    expect(
      await readInstalledVersion("ffmpeg", join(binDir, "ffmpeg.exe"), binDir, { kind: "sidecar" }),
    ).toBeNull();
  });

  it("is null when unreadable or empty, rather than a blank version", async () => {
    await writeFile(versionSidecarPath(binDir, "ffmpeg"), "{ not json", "utf8");
    expect(
      await readInstalledVersion("ffmpeg", join(binDir, "ffmpeg.exe"), binDir, { kind: "sidecar" }),
    ).toBeNull();

    await writeFile(versionSidecarPath(binDir, "ffmpeg"), JSON.stringify({ version: "  " }), "utf8");
    expect(
      await readInstalledVersion("ffmpeg", join(binDir, "ffmpeg.exe"), binDir, { kind: "sidecar" }),
    ).toBeNull();
  });
});

describe("probing a binary that will not run", () => {
  it("is null, not a version and not an exception", async () => {
    const missing = join(binDir, "ffmpeg");
    expect(
      await readInstalledVersion("ffmpeg", missing, binDir, { kind: "probe", args: ["-version"] }),
    ).toBeNull();
  });
});
