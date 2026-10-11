import { createReadStream } from "node:fs";
import { link, mkdir, mkdtemp, open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { nanoid } from "nanoid";

import type { MumblerCard, SaveOutputFile } from "@shared/app-shell";
import { formatUtcIsoCompact } from "@shared/timestamps";
import { CancelledError, isCancelledError, isNodeAbortError } from "./cancellation";
import {
  fileExists,
  formatError,
  keepReplacedMode,
  sameFileBytes,
  syncDirectory,
} from "./file-io";
import { FORMAT_VERSIONS } from "./format-versions";

// A save that must not overwrite found one of its targets already taken when
// it came to publish: someone wrote that name after the conflict check.
export class OutputConflictError extends Error {
  constructor(readonly targetPath: string) {
    super(`An output already exists at ${targetPath}.`);
    this.name = "OutputConflictError";
  }
}

export class OutputLocationError extends Error {
  constructor() { super("Output location overlaps an input or disposable audio directory."); this.name = "OutputLocationError"; }
}

// Filesystems without hard links (FAT, exFAT, some network shares) refuse
// link() with one of these codes rather than EEXIST.
const HARD_LINK_UNSUPPORTED_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export interface OutputCleanupIssue {
  operation: string;
  path: string;
  error: unknown;
}

// A failed publication leaves completed outputs in place. Cleanup failures are
// secondary; the caller retains the working card for another save attempt.
export class OutputPartialFailureError extends AggregateError {
  constructor(readonly primary: unknown, readonly files: SaveOutputFile[], readonly issues: OutputCleanupIssue[]) {
    super([primary, ...issues.map((issue) => issue.error)], "Output save did not finish.", { cause: primary });
    this.name = "OutputPartialFailureError";
  }
}

// Audio is streamed into a private stage, retaining copy mtime and ordinary mode.
async function stageAudio(source: string, destination: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new CancelledError("Save cancelled.");
  const handle = await open(destination, "wx", 0o600);
  const stream = createReadStream(source, { signal });
  stream.on("error", () => undefined);
  let primary: unknown;
  try {
    await handle.writeFile(stream);
    const sourceInfo = await stat(source);
    await handle.utimes(sourceInfo.atime, sourceInfo.mtime);
    await handle.chmod(sourceInfo.mode);
    await handle.sync();
  } catch (error) { primary = error; }
  finally {
    stream.destroy();
    try { await handle.close(); }
    catch (error) {
      if (primary !== undefined) throw new AggregateError([primary, error], "Audio staging and close failed.", { cause: primary });
      throw error;
    }
  }
  if (primary !== undefined) throw primary;
}

// Fresh names must remain exclusive even on volumes without hard links.
// A failed copy can leave an incomplete target; it is reported, never rolled back.
async function publishExclusive(source: string, destination: string): Promise<void> {
  try {
    try { await link(source, destination); }
    catch (error) {
      if (!HARD_LINK_UNSUPPORTED_CODES.has(errorCode(error) ?? "")) throw error;
      await stageAudio(source, destination);
    }
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new OutputConflictError(destination);
    throw error;
  }
}

export interface SaveTargetPaths {
  audioPath: string;
  jsonPath: string;
  markdownPath: string;
}

export async function pathsConflict(targets: SaveTargetPaths): Promise<boolean> {
  const exists = await Promise.all([
    fileExists(targets.audioPath),
    fileExists(targets.jsonPath),
    fileExists(targets.markdownPath),
  ]);
  return exists.some((value) => value);
}

export async function buildUniqueSuffixedTargets(
  outputDirectory: string,
  baseName: string,
  extension: string,
): Promise<SaveTargetPaths> {
  while (true) {
    const suffixedBase = `${baseName}-${nanoid(8)}`;
    const candidate: SaveTargetPaths = {
      audioPath: join(outputDirectory, `${suffixedBase}${extension}`),
      jsonPath: join(outputDirectory, `${suffixedBase}.json`),
      markdownPath: join(outputDirectory, `${suffixedBase}.md`),
    };
    if (!(await pathsConflict(candidate))) {
      return candidate;
    }
  }
}

// Reserve only overlapping groups. Every earlier live intersection matters:
// cancelling a pending bridge must not let a later group bypass its predecessor.
const publications = new Set<{ keys: Set<string>; released: Promise<void> }>();

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

async function reservePublication(paths: string[], signal?: AbortSignal): Promise<() => void> {
  const keys = new Set((await Promise.all(paths.map(async (path) => {
    // Keep the directory entry as well as an existing symlink's target: equality
    // reads follow symlinks, whereas replacement publishes at the literal entry.
    const entry = join(await canonicalPath(dirname(path)), basename(path));
    const target = await canonicalPath(path);
    // Conservative identity on case-sensitive volumes is harmless exclusion;
    // actual filesystem operations retain the user's literal paths.
    return [entry, target].map((value) => value.normalize("NFC").toLowerCase());
  }))).flat());
  if (signal?.aborted) throw new CancelledError("Save cancelled.");
  const previous = [...publications].filter((publication) =>
    [...publication.keys].some((key) => keys.has(key)),
  );
  let resolveRelease!: () => void;
  const publication = { keys, released: new Promise<void>((resolve) => { resolveRelease = resolve; }) };
  const release = () => { publications.delete(publication); resolveRelease(); };
  // Capture predecessors and register without an intervening await, so groups
  // never acquire members separately or deadlock on partially overlapping trios.
  publications.add(publication);
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = () => reject(new CancelledError("Save cancelled."));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      void Promise.all(previous.map((value) => value.released)).then(() => resolve());
    });
    if (signal?.aborted) throw new CancelledError("Save cancelled.");
    return release;
  } catch (error) {
    release();
    throw error;
  } finally {
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

export async function finalizeOutputs(params: {
  sourceAudioPath: string;
  targets: SaveTargetPaths;
  overwrite: boolean;
  jsonContent: string;
  markdownContent: string;
  signal?: AbortSignal;
  isSafeLocation?: () => Promise<boolean>;
}): Promise<{ warnings: OutputCleanupIssue[] }> {
  const directory = dirname(params.targets.audioPath);
  await mkdir(directory, { recursive: true });
  // All content is complete before any output changes. The three publications
  // are independent: explicit overwrite accepts a mixed trio on later failure.
  // Choosing Overwrite is the user's confirmation, so it replaces existing
  // outputs whatever format version they record, including a newer one.
  const staging = await mkdtemp(join(directory, ".mumbler-save-"));
  const members = [
    { path: params.targets.audioPath, stage: join(staging, "audio"), kind: "audio" as const },
    { path: params.targets.jsonPath, stage: join(staging, "metadata.json"), kind: "json" as const },
    { path: params.targets.markdownPath, stage: join(staging, "transcript.md"), kind: "markdown" as const },
  ];
  const files: SaveOutputFile[] = members.map(({ path }) => ({ path, status: "pending" }));
  let primary: unknown;
  let current: SaveOutputFile | undefined;
  const issues: OutputCleanupIssue[] = [];
  try {
    await stageAudio(params.sourceAudioPath, members[0]!.stage, params.signal);
    for (const member of members.slice(1)) {
      const handle = await open(member.stage, "wx", 0o600);
      let failure: unknown;
      try {
        await handle.writeFile(member.kind === "json" ? params.jsonContent : params.markdownContent, "utf8");
        await handle.chmod(0o666 & ~process.umask());
        await handle.sync();
      } catch (error) { failure = error; }
      finally {
        try { await handle.close(); }
        catch (error) {
          if (failure !== undefined) throw new AggregateError([failure, error], "Output staging and close failed.", { cause: failure });
          throw error;
        }
      }
      if (failure !== undefined) throw failure;
    }
    const release = await reservePublication(members.map((member) => member.path), params.signal);
    try {
      if (params.isSafeLocation !== undefined && !(await params.isSafeLocation())) throw new OutputLocationError();
      for (const [index, member] of members.entries()) {
        current = files[index]!;
        if (params.signal?.aborted) throw new CancelledError("Save cancelled.");
        if (params.overwrite && await fileExists(member.path) && await sameFileBytes(member.stage, member.path)) {
          current.status = "unchanged";
          continue;
        }
        if (params.overwrite) {
          await keepReplacedMode(member.path, member.stage);
          if (params.signal?.aborted) throw new CancelledError("Save cancelled.");
          await rename(member.stage, member.path);
        } else {
          await publishExclusive(member.stage, member.path);
        }
        current.status = "saved";
      }
    } finally { release(); }
  } catch (error) {
    primary = isNodeAbortError(error) ? new CancelledError("Save cancelled.") : error;
    if (current !== undefined && current.status === "pending") current.status = "failed";
  }
  try { await rm(staging, { recursive: true, force: true }); }
  catch (error) { issues.push({ operation: "remove staging directory", path: staging, error }); }
  await syncDirectory(directory);
  if (primary !== undefined) {
    if (files.some((file) => file.status === "saved") || issues.length > 0 ||
        (current !== undefined && !isCancelledError(primary) && !(primary instanceof OutputConflictError)))
      throw new OutputPartialFailureError(primary, files, issues);
    if (isCancelledError(primary) || primary instanceof OutputConflictError || primary instanceof OutputLocationError) throw primary;
    throw new Error(`Failed to finalize output files: ${formatError(primary)}`, { cause: primary });
  }
  return { warnings: issues };
}

export function buildOutputPayload(params: {
  card: MumblerCard;
  finalProfile: MumblerCard["audioProfile"];
  finalDurationSec: number | null;
  finalizedAtUtc: number;
}): Record<string, unknown> {
  return {
    formatVersion: FORMAT_VERSIONS.outputJson,
    appVersion: __APP_VERSION__,
    originalFilename: params.card.originalFilename,
    importSource: params.card.importSource,
    timestamps: {
      confirmedLocal: params.card.timestamps.confirmedLocal,
      confirmedUtc: formatUtcIsoCompact(params.card.timestamps.confirmedUtc),
      effectiveLocal: params.card.timestamps.effectiveLocal,
      effectiveUtc: formatUtcIsoCompact(params.card.timestamps.effectiveUtc),
      timezone: params.card.timestamps.timezone,
      transcribedAtUtc: params.card.ai.transcription !== null ? formatUtcIsoCompact(params.card.ai.transcription.generatedAtUtc) : null,
      finalizedAtUtc: formatUtcIsoCompact(params.finalizedAtUtc),
    },
    trim:
      params.card.trim.frontMarkerSec === null && params.card.trim.backMarkerSec === null
        ? null
        : params.card.trim,
    duration: {
      originalSec: params.card.durationSec,
      finalSec: params.finalDurationSec,
    },
    transcription: {
      raw: params.card.transcription.text,
      structured: params.card.metadata.structured,
      title: params.card.metadata.title,
      slug: params.card.metadata.slug,
    },
    providers: {
      transcription: params.card.ai.transcription !== null ? {
        ...params.card.ai.transcription,
        generatedAtUtc: formatUtcIsoCompact(params.card.ai.transcription.generatedAtUtc),
      } : null,
      structured: params.card.ai.structured !== null ? {
        ...params.card.ai.structured,
        generatedAtUtc: formatUtcIsoCompact(params.card.ai.structured.generatedAtUtc),
      } : null,
      title: params.card.ai.title !== null ? {
        ...params.card.ai.title,
        generatedAtUtc: formatUtcIsoCompact(params.card.ai.title.generatedAtUtc),
      } : null,
      slug: params.card.ai.slug !== null ? {
        ...params.card.ai.slug,
        generatedAtUtc: formatUtcIsoCompact(params.card.ai.slug.generatedAtUtc),
      } : null,
    },
    audio: {
      finalCodec: params.finalProfile?.codecName ?? null,
      finalBitrateKbps: params.finalProfile?.bitRateKbps ?? null,
      finalSampleRateHz: params.finalProfile?.sampleRateHz ?? null,
      finalChannels: params.finalProfile?.channels ?? null,
      trimDecision: params.card.trimDecision?.kind ?? "not-needed",
    },
  };
}

export function yamlDoubleQuotedString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n");
  return `"${escaped}"`;
}

export function buildMarkdownContent(params: {
  card: MumblerCard;
  audioFilename: string;
  finalDurationSec: number | null;
}): string {
  const title = params.card.metadata.title ?? "";
  const slug = params.card.metadata.slug ?? "";
  const date = formatUtcIsoCompact(params.card.timestamps.effectiveUtc);
  const duration = params.finalDurationSec ?? null;
  const body = params.card.metadata.structured ?? "";

  const lines: string[] = [
    "---",
    `format_version: ${FORMAT_VERSIONS.outputMarkdown}`,
    `date: ${yamlDoubleQuotedString(date)}`,
    `audio: ${yamlDoubleQuotedString(params.audioFilename)}`,
    `duration: ${duration === null ? "null" : duration}`,
    `title: ${yamlDoubleQuotedString(title)}`,
    `slug: ${yamlDoubleQuotedString(slug)}`,
    "---",
    "",
    body,
  ];

  let content = lines.join("\n");
  if (!content.endsWith("\n")) {
    content += "\n";
  }
  return content;
}

export function computeFinalDuration(card: MumblerCard, probedDurationSec: number | null): number | null {
  if (probedDurationSec !== null) {
    return probedDurationSec;
  }

  if (card.durationSec === null) {
    return null;
  }

  const startSec = card.trim.frontMarkerSec ?? 0;
  const endSec = card.trim.backMarkerSec ?? card.durationSec;
  return Math.max(0, Math.round((endSec - startSec) * 1000) / 1000);
}
