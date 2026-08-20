import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";

import { nanoid } from "nanoid";

import type { AudioProfile, CardTrim, TrimDecision, ToolName } from "@shared/app-shell";
import { type AppLogger } from "./logger";
import { CancelledError, isNodeAbortError } from "./cancellation";

const execFileAsync = promisify(execFile);
const DEFAULT_TRIM_TOLERANCE_SEC = 3;

// Every tool call is bounded, because both of these open a file and read it:
// a truncated recording, a stalled network or removable mount, or a stuck
// filter leaves the read never returning, and an unbounded await then hangs
// whatever was waiting on it — an import, a save, or the whole pipeline — with
// no error and nothing to cancel.
//
// Wall-clock rather than an idle watchdog, because unlike a download these have
// a predictable duration: a probe reads headers and a bounded packet interval,
// and a trim is bounded by the markers and runs many times faster than realtime.
// Both bounds are therefore generous enough that only a genuinely stuck process
// reaches them.
const PROBE_TIMEOUT_MS = 60_000;
const TRANSCODE_TIMEOUT_MS = 30 * 60 * 1000;

// SIGTERM first so ffmpeg can close its output file, then SIGKILL if it ignores
// that — Node's own `timeout` sends one signal and never escalates, so a child
// that traps SIGTERM would otherwise outlive the bound it was given.
const KILL_ESCALATION_MS = 5_000;

interface RunToolOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * The one place this module spawns anything. Applies the bound and the caller's
 * cancellation signal, and translates an abort into the pipeline's own
 * CancelledError so a user's Cancel records the card as cancelled rather than
 * failed.
 */
export async function runTool(
  toolPath: string,
  args: string[],
  options: RunToolOptions,
): Promise<{ stdout: string }> {
  // The bound and the signal are handled here rather than through execFile's own
  // `timeout`/`signal` options, because those send ONE signal and never follow
  // it: a tool that ignores SIGTERM would outlive the bound it was given, and
  // the await would hang exactly as it did before.
  const promise = execFileAsync(toolPath, args);
  const child = promise.child;

  let escalation: ReturnType<typeof setTimeout> | null = null;
  const stop = (): void => {
    child.kill("SIGTERM");
    if (escalation !== null) return;
    // Cleared in `finally`, which runs only once the child has actually exited
    // — so this fires if and only if SIGTERM was ignored.
    escalation = setTimeout(() => child.kill("SIGKILL"), KILL_ESCALATION_MS);
    escalation.unref?.();
  };

  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  deadline.unref?.();

  const onAbort = (): void => stop();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted === true) stop();

  try {
    const { stdout } = await promise;
    return { stdout };
  } catch (error: unknown) {
    if (options.signal?.aborted === true || isNodeAbortError(error)) {
      throw new CancelledError();
    }
    // Say the bound was hit. "ffmpeg exited with signal SIGKILL" reads as a
    // broken input file, which sends the user looking in the wrong place.
    if (timedOut) {
      throw new Error(
        `${basename(toolPath)} did not finish within ${Math.round(options.timeoutMs / 1000)} seconds and was stopped.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    if (escalation !== null) clearTimeout(escalation);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

// ffmpeg/ffprobe are managed dependencies resolved through the ToolManager (see
// core/binaries), not npm wrappers. The runtime injects the resolver once the
// manager is built; resolving a tool that is not installed throws a user-facing
// error pointing at the Audio Tools surface.
let toolPathResolver: ((name: ToolName) => string) | null = null;

export function configureToolResolver(resolve: (name: ToolName) => string): void {
  toolPathResolver = resolve;
}

interface PacketBoundary {
  startSec: number;
  endSec: number | null;
}

interface RawPacket {
  pts_time?: string;
  dts_time?: string;
  duration_time?: string;
}

interface FfprobeFormatResponse {
  format?: {
    format_name?: string;
    bit_rate?: string;
    duration?: string;
  };
  streams?: Array<{
    codec_name?: string;
    sample_rate?: string;
    channels?: number;
    duration?: string;
  }>;
  packets?: RawPacket[];
}

export interface PreparedAudioInput {
  filePath: string;
  mimeType: string;
  wasDerived: boolean;
  cleanup: () => Promise<void>;
}

export async function probeAudioProfile(
  filePath: string,
  signal?: AbortSignal,
): Promise<{ durationSec: number | null; audioProfile: AudioProfile | null }> {
  const ffprobePath = resolveFfprobePath();

  const { stdout } = await runTool(ffprobePath, [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_name,sample_rate,channels,duration:format=format_name,bit_rate,duration",
    "-of",
    "json",
    filePath,
  ], { timeoutMs: PROBE_TIMEOUT_MS, signal });

  const parsed = JSON.parse(stdout) as FfprobeFormatResponse;
  const stream = parsed.streams?.[0];
  const format = parsed.format;
  const durationCandidate = parseNumber(stream?.duration) ?? parseNumber(format?.duration);

  return {
    durationSec: durationCandidate,
    audioProfile: {
      formatName: format?.format_name ?? null,
      codecName: stream?.codec_name ?? null,
      bitRateKbps: toKbps(parseNumber(format?.bit_rate)),
      sampleRateHz: parseInteger(stream?.sample_rate),
      channels: typeof stream?.channels === "number" ? stream.channels : null,
    },
  };
}

export async function analyzeTrimDecision(
  filePath: string,
  trim: CardTrim,
  durationSec: number | null,
  signal?: AbortSignal,
): Promise<TrimDecision> {
  const requestedStartSec = trim.frontMarkerSec;
  const requestedEndSec = trim.backMarkerSec;

  if (requestedStartSec === null && requestedEndSec === null) {
    return {
      kind: "not-needed",
      toleranceSec: DEFAULT_TRIM_TOLERANCE_SEC,
      requestedStartSec: null,
      requestedEndSec: null,
      searchStartFromSec: null,
      searchStartToSec: null,
      searchEndFromSec: null,
      searchEndToSec: null,
      chosenStartBoundarySec: null,
      chosenEndBoundarySec: null,
      startDeltaSec: null,
      endDeltaSec: null,
      reason: "No trim markers set.",
      analyzedAtUtc: Date.now(),
    };
  }

  const searchStartFromSec =
    requestedStartSec === null ? null : Math.max(0, requestedStartSec - DEFAULT_TRIM_TOLERANCE_SEC);
  const searchStartToSec = requestedStartSec;
  const searchEndFromSec = requestedEndSec;
  const searchEndToSec =
    requestedEndSec === null ? null : requestedEndSec + DEFAULT_TRIM_TOLERANCE_SEC;

  const startBoundary =
    requestedStartSec === null || requestedStartSec <= 0
      ? 0
      : await findStartBoundary(filePath, searchStartFromSec!, searchStartToSec!, signal);

  const endBoundary =
    requestedEndSec === null || (durationSec !== null && requestedEndSec >= durationSec)
      ? requestedEndSec
      : await findEndBoundary(filePath, searchEndFromSec!, searchEndToSec!, signal);

  const startDeltaSec =
    requestedStartSec === null || startBoundary === null
      ? null
      : roundSeconds(requestedStartSec - startBoundary);
  const endDeltaSec =
    requestedEndSec === null || endBoundary === null
      ? null
      : roundSeconds(endBoundary - requestedEndSec);

  const canStreamCopy =
    (requestedStartSec === null || startBoundary !== null) &&
    (requestedEndSec === null || endBoundary !== null);

  return {
    kind: canStreamCopy ? "stream-copy" : "reencode",
    toleranceSec: DEFAULT_TRIM_TOLERANCE_SEC,
    requestedStartSec,
    requestedEndSec,
    searchStartFromSec,
    searchStartToSec,
    searchEndFromSec,
    searchEndToSec,
    chosenStartBoundarySec: startBoundary,
    chosenEndBoundarySec: endBoundary,
    startDeltaSec,
    endDeltaSec,
    reason: canStreamCopy
      ? "All required boundaries were found within tolerance."
      : "At least one required boundary was not found within tolerance.",
    analyzedAtUtc: Date.now(),
  };
}

export async function prepareAudioForTranscription(params: {
  sourceFilePath: string;
  workingDir: string;
  trim: CardTrim;
  trimDecision: TrimDecision | null;
  durationSec: number | null;
  audioProfile: AudioProfile | null;
  logger?: AppLogger;
  signal?: AbortSignal;
}): Promise<PreparedAudioInput> {
  const mimeType = inferAudioMimeType(params.sourceFilePath);

  if (params.trim.frontMarkerSec === null && params.trim.backMarkerSec === null) {
    return {
      filePath: params.sourceFilePath,
      mimeType,
      wasDerived: false,
      cleanup: async () => undefined,
    };
  }

  const derivedDir = join(params.workingDir, "derived");
  await mkdir(derivedDir, { recursive: true });

  const extension = extname(params.sourceFilePath) || ".audio";
  const outputPath = join(derivedDir, `${nanoid()}${extension}`);

  if (params.trimDecision?.kind === "stream-copy") {
    const startSec = params.trimDecision.chosenStartBoundarySec ?? 0;
    const endSec = params.trimDecision.chosenEndBoundarySec;
    await runFfmpegTrim({
      sourceFilePath: params.sourceFilePath,
      outputPath,
      startSec,
      endSec,
      mode: "stream-copy",
      audioProfile: params.audioProfile,
      logger: params.logger,
      signal: params.signal,
    });

    return {
      filePath: outputPath,
      mimeType,
      wasDerived: true,
      cleanup: async () => cleanupDerivedFile(outputPath),
    };
  }

  const startSec = params.trim.frontMarkerSec ?? 0;
  const endSec = params.trim.backMarkerSec;
  await runFfmpegTrim({
    sourceFilePath: params.sourceFilePath,
    outputPath,
    startSec,
    endSec,
    mode: "reencode",
    audioProfile: params.audioProfile,
    logger: params.logger,
    signal: params.signal,
  });

  return {
    filePath: outputPath,
    mimeType,
    wasDerived: true,
    cleanup: async () => cleanupDerivedFile(outputPath),
  };
}

export function inferAudioMimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".mp3":
      return "audio/mpeg";
    case ".m4a":
    case ".mp4":
      return "audio/mp4";
    case ".aac":
      return "audio/aac";
    case ".wav":
      return "audio/wav";
    case ".flac":
      return "audio/flac";
    case ".ogg":
    case ".oga":
    case ".opus":
      return "audio/ogg";
    case ".aif":
    case ".aiff":
      return "audio/aiff";
    default:
      return "application/octet-stream";
  }
}

function resolveToolPath(name: ToolName): string {
  if (toolPathResolver === null) {
    throw new Error("Audio tool resolver is not configured.");
  }
  return toolPathResolver(name);
}

function resolveFfprobePath(): string {
  return resolveToolPath("ffprobe");
}

function resolveFfmpegPath(): string {
  return resolveToolPath("ffmpeg");
}

async function runFfmpegTrim(params: {
  sourceFilePath: string;
  outputPath: string;
  startSec: number;
  endSec: number | null;
  mode: "stream-copy" | "reencode";
  audioProfile: AudioProfile | null;
  logger?: AppLogger;
  signal?: AbortSignal;
}): Promise<void> {
  const ffmpeg = resolveFfmpegPath();

  // For stream-copy, -ss before -i (fast input-side seek) is safe because
  // startSec is already an exact packet boundary found by findStartBoundary.
  // For re-encode, -ss after -i (output-side seek) gives frame-accurate positioning.
  const inputSeekArgs =
    params.mode === "stream-copy" && params.startSec > 0
      ? ["-ss", params.startSec.toFixed(3)]
      : [];
  const outputTimingArgs = buildOutputTimingArgs(
    params.mode === "stream-copy" ? 0 : params.startSec,
    params.endSec,
    params.mode === "stream-copy" ? params.startSec : 0,
  );
  const codecArgs =
    params.mode === "stream-copy"
      ? ["-vn", "-c:a", "copy"]
      : ["-vn", ...buildReencodeArgs(params.outputPath, params.audioProfile)];

  await params.logger?.debug("audio.ffmpeg-trim", "Running ffmpeg trim.", {
    mode: params.mode,
    startSec: params.startSec,
    endSec: params.endSec,
    inputFile: basename(params.sourceFilePath),
    outputFile: basename(params.outputPath),
    inputSeekArgs,
    outputTimingArgs,
    codecArgs,
  });

  await runTool(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...inputSeekArgs,
    "-i",
    params.sourceFilePath,
    ...outputTimingArgs,
    ...codecArgs,
    params.outputPath,
  ], { timeoutMs: TRANSCODE_TIMEOUT_MS, signal: params.signal });
}

// seekSec: value placed after -i as -ss (0 = omit). baseOffsetSec: amount
// already consumed by an input-side seek (non-zero for stream-copy mode).
// Duration = endSec - seekSec - baseOffsetSec, which collapses to endSec - startSec
// in both stream-copy (seekSec=0, baseOffsetSec=startSec) and re-encode
// (seekSec=startSec, baseOffsetSec=0) cases.
export function buildOutputTimingArgs(
  seekSec: number,
  endSec: number | null,
  baseOffsetSec: number,
): string[] {
  const args: string[] = [];

  if (seekSec > 0) {
    args.push("-ss", seekSec.toFixed(3));
  }

  const durationSec = endSec === null ? null : Math.max(0, endSec - seekSec - baseOffsetSec);
  if (durationSec !== null) {
    args.push("-t", durationSec.toFixed(3));
  }

  return args;
}

export function buildReencodeArgs(outputPath: string, audioProfile: AudioProfile | null): string[] {
  const extension = extname(outputPath).toLowerCase();
  const bitrateKbps = audioProfile?.bitRateKbps ?? 192;

  switch (extension) {
    case ".mp3":
      return ["-c:a", "libmp3lame", "-b:a", `${bitrateKbps}k`];
    case ".m4a":
    case ".mp4":
    case ".aac":
      return ["-c:a", "aac", "-b:a", `${bitrateKbps}k`];
    case ".flac":
      return ["-c:a", "flac"];
    case ".wav":
      return ["-c:a", "pcm_s16le"];
    case ".aif":
    case ".aiff":
      return ["-c:a", "pcm_s16be"];
    case ".ogg":
    case ".oga":
    case ".opus":
      return audioProfile?.codecName === "opus"
        ? ["-c:a", "libopus", "-b:a", `${Math.max(24, bitrateKbps)}k`]
        : ["-c:a", "libvorbis", "-b:a", `${bitrateKbps}k`];
    default:
      return ["-c:a", "copy"];
  }
}

async function cleanupDerivedFile(filePath: string): Promise<void> {
  try {
    const { rm } = await import("node:fs/promises");
    await rm(filePath, { force: true });
  } catch {
    return;
  }
}

async function findStartBoundary(
  filePath: string,
  fromSec: number,
  toSec: number,
  signal?: AbortSignal,
): Promise<number | null> {
  const packets = await readPackets(filePath, fromSec, toSec, signal);
  if (packets.length === 0) {
    return null;
  }

  const candidate = packets
    .filter((packet) => packet.startSec >= fromSec && packet.startSec <= toSec)
    .sort((left, right) => right.startSec - left.startSec)[0];

  return candidate ? roundSeconds(candidate.startSec) : null;
}

async function findEndBoundary(
  filePath: string,
  fromSec: number,
  toSec: number,
  signal?: AbortSignal,
): Promise<number | null> {
  const packets = await readPackets(filePath, fromSec, toSec, signal);
  if (packets.length === 0) {
    return null;
  }

  const candidate = packets
    .map((packet, index, allPackets) => {
      const inferredEnd =
        packet.endSec ?? (allPackets[index + 1] ? allPackets[index + 1].startSec : null);

      return inferredEnd === null
        ? null
        : {
            ...packet,
            endSec: inferredEnd,
          };
    })
    .filter((packet): packet is PacketBoundary & { endSec: number } => packet !== null)
    .filter((packet) => packet.endSec >= fromSec && packet.endSec <= toSec)
    .sort((left, right) => left.endSec - right.endSec)[0];

  return candidate ? roundSeconds(candidate.endSec) : null;
}

async function readPackets(
  filePath: string,
  fromSec: number,
  toSec: number,
  signal?: AbortSignal,
): Promise<PacketBoundary[]> {
  const ffprobePath = resolveFfprobePath();
  const { stdout } = await runTool(ffprobePath, [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "packet=pts_time,dts_time,duration_time",
    "-of",
    "json",
    "-read_intervals",
    `${fromSec}%${toSec}`,
    filePath,
  ], { timeoutMs: PROBE_TIMEOUT_MS, signal });

  const parsed = JSON.parse(stdout) as FfprobeFormatResponse;
  const packets = parsed.packets ?? [];

  return packets
    .map((packet) => {
      const startSec = parseNumber(packet.pts_time) ?? parseNumber(packet.dts_time);
      if (startSec === null) {
        return null;
      }

      const durationTime = parseNumber(packet.duration_time);
      return {
        startSec,
        endSec: durationTime === null ? null : startSec + durationTime,
      };
    })
    .filter((packet): packet is PacketBoundary => packet !== null);
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseInteger(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function toKbps(value: number | null): number | null {
  if (value === null) {
    return null;
  }

  return Math.round(value / 1000);
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

