import { describe, expect, it } from "vitest";

import type { CardError, CardProcessingStep, CardStatus, MumblerCard } from "@shared/app-shell";
import { formatActiveStepMessage, formatCardStatusMessage, formatStepName, isCardBusy } from "@renderer/app/card-status";

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
    expect(isCardBusy(card("Imported"))).toBe(false);
    expect(isCardBusy(card("Ready to Save"))).toBe(false);
    expect(isCardBusy(card("Error"))).toBe(false);
  });
});

describe("formatStepName", () => {
  it("names every pipeline step plus startup recovery", () => {
    expect(formatStepName("transcription")).toBe("transcription");
    expect(formatStepName("structured")).toBe("structured transcription");
    expect(formatStepName("title")).toBe("title");
    expect(formatStepName("slug")).toBe("slug");
    expect(formatStepName("startup-recovery")).toBe("startup recovery");
  });
});

describe("formatActiveStepMessage", () => {
  it("covers each active step including the null preparing state", () => {
    expect(formatActiveStepMessage("transcription")).toBe("Generating transcription");
    expect(formatActiveStepMessage("structured")).toBe("Generating structured transcription");
    expect(formatActiveStepMessage("title")).toBe("Generating title");
    expect(formatActiveStepMessage("slug")).toBe("Generating slug");
    expect(formatActiveStepMessage(null)).toBe("Preparing generation");
  });
});

describe("formatCardStatusMessage", () => {
  it("maps the steady-state statuses", () => {
    expect(formatCardStatusMessage(card("Pending Review"))).toBe("Pending timestamp review");
    expect(formatCardStatusMessage(card("Imported"))).toBe("Ready to generate");
    expect(formatCardStatusMessage(card("Queued"))).toBe("Queued to generate transcription");
    expect(formatCardStatusMessage(card("Ready to Save"))).toBe("Ready to save");
  });

  it("reflects the active step while working", () => {
    expect(formatCardStatusMessage(card("Transcribing", "transcription"))).toBe(
      "Generating transcription",
    );
    expect(formatCardStatusMessage(card("Generating Metadata", "title"))).toBe("Generating title");
  });

  it("names the failed/cancelled step when known and falls back when not", () => {
    const err = (failedStep: CardError["failedStep"]): CardError => ({
      message: "x",
      occurredAtUtc: 0,
      failedStep,
    });
    expect(formatCardStatusMessage(card("Error", null, err("slug")))).toBe(
      "Failed while working on slug",
    );
    expect(formatCardStatusMessage(card("Cancelled", null, err("structured")))).toBe(
      "Cancelled while working on structured transcription",
    );
    expect(formatCardStatusMessage(card("Error", null, null))).toBe("Failed");
    expect(formatCardStatusMessage(card("Cancelled", null, null))).toBe("Cancelled");
  });
});
