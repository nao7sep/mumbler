// The interface languages Mumbler ships, in the order the Settings picker lists
// them after System: Latin-script languages alphabetically by their own names,
// then Cyrillic, then CJK. Each tag names a catalogue in ./locales, which both
// the main process (native menus, dialogs, the startup-failure window) and the
// renderer read, so the two always speak the same language.
//
// A tag says exactly which variety a catalogue is written in, while the picker
// shows each language by its plain name: zh-Hans is Simplified Chinese, shown
// as 中文, and pt-BR is Brazilian Portuguese, shown as Português. Each is the
// app's only variety of its language, so every Chinese or Portuguese computer
// resolves to it.
export const LANGUAGES = ["en", "de", "es", "fr", "it", "pt-BR", "ru", "ja", "ko", "zh-Hans"] as const;

export type Language = (typeof LANGUAGES)[number];

// The saved choice. System follows the computer's language on every launch.
export type LanguagePreference = "system" | Language;

// What the main process tells the renderer: the language both speak and the
// locale dates and numbers are formatted in.
export interface InterfaceLanguage {
  language: Language;
  locale: string;
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

// A missing, retired, or hand-edited value follows the computer.
export function normalizeLanguagePreference(value: unknown): LanguagePreference {
  return isLanguage(value) ? value : "system";
}

export function effectiveLanguage(preference: LanguagePreference, systemLanguage: Language): Language {
  return preference === "system" ? systemLanguage : preference;
}

// The supported tag a computer locale resolves to, if any. Every Chinese
// locale, Taiwan and Hong Kong included, resolves to Simplified Chinese, and
// every Portuguese one to Brazilian Portuguese.
function matchLocale(locale: string): Language | null {
  const primary = locale.split(/[-_.@]/)[0]?.toLowerCase() ?? "";
  if (primary === "zh") return "zh-Hans";
  if (primary === "pt") return "pt-BR";
  return LANGUAGES.find((tag) => tag === primary) ?? null;
}

// The computer's language: the first of its preferred languages that resolves
// to a supported tag, else English.
export function systemLanguage(preferred: readonly string[]): Language {
  for (const locale of preferred) {
    const match = matchLocale(locale);
    if (match !== null) return match;
  }
  return "en";
}

// Dates and numbers follow the computer's regional format when it is in the
// interface language (British English dates for an en-GB computer), and the
// interface language's own format otherwise.
export function formattingLocale(language: Language, systemLocale: string | null): string {
  if (systemLocale === null) {
    return language;
  }
  try {
    const system = new Intl.Locale(systemLocale).maximize();
    const target = new Intl.Locale(language).maximize();
    const sameLanguage = system.language === target.language && system.script === target.script;
    return sameLanguage && Intl.DateTimeFormat.supportedLocalesOf([systemLocale]).length > 0
      ? systemLocale
      : language;
  } catch {
    return language;
  }
}
