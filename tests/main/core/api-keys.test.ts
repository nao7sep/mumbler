import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiKeyEnvVar, clearApiKey, hasApiKey, resolveApiKey, writeApiKey } from "@main/core/api-keys";

// The secrets store is isolated by pointing MUMBLER_HOME at a throwaway directory
// (storage-path-conventions: tests relocate the root via the env override) and
// resolving the api-keys path under it exactly as the app does. The whole tree is
// removed after each test.
const GEMINI = apiKeyEnvVar(["gemini"]); // "GEMINI_API_KEY"

let home: string;
let apiKeysPath: string;
let settingsPath: string;

function clearGeminiEnv(): void {
  for (const name of Object.keys(process.env)) {
    if (/^GEMINI.*_API_KEY$/.test(name)) delete process.env[name];
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mumbler-secrets-"));
  process.env.MUMBLER_HOME = home;
  apiKeysPath = join(home, "api-keys.json");
  settingsPath = join(home, "settings.json");
  clearGeminiEnv();
});

afterEach(async () => {
  delete process.env.MUMBLER_HOME;
  clearGeminiEnv();
  await rm(home, { recursive: true, force: true });
});

describe("API key secrets store", () => {
  // First, so the once-per-process insecure-mode warning is observable before any
  // other test reads a group/world-readable file.
  it("warns once and tightens an insecure (group/world-readable) key file on read", async () => {
    if (process.platform === "win32") {
      return; // POSIX-only permission model.
    }
    await writeApiKey(apiKeysPath, ["gemini"], "stored-key");
    await chmod(apiKeysPath, 0o644);

    const warn = vi.fn();
    expect(await resolveApiKey(apiKeysPath, ["gemini"], undefined, warn)).toBe("stored-key");

    expect(warn).toHaveBeenCalledTimes(1);
    const fileStat = await stat(apiKeysPath);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("prefers the environment value over the stored value and never persists it", async () => {
    await writeApiKey(apiKeysPath, ["gemini"], "stored-key");
    process.env[GEMINI] = "  env-key  ";

    // Env wins (trimmed); the stored value is ignored while env is present.
    expect(await resolveApiKey(apiKeysPath, ["gemini"])).toBe("env-key");
    expect(await hasApiKey(apiKeysPath, ["gemini"])).toBe(true);

    // The env value is never written back: the file still holds only the stored key.
    const onDisk = await readFile(apiKeysPath, "utf8");
    expect(onDisk).not.toContain("env-key");
  });

  it("uses the stored value when no environment variable is set", async () => {
    await writeApiKey(apiKeysPath, ["gemini"], "stored-key");
    expect(await resolveApiKey(apiKeysPath, ["gemini"])).toBe("stored-key");
    expect(await hasApiKey(apiKeysPath, ["gemini"])).toBe(true);
  });

  it("returns null when neither an env nor a stored key is present", async () => {
    expect(await resolveApiKey(apiKeysPath, ["gemini"])).toBeNull();
    expect(await hasApiKey(apiKeysPath, ["gemini"])).toBe(false);
  });

  it("writes the key obfuscated to a 0600 api-keys.json, under its segment id, not into settings", async () => {
    await writeApiKey(apiKeysPath, ["gemini"], "AIzaSecretKey123");

    const stored = await readFile(apiKeysPath, "utf8");
    expect(stored).not.toContain("AIzaSecretKey123"); // obfuscated at rest
    expect(JSON.parse(stored)).toHaveProperty(["keys", "gemini"]);

    if (process.platform !== "win32") {
      const fileStat = await stat(apiKeysPath);
      expect(fileStat.mode & 0o777).toBe(0o600);
    }

    // The settings store is a separate file and is never touched by key writes.
    await expect(readFile(settingsPath, "utf8")).rejects.toThrow();
  });

  it("clears the stored key while leaving any env key in effect", async () => {
    await writeApiKey(apiKeysPath, ["gemini"], "stored-key");
    expect(await resolveApiKey(apiKeysPath, ["gemini"])).toBe("stored-key");

    await clearApiKey(apiKeysPath, ["gemini"]);
    expect(await resolveApiKey(apiKeysPath, ["gemini"])).toBeNull();

    process.env[GEMINI] = "env-key";
    expect(await resolveApiKey(apiKeysPath, ["gemini"])).toBe("env-key");
  });

  it("treats an untagged stored value as plaintext (a hand-pasted key)", async () => {
    await writeFile(apiKeysPath, JSON.stringify({ keys: { gemini: "sk-plain-pasted" } }), "utf8");
    expect(await resolveApiKey(apiKeysPath, ["gemini"])).toBe("sk-plain-pasted");
  });

  it("matches stored key ids case-insensitively", async () => {
    await writeFile(apiKeysPath, JSON.stringify({ keys: { Gemini: "case-key" } }), "utf8");
    expect(await resolveApiKey(apiKeysPath, ["gemini"])).toBe("case-key");
  });

  it("trims values and treats a blank env as unset, falling through to the stored key", async () => {
    await writeApiKey(apiKeysPath, ["gemini"], "stored-key");

    process.env[GEMINI] = "   ";
    expect(await resolveApiKey(apiKeysPath, ["gemini"])).toBe("stored-key");

    process.env[GEMINI] = "  env-key  ";
    expect(await resolveApiKey(apiKeysPath, ["gemini"])).toBe("env-key");
  });

  it("resolves source-first with most-to-least-specific fallback", async () => {
    await writeApiKey(apiKeysPath, ["gemini"], "general-stored");
    await writeApiKey(apiKeysPath, ["gemini", "text"], "text-stored");

    // A more specific stored key beats the general stored key.
    expect(await resolveApiKey(apiKeysPath, ["gemini", "text"])).toBe("text-stored");
    // An unconfigured specific key falls back to the general stored key.
    expect(await resolveApiKey(apiKeysPath, ["gemini", "other"])).toBe("general-stored");

    // Source-first: the general env beats even a more specific stored key.
    process.env[GEMINI] = "general-env";
    expect(await resolveApiKey(apiKeysPath, ["gemini", "text"])).toBe("general-env");
    delete process.env[GEMINI];

    // fallback:false consults only the exact key.
    expect(await resolveApiKey(apiKeysPath, ["gemini", "missing"], { fallback: false })).toBeNull();
    expect(await resolveApiKey(apiKeysPath, ["gemini", "text"], { fallback: false })).toBe("text-stored");
  });

  it("treats a wrong-shaped but valid-JSON key file as empty", async () => {
    await writeFile(apiKeysPath, JSON.stringify({ unexpected: true }), "utf8");
    expect(await resolveApiKey(apiKeysPath, ["gemini"])).toBeNull();
  });

  it("moves a corrupt (unparseable) key file aside and resolves to no key instead of throwing", async () => {
    await writeFile(apiKeysPath, "not json at all", "utf8");

    const warn = vi.fn();
    await expect(resolveApiKey(apiKeysPath, ["gemini"], undefined, warn)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();

    // The unreadable file is preserved aside (timestamped), not left in place to be
    // re-flagged on every read, and not deleted silently.
    const entries = await readdir(home);
    expect(entries.some((e) => e.startsWith("api-keys.json.corrupt-"))).toBe(true);
    expect(entries).not.toContain("api-keys.json");
  });
});
