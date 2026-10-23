import type { GenerateTarget, MumblerCard } from "./app-shell";

export function resolveGenerateStartStep(card: MumblerCard, target: GenerateTarget): GenerateTarget {
  if (target !== "transcription" && card.transcription.text === null) {
    return "transcription";
  }

  if ((target === "title" || target === "slug") && card.metadata.structured === null) {
    return "structured";
  }

  if (target === "slug" && card.metadata.title === null) {
    return "title";
  }

  return target;
}
