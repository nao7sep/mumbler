import { readdir, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { MumblerCard } from "@shared/app-shell";

import { isMissingFileError, preserveAside, readJsonFile, writeJsonFile } from "./file-io";
import { FORMAT_VERSIONS } from "./format-versions";
import { assertReadableFormat, assertResettableJson, CorruptStateError, loadFailure, UnreadableStoreError } from "./json-store";

/** A card's two long text bodies, kept in the card's own file rather than in queue.json. */
export interface CardTranscript {
  transcription: string | null;
  structured: string | null;
}

export function transcriptOf(card: MumblerCard): CardTranscript {
  return { transcription: card.transcription.text, structured: card.metadata.structured };
}

function isEmpty(transcript: CardTranscript): boolean {
  return transcript.transcription === null && transcript.structured === null;
}

// Card ids are nanoids, whose alphabet mixes cases; two ids differing only in case
// would name one file on a case-insensitive filesystem. Hex keeps the name unique
// under any comparison and maps back to the id exactly.
function fileNameFor(cardId: string): string {
  return `${Buffer.from(cardId, "utf8").toString("hex")}.json`;
}

function cardIdFrom(fileName: string): string | null {
  if (extname(fileName) !== ".json") return null;
  const hex = basename(fileName, ".json");
  return /^(?:[0-9a-f]{2})+$/.test(hex) ? Buffer.from(hex, "hex").toString("utf8") : null;
}

function serialize(cardId: string, transcript: CardTranscript): Record<string, unknown> {
  return { formatVersion: FORMAT_VERSIONS.transcript, cardId, ...transcript };
}

function parse(path: string, raw: unknown, cardId: string): CardTranscript {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CorruptStateError(path, "file does not contain a JSON object");
  }
  const record = raw as Record<string, unknown>;
  assertReadableFormat(path, record, FORMAT_VERSIONS.transcript);
  if (record.cardId !== cardId) throw new CorruptStateError(path, "cardId does not match the transcript filename");
  // A wrong type is unreadable: read as no text, a later save or cleanup would
  // overwrite or delete it (store-recovery-conventions). An absent field is no text.
  const text = (key: keyof CardTranscript): string | null => {
    const value = record[key];
    if (value === undefined || value === null || typeof value === "string") return value ?? null;
    throw new CorruptStateError(path, `${key} is not text`);
  };
  return { transcription: text("transcription"), structured: text("structured") };
}

// Owns the per-card transcript files under transcripts/. Each file holds one
// card's transcription and structured outline, and is written only when that
// card's text actually changed, so the queue's frequent status saves record
// small rows in the backup history instead of every transcript each time.
//
// Writes are ordered through one queue. A save computes what to write from the
// cards as they are when it is called, and compares against what the last write
// left on disk, so repeated saves of unchanged text write nothing. Each file's
// format is checked once, when open() reads it; writes and removals touch only
// files this session read or wrote, so they do not re-read them.
export class TranscriptStore {
  // What each card's file holds on disk, as serialized text; absent means no file.
  private readonly onDisk = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  /** A directory reset includes text no current queue refers to. Admit all named files. */
  async admitReset(): Promise<void> {
    const names = await readdir(this.directory).catch((error: unknown) => {
      if (isMissingFileError(error)) return [];
      throw error;
    });
    for (const name of names) {
      if (cardIdFrom(name) !== null) await assertResettableJson(join(this.directory, name), FORMAT_VERSIONS.transcript);
    }
  }

  async preserveExistingFiles(): Promise<string | null> {
    await this.admitReset();
    return preserveAside(this.directory);
  }

  /**
   * Reads the transcript of every card in `cardIds`. A file no card refers to is
   * left in place: it may hold the text of a queue that was lost, which is never
   * deleted for that (a removed card's file is deleted when it is removed). A
   * damaged file, one that cannot be read and one in a newer format each halt
   * like the same problem in queue.json, and are left in place.
   */
  async open(cardIds: readonly string[]): Promise<Map<string, CardTranscript>> {
    const wanted = new Set(cardIds);
    const transcripts = new Map<string, CardTranscript>();
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error: unknown) {
      if (isMissingFileError(error)) return transcripts;
      throw new UnreadableStoreError(this.directory, { cause: error });
    }

    for (const name of names) {
      const cardId = cardIdFrom(name);
      if (cardId === null || !wanted.has(cardId)) continue;
      const path = join(this.directory, name);
      let raw: unknown;
      try {
        raw = await readJsonFile<unknown>(path);
      } catch (error: unknown) {
        throw loadFailure(path, error);
      }
      if (raw === undefined) continue;
      const transcript = parse(path, raw, cardId);
      transcripts.set(cardId, transcript);
      this.onDisk.set(cardId, JSON.stringify(serialize(cardId, transcript)));
    }
    return transcripts;
  }

  /** Writes the file of every card whose text differs from what is on disk; returns how many. */
  writeChanged(cards: readonly MumblerCard[]): Promise<number> {
    const wanted = cards.map((card) => ({ cardId: card.id, transcript: transcriptOf(card) }));
    return this.enqueue(async () => {
      let written = 0;
      for (const { cardId, transcript } of wanted) {
        if (isEmpty(transcript)) continue;
        const value = serialize(cardId, transcript);
        const text = JSON.stringify(value);
        if (this.onDisk.get(cardId) === text) continue;
        await writeJsonFile(this.pathFor(cardId), value);
        this.onDisk.set(cardId, text);
        written += 1;
      }
      return written;
    });
  }

  /** Deletes the file of every card that is gone or has no text left. */
  removeAbsent(cards: readonly MumblerCard[]): Promise<void> {
    const keep = new Set(cards.filter((card) => !isEmpty(transcriptOf(card))).map((card) => card.id));
    return this.enqueue(async () => {
      for (const cardId of [...this.onDisk.keys()]) {
        if (keep.has(cardId)) continue;
        // not recorded: a deletion writes no bytes; the file's last version is
        // already in the backup history.
        await rm(this.pathFor(cardId), { force: true });
        this.onDisk.delete(cardId);
      }
    });
  }

  /** Awaits every queued write; used by graceful shutdown. */
  async flush(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  private pathFor(cardId: string): string {
    return join(this.directory, fileNameFor(cardId));
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
