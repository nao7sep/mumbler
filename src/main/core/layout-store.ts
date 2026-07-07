import type { MumblerLayout } from "@shared/app-shell";
import { QUEUE_WIDTH } from "@shared/layout";

import { JsonStore } from "./json-store";

// Bumped only on a breaking change to layout.json's shape. A file whose version
// is newer than this build refuses to load (JsonStore). Unlike settings/state,
// the runtime treats that refusal leniently — pane geometry is disposable, so a
// corrupt or too-new layout file self-heals to defaults rather than halting
// launch (see ApplicationRuntime.initialize).
export const LAYOUT_SCHEMA_VERSION = 1;

// Snap a persisted/candidate width to the queue-pane bounds. A non-finite or
// out-of-range value is pulled to the nearest valid width rather than rejected,
// so a hand-edited or drifted layout.json self-heals instead of blocking.
export function clampQueueWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return QUEUE_WIDTH.default;
  }
  return Math.max(QUEUE_WIDTH.min, Math.min(QUEUE_WIDTH.max, Math.round(value)));
}

export function createDefaultLayout(): MumblerLayout {
  return { schemaVersion: LAYOUT_SCHEMA_VERSION, queueWidth: QUEUE_WIDTH.default };
}

export function normalizeLayout(raw: Record<string, unknown>): MumblerLayout {
  return {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    queueWidth: clampQueueWidth(raw.queueWidth),
  };
}

export function createLayoutStore(path: string): JsonStore<MumblerLayout> {
  return new JsonStore<MumblerLayout>({
    path,
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    validate: (raw) => normalizeLayout(raw),
    createDefault: () => createDefaultLayout(),
  });
}
