import type { MumblerCard } from "./app-shell";
import { formatUtcMarker } from "./timestamps";

/** The name a save gives a recording's files, without the extension: its
 * official start in UTC, then its slug. Null until there is a slug. */
export function outputBaseName(card: Pick<MumblerCard, "timestamps" | "metadata">): string | null {
  const slug = card.metadata.slug?.trim() ?? "";
  if (slug.length === 0) return null;
  return `${formatUtcMarker(new Date(card.timestamps.effectiveUtc))}-${slug}`;
}

/** The saved audio's file name: the base name with the recording's own extension. */
export function outputAudioName(card: Pick<MumblerCard, "timestamps" | "metadata" | "sourceFilePath">): string | null {
  const base = outputBaseName(card);
  if (base === null) return null;
  const name = card.sourceFilePath.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return `${base}${dot > 0 ? name.slice(dot) : ""}`;
}
