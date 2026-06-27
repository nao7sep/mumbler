import type { GenerateTarget, MumblerCard, TrimDecision } from "@shared/app-shell";

import { formatCardStatusMessage } from "./card-status";

// The pure display/decision rules behind App.tsx: the disabled-reason and
// confirmation-body strings (where a silent branch bug would hide a data-loss
// warning) and the generate-target invalidation cascade. Lifted out of the
// component so each branch is testable without rendering.

export function formatOptionalSeconds(value: number | null): string {
  if (value === null) {
    return "—";
  }

  return `${value.toFixed(3)}s`;
}

export function describeTrimDecision(decision: TrimDecision | null): string {
  if (decision === null) {
    return "Not analyzed.";
  }

  if (decision.kind === "not-needed") {
    return "No markers set.";
  }

  if (decision.kind === "stream-copy") {
    return "Stream copy eligible.";
  }

  return "Re-encode required.";
}

export function getGenerateDisabledReason(params: {
  selectedCard: MumblerCard | null;
  hasGeminiKey: boolean;
}): string | null {
  if (params.selectedCard === null) {
    return null;
  }

  if (!params.hasGeminiKey) {
    return "Gemini API key not configured.";
  }

  return null;
}

export function getSaveDisabledReason(params: {
  selectedCard: MumblerCard | null;
  selectedCardIsBusy: boolean;
}): string | null {
  if (params.selectedCard === null) {
    return null;
  }

  if (params.selectedCard.status !== "Ready to Save") {
    return "Not ready to save.";
  }

  if (params.selectedCardIsBusy) {
    return formatCardStatusMessage(params.selectedCard);
  }

  return null;
}

export function getRemoveConfirmBody(card: MumblerCard): string {
  const hasAiWork =
    (card.transcription.text ?? "").trim().length > 0 ||
    (card.metadata.structured ?? "").trim().length > 0 ||
    (card.metadata.title ?? "").trim().length > 0 ||
    (card.metadata.slug ?? "").trim().length > 0;

  if (hasAiWork) {
    return "This recording has been processed by AI. Removing it will permanently discard the transcription and generated metadata. Working audio will be permanently deleted.";
  }

  const hasTrimWork =
    card.trim.frontMarkerSec !== null || card.trim.backMarkerSec !== null;

  if (hasTrimWork) {
    return "You've set trim markers on this recording. Removing it will discard that work. Working audio will be permanently deleted.";
  }

  return "Working audio will be permanently deleted. Saved output is not affected.";
}

export const resultLabels: Record<GenerateTarget, string> = {
  transcription: "Transcription",
  structured: "Structured transcription",
  title: "Title",
  slug: "Slug",
};

function getResultValue(card: MumblerCard, target: GenerateTarget): string | null {
  switch (target) {
    case "transcription":
      return card.transcription.text;
    case "structured":
      return card.metadata.structured;
    case "title":
      return card.metadata.title;
    case "slug":
      return card.metadata.slug;
  }
}

export function getInvalidatedGenerateTargets(target: GenerateTarget): GenerateTarget[] {
  switch (target) {
    case "transcription":
      return ["transcription", "structured", "title", "slug"];
    case "structured":
      return ["structured", "title", "slug"];
    case "title":
      return ["title", "slug"];
    case "slug":
      return ["slug"];
  }
}

export function getGenerateConfirmBody(card: MumblerCard, target: GenerateTarget): string | null {
  const invalidated = getInvalidatedGenerateTargets(target)
    .filter((entry) => (getResultValue(card, entry) ?? "").trim().length > 0)
    .map((entry) => resultLabels[entry]);
  if (invalidated.length === 0) {
    return null;
  }
  const labelText = invalidated.join(", ");
  return `Generating ${resultLabels[target].toLowerCase()} will replace existing data for: ${labelText}.`;
}
