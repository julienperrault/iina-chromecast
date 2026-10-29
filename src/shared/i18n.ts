/**
 * Multi-language (i18n) loader & formatter for IINA Chromecast Plugin
 */

import enDict from "../../i18n/en.json";
import frDict from "../../i18n/fr.json";
import esDict from "../../i18n/es.json";

export type SupportedLanguage = "en" | "fr" | "es";
export const SUPPORTED_LANGUAGES: SupportedLanguage[] = ["en", "fr", "es"];

export type TranslationKey = keyof typeof enDict;

export const TRANSLATIONS: Record<SupportedLanguage, Record<string, string>> = {
  en: enDict,
  fr: frDict,
  es: esDict,
};

export function resolveLanguage(
  prefLang?: string | null,
  fallbackLocale = ""
): SupportedLanguage {
  if (prefLang && prefLang !== "auto") {
    const directShort = String(prefLang).toLowerCase().slice(0, 2) as SupportedLanguage;
    if (SUPPORTED_LANGUAGES.includes(directShort)) {
      return directShort;
    }
  }

  const rawLocale =
    fallbackLocale ||
    (typeof navigator !== "undefined" && navigator.language) ||
    (typeof process !== "undefined" &&
      process.env &&
      (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG)) ||
    "en";

  const short = String(rawLocale).toLowerCase().slice(0, 2) as SupportedLanguage;
  if (SUPPORTED_LANGUAGES.includes(short)) {
    return short;
  }
  return "en";
}

export function t(
  lang: string | null | undefined,
  key: string,
  params: Record<string, string | number | null | undefined> = {}
): string {
  const resolved = resolveLanguage(lang);
  const dict = TRANSLATIONS[resolved] || TRANSLATIONS.en;
  const template = dict[key] ?? TRANSLATIONS.en[key] ?? key;

  return String(template).replace(/\{(\w+)\}/g, (_, k) =>
    params[k] !== undefined && params[k] !== null ? String(params[k]) : ""
  );
}

// Global browser window export for UI webviews (sidebar & preferences)
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).IINA_CHROMECAST_I18N = {
    SUPPORTED_LANGUAGES,
    TRANSLATIONS,
    resolveLanguage,
    t,
  };
}
