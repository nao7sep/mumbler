import type { CardProcessingStep, MumblerCard } from "@shared/app-shell";
import type { MessageKey } from "@shared/i18n/catalogues";
import { message, type Message } from "@shared/i18n/translate";

// The busy predicate lives in shared so the renderer's control disabling and the
// main process's mutation guards read the same definition; re-exported here so
// renderer callers keep one import for all card-status helpers.
export { hasStaleResults, isCardBusy } from "@shared/card-status";

export const staleResultsNote: Message = message("status.stale");

type StoppedStep = Exclude<CardProcessingStep, null> | "startup-recovery";

const STEP_NAMES: Record<StoppedStep, MessageKey> = {
  transcription: "step.transcription",
  structured: "step.structured",
  title: "step.title",
  slug: "step.slug",
  "startup-recovery": "step.startupRecovery",
};

// A step named on its own, as a value beside a label.
export function formatStepName(step: StoppedStep): Message {
  return message(STEP_NAMES[step]);
}

export function formatActiveStepMessage(step: CardProcessingStep): Message {
  switch (step) {
    case "transcription":
      return message("status.generatingTranscription");
    case "structured":
      return message("status.generatingStructured");
    case "title":
      return message("status.generatingTitle");
    case "slug":
      return message("status.generatingSlug");
    case null:
      return message("status.preparing");
  }
}

// Each step has its own whole sentence, so no language builds one from a step name.
const CANCELLED_WHILE: Record<StoppedStep, MessageKey> = {
  transcription: "status.cancelledWhile.transcription",
  structured: "status.cancelledWhile.structured",
  title: "status.cancelledWhile.title",
  slug: "status.cancelledWhile.slug",
  "startup-recovery": "status.cancelledWhile.startupRecovery",
};

const FAILED_WHILE: Record<StoppedStep, MessageKey> = {
  transcription: "status.failedWhile.transcription",
  structured: "status.failedWhile.structured",
  title: "status.failedWhile.title",
  slug: "status.failedWhile.slug",
  "startup-recovery": "status.failedWhile.startupRecovery",
};

export function formatCardStatusMessage(card: MumblerCard): Message {
  switch (card.status) {
    case "Pending Review":
      return message("status.pendingReview");
    case "Imported":
      return message("status.imported");
    case "Queued":
      return message("status.queued");
    case "Transcribing":
    case "Generating Metadata":
      return formatActiveStepMessage(card.activeStep);
    case "Ready to Save":
      return message("status.readyToSave");
    case "Saving":
      return message("status.saving");
    case "Cancelled":
      return card.lastError?.failedStep
        ? message(CANCELLED_WHILE[card.lastError.failedStep])
        : message("status.cancelled");
    case "Error":
      return card.lastError?.failedStep
        ? message(FAILED_WHILE[card.lastError.failedStep])
        : message("status.failed");
  }
}

// What stopped a card, said in the reader's language. The main process records
// its own English with the card for the log's sake (card.lastError.message);
// the interface derives the sentence from the status and the step it stopped at.
export function cardErrorMessage(card: MumblerCard): Message | null {
  if (card.lastError === null) return null;
  if (card.status === "Cancelled") return message("cardError.cancelled");
  switch (card.lastError.failedStep) {
    case "startup-recovery":
      return message("cardError.interrupted");
    case "transcription":
      return message("cardError.transcription");
    case "structured":
    case "title":
    case "slug":
      return message("cardError.metadata");
    default:
      return message("cardError.generic");
  }
}
