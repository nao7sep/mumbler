import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ToolName } from "@shared/app-shell";
import { FFMPEG_BUILD_TAG } from "@shared/dependency-status";
import { formatUtcIsoCompact } from "@shared/timestamps";

import { runTool } from "../audio-tools";
import { writeJsonFile } from "../file-io";
import { fileHeader, FORMATS, recordedFormatVersion } from "../format-versions";
import { normalizeToolVersion } from "./registry";
import { sha256OfFile } from "./integrity";

// The installed version of a managed tool, read FROM THE ARTIFACT
// (managed-runtime-dependencies-conventions).
//
// It used to be persisted in dependencies.json, one file away from the binary it
// described, with nothing keeping the two in step — so any install that failed to
// write the record (one predating the tracking, an interrupted install, a
// hand-placed file, the facts file deleted to clear something else) stranded a
// present tool as permanently unversioned, which the derivation can only read as
// "installed (not checked)": never up to date, never update-available, and so never
// offering the update that exists. Reading the version where presence is read makes
// that state unreachable rather than merely unlikely.
//
// Two sources, chosen by whether the tool's own version can be compared with what
// the source calls "latest":
//
//   probe    macOS. martin-riedl builds a numbered upstream release, and the
//            binary's banner names that same release — one namespace, so the
//            artifact can answer for itself.
//   sidecar  Windows. BtbN ships rolling master builds (`N-119123-g…`) under a
//            release tagged with its build time; the two never meet, so the
//            build tag is recorded beside the binary at install instead, and a
//            sidecar holding anything else reads as version unreadable.
//
// A probe is a subprocess spawn, so callers hold the answer for the process (the
// manager's map) and re-read only after an install replaces the binary — it must
// never sit on a render path.

export type InstalledVersionSource = { kind: "probe"; args: readonly string[] } | { kind: "sidecar" };

// Long enough for a cold start off a spun-down disk, short enough that a wedged
// binary cannot stall startup behind it.
const PROBE_TIMEOUT_MS = 10_000;

export function installedVersionSource(platform: string): InstalledVersionSource {
  return platform === "win32" ? { kind: "sidecar" } : { kind: "probe", args: ["-version"] };
}

// Both tools open with `<name> version <version> Copyright (c) …`; ffmpeg's carries
// martin-riedl's `-https://…` builder suffix, which normalizeToolVersion strips so
// the result matches the version parsed out of the resolved build id. Output that
// does not match yields null rather than becoming a version.
export function parseVersionBanner(name: ToolName, stdout: string): string | null {
  const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
  const match = new RegExp(`^${name} version (\\S+)`).exec(first);
  return match ? normalizeToolVersion(match[1]) : null;
}

// `bin/<name>.json` beside `bin/<name>[.exe]` — stem plus the role extension, never
// a suffix dot-appended to the full filename, per the derived-filename grammar.
export function versionSidecarPath(binDir: string, name: ToolName): string {
  return join(binDir, `${name}.json`);
}

interface VersionSidecar extends ReturnType<typeof fileHeader> {
  version: string;
  installedAt: string;
  binarySha256: string;
}

// Record a just-published binary's version beside it. Called only for a
// sidecar-read tool, and only AFTER the binary itself has landed: a crash between
// the two leaves a present binary reading version-unknown (which offers a
// re-acquire), where writing the sidecar first would leave the OLD binary wearing
// the NEW version's label and reading as up to date.
export async function writeVersionSidecar(
  binDir: string,
  name: ToolName,
  version: string,
  nowUtc: number,
  toolPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const payload: VersionSidecar = {
    ...fileHeader(FORMATS.toolVersion),
    version,
    installedAt: formatUtcIsoCompact(nowUtc),
    binarySha256: await sha256OfFile(toolPath, signal),
  };
  const target = versionSidecarPath(binDir, name);
  // Atomic replace through a same-directory temp, per the storage-path conventions.
  // not recorded: a sidecar colocated in the binary-bearing bin/ directory, describing
  // the re-fetchable binary it sits beside — meaningless without that binary (itself
  // excluded as a re-fetchable binary) and rewritten by the next install, so it rides
  // along into exclusion rather than being recorded orphaned (data-backup conventions).
  await writeJsonFile(target, payload, { record: false });
}

// The installed version of `name`, or null for an absent/unusable sidecar.
// Execution and access failures propagate to the manager's diagnostic owner.
// Null is NOT "absent" and never reads as up to date: there is nothing to compare,
// so the derivation holds the tool at installed-unchecked. Callers check presence
// first; an absent tool has no version to read.
export async function readInstalledVersion(
  name: ToolName,
  toolPath: string,
  binDir: string,
  source: InstalledVersionSource,
): Promise<string | null> {
  if (source.kind === "sidecar") {
    return readSidecar(binDir, name, toolPath);
  }
  return probeToolVersion(name, toolPath, undefined, source.args);
}

/** A successful process and recognizable banner establish staged viability. */
export async function probeToolVersion(name: ToolName, toolPath: string, signal?: AbortSignal, args: readonly string[] = ["-version"]): Promise<string> {
  const { stdout } = await runTool(toolPath, [...args], { timeoutMs: PROBE_TIMEOUT_MS, signal });
  const version = parseVersionBanner(name, stdout);
  if (version === null) throw new Error(`${name} did not report a recognizable version.`);
  return version;
}

/** The tool sidecars in `binDir` that a newer Mumbler wrote, which stop launch. Nothing is written. */
export async function newerVersionSidecars(binDir: string, names: readonly ToolName[]): Promise<string[]> {
  const newer: string[] = [];
  for (const name of names) {
    const path = versionSidecarPath(binDir, name);
    try {
      const raw: unknown = JSON.parse(await readFile(path, "utf8"));
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const recorded = recordedFormatVersion(raw as Record<string, unknown>, FORMATS.toolVersion);
      if (recorded !== null && recorded > FORMATS.toolVersion.version) newer.push(path);
    } catch {
      // Absent or unreadable: a cache, rebuilt by the next install.
    }
  }
  return newer;
}

async function readSidecar(binDir: string, name: ToolName, toolPath: string): Promise<string | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(versionSidecarPath(binDir, name), "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (recordedFormatVersion(raw as Record<string, unknown>, FORMATS.toolVersion) !== FORMATS.toolVersion.version) return null;
    const sidecar = raw as Partial<VersionSidecar>;
    if (typeof sidecar.version !== "string" || !FFMPEG_BUILD_TAG.test(sidecar.version)
      || typeof sidecar.binarySha256 !== "string" || !/^[a-f0-9]{64}$/.test(sidecar.binarySha256)) return null;
    return await sha256OfFile(toolPath) === sidecar.binarySha256 ? sidecar.version : null;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
