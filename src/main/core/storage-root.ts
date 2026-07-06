/**
 * The single storage-root resolver — the one place that decides where mumbler keeps its own files, per
 * the storage-path conventions. Every subpath (config.json, state.json, logs/, working/, and the backup
 * store) is derived from the root this module returns and from nowhere else, so one variable moves the
 * whole tree and two derivations can never disagree.
 *
 * The root is `~/.mumbler` by default, resolved from `os.homedir()` and from nothing about how the app was
 * launched — never the working directory. `MUMBLER_HOME` relocates the whole root: its value is expanded
 * (a leading `~`/`~/` and `$VAR`/`${VAR}`/`%VAR%` references) and then made absolute *against the home
 * directory*, never against `process.cwd()`, so the override can never reintroduce the cwd dependence the
 * convention removes. A value that cannot be made into a usable absolute path is a reported startup error,
 * never a silent fallback to the default.
 *
 * This module holds no electron import, so both the electron main runtime (app-runtime.ts, which re-exports
 * it) and the pure Node backup store (backupStore.ts) resolve the root the same way without dragging
 * electron into the store. Pure and home-injectable, so it is unit-testable without touching the real
 * environment. Resolution is lazy at every call site (never frozen into an import-time constant), so a
 * half-set environment is never captured before it is fully set.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// Expand `$VAR` / `${VAR}` (POSIX) and `%VAR%` (Windows) references against the current environment. An
// undefined reference expands to empty, matching shell behavior, rather than being left as a literal that
// would later become a directory name.
function expandEnvReferences(value: string): string {
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "")
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => process.env[name] ?? "")
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_match, name: string) => process.env[name] ?? "");
}

// Resolve the single storage root per the storage-path-conventions. The root is MUMBLER_HOME when that
// variable is set and non-empty (trimmed); otherwise the default `<home>/.mumbler`. An override is
// expanded (a leading `~`/`~/` and `$VAR` env references), then made absolute against the HOME directory —
// never process.cwd(), so the override can never reintroduce a working-directory dependence. A value that
// cannot be made into a usable absolute path is a reported startup error, never a silent fallback to the
// default.
export function resolveStorageRoot(
  rawOverride: string | undefined,
  homeDirectory: string,
): string {
  const trimmed = rawOverride?.trim() ?? "";
  if (trimmed.length === 0) {
    return join(homeDirectory, ".mumbler");
  }

  let value = expandEnvReferences(trimmed).trim();

  // An override that is set but expands to nothing — an unset `$VAR`/`%VAR%`, say — is a misconfiguration.
  // Rejecting it is the "reported startup error, not a silent fallback" the convention requires, and it
  // avoids silently collapsing the root onto the bare home directory.
  if (value.length === 0) {
    throw new Error(
      `MUMBLER_HOME is set to "${rawOverride}" but expands to an empty path ` +
        `(an unset $VAR/%VAR%?). Set it to a usable directory, or unset it to use ~/.mumbler.`,
    );
  }

  // Expand a leading `~` / `~/` (and `~\` on Windows) to the home directory.
  if (value === "~") {
    value = homeDirectory;
  } else if (value.startsWith("~/") || value.startsWith("~\\")) {
    value = join(homeDirectory, value.slice(2));
  }

  // A still-relative value is resolved against the HOME directory, not the working directory, so launch
  // context can never move the storage root. resolve() always returns an absolute path, so no further
  // guard is needed.
  return isAbsolute(value) ? resolve(value) : resolve(homeDirectory, value);
}

// The resolved storage root for this process, honoring MUMBLER_HOME. Computed lazily at every call (not
// frozen into a module constant at import time) so the environment is read after it is set, per the
// storage-path convention's caution against import-time resolution. This is the mumbler analogue of
// zipkit's `storageRoot()`.
export function storageRoot(): string {
  return resolveStorageRoot(process.env.MUMBLER_HOME, homedir());
}
