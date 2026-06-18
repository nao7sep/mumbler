import { chmod, stat } from "node:fs/promises";

import { readJsonFile, writeJsonFile } from "./file-io";

/**
 * Gemini API key storage with environment-first resolution.
 *
 * The key lives in its own file under the mumbler storage root
 * (`~/.mumbler/api-keys.json`), separate from the shared settings store, per the
 * storage-path-conventions' "Secrets and keys" rule. It is mirrored on the other
 * personal AI tools (tapebox / fotoready / imagequeue).
 *
 * The stored value uses the same lightweight local obfuscation those tools use:
 * "obf:" + base64(reverse(key)). This is NOT encryption — it only keeps the raw
 * key out of view during casual file browsing. The real protection is the file's
 * 0600 permissions.
 *
 * Per the convention:
 *   - Resolution prefers the environment: GEMINI_API_KEY, when set and non-empty,
 *     wins over the stored value, so a user can supply a key without persisting
 *     it. The env value is never written back to the file.
 *   - The file is written 0600 on POSIX (owner read/write only). On read, a file
 *     that is group/world-readable is warned about once and tightened back to
 *     0600 rather than refused, so an existing key never becomes unusable.
 *   - The check is skipped on Windows, which uses a different permission model.
 *
 * This module is the single reader/writer of the secret; the pipeline and the
 * IPC layer call resolveGeminiApiKey()/writeGeminiApiKey()/clearGeminiApiKey()
 * rather than touching the file or the settings store.
 */

const KEY_SLOT = "gemini";
const OBFUSCATION_MARKER = "obf:";

// The environment variable that takes precedence over the stored key.
export const GEMINI_API_KEY_ENV_VAR = "GEMINI_API_KEY";

// Secrets file mode on POSIX; the permission model differs on Windows, where the
// permission check and the explicit mode are both skipped (storage-path-conventions).
const SECRETS_FILE_MODE = 0o600;
const ENFORCE_FILE_MODE = process.platform !== "win32";

interface ApiKeysFile {
  // Slot -> obfuscated value. A record (not a single field) so a future second
  // key can be added without changing the file shape.
  keys: Record<string, string>;
}

// Warn at most once per process for an insecure file mode, so a key read on
// every pipeline run does not spam the log.
let modeWarned = false;

function envGeminiKey(): string | null {
  const value = process.env[GEMINI_API_KEY_ENV_VAR];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function encodeApiKey(apiKey: string): string {
  if (apiKey.length === 0) {
    return "";
  }
  const reversed = Array.from(apiKey).reverse().join("");
  return `${OBFUSCATION_MARKER}${Buffer.from(reversed, "utf8").toString("base64")}`;
}

function decodeApiKey(stored: string): string {
  if (!stored.startsWith(OBFUSCATION_MARKER)) {
    return "";
  }
  try {
    const reversed = Buffer.from(stored.slice(OBFUSCATION_MARKER.length), "base64").toString("utf8");
    return Array.from(reversed).reverse().join("");
  } catch {
    return "";
  }
}

function isApiKeysFile(value: unknown): value is ApiKeysFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = (value as Record<string, unknown>).keys;
  return (
    typeof keys === "object" &&
    keys !== null &&
    !Array.isArray(keys) &&
    Object.values(keys).every((entry) => typeof entry === "string")
  );
}

// POSIX-only: warn once if the secrets file is readable beyond the owner, and
// repair the mode opportunistically. The next write re-applies 0600 regardless.
// Best-effort: a failed stat/chmod never blocks reading the key.
async function warnIfInsecureMode(
  filePath: string,
  warn: (message: string, details: Record<string, unknown>) => void,
): Promise<void> {
  if (!ENFORCE_FILE_MODE || modeWarned) {
    return;
  }
  try {
    const fileStat = await stat(filePath);
    if ((fileStat.mode & 0o077) !== 0) {
      modeWarned = true;
      warn("API key file is readable beyond the owner; tightening to 0600.", {
        path: filePath,
        mode: (fileStat.mode & 0o777).toString(8).padStart(3, "0"),
      });
      await chmod(filePath, SECRETS_FILE_MODE).catch(() => undefined);
    }
  } catch {
    // No file yet, or stat failed — nothing to warn about.
  }
}

async function readAll(
  filePath: string,
  warn: (message: string, details: Record<string, unknown>) => void,
): Promise<ApiKeysFile> {
  await warnIfInsecureMode(filePath, warn);
  const raw = await readJsonFile<unknown>(filePath);
  return isApiKeysFile(raw) ? raw : { keys: {} };
}

// A no-op warning sink, used by callers that resolve the key on a hot path
// (the pipeline guard) where a logger may not be on hand. The IPC/runtime
// callers pass a real logger so the tighten-on-read warning is recorded.
const noopWarn = (): void => undefined;

/**
 * Resolve the Gemini API key, environment-first. Returns the env value when
 * GEMINI_API_KEY is set and non-empty (never persisting it), otherwise the
 * stored value, or null when neither is present.
 */
export async function resolveGeminiApiKey(
  filePath: string,
  warn: (message: string, details: Record<string, unknown>) => void = noopWarn,
): Promise<string | null> {
  const fromEnv = envGeminiKey();
  if (fromEnv !== null) {
    return fromEnv;
  }
  const all = await readAll(filePath, warn);
  const apiKey = decodeApiKey(all.keys[KEY_SLOT] ?? "");
  return apiKey.length > 0 ? apiKey : null;
}

/**
 * True when a key is available from either the environment or the stored file.
 * Used for the "is a key configured?" presence flag the UI and snapshot need,
 * without exposing the value.
 */
export async function hasGeminiApiKey(
  filePath: string,
  warn: (message: string, details: Record<string, unknown>) => void = noopWarn,
): Promise<boolean> {
  return (await resolveGeminiApiKey(filePath, warn)) !== null;
}

/** Persist a new stored key (obfuscated), writing the file 0600 on POSIX. */
export async function writeGeminiApiKey(
  filePath: string,
  apiKey: string,
  warn: (message: string, details: Record<string, unknown>) => void = noopWarn,
): Promise<void> {
  const all = await readAll(filePath, warn);
  all.keys[KEY_SLOT] = encodeApiKey(apiKey);
  await writeJsonFile(filePath, all, ENFORCE_FILE_MODE ? SECRETS_FILE_MODE : undefined);
}

/** Remove the stored key. The environment value, if any, is unaffected. */
export async function clearGeminiApiKey(
  filePath: string,
  warn: (message: string, details: Record<string, unknown>) => void = noopWarn,
): Promise<void> {
  const all = await readAll(filePath, warn);
  delete all.keys[KEY_SLOT];
  await writeJsonFile(filePath, all, ENFORCE_FILE_MODE ? SECRETS_FILE_MODE : undefined);
}
