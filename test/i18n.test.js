const test = require("node:test");
const assert = require("node:assert/strict");
require("./setup.js");

const {
  resolveLanguage,
  t,
  TRANSLATIONS,
} = require("../src/shared/i18n.ts");

test("resolveLanguage: resolves direct and prefixed languages", () => {
  assert.equal(resolveLanguage("fr"), "fr");
  assert.equal(resolveLanguage("fr-CA"), "fr");
  assert.equal(resolveLanguage("es-MX"), "es");
  assert.equal(resolveLanguage("en-GB"), "en");
});

test("resolveLanguage: falls back to system locale or english", () => {
  assert.equal(resolveLanguage(null, "fr-FR"), "fr");
  assert.equal(resolveLanguage("", "es-ES"), "es");
  assert.equal(resolveLanguage("unknown", "de-DE"), "en");
  assert.equal(resolveLanguage("auto", "fr_FR"), "fr");
});

test("t: formats parameterized translation strings", () => {
  const msgEn = t("en", "track.audio", { index: 2 });
  assert.equal(msgEn, "Audio #2");

  const msgFr = t("fr", "track.subtitle", { index: 3 });
  assert.equal(msgFr, "Sous-titres #3");

  const msgEs = t("es", "track.subtitle", { index: 3 });
  assert.equal(msgEs, "Subtítulos #3");
});

test("t: falls back to English when key is absent", () => {
  const result = t("fr", "non_existent_key");
  assert.equal(result, "non_existent_key");
});

test("TRANSLATIONS: parity check across language dictionaries", () => {
  const enKeys = Object.keys(TRANSLATIONS.en);
  const frKeys = Object.keys(TRANSLATIONS.fr);
  const esKeys = Object.keys(TRANSLATIONS.es);

  assert.ok(enKeys.length > 20, "English dictionary should have translations");
  assert.equal(frKeys.length, enKeys.length, "French should have same number of keys as English");
  assert.equal(esKeys.length, enKeys.length, "Spanish should have same number of keys as English");

  for (const key of enKeys) {
    assert.ok(key in TRANSLATIONS.fr, `French dictionary missing key '${key}'`);
    assert.ok(key in TRANSLATIONS.es, `Spanish dictionary missing key '${key}'`);
  }
});
