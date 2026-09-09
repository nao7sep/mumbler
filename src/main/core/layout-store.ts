import type { MumblerLayout, WindowBounds } from "@shared/app-shell";
import { QUEUE_WIDTH } from "@shared/layout";
import { normalizeWindowsNormalBounds } from "@shared/windows-placement";

import { JsonStore } from "./json-store";

// Bumped only on a breaking change to layout.json's shape. Unlike settings/work
// data, this presentation state is disposable, so the runtime self-heals a
// corrupt or too-new file rather than halting launch.
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
  return {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    queueWidth: QUEUE_WIDTH.default,
    selectedCardId: null,
    windowPlacements: { main: null },
  };
}

export function normalizeLayout(raw: Record<string, unknown>): MumblerLayout {
  return {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    queueWidth: clampQueueWidth(raw.queueWidth),
    selectedCardId: typeof raw.selectedCardId === "string" ? raw.selectedCardId : null,
    windowPlacements: normalizeWindowPlacements(raw.windowPlacements),
  };
}

function normalizeWindowPlacements(raw: unknown): MumblerLayout["windowPlacements"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { main: null };
  const source = raw as Record<string, unknown>;
  if (source.main === null || source.main === undefined) return { main: null };
  if (!source.main || typeof source.main !== "object" || Array.isArray(source.main)) return { main: null };
  const placement = source.main as Record<string, unknown>;
  return {
    main: {
      normalBounds: normalizeWindowBounds(placement.normalBounds),
      ...(placement.windowsNormalBounds === undefined ? {} : {
        windowsNormalBounds: normalizeWindowsNormalBounds(placement.windowsNormalBounds),
      }),
      mode: placement.mode === "normal" || placement.mode === "maximized" ? placement.mode : "maximized",
    },
  };
}

function normalizeWindowBounds(raw: unknown): WindowBounds | null {
  if (raw === null || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const values = [source.x, source.y, source.width, source.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  return {
    x: source.x as number,
    y: source.y as number,
    width: source.width as number,
    height: source.height as number,
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
  });
}
