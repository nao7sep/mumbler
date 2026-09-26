import { app, systemPreferences } from "electron";

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

// macOS draws some Edit menu items itself (Emoji & Symbols, Start Dictation,
// AutoFill, Writing Tools, Services) in the language AppKit settles on before
// any JavaScript runs, from AppleLanguages. Electron offers no volatile argument
// domain, so Mumbler keeps the interface language in its own defaults domain
// (never the global one), as macOS's own per-app language setting does: AppKit,
// and Chromium's own strings, pick it up at the next launch, as the conventions
// allow for a language saved mid-session. System removes the entry, so the
// computer's own list applies again. Only the packaged app does this: an
// unpackaged run shares the Electron runtime's own domain with every other
// app in development.
const APPLE_LANGUAGES = "AppleLanguages";

function ownsAppKitLanguages(): boolean {
  return process.platform === "darwin" && app.isPackaged;
}

function readComputerLanguage(): ComputerLanguage {
  if (computer === null) {
    let preferred: string[] = [];
    let locale: string | null = null;
    try {
      if (ownsAppKitLanguages()) {
        // The entry this app wrote shadows the computer's list; clear it first
        // so System reads what the computer prefers. alignAppKit writes it back.
        systemPreferences.removeUserDefault(APPLE_LANGUAGES);
      }
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

/** Points AppKit at the interface language from the next launch: the saved tag
 *  in the app's own defaults domain, or no entry for System. */
export function alignAppKit(preference: LanguagePreference, onError: (error: unknown) => void): void {
  if (!ownsAppKitLanguages()) return;
  readComputerLanguage(); // the computer's list is read before the entry is written
  try {
    if (preference === "system") systemPreferences.removeUserDefault(APPLE_LANGUAGES);
    else systemPreferences.setUserDefault(APPLE_LANGUAGES, "array", [preference]);
  } catch (error) {
    onError(error);
  }
}
