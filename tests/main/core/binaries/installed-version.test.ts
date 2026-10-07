import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
  await writeFile(join(binDir, "ffmpeg.exe"), "binary bytes");
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

  it("round-trips the recorded build tag", async () => {
    await writeVersionSidecar(binDir, "ffmpeg", "autobuild-2026-08-19-19-21", 1_700_000_000_000, join(binDir, "ffmpeg.exe"));
    const read = await readInstalledVersion("ffmpeg", join(binDir, "ffmpeg.exe"), binDir, {
      kind: "sidecar",
    });
    expect(read).toBe("autobuild-2026-08-19-19-21");
  });

  it("reads anything but a build tag as version unreadable", async () => {
    for (const stored of ["Latest Auto-Build (2026-08-19 19:21)", "latest", "autobuild-next", ""]) {
      await writeVersionSidecar(binDir, "ffmpeg", stored, 1_700_000_000_000, join(binDir, "ffmpeg.exe"));
      expect(await readInstalledVersion("ffmpeg", join(binDir, "ffmpeg.exe"), binDir, { kind: "sidecar" }), stored).toBeNull();
    }
  });

  it("records when it was installed, in canonical UTC", async () => {
    await writeVersionSidecar(binDir, "ffmpeg", "8.2", 1_700_000_000_000, join(binDir, "ffmpeg.exe"));
    const raw: unknown = JSON.parse(await readFile(versionSidecarPath(binDir, "ffmpeg"), "utf8"));
    expect(raw).toEqual({ formatVersion: 1, version: "8.2", installedAt: "2023-11-14T22:13:20.000Z", binarySha256: createHash("sha256").update("binary bytes").digest("hex") });
  });

  it.skipIf(process.platform === "win32")("keeps the mode of the sidecar it replaces", async () => {
    await writeVersionSidecar(binDir, "ffmpeg", "8.1", 1_700_000_000_000, join(binDir, "ffmpeg.exe"));
    await chmod(versionSidecarPath(binDir, "ffmpeg"), 0o640);

    await writeVersionSidecar(binDir, "ffmpeg", "8.2", 1_700_000_000_000, join(binDir, "ffmpeg.exe"));

    expect((await stat(versionSidecarPath(binDir, "ffmpeg"))).mode & 0o777).toBe(0o640);
  });

  it("leaves no staging file behind", async () => {
    await writeVersionSidecar(binDir, "ffmpeg", "8.2", 1_700_000_000_000, join(binDir, "ffmpeg.exe"));
    expect(await readdir(binDir)).toEqual(["ffmpeg.exe", "ffmpeg.json"]);
  });

  it("is null when absent — a hand-placed binary is unversioned, never assumed current", async () => {
    expect(
      await readInstalledVersion("ffmpeg", join(binDir, "ffmpeg.exe"), binDir, { kind: "sidecar" }),
    ).toBeNull();
  });

  it("reads a sidecar without its format version, or in a newer format, as unreadable, untouched", async () => {
    const tag = "autobuild-2026-08-19-19-21";
    const read = () => readInstalledVersion("ffmpeg", join(binDir, "ffmpeg.exe"), binDir, { kind: "sidecar" });
    await writeFile(versionSidecarPath(binDir, "ffmpeg"), JSON.stringify({ version: tag }), "utf8");
    expect(await read()).toBeNull();

    const newer = JSON.stringify({ formatVersion: 2, version: tag });
    await writeFile(versionSidecarPath(binDir, "ffmpeg"), newer, "utf8");
    expect(await read()).toBeNull();
    expect(await readFile(versionSidecarPath(binDir, "ffmpeg"), "utf8")).toBe(newer);
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


describe("sidecar publication admission and identity", () => {
  it("refuses to replace a newer sidecar through the writer", async () => {
    const path = versionSidecarPath(binDir, "ffmpeg");
    const newer = JSON.stringify({ formatVersion: 2, version: "future" });
    await writeFile(path, newer);
    await expect(writeVersionSidecar(binDir, "ffmpeg", "8.2", 0, join(binDir, "ffmpeg.exe"))).rejects.toMatchObject({ name: "NewerFormatError" });
    expect(await readFile(path, "utf8")).toBe(newer);
    expect(await readdir(binDir)).toEqual(["ffmpeg.exe", "ffmpeg.json"]);
  });

  it("does not attribute an old sidecar to a replaced binary on a fresh read", async () => {
    const tool = join(binDir, "ffmpeg.exe");
    await writeVersionSidecar(binDir, "ffmpeg", "autobuild-2026-08-19-19-21", 0, tool);
    await writeFile(tool, "new binary bytes");
    expect(await readInstalledVersion("ffmpeg", tool, binDir, { kind: "sidecar" })).toBeNull();
  });

  it("cancellation leaves the previous sidecar intact", async () => {
    const path = versionSidecarPath(binDir, "ffmpeg");
    await writeFile(path, "previous");
    const controller = new AbortController();
    const primary = new Error("cancelled");
    controller.abort(primary);
    await expect(writeVersionSidecar(binDir, "ffmpeg", "8.2", 0, join(binDir, "ffmpeg.exe"), controller.signal)).rejects.toBe(primary);
    expect(await readFile(path, "utf8")).toBe("previous");
    expect(await readdir(binDir)).toEqual(["ffmpeg.exe", "ffmpeg.json"]);
  });
});
