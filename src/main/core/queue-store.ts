import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { customAlphabet } from "nanoid";

import { CARD_STATUSES, type MumblerCard, type MumblerQueue, type PendingImportReviewItem, type RecordingTimeCandidate } from "@shared/app-shell";
import { formatUtcIsoCompact, formatUtcMarkerMs, parseUtcMs } from "@shared/timestamps";

import { fileExists, isMissingFileError, readJsonFile, writeJsonFile } from "./file-io";
import { type FileFormat, fileHeader, FORMATS, NewerFormatError, withoutHeader } from "./format-versions";
import { assertReadableFormat, assertResettableJson, CorruptStateError, loadFailure, UnreadableStoreError } from "./json-store";
import { type AppLogger } from "./logger";


// The queue's storage, one folder per card and per pending import
// (data-lifecycle-conventions, Storage boundaries): each has its own lifecycle,
// so each is its own file, and the items list and sort themselves.
//
//   cards/<id>/card.json      the whole card, its text included
//   cards/<id>/<recording>    its working audio, under the source's file name
//   cards/<id>/temp/          its trim and retag scratch
//   inbox/<id>/import.json    a pending import's review choices
//   inbox/<id>/<recording>    its working copy
//
// The cards are the folders under cards/ that hold a card.json, ordered by each
// card's effective time; the pending imports are the folders under inbox/ that
// hold an import.json, ordered by when they were imported. A change writes only
// the files it changed. Launch never deletes an item's folder: one whose file
// cannot be read is reported with its path, and one with no file is left and
// logged. Removing an item renames its folder to a hidden removed name in one
// step, then deletes it; a removed folder a crash left is deleted at launch.
// Accepting an import writes its card.json into its folder, then renames the
// folder from inbox/ into cards/ under the same id: the rename is the commit.
//
// Not recorded in the backup history: the queue, its review drafts and its
// text are transient work that ends in exports (data-backup-conventions;
// developer decision).

// Ids name folders, so they use one case only: two ids differing only in case
// would name one folder on a case-insensitive filesystem.
export const newItemId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 21);

const CARD_FILE = "card.json";
const IMPORT_FILE = "import.json";
const SCRATCH_FOLDER = "temp";
// What an atomic write of an item's file stages beside it (writeJsonFile).
const STAGED_ITEM_FILE = /^(card|import)-[0-9A-Za-z_-]{8}\.tmp$/;
// A removed item's folder, renamed so in one step before it is deleted.
const REMOVED_PREFIX = ".removed-";

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
    // A review that holds no time candidates offers none.
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
  return { ...fileHeader(FORMATS.card), ...(serializeUtcInstants(card) as Record<string, unknown>) };
}

function serializeImport(item: PendingImportReviewItem): Record<string, unknown> {
  return { ...fileHeader(FORMATS.pendingImport), ...(serializeUtcInstants(item) as Record<string, unknown>) };
}

async function readDocument(path: string, expected: FileFormat): Promise<Record<string, unknown> | undefined> {
  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(path);
  } catch (error: unknown) {
    throw loadFailure(path, error);
  }
  if (raw === undefined) return undefined;
  const record = asRecord(raw);
  if (record === null) throw new CorruptStateError(path, "file does not contain a JSON object");
  assertReadableFormat(path, record, expected);
  return withoutHeader(record);
}

async function folderEntries(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error: unknown) {
    if (isMissingFileError(error)) return [];
    throw new UnreadableStoreError(directory, { cause: error });
  }
}

async function folderNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error: unknown) {
    if (isMissingFileError(error)) return [];
    throw new UnreadableStoreError(directory, { cause: error });
  }
}

async function modifiedTime(file: string): Promise<number> {
  return Math.floor((await stat(file)).mtimeMs);
}

/** The queue's order: by effective time, then by when each card was made. */
export function compareCards(left: MumblerCard, right: MumblerCard): number {
  return left.timestamps.effectiveUtc - right.timestamps.effectiveUtc ||
    left.createdAtUtc - right.createdAtUtc ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function compareImports(left: PendingImportReviewItem, right: PendingImportReviewItem): number {
  return left.createdAtUtc - right.createdAtUtc || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/** A file launch could not read, left as it is. */
export interface UnreadableItemFile {
  path: string;
  reason: string;
}

export interface QueueLoad {
  state: MumblerQueue;
  recoveredInterruptedCards: number;
  restoredSavingCards: number;
  missingWorkingCards: number;
  /** Item files that are damaged or in a newer format, shown with their paths. */
  unreadable: UnreadableItemFile[];
  /** Folders with no item file, or an import with no copy, left in place. */
  unlistedFolders: number;
  /** Removed folders a crash left, deleted. */
  removedFolders: number;
  /** Scratch and staged-write leftovers cleared from the items' folders. */
  clearedLeftovers: number;
}

type FileKey = `card:${string}` | `import:${string}`;

function unreadableReason(error: unknown): string | null {
  if (error instanceof CorruptStateError) return error.reason;
  if (error instanceof NewerFormatError) return error.message;
  return null;
}

export class QueueStore {
  readonly cardsDir: string;
  readonly inboxDir: string;
  // The files whose latest write failed. Quit writes them again from what the
  // app then holds; a later write that lands clears one.
  private readonly failed = new Set<FileKey>();

  constructor(paths: { cardsDir: string; inboxDir: string }) {
    this.cardsDir = paths.cardsDir;
    this.inboxDir = paths.inboxDir;
  }

  cardFolder(cardId: string): string {
    return cardFolder(this.cardsDir, cardId);
  }

  importFolder(importId: string): string {
    return join(this.inboxDir, importId);
  }

  /** Where an import's audio is once it is accepted as a card. */
  acceptedAudioPath(item: PendingImportReviewItem): string {
    return join(this.cardFolder(item.id), basename(item.workingFilePath));
  }

  /**
   * Reads every card and pending import from its folder and settles what a
   * previous session left: removed folders are deleted, an interrupted card is
   * recovered, a card whose audio is missing is marked so, and scratch is
   * cleared. Only what changed is written. An item file that is
   * damaged or in a newer format is left as it is and reported; a folder or
   * file that cannot be read at all stops the load.
   */
  async load(logger: AppLogger): Promise<QueueLoad> {
    const result: QueueLoad = {
      state: { cards: [], pendingImports: [] },
      recoveredInterruptedCards: 0,
      restoredSavingCards: 0,
      missingWorkingCards: 0,
      unreadable: [],
      unlistedFolders: 0,
      removedFolders: 0,
      clearedLeftovers: 0,
    };
    const unreadable = async (path: string, reason: string) => {
      result.unreadable.push({ path, reason });
      await logger.warn("startup.item-unreadable", "Left an item file that could not be read as it is.", { path, reason });
    };
    const unlisted = async (path: string, reason: string) => {
      result.unlistedFolders += 1;
      await logger.warn("startup.folder-unlisted", "Left a folder that holds no readable item in place.", { path, reason });
    };

    for (const directory of [this.cardsDir, this.inboxDir]) {
      for (const name of await folderNames(directory)) {
        if (!name.startsWith(REMOVED_PREFIX)) continue;
        await this.clear(join(directory, name), logger, () => { result.removedFolders += 1; });
      }
    }

    for (const id of await folderNames(this.inboxDir)) {
      if (id.startsWith(".")) continue;
      const folder = this.importFolder(id);
      const path = join(folder, IMPORT_FILE);
      const raw = await this.readItem(path, FORMATS.pendingImport, unreadable);
      if (raw === null) continue;
      if (raw === undefined) {
        await unlisted(folder, "no import.json");
        continue;
      }
      const issue = pendingImportIssue(raw) ?? (raw.id !== id ? "id does not match the import's folder" : null);
      if (issue !== null) {
        await unreadable(path, issue);
        continue;
      }
      const stored = raw as unknown as PendingImportReviewItem;
      // The folder is the authority for where the copy is.
      const workingFilePath = join(folder, basename(stored.workingFilePath));
      if (!(await this.present(workingFilePath))) {
        await unlisted(folder, "its working copy is missing");
        continue;
      }
      // A card.json beside an import was staged by an acceptance that did not
      // rename the folder: the import is still the user's to review.
      await this.clearLeftovers(folder, [CARD_FILE], logger, result);
      const undated = firstRecorded(pendingImportRecordedTimes(stored)) === null
        ? await modifiedTime(workingFilePath).catch(() => modifiedTime(path))
        : 0;
      result.state.pendingImports.push(normalizePendingImportRecord({ ...stored, workingFilePath }, () => undated));
    }

    const changedCards: MumblerCard[] = [];
    for (const id of await folderNames(this.cardsDir)) {
      if (id.startsWith(".")) continue;
      const folder = this.cardFolder(id);
      const path = join(folder, CARD_FILE);
      const raw = await this.readItem(path, FORMATS.card, unreadable);
      if (raw === null) continue;
      if (raw === undefined) {
        await unlisted(folder, "no card.json");
        continue;
      }
      const issue = cardIssue(raw) ?? (raw.id !== id ? "id does not match the card's folder" : null);
      if (issue !== null) {
        await unreadable(path, issue);
        continue;
      }
      const stored = raw as unknown as MumblerCard;
      const sourceFilePath = join(folder, basename(stored.sourceFilePath));
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
          cardId: id, originalFilename: card.originalFilename, sourceFilePath,
        });
      }
      // An import.json beside a card is what its acceptance left after the rename.
      await this.clearLeftovers(folder, [IMPORT_FILE], logger, result);
      if (recovered !== null) changedCards.push(card);
      result.state.cards.push(card);
    }
    for (const card of changedCards) await this.writeCard(card);
    result.state.cards.sort(compareCards);
    result.state.pendingImports.sort(compareImports);
    return result;
  }

  // Reads one item file: undefined when it is absent, null when it is damaged
  // or newer and was reported. A file that cannot be read at all stops the load.
  private async readItem(
    path: string,
    expected: FileFormat,
    unreadable: (path: string, reason: string) => Promise<void>,
  ): Promise<Record<string, unknown> | null | undefined> {
    try {
      return await readDocument(path, expected);
    } catch (error: unknown) {
      const reason = unreadableReason(error);
      if (reason === null) throw error;
      await unreadable(path, reason);
      return null;
    }
  }

  // Scratch and a staged write a crash left are temporary by location; so are
  // the `stray` files named. The item's own file and audio are not touched.
  private async clearLeftovers(folder: string, stray: readonly string[], logger: AppLogger, result: QueueLoad): Promise<void> {
    for (const name of await folderEntries(folder)) {
      if (name !== SCRATCH_FOLDER && !STAGED_ITEM_FILE.test(name) && !stray.includes(name)) continue;
      await this.clear(join(folder, name), logger, () => { result.clearedLeftovers += 1; });
    }
  }

  // Cleanup: what cannot be removed now is tried again next launch.
  private async clear(path: string, logger: AppLogger, onCleared: () => void): Promise<void> {
    try {
      await rm(path, { recursive: true, force: true });
      onCleared();
    } catch (error: unknown) {
      await logger.warn("startup.cleanup", "Could not remove a leftover in the queue's folders.", {
        path, error: error instanceof Error ? error.message : String(error),
      });
    }
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

  writeImport(item: PendingImportReviewItem): Promise<void> {
    return this.write(`import:${item.id}`, join(this.importFolder(item.id), IMPORT_FILE), serializeImport(item));
  }

  /** Writes again, from `state`, every file whose latest write failed. */
  async retryFailedWrites(state: MumblerQueue): Promise<void> {
    let firstError: unknown = null;
    for (const key of [...this.failed]) {
      try {
        const card = state.cards.find((entry) => `card:${entry.id}` === key);
        const item = state.pendingImports.find((entry) => `import:${entry.id}` === key);
        if (card !== undefined) await this.writeCard(card);
        else if (item !== undefined) await this.writeImport(item);
        else this.failed.delete(key);
      } catch (error: unknown) {
        firstError ??= error;
      }
    }
    if (firstError !== null) throw firstError;
  }

  /**
   * Makes a pending import the card given: writes its card.json into the
   * import's folder, then renames the folder into cards/, which commits it.
   * When either step fails the import stays as it was.
   */
  async acceptImport(item: PendingImportReviewItem, card: MumblerCard): Promise<void> {
    const folder = this.importFolder(item.id);
    const staged = join(folder, CARD_FILE);
    await writeJsonFile(staged, serializeCard(card));
    try {
      await mkdir(this.cardsDir, { recursive: true });
      await rename(folder, this.cardFolder(item.id));
    } catch (error: unknown) {
      await rm(staged, { force: true }).catch(() => undefined);
      throw error;
    }
    this.failed.delete(`import:${item.id}`);
    // Left behind, it is cleared at the next launch.
    await rm(join(this.cardFolder(item.id), IMPORT_FILE), { force: true }).catch(() => undefined);
  }

  /** Removes a card: its folder is renamed aside in one step, then deleted. A failed rename throws and keeps the card. */
  removeCard(cardId: string): Promise<void> {
    this.failed.delete(`card:${cardId}`);
    return this.removeFolder(this.cardsDir, cardId);
  }

  /** Removes a pending import and its copy, as removeCard does a card. */
  removeImport(importId: string): Promise<void> {
    this.failed.delete(`import:${importId}`);
    return this.removeFolder(this.inboxDir, importId);
  }

  private async removeFolder(directory: string, id: string): Promise<void> {
    const removed = join(directory, `${REMOVED_PREFIX}${id}`);
    try {
      await rename(join(directory, id), removed);
    } catch (error: unknown) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    // The item is gone once renamed; a folder left here is deleted at launch.
    await rm(removed, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Explicit reset may set damaged files aside, but never a readable newer one. */
  async admitReset(): Promise<void> {
    for (const name of await folderEntries(this.cardsDir)) {
      await assertResettableJson(join(this.cardsDir, name, CARD_FILE), FORMATS.card);
    }
    for (const name of await folderEntries(this.inboxDir)) {
      await assertResettableJson(join(this.inboxDir, name, IMPORT_FILE), FORMATS.pendingImport);
    }
  }

  /** Sets the queue's folders aside together for Reset, in one
   * "queue-<time>.invalid" folder beside them, naming each path to `onMoved`
   * as it moves, so a move that fails part-way still reports the earlier ones. */
  async preserveExistingFiles(onMoved: (path: string) => void = () => undefined): Promise<string[]> {
    await this.admitReset();
    const present: string[] = [];
    for (const path of [this.cardsDir, this.inboxDir]) {
      if (await fileExists(path)) present.push(path);
    }
    if (present.length > 0) {
      const aside = join(dirname(this.cardsDir), `queue-${formatUtcMarkerMs(new Date())}.invalid`);
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
