// @vitest-environment jsdom
import { act, createElement, isValidElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { loadCatalogue, type MessageKey } from "@shared/i18n/catalogues";
import { createTranslator, message } from "@shared/i18n/translate";
import type { Language } from "@shared/i18n/languages";
import { createRendererTranslator, I18nProvider, useI18n } from "@renderer/i18n/I18nContext";

beforeAll(() => Promise.all((["de", "ru", "fr", "ja"] as const).map(loadCatalogue)));

describe("createTranslator", () => {
  it("fills placeholders and formats numbers for the locale", () => {
    expect(createTranslator("en").t("about.version", { version: "1.2.0" })).toBe("Version 1.2.0");
    expect(createTranslator("en", "en-US").t("units.hertz", { value: 44100 })).toBe("44,100 Hz");
    expect(createTranslator("de").t("units.hertz", { value: 44100 })).toBe("44.100 Hz");
  });

  it("chooses the plural form by the language's own rules", () => {
    const ru = createTranslator("ru");
    const imported = (count: number) => ru.t("import.imported", { count });
    expect(imported(1)).toContain("1 файл.");
    expect(imported(3)).toContain("3 файла.");
    expect(imported(5)).toContain("5 файлов.");
    expect(imported(21)).toContain("21 файл.");
    expect(createTranslator("en").t("import.imported", { count: 1 })).toBe("Imported 1 file.");
    expect(createTranslator("en").t("import.imported", { count: 2 })).toBe("Imported 2 files.");
  });

  it("renders a value that is itself a message, in the same language", () => {
    const nested = message("import.failureItem", {
      file: "a.txt",
      reason: message("import.unsupportedType"),
    });
    expect(createTranslator("en").text(nested)).toBe("a.txt: Unsupported audio file type.");
  });

  it("joins a list value with the platform's list formatting", () => {
    const body = message("generate.confirmBody.title", {
      results: [message("result.title"), message("result.slug")],
    });
    expect(createTranslator("en").text(body)).toBe("Generating the title will replace existing data for: Title, Slug.");
  });

  it("formats sizes, seconds, percentages and relative times for the locale", () => {
    const en = createTranslator("en", "en-US");
    expect(en.bytes(512)).toBe("512 byte");
    expect(en.bytes(1536)).toBe("1.5 kB");
    expect(en.bytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(en.seconds(0.1, { fractionDigits: 1, signed: true })).toBe("+0.1s");
    expect(en.seconds(-1, { fractionDigits: 1, signed: true })).toBe("-1.0s");
    expect(en.percent(0.42)).toBe("42%");
    expect(createTranslator("fr").percent(0.42)).toBe("42 %");
    expect(en.relativeTime(-5, "minute")).toBe("5 min. ago");
  });

  it("shows a key the catalogue lacks instead of failing the render", () => {
    const missing = "gone.missing" as unknown as MessageKey;
    expect(createTranslator("ja").t(missing)).toBe("gone.missing");
  });
});

describe("createRendererTranslator", () => {
  it("puts markup into placeholders for rich text", () => {
    const parts = createRendererTranslator("en").rich("review.backupHint", { path: "P" }) as unknown[];
    const filled = parts.map((part) =>
      isValidElement(part) ? (part as ReactElement<{ children: unknown }>).props.children : part,
    );
    expect(filled.join("")).toBe("Backups are saved to P. Configure the location in Settings.");
  });
});

describe("catalogue loading", () => {
  it("builds a translator only for a language whose catalogue is loaded", async () => {
    expect(() => createTranslator("ko")).toThrow();
    await loadCatalogue("ko");
    expect(createTranslator("ko").t("settings.language")).toBe("언어");
  });

  it("keeps the language on screen until a newly chosen one has loaded", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    const root = createRoot(host);
    function Heading() {
      return createElement("h1", null, useI18n().t("settings.language"));
    }
    const render = (language: Language) =>
      root.render(createElement(I18nProvider, { language, locale: language, children: createElement(Heading) }));
    try {
      await act(async () => render("en"));
      expect(host.textContent).toBe("Language");
      act(() => render("es"));
      expect(host.textContent).toBe("Language");
      await vi.waitFor(() => expect(host.textContent).toBe("Idioma"));
      expect(document.documentElement.lang).toBe("es");
    } finally {
      act(() => root.unmount());
    }
  });
});
