import { chmod, stat } from "node:fs/promises";

import { fileExists, formatError, preserveAside, readJsonFile, writeJsonFile } from "./file-io";

/**
 * API key storage and resolution — the secret store, kept in its own 0600 file
 * under the app storage root (`~/.mumbler/api-keys.json`), separate from the
 * shared settings store. This is the fleet api-key-storage-conventions realized
 * for mumbler.
 *
 * mumbler uses a single key today (`"gemini"` → GEMINI_API_KEY), but the
 * module is the generic, id-addressed form so its contract matches every
 * other app in the fleet.
 *
 * Contract (api-key-storage-conventions):
 *   - A key id is one flat lowercase string (`gemini`, or `provider.purpose`
 *     such as `gemini.text`); its environment variable is the id uppercased,
 *     dots to underscores, suffixed "_API_KEY". Stored ids are matched
 *     case-insensitively; non-conforming ids are ignored.
 *   - Resolution consults exactly two places for the exact id: the environment
 *     variable, then the stored value. There is no fallback from a longer id to
 *     a shorter one. Every value is trimmed; blank counts as absent; an
 *     environment value is never written back.
 *   - The stored value is `obf:` + base64 of the reversed UTF-8 bytes; an
 *     untagged value is treated as plaintext. This is NOT encryption — the 0600
 *     mode is the real protection. A marked value that fails canonical base64
 *     validation is never decoded (Node's decoder would otherwise silently drop
 *     invalid characters); it is treated as absent and warned about, naming the
 *     key id, rather than handed to a provider as garbage.
 *   - On read: a group/world-readable file is warned about once and tightened to
 *     0600 every time it is found that way (POSIX only); a corrupt/unreadable
 *     file is moved aside to a timestamped neighbour, warned, and treated as
 *     empty rather than throwing.
 */

const MARKER = "obf:";
const SECRETS_FILE_MODE = 0o600;
const ENFORCE_FILE_MODE = process.platform !== "win32";

type WarnFn = (message: string, details: Record<string, unknown>) => void;
const noopWarn: WarnFn = () => undefined;

interface ApiKeysFile {
  keys: Record<string, string>;
}

// --- key id / env var derivation ---------------------------------------------

const KEY_ID_RE = /^[a-z0-9]+(\.[a-z0-9]+)*$/;

function assertKeyId(id: string): void {
  if (!KEY_ID_RE.test(id)) {
    throw new Error(`Invalid api-key id "${id}": must match [a-z0-9]+(.[a-z0-9]+)*`);
  }
}

export function apiKeyEnvVar(id: string): string {
  return `${id.toUpperCase().replace(/\./g, "_")}_API_KEY`;
}

// --- obfuscation (NOT encryption) --------------------------------------------

function encodeApiKey(plain: string): string {
  return MARKER + Buffer.from(Buffer.from(plain, "utf8")).reverse().toString("base64");
}

// Canonical base64 (RFC 4648, standard alphabet, correct padding) — anything
// else is a payload Node's lenient `Buffer.from(_, "base64")` would silently
// mangle (dropping unrecognized characters) rather than reject.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function isCanonicalBase64(payload: string): boolean {
  return payload.length % 4 === 0 && BASE64_RE.test(payload);
}

// Convention: an untagged value is plaintext, used as-is; a tagged value must be
// canonical base64 behind the marker. Never throws: a marked payload that fails
// canonical validation returns `null` rather than silently decoding to garbage
// (Node drops invalid characters instead of rejecting them), and the caller
// treats `null` as absent and warns, naming the key id.
function decodeApiKey(stored: string): string | null {
  if (!stored.startsWith(MARKER)) return stored;
  const payload = stored.slice(MARKER.length);
  if (!isCanonicalBase64(payload)) return null;
  return Buffer.from(payload, "base64").reverse().toString("utf8");
}

// --- file read/write ---------------------------------------------------------

// Warn at most once per process about an insecure mode, so a key read on every
// pipeline run does not spam the log. The tightening itself is never suppressed:
// it runs on every access that finds the file group/world-readable, regardless
// of whether the warning has already fired this session.
let modeWarned = false;

async function warnIfInsecureMode(filePath: string, warn: WarnFn): Promise<void> {
  if (!ENFORCE_FILE_MODE) return;
  try {
    const fileStat = await stat(filePath);
    if ((fileStat.mode & 0o077) !== 0) {
      if (!modeWarned) {
        modeWarned = true;
        warn("API key file is readable beyond the owner; tightening to 0600.", {
          path: filePath,
          mode: (fileStat.mode & 0o777).toString(8).padStart(3, "0"),
        });
      }
      await chmod(filePath, SECRETS_FILE_MODE).catch(() => undefined);
    }
  } catch {
    // No file yet, or stat failed — nothing to tighten.
  }
}

// Validate and canonicalize the on-disk shape: `{ keys: { id: value } }`, ids
// lowercased and matched against the id grammar, values kept only when strings.
// A hand-edited, otherwise valid container degrades to whatever entries are
// valid. A wrong root/container shape returns null so the caller can preserve
// the original bytes before treating the canonical store as empty.
function normalize(raw: unknown): ApiKeysFile | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rawKeys = (raw as { keys?: unknown }).keys;
  if (!rawKeys || typeof rawKeys !== "object" || Array.isArray(rawKeys)) return null;
  const keys: Record<string, string> = {};
  for (const [id, value] of Object.entries(rawKeys as Record<string, unknown>)) {
    const canonical = id.toLowerCase();
    if (typeof value === "string" && KEY_ID_RE.test(canonical)) keys[canonical] = value;
  }
  return { keys };
}

async function readAll(filePath: string, warn: WarnFn): Promise<ApiKeysFile> {
  await warnIfInsecureMode(filePath, warn);
  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(filePath);
  } catch (error) {
    // Corrupt/unreadable: never fail key resolution over it. Move the bad file
    // aside (timestamped) so its bytes are preserved and it is handled once,
    // warn, and degrade to "no key" — it is rebuilt on the next write.
    const preserved = await preserveAside(filePath).catch(() => null);
    warn("api-keys.json was unreadable; moved aside and treating as empty", {
      path: filePath,
      preserved,
      error: formatError(error),
    });
    return { keys: {} };
  }
  // readJsonFile uses null for both a missing file and a file containing the
  // valid JSON literal null. Only the former is an empty store; preserve the
  // latter just like every other wrong root shape.
  if (raw === null && !(await fileExists(filePath))) return { keys: {} };
  const normalized = normalize(raw);
  if (normalized !== null) return normalized;

  const preserved = await preserveAside(filePath).catch(() => null);
  warn("api-keys.json had an unexpected shape; moved aside and treating as empty", {
    path: filePath,
    preserved,
  });
  return { keys: {} };
}

async function writeAll(filePath: string, data: ApiKeysFile): Promise<void> {
  // not recorded: api-keys.json is a secret and is never written into the backup store (data-backup
  // conventions). A history that held a credential would become sensitive-at-rest in its entirety; keeping
  // secrets out is what keeps backups.sqlite3 no more sensitive than ordinary user text. `record: false` is
  // the explicit opt-out — NOT gated on `mode`, because on Windows the mode is undefined yet the file is
  // still the secret. The live secret keeps its own 0600 protection here; that is where a secret is guarded.
  await writeJsonFile(filePath, data, {
    mode: ENFORCE_FILE_MODE ? SECRETS_FILE_MODE : undefined,
    record: false,
  });
}

function envValue(id: string): string | null {
  const value = process.env[apiKeyEnvVar(id)]?.trim();
  return value ? value : null;
}

// --- public API --------------------------------------------------------------

/**
 * Resolve a key's plaintext value for the exact id — the environment variable,
 * then the stored value — or null when neither holds one. There is no fallback
 * to a shorter id.
 */
export async function resolveApiKey(
  filePath: string,
  id: string,
  warn: WarnFn = noopWarn,
): Promise<string | null> {
  assertKeyId(id);

  const fromEnv = envValue(id);
  if (fromEnv) return fromEnv;

  const all = await readAll(filePath, warn);
  const stored = all.keys[id];
  if (typeof stored === "string") {
    const decoded = decodeApiKey(stored);
    if (decoded === null) {
      // A malformed obf: payload never reaches the caller (Node's base64
      // decoder would otherwise silently drop invalid characters and hand
      // back garbage). Treat it as absent and warn.
      warn(`API key "${id}" is stored with a malformed obf: value; treating as absent.`, {
        keyId: id,
      });
      return null;
    }
    const key = decoded.trim();
    if (key) return key;
  }
  return null;
}

/** Whether a key resolves from either the environment or the stored file. */
export async function hasApiKey(
  filePath: string,
  id: string,
  warn: WarnFn = noopWarn,
): Promise<boolean> {
  return (await resolveApiKey(filePath, id, warn)) !== null;
}

/** Persist a key (trimmed, obfuscated). A blank key clears it instead. */
export async function writeApiKey(
  filePath: string,
  id: string,
  apiKey: string,
  warn: WarnFn = noopWarn,
): Promise<void> {
  assertKeyId(id);
  const trimmed = apiKey.trim();
  const all = await readAll(filePath, warn);
  if (trimmed.length === 0) {
    delete all.keys[id];
  } else {
    all.keys[id] = encodeApiKey(trimmed);
  }
  await writeAll(filePath, all);
}

/** Remove the stored key. Any environment value is unaffected. */
export async function clearApiKey(
  filePath: string,
  id: string,
  warn: WarnFn = noopWarn,
): Promise<void> {
  assertKeyId(id);
  const all = await readAll(filePath, warn);
  if (id in all.keys) {
    delete all.keys[id];
    await writeAll(filePath, all);
  }
}
