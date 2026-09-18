import { describe, expect, it } from "vitest";

import { readWaveformPalette } from "@renderer/app/waveform-palette";

describe("readWaveformPalette", () => {
  it("reads each waveform color from its theme token", () => {
    const tokens: Record<string, string> = {
      "--waveform-wave": " rgba(1, 2, 3, 0.2) ",
      "--waveform-progress": "rgba(4, 5, 6, 0.9)",
      "--waveform-cursor": "#abcdef",
      "--waveform-region": "rgba(7, 8, 9, 0.2)",
    };
    expect(readWaveformPalette({ getPropertyValue: (name: string) => tokens[name] ?? "" })).toEqual({
      wave: "rgba(1, 2, 3, 0.2)",
      progress: "rgba(4, 5, 6, 0.9)",
      cursor: "#abcdef",
      region: "rgba(7, 8, 9, 0.2)",
    });
  });
});
