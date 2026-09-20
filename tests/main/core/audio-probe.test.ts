import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { analyzeTrimDecision, configureToolResolver, prepareAudioForTranscription, probeAudioProfile } from "@main/core/audio-tools";
import type { TrimDecision } from "@shared/app-shell";

// What the app believes about a recording — its format, how long it is, and
// where a trim can cut without re-encoding — is read out of ffprobe's JSON.
// These drive the REAL tool path (spawn, bound, parse) with a stand-in ffprobe
// that prints prepared answers, so what is under test is the reading and the
// boundary choice rather than a mock of them.
let toolDir = "";
let ffprobePath = "";
let ffmpegPath = "";

/** What the stand-in ffprobe will print for the next format / packet query. */
function answerWith(kind: "format" | "packets", payload: unknown): void {
  writeFileSync(join(toolDir, `${kind}.json`), JSON.stringify(payload));
}

/** A packet list as ffprobe reports one: start times, and durations where known. */
function packets(entries: Array<{ pts?: number; dts?: number; duration?: number }>): unknown {
  return {
    packets: entries.map((entry) => ({
      ...(entry.pts === undefined ? {} : { pts_time: String(entry.pts) }),
      ...(entry.dts === undefined ? {} : { dts_time: String(entry.dts) }),
      ...(entry.duration === undefined ? {} : { duration_time: String(entry.duration) }),
    })),
  };
}

beforeAll(() => {
  toolDir = mkdtempSync(join(tmpdir(), "mumbler-ffprobe-"));
  const script = join(toolDir, "ffprobe.cjs");
  // Which query this is, is visible in the arguments: packet reads ask for
  // packet entries, everything else asks for the stream and format entries.
  writeFileSync(
    script,
    [
      "const { readFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      "const wantsPackets = process.argv.some((arg) => arg.startsWith('packet='));",
      "process.stdout.write(readFileSync(join(__dirname, wantsPackets ? 'packets.json' : 'format.json'), 'utf8'));",
    ].join("\n"),
  );
  // ffmpeg's stand-in records what it was asked to do and produces the file it
  // was asked for, which is all the caller relies on.
  const ffmpegScript = join(toolDir, "ffmpeg.cjs");
  writeFileSync(
    ffmpegScript,
    [
      "const { writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      "const args = process.argv.slice(2);",
      "writeFileSync(join(__dirname, 'ffmpeg-args.json'), JSON.stringify(args));",
      "writeFileSync(args[args.length - 1], 'trimmed audio');",
    ].join("\n"),
  );
  ffprobePath = launcher("ffprobe", script);
  ffmpegPath = launcher("ffmpeg", ffmpegScript);
  configureToolResolver((name) => (name === "ffmpeg" ? ffmpegPath : ffprobePath));
});

/**
 * The app runs its tools as programs with their own arguments, so a stand-in has
 * to be one: a launcher the OS can execute, in that OS's own form.
 */
function launcher(name: string, script: string): string {
  const windows = process.platform === "win32";
  const toolPath = join(toolDir, windows ? `${name}.cmd` : name);
  writeFileSync(
    toolPath,
    windows
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
  );
  chmodSync(toolPath, 0o755);
  return toolPath;
}

/** What the stand-in ffmpeg was asked to do on its last run. */
function ffmpegArgs(): string[] {
  return JSON.parse(readFileSync(join(toolDir, "ffmpeg-args.json"), "utf8")) as string[];
}

beforeEach(() => {
  answerWith("format", {});
  answerWith("packets", { packets: [] });
});

/** The recording under test; the stand-in ffprobe ignores it and answers from the staged files. */
const RECORDING = "/recordings/take.m4a";

describe("reading a recording's profile", () => {
  it("reports the format, codec, rate, channels and duration the file declares", async () => {
    answerWith("format", {
      format: { format_name: "mov,mp4,m4a", bit_rate: "128000", duration: "301.5" },
      streams: [{ codec_name: "aac", sample_rate: "44100", channels: 2, duration: "300.25" }],
    });

    await expect(probeAudioProfile(RECORDING)).resolves.toEqual({
      durationSec: 300.25,
      audioProfile: {
        formatName: "mov,mp4,m4a",
        codecName: "aac",
        bitRateKbps: 128,
        sampleRateHz: 44100,
        channels: 2,
      },
    });
  });

  it("falls back to the container's duration when the stream does not state one", async () => {
    answerWith("format", {
      format: { format_name: "wav", duration: "12.5" },
      streams: [{ codec_name: "pcm_s16le", sample_rate: "48000", channels: 1 }],
    });

    const { durationSec, audioProfile } = await probeAudioProfile(RECORDING);

    expect(durationSec).toBe(12.5);
    expect(audioProfile).toMatchObject({ bitRateKbps: null, sampleRateHz: 48000, channels: 1 });
  });

  it("answers with nulls rather than guesses when ffprobe knows nothing", async () => {
    answerWith("format", { format: {}, streams: [] });

    await expect(probeAudioProfile(RECORDING)).resolves.toEqual({
      durationSec: null,
      audioProfile: {
        formatName: null,
        codecName: null,
        bitRateKbps: null,
        sampleRateHz: null,
        channels: null,
      },
    });
  });

  it("ignores values it cannot read as numbers", async () => {
    answerWith("format", {
      format: { format_name: "ogg", bit_rate: "N/A", duration: "N/A" },
      streams: [{ codec_name: "opus", sample_rate: "", channels: "two", duration: "N/A" }],
    });

    const { durationSec, audioProfile } = await probeAudioProfile(RECORDING);

    expect(durationSec).toBeNull()
    expect(audioProfile).toMatchObject({ bitRateKbps: null, sampleRateHz: null, channels: null });
  });
});

describe("deciding how a trim can be cut", () => {
  it("does no work at all when neither marker is set", async () => {
    const decision = await analyzeTrimDecision(RECORDING, { frontMarkerSec: null, backMarkerSec: null }, 300);

    expect(decision).toMatchObject({
      kind: "not-needed",
      reason: "No trim markers set.",
      chosenStartBoundarySec: null,
      chosenEndBoundarySec: null,
    });
  });

  it("takes the last packet start at or before the mark, so the cut keeps what the user kept", async () => {
    // Marks at 10 s; packets start every 0.5 s. 9.75 is the latest one that does
    // not cross the mark, so it is where a stream copy can begin.
    answerWith("packets", packets([{ pts: 9.25 }, { pts: 9.75 }, { pts: 10.25 }]));

    const decision = await analyzeTrimDecision(RECORDING, { frontMarkerSec: 10, backMarkerSec: null }, 300);

    expect(decision).toMatchObject({
      kind: "stream-copy",
      requestedStartSec: 10,
      chosenStartBoundarySec: 9.75,
      startDeltaSec: 0.25,
      // The search reaches three seconds back from the mark, never past it.
      searchStartFromSec: 7,
      searchStartToSec: 10,
      reason: "All required boundaries were found within tolerance.",
    });
  });

  it("takes the first packet end at or after the back mark", async () => {
    answerWith("packets", packets([{ pts: 19.5, duration: 0.5 }, { pts: 20, duration: 0.5 }]));

    const decision = await analyzeTrimDecision(RECORDING, { frontMarkerSec: null, backMarkerSec: 20 }, 300);

    expect(decision).toMatchObject({
      kind: "stream-copy",
      chosenEndBoundarySec: 20,
      endDeltaSec: 0,
      searchEndFromSec: 20,
      searchEndToSec: 23,
    });
  });

  it("infers a packet's end from the next packet's start when ffprobe gives no duration", async () => {
    answerWith("packets", packets([{ pts: 19.6 }, { pts: 20.4 }]));

    const decision = await analyzeTrimDecision(RECORDING, { frontMarkerSec: null, backMarkerSec: 20 }, 300);

    expect(decision.chosenEndBoundarySec).toBe(20.4);
    expect(decision.kind).toBe("stream-copy");
  });

  it("reads a packet's start from its decode time when it has no presentation time", async () => {
    answerWith("packets", packets([{ dts: 9.5 }]));

    const decision = await analyzeTrimDecision(RECORDING, { frontMarkerSec: 10, backMarkerSec: null }, 300);

    expect(decision.chosenStartBoundarySec).toBe(9.5);
  });

  it("calls for a re-encode when no boundary sits within tolerance", async () => {
    answerWith("packets", { packets: [] });

    const decision = await analyzeTrimDecision(RECORDING, { frontMarkerSec: 10, backMarkerSec: 20 }, 300);

    expect(decision).toMatchObject({
      kind: "reencode",
      chosenStartBoundarySec: null,
      chosenEndBoundarySec: null,
      startDeltaSec: null,
      endDeltaSec: null,
      reason: "At least one required boundary was not found within tolerance.",
    });
  });

  it("starts at zero without asking ffprobe when the front mark is the beginning", async () => {
    answerWith("packets", packets([{ pts: 19.75, duration: 0.5 }]));

    const decision = await analyzeTrimDecision(RECORDING, { frontMarkerSec: 0, backMarkerSec: 20 }, 300);

    expect(decision).toMatchObject({ kind: "stream-copy", chosenStartBoundarySec: 0, startDeltaSec: 0 });
  });

  it("keeps a back mark at or past the end as it is, since there is nothing to cut there", async () => {
    answerWith("packets", { packets: [] });

    const decision = await analyzeTrimDecision(RECORDING, { frontMarkerSec: null, backMarkerSec: 300 }, 300);

    expect(decision).toMatchObject({ kind: "stream-copy", chosenEndBoundarySec: 300, endDeltaSec: 0 });
  });
});

describe("preparing audio for transcription", () => {
  let workingDir = "";
  const streamCopy = {
    kind: "stream-copy",
    chosenStartBoundarySec: 9.75,
    chosenEndBoundarySec: 20,
  } as unknown as TrimDecision;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "mumbler-prepare-"));
  });

  afterEach(async () => {
    await rm(workingDir, { recursive: true, force: true });
  });

  it("sends the recording itself when nothing is trimmed away", async () => {
    const prepared = await prepareAudioForTranscription({
      sourceFilePath: "/recordings/take.m4a",
      workingDir,
      trim: { frontMarkerSec: null, backMarkerSec: null },
      trimDecision: null,
      durationSec: 300,
      audioProfile: null,
    });

    expect(prepared).toMatchObject({ filePath: "/recordings/take.m4a", mimeType: "audio/mp4", wasDerived: false });
    await expect(prepared.cleanup(), "there is nothing of ours to clean up").resolves.toBeUndefined();
  });

  it("copies the chosen span out at the packet boundary, without re-encoding it", async () => {
    const prepared = await prepareAudioForTranscription({
      sourceFilePath: "/recordings/take.m4a",
      workingDir,
      trim: { frontMarkerSec: 10, backMarkerSec: 20 },
      trimDecision: streamCopy,
      durationSec: 300,
      audioProfile: { formatName: "mov,mp4,m4a", codecName: "aac", bitRateKbps: 128, sampleRateHz: 44100, channels: 2 },
    });

    const args = ffmpegArgs();
    expect(args.slice(args.indexOf("-ss"), args.indexOf("-i") + 2)).toEqual(["-ss", "9.750", "-i", "/recordings/take.m4a"]);
    expect(args).toContain("copy");
    expect(args.join(" "), "the span runs from the boundary to the back mark").toContain("-t 10.250");
    expect(prepared.wasDerived).toBe(true);
    expect(prepared.filePath.startsWith(join(workingDir, "derived"))).toBe(true);
    expect(prepared.filePath.endsWith(".m4a"), "the derived file keeps the source's type").toBe(true);
    expect(existsSync(prepared.filePath)).toBe(true);

    await prepared.cleanup();
    expect(existsSync(prepared.filePath), "the derived copy does not outlive the run").toBe(false);
    await expect(prepared.cleanup(), "cleaning up twice is not a failure").resolves.toBeUndefined();
  });

  it("re-encodes from the user's own marks when the boundaries did not line up", async () => {
    const prepared = await prepareAudioForTranscription({
      sourceFilePath: "/recordings/take.mp3",
      workingDir,
      trim: { frontMarkerSec: 10, backMarkerSec: 20 },
      trimDecision: { kind: "reencode" } as unknown as TrimDecision,
      durationSec: 300,
      audioProfile: { formatName: "mp3", codecName: "mp3", bitRateKbps: 192, sampleRateHz: 44100, channels: 2 },
    });

    const args = ffmpegArgs();
    expect(args.indexOf("-ss"), "the seek is on the output side, for an exact cut").toBeGreaterThan(args.indexOf("-i"));
    expect(args.join(" ")).toContain("-ss 10.000");
    expect(args).not.toContain("copy");
    expect(args, "it is re-encoded to the source's own codec and rate").toContain("libmp3lame");
    expect(prepared).toMatchObject({ wasDerived: true, mimeType: "audio/mpeg" });
  });

  it("re-encodes when no decision was recorded at all", async () => {
    const prepared = await prepareAudioForTranscription({
      sourceFilePath: "/recordings/take.wav",
      workingDir,
      trim: { frontMarkerSec: 5, backMarkerSec: null },
      trimDecision: null,
      durationSec: 300,
      audioProfile: null,
    });

    const args = ffmpegArgs();
    expect(args).not.toContain("copy");
    expect(args.join(" "), "no end mark, so no duration is imposed").not.toContain("-t ");
    expect(prepared.wasDerived).toBe(true);
  });
});
