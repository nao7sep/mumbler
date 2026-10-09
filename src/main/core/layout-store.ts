import type { MumblerLayout } from "@shared/app-shell";
import { QUEUE_WIDTH, RECORDS_LIST_WIDTH } from "@shared/layout";
import { formatUtcIsoCompact, parseUtcMs } from "@shared/timestamps";

import { FORMAT_VERSIONS } from "./format-versions";
import { JsonStore } from "./json-store";

// Snap a persisted/candidate width to the queue-pane bounds. A non-finite or
// out-of-range value is pulled to the nearest valid width rather than rejected,
// so a hand-edited or drifted layout.json self-heals instead of blocking.
function clampPaneWidth(value: unknown, bounds: { min: number; default: number; max: number }): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return bounds.default;
  }
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(value)));
}

export function clampQueueWidth(value: unknown): number {
  return clampPaneWidth(value, QUEUE_WIDTH);
}

// The records window's list pane, healed the same way.
export function clampRecordsListWidth(value: unknown): number {
  return clampPaneWidth(value, RECORDS_LIST_WIDTH);
}

export function createDefaultLayout(): MumblerLayout {
  return {
    queueWidth: QUEUE_WIDTH.default,
    recordsListWidth: RECORDS_LIST_WIDTH.default,
    selectedCardId: null,
    releaseCheckAttemptAtUtc: null,
  };
}

export function normalizeLayout(raw: Record<string, unknown>): MumblerLayout {
  return {
    queueWidth: clampQueueWidth(raw.queueWidth),
    recordsListWidth: clampRecordsListWidth(raw.recordsListWidth),
    selectedCardId: typeof raw.selectedCardId === "string" ? raw.selectedCardId : null,
    releaseCheckAttemptAtUtc: parseUtcMs(raw.releaseCheckAttemptAtUtc),
  };
}

function serializeLayout(layout: MumblerLayout): object {
  return {
    ...layout,
    releaseCheckAttemptAtUtc: layout.releaseCheckAttemptAtUtc === null ? null : formatUtcIsoCompact(layout.releaseCheckAttemptAtUtc),
  };
}

export function selectExistingCardId(
  cardIds: readonly string[],
  selectedCardId: string | null,
): string | null {
  if (selectedCardId !== null && cardIds.includes(selectedCardId)) {
    return selectedCardId;
  }
  return cardIds[0] ?? null;
}

export function createLayoutStore(path: string): JsonStore<MumblerLayout> {
  return new JsonStore<MumblerLayout>({
    path,
    formatVersion: FORMAT_VERSIONS.layout,
    validate: (raw) => normalizeLayout(raw),
    createDefault: () => createDefaultLayout(),
    serialize: serializeLayout,
    // Volatile state (pane widths, selected card) only: not recorded in backups.sqlite3.
    record: false,
  });
}
