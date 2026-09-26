import { CATALOGUES, type Catalogue, type MessageKey } from "./catalogues";
import type { Language } from "./languages";

// A value filled into a placeholder: a number (formatted for the locale), a
// literal string (a path, a file name, a model id), another message rendered in
// the same language, or a list of any of these, joined by the platform's list
// formatting.
export type MessageValue = string | number | Message | readonly MessageValue[];

export type MessageValues = Readonly<Record<string, MessageValue>>;

// Text held in state (toasts, notices, action results, dialog bodies, load
// failures) is a key plus values, never a finished string, so it renders in
// whatever language is current when it is shown. Stores, services and the main
// process return these; only components render them.
export interface Message {
  readonly key: MessageKey;
  readonly values?: MessageValues;
}

export function message(key: MessageKey, values?: MessageValues): Message {
  return values === undefined ? { key } : { key, values };
}

export function isMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as Message).key === "string";
}

const PLACEHOLDER = /\{(\w+)\}/g;

export type Translator = {
  language: Language;
  locale: string;
  t: (key: MessageKey, values?: MessageValues) => string;
  text: (message: Message) => string;
  // The template split at its placeholders: even indexes are literal text, odd
  // indexes are placeholder names. The renderer fills markup into them.
  parts: (key: MessageKey) => string[];
  value: (value: MessageValue) => string;
  number: (value: number, options?: Intl.NumberFormatOptions) => string;
  percent: (ratio: number) => string;
  list: (items: readonly string[]) => string;
  bytes: (value: number) => string;
  seconds: (value: number, options?: { fractionDigits?: number; signed?: boolean }) => string;
  relativeTime: (value: number, unit: Intl.RelativeTimeFormatUnit) => string;
};

const BYTE_UNITS = ["kilobyte", "megabyte", "gigabyte"] as const;

export function createTranslator(language: Language, locale: string = language): Translator {
  const catalogue: Catalogue = CATALOGUES[language];
  const numberFormat = new Intl.NumberFormat(locale);
  const percentFormat = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const listFormat = new Intl.ListFormat(language, { style: "narrow", type: "conjunction" });
  const relativeFormat = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "short" });
  const pluralRules = new Intl.PluralRules(language);

  function template(key: MessageKey, values: MessageValues | undefined): string {
    const entry = catalogue[key];
    if (typeof entry === "string") {
      return entry;
    }
    // A key the catalogue does not carry shows as itself rather than taking the
    // window down; the catalogue gate and the on-screen-key check both fail on
    // it, so it cannot reach a release unnoticed.
    if (entry === undefined || entry === null) {
      return key;
    }
    // A plural entry holds one form per CLDR category the language uses; the
    // catalogue gate guarantees the category the rules select is present.
    const count = typeof values?.count === "number" ? values.count : 0;
    const forms = entry as Record<string, string>;
    return forms[pluralRules.select(count)] ?? forms.other ?? key;
  }

  function value(item: MessageValue): string {
    if (typeof item === "number") return numberFormat.format(item);
    if (typeof item === "string") return item;
    if (Array.isArray(item)) return listFormat.format((item as readonly MessageValue[]).map(value));
    return text(item as Message);
  }

  function t(key: MessageKey, values?: MessageValues): string {
    return template(key, values).replace(PLACEHOLDER, (whole, name: string) =>
      values !== undefined && name in values ? value(values[name]!) : whole,
    );
  }

  function text(item: Message): string {
    return t(item.key, item.values);
  }

  function bytes(size: number): string {
    if (size < 1024) {
      return new Intl.NumberFormat(locale, { style: "unit", unit: "byte", unitDisplay: "short" }).format(size);
    }
    let scaled = size / 1024;
    let index = 0;
    while (scaled >= 1024 && index < BYTE_UNITS.length - 1) {
      scaled /= 1024;
      index += 1;
    }
    const digits = scaled >= 100 ? 0 : 1;
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: BYTE_UNITS[index],
      unitDisplay: "short",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(scaled);
  }

  function seconds(amount: number, options: { fractionDigits?: number; signed?: boolean } = {}): string {
    const digits = options.fractionDigits ?? 0;
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "second",
      unitDisplay: "narrow",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      signDisplay: options.signed ? "exceptZero" : "auto",
    }).format(amount);
  }

  return {
    language,
    locale,
    t,
    text,
    parts: (key) => template(key, undefined).split(PLACEHOLDER),
    value,
    number: (amount, options) => (options === undefined ? numberFormat : new Intl.NumberFormat(locale, options)).format(amount),
    percent: (ratio) => percentFormat.format(ratio),
    list: (items) => listFormat.format(items),
    bytes,
    seconds,
    relativeTime: (amount, unit) => relativeFormat.format(amount, unit),
  };
}
