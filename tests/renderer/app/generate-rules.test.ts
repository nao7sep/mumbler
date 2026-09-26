import { describe, expect, it } from "vitest";

import type { CardStatus, MumblerCard, TrimDecision, TrimDecisionKind } from "@shared/app-shell";
import {
  describeTrimDecision,
  formatOptionalSeconds,
  getGenerateConfirmBody,
  getGenerateDisabledReason,
  getInvalidatedGenerateTargets,
  getRemoveConfirmBody,
  getSaveDisabledReason,
} from "@renderer/app/generate-rules";
import { createTranslator, type Message } from "@shared/i18n/translate";

const english = createTranslator("en");
function en(message: Message | null): string | null {
  return message === null ? null : english.text(message);
}

// Each helper reads only a slice of MumblerCard; build that slice and cast.
function card(
  over: Partial<{
    status: CardStatus;
    transcription: string | null;
    structured: string | null;
    title: string | null;
    slug: string | null;
    frontMarkerSec: number | null;
    backMarkerSec: number | null;
  }> = {},
): MumblerCard {
  return {
    status: over.status ?? "Ready to Save",
    transcription: { text: over.transcription ?? null },
    metadata: { structured: over.structured ?? null, title: over.title ?? null, slug: over.slug ?? null },
    trim: { frontMarkerSec: over.frontMarkerSec ?? null, backMarkerSec: over.backMarkerSec ?? null },
  } as MumblerCard;
}

const decision = (kind: TrimDecisionKind): TrimDecision => ({ kind }) as unknown as TrimDecision;

describe("formatOptionalSeconds", () => {
  it("formats to three decimals, or an em dash for null", () => {
    expect(formatOptionalSeconds(english, null)).toBe("—");
    expect(formatOptionalSeconds(english, 1.23456)).toBe("1.235s");
    expect(formatOptionalSeconds(english, 0)).toBe("0.000s");
    expect(formatOptionalSeconds(createTranslator("de"), 1.5)).toMatch(/^1,500\s/);
  });
});

describe("describeTrimDecision", () => {
  it("maps each decision kind", () => {
    expect(en(describeTrimDecision(null))).toBe("Not analyzed.");
    expect(en(describeTrimDecision(decision("not-needed")))).toBe("No markers set.");
    expect(en(describeTrimDecision(decision("stream-copy")))).toBe("Stream copy eligible.");
    expect(en(describeTrimDecision(decision("reencode")))).toBe("Re-encode required.");
  });
});

describe("getGenerateDisabledReason", () => {
  it("is null without a card, flags a missing key, clears when keyed", () => {
    expect(en(getGenerateDisabledReason({ selectedCard: null, hasGeminiKey: false }))).toBeNull();
    expect(en(getGenerateDisabledReason({ selectedCard: card(), hasGeminiKey: false }))).toBe(
      "Gemini API key not configured.",
    );
    expect(en(getGenerateDisabledReason({ selectedCard: card(), hasGeminiKey: true }))).toBeNull();
  });
});

describe("getSaveDisabledReason", () => {
  it("covers no-card, not-ready, ready, and busy", () => {
    expect(en(getSaveDisabledReason({ selectedCard: null, selectedCardIsBusy: false }))).toBeNull();
    expect(
      en(getSaveDisabledReason({ selectedCard: card({ status: "Transcribing" }), selectedCardIsBusy: false })),
    ).toBe("Not ready to save.");
    expect(
      en(getSaveDisabledReason({ selectedCard: card({ status: "Ready to Save" }), selectedCardIsBusy: false })),
    ).toBeNull();
    expect(
      typeof en(getSaveDisabledReason({ selectedCard: card({ status: "Ready to Save" }), selectedCardIsBusy: true })),
    ).toBe("string");
  });
});

describe("getInvalidatedGenerateTargets", () => {
  it("cascades to every downstream target", () => {
    expect(getInvalidatedGenerateTargets("transcription")).toEqual([
      "transcription",
      "structured",
      "title",
      "slug",
    ]);
    expect(getInvalidatedGenerateTargets("structured")).toEqual(["structured", "title", "slug"]);
    expect(getInvalidatedGenerateTargets("title")).toEqual(["title", "slug"]);
    expect(getInvalidatedGenerateTargets("slug")).toEqual(["slug"]);
  });
});

describe("getGenerateConfirmBody (the data-loss warning)", () => {
  it("returns null when nothing downstream would be replaced", () => {
    expect(en(getGenerateConfirmBody(card(), "transcription"))).toBeNull();
  });

  it("lists every existing downstream field that would be replaced", () => {
    const c = card({ transcription: "t", structured: "s", title: "T", slug: "sl" });
    expect(en(getGenerateConfirmBody(c, "transcription"))).toBe(
      "Generating the transcription will replace existing data for: Transcription, Structured transcription, Title, Slug.",
    );
  });

  it("counts only targets downstream of the chosen one", () => {
    // Generating the title invalidates title + slug only; slug is empty here.
    const c = card({ transcription: "t", structured: "s", title: "T" });
    expect(en(getGenerateConfirmBody(c, "title"))).toBe(
      "Generating the title will replace existing data for: Title.",
    );
  });

  it("treats whitespace-only existing values as empty", () => {
    expect(en(getGenerateConfirmBody(card({ structured: "   " }), "transcription"))).toBeNull();
  });
});

describe("getRemoveConfirmBody", () => {
  it("warns about AI work when any AI output exists", () => {
    expect(en(getRemoveConfirmBody(card({ title: "T" })))).toMatch(/processed by AI/);
  });

  it("warns about trim work when only markers are set", () => {
    expect(en(getRemoveConfirmBody(card({ frontMarkerSec: 1 })))).toMatch(/trim markers/);
  });

  it("gives the plain message when there is no work to lose", () => {
    expect(en(getRemoveConfirmBody(card()))).toMatch(/Saved output is not affected/);
  });
});
