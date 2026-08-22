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

// Resolve any user/configured path with the same expansion rules as the storage
// root. A relative value is anchored to the home directory, never process.cwd(),
// so a typed path behaves identically in development and in the packaged app.
export function resolvePathFromHome(rawValue: string, homeDirectory: string): string {
  let value = expandEnvReferences(rawValue.trim()).trim();
  if (value.length === 0) {
    throw new Error(`Path "${rawValue}" expands to an empty value.`);
  }

  if (value === "~") {
    value = homeDirectory;
  } else if (value.startsWith("~/") || value.startsWith("~\\")) {
    value = join(homeDirectory, value.slice(2));
  }

  return isAbsolute(value) ? resolve(value) : resolve(homeDirectory, value);
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

  try {
    return resolvePathFromHome(trimmed, homeDirectory);
  } catch {
    // A set-but-empty-expanding override is a misconfiguration. Reject it rather
    // than silently collapsing the root onto the bare home directory.
    throw new Error(
      `MUMBLER_HOME is set to "${rawOverride}" but expands to an empty path ` +
        `(an unset $VAR/%VAR%?). Set it to a usable directory, or unset it to use ~/.mumbler.`,
    );
  }
}

// The resolved storage root for this process, honoring MUMBLER_HOME. Computed lazily at every call (not
// frozen into a module constant at import time) so the environment is read after it is set, per the
// storage-path convention's caution against import-time resolution. This is the mumbler analogue of
// zipkit's `storageRoot()`.
export function storageRoot(): string {
  return resolveStorageRoot(process.env.MUMBLER_HOME, homedir());
}
