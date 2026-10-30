import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { customAlphabet } from "nanoid";

import { CARD_STATUSES, type MumblerCard, type MumblerQueue, type PendingImportReviewItem, type RecordingTimeCandidate } from "@shared/app-shell";
import { formatUtcIsoCompact, formatUtcMarkerMs, parseUtcMs } from "@shared/timestamps";

import { fileExists, isMissingFileError, readJsonFile, writeJsonFile } from "./file-io";
import { FORMAT_VERSIONS } from "./format-versions";
import { assertReadableFormat, assertResettableJson, CorruptStateError, loadFailure, UnreadableStoreError } from "./json-store";
import { type AppLogger } from "./logger";

// The queue's storage, one folder per card (data-lifecycle-conventions, Storage
// boundaries): each card has its own lifecycle, so each is its own file.
//
//   queue.json              the order of the cards, by id
//   cards/<id>/card.json    the whole card, its text included
//   cards/<id>/<recording>  its working audio, under the source's file name
//   cards/<id>/temp/        its trim and retag scratch
//   inbox.json              the pending imports
//   inbox/<id>/<recording>  each one's working copy
//
// A change writes only the files it changed. The two lists are the authority:
// a folder is created before its list names it and deleted after its list no
// longer does, so startup removes any folder neither list names. Accepting an
// import renames its folder from inbox/ into cards/ under the same id.
//
// Not recorded in the backup history: the queue, its review drafts and its
// text are transient work that ends in exports (data-backup-conventions;
// developer decision).

// Ids name folders, so they use one case only: two ids differing only in case
// would name one folder on a case-insensitive filesystem.
export const newItemId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 21);

const ITEM_ID = /^[0-9a-z_-]+$/;

const CARD_FILE = "card.json";
const SCRATCH_FOLDER = "temp";
// What an atomic write of card.json stages beside it (writeJsonFile).
const STAGED_CARD_FILE = /^card-[0-9A-Za-z_-]{8}\.tmp$/;

export function cardFolder(cardsDir: string, cardId: string): string {
  return join(cardsDir, cardId);
}

/** A card's scratch folder, removed with the card. */
export function cardScratchFolder(cardsDir: string, cardId: string): string {
  return join(cardsDir, cardId, SCRATCH_FOLDER);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// A time an item's file holds unreadable is taken from another time the same
// item recorded, and only an item that recorded none takes its audio file's
// modified time, never the moment of loading (content-lifecycle-conventions,
// "A missing time is not made up"). Each list is in the order a missing time is
// taken from: the item's own change times first.
function pendingImportRecordedTimes(item: PendingImportReviewItem): (number | null)[] {
  return [item.updatedAtUtc, item.createdAtUtc].map(parseUtcMs);
}

function cardRecordedTimes(card: MumblerCard): (number | null)[] {
  return [
    card.updatedAtUtc,
    card.createdAtUtc,
    card.queuedAtUtc,
    card.trimDecision?.analyzedAtUtc,
    card.ai.transcription?.generatedAtUtc,
    card.ai.structured?.generatedAtUtc,
    card.ai.title?.generatedAtUtc,
    card.ai.slug?.generatedAtUtc,
    card.lastError?.occurredAtUtc,
    card.timestamps.effectiveUtc,
    card.timestamps.confirmedUtc,
  ].map(parseUtcMs);
}

function firstRecorded(times: (number | null)[]): number | null {
  return times.find((time) => time !== null) ?? null;
}

// The fields of a card or pending import the app reads or acts on, checked
// before anything is normalized (store-recovery-conventions); an absent time is
// taken from the item's other times.
function textIssue(owner: string, record: Record<string, unknown>, keys: readonly string[]): string | null {
  const key = keys.find((name) => typeof record[name] !== "string");
  return key === undefined ? null : `${owner} ${key} is not text`;
}

function objectOrNullIssue(owner: string, record: Record<string, unknown>, keys: readonly string[]): string | null {
  const key = keys.find((name) => record[name] !== null && asRecord(record[name]) === null);
  return key === undefined ? null : `${owner} ${key} is not an object or null`;
}

function optionalNumbersIssue(owner: string, record: Record<string, unknown>, keys: readonly string[], minimum = -Infinity): string | null {
  const key = keys.find((name) => record[name] != null &&
    (typeof record[name] !== "number" || !Number.isFinite(record[name]) || record[name] < minimum));
  return key === undefined ? null : `${owner} ${key} is not a valid number or null`;
}

function cardDetailsIssue(card: Record<string, unknown>): string | null {
  const error = asRecord(card.lastError);
  if (error !== null) {
    if (typeof error.message !== "string") return "a card's error message is not text";
    if (error.providerReason !== undefined && typeof error.providerReason !== "string") return "a card's provider reason is not text";
    if (error.refused !== undefined && error.refused !== true) return "a card's refusal flag is invalid";
    if (!["transcription", "structured", "title", "slug", "startup-recovery"].includes(error.failedStep as string)) return "a card's failed step is unknown";
  }
  if (card.audioProfile != null) {
    const profile = asRecord(card.audioProfile);
    if (profile === null) return "a card's audio profile is not an object or null";
    for (const key of ["formatName", "codecName"]) {
      if (profile[key] != null && typeof profile[key] !== "string") return `a card's audio ${key} is not text or null`;
    }
    const issue = optionalNumbersIssue("a card's audio", profile, ["bitRateKbps", "sampleRateHz", "channels"], 0);
    if (issue !== null) return issue;
  }
  const trim = asRecord(card.trimDecision);
  if (trim !== null) {
    if (!["not-needed", "stream-copy", "reencode"].includes(trim.kind as string)) return "a card's trim decision is unknown";
    if (trim.reason !== undefined && typeof trim.reason !== "string") return "a card's trim reason is not text";
    const issue = optionalNumbersIssue("a card's trim decision", trim, ["toleranceSec", "requestedStartSec", "requestedEndSec", "searchStartFromSec", "searchStartToSec", "searchEndFromSec", "searchEndToSec", "chosenStartBoundarySec", "chosenEndBoundarySec"], 0) ??
      optionalNumbersIssue("a card's trim decision", trim, ["startDeltaSec", "endDeltaSec"]);
    if (issue !== null) return issue;
  }
  for (const role of ["transcription", "structured", "title", "slug"]) {
    const info = asRecord((card.ai as Record<string, unknown>)[role]);
    if (info === null) continue;
    if (info.model !== undefined && typeof info.model !== "string") return "a card's AI model is not text";
    if (info.provider !== undefined && info.provider !== "gemini") return "a card's AI provider is unknown";
  }
  return optionalNumbersIssue("a card's timestamps", card.timestamps as Record<string, unknown>, ["frontTrimOffsetSec"], 0);
}

function pendingImportIssue(item: unknown): string | null {
  const record = asRecord(item);
  if (record === null) return "a pending import is not an object";
  if (record.timestampBasis !== undefined && record.timestampBasis !== "local" && record.timestampBasis !== "utc") return "a pending import's timestamp basis is unknown";
  if (record.sourceIdentity !== undefined) {
    const identity = asRecord(record.sourceIdentity);
    if (identity === null || ["dev", "ino", "size", "mtimeMs", "ctimeMs"].some((key) => typeof identity[key] !== "number" || !Number.isFinite(identity[key]))) {
      return "a pending import's source identity is invalid";
    }
  }
  const flag = ["deleteOriginalOnConfirm", "copyToBackupOnConfirm"].find((key) => typeof record[key] !== "boolean");
  return textIssue("a pending import entry's", record, [
    "id",
    "originalFilename",
    "originalSourcePath",
    "workingFilePath",
    "localTimestampText",
    "timezone",
    "utcTimestampText",
  ]) ?? (flag === undefined ? null : `a pending import entry's ${flag} is not true or false`);
}

function cardIssue(item: unknown): string | null {
  const card = asRecord(item);
  if (card === null) return "a card is not an object";
  const issue = textIssue("a card's", card, ["id", "originalFilename", "sourceFilePath", "status"]) ??
    objectOrNullIssue("a card's", card, ["trimDecision", "transcribedTrim", "lastError"]);
  if (issue !== null) return issue;
  if (!CARD_STATUSES.includes(card.status as MumblerCard["status"])) return "a card's status is unknown";
  const part = ["timestamps", "trim", "transcription", "metadata", "ai"].find((key) => asRecord(card[key]) === null);
  if (part !== undefined) return `a card's ${part} is not an object`;
  for (const [name, trim] of [["trim", card.trim], ["transcribedTrim", card.transcribedTrim]] as const) {
    if (trim === null) continue;
    for (const key of ["frontMarkerSec", "backMarkerSec"]) {
      const value = (trim as Record<string, unknown>)[key];
      if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        return `a card's ${name} ${key} is not a non-negative finite number or null`;
      }
    }
  }
  const transcript = (card.transcription as Record<string, unknown>).text;
  if (transcript !== null && typeof transcript !== "string") return "a card's transcription is not text or null";
  const metadata = card.metadata as Record<string, unknown>;
  const label = ["structured", "title", "slug"].find((key) => metadata[key] !== null && typeof metadata[key] !== "string");
  return textIssue("a card's timestamps", card.timestamps as Record<string, unknown>, ["confirmedLocal", "effectiveLocal", "timezone"]) ??
    objectOrNullIssue("a card's ai", card.ai as Record<string, unknown>, ["transcription", "structured", "title", "slug"]) ??
    cardDetailsIssue(card) ??
    (label === undefined ? null : `a card's metadata ${label} is not text or null`);
}

/** The time the loader read for an undated item from its audio file, or failing that its own file. */
type UndatedItemTime = (audioFilePath: string) => number;

function normalizePendingImportRecord(
  item: PendingImportReviewItem,
  undatedTime: UndatedItemTime,
): PendingImportReviewItem {
  const fallback = firstRecorded(pendingImportRecordedTimes(item)) ?? undatedTime(item.workingFilePath);

  return {
    ...item,
    // A review staged before times were collected offers none.
    timeCandidates: Array.isArray(item.timeCandidates) ? item.timeCandidates.filter(isTimeCandidate) : [],
    createdAtUtc: parseUtcMs(item.createdAtUtc) ?? fallback,
    updatedAtUtc: parseUtcMs(item.updatedAtUtc) ?? fallback,
  };
}

const TIME_SOURCES: readonly RecordingTimeCandidate["source"][] = ["file-name", "embedded", "file-created", "file-modified"];

function isTimeCandidate(value: unknown): value is RecordingTimeCandidate {
  const record = asRecord(value);
  return record !== null && TIME_SOURCES.includes(record.source as RecordingTimeCandidate["source"])
    && ((typeof record.utcMs === "number" && Number.isFinite(record.utcMs) && record.localText === null)
      || (record.utcMs === null && typeof record.localText === "string"));
}

function normalizeTrimDecisionRecord(
  cardTrimDecision: MumblerCard["trimDecision"],
  fallback: number,
): MumblerCard["trimDecision"] {
  if (cardTrimDecision === null) {
    return null;
  }

  return {
    ...cardTrimDecision,
    analyzedAtUtc: parseUtcMs(cardTrimDecision.analyzedAtUtc) ?? fallback,
  };
}

function normalizeAiRunInfo(
  run: MumblerCard["ai"]["transcription"],
  fallback: number,
): MumblerCard["ai"]["transcription"] {
  if (run === null) {
    return null;
  }

  return {
    ...run,
    generatedAtUtc: parseUtcMs(run.generatedAtUtc) ?? fallback,
  };
}

function normalizeCardError(error: MumblerCard["lastError"], fallback: number): MumblerCard["lastError"] {
  if (error === null) {
    return null;
  }

  return {
    ...error,
    occurredAtUtc: parseUtcMs(error.occurredAtUtc) ?? fallback,
  };
}

function normalizeCardRecord(card: MumblerCard, undatedTime: UndatedItemTime): MumblerCard {
  const fallback = firstRecorded(cardRecordedTimes(card)) ?? undatedTime(card.sourceFilePath);
  // The confirmed and effective instants are one recording time apart by the
  // front trim, which applyFrontTrimOffset applies exactly, so either one
  // restores the other before the card's other times are used.
  const frontTrimOffsetSec = card.timestamps.frontTrimOffsetSec;
  const frontTrimOffsetMs = Number.isFinite(frontTrimOffsetSec) ? Math.round(frontTrimOffsetSec * 1000) : 0;
  const storedConfirmedUtc = parseUtcMs(card.timestamps.confirmedUtc);
  const storedEffectiveUtc = parseUtcMs(card.timestamps.effectiveUtc);
  const confirmedUtc =
    storedConfirmedUtc ?? (storedEffectiveUtc !== null ? storedEffectiveUtc - frontTrimOffsetMs : fallback);
  const queuedMode = card.queuedMode === "generate" ? card.queuedMode : null;
  // queuedAtUtc is paired with queuedMode and read like every other instant.
  const queuedAtUtc = queuedMode !== null ? (parseUtcMs(card.queuedAtUtc) ?? fallback) : null;

  return {
    ...card,
    timestamps: {
      ...card.timestamps,
      confirmedUtc,
      effectiveUtc: storedEffectiveUtc ?? confirmedUtc + frontTrimOffsetMs,
    },
    trimDecision: normalizeTrimDecisionRecord(card.trimDecision, fallback),
    ai: {
      transcription: normalizeAiRunInfo(card.ai.transcription, fallback),
      structured: normalizeAiRunInfo(card.ai.structured, fallback),
      title: normalizeAiRunInfo(card.ai.title, fallback),
      slug: normalizeAiRunInfo(card.ai.slug, fallback),
    },
    queuedMode,
    queuedAtUtc,
    lastError: normalizeCardError(card.lastError, fallback),
    createdAtUtc: parseUtcMs(card.createdAtUtc) ?? fallback,
    updatedAtUtc: parseUtcMs(card.updatedAtUtc) ?? fallback,
  };
}

// Render in-memory state to its on-disk shape: every UTC instant (stored as an
// epoch-ms number and named with the convention's `*Utc` suffix) becomes the
// canonical ISO-8601 string, while everything else passes through unchanged.
// The model keeps epoch-ms for arithmetic/sorting; this converts only at the
// persistence edge; the read path (parseUtcMs) turns the ISO back into epoch-ms.
function serializeUtcInstants(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(serializeUtcInstants);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, fieldValue]) => [
        key,
        /Utc$/.test(key) && typeof fieldValue === "number" && Number.isFinite(fieldValue)
          ? formatUtcIsoCompact(fieldValue)
          : serializeUtcInstants(fieldValue),
      ]),
    );
  }
  return value;
}

// A card a previous session left mid-step. An interrupted save may have
// published some outputs, so that card is kept ready for the user to inspect
// them and retry; an interrupted run is an error to generate again.
export function recoverInterruptedCard(card: MumblerCard): { card: MumblerCard; recovered: "save" | "run" | null } {
  if (card.status === "Saving") return { card: { ...card, status: "Ready to Save" }, recovered: "save" };
  if (card.status !== "Transcribing" && card.status !== "Generating Metadata") return { card, recovered: null };
  return {
    card: {
      ...card,
      status: "Error",
      activeStep: null,
      lastError: {
        message: "Interrupted — generate again to resume",
        occurredAtUtc: Date.now(),
        failedStep: "startup-recovery",
      },
    },
    recovered: "run",
  };
}

function markCardWorkingFileMissing(card: MumblerCard): MumblerCard {
  return {
    ...card,
    status: "Error",
    activeStep: null,
    queuedMode: null,
    queuedAtUtc: null,
    lastError: {
      message: "Working audio is missing from working storage — remove this card or re-import the source audio.",
      occurredAtUtc: Date.now(),
      failedStep: "startup-recovery",
    },
  };
}

function serializeCard(card: MumblerCard): Record<string, unknown> {
  return { formatVersion: FORMAT_VERSIONS.card, ...(serializeUtcInstants(card) as Record<string, unknown>) };
}

function idListIssue(list: unknown, key: string): string | null {
  if (!Array.isArray(list)) return `${key} is not a list`;
  const ids = new Set<string>();
  for (const id of list) {
    if (typeof id !== "string" || !ITEM_ID.test(id) || ids.has(id)) return `${key} contains an invalid or duplicate id`;
    ids.add(id);
  }
  return null;
}

async function readDocument(path: string, supported: number): Promise<Record<string, unknown> | undefined> {
  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(path);
  } catch (error: unknown) {
    throw loadFailure(path, error);
  }
  if (raw === undefined) return undefined;
  const record = asRecord(raw);
  if (record === null) throw new CorruptStateError(path, "file does not contain a JSON object");
  assertReadableFormat(path, record, supported);
  return record;
}

async function folderEntries(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error: unknown) {
    if (isMissingFileError(error)) return [];
    throw new UnreadableStoreError(directory, { cause: error });
  }
}

async function modifiedTime(file: string): Promise<number> {
  return Math.floor((await stat(file)).mtimeMs);
}

export interface QueueLoad {
  state: MumblerQueue;
  recoveredInterruptedCards: number;
  restoredSavingCards: number;
  droppedPendingImports: number;
  missingWorkingCards: number;
  droppedCards: number;
  /** Imports an interrupted acceptance had moved into cards/, moved back for review. */
  returnedImports: number;
  removedFolders: number;
  /** Scratch and staged-write leftovers cleared from listed cards' folders. */
  clearedLeftovers: number;
}

type FileKey = "order" | "inbox" | `card:${string}`;

export class QueueStore {
  readonly orderPath: string;
  readonly inboxPath: string;
  readonly cardsDir: string;
  readonly inboxDir: string;
  // The files whose latest write failed. Quit writes them again from what the
  // app then holds; a later write that lands clears one.
  private readonly failed = new Set<FileKey>();

  constructor(paths: { queuePath: string; inboxPath: string; cardsDir: string; inboxDir: string }) {
    this.orderPath = paths.queuePath;
    this.inboxPath = paths.inboxPath;
    this.cardsDir = paths.cardsDir;
    this.inboxDir = paths.inboxDir;
  }

  cardFolder(cardId: string): string {
    return cardFolder(this.cardsDir, cardId);
  }

  importFolder(importId: string): string {
    return join(this.inboxDir, importId);
  }

  /**
   * Reads the two lists and each listed card, and settles what a previous
   * session left: an interrupted card is recovered, a listed card with no file
   * and a pending import with no working copy are dropped, a card whose audio
   * is missing is marked so, and every folder neither list names is removed.
   * Only what changed is written. A damaged file, one that cannot be read and
   * one in a newer format each stop the load and are left in place.
   */
  async load(logger: AppLogger): Promise<QueueLoad> {
    const order = await readDocument(this.orderPath, FORMAT_VERSIONS.queue);
    const cardIds = (order?.cardIds ?? []) as string[];
    if (order !== undefined) {
      const issue = idListIssue(order.cardIds, "cardIds");
      if (issue !== null) throw new CorruptStateError(this.orderPath, issue);
    }
    const inbox = await readDocument(this.inboxPath, FORMAT_VERSIONS.inbox);
    const rawImports = (inbox?.pendingImports ?? []) as unknown[];
    if (inbox !== undefined) {
      if (!Array.isArray(inbox.pendingImports)) throw new CorruptStateError(this.inboxPath, "pendingImports is not a list");
      const ids = new Set<string>();
      for (const item of rawImports) {
        const issue = pendingImportIssue(item);
        if (issue !== null) throw new CorruptStateError(this.inboxPath, issue);
        const id = (item as PendingImportReviewItem).id;
        if (!ITEM_ID.test(id) || ids.has(id)) throw new CorruptStateError(this.inboxPath, "pendingImports contains an invalid or duplicate id");
        ids.add(id);
      }
    }

    const result: QueueLoad = {
      state: { cards: [], pendingImports: [] },
      recoveredInterruptedCards: 0,
      restoredSavingCards: 0,
      droppedPendingImports: 0,
      missingWorkingCards: 0,
      droppedCards: 0,
      returnedImports: 0,
      removedFolders: 0,
      clearedLeftovers: 0,
    };
    const listedCards = new Set(cardIds);
    let acceptedImports = 0;
    const changedCards: MumblerCard[] = [];

    for (const raw of rawImports as PendingImportReviewItem[]) {
      // The folder is the authority for where the copy is.
      const workingFilePath = join(this.importFolder(raw.id), basename(raw.workingFilePath));
      if (!(await this.present(workingFilePath)) && listedCards.has(raw.id)) {
        // Its acceptance committed in the order before the inbox was saved.
        acceptedImports += 1;
        continue;
      }
      if (!(await this.present(workingFilePath)) &&
          await this.present(join(this.cardFolder(raw.id), basename(raw.workingFilePath)))) {
        // An acceptance moved the folder into cards/ but never listed the
        // card: the import is still the user's to review.
        await this.returnToInbox(raw.id);
        result.returnedImports += 1;
        await logger.warn("startup.import-returned", "Moved an import an interrupted confirmation had accepted back for review.", {
          pendingImportId: raw.id, originalFilename: raw.originalFilename,
        });
      }
      if (!(await this.present(workingFilePath))) {
        result.droppedPendingImports += 1;
        await logger.warn("startup.pending-missing", "Dropped pending import because its working file is missing.", {
          pendingImportId: raw.id, originalFilename: raw.originalFilename, workingFilePath,
        });
        continue;
      }
      const undated = firstRecorded(pendingImportRecordedTimes(raw)) === null
        ? await modifiedTime(workingFilePath).catch(() => modifiedTime(this.inboxPath))
        : 0;
      result.state.pendingImports.push(normalizePendingImportRecord({ ...raw, workingFilePath }, () => undated));
    }

    for (const cardId of cardIds) {
      const path = join(this.cardFolder(cardId), CARD_FILE);
      const raw = await readDocument(path, FORMAT_VERSIONS.card);
      if (raw === undefined) {
        result.droppedCards += 1;
        await logger.warn("startup.card-file-missing", "Dropped a listed card because its file is missing.", { cardId, path });
        continue;
      }
      const issue = cardIssue(raw);
      if (issue !== null) throw new CorruptStateError(path, issue);
      if (raw.id !== cardId) throw new CorruptStateError(path, "id does not match the card's folder");
      const { formatVersion: _format, ...stored } = raw as unknown as MumblerCard & { formatVersion: number };
      const sourceFilePath = join(this.cardFolder(cardId), basename(stored.sourceFilePath));
      const undated = firstRecorded(cardRecordedTimes(stored)) === null
        ? await modifiedTime(sourceFilePath).catch(() => modifiedTime(path))
        : 0;
      const loaded = normalizeCardRecord({ ...stored, sourceFilePath }, () => undated);
      let { card, recovered } = recoverInterruptedCard(loaded);
      if (recovered === "run") result.recoveredInterruptedCards += 1;
      if (recovered === "save") result.restoredSavingCards += 1;
      if (!(await this.present(sourceFilePath))) {
        result.missingWorkingCards += 1;
        card = markCardWorkingFileMissing(card);
        recovered = "run";
        await logger.warn("startup.card-missing", "Marked card as errored because its working file is missing.", {
          cardId, originalFilename: card.originalFilename, sourceFilePath,
        });
      }
      if (recovered !== null) changedCards.push(card);
      result.state.cards.push(card);
    }

    for (const card of changedCards) await this.writeCard(card);
    if (result.droppedCards > 0) await this.writeOrder(result.state.cards);
    if (result.droppedPendingImports > 0 || acceptedImports > 0) await this.writeInbox(result.state.pendingImports);

    // A listed card's scratch and a staged card.json a crash left behind are
    // temporary by location; the card's own file and audio are not touched.
    for (const card of result.state.cards) {
      const folder = this.cardFolder(card.id);
      for (const name of await folderEntries(folder)) {
        if (name !== SCRATCH_FOLDER && !STAGED_CARD_FILE.test(name)) continue;
        const path = join(folder, name);
        try {
          await rm(path, { recursive: true, force: true });
          result.clearedLeftovers += 1;
        } catch (error: unknown) {
          await logger.warn("startup.card-cleanup", "Could not clear a leftover in a card's folder.", {
            path, error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // Removal is cleanup: a folder that cannot be removed now is tried again
    // next launch.
    const listed = [
      { directory: this.cardsDir, ids: new Set(result.state.cards.map((card) => card.id)) },
      { directory: this.inboxDir, ids: new Set(result.state.pendingImports.map((item) => item.id)) },
    ];
    for (const { directory, ids } of listed) {
      for (const name of await folderEntries(directory)) {
        if (ids.has(name)) continue;
        const path = join(directory, name);
        try {
          await rm(path, { recursive: true, force: true });
          result.removedFolders += 1;
        } catch (error: unknown) {
          await logger.warn("startup.folder-cleanup", "Could not remove a folder neither list names.", {
            path, error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return result;
  }

  // A presence check that failed says nothing about whether the audio is
  // there, so it stops the load naming the path rather than marking the item.
  private async present(path: string): Promise<boolean> {
    try {
      return await fileExists(path);
    } catch (error: unknown) {
      throw new UnreadableStoreError(path, { cause: error });
    }
  }

  writeCard(card: MumblerCard): Promise<void> {
    return this.write(`card:${card.id}`, join(this.cardFolder(card.id), CARD_FILE), serializeCard(card));
  }

  writeOrder(cards: readonly MumblerCard[]): Promise<void> {
    return this.write("order", this.orderPath, { formatVersion: FORMAT_VERSIONS.queue, cardIds: cards.map((card) => card.id) });
  }

  writeInbox(pendingImports: readonly PendingImportReviewItem[]): Promise<void> {
    return this.write("inbox", this.inboxPath, {
      formatVersion: FORMAT_VERSIONS.inbox,
      pendingImports: serializeUtcInstants(pendingImports),
    });
  }

  /** Writes again, from `state`, every file whose latest write failed. */
  async retryFailedWrites(state: MumblerQueue): Promise<void> {
    let firstError: unknown = null;
    for (const key of [...this.failed]) {
      try {
        if (key === "order") await this.writeOrder(state.cards);
        else if (key === "inbox") await this.writeInbox(state.pendingImports);
        else {
          const card = state.cards.find((entry) => `card:${entry.id}` === key);
          if (card === undefined) this.failed.delete(key);
          else await this.writeCard(card);
        }
      } catch (error: unknown) {
        firstError ??= error;
      }
    }
    if (firstError !== null) throw firstError;
  }

  // A pending import's folder is inbox/<id>, or cards/<id> while an
  // acceptance that could not be saved or undone left it there; no listed card
  // shares a pending import's id, so both places are the import's own.

  /** Moves an import's folder into cards/ under the same id, and returns where its audio is now. */
  async acceptImport(item: PendingImportReviewItem): Promise<string> {
    const audio = join(this.cardFolder(item.id), basename(item.workingFilePath));
    await mkdir(this.cardsDir, { recursive: true });
    try {
      await rename(this.importFolder(item.id), this.cardFolder(item.id));
    } catch (error: unknown) {
      // An earlier acceptance that could not be undone left it there already.
      if (!isMissingFileError(error) || !(await fileExists(audio))) throw error;
    }
    return audio;
  }

  /** Moves an accepted card's folder back into inbox/, for an acceptance that could not be saved. */
  async returnImport(item: PendingImportReviewItem): Promise<void> {
    this.failed.delete(`card:${item.id}`);
    await this.returnToInbox(item.id);
  }

  private async returnToInbox(id: string): Promise<void> {
    const folder = this.cardFolder(id);
    for (const name of await folderEntries(folder)) {
      if (name === CARD_FILE || name === SCRATCH_FOLDER || STAGED_CARD_FILE.test(name)) {
        await rm(join(folder, name), { recursive: true, force: true });
      }
    }
    await mkdir(this.inboxDir, { recursive: true });
    await rename(this.cardFolder(id), this.importFolder(id));
  }

  /** Deletes a card's folder: its file, audio and scratch. Call after the order no longer lists it. */
  async removeCardFolder(cardId: string): Promise<void> {
    this.failed.delete(`card:${cardId}`);
    await rm(this.cardFolder(cardId), { recursive: true, force: true });
  }

  /** Deletes a pending import's folder, wherever it is. Call after the inbox no longer lists it. */
  async removeImportFolder(importId: string): Promise<void> {
    await rm(this.importFolder(importId), { recursive: true, force: true });
    await rm(this.cardFolder(importId), { recursive: true, force: true });
  }

  /** Explicit reset may set damaged files aside, but never a readable newer one. */
  async admitReset(): Promise<void> {
    await assertResettableJson(this.orderPath, FORMAT_VERSIONS.queue);
    await assertResettableJson(this.inboxPath, FORMAT_VERSIONS.inbox);
    for (const name of await folderEntries(this.cardsDir)) {
      await assertResettableJson(join(this.cardsDir, name, CARD_FILE), FORMAT_VERSIONS.card);
    }
  }

  /** Sets the lists and both folders aside together for Reset, in one
   * "queue-<time>.invalid" folder beside them, naming each path to `onMoved`
   * as it moves, so a move that fails part-way still reports the earlier ones. */
  async preserveExistingFiles(onMoved: (path: string) => void = () => undefined): Promise<string[]> {
    await this.admitReset();
    const present: string[] = [];
    for (const path of [this.orderPath, this.inboxPath, this.cardsDir, this.inboxDir]) {
      if (await fileExists(path)) present.push(path);
    }
    if (present.length > 0) {
      const aside = join(dirname(this.orderPath), `queue-${formatUtcMarkerMs(new Date())}.invalid`);
      await mkdir(aside);
      for (const path of present) {
        await rename(path, join(aside, basename(path)));
        onMoved(path);
      }
    }
    this.failed.clear();
    return present;
  }

  private async write(key: FileKey, path: string, document: Record<string, unknown>): Promise<void> {
    try {
      await writeJsonFile(path, document);
    } catch (error: unknown) {
      this.failed.add(key);
      throw error;
    }
    this.failed.delete(key);
  }
}

export function createEmptyQueue(): MumblerQueue {
  return {
    pendingImports: [],
    cards: [],
  };
}
