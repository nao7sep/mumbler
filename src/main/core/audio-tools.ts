import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { dirname, extname, join } from "node:path";
import { promisify } from "node:util";

import { nanoid } from "nanoid";

import type { AudioProfile, CardTrim, TrimDecision } from "@shared/app-shell";

const execFileAsync = promisify(execFile);
const DEFAULT_TRIM_TOLERANCE_SEC = 3;
const require = createRequire(import.meta.url);

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
): Promise<{ durationSec: number | null; audioProfile: AudioProfile | null }> {
  const ffprobePath = resolveFfprobePath();

  const { stdout } = await execFileAsync(ffprobePath, [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_name,sample_rate,channels,duration:format=format_name,bit_rate,duration",
    "-of",
    "json",
    filePath,
  ]);

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
      analyzedAtUtc: new Date().toISOString(),
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
      : await findStartBoundary(filePath, searchStartFromSec!, searchStartToSec!);

  const endBoundary =
    requestedEndSec === null || (durationSec !== null && requestedEndSec >= durationSec)
      ? requestedEndSec
      : await findEndBoundary(filePath, searchEndFromSec!, searchEndToSec!);

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
    analyzedAtUtc: new Date().toISOString(),
  };
}

export async function prepareAudioForTranscription(params: {
  sourceFilePath: string;
  workingDir: string;
  trim: CardTrim;
  trimDecision: TrimDecision | null;
  durationSec: number | null;
  audioProfile: AudioProfile | null;
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

function resolveFfprobePath(): string {
  const required = require("ffprobe-static") as { path?: string };
  if (required?.path) {
    return required.path;
  }

  const packagePath = require.resolve("ffprobe-static/package.json");
  const binaryPath = join(
    dirname(packagePath),
    "bin",
    platform(),
    arch(),
    platform() === "win32" ? "ffprobe.exe" : "ffprobe",
  );
  return binaryPath;
}

function resolveFfmpegPath(): string {
  const required = require("ffmpeg-static") as string | null;
  if (!required) {
    throw new Error("ffmpeg-static did not provide a binary path.");
  }

  return required;
}

async function runFfmpegTrim(params: {
  sourceFilePath: string;
  outputPath: string;
  startSec: number;
  endSec: number | null;
  mode: "stream-copy" | "reencode";
  audioProfile: AudioProfile | null;
}): Promise<void> {
  const ffmpeg = resolveFfmpegPath();
  const trimArgs = buildTrimTimingArgs(params.startSec, params.endSec);
  const codecArgs =
    params.mode === "stream-copy"
      ? ["-c", "copy"]
      : buildReencodeArgs(params.outputPath, params.audioProfile);

  await execFileAsync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    params.sourceFilePath,
    ...trimArgs,
    ...codecArgs,
    params.outputPath,
  ]);
}

function buildTrimTimingArgs(startSec: number, endSec: number | null): string[] {
  const args: string[] = [];

  if (startSec > 0) {
    args.push("-ss", startSec.toFixed(3));
  }

  const durationSec = endSec === null ? null : Math.max(0, endSec - startSec);
  if (durationSec !== null) {
    args.push("-t", durationSec.toFixed(3));
  }

  return args;
}

function buildReencodeArgs(outputPath: string, audioProfile: AudioProfile | null): string[] {
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
): Promise<number | null> {
  const packets = await readPackets(filePath, fromSec, toSec);
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
): Promise<number | null> {
  const packets = await readPackets(filePath, fromSec, toSec);
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
): Promise<PacketBoundary[]> {
  const ffprobePath = resolveFfprobePath();
  const { stdout } = await execFileAsync(ffprobePath, [
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
  ]);

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

export function assertFfmpegToolingPresent(): void {
  resolveFfmpegPath();
  resolveFfprobePath();
}
