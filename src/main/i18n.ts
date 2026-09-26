import { app } from "electron";

import {
  effectiveLanguage,
  formattingLocale,
  systemLanguage,
  type InterfaceLanguage,
  type Language,
  type LanguagePreference,
} from "@shared/i18n/languages";
import { createTranslator, type Translator } from "@shared/i18n/translate";

// The computer's language, read once, at launch: System resolves against this
// reading for the whole session (localization-conventions).
interface ComputerLanguage {
  language: Language;
  // The computer's regional locale, for dates and numbers when it is in the
  // interface language.
  locale: string | null;
}

let computer: ComputerLanguage | null = null;

function readComputerLanguage(): ComputerLanguage {
  if (computer === null) {
    let preferred: string[] = [];
    let locale: string | null = null;
    try {
      preferred = app.getPreferredSystemLanguages();
      locale = app.getSystemLocale() || null;
    } catch {
      // Outside a running Electron app (unit tests), the computer speaks English.
    }
    computer = { language: systemLanguage(preferred), locale };
  }
  return computer;
}

/** The language and formatting locale a saved preference settles on. */
export function resolveInterfaceLanguage(preference: LanguagePreference): InterfaceLanguage {
  const { language: system, locale } = readComputerLanguage();
  const language = effectiveLanguage(preference, system);
  return { language, locale: formattingLocale(language, locale) };
}

/** The translator for text the main process draws itself. */
export function mainTranslator(preference: LanguagePreference): Translator {
  const { language, locale } = resolveInterfaceLanguage(preference);
  return createTranslator(language, locale);
}
