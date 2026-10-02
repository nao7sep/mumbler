// What the records window reads from records.sqlite3: a filtered page of
// summaries, newest first, and one record whole. JSON fields arrive as the text
// the database holds; the window decides how to show them.

export type RecordKind = "log" | "provider-call";

export type RecordLevel = "debug" | "info" | "warn" | "error";

export const RECORD_KINDS: readonly RecordKind[] = ["log", "provider-call"];

export const RECORD_LEVELS: readonly RecordLevel[] = ["error", "warn", "info", "debug"];

// Where the next page starts: the last summary of the page before it.
export interface RecordCursor {
  time: string;
  kind: RecordKind;
  id: number;
}

export interface RecordsQuery {
  // A launch, named by its session.
  session: string | null;
  kind: RecordKind | null;
  // A provider call reads as `error` when it failed and `info` otherwise.
  level: RecordLevel | null;
  cardId: string | null;
  search: string;
  after: RecordCursor | null;
}

export interface RecordSummary {
  kind: RecordKind;
  id: number;
  session: string;
  time: string;
  level: RecordLevel;
  // A log line's operation, or a provider call's provider and operation.
  title: string;
  // A log line's message, or a provider call's model.
  text: string | null;
  cardId: string | null;
}

export interface RecordsPage {
  records: RecordSummary[];
  more: boolean;
}

export interface LogRecordDetail {
  kind: "log";
  id: number;
  session: string;
  time: string;
  level: RecordLevel;
  op: string;
  message: string;
  cardId: string | null;
  details: string | null;
  error: string | null;
}

export interface ProviderCallRecordDetail {
  kind: "provider-call";
  id: number;
  session: string;
  startedAt: string;
  finishedAt: string;
  cardId: string | null;
  step: string | null;
  attempt: number | null;
  provider: string;
  operation: string;
  endpoint: string | null;
  model: string | null;
  request: string;
  response: string | null;
  error: string | null;
}

export type RecordDetail = LogRecordDetail | ProviderCallRecordDetail;

// The values the filters offer: every launch and every card that has records.
export interface RecordSources {
  currentSession: string;
  sessions: string[];
  // A card still in the queue carries its file name.
  cards: { cardId: string; name: string | null }[];
}
