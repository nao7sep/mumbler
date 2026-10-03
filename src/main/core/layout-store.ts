import type { MumblerLayout } from "@shared/app-shell";
import { QUEUE_WIDTH, RECORDS_LIST_WIDTH } from "@shared/layout";

import { JsonStore } from "./json-store";

// Bumped only on a breaking change to layout.json's shape. Unlike settings/work
// data, this presentation state is disposable, so the runtime self-heals a
// corrupt or too-new file rather than halting launch.
export const LAYOUT_SCHEMA_VERSION = 2;

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
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    queueWidth: QUEUE_WIDTH.default,
    recordsListWidth: RECORDS_LIST_WIDTH.default,
    selectedCardId: null,
  };
}

export function normalizeLayout(raw: Record<string, unknown>): MumblerLayout {
  return {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    queueWidth: clampQueueWidth(raw.queueWidth),
    recordsListWidth: clampRecordsListWidth(raw.recordsListWidth),
    selectedCardId: typeof raw.selectedCardId === "string" ? raw.selectedCardId : null,
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
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    validate: (raw) => normalizeLayout(raw),
    createDefault: () => createDefaultLayout(),
    // Volatile state (pane widths, selected card) only: not recorded in backups.sqlite3.
    record: false,
  });
}
