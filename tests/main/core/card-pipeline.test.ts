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
    transcribedTrim: null,
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
    const card = makeCard({ transcribedTrim: { frontMarkerSec: null, backMarkerSec: null } });
    clearCardResultsFromStep(card, "transcription");
    expect(card.transcription.text).toBeNull();
    expect(card.ai.transcription).toBeNull();
    expect(card.transcribedTrim).toBeNull();
    expect(card.metadata.structured).toBeNull();
    expect(card.metadata.title).toBeNull();
    expect(card.metadata.slug).toBeNull();
  });
});

describe("clearCardResultsFromStep — whether content changed", () => {
  it("reports clearing content, and not clearing what was already empty", () => {
    const card = makeCard();
    expect(clearCardResultsFromStep(card, "title")).toBe(true);
    expect(clearCardResultsFromStep(card, "title")).toBe(false);
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

  it("bounds a slug at 80 characters without leaving a trailing separator", () => {
    const slug = sanitizeSlug(`${"a".repeat(79)} tail`);
    expect(slug).toBe("a".repeat(79));
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
  function at(attempt: number, random: number): number {
    const spy = vi.spyOn(Math, "random").mockReturnValue(random);
    try { return computeRetryDelayMs(attempt); } finally { spy.mockRestore(); }
  }

  it("grows by powers of four from a second, centred when the jitter draws the middle", () => {
    expect([1, 2, 3].map((attempt) => at(attempt, 0.5))).toEqual([1000, 4000, 16000]);
  });

  it("stops growing at sixteen seconds", () => {
    expect(at(4, 0.5)).toBe(16000);
    expect(at(10, 0.5)).toBe(16000);
  });

  it("spreads each wait by a fifth either way", () => {
    expect(at(1, 0)).toBe(800);
    expect(at(1, 1)).toBe(1200);
  });
});
