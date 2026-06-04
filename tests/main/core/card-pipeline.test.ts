import { describe, expect, it, vi } from "vitest";

import type { MumblerCard } from "@shared/app-shell";
import {
  clearCardResults,
  clearCardResultsFromStep,
  computeRetryDelayMs,
  resolveGenerateStartStep,
  sanitizeSlug,
  sanitizeTitle,
} from "@main/core/card-pipeline";

function makeCard(overrides: Partial<MumblerCard> = {}): MumblerCard {
  return {
    id: "card-1",
    originalFilename: "rec.m4a",
    importSource: "file-picker",
    sourceFilePath: "/tmp/rec.m4a",
    audioProfile: null,
    durationSec: 60,
    fileSizeBytes: 1024,
    timestamps: {
      confirmedLocal: "2026-04-22 09:44:00",
      confirmedUtc: Date.UTC(2026, 3, 22, 0, 44, 0),
      timezone: "Asia/Tokyo",
      frontTrimOffsetSec: 0,
      effectiveLocal: "2026-04-22 09:44:00",
      effectiveUtc: Date.UTC(2026, 3, 22, 0, 44, 0),
    },
    trim: { frontMarkerSec: null, backMarkerSec: null },
    trimDecision: null,
    transcription: { text: "raw text" },
    metadata: { structured: "structured", title: "Title", slug: "slug" },
    ai: {
      transcription: { provider: "gemini", model: "m", generatedAtUtc: 1 },
      structured: { provider: "gemini", model: "m", generatedAtUtc: 1 },
      title: { provider: "gemini", model: "m", generatedAtUtc: 1 },
      slug: { provider: "gemini", model: "m", generatedAtUtc: 1 },
    },
    status: "Ready to Save",
    activeStep: null,
    queuedMode: null,
    queuedAtUtc: null,
    lastError: null,
    createdAtUtc: 1,
    updatedAtUtc: 1,
    ...overrides,
  };
}

describe("resolveGenerateStartStep", () => {
  it("starts at transcription when targeting transcription", () => {
    const card = makeCard();
    expect(resolveGenerateStartStep(card, "transcription")).toBe("transcription");
  });

  it("backs up to transcription when the transcript is missing", () => {
    const card = makeCard({ transcription: { text: null } });
    expect(resolveGenerateStartStep(card, "slug")).toBe("transcription");
    expect(resolveGenerateStartStep(card, "structured")).toBe("transcription");
  });

  it("backs up to structured when targeting title/slug without a structured outline", () => {
    const card = makeCard({ metadata: { structured: null, title: null, slug: null } });
    expect(resolveGenerateStartStep(card, "title")).toBe("structured");
    expect(resolveGenerateStartStep(card, "slug")).toBe("structured");
  });

  it("backs up to title when targeting slug without a title", () => {
    const card = makeCard({ metadata: { structured: "s", title: null, slug: null } });
    expect(resolveGenerateStartStep(card, "slug")).toBe("title");
  });

  it("uses the requested step when every prerequisite is present", () => {
    const card = makeCard();
    expect(resolveGenerateStartStep(card, "slug")).toBe("slug");
    expect(resolveGenerateStartStep(card, "title")).toBe("title");
    expect(resolveGenerateStartStep(card, "structured")).toBe("structured");
  });
});

describe("clearCardResultsFromStep", () => {
  it("clearing from title keeps transcription and structured but drops title and slug", () => {
    const card = makeCard();
    clearCardResultsFromStep(card, "title");
    expect(card.transcription.text).toBe("raw text");
    expect(card.metadata.structured).toBe("structured");
    expect(card.metadata.title).toBeNull();
    expect(card.metadata.slug).toBeNull();
    expect(card.ai.title).toBeNull();
    expect(card.ai.slug).toBeNull();
  });

  it("clearing from structured drops structured, title, and slug", () => {
    const card = makeCard();
    clearCardResultsFromStep(card, "structured");
    expect(card.transcription.text).toBe("raw text");
    expect(card.metadata.structured).toBeNull();
    expect(card.metadata.title).toBeNull();
    expect(card.metadata.slug).toBeNull();
  });

  it("clearing from transcription drops everything", () => {
    const card = makeCard();
    clearCardResultsFromStep(card, "transcription");
    expect(card.transcription.text).toBeNull();
    expect(card.ai.transcription).toBeNull();
    expect(card.metadata.structured).toBeNull();
    expect(card.metadata.title).toBeNull();
    expect(card.metadata.slug).toBeNull();
  });
});

describe("clearCardResults", () => {
  it("resets a finished card back to Imported with cleared outputs", () => {
    const card = makeCard({ queuedMode: "generate", queuedAtUtc: 5, lastError: null });
    clearCardResults(card);
    expect(card.status).toBe("Imported");
    expect(card.activeStep).toBeNull();
    expect(card.queuedMode).toBeNull();
    expect(card.queuedAtUtc).toBeNull();
    expect(card.transcription.text).toBeNull();
    expect(card.metadata.slug).toBeNull();
  });
});

describe("sanitizeTitle", () => {
  it("strips markdown emphasis markers", () => {
    expect(sanitizeTitle("**Bold Title**")).toBe("Bold Title");
    expect(sanitizeTitle("*Emphasis*")).toBe("Emphasis");
  });

  it("strips surrounding quotes and backticks", () => {
    expect(sanitizeTitle('"Quoted"')).toBe("Quoted");
    expect(sanitizeTitle("`code`")).toBe("code");
    expect(sanitizeTitle("'single'")).toBe("single");
  });

  it("collapses internal whitespace and trims", () => {
    expect(sanitizeTitle("  a\n\n  b   c  ")).toBe("a b c");
  });
});

describe("sanitizeSlug", () => {
  it("lowercases and hyphenates", () => {
    expect(sanitizeSlug("Hello World!")).toBe("hello-world");
  });

  it("trims leading and trailing separators", () => {
    expect(sanitizeSlug("  --Trim Me--  ")).toBe("trim-me");
  });

  it("returns an empty string when nothing survives sanitization", () => {
    expect(sanitizeSlug("!!! ???")).toBe("");
  });

  it("clamps the result to at most 80 characters", () => {
    const long = "word ".repeat(40); // 200 chars of words
    expect(sanitizeSlug(long).length).toBeLessThanOrEqual(80);
  });
});

describe("computeRetryDelayMs", () => {
  const policy = { maxRetries: 5, initialDelayMs: 1000, maxDelayMs: 16000, jitterRatio: 0 };

  it("grows by powers of four with no jitter", () => {
    expect(computeRetryDelayMs(1, policy)).toBe(1000);
    expect(computeRetryDelayMs(2, policy)).toBe(4000);
    expect(computeRetryDelayMs(3, policy)).toBe(16000);
  });

  it("clamps to the configured maximum delay", () => {
    expect(computeRetryDelayMs(4, policy)).toBe(16000);
    expect(computeRetryDelayMs(10, policy)).toBe(16000);
  });

  it("applies jitter within the symmetric window", () => {
    const jittered = { ...policy, jitterRatio: 0.25 }; // window = 250 at base 1000
    const random = vi.spyOn(Math, "random");
    try {
      random.mockReturnValue(0); // offset = -window
      expect(computeRetryDelayMs(1, jittered)).toBe(750);
      random.mockReturnValue(1); // offset = +window
      expect(computeRetryDelayMs(1, jittered)).toBe(1250);
      random.mockReturnValue(0.5); // offset = 0
      expect(computeRetryDelayMs(1, jittered)).toBe(1000);
    } finally {
      random.mockRestore();
    }
  });
});
