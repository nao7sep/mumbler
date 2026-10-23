import type { PendingImportReviewItem, RecordingTimeCandidate } from "./app-shell";
import { formatUtcForDisplay, recomputeLocalFromUtc, recomputeUtcFromLocal } from "./timestamps";

type ReviewTime = Pick<PendingImportReviewItem, "localTimestampText" | "utcTimestampText" | "timestampBasis">;

/** Preserve an exact recording instant; only zone-less input needs interpretation. */
export function recordingTimeDraft(candidate: RecordingTimeCandidate | null, timezone: string): ReviewTime {
  if (candidate === null) return { localTimestampText: "", utcTimestampText: "", timestampBasis: "local" };
  if (candidate.utcMs !== null) {
    const local = recomputeLocalFromUtc(candidate.utcMs, timezone);
    return { localTimestampText: local.error === null ? local.localTimestampText : "", utcTimestampText: formatUtcForDisplay(candidate.utcMs), timestampBasis: "utc" };
  }
  const localTimestampText = candidate.localText ?? "";
  const utc = recomputeUtcFromLocal(localTimestampText, timezone);
  return { localTimestampText, utcTimestampText: utc.error === null ? formatUtcForDisplay(utc.utcMs!) : "", timestampBasis: "local" };
}

export function changeReviewTimezone(item: PendingImportReviewItem, timezone: string): PendingImportReviewItem {
  if (item.timestampBasis === "utc") {
    const local = recomputeLocalFromUtc(item.utcTimestampText, timezone);
    return { ...item, timezone, localTimestampText: local.error === null ? local.localTimestampText : item.localTimestampText };
  }
  const utc = recomputeUtcFromLocal(item.localTimestampText, timezone);
  if (utc.error === null) return { ...item, timezone, utcTimestampText: formatUtcForDisplay(utc.utcMs!) };
  const local = recomputeLocalFromUtc(item.utcTimestampText, timezone);
  return local.error === null
    ? { ...item, timezone, localTimestampText: local.localTimestampText, timestampBasis: "utc" }
    : { ...item, timezone };
}
