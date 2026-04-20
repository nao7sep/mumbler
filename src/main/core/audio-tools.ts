import { execFile } from "node:child_process";
import { promisify } from "node:util";

import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

import type { AudioProfile, CardTrim, TrimDecision } from "@shared/app-shell";

const execFileAsync = promisify(execFile);
const DEFAULT_TRIM_TOLERANCE_SEC = 3;

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

function resolveFfprobePath(): string {
  if (!ffprobeStatic?.path) {
    throw new Error("ffprobe-static did not provide a binary path.");
  }

  return ffprobeStatic.path;
}

function resolveFfmpegPath(): string {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static did not provide a binary path.");
  }

  return ffmpegPath;
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
