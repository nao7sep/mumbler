import { formatError, preserveAside, readJsonFile, writeJsonFile } from "./file-io";
import { NewerFormatError, recordedFormatVersion } from "./format-versions";

// Thrown when a persisted file exists but cannot be safely loaded: malformed
// JSON, or a document that does not fit its shape. The store never overwrites or
// deletes the offending file in this case; the caller decides the recovery. A
// read that failed keeps its error as the cause.
export class CorruptStateError extends Error {
  constructor(
    readonly filePath: string,
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`Could not load ${filePath}: ${reason}.`, options);
    this.name = "CorruptStateError";
  }
}

// Checks the format version a JSON document records against the one this build
// reads: a missing or unusable marker is corruption, and a newer one is intact
// data this build leaves alone (store-recovery-conventions).
export function assertReadableFormat(filePath: string, document: Record<string, unknown>, supported: number): void {
  const recorded = recordedFormatVersion(document);
  if (recorded === null) {
    throw new CorruptStateError(filePath, "formatVersion is missing or not a positive integer");
  }
  if (recorded > supported) {
    throw new NewerFormatError(filePath, recorded, supported);
  }
}

export interface JsonStoreOptions<T> {
  /** Absolute path to the canonical file (e.g. ~/.mumbler/queue.json). */
  path: string;
  /** The format version this build reads and writes, recorded as `formatVersion`. */
  formatVersion: number;
  /** Normalize/validate raw parsed JSON into the typed value. Pure, no I/O. */
  validate: (raw: Record<string, unknown>) => T;
  /** Build the in-memory default when no file exists yet. Pure, no I/O. */
  createDefault: () => T;
  /**
   * Render the typed value into its on-disk shape before writing. Pure, no I/O.
   * The write-side mirror of validate(): validate() parses a raw file into T;
   * serialize() renders T back to the canonical on-disk form. Defaults to
   * identity, so stores whose in-memory shape is already the on-disk shape omit
   * it. Used to convert in-memory epoch-ms instants to canonical ISO at the
   * persistence edge while keeping the core in epoch-ms. The store adds
   * `formatVersion` itself.
   */
  serialize?: (value: T) => object;
  /** Whether writes enter backups.sqlite3. Defaults to true for managed text. */
  record?: boolean;
}

export interface LoadResult<T> {
  value: T;
  /** "created" when no file existed (defaults, not yet written); "loaded" otherwise. */
  origin: "created" | "loaded";
}

// Owns the full safe lifecycle of ONE canonical JSON file:
//   - load(): never destructive — missing → defaults, corrupt → throws
//     CorruptStateError, newer format → throws NewerFormatError (the file is
//     left untouched either way), valid → returns.
//   - save(): serialized (no overlapping writes) + atomic (temp + fsync +
//     rename + dir fsync, via writeJsonFile).
//   - flush(): await all queued writes — used by graceful shutdown.
//
// There is no `.bak` last-good copy: save() is atomic (temp + rename), so a write
// can never tear the canonical file into a state that would need one. A logically
// bad file (hand-edited, or a newer format) is left untouched for the user to repair
// or delete, and Reset (preserveExistingFiles) sets it aside before writing
// defaults so the original is always recoverable.
export class JsonStore<T extends object> {
  private queue: Promise<void> = Promise.resolve();
  // The latest write, when it failed: the value it could not write. A write
  // that lands clears it.
  private failure: { readonly value: T } | null = null;

  constructor(private readonly options: JsonStoreOptions<T>) {}

  get path(): string {
    return this.options.path;
  }

  async load(): Promise<LoadResult<T>> {
    let raw: unknown;
    try {
      raw = await readJsonFile<unknown>(this.options.path);
    } catch (error) {
      // Present but unreadable/unparseable. Leave it in place; the caller halts.
      throw new CorruptStateError(this.options.path, formatError(error), { cause: error });
    }

    if (raw === undefined) {
      return { value: this.options.createDefault(), origin: "created" };
    }

    // Valid JSON, but not a document object (e.g. null, an array or a bare number).
    // Treat it as corruption rather than silently resetting to defaults, so the
    // user is alerted instead of losing whatever the file was meant to hold.
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new CorruptStateError(this.options.path, "file does not contain a JSON object");
    }

    const record = raw as Record<string, unknown>;
    assertReadableFormat(this.options.path, record, this.options.formatVersion);

    return { value: this.options.validate(record), origin: "loaded" };
  }

  async save(value: T): Promise<void> {
    const work = (): Promise<void> => this.write(value);
    // Chain on the tail so writes never overlap, and a failed write doesn't
    // wedge the queue (errors propagate to that caller but the chain continues).
    this.queue = this.queue.then(work, work);
    return this.queue;
  }

  /** Serialize a read-modify-write; undefined leaves the file as it is. */
  async update(change: (current: T) => T | undefined): Promise<void> {
    const work = async (): Promise<void> => {
      const { value } = await this.load();
      const next = change(value);
      if (next === undefined) return;
      await this.write(next);
    };
    this.queue = this.queue.then(work, work);
    return this.queue;
  }

  private async write(value: T): Promise<void> {
    const wire = this.options.serialize ? this.options.serialize(value) : value;
    try {
      await writeJsonFile(
        this.options.path,
        { formatVersion: this.options.formatVersion, ...wire },
        { record: this.options.record },
      );
    } catch (error: unknown) {
      this.failure = { value };
      throw error;
    }
    this.failure = null;
  }

  /** The latest write when it failed, holding the value it could not write;
   * null once a write lands. Each failure is a new object. */
  get failedWrite(): { readonly value: T } | null {
    return this.failure;
  }

  /** Writes again the value the latest write failed to write; nothing when it landed. */
  retryFailedWrite(): Promise<void> {
    const work = async (): Promise<void> => {
      if (this.failure !== null) await this.write(this.failure.value);
    };
    this.queue = this.queue.then(work, work);
    return this.queue;
  }

  // Awaits all queued writes — used by graceful shutdown. A failed save() rejects
  // to its own awaiter (every caller awaits save()/persistState(), and those
  // rejections are logged at the IPC boundary or in the pipeline's catch), so the
  // error is never lost. flush() is only a drain barrier: it must not re-reject on
  // an error already delivered there, or one failed final write would wedge
  // shutdown. This is deliberate control flow, not a swallowed failure.
  async flush(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  // Sets the canonical file aside to a quarantined "<stem>-<stamp>.invalid" name,
  // returning the path it moved to (or [] if there was nothing to move). This is
  // the explicit-recovery (Reset) escape hatch: the user's original data is
  // preserved before defaults are written over it.
  //
  // Call before save(): it does not go through the write queue, and is meant to
  // run on a fresh store with no writes in flight (as Reset does).
  async preserveExistingFiles(): Promise<string[]> {
    const movedTo = await preserveAside(this.options.path);
    return movedTo !== null ? [movedTo] : [];
  }
}
