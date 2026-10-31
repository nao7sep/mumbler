import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settingsWrite = vi.hoisted(() => ({
  held: null as { path: string; release: Promise<void>; entered: number } | null,
  refused: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const held = settingsWrite.held;
      if (held !== null && held.path === String(args[1])) {
        held.entered += 1;
        await held.release;
        if (settingsWrite.refused) throw new Error("settings publication refused");
      }
      return actual.rename(...args);
    },
  };
});

import type { MumblerSettings } from "@shared/app-shell";
import { NewerFormatError } from "@main/core/format-versions";
import { CorruptStateError } from "@main/core/json-store";
import {
  buildSettingsDraft,
  createDefaultSettings,
  createSettingsStore,
} from "@main/core/settings-schema";
import { until } from "../../support/until";
import { header } from "../../support/file-header";

let dir: string;

beforeEach(async () => {
  settingsWrite.held = null;
  settingsWrite.refused = false;
  dir = await mkdtemp(join(tmpdir(), "mumbler-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function settings(patch: Partial<MumblerSettings> = {}): MumblerSettings {
  return { ...createDefaultSettings(), ...patch };
}

function settingsPath(): string {
  return join(dir, "config.json");
}

describe("settings store", () => {
  it("reads every absent set as its built-in when the file holds only one set", async () => {
    const raw = JSON.stringify({ ...header("config"), concurrencyLimit: 5 });
    await writeFile(settingsPath(), raw, "utf8");
    const store = createSettingsStore(settingsPath());

    expect((await store.load()).value).toEqual({ ...createDefaultSettings(), concurrencyLimit: 5 });
    expect(await readFile(settingsPath(), "utf8")).toBe(raw);
  });

  it("keeps a fresh install without a file when every set saved equals its built-in", async () => {
    const store = createSettingsStore(settingsPath());
    await store.save(createDefaultSettings());

    await expect(readFile(settingsPath(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.load()).value).toEqual(createDefaultSettings());
  });

  it("keeps the file when its final set is saved equal to its built-in, with only its format version", async () => {
    await writeFile(settingsPath(), JSON.stringify({ ...header("config"), concurrencyLimit: 5 }));
    const store = createSettingsStore(settingsPath());
    await store.load();
    await store.save(createDefaultSettings());

    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ ...header("config") });
    expect((await store.load()).value).toEqual(createDefaultSettings());
  });

  it("removes a set's key when it changes back to its built-in and keeps the others", async () => {
    const store = createSettingsStore(settingsPath());
    await store.save(settings({ concurrencyLimit: 5, theme: "dark" }));
    await store.save(settings({ theme: "dark" }));
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ ...header("config"), theme: "dark" });
  });

  it("compares a model id with its built-in trimmed and case-insensitively", async () => {
    const store = createSettingsStore(settingsPath());
    await store.save(settings({ "gemini.outline": "custom-model" }));
    await store.save(settings({ "gemini.outline": ` ${createDefaultSettings()["gemini.outline"].toUpperCase()} ` }));
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ ...header("config") });
  });

  it("stores a role's thinking only while it differs from the default for the role's model", async () => {
    const store = createSettingsStore(settingsPath());
    const defaults = createDefaultSettings();
    await store.save({ ...defaults, "gemini.metadata": "gemini-3.8-flash", "gemini.thinking.metadata": "medium", "gemini.thinking.outline": "high" });
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ ...header("config"), "gemini.metadata": "gemini-3.8-flash", "gemini.thinking.outline": "high" });

    // The default follows the model's tier, not the role's: a fast model on the balanced role starts at minimal.
    await store.save({ ...defaults, "gemini.outline": "gemini-3.5-flash-lite", "gemini.thinking.outline": "minimal" });
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ ...header("config"), "gemini.outline": "gemini-3.5-flash-lite" });

    // Under a model with no row the choice is kept, unsent, while it differs from the built-in.
    await store.save({ ...defaults, "gemini.outline": "custom-model", "gemini.thinking.outline": "high" });
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ ...header("config"), "gemini.outline": "custom-model", "gemini.thinking.outline": "high" });
    await store.save({ ...defaults, "gemini.outline": "custom-model" });
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ ...header("config"), "gemini.outline": "custom-model" });
  });

  it("keeps a thinking saved under a model with no row through a relaunch, in the settings and the draft", async () => {
    await createSettingsStore(settingsPath()).save(settings({ "gemini.metadata": "custom-model", "gemini.thinking.metadata": "high" }));
    const loaded = (await createSettingsStore(settingsPath()).load()).value;
    expect(loaded).toEqual(settings({ "gemini.metadata": "custom-model", "gemini.thinking.metadata": "high" }));
    expect(buildSettingsDraft(loaded, "", "", false)).toMatchObject({ metadataModel: "custom-model", metadataThinking: "high" });
  });

  it("reads a thinking the file does not hold as the selected model's own default after a relaunch", async () => {
    // The outline's built-in model is Flash (medium); Flash Lite's own default is minimal, so it is not stored.
    await createSettingsStore(settingsPath()).save(settings({ "gemini.outline": "gemini-3.5-flash-lite", "gemini.thinking.outline": "minimal" }));
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ ...header("config"), "gemini.outline": "gemini-3.5-flash-lite" });
    const loaded = (await createSettingsStore(settingsPath()).load()).value;
    expect(loaded["gemini.thinking.outline"]).toBe("minimal");
    expect(buildSettingsDraft(loaded, "", "", false)).toMatchObject({ outlineModel: "gemini-3.5-flash-lite", outlineThinking: "minimal" });
  });

  it("writes nothing when the file already holds what the settings store", async () => {
    const raw = `${JSON.stringify({ ...header("config"), concurrencyLimit: 5 }, null, 2)}\n`;
    await writeFile(settingsPath(), raw, "utf8");
    const earlier = new Date(Date.UTC(2024, 4, 6, 7, 8, 9));
    await utimes(settingsPath(), earlier, earlier);
    const store = createSettingsStore(settingsPath());
    await store.load();
    await store.save(settings({ concurrencyLimit: 5 }));
    expect(await readFile(settingsPath(), "utf8")).toBe(raw);
    expect((await stat(settingsPath())).mtime.getTime()).toBe(earlier.getTime());
  });

  it("loads no file without seeding and writes just one changed set", async () => {
    const store = createSettingsStore(settingsPath());
    expect((await store.load()).value).toEqual(createDefaultSettings());
    await expect(readFile(settingsPath(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await store.save(settings({ concurrencyLimit: 5 }));
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ ...header("config"), concurrencyLimit: 5 });
    expect((await store.load()).value).toEqual(settings({ concurrencyLimit: 5 }));
  });

  it("keeps keys this build does not know through every save, as a newer Mumbler wrote them", async () => {
    const future = { added: { by: "a newer Mumbler" }, dictionary: ["mumbler"] };
    await writeFile(settingsPath(), JSON.stringify({ ...header("config"), theme: "dark", ...future }));
    const store = createSettingsStore(settingsPath());
    const loaded = await store.load();
    expect(loaded.value).toEqual(settings({ theme: "dark" }));
    expect(loaded.unusable).toEqual([]);
    await store.save({ ...loaded.value, concurrencyLimit: 5 });
    await store.save({ ...loaded.value, concurrencyLimit: 6 }, { replaceUnusable: true });
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ ...header("config"), theme: "dark", concurrencyLimit: 6, ...future });
  });

  it.each([false, true])("preserves unknown own keys named like object properties during a settings save (%s)", async (replaceUnusable) => {
    // JSON.parse creates an own __proto__ property, unlike an object literal.
    const future = JSON.parse('{"__proto__":{"by":"a newer Mumbler"},"constructor":"future constructor","toString":["future text"]}') as Record<string, unknown>;
    await writeFile(settingsPath(), JSON.stringify({ ...header("config"), theme: "dark", ...future }));
    const store = createSettingsStore(settingsPath());
    const loaded = await store.load();
    expect(loaded.value).toEqual(settings({ theme: "dark" }));
    expect(loaded.unusable).toEqual([]);

    await store.save({ ...loaded.value, concurrencyLimit: 5 }, { replaceUnusable });
    const saved = JSON.parse(await readFile(settingsPath(), "utf8")) as Record<string, unknown>;
    for (const key of Object.keys(future)) {
      expect(Object.hasOwn(saved, key), `${key} remains an own set`).toBe(true);
      expect(saved[key]).toEqual(future[key]);
    }
    expect((await createSettingsStore(settingsPath()).load()).value).toEqual(settings({ theme: "dark", concurrencyLimit: 5 }));
  });

  it("builds the file from the settings it is given, not onto the stored bytes, one save after another", async () => {
    const store = createSettingsStore(settingsPath());
    await store.load();
    await writeFile(settingsPath(), JSON.stringify({ ...header("config"), theme: "dark" }));
    await Promise.all([store.save(settings({ concurrencyLimit: 5 })), store.save(settings({ skipIntervalSec: 20 }))]);
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ ...header("config"), skipIntervalSec: 20 });
  });

  it("keeps a System or chosen zone for both zone settings, and cannot use anything else", async () => {
    await writeFile(settingsPath(), JSON.stringify({ ...header("config"), defaultTimezone: "system", displayTimezone: "Asia/Tokyo" }));
    const kept = await createSettingsStore(settingsPath(), dir, () => undefined).load();
    expect(kept.unusable).toEqual([]);
    expect(kept.value).toMatchObject({ defaultTimezone: "system", displayTimezone: "Asia/Tokyo" });

    await writeFile(settingsPath(), JSON.stringify({ ...header("config"), defaultTimezone: "Mars/Olympus", displayTimezone: "Moon/Tranquility" }));
    const unusable = await createSettingsStore(settingsPath(), dir, () => undefined).load();
    expect(unusable.unusable).toEqual(["defaultTimezone", "displayTimezone"]);
  });

  it("uses the built-in for a set it cannot use, names it, keeps it through other saves and replaces it at a Settings save", async () => {
    const warnings: string[] = [];
    await writeFile(settingsPath(), JSON.stringify({
      ...header("config"),
      prompts: { structured: "custom" },
      skipIntervalSec: 0,
      previewSnippetSeconds: "ten",
      theme: "sepia",
    }));
    const store = createSettingsStore(settingsPath(), dir, (key) => warnings.push(key));
    const { value: loaded, unusable } = await store.load();
    expect(loaded).toEqual(createDefaultSettings());
    expect(warnings).toEqual(["theme", "skipIntervalSec", "previewSnippetSeconds", "prompts"]);
    expect(unusable).toEqual(["prompts", "skipIntervalSec", "previewSnippetSeconds", "theme"]);

    // A save that does not come from the Settings window keeps them as written.
    await store.save({ ...loaded, concurrencyLimit: 5 });
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({
      ...header("config"),
      concurrencyLimit: 5,
      prompts: { structured: "custom" },
      skipIntervalSec: 0,
      previewSnippetSeconds: "ten",
      theme: "sepia",
    });

    // Saving the Settings window, which showed the built-ins, replaces them.
    await store.save({ ...loaded, concurrencyLimit: 5 }, { replaceUnusable: true });
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ ...header("config"), concurrencyLimit: 5 });
    await store.save({ ...loaded, concurrencyLimit: 6 });
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ ...header("config"), concurrencyLimit: 6 });
  });

  it("keeps unusable-set replacement authoritative for a targeted save queued during its primary write", async () => {
    const future = JSON.parse('{"__proto__":{"keep":"future own key"}}') as Record<string, unknown>;
    await writeFile(settingsPath(), JSON.stringify({ ...header("config"), prompts: { structured: "custom" }, ...future }));
    const store = createSettingsStore(settingsPath(), dir, () => undefined);
    const { value } = await store.load();
    let release!: () => void;
    settingsWrite.held = { path: settingsPath(), release: new Promise((resolve) => { release = resolve; }), entered: 0 };
    const replacement = store.save({ ...value, theme: "dark" }, { replaceUnusable: true });
    let targeted: Promise<void> | undefined;
    try {
      await until(() => expect(settingsWrite.held?.entered).toBe(1));
      targeted = store.save({ ...value, theme: "dark", checkUpdatesAtLaunch: false });
      release();
      await Promise.all([replacement, targeted]);
      expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({
        ...header("config"), theme: "dark", checkUpdatesAtLaunch: false, ...future,
      });
      expect((await store.load()).unusable).toEqual([]);
    } finally {
      release();
      await Promise.allSettled([replacement, ...(targeted ? [targeted] : [])]);
      settingsWrite.held = null;
    }
  });

  it("publishes replacement metadata when failed settings bytes are retried before a targeted save", async () => {
    await writeFile(settingsPath(), JSON.stringify({ ...header("config"), prompts: { structured: "custom" } }));
    const store = createSettingsStore(settingsPath(), dir, () => undefined);
    const { value } = await store.load();
    let release!: () => void;
    settingsWrite.held = { path: settingsPath(), release: new Promise((resolve) => { release = resolve; }), entered: 0 };
    settingsWrite.refused = true;
    const replacement = store.save({ ...value, theme: "dark" }, { replaceUnusable: true }).then(() => "saved", () => "failed");
    try {
      await until(() => expect(settingsWrite.held?.entered).toBe(1));
      release();
      expect(await replacement).toBe("failed");
      expect(store.failedWrite).not.toBeNull();
      settingsWrite.refused = false;
      await store.retryFailedWrite();
      expect(store.failedWrite).toBeNull();
      await store.save({ ...value, theme: "dark", checkUpdatesAtLaunch: false });
      expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ ...header("config"), theme: "dark", checkUpdatesAtLaunch: false });
    } finally {
      release();
      await replacement;
      settingsWrite.held = null;
    }
  });

  it("commits acknowledged built-ins instead of leaving a rejected first save eligible for retry", async () => {
    const store = createSettingsStore(settingsPath(), dir);
    await store.load();
    settingsWrite.held = { path: settingsPath(), release: Promise.resolve(), entered: 0 };
    settingsWrite.refused = true;
    await expect(store.save(settings({ theme: "dark" }))).rejects.toThrow("settings publication refused");
    expect(store.failedWrite).not.toBeNull();
    settingsWrite.refused = false;

    await store.save(settings());

    expect(store.failedWrite).toBeNull();
    await store.retryFailedWrite();
    expect(JSON.parse(await readFile(settingsPath(), "utf8"))).toEqual({ ...header("config") });
  });

  it.each([
    ["timestampPatterns", []],
    ["timestampPatterns", "(?<year>\\d{4})"],
    ["timestampPatterns", ["(?<year>"]],
    ["gemini.endpoint", "ftp://example.test"],
    ["gemini.endpoint", "https://user:secret@example.test"],
    ["gemini.outline", "  "],
    ["concurrencyLimit", 17],
    ["prompts", { structured: "No placeholder", title: "{transcript}", slug: "{title}" }],
    ["prompts", { structured: "{transcript}", title: "No placeholder", slug: "{title}" }],
    ["prompts", { structured: "{transcript}", title: "{structured}", slug: "No placeholder" }],
  ])("reads %s %j, which Save refuses, as its built-in", async (key, value) => {
    const warnings: string[] = [];
    await writeFile(settingsPath(), JSON.stringify({ ...header("config"), [key]: value }));
    expect((await createSettingsStore(settingsPath(), dir, (warned) => warnings.push(warned)).load()).value).toEqual(createDefaultSettings());
    expect(warnings).toEqual([key]);
  });

  it("keeps complete clusters without filling members from built-ins", async () => {
    const prompts = { structured: "{transcript}", title: "{structured}", slug: "{title}", extra: "kept" };
    await writeFile(settingsPath(), JSON.stringify({ ...header("config"), prompts }));
    expect((await createSettingsStore(settingsPath()).load()).value.prompts).toEqual(prompts);
  });

  it("refuses a config.json without its format version as unreadable, and leaves it untouched", async () => {
    const unmarked = JSON.stringify({ theme: "dark" });
    await writeFile(settingsPath(), unmarked, "utf8");
    await expect(createSettingsStore(settingsPath()).load()).rejects.toBeInstanceOf(CorruptStateError);
    expect(await readFile(settingsPath(), "utf8")).toBe(unmarked);
  });

  it("refuses a config.json in a newer format on load and leaves it untouched", async () => {
    const newer = JSON.stringify({ ...header("config", 2), theme: "dark" });
    await writeFile(settingsPath(), newer, "utf8");
    const store = createSettingsStore(settingsPath());
    await expect(store.load()).rejects.toBeInstanceOf(NewerFormatError);
    expect(await readFile(settingsPath(), "utf8")).toBe(newer);
  });

  it("normalizes out-of-range settings values on load", async () => {
    await writeFile(
      settingsPath(),
      JSON.stringify({ ...header("config"), concurrencyLimit: -5, skipIntervalSec: "nope" }),
      "utf8",
    );
    const { value } = await createSettingsStore(settingsPath()).load();
    expect(value.concurrencyLimit).toBeGreaterThan(0);
    expect(value.skipIntervalSec).toBeGreaterThan(0);
  });

  it("defaults the theme to System and keeps a saved Light or Dark", async () => {
    await writeFile(settingsPath(), JSON.stringify({ ...header("config") }), "utf8");
    expect((await createSettingsStore(settingsPath()).load()).value.theme).toBe("system");

    await writeFile(settingsPath(), JSON.stringify({ ...header("config"), theme: "dark" }), "utf8");
    expect((await createSettingsStore(settingsPath()).load()).value.theme).toBe("dark");

    await writeFile(settingsPath(), JSON.stringify({ ...header("config"), theme: "sepia" }), "utf8");
    expect((await createSettingsStore(settingsPath()).load()).value.theme).toBe("system");
  });

  it("defaults the launch update check on when absent, and preserves an explicit off", async () => {
    await writeFile(settingsPath(), JSON.stringify({ ...header("config") }), "utf8");
    expect((await createSettingsStore(settingsPath()).load()).value.checkUpdatesAtLaunch).toBe(true);

    await writeFile(
      settingsPath(),
      JSON.stringify({ ...header("config"), checkUpdatesAtLaunch: false }),
      "utf8",
    );
    expect((await createSettingsStore(settingsPath()).load()).value.checkUpdatesAtLaunch).toBe(false);
  });

  it("resolves hand-edited configured paths against HOME rather than cwd", async () => {
    const home = join(dir, "home");
    await writeFile(
      settingsPath(),
      JSON.stringify({
        ...header("config"),
        outputDirectory: "~/output",
        backupDirectory: "relative/backups",
      }),
      "utf8",
    );
    const settings = (await createSettingsStore(settingsPath(), home).load()).value;
    expect(settings.outputDirectory).toBe(join(home, "output"));
    expect(settings.backupDirectory).toBe(join(home, "relative", "backups"));
  });
});
