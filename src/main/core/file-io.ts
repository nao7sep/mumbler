import { access, chmod, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, extname, join } from "node:path";
import { nanoid } from "nanoid";

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw new Error(`Failed to read JSON file at ${filePath}: ${formatError(error)}`);
  }
}

// Atomic JSON write: temp file in the same directory -> fsync -> rename over the
// target -> fsync the parent dir. When `mode` is given (e.g. 0o600 for a secrets
// file), it is applied to the temp file *before* the rename, so the target is
// never momentarily readable beyond that mode — the file appears at its final
// path already tightened. The mode is ignored on platforms where chmod is a
// no-op (Windows), matching the secrets convention's POSIX-only permission rule.
export async function writeJsonFile(
  filePath: string,
  value: unknown,
  mode?: number,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${nanoid(8)}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (mode !== undefined) {
      await chmod(tempPath, mode);
    }
    await syncFile(tempPath);
    await rename(tempPath, filePath);
    await syncDirectory(dirname(filePath));
  } catch (error) {
    // Best-effort removal of the half-written temp file; the original write error
    // is the meaningful one and is always rethrown below, so a failed cleanup is
    // deliberately not surfaced on top of it.
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

// Best-effort fsync of a directory so the rename above — the atomic-write commit
// point — is itself durable across power loss. Opening a directory is not
// supported on every platform (Windows throws), so failures are ignored: this
// is a durability nicety, not required for correctness.
async function syncDirectory(directoryPath: string): Promise<void> {
  try {
    const handle = await open(directoryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // ignore
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Picks a path in `directory` whose basename does not collide with any existing
// entry *case-insensitively* — because macOS/Windows are case-insensitive,
// "File.wav" and "file.wav" would clobber each other in the same directory. The
// human-readable name is preserved; only the collision test folds case. The
// directory is read once and its names casefolded, then the disambiguation
// suffix is advanced until the candidate no longer collides.
export async function uniquePathInDirectory(directory: string, filename: string): Promise<string> {
  const extension = extname(filename);
  const stem = filename.slice(0, filename.length - extension.length);

  let existing: Set<string>;
  try {
    existing = new Set((await readdir(directory)).map((name) => name.toLowerCase()));
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      throw error;
    }
    existing = new Set();
  }

  let name = filename;
  while (existing.has(name.toLowerCase())) {
    name = `${stem}-${nanoid(8)}${extension}`;
  }

  return join(directory, name);
}

export function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

// Moves an existing file aside to "<path>.corrupt-<yyyymmdd-hhmmss-utc>",
// returning the new path (or null if there was nothing to move). Used by
// explicit recovery (e.g. Reset) so a user's unreadable data is preserved rather
// than silently overwritten.
export async function preserveAside(filePath: string): Promise<string | null> {
  if (!(await fileExists(filePath))) {
    return null;
  }
  const preserved = `${filePath}.corrupt-${utcStampForFilename()}`;
  await rename(filePath, preserved);
  return preserved;
}

function utcStampForFilename(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}-utc`
  );
}
