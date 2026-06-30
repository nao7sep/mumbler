import { formatError, preserveAside, readJsonFile, writeJsonFile } from "./file-io";

// Thrown when a persisted file exists but cannot be safely loaded — malformed
// JSON, or an on-disk schema version newer than this build understands. The
// store never overwrites or deletes the offending file in this case; the caller
// is expected to halt and surface the path so the user can repair or restore it.
export class CorruptStateError extends Error {
  constructor(
    readonly filePath: string,
    readonly reason: string,
  ) {
    super(`Could not load ${filePath}: ${reason}.`);
    this.name = "CorruptStateError";
  }
}

export interface JsonStoreOptions<T> {
  /** Absolute path to the canonical file (e.g. ~/.mumbler/state.json). */
  path: string;
  /** Highest schema version this build can read. Newer files are refused. */
  schemaVersion: number;
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
   * persistence edge while keeping the core in epoch-ms.
   */
  serialize?: (value: T) => unknown;
}

export interface LoadResult<T> {
  value: T;
  /** "created" when no file existed (defaults, not yet written); "loaded" otherwise. */
  origin: "created" | "loaded";
}

// Owns the full safe lifecycle of ONE canonical JSON file:
//   - load(): never destructive — missing → defaults, corrupt → throws (file
//     left untouched), valid → returns.
//   - save(): serialized (no overlapping writes) + atomic (temp + fsync +
//     rename + dir fsync, via writeJsonFile).
//   - flush(): await all queued writes — used by graceful shutdown.
//
// There is no `.bak` last-good copy: save() is atomic (temp + rename), so a write
// can never tear the canonical file into a state that would need one. A logically
// bad file (hand-edited, or newer schema) is left untouched for the user to repair
// or delete, and Reset (preserveExistingFiles) sets it aside before writing
// defaults so the original is always recoverable.
export class JsonStore<T> {
  private queue: Promise<void> = Promise.resolve();

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
      throw new CorruptStateError(this.options.path, formatError(error));
    }

    if (raw === null) {
      return { value: this.options.createDefault(), origin: "created" };
    }

    // Valid JSON, but not a document object (e.g. an array or a bare number).
    // Treat it as corruption rather than silently resetting to defaults, so the
    // user is alerted instead of losing whatever the file was meant to hold.
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new CorruptStateError(this.options.path, "file does not contain a JSON object");
    }

    const record = raw as Record<string, unknown>;
    const onDiskVersion =
      typeof record.schemaVersion === "number" ? record.schemaVersion : null;
    if (onDiskVersion !== null && onDiskVersion > this.options.schemaVersion) {
      throw new CorruptStateError(
        this.options.path,
        `on-disk schema version ${onDiskVersion} is newer than this build supports (${this.options.schemaVersion})`,
      );
    }

    return { value: this.options.validate(record), origin: "loaded" };
  }

  async save(value: T): Promise<void> {
    const work = async (): Promise<void> => {
      const wire = this.options.serialize ? this.options.serialize(value) : value;
      await writeJsonFile(this.options.path, wire);
    };
    // Chain on the tail so writes never overlap, and a failed write doesn't
    // wedge the queue (errors propagate to that caller but the chain continues).
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

  // Sets the canonical file aside to a timestamped ".corrupt-<stamp>" name,
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
