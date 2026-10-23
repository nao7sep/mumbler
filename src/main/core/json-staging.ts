import { chmod, lstat, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AppPaths } from "@shared/app-shell";

export const JSON_STAGING_DIRECTORY = ".json-staging";

async function ownedDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Only startup calls this, after instance and root admission, before any writer. */
export async function cleanInterruptedJsonWrites(paths: AppPaths): Promise<void> {
  const groups: Array<[string, RegExp]> = [
    [paths.homeDir, /^(?:config|queue|layout|api-keys|dependencies)-[\w-]{8}\.tmp$/],
    [paths.transcriptsDir, /^(?:[0-9a-f]{2})+-[\w-]{8}\.tmp$/],
    [paths.binDir, /^(?:ffmpeg|ffprobe)-[\w-]{8}\.tmp$/],
  ];
  for (const [parent, grammar] of groups) {
    if (!await ownedDirectory(parent)) continue;
    // Legacy sibling stages have this exact generated grammar. Never recurse
    // into directories or follow a link, including a store-directory link.
    await removeStages(parent, grammar);
    const staging = join(parent, JSON_STAGING_DIRECTORY);
    if (await ownedDirectory(staging)) await removeStages(staging, grammar);
  }
}

async function removeStages(directory: string, grammar: RegExp): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && grammar.test(entry.name)) await unlink(join(directory, entry.name));
  }
}

/** Same-parent staging; an unsupported cross-volume rename fails without fallback. */
export async function ensureJsonStagingDirectory(parent: string): Promise<string> {
  const directory = join(parent, JSON_STAGING_DIRECTORY);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("JSON staging is not an owned directory.");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    await chmod(directory, 0o700);
    if (((await lstat(directory)).mode & 0o077) !== 0) throw new Error("JSON staging is not owner-only.");
  }
  return directory;
}
