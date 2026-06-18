import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GEMINI_API_KEY_ENV_VAR,
  clearGeminiApiKey,
  hasGeminiApiKey,
  resolveGeminiApiKey,
  writeGeminiApiKey,
} from "@main/core/api-keys";

// The secrets store is isolated by pointing MUMBLER_HOME at a throwaway directory
// (storage-path-conventions: tests relocate the root via the env override, not a
// private setter) and resolving the api-keys path under it exactly as the app
// does. The whole tree is removed after each test.
let home: string;
let apiKeysPath: string;
let settingsPath: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mumbler-secrets-"));
  process.env.MUMBLER_HOME = home;
  apiKeysPath = join(home, "api-keys.json");
  settingsPath = join(home, "settings.json");
  // Start from a clean slate: no env key leaking in from the host.
  delete process.env[GEMINI_API_KEY_ENV_VAR];
});

afterEach(async () => {
  delete process.env.MUMBLER_HOME;
  delete process.env[GEMINI_API_KEY_ENV_VAR];
  await rm(home, { recursive: true, force: true });
});

describe("Gemini API key secrets store", () => {
  it("prefers the environment value over the stored value and never persists it", async () => {
    await writeGeminiApiKey(apiKeysPath, "stored-key");
    process.env[GEMINI_API_KEY_ENV_VAR] = "  env-key  ";

    // Env wins (trimmed), stored value is ignored while env is present.
    expect(await resolveGeminiApiKey(apiKeysPath)).toBe("env-key");
    expect(await hasGeminiApiKey(apiKeysPath)).toBe(true);

    // The env value is never written back: the file still holds only the stored key.
    const onDisk = JSON.parse(await readFile(apiKeysPath, "utf8")) as { keys: Record<string, string> };
    expect(JSON.stringify(onDisk)).not.toContain("env-key");
  });

  it("uses the stored value when no environment variable is set", async () => {
    await writeGeminiApiKey(apiKeysPath, "stored-key");
    expect(await resolveGeminiApiKey(apiKeysPath)).toBe("stored-key");
    expect(await hasGeminiApiKey(apiKeysPath)).toBe(true);
  });

  it("returns null when neither an env nor a stored key is present", async () => {
    expect(await resolveGeminiApiKey(apiKeysPath)).toBeNull();
    expect(await hasGeminiApiKey(apiKeysPath)).toBe(false);
  });

  it("writes the key to api-keys.json (0600), obfuscated, and not into settings.json", async () => {
    await writeGeminiApiKey(apiKeysPath, "AIzaSecretKey123");

    // The secret lives in its own api-keys.json, not the shared settings store.
    expect(apiKeysPath.endsWith("api-keys.json")).toBe(true);
    const stored = await readFile(apiKeysPath, "utf8");
    // Obfuscated at rest: the raw key never appears verbatim in the file.
    expect(stored).not.toContain("AIzaSecretKey123");

    // POSIX: the file is owner-read/write only.
    if (process.platform !== "win32") {
      const fileStat = await stat(apiKeysPath);
      expect(fileStat.mode & 0o777).toBe(0o600);
    }

    // The settings store is a separate file and is never touched by key writes.
    await expect(readFile(settingsPath, "utf8")).rejects.toThrow();
  });

  it("clears the stored key while leaving any env key in effect", async () => {
    await writeGeminiApiKey(apiKeysPath, "stored-key");
    expect(await resolveGeminiApiKey(apiKeysPath)).toBe("stored-key");

    await clearGeminiApiKey(apiKeysPath);
    expect(await resolveGeminiApiKey(apiKeysPath)).toBeNull();
    expect(await hasGeminiApiKey(apiKeysPath)).toBe(false);

    // An env key still resolves after the stored one is cleared.
    process.env[GEMINI_API_KEY_ENV_VAR] = "env-key";
    expect(await resolveGeminiApiKey(apiKeysPath)).toBe("env-key");
  });

  it("warns and tightens an insecure (group/world-readable) key file on read", async () => {
    if (process.platform === "win32") {
      return; // POSIX-only permission model.
    }
    await writeGeminiApiKey(apiKeysPath, "stored-key");
    // Loosen the mode behind the store's back, as a careless copy/edit might.
    await chmod(apiKeysPath, 0o644);

    const warn = vi.fn();
    expect(await resolveGeminiApiKey(apiKeysPath, warn)).toBe("stored-key");

    // The read warned once and tightened the file back to 0600 rather than refusing.
    expect(warn).toHaveBeenCalledTimes(1);
    const fileStat = await stat(apiKeysPath);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("treats a wrong-shaped but valid-JSON key file as empty", async () => {
    // Valid JSON that is not the { keys: {...} } shape is tolerated as "no key"
    // rather than crashing — the file is rebuildable by re-entering the key.
    await writeFile(apiKeysPath, JSON.stringify({ unexpected: true }), "utf8");
    expect(await resolveGeminiApiKey(apiKeysPath)).toBeNull();
  });

  it("surfaces a corrupt (unparseable) key file rather than silently dropping it", async () => {
    // Truly malformed content is not silently treated as empty: that would mask
    // corruption and could discard a recoverable key. The read error propagates.
    await writeFile(apiKeysPath, "not json at all", "utf8");
    await expect(resolveGeminiApiKey(apiKeysPath)).rejects.toThrow();
  });
});
