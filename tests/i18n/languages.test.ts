import { describe, expect, it } from "vitest";

import {
  effectiveLanguage,
  formattingLocale,
  normalizeLanguagePreference,
  systemLanguage,
} from "@shared/i18n/languages";

describe("normalizeLanguagePreference", () => {
  it("keeps System and every supported tag", () => {
    expect(normalizeLanguagePreference("system")).toBe("system");
    expect(normalizeLanguagePreference("ja")).toBe("ja");
    expect(normalizeLanguagePreference("zh-Hans")).toBe("zh-Hans");
    expect(normalizeLanguagePreference("pt-BR")).toBe("pt-BR");
  });

  it("follows the computer for anything missing, retired, or hand-edited", () => {
    expect(normalizeLanguagePreference(undefined)).toBe("system");
    expect(normalizeLanguagePreference("zh-hans")).toBe("system");
    expect(normalizeLanguagePreference("pt")).toBe("system");
    expect(normalizeLanguagePreference(3)).toBe("system");
  });
});

describe("systemLanguage", () => {
  it("takes the first preferred language in the set", () => {
    expect(systemLanguage(["pl-PL", "de-AT", "en-US"])).toBe("de");
    expect(systemLanguage(["ja-JP"])).toBe("ja");
    expect(systemLanguage(["es-419"])).toBe("es");
  });

  it("resolves every Chinese locale to Simplified and every Portuguese one to Brazilian", () => {
    expect(systemLanguage(["zh-Hant-TW"])).toBe("zh-Hans");
    expect(systemLanguage(["zh-HK"])).toBe("zh-Hans");
    expect(systemLanguage(["pt-PT"])).toBe("pt-BR");
    expect(systemLanguage(["pt_BR"])).toBe("pt-BR");
  });

  it("speaks English when no preferred language is in the set", () => {
    expect(systemLanguage(["pl-PL", "tr-TR"])).toBe("en");
    expect(systemLanguage([])).toBe("en");
  });
});

describe("effectiveLanguage", () => {
  it("resolves System to the computer's language and keeps an explicit choice", () => {
    expect(effectiveLanguage("system", "ko")).toBe("ko");
    expect(effectiveLanguage("fr", "ko")).toBe("fr");
  });
});

describe("formattingLocale", () => {
  it("uses the computer's regional locale when it is in the interface language", () => {
    expect(formattingLocale("en", "en-GB")).toBe("en-GB");
    expect(formattingLocale("pt-BR", "pt-PT")).toBe("pt-PT");
    expect(formattingLocale("zh-Hans", "zh-CN")).toBe("zh-CN");
  });

  it("uses the interface language's own format otherwise", () => {
    expect(formattingLocale("de", "en-GB")).toBe("de");
    expect(formattingLocale("zh-Hans", "zh-TW")).toBe("zh-Hans");
    expect(formattingLocale("en", null)).toBe("en");
    expect(formattingLocale("en", "not a locale")).toBe("en");
  });
});
