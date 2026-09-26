import type { GenerateTarget, MumblerCard, TrimDecision } from "@shared/app-shell";

import type { MessageKey } from "@shared/i18n/catalogues";
import { message, type Message, type Translator } from "@shared/i18n/translate";

import { formatCardStatusMessage } from "./card-status";

// The pure display/decision rules behind App.tsx: the disabled-reason and
// confirmation-body strings (where a silent branch bug would hide a data-loss
// warning) and the generate-target invalidation cascade. Lifted out of the
// component so each branch is testable without rendering.

export function formatOptionalSeconds(t: Pick<Translator, "seconds">, value: number | null): string {
  if (value === null) {
    return "—";
  }

  return t.seconds(value, { fractionDigits: 3 });
}

export function describeTrimDecision(decision: TrimDecision | null): Message {
  if (decision === null) {
    return message("trim.notAnalyzed");
  }

  if (decision.kind === "not-needed") {
    return message("trim.noMarkers");
  }

  if (decision.kind === "stream-copy") {
    return message("trim.streamCopy");
  }

  return message("trim.reencode");
}

// Why the trim analysis decided as it did. The main process records its own
// English with the decision; the interface says it from the decision's kind.
export function trimDecisionReason(decision: TrimDecision | null): Message {
  if (decision === null) return message("trim.reasonNone");
  switch (decision.kind) {
    case "not-needed":
      return message("trim.reasonNoMarkers");
    case "stream-copy":
      return message("trim.reasonWithinTolerance");
    case "reencode":
      return message("trim.reasonOutsideTolerance");
  }
}

export function getGenerateDisabledReason(params: {
  selectedCard: MumblerCard | null;
  hasGeminiKey: boolean;
}): Message | null {
  if (params.selectedCard === null) {
    return null;
  }

  if (!params.hasGeminiKey) {
    return message("generate.noApiKey");
  }

  return null;
}

export function getSaveDisabledReason(params: {
  selectedCard: MumblerCard | null;
  selectedCardIsBusy: boolean;
}): Message | null {
  if (params.selectedCard === null) {
    return null;
  }

  if (params.selectedCard.status !== "Ready to Save") {
    return message("output.notReady");
  }

  if (params.selectedCardIsBusy) {
    return formatCardStatusMessage(params.selectedCard);
  }

  return null;
}

export function getRemoveConfirmBody(card: MumblerCard): Message {
  const hasAiWork =
    (card.transcription.text ?? "").trim().length > 0 ||
    (card.metadata.structured ?? "").trim().length > 0 ||
    (card.metadata.title ?? "").trim().length > 0 ||
    (card.metadata.slug ?? "").trim().length > 0;

  if (hasAiWork) {
    return message("remove.bodyAiWork");
  }

  const hasTrimWork =
    card.trim.frontMarkerSec !== null || card.trim.backMarkerSec !== null;

  if (hasTrimWork) {
    return message("remove.bodyTrimWork");
  }

  return message("remove.bodyPlain");
}

export const resultLabels: Record<GenerateTarget, MessageKey> = {
  transcription: "result.transcription",
  structured: "result.structured",
  title: "result.title",
  slug: "result.slug",
};

// A whole title and body sentence per target, so no language builds them from
// a lowercased label.
export const generateConfirmTitles: Record<GenerateTarget, MessageKey> = {
  transcription: "generate.confirmTitle.transcription",
  structured: "generate.confirmTitle.structured",
  title: "generate.confirmTitle.title",
  slug: "generate.confirmTitle.slug",
};

const GENERATE_CONFIRM_BODIES: Record<GenerateTarget, MessageKey> = {
  transcription: "generate.confirmBody.transcription",
  structured: "generate.confirmBody.structured",
  title: "generate.confirmBody.title",
  slug: "generate.confirmBody.slug",
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

export function getGenerateConfirmBody(card: MumblerCard, target: GenerateTarget): Message | null {
  const invalidated = getInvalidatedGenerateTargets(target)
    .filter((entry) => (getResultValue(card, entry) ?? "").trim().length > 0)
    .map((entry) => message(resultLabels[entry]));
  if (invalidated.length === 0) {
    return null;
  }
  return message(GENERATE_CONFIRM_BODIES[target], { results: invalidated });
}
