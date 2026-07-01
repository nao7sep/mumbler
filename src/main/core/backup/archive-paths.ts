/**
 * Pure mapping from a file's role to its entry path within the archive. Mumbler keeps all its managed
 * data under `~/.mumbler/` (there are no external roots), so the archive is a faithful image of the home
 * root: each captured file maps straight from its path relative to the home root onto the archive root
 * (`config.json` → `config.json`, `sub/x` → `sub/x`). All entry paths use forward slashes.
 */

/** Normalizes a filesystem-relative path to a forward-slash archive path. */
export function normalize(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** A file directly under `~/.mumbler/`: its relative path is the archive path (`config.json`). */
export function forHomeFile(relativePath: string): string {
  return normalize(relativePath);
}
