import { describe, expect, it } from "vitest";

import type { AudioProfile } from "@shared/app-shell";
import {
  buildOutputTimingArgs,
  buildReencodeArgs,
  inferAudioMimeType,
} from "./audio-tools";

describe("inferAudioMimeType", () => {
  it("maps known extensions case-insensitively", () => {
    expect(inferAudioMimeType("a.mp3")).toBe("audio/mpeg");
    expect(inferAudioMimeType("a.M4A")).toBe("audio/mp4");
    expect(inferAudioMimeType("a.mp4")).toBe("audio/mp4");
    expect(inferAudioMimeType("a.aac")).toBe("audio/aac");
    expect(inferAudioMimeType("a.wav")).toBe("audio/wav");
    expect(inferAudioMimeType("a.flac")).toBe("audio/flac");
    expect(inferAudioMimeType("a.OGG")).toBe("audio/ogg");
    expect(inferAudioMimeType("a.opus")).toBe("audio/ogg");
    expect(inferAudioMimeType("a.aiff")).toBe("audio/aiff");
  });

  it("falls back to octet-stream for unknown extensions", () => {
    expect(inferAudioMimeType("a.xyz")).toBe("application/octet-stream");
    expect(inferAudioMimeType("noext")).toBe("application/octet-stream");
  });
});

describe("buildOutputTimingArgs", () => {
  it("emits only a clamped duration for the stream-copy shape (seek consumed input-side)", () => {
    // stream-copy: seekSec=0, baseOffset=startSec already seeked before -i.
    expect(buildOutputTimingArgs(0, 20, 5)).toEqual(["-t", "15.000"]);
  });

  it("emits an output-side seek plus duration for the re-encode shape", () => {
    // re-encode: seekSec=startSec, baseOffset=0.
    expect(buildOutputTimingArgs(5, 20, 0)).toEqual(["-ss", "5.000", "-t", "15.000"]);
  });

  it("omits duration entirely when there is no end marker", () => {
    expect(buildOutputTimingArgs(5, null, 0)).toEqual(["-ss", "5.000"]);
    expect(buildOutputTimingArgs(0, null, 0)).toEqual([]);
  });

  it("clamps a negative computed duration to zero", () => {
    expect(buildOutputTimingArgs(0, 3, 5)).toEqual(["-t", "0.000"]);
  });
});

describe("buildReencodeArgs", () => {
  const profile = (overrides: Partial<AudioProfile> = {}): AudioProfile => ({
    formatName: null,
    codecName: null,
    bitRateKbps: null,
    sampleRateHz: null,
    channels: null,
    ...overrides,
  });

  it("selects a codec and the source bitrate for lossy formats", () => {
    expect(buildReencodeArgs("/out/x.mp3", profile({ bitRateKbps: 128 }))).toEqual([
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
    ]);
    expect(buildReencodeArgs("/out/x.m4a", profile({ bitRateKbps: 256 }))).toEqual([
      "-c:a",
      "aac",
      "-b:a",
      "256k",
    ]);
  });

  it("defaults to 192k when the profile has no bitrate", () => {
    expect(buildReencodeArgs("/out/x.mp3", null)).toEqual([
      "-c:a",
      "libmp3lame",
      "-b:a",
      "192k",
    ]);
  });

  it("uses lossless codecs without a bitrate for flac/wav/aiff", () => {
    expect(buildReencodeArgs("/out/x.flac", null)).toEqual(["-c:a", "flac"]);
    expect(buildReencodeArgs("/out/x.wav", null)).toEqual(["-c:a", "pcm_s16le"]);
    expect(buildReencodeArgs("/out/x.aiff", null)).toEqual(["-c:a", "pcm_s16be"]);
  });

  it("picks libopus for opus sources and libvorbis otherwise within ogg containers", () => {
    expect(buildReencodeArgs("/out/x.ogg", profile({ codecName: "opus", bitRateKbps: 16 }))).toEqual(
      ["-c:a", "libopus", "-b:a", "24k"], // bitrate floored at 24
    );
    expect(buildReencodeArgs("/out/x.ogg", profile({ codecName: "vorbis", bitRateKbps: 160 }))).toEqual(
      ["-c:a", "libvorbis", "-b:a", "160k"],
    );
  });

  it("stream-copies unknown extensions", () => {
    expect(buildReencodeArgs("/out/x.xyz", null)).toEqual(["-c:a", "copy"]);
  });
});
