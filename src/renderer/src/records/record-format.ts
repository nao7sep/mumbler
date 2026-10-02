import type { MessageKey } from "@shared/i18n/catalogues";
import type { RecordCursor, RecordKind, RecordLevel, RecordSummary } from "@shared/records";

export function recordKey(record: { kind: RecordKind; id: number }): string {
  return `${record.kind}:${record.id}`;
}

// Stored JSON, indented for reading; text that is not JSON is shown as it is.
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function durationSeconds(startedAt: string, finishedAt: string): number {
  return (Date.parse(finishedAt) - Date.parse(startedAt)) / 1000;
}

export const KIND_LABELS: Record<RecordKind, MessageKey> = {
  log: "records.kindLog",
  "provider-call": "records.kindProviderCall",
};

export const LEVEL_LABELS: Record<RecordLevel, MessageKey> = {
  error: "records.levelError",
  warn: "records.levelWarn",
  info: "records.levelInfo",
  debug: "records.levelDebug",
};

export const LEVEL_PILLS: Record<RecordLevel, string> = {
  error: "pill pill--danger",
  warn: "pill pill--warning",
  info: "pill pill--quiet",
  debug: "pill pill--quiet",
};

// A stored step is the pipeline's own name for it; the ones the interface
// names are shown in the interface language.
const STEP_LABELS: Readonly<Record<string, MessageKey>> = {
  transcription: "step.transcription",
  structured: "step.structured",
  title: "step.title",
  slug: "step.slug",
};

export function stepLabel(step: string): MessageKey | null {
  return Object.hasOwn(STEP_LABELS, step) ? STEP_LABELS[step]! : null;
}

// The page after the last record shown.
export function cursorAfter(records: readonly RecordSummary[]): RecordCursor | null {
  const last = records.at(-1);
  return last === undefined ? null : { time: last.time, kind: last.kind, id: last.id };
}
