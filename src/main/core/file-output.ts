import { createReadStream } from "node:fs";
import { link, mkdir, mkdtemp, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { FORMAT_VERSIONS, NewerFormatError, recordedFormatVersion } from "./format-versions";

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

async function admitOutputMarker(path: string, kind: "json" | "markdown"): Promise<void> {
  let bytes: string;
  try { bytes = await readFile(path, "utf8"); }
  catch (error) { if (errorCode(error) === "ENOENT") return; throw error; }
  let recorded: number | null = null;
  if (kind === "json") {
    try {
      const value: unknown = JSON.parse(bytes);
      if (typeof value === "object" && value !== null && !Array.isArray(value))
        recorded = recordedFormatVersion(value as Record<string, unknown>);
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  } else {
    const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(bytes)?.[1];
    const marker = frontMatter?.match(/^format_version:[ \t]*(\d+)[ \t]*\r?$/m)?.[1];
    if (marker !== undefined && Number.isSafeInteger(Number(marker)) && Number(marker) > 0) recorded = Number(marker);
  }
  const supported = kind === "json" ? FORMAT_VERSIONS.outputJson : FORMAT_VERSIONS.outputMarkdown;
  if (recorded !== null && recorded > supported) throw new NewerFormatError(path, recorded, supported);
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

// Staging can run in parallel; publication attempts take one app-local turn so
// two cards cannot interleave successful audio/JSON/Markdown groups.
let publicationTail = Promise.resolve();

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
    const previous = publicationTail;
    let release!: () => void;
    publicationTail = new Promise<void>((resolve) => { release = resolve; });
    try {
      await previous;
      if (params.isSafeLocation !== undefined && !(await params.isSafeLocation())) throw new OutputLocationError();
      if (params.overwrite) for (const member of members.slice(1)) await admitOutputMarker(member.path, member.kind as "json" | "markdown");
      for (const [index, member] of members.entries()) {
        current = files[index]!;
        if (params.signal?.aborted) throw new CancelledError("Save cancelled.");
        if (params.overwrite && await fileExists(member.path) && await sameFileBytes(member.stage, member.path)) {
          current.status = "unchanged";
          continue;
        }
        if (params.overwrite) {
          if (member.kind !== "audio") await admitOutputMarker(member.path, member.kind);
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
        (current !== undefined && !isCancelledError(primary) && !(primary instanceof OutputConflictError) && !(primary instanceof NewerFormatError)))
      throw new OutputPartialFailureError(primary, files, issues);
    if (isCancelledError(primary) || primary instanceof OutputConflictError || primary instanceof NewerFormatError || primary instanceof OutputLocationError) throw primary;
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
