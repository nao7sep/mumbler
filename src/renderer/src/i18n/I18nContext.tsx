import { Fragment, createContext, createElement, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

import { loadCatalogue, type MessageKey } from "@shared/i18n/catalogues";
import { isLanguage, type InterfaceLanguage, type Language } from "@shared/i18n/languages";
import { createTranslator, isIdentifier, type Message, type MessageValue, type Translator } from "@shared/i18n/translate";

import { reportRendererDiagnostic } from "../app/presentFailure";
import { ShortenedValue } from "../app/ShortenedValue";

// The renderer's translator: the shared one, plus `rich`, which fills markup
// (a <code> path, say) into a placeholder so a sentence is never glued together
// from fragments, and `node`, which renders a message for a compact surface:
// the names and paths in it are shortened, each revealable whole.
export type RendererTranslator = Translator & {
  rich: (key: MessageKey, values: Readonly<Record<string, ReactNode>>) => ReactNode;
  node: (message: Message) => ReactNode;
};

export function createRendererTranslator(language: Language, locale: string = language): RendererTranslator {
  const translator = createTranslator(language, locale);

  function value(item: MessageValue): ReactNode {
    if (isIdentifier(item)) return createElement(ShortenedValue, { kind: item.identifier, value: item.value });
    if (Array.isArray(item)) {
      const items = item as readonly MessageValue[];
      // The list's own words and separators, with each element rendered in
      // place. Each element stands in as its own private-use character: the
      // formatter merges empty elements into the separators around them.
      const token = (index: number) => String.fromCharCode(0xe000 + index);
      return translator.listParts(items.map((_, index) => token(index))).map((part, index) =>
        createElement(
          Fragment,
          { key: index },
          part.type === "element" ? value(items[part.value.charCodeAt(0) - 0xe000]!) : part.value,
        ),
      );
    }
    if (typeof item === "object") return node(item as Message);
    return translator.value(item);
  }

  function node(item: Message): ReactNode {
    // split with a capture group alternates literal text and placeholder names.
    return translator.parts(item.key, item.values).map((part, index) =>
      index % 2 === 0
        ? part
        : createElement(Fragment, { key: index }, item.values !== undefined && part in item.values ? value(item.values[part]!) : `{${part}}`),
    );
  }

  return {
    ...translator,
    rich: (key, values) =>
      translator.parts(key).map((part, index) =>
        index % 2 === 0
          ? part
          : createElement(Fragment, { key: index }, part in values ? values[part] : `{${part}}`),
      ),
    node,
  };
}

// English until a provider says otherwise, so a component rendered on its own
// (in a test, say) still has text.
const I18nContext = createContext<RendererTranslator>(createRendererTranslator("en"));

// The first language given must already be loaded. A later one, saved in
// Settings, replaces it once its catalogue has loaded.
export function I18nProvider({
  language,
  locale,
  children,
}: {
  language: Language;
  locale: string;
  children: ReactNode;
}) {
  const [shown, setShown] = useState<InterfaceLanguage>({ language, locale });

  useEffect(() => {
    let cancelled = false;
    void loadCatalogue(language).then(
      () => {
        if (!cancelled) setShown({ language, locale });
      },
      (error: unknown) => reportRendererDiagnostic(error, "interface catalogue load failed"),
    );
    return () => {
      cancelled = true;
    };
  }, [language, locale]);

  const translator = useMemo(() => createRendererTranslator(shown.language, shown.locale), [shown.language, shown.locale]);

  // <html lang> picks the right glyphs for Chinese, Japanese and Korean text and
  // tells the last-resort error boundary, which sits outside this provider,
  // which language to speak. It changes before paint, with the text it describes.
  useLayoutEffect(() => {
    document.documentElement.lang = shown.language;
  }, [shown.language]);

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
