// ─── Supported languages — single source of truth ────────────────────────────
// Drives the Settings/onboarding language chips, validation on
// POST /settings/language, and (Sprint 1.6) the conversation language itself.
//
// active=true means the FULL activation bar is met: crisis-floor detection in
// the language (services/crisis/i18nPatterns.ts), a localized helpline card
// (crisis/helplines.ts), the system-prompt language directive, multilingual
// TTS routing, and a curated voice set (settings/voiceCatalog.ts). A language
// may be CHOSEN and stored while inactive — Eos keeps speaking English until
// every piece above exists. That gate is deliberate: a helpline floor that
// can't read the user's language is not a floor.
//
// ElevenLabs removal (2026-09): the supported set shrank from twelve
// languages to ENGLISH + SPANISH — the two the Hume voice provider carries.
// Removed codes are invalid again: the chips don't offer them, POST
// /settings/language rejects them, and a boot backfill
// (settings/languageSunset.ts) moves stored profiles on removed codes to
// English so nobody is left selecting into a dead option. The crisis
// pattern sets for the removed languages stay in i18nPatterns.ts on
// purpose — detection breadth is free and a user may still WRITE in
// those languages.

export interface LanguageOption {
  /** ISO 639-1 code, stored in profile.preferred_language. */
  code: string;
  /** English name. */
  nameEnglish: string;
  /** Native name (what a speaker of the language calls it). */
  nameNative: string;
  flag: string;
  /** true → Eos actually converses in this language today. */
  active: boolean;
}

export const LANGUAGES: LanguageOption[] = [
  { code: "en", nameEnglish: "English", nameNative: "English", flag: "🇺🇸", active: true },
  { code: "es", nameEnglish: "Spanish", nameNative: "Español", flag: "🇪🇸", active: true },
];

export const LANGUAGE_CODES = new Set(LANGUAGES.map((l) => l.code));

export function isValidLanguage(code: string): boolean {
  return LANGUAGE_CODES.has(code);
}

export function languageByCode(code: string): LanguageOption | undefined {
  return LANGUAGES.find((l) => l.code === code);
}
