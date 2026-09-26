import { Fragment, createContext, createElement, useContext, useEffect, useMemo, type ReactNode } from "react";

import type { MessageKey } from "@shared/i18n/catalogues";
import { isLanguage, type Language } from "@shared/i18n/languages";
import { createTranslator, type Translator } from "@shared/i18n/translate";

// The renderer's translator: the shared one, plus `rich`, which fills markup
// (a <code> path, say) into a placeholder so a sentence is never glued together
// from fragments.
export type RendererTranslator = Translator & {
  rich: (key: MessageKey, values: Readonly<Record<string, ReactNode>>) => ReactNode;
};

export function createRendererTranslator(language: Language, locale: string = language): RendererTranslator {
  const translator = createTranslator(language, locale);
  return {
    ...translator,
    rich: (key, values) =>
      // split with a capture group alternates literal text and placeholder names.
      translator.parts(key).map((part, index) =>
        index % 2 === 0
          ? part
          : createElement(Fragment, { key: index }, part in values ? values[part] : `{${part}}`),
      ),
  };
}

// English until a provider says otherwise, so a component rendered on its own
// (in a test, say) still has text.
const I18nContext = createContext<RendererTranslator>(createRendererTranslator("en"));

export function I18nProvider({
  language,
  locale,
  children,
}: {
  language: Language;
  locale: string;
  children: ReactNode;
}) {
  const translator = useMemo(() => createRendererTranslator(language, locale), [language, locale]);

  // <html lang> picks the right glyphs for Chinese, Japanese and Korean text and
  // tells the last-resort error boundary, which sits outside this provider,
  // which language to speak.
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return <I18nContext.Provider value={translator}>{children}</I18nContext.Provider>;
}

export function useI18n(): RendererTranslator {
  return useContext(I18nContext);
}

// For surfaces outside the provider: the language the document last declared.
export function documentTranslator(): RendererTranslator {
  const declared = document.documentElement.lang;
  return createRendererTranslator(isLanguage(declared) ? declared : "en");
}
