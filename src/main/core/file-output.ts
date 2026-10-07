import { createReadStream, type Stats } from "node:fs";
import { link, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { nanoid } from "nanoid";

import type { MumblerCard } from "@shared/app-shell";
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

// The primary failure is retained alongside every failed rollback/cleanup step.
// Paths are diagnostic/recovery data, never arbitrary exception text for the UI.
export class OutputPartialFailureError extends AggregateError {
  constructor(readonly primary: unknown, readonly issues: OutputCleanupIssue[]) {
    super([primary, ...issues.map((issue) => issue.error)], "Output save did not finish restoring or cleaning up.", { cause: primary });
    this.name = "OutputPartialFailureError";
  }
}

type OwnedFile = { path: string; identity: Stats | null };

function sameFileState(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.mode === right.mode;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return sameFileState(left, right) && left.ctimeMs === right.ctimeMs;
}

async function observedFile(path: string): Promise<Stats | null> {
  try { return await stat(path); }
  catch (error) { if (errorCode(error) === "ENOENT") return null; throw error; }
}

async function removeOwned(file: OwnedFile): Promise<void> {
  const current = await observedFile(file.path);
  if (current === null) return;
  if (file.identity === null || !sameIdentity(current, file.identity)) throw new OutputConflictError(file.path);
  await rm(file.path);
}

// Publishing/removing a hard link changes the staged inode's ctime. All other
// observed fields must still match before this owner cleans up its stage.
async function removeStage(file: OwnedFile): Promise<void> {
  const current = await observedFile(file.path);
  if (current === null) return;
  if (file.identity === null || !sameFileState(current, file.identity)) throw new OutputConflictError(file.path);
  await removeOwned({ path: file.path, identity: current });
}

// The descriptor owns an exclusive creation even if writing or syncing fails.
// Audio is streamed; no complete recording is buffered on the main process.
async function copyExclusive(source: string, destination: string, owned: (file: OwnedFile) => void,
  signal?: AbortSignal, expectedSource?: Stats): Promise<void> {
  if (expectedSource !== undefined && !sameIdentity(await stat(source), expectedSource)) throw new OutputConflictError(source);
  if (signal?.aborted) throw new CancelledError("Save cancelled.");
  const handle = await open(destination, "wx", 0o600);
  owned({ path: destination, identity: null });
  const stream = createReadStream(source, { signal });
  // The iterator still rejects; this listener owns an early abort emission
  // before writeFile has attached its iterator.
  stream.on("error", () => undefined);
  const failures: unknown[] = [];
  try {
    owned({ path: destination, identity: await handle.stat() });
    await handle.writeFile(stream);
    const sourceInfo = await stat(source);
    if (expectedSource !== undefined && !sameIdentity(sourceInfo, expectedSource)) throw new OutputConflictError(source);
    await handle.utimes(sourceInfo.atime, sourceInfo.mtime);
    await handle.chmod(sourceInfo.mode);
    await handle.sync();
  } catch (error) { failures.push(error); }
  finally {
    stream.destroy();
    try { owned({ path: destination, identity: await handle.stat() }); }
    catch (error) { failures.push(error); }
    try { await handle.close(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Exclusive output copy failed.", { cause: failures[0] });
}

// Never replace a contender. Hard links are atomic; the exclusive streamed copy
// fallback on FAT/exFAT is not atomic, but owns and rolls back only its creation.
async function publishExclusive(source: string, destination: string, owned: (file: OwnedFile) => void,
  expectedSource: Stats): Promise<void> {
  const sourceInfo = await stat(source);
  if (!sameIdentity(sourceInfo, expectedSource)) throw new OutputConflictError(source);
  try {
    await link(source, destination);
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new OutputConflictError(destination);
    if (!HARD_LINK_UNSUPPORTED_CODES.has(errorCode(error) ?? "")) throw error;
    try { await copyExclusive(source, destination, owned, undefined, expectedSource); }
    catch (copyError) {
      if (errorCode(copyError) === "EEXIST") throw new OutputConflictError(destination);
      throw copyError;
    }
    return;
  }
  // link changes ctime on both names. Capture the linked inode, never adopt a
  // replacement that arrived during the following asynchronous stat.
  owned({ path: destination, identity: sourceInfo });
  const linked = await stat(destination);
  if (linked.dev !== sourceInfo.dev || linked.ino !== sourceInfo.ino || linked.size !== sourceInfo.size ||
      linked.mtimeMs !== sourceInfo.mtimeMs || linked.mode !== sourceInfo.mode) throw new OutputConflictError(destination);
  owned({ path: destination, identity: linked });
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

export async function finalizeOutputsAtomically(params: {
  sourceAudioPath: string;
  targets: SaveTargetPaths;
  overwrite: boolean;
  jsonContent: string;
  markdownContent: string;
  // Cancel before retirement/publication. Once publication starts, finish or
  // restore the group, retaining recovery files if another writer prevents it.
  signal?: AbortSignal;
}): Promise<{ warnings: OutputCleanupIssue[] }> {
  await mkdir(dirname(params.targets.audioPath), { recursive: true });
  // not recorded: finalized audio, JSON and Markdown are user outputs, forgotten
  // by Mumbler once the card leaves the queue, rather than managed app stores.
  const derived = (path: string, extension: string): string =>
    join(dirname(path), `${basename(path, extname(path))}-${nanoid(8)}.${extension}`);
  const members = [
    { target: params.targets.audioPath, kind: "audio" as const },
    { target: params.targets.jsonPath, kind: "json" as const },
    { target: params.targets.markdownPath, kind: "markdown" as const },
  ].map((member) => ({ ...member, temp: derived(member.target, "tmp"), backup: derived(member.target, "bak"),
    stage: null as OwnedFile | null, previous: null as OwnedFile | null,
    published: null as OwnedFile | null, retired: false, unchanged: null as Stats | null }));
  const syncDirectories = async (): Promise<void> => {
    for (const directory of new Set(members.map((member) => dirname(member.target)))) await syncDirectory(directory);
  };
  const issues: OutputCleanupIssue[] = [];
  const attempt = async (operation: string, path: string, action: () => Promise<void>): Promise<boolean> => {
    try { await action(); return true; }
    catch (error) { issues.push({ operation, path, error }); return false; }
  };
  try {
    await copyExclusive(params.sourceAudioPath, members[0]!.temp, (file) => { members[0]!.stage = file; }, params.signal);
    for (const member of members.slice(1)) {
      const handle = await open(member.temp, "wx", 0o600);
      member.stage = { path: member.temp, identity: null };
      const failures: unknown[] = [];
      try {
        member.stage = { path: member.temp, identity: await handle.stat() };
        await handle.writeFile(member.kind === "json" ? params.jsonContent : params.markdownContent, "utf8");
        // Private while being written; ordinary new output mode once complete.
        await handle.chmod(0o666 & ~process.umask());
        await handle.sync();
      } catch (error) { failures.push(error); }
      finally {
        try { member.stage = { path: member.temp, identity: await handle.stat() }; }
        catch (error) { failures.push(error); }
        try { await handle.close(); }
        catch (error) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Output staging failed.", { cause: failures[0] });
    }
    // Check both sidecars before moving even the audio aside.
    if (params.overwrite) for (const member of members.slice(1)) await admitOutputMarker(member.target, member.kind as "json" | "markdown");
    for (const member of members) {
      const current = await observedFile(member.target);
      member.unchanged = params.overwrite && current !== null && await sameFileBytes(member.temp, member.target) ? current : null;
      if (member.unchanged) {
        // Equality must have compared our staged bytes, not a replacement that
        // arrived during an earlier member's backup or the comparison itself.
        if (!sameIdentity(await stat(member.temp), member.stage!.identity!)) throw new OutputConflictError(member.temp);
        continue;
      }
      if (params.overwrite && current !== null) {
        if (member.kind !== "audio") {
          await admitOutputMarker(member.target, member.kind);
          // Capture destination access mode at its retirement checkpoint, after
          // any earlier output backup wait, rather than using a staged old mode.
          const beforeMode = member.stage!.identity!;
          if (!sameIdentity(await stat(member.temp), beforeMode)) throw new OutputConflictError(member.temp);
          await keepReplacedMode(member.target, member.temp);
          const afterMode = await stat(member.temp);
          if (afterMode.dev !== beforeMode.dev || afterMode.ino !== beforeMode.ino ||
              afterMode.size !== beforeMode.size || afterMode.mtimeMs !== beforeMode.mtimeMs)
            throw new OutputConflictError(member.temp);
          member.stage!.identity = afterMode;
        }
        if (params.signal?.aborted) throw new CancelledError("Save cancelled.");
        await publishExclusive(member.target, member.backup, (file) => { member.previous = file; }, current);
        const now = await stat(member.target);
        // Own link creation changes ctime. All other observed identity/content
        // changes still prevent retirement; the linked backup is also checked.
        const backupIdentity = member.previous!.identity!;
        const hardLinked = now.dev === backupIdentity.dev && now.ino === backupIdentity.ino;
        if (!sameFileState(now, current) ||
            !(hardLinked ? sameIdentity(now, backupIdentity) : sameIdentity(now, current)))
          throw new OutputConflictError(member.target);
        await rm(member.target);
        member.retired = true;
        const backupAfterRetirement = await stat(member.backup);
        if (!sameFileState(backupAfterRetirement, backupIdentity)) throw new OutputConflictError(member.backup);
        member.previous!.identity = backupAfterRetirement;
      }
    }
    if (params.signal?.aborted) throw new CancelledError("Save cancelled.");
    for (const member of members) {
      if (!member.unchanged) await publishExclusive(member.temp, member.target, (file) => { member.published = file; }, member.stage!.identity!);
    }
    for (const member of members) {
      const expected = member.unchanged ?? member.published?.identity;
      const current = await observedFile(member.target);
      if (expected == null || current === null || !sameIdentity(current, expected))
        throw new OutputConflictError(member.target);
    }
    await syncDirectories();
  } catch (error) {
    const primary = isNodeAbortError(error) ? new CancelledError("Save cancelled.") : error;
    for (const member of [...members].reverse()) {
      if (member.published !== null) await attempt("remove published output", member.target, () => removeOwned(member.published!));
      if (member.retired && member.previous !== null) {
        const restored = await attempt("restore previous output", member.backup, async () => {
          const current = await stat(member.backup);
          if (!sameIdentity(current, member.previous!.identity!)) throw new OutputConflictError(member.backup);
          let restoration: OwnedFile | null = null;
          try { await publishExclusive(member.backup, member.target, (file) => { restoration = file; }, member.previous!.identity!); }
          catch (error) {
            if (restoration !== null) await attempt("remove failed restoration", member.target, () => removeOwned(restoration!));
            throw error;
          }
          // Restoring the link changes backup ctime again.
          const backupAfterRestore = await stat(member.backup);
          if (!sameFileState(backupAfterRestore, member.previous!.identity!)) throw new OutputConflictError(member.backup);
          member.previous!.identity = backupAfterRestore;
        });
        if (restored) await attempt("remove restored backup", member.backup, () => removeOwned(member.previous!));
      } else if (member.previous !== null) {
        await attempt("remove unused backup", member.backup, () => removeOwned(member.previous!));
      }
      if (member.stage !== null) await attempt("remove staging file", member.temp, () => removeStage(member.stage!));
    }
    if (issues.length > 0) throw new OutputPartialFailureError(primary, issues);
    if (isCancelledError(primary) || primary instanceof OutputConflictError || primary instanceof NewerFormatError) throw primary;
    throw new Error(`Failed to finalize output files: ${formatError(primary)}`, { cause: primary });
  }
  // Publication committed. Cleanup errors are warnings, never a failed save.
  for (const member of members) {
    if (member.previous !== null) await attempt("remove previous output backup", member.backup, () => removeOwned(member.previous!));
    if (member.stage !== null) await attempt("remove staging file", member.temp, () => removeStage(member.stage!));
  }
  await syncDirectories();
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
