/**
 * Multi-language (i18n) loader & formatter for IINA Chromecast Plugin
 * Translations are stored in separate JSON files under `i18n/`:
 * - `i18n/en.json` (English - default fallback)
 * - `i18n/fr.json` (Français)
 * - `i18n/es.json` (Español)
 */

const en = require("../i18n/en.json");
const fr = require("../i18n/fr.json");
const es = require("../i18n/es.json");

const SUPPORTED_LANGUAGES = ["en", "fr", "es"];

const TRANSLATIONS = {
  en,
  fr,
  es,
};

function resolveLanguage(prefLang, fallbackLocale = "") {
  if (prefLang && SUPPORTED_LANGUAGES.includes(prefLang)) {
    return prefLang;
  }

  const rawLocale =
    fallbackLocale ||
    (typeof navigator !== "undefined" && navigator.language) ||
    (typeof process !== "undefined" &&
      process.env &&
      (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG)) ||
    "en";

  const short = String(rawLocale).toLowerCase().slice(0, 2);
  if (SUPPORTED_LANGUAGES.includes(short)) {
    return short;
  }
  return "en";
}

function t(lang, key, params = {}) {
  const resolved = resolveLanguage(lang);
  const dict = TRANSLATIONS[resolved] || TRANSLATIONS.en;
  const template = dict[key] ?? TRANSLATIONS.en[key] ?? key;

  return String(template).replace(/\{(\w+)\}/g, (_, k) =>
    params[k] !== undefined && params[k] !== null ? String(params[k]) : ""
  );
}

const i18nApi = {
  SUPPORTED_LANGUAGES,
  TRANSLATIONS,
  resolveLanguage,
  t,
};

if (typeof window !== "undefined") {
  window.IINA_CHROMECAST_I18N = i18nApi;
}

module.exports = i18nApi;
