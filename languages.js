// Source languages the captions can be in, and the traits the sentence
// splitting needs for each. The target is always Traditional Chinese.
// Loaded as a content script, in the popup and in the options page.
(() => {
  'use strict';

  const SOURCE_LANGUAGE_KEY = 'bceSourceLanguage';
  const TARGET_LANGUAGE = 'zh-Hant';
  // charSeconds: how long one character takes to say, for auto-generated
  // tracks that time each word's start but not its end. Japanese has no
  // spaces between words, so lines join without one.
  const LANGUAGES = {
    en: { code: 'en', label: '英文', spaced: true, charSeconds: 0.065 },
    ja: { code: 'ja', label: '日文', spaced: false, charSeconds: 0.13 },
    ko: { code: 'ko', label: '韓文', spaced: true, charSeconds: 0.13 },
  };
  const SOURCE_CODES = Object.keys(LANGUAGES);
  // 'auto' follows the language spoken in the video when it is one of the
  // above, and English otherwise.
  const PREFERENCES = { auto: '自動', en: '英文', ja: '日文', ko: '韓文' };

  // 'en-US' -> 'en'; undefined for languages without support.
  function normalizeLanguage(code) {
    const base = String(code ?? '').toLowerCase().split(/[-_]/)[0];
    return Object.hasOwn(LANGUAGES, base) ? base : undefined;
  }

  function mergeSourceLanguage(value) {
    return typeof value === 'string' && Object.hasOwn(PREFERENCES, value) ? value : 'auto';
  }

  const traitsOf = (code) => LANGUAGES[normalizeLanguage(code) ?? 'en'];

  // Guesses the language of caption text that came without one (the
  // transcript panel, live CC, an imported file) from its script.
  function detectLanguage(text) {
    const sample = String(text ?? '').slice(0, 2000);
    const count = (pattern) => (sample.match(pattern) ?? []).length;
    const kana = count(/[぀-ヿㇰ-ㇿ]/g);
    const hangul = count(/[가-힯ᄀ-ᇿ㄰-㆏]/g);
    const latin = count(/[A-Za-z]/g);
    if (kana && kana * 4 >= latin) return 'ja';
    if (hangul && hangul * 3 >= latin) return 'ko';
    return 'en';
  }

  // The language the menu shows: "自動 · 日文" once auto has found one.
  function describePreference(preference, detected) {
    const label = PREFERENCES[mergeSourceLanguage(preference)];
    if (preference !== 'auto' || !normalizeLanguage(detected)) return label;
    return `${label} · ${LANGUAGES[normalizeLanguage(detected)].label}`;
  }

  const api = {
    SOURCE_LANGUAGE_KEY, TARGET_LANGUAGE, LANGUAGES, SOURCE_CODES, PREFERENCES,
    normalizeLanguage, mergeSourceLanguage, traitsOf, detectLanguage, describePreference,
  };
  globalThis.bceLanguages = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
