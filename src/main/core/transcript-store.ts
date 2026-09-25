import { readdir, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { MumblerCard } from "@shared/app-shell";

import { formatError, isMissingFileError, readJsonFile, writeJsonFile } from "./file-io";
import { CorruptStateError } from "./json-store";

const TRANSCRIPT_SCHEMA_VERSION = 1;

/** A card's two long text bodies, kept in the card's own file rather than in state.json. */
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
  return { schemaVersion: TRANSCRIPT_SCHEMA_VERSION, cardId, ...transcript };
}

function parse(path: string, raw: unknown): CardTranscript {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CorruptStateError(path, "file does not contain a JSON object");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.schemaVersion === "number" && record.schemaVersion > TRANSCRIPT_SCHEMA_VERSION) {
    throw new CorruptStateError(
      path,
      `on-disk schema version ${record.schemaVersion} is newer than this build supports (${TRANSCRIPT_SCHEMA_VERSION})`,
      "future-version",
    );
  }
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return { transcription: text(record.transcription), structured: text(record.structured) };
}

// Owns the per-card transcript files under transcripts/. Each file holds one
// card's transcription and structured outline, and is written only when that
// card's text actually changed, so the queue's frequent status saves record
// small rows in the backup history instead of every transcript each time.
//
// Writes are ordered through one queue. A save computes what to write from the
// cards as they are when it is called, and compares against what the last write
// left on disk, so repeated saves of unchanged text write nothing.
export class TranscriptStore {
  // What each card's file holds on disk, as serialized text; absent means no file.
  private readonly onDisk = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  /**
   * Reads the transcript of every card in `cardIds`, and deletes files that no
   * card refers to any more (the card was removed or saved before its file could
   * be). A file that cannot be read halts like a corrupt state.json: it is left
   * in place for the user.
   */
  async open(cardIds: readonly string[]): Promise<Map<string, CardTranscript>> {
    const wanted = new Set(cardIds);
    const transcripts = new Map<string, CardTranscript>();
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error: unknown) {
      if (isMissingFileError(error)) return transcripts;
      throw error;
    }

    for (const name of names) {
      const cardId = cardIdFrom(name);
      if (cardId === null) continue;
      const path = join(this.directory, name);
      if (!wanted.has(cardId)) {
        await rm(path, { force: true });
        continue;
      }
      let raw: unknown;
      try {
        raw = await readJsonFile<unknown>(path);
      } catch (error: unknown) {
        throw new CorruptStateError(path, formatError(error));
      }
      if (raw === null) continue;
      const transcript = parse(path, raw);
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
