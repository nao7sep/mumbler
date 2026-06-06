import { copyFile } from "node:fs/promises";

import { fileExists, formatError, preserveAside, readJsonFile, writeJsonFile } from "./file-io";

// Thrown when a persisted file exists but cannot be safely loaded — malformed
// JSON, or an on-disk schema version newer than this build understands. The
// store never overwrites or deletes the offending file in this case; the caller
// is expected to halt and surface the path so the user can repair or restore it.
export class CorruptStateError extends Error {
  constructor(
    readonly filePath: string,
    readonly reason: string,
    readonly backupPath: string | null,
  ) {
    super(
      `Could not load ${filePath}: ${reason}.` +
        (backupPath ? ` A last-known-good copy is at ${backupPath}.` : ""),
    );
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
}

export interface LoadResult<T> {
  value: T;
  /** "created" when no file existed (defaults, not yet written); "loaded" otherwise. */
  origin: "created" | "loaded";
}

// Owns the full safe lifecycle of ONE canonical JSON file:
//   - load(): never destructive — missing → defaults, corrupt → throws (file
//     left untouched), valid → returns and refreshes the .bak last-good copy.
//   - save(): serialized (no overlapping writes) + atomic (temp + fsync +
//     rename + dir fsync, via writeJsonFile).
//   - flush(): await all queued writes — used by graceful shutdown.
export class JsonStore<T> {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: JsonStoreOptions<T>) {}

  get path(): string {
    return this.options.path;
  }

  get backupPath(): string {
    return `${this.options.path}.bak`;
  }

  async load(): Promise<LoadResult<T>> {
    let raw: unknown;
    try {
      raw = await readJsonFile<unknown>(this.options.path);
    } catch (error) {
      // Present but unreadable/unparseable. Leave it in place; the caller halts.
      throw new CorruptStateError(this.options.path, formatError(error), await this.existingBackup());
    }

    if (raw === null) {
      return { value: this.options.createDefault(), origin: "created" };
    }

    // Valid JSON, but not a document object (e.g. an array or a bare number).
    // Treat it as corruption rather than silently resetting to defaults, so the
    // user is alerted instead of losing whatever the file was meant to hold.
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new CorruptStateError(
        this.options.path,
        "file does not contain a JSON object",
        await this.existingBackup(),
      );
    }

    const record = raw as Record<string, unknown>;
    const onDiskVersion =
      typeof record.schemaVersion === "number" ? record.schemaVersion : null;
    if (onDiskVersion !== null && onDiskVersion > this.options.schemaVersion) {
      throw new CorruptStateError(
        this.options.path,
        `on-disk schema version ${onDiskVersion} is newer than this build supports (${this.options.schemaVersion})`,
        await this.existingBackup(),
      );
    }

    const value = this.options.validate(record);
    // Refresh the last-known-good copy from the file we just validated. This is
    // the previous session's good state; if the canonical file later becomes
    // unreadable, it is the manual-recovery source named in CorruptStateError.
    await this.refreshBackup();
    return { value, origin: "loaded" };
  }

  async save(value: T): Promise<void> {
    const work = async (): Promise<void> => {
      await writeJsonFile(this.options.path, value);
    };
    // Chain on the tail so writes never overlap, and a failed write doesn't
    // wedge the queue (errors propagate to that caller but the chain continues).
    this.queue = this.queue.then(work, work);
    return this.queue;
  }

  async flush(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  // Sets aside every file this store owns — the canonical file AND its .bak
  // last-known-good copy — to timestamped ".corrupt-<stamp>" names, returning the
  // paths actually moved. The store is the only thing that knows it maintains a
  // .bak, so it must be the one to rescue it: this is the explicit-recovery
  // (Reset) escape hatch. Without it, the next successful load() refreshes .bak
  // from freshly-written defaults and silently erases the user's last readable
  // copy.
  //
  // Call before save(): it does not go through the write queue, and is meant to
  // run on a fresh store with no writes in flight (as Reset does).
  async preserveExistingFiles(): Promise<string[]> {
    const preserved: string[] = [];
    for (const filePath of [this.options.path, this.backupPath]) {
      const movedTo = await preserveAside(filePath);
      if (movedTo !== null) {
        preserved.push(movedTo);
      }
    }
    return preserved;
  }

  private async existingBackup(): Promise<string | null> {
    return (await fileExists(this.backupPath)) ? this.backupPath : null;
  }

  private async refreshBackup(): Promise<void> {
    try {
      await copyFile(this.options.path, this.backupPath);
    } catch {
      // Best-effort: a missing backup never blocks loading.
    }
  }
}
