import { execFile } from "node:child_process";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { nanoid } from "nanoid";

import type { ToolName } from "@shared/app-shell";
import { formatUtcIsoCompact } from "@shared/timestamps";

import { normalizeToolVersion } from "./registry";

const execFileAsync = promisify(execFile);

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
//            release whose name is a build timestamp; the two never meet, so the
//            resolved version is recorded beside the binary at install instead.
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

interface VersionSidecar {
  version: string;
  installedAt: string;
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
): Promise<void> {
  const payload: VersionSidecar = { version, installedAt: formatUtcIsoCompact(nowUtc) };
  const target = versionSidecarPath(binDir, name);
  // Atomic replace through a same-directory temp, per the storage-path conventions.
  // not recorded: a sidecar colocated in the binary-bearing bin/ directory, describing
  // the re-fetchable binary it sits beside — meaningless without that binary (itself
  // excluded as a re-fetchable binary) and rewritten by the next install, so it rides
  // along into exclusion rather than being recorded orphaned (data-backup conventions).
  const staged = join(binDir, `${name}-${nanoid()}.tmp`);
  await writeFile(staged, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(staged, target);
}

// The installed version of `name`, or null when it cannot be read — the binary will
// not run, exits non-zero, prints something unrecognized, or its sidecar is missing.
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
    return readSidecar(binDir, name);
  }
  try {
    const { stdout } = await execFileAsync(toolPath, [...source.args], { timeout: PROBE_TIMEOUT_MS });
    return parseVersionBanner(name, stdout);
  } catch {
    return null;
  }
}

async function readSidecar(binDir: string, name: ToolName): Promise<string | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(versionSidecarPath(binDir, name), "utf8"));
    const version = (raw as Partial<VersionSidecar> | null)?.version;
    if (typeof version !== "string" || version.trim().length === 0) {
      return null;
    }
    return normalizeToolVersion(version);
  } catch {
    return null;
  }
}
