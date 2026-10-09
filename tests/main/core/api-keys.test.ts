import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiKeyEnvVar, clearApiKey, hasApiKey, resolveApiKey, writeApiKey } from "@main/core/api-keys";
import { closeBackupStore } from "@main/core/backupStore";
import * as fileIo from "@main/core/file-io";
import { NewerFormatError } from "@main/core/format-versions";

// The secrets store is isolated by pointing MUMBLER_DATA_DIR at a throwaway directory
// (storage-path-conventions: tests relocate the root via the env override) and
// resolving the api-keys path under it exactly as the app does. The whole tree is
// removed after each test.
const GEMINI = apiKeyEnvVar("gemini"); // "GEMINI_API_KEY"

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
  process.env.MUMBLER_DATA_DIR = home;
  apiKeysPath = join(home, "api-keys.json");
  settingsPath = join(home, "config.json");
  clearGeminiEnv();
});

afterEach(async () => {
  delete process.env.MUMBLER_DATA_DIR;
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
    await writeApiKey(apiKeysPath, "gemini", "stored-key");
    await chmod(apiKeysPath, 0o644);

    const warn = vi.fn();
    expect(await resolveApiKey(apiKeysPath, "gemini", warn)).toBe("stored-key");

    expect(warn).toHaveBeenCalledTimes(1);
    const fileStat = await stat(apiKeysPath);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("re-tightens a key file that is widened again on a second access in the same session", async () => {
    if (process.platform === "win32") {
      return; // POSIX-only permission model.
    }
    await writeApiKey(apiKeysPath, "gemini", "stored-key");
    const warn = vi.fn();

    // First access: widen, then read. Tightened back to 0600 regardless of
    // whether the once-per-session warning has already fired in an earlier test.
    await chmod(apiKeysPath, 0o644);
    expect(await resolveApiKey(apiKeysPath, "gemini", warn)).toBe("stored-key");
    expect((await stat(apiKeysPath)).mode & 0o777).toBe(0o600);

    // Second access, widened again: the tightening itself must never be gated
    // behind the warning having already been emitted once this session.
    await chmod(apiKeysPath, 0o644);
    expect(await resolveApiKey(apiKeysPath, "gemini", warn)).toBe("stored-key");
    expect((await stat(apiKeysPath)).mode & 0o777).toBe(0o600);
  });

  it("prefers the environment value over the stored value and never persists it", async () => {
    await writeApiKey(apiKeysPath, "gemini", "stored-key");
    process.env[GEMINI] = "  env-key  ";

    // Env wins (trimmed); the stored value is ignored while env is present.
    expect(await resolveApiKey(apiKeysPath, "gemini")).toBe("env-key");
    expect(await hasApiKey(apiKeysPath, "gemini")).toBe(true);

    // The env value is never written back: the file still holds only the stored key.
    const onDisk = await readFile(apiKeysPath, "utf8");
    expect(onDisk).not.toContain("env-key");
  });

  it("uses the stored value when no environment variable is set", async () => {
    await writeApiKey(apiKeysPath, "gemini", "stored-key");
    expect(await resolveApiKey(apiKeysPath, "gemini")).toBe("stored-key");
    expect(await hasApiKey(apiKeysPath, "gemini")).toBe(true);
  });

  it("returns null when neither an env nor a stored key is present", async () => {
    expect(await resolveApiKey(apiKeysPath, "gemini")).toBeNull();
    expect(await hasApiKey(apiKeysPath, "gemini")).toBe(false);
  });

  it("writes the key obfuscated to a 0600 api-keys.json, under its id, not into settings", async () => {
    await writeApiKey(apiKeysPath, "gemini", "AIzaSecretKey123");

    const stored = await readFile(apiKeysPath, "utf8");
    expect(stored).not.toContain("AIzaSecretKey123"); // obfuscated at rest
    expect(JSON.parse(stored)).toHaveProperty(["keys", "gemini"]);
    expect(JSON.parse(stored).formatVersion).toBe(1);

    if (process.platform !== "win32") {
      const fileStat = await stat(apiKeysPath);
      expect(fileStat.mode & 0o777).toBe(0o600);
    }

    // The settings store is a separate file and is never touched by key writes.
    await expect(readFile(settingsPath, "utf8")).rejects.toThrow();
  });

  it("never records the secret into the backup store (record:false on the choke point)", async () => {
    // MUMBLER_DATA_DIR is `home` here, so the store — if it recorded — would create home/backups.sqlite3.
    await writeApiKey(apiKeysPath, "gemini", "AIzaSecretKey123");
    await writeApiKey(apiKeysPath, "gemini", "AIzaSecretKey999"); // a second, changed write
    await closeBackupStore();

    // The secret write path opts out of recording, so NO backup store file exists — the credential never
    // lands in a history that would otherwise become sensitive-at-rest (data-backup conventions).
    expect(await readdir(home)).not.toContain("backups.sqlite3");
  });

  it("clears the stored key while leaving any env key in effect", async () => {
    await writeApiKey(apiKeysPath, "gemini", "stored-key");
    expect(await resolveApiKey(apiKeysPath, "gemini")).toBe("stored-key");

    await clearApiKey(apiKeysPath, "gemini");
    expect(await resolveApiKey(apiKeysPath, "gemini")).toBeNull();

    process.env[GEMINI] = "env-key";
    expect(await resolveApiKey(apiKeysPath, "gemini")).toBe("env-key");
  });

  it("treats an untagged stored value as plaintext (a hand-pasted key)", async () => {
    await writeFile(apiKeysPath, JSON.stringify({ formatVersion: 1, keys: { gemini: "sk-plain-pasted" } }), "utf8");
    expect(await resolveApiKey(apiKeysPath, "gemini")).toBe("sk-plain-pasted");
  });

  it("round-trips a validly encoded obf: value", async () => {
    await writeApiKey(apiKeysPath, "gemini", "AIzaValidRoundTripKey123");
    expect(await resolveApiKey(apiKeysPath, "gemini")).toBe("AIzaValidRoundTripKey123");
  });

  it("treats a malformed obf: value as absent and warns naming the key id, rather than decoding it to garbage", async () => {
    // Node's base64 decoder silently drops characters outside the alphabet
    // instead of rejecting them; "!" and the wrong length both make this payload
    // non-canonical base64, so it must never reach a provider as a "decoded" key.
    await writeFile(
      apiKeysPath,
      JSON.stringify({ formatVersion: 1, keys: { gemini: "obf:not-valid-base64!!" } }),
      "utf8",
    );

    const warn = vi.fn();
    expect(await resolveApiKey(apiKeysPath, "gemini", warn)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("gemini"),
      expect.objectContaining({ keyId: "gemini" }),
    );
  });

  it("matches stored key ids case-insensitively", async () => {
    await writeFile(apiKeysPath, JSON.stringify({ formatVersion: 1, keys: { Gemini: "case-key" } }), "utf8");
    expect(await resolveApiKey(apiKeysPath, "gemini")).toBe("case-key");
  });

  it("trims values and treats a blank env as unset, falling through to the stored key", async () => {
    await writeApiKey(apiKeysPath, "gemini", "stored-key");

    process.env[GEMINI] = "   ";
    expect(await resolveApiKey(apiKeysPath, "gemini")).toBe("stored-key");

    process.env[GEMINI] = "  env-key  ";
    expect(await resolveApiKey(apiKeysPath, "gemini")).toBe("env-key");
  });

  it("resolves a provider.purpose id exactly and never falls back to the provider id", async () => {
    expect(apiKeyEnvVar("gemini.text")).toBe("GEMINI_TEXT_API_KEY");

    await writeApiKey(apiKeysPath, "gemini", "general-stored");
    // No stored or env value for gemini.text: the provider key is never used for it.
    expect(await resolveApiKey(apiKeysPath, "gemini.text")).toBeNull();
    expect(await hasApiKey(apiKeysPath, "gemini.text")).toBe(false);

    await writeApiKey(apiKeysPath, "gemini.text", "text-stored");
    expect(await resolveApiKey(apiKeysPath, "gemini.text")).toBe("text-stored");
    expect(await resolveApiKey(apiKeysPath, "gemini")).toBe("general-stored");

    // The exact derived variable wins; the provider's variable is not consulted.
    process.env.GEMINI_API_KEY = "general-env";
    expect(await resolveApiKey(apiKeysPath, "gemini.text")).toBe("text-stored");
    process.env.GEMINI_TEXT_API_KEY = "text-env";
    expect(await resolveApiKey(apiKeysPath, "gemini.text")).toBe("text-env");
    expect(await resolveApiKey(apiKeysPath, "gemini")).toBe("general-env");
  });

  it("preserves a wrong-shaped valid-JSON key file before rebuilding it", async () => {
    const original = '{"unexpected":{"secret":"hand-authored"}}\n';
    await writeFile(apiKeysPath, original, "utf8");

    const warn = vi.fn();
    await writeApiKey(apiKeysPath, "gemini", "replacement-key", warn);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("unexpected shape"),
      expect.objectContaining({ path: apiKeysPath }),
    );

    const preservedName = (await readdir(home)).find((entry) =>
      /^api-keys-\d{8}-\d{6}-\d{3}-utc\.invalid$/.test(entry),
    );
    expect(preservedName).toBeDefined();
    expect(await readFile(join(home, preservedName!), "utf8")).toBe(original);

    expect(await resolveApiKey(apiKeysPath, "gemini")).toBe("replacement-key");
    expect(await readFile(join(home, preservedName!), "utf8")).toBe(original);
  });

  it("preserves a valid JSON null instead of mistaking it for a missing key file", async () => {
    const original = "null\n";
    await writeFile(apiKeysPath, original, "utf8");

    await writeApiKey(apiKeysPath, "gemini", "replacement-key");

    const preservedName = (await readdir(home)).find((entry) =>
      /^api-keys-\d{8}-\d{6}-\d{3}-utc\.invalid$/.test(entry),
    );
    expect(preservedName).toBeDefined();
    expect(await readFile(join(home, preservedName!), "utf8")).toBe(original);
    expect(await resolveApiKey(apiKeysPath, "gemini")).toBe("replacement-key");
  });

  it("leaves a corrupt (unparseable) key file in place and resolves to no key instead of throwing", async () => {
    await writeFile(apiKeysPath, "not json at all", "utf8");

    const warn = vi.fn();
    await expect(resolveApiKey(apiKeysPath, "gemini", warn)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not valid JSON"), expect.objectContaining({ path: apiKeysPath }));

    // Lookup never moves or rewrites the file: it may still hold the user's key.
    expect(await readFile(apiKeysPath, "utf8")).toBe("not json at all");
    expect(await readdir(home)).toEqual(["api-keys.json"]);
  });

  it("leaves a key file without its format version in place and resolves to no key", async () => {
    const unmarked = JSON.stringify({ keys: { gemini: "hand-pasted" } });
    await writeFile(apiKeysPath, unmarked, "utf8");
    const warn = vi.fn();

    await expect(resolveApiKey(apiKeysPath, "gemini", warn)).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unexpected shape"), expect.objectContaining({ path: apiKeysPath }));
    expect(await readFile(apiKeysPath, "utf8")).toBe(unmarked);
    expect(await readdir(home)).toEqual(["api-keys.json"]);
  });

  it("leaves a key file it cannot read in place, reporting the error code only", async () => {
    await mkdir(apiKeysPath);
    const warn = vi.fn();

    await expect(resolveApiKey(apiKeysPath, "gemini", warn)).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be read"), { path: apiKeysPath, code: "EISDIR" });
    expect((await stat(apiKeysPath)).isDirectory()).toBe(true);
    expect(await readdir(home)).toEqual(["api-keys.json"]);
  });

  it("never quotes the key file's text in a warning", async () => {
    // Truncated JSON whose parse error message would quote the text around the failure.
    await writeFile(apiKeysPath, '{"formatVersion":1,"keys":{"gemini":"AIzaFAKEFRAGMENT-not-a-real-key', "utf8");
    const warn = vi.fn();

    await expect(resolveApiKey(apiKeysPath, "gemini", warn)).resolves.toBeNull();
    await writeApiKey(apiKeysPath, "gemini", "replacement-key", warn);

    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("FAKEFRAGMENT");
  });

  it("sets an unusable key file aside before replacing it, and writes nothing when that fails", async () => {
    const original = '{"formatVersion":1,"keys":"not an object"}';
    await writeFile(apiKeysPath, original, "utf8");
    const spy = vi.spyOn(fileIo, "preserveAside").mockRejectedValueOnce(new Error("rename refused"));
    try {
      await expect(writeApiKey(apiKeysPath, "gemini", "replacement-key")).rejects.toThrow("rename refused");
    } finally { spy.mockRestore(); }
    expect(await readFile(apiKeysPath, "utf8")).toBe(original);
    expect(await readdir(home)).toEqual(["api-keys.json"]);

    // Clearing over it sets it aside and leaves no key file behind.
    await clearApiKey(apiKeysPath, "gemini");
    const entries = await readdir(home);
    expect(entries).not.toContain("api-keys.json");
    const preservedName = entries.find((entry) => /^api-keys-.*\.invalid$/.test(entry));
    expect(await readFile(join(home, preservedName!), "utf8")).toBe(original);
  });

  it("leaves a key file in a newer format in place, reads no key from it, and refuses to write over it", async () => {
    const newer = JSON.stringify({ formatVersion: 2, keys: { gemini: "from-a-newer-build" } });
    await writeFile(apiKeysPath, newer, "utf8");
    if (process.platform !== "win32") await chmod(apiKeysPath, 0o644);
    const warn = vi.fn();

    await expect(resolveApiKey(apiKeysPath, "gemini", warn)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("newer format"), expect.objectContaining({ path: apiKeysPath }));
    await expect(writeApiKey(apiKeysPath, "gemini", "replacement-key", warn)).rejects.toBeInstanceOf(NewerFormatError);
    await expect(clearApiKey(apiKeysPath, "gemini", warn)).rejects.toBeInstanceOf(NewerFormatError);

    expect(await readFile(apiKeysPath, "utf8")).toBe(newer);
    if (process.platform !== "win32") expect((await stat(apiKeysPath)).mode & 0o777).toBe(0o644);
    expect((await readdir(home)).filter((entry) => entry.endsWith(".invalid"))).toEqual([]);
  });
});
