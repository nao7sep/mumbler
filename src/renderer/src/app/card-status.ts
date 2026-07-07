import type { CardProcessingStep, MumblerCard } from "@shared/app-shell";

export function isCardBusy(card: MumblerCard): boolean {
  return (
    card.status === "Queued" ||
    card.status === "Transcribing" ||
    card.status === "Generating Metadata"
  );
}

export function formatStepName(step: Exclude<CardProcessingStep, null> | "startup-recovery"): string {
  switch (step) {
    case "transcription":
      return "transcription";
    case "structured":
      return "structured transcription";
    case "title":
      return "title";
    case "slug":
      return "slug";
    case "startup-recovery":
      return "startup recovery";
  }
}

export function formatActiveStepMessage(step: CardProcessingStep): string {
  switch (step) {
    case "transcription":
      return "Generating transcription";
    case "structured":
      return "Generating structured transcription";
    case "title":
      return "Generating title";
    case "slug":
      return "Generating slug";
    case null:
      return "Preparing generation";
  }
}

export function formatCardStatusMessage(card: MumblerCard): string {
  switch (card.status) {
    case "Pending Review":
      return "Pending timestamp review";
    case "Imported":
      return "Ready to generate";
    case "Queued":
      return "Queued to generate transcription";
    case "Transcribing":
    case "Generating Metadata":
      return formatActiveStepMessage(card.activeStep);
    case "Ready to Save":
      return "Ready to save";
    case "Cancelled":
      return card.lastError?.failedStep
        ? `Cancelled while working on ${formatStepName(card.lastError.failedStep)}`
        : "Cancelled";
    case "Error":
      return card.lastError?.failedStep
        ? `Failed while working on ${formatStepName(card.lastError.failedStep)}`
        : "Failed";
  }
}
