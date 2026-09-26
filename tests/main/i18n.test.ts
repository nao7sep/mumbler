import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
const defaults = vi.hoisted(() => ({ appleLanguages: null as string[] | null }));

vi.mock("electron", () => ({
  app: {
    getPreferredSystemLanguages: () => {
      calls.push("read");
      // An entry in the app's own domain shadows the computer's list.
      return defaults.appleLanguages ?? ["de-DE", "en-US"];
    },
    getSystemLocale: () => "de-DE",
  },
  systemPreferences: {
    removeUserDefault: (key: string) => {
      calls.push(`remove ${key}`);
      defaults.appleLanguages = null;
    },
    setUserDefault: (key: string, type: string, value: string[]) => {
      calls.push(`set ${key} ${type} ${value.join(",")}`);
      defaults.appleLanguages = value;
    },
  },
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  vi.resetModules();
  calls.length = 0;
  defaults.appleLanguages = ["ja"]; // written by a previous launch
  Object.defineProperty(process, "platform", { value: "darwin" });
  return () => Object.defineProperty(process, "platform", platform);
});

describe("AppKit's language on macOS", () => {
  it("clears its own entry before reading the computer's languages, then writes the chosen tag", async () => {
    const { alignAppKit, resolveInterfaceLanguage } = await import("@main/i18n");
    expect(resolveInterfaceLanguage("system")).toEqual({ language: "de", locale: "de-DE" });
    alignAppKit("ja", vi.fn());
    expect(calls).toEqual(["remove AppleLanguages", "read", "set AppleLanguages array ja"]);
  });

  it("removes the entry for System, so the computer's list applies again", async () => {
    const { alignAppKit } = await import("@main/i18n");
    alignAppKit("system", vi.fn());
    expect(calls).toEqual(["remove AppleLanguages", "read", "remove AppleLanguages"]);
    expect(defaults.appleLanguages).toBeNull();
  });

  it("writes nothing on other platforms", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const { alignAppKit } = await import("@main/i18n");
    alignAppKit("ja", vi.fn());
    expect(calls.filter((call) => call !== "read")).toEqual([]);
  });
});
