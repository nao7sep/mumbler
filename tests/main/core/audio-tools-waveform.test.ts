import { describe, expect, it } from "vitest";

import { streamTool, ToolTimeoutError, WaveformPeakReducer } from "@main/core/audio-tools";
import { isCancelledError } from "@main/core/cancellation";

// Interleaved little-endian floats, as ffmpeg's f32le output carries them.
function samples(...values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

describe("the waveform summary", () => {
  it("keeps the loudest sample of any channel in each span of frames", () => {
    // Two channels, two frames per peak: each peak covers four samples.
    const reducer = new WaveformPeakReducer(2, 2);
    reducer.push(samples(0.1, -0.2, 0.05, 0.3, -0.9, 0.0, 0.4, 0.1));
    expect([...reducer.finish()].map((value) => Number(value.toFixed(2)))).toEqual([0.3, 0.9]);
  });

  it("finds a channel that is loud alone, so neither side of a stereo file is lost", () => {
    const reducer = new WaveformPeakReducer(2, 1);
    reducer.push(samples(0, 0.8, 0.6, 0));
    expect([...reducer.finish()].map((value) => Number(value.toFixed(2)))).toEqual([0.8, 0.6]);
  });

  it("reads samples and frames split across chunks, and keeps a last partial span", () => {
    const whole = samples(0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7);
    const reducer = new WaveformPeakReducer(2, 2);
    for (const cut of [[0, 3], [3, 9], [9, 17], [17, 28]]) reducer.push(whole.subarray(cut[0], cut[1]));
    expect([...reducer.finish()].map((value) => Number(value.toFixed(2)))).toEqual([0.4, 0.7]);
  });

  it("grows past its first allocation", () => {
    const reducer = new WaveformPeakReducer(1, 1);
    reducer.push(samples(...Array.from({ length: 10_000 }, (_, index) => (index % 10) / 10)));
    const peaks = reducer.finish();
    expect(peaks).toHaveLength(10_000);
    expect(Number(peaks[9_999]!.toFixed(1))).toBe(0.9);
  });
});

// The real streaming path, with Node itself as the tool.
describe("a streamed tool run", () => {
  const node = process.execPath;

  it("hands over its output as it arrives and settles after the tool exits", async () => {
    const chunks: Buffer[] = [];
    await streamTool(node, ["-e", "process.stdout.write('ab'); setTimeout(() => process.stdout.write('cd'), 20);"], {
      timeoutMs: 10_000, onStdout: (chunk) => chunks.push(chunk),
    });
    expect(Buffer.concat(chunks).toString()).toBe("abcd");
  });

  it("names the exit and the end of what the tool said when it fails", async () => {
    await expect(streamTool(node, ["-e", "process.stderr.write('Invalid data found'); process.exit(3);"], {
      timeoutMs: 10_000, onStdout: () => undefined,
    })).rejects.toThrow(/exited with code 3: Invalid data found/);
  });

  it("stops on cancel with the pipeline's cancelled error", async () => {
    const controller = new AbortController();
    const running = streamTool(node, ["-e", "setInterval(() => process.stdout.write('x'), 10);"], {
      timeoutMs: 10_000, signal: controller.signal, onStdout: () => controller.abort(),
    });
    const error = await running.catch((cause: unknown) => cause);
    expect(isCancelledError(error)).toBe(true);
  });

  it("stops at its bound and says so", async () => {
    await expect(streamTool(node, ["-e", "setInterval(() => {}, 1000);"], {
      timeoutMs: 100, killEscalationMs: 50, onStdout: () => undefined,
    })).rejects.toBeInstanceOf(ToolTimeoutError);
  });
});
