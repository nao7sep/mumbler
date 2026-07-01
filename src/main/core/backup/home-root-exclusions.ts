/**
 * The optimistic exclude list for the `~/.mumbler/` home root: everything under the root is backed up
 * except the entries here. Pure, so the "did we pick the right files?" decision is unit-testable.
 *
 * Backed up (managed durable data): `config.json`, `state.json` (the card queue — user work in progress),
 * `api-keys.json` (secrets are backed up too — see the data-backup conventions), and `dependencies.json`.
 *
 * Excluded:
 *  - App-specific: `working/` and `output/` (working audio and finished exports the app re-creates or
 *    already handed to the user), `bin/` and `temp/` (re-fetchable managed audio tools and disposable
 *    download staging), and `layout.json` (volatile pane geometry — near-worthless to capture).
 *  - Always-exclude (shared across the fleet): `backups/` (the feature's own output — capturing it would
 *    recurse), `logs/` (recreatable), `*.tmp` (atomic-write temporaries), and the OS metadata sidecars
 *    `.DS_Store` / `Thumbs.db`.
 *
 * Paths are the forward-slash relative path under the root.
 */
import { normalize } from "./archive-paths.js";

const EXCLUDED_DIRS = ["working", "output", "bin", "temp", "backups", "logs"];
const EXCLUDED_FILES = ["layout.json"];
const EXCLUDED_BASENAMES = [".ds_store", "thumbs.db"];

/** True when a home-root file must not be backed up. */
export function isExcludedFile(relativePath: string): boolean {
  const path = normalize(relativePath);
  if (path.endsWith(".tmp")) return true;
  if (EXCLUDED_FILES.includes(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (EXCLUDED_BASENAMES.includes(basename)) return true;
  return EXCLUDED_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`));
}

/** True when a home-root subdirectory should be pruned (not descended into) during the walk. */
export function isExcludedDir(relativeDirPath: string): boolean {
  const path = normalize(relativeDirPath);
  return EXCLUDED_DIRS.includes(path);
}
