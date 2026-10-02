import en from "./locales/en.json";
import type { Language } from "./languages";

// English defines the key set; every other catalogue carries every key, with
// plural entries keyed by the language's own CLDR categories. The catalogue
// gate (tests/i18n/catalogues.test.ts) checks keys, placeholders, plural forms,
// and untranslated English.
export type MessageKey = keyof typeof en;

export type CatalogueEntry = string | Readonly<Record<string, string>>;

export type Catalogue = Readonly<Record<MessageKey, CatalogueEntry>>;

export const ENGLISH: Catalogue = en;

// English is always at hand; every other catalogue is its own dynamic import,
// so each process reads only the interface language and English
// (localization-stack-conventions, Electron with React).
const LOADERS: Readonly<Record<Exclude<Language, "en">, () => Promise<{ default: Catalogue }>>> = {
  de: () => import("./locales/de.json"),
  es: () => import("./locales/es.json"),
  fr: () => import("./locales/fr.json"),
  it: () => import("./locales/it.json"),
  "pt-BR": () => import("./locales/pt-BR.json"),
  ru: () => import("./locales/ru.json"),
  ja: () => import("./locales/ja.json"),
  ko: () => import("./locales/ko.json"),
  "zh-Hans": () => import("./locales/zh-Hans.json"),
};

const loaded = new Map<Language, Catalogue>([["en", ENGLISH]]);

export async function loadCatalogue(language: Language): Promise<void> {
  if (language === "en" || loaded.has(language)) return;
  loaded.set(language, (await LOADERS[language]()).default);
}

// A translator is built only for a language whose catalogue is loaded.
export function loadedCatalogue(language: Language): Catalogue {
  const catalogue = loaded.get(language);
  if (catalogue === undefined) {
    throw new Error(`The ${language} catalogue is not loaded.`);
  }
  return catalogue;
}
