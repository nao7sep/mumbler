import { describe, expect, it } from "vitest";

import type { MumblerCard } from "@shared/app-shell";
import { outputAudioName, outputBaseName } from "@shared/output-name";

function card(slug: string | null, sourceFilePath = "/working/take.m4a"): Pick<MumblerCard, "timestamps" | "metadata" | "sourceFilePath"> {
  return {
    timestamps: { effectiveUtc: Date.UTC(2026, 9, 15, 4, 30, 22, 600) } as MumblerCard["timestamps"],
    metadata: { structured: null, title: null, slug },
    sourceFilePath,
  };
}

describe("the saved recording's name", () => {
  it("is the official start in UTC, the slug and the recording's own extension", () => {
    expect(outputBaseName(card("team-sync"))).toBe("20261015-043022-utc-team-sync");
    expect(outputAudioName(card("team-sync"))).toBe("20261015-043022-utc-team-sync.m4a");
    expect(outputAudioName(card("team-sync", "C:\\working\\take.WAV"))).toBe("20261015-043022-utc-team-sync.WAV");
  });

  it("waits for a slug", () => {
    expect(outputAudioName(card(null))).toBeNull();
    expect(outputAudioName(card("  "))).toBeNull();
  });
});
