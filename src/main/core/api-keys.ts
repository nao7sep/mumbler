import { chmod, stat } from "node:fs/promises";

import { formatError, preserveAside, readJsonFile, writeJsonFile } from "./file-io";

/**
 * API key storage and resolution — the secret store, kept in its own 0600 file
 * under the app storage root (`~/.mumbler/api-keys.json`), separate from the
 * shared settings store. This is the fleet api-key-storage-conventions realized
 * for mumbler.
 *
 * mumbler uses a single key today (`["gemini"]` → GEMINI_API_KEY), but the
 * module is the generic, segment-addressed form so its contract matches every
 * other app in the fleet.
 *
 * Contract (api-key-storage-conventions):
 *   - A key id is its segments joined by ".", lowercase; its environment
 *     variable is the segments uppercased, joined by "_", suffixed "_API_KEY".
 *     Stored ids are matched case-insensitively; non-conforming ids are ignored.
 *   - Resolution is source-first: every environment candidate (most→least
 *     specific) then every stored candidate. Environment wins; the longer (more
 *     specific) key wins within each source. `fallback: false` consults only the
 *     exact key. Every value is trimmed; blank counts as absent; an environment
 *     value is never written back.
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

interface ResolveOptions {
  fallback?: boolean;
}

// --- key id / env var derivation ---------------------------------------------

const SEGMENT_RE = /^[a-z0-9]+$/;
const KEY_ID_RE = /^[a-z0-9]+(\.[a-z0-9]+)*$/;

function assertSegments(segments: string[]): void {
  if (segments.length === 0 || !segments.every((s) => SEGMENT_RE.test(s))) {
    throw new Error(`Invalid api-key segments [${segments.join(", ")}]: each must match [a-z0-9]+`);
  }
}

// The prefixes of a segment list, most specific first: [a,b,c] → [[a,b,c],[a,b],[a]].
function prefixes(segments: string[]): string[][] {
  const out: string[][] = [];
  for (let n = segments.length; n >= 1; n--) out.push(segments.slice(0, n));
  return out;
}

function keyId(segments: string[]): string {
  return segments.join(".");
}

export function apiKeyEnvVar(segments: string[]): string {
  return `${segments.map((s) => s.toUpperCase()).join("_")}_API_KEY`;
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
// A hand-edited or partly-bad file degrades to whatever is valid, never throws.
function normalize(raw: unknown): ApiKeysFile {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { keys: {} };
  const rawKeys = (raw as { keys?: unknown }).keys;
  if (!rawKeys || typeof rawKeys !== "object" || Array.isArray(rawKeys)) return { keys: {} };
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
  if (raw === null) return { keys: {} };
  return normalize(raw);
}

async function writeAll(filePath: string, data: ApiKeysFile): Promise<void> {
  await writeJsonFile(filePath, data, ENFORCE_FILE_MODE ? SECRETS_FILE_MODE : undefined);
}

function envValue(segments: string[]): string | null {
  const value = process.env[apiKeyEnvVar(segments)]?.trim();
  return value ? value : null;
}

// --- public API --------------------------------------------------------------

/**
 * Resolve a key's plaintext value, source-first (environment then stored,
 * most→least specific), or null when nothing resolves. `fallback: false`
 * consults only the exact key.
 */
export async function resolveApiKey(
  filePath: string,
  segments: string[],
  options: ResolveOptions = {},
  warn: WarnFn = noopWarn,
): Promise<string | null> {
  assertSegments(segments);
  const levels = options.fallback === false ? [segments] : prefixes(segments);

  for (const level of levels) {
    const fromEnv = envValue(level);
    if (fromEnv) return fromEnv;
  }
  const all = await readAll(filePath, warn);
  for (const level of levels) {
    const stored = all.keys[keyId(level)];
    if (typeof stored === "string") {
      const decoded = decodeApiKey(stored);
      if (decoded === null) {
        // A malformed obf: payload never reaches the caller (Node's base64
        // decoder would otherwise silently drop invalid characters and hand
        // back garbage). Treat this candidate as absent and warn, then keep
        // walking the fallback chain exactly as if it were unset.
        warn(`API key "${keyId(level)}" is stored with a malformed obf: value; treating as absent.`, {
          keyId: keyId(level),
        });
        continue;
      }
      const key = decoded.trim();
      if (key) return key;
    }
  }
  return null;
}

/** Whether a key resolves from either the environment or the stored file. */
export async function hasApiKey(
  filePath: string,
  segments: string[],
  options: ResolveOptions = {},
  warn: WarnFn = noopWarn,
): Promise<boolean> {
  return (await resolveApiKey(filePath, segments, options, warn)) !== null;
}

/** Persist a key (trimmed, obfuscated). A blank key clears it instead. */
export async function writeApiKey(
  filePath: string,
  segments: string[],
  apiKey: string,
  warn: WarnFn = noopWarn,
): Promise<void> {
  assertSegments(segments);
  const trimmed = apiKey.trim();
  const all = await readAll(filePath, warn);
  if (trimmed.length === 0) {
    delete all.keys[keyId(segments)];
  } else {
    all.keys[keyId(segments)] = encodeApiKey(trimmed);
  }
  await writeAll(filePath, all);
}

/** Remove the stored key. Any environment value is unaffected. */
export async function clearApiKey(
  filePath: string,
  segments: string[],
  warn: WarnFn = noopWarn,
): Promise<void> {
  assertSegments(segments);
  const all = await readAll(filePath, warn);
  if (keyId(segments) in all.keys) {
    delete all.keys[keyId(segments)];
    await writeAll(filePath, all);
  }
}
