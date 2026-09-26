import { describe, expect, it } from "vitest";

import type { CardError, CardProcessingStep, CardStatus, MumblerCard } from "@shared/app-shell";
import { formatActiveStepMessage, formatCardStatusMessage, formatStepName, isCardBusy } from "@renderer/app/card-status";
import { createTranslator, type Message } from "@shared/i18n/translate";

const english = createTranslator("en");
function en(message: Message | null): string | null {
  return message === null ? null : english.text(message);
}

// formatCardStatusMessage only reads status, activeStep, and lastError.
function card(
  status: CardStatus,
  activeStep: CardProcessingStep = null,
  lastError: CardError | null = null,
): MumblerCard {
  return { status, activeStep, lastError } as MumblerCard;
}

describe("isCardBusy", () => {
  it("is true only for in-flight statuses", () => {
    expect(isCardBusy(card("Queued"))).toBe(true);
    expect(isCardBusy(card("Transcribing"))).toBe(true);
    expect(isCardBusy(card("Generating Metadata"))).toBe(true);
    expect(isCardBusy(card("Saving")), "a save in progress owns its card").toBe(true);
    expect(isCardBusy(card("Imported"))).toBe(false);
    expect(isCardBusy(card("Ready to Save"))).toBe(false);
    expect(isCardBusy(card("Error"))).toBe(false);
  });
});

describe("formatStepName", () => {
  it("names every pipeline step plus startup recovery", () => {
    expect(en(formatStepName("transcription"))).toBe("Transcription");
    expect(en(formatStepName("structured"))).toBe("Structured transcription");
    expect(en(formatStepName("title"))).toBe("Title");
    expect(en(formatStepName("slug"))).toBe("Slug");
    expect(en(formatStepName("startup-recovery"))).toBe("Startup recovery");
  });
});

describe("formatActiveStepMessage", () => {
  it("covers each active step including the null preparing state", () => {
    expect(en(formatActiveStepMessage("transcription"))).toBe("Generating transcription");
    expect(en(formatActiveStepMessage("structured"))).toBe("Generating structured transcription");
    expect(en(formatActiveStepMessage("title"))).toBe("Generating title");
    expect(en(formatActiveStepMessage("slug"))).toBe("Generating slug");
    expect(en(formatActiveStepMessage(null))).toBe("Preparing generation");
  });
});

describe("formatCardStatusMessage", () => {
  it("maps the steady-state statuses", () => {
    expect(en(formatCardStatusMessage(card("Pending Review")))).toBe("Pending timestamp review");
    expect(en(formatCardStatusMessage(card("Imported")))).toBe("Ready to generate");
    expect(en(formatCardStatusMessage(card("Queued")))).toBe("Queued to generate transcription");
    expect(en(formatCardStatusMessage(card("Ready to Save")))).toBe("Ready to save");
  });

  it("reflects the active step while working", () => {
    expect(en(formatCardStatusMessage(card("Transcribing", "transcription")))).toBe(
      "Generating transcription",
    );
    expect(en(formatCardStatusMessage(card("Generating Metadata", "title")))).toBe("Generating title");
  });

  it("names the failed/cancelled step when known and falls back when not", () => {
    const err = (failedStep: CardError["failedStep"]): CardError => ({
      message: "x",
      occurredAtUtc: 0,
      failedStep,
    });
    expect(en(formatCardStatusMessage(card("Error", null, err("slug"))))).toBe(
      "Failed while working on the slug",
    );
    expect(en(formatCardStatusMessage(card("Cancelled", null, err("structured"))))).toBe(
      "Cancelled while working on the structured transcription",
    );
    expect(en(formatCardStatusMessage(card("Error", null, null)))).toBe("Failed");
    expect(en(formatCardStatusMessage(card("Cancelled", null, null)))).toBe("Cancelled");
  });
});
