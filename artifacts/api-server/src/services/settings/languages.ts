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
// Sprint 1.6 activated the ten target languages; Finnish stays as an inactive
// placeholder (chooseable, "coming soon", English conversation).

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
  { code: "en", nameEnglish: "English",    nameNative: "English",    flag: "🇺🇸", active: true },
  { code: "nl", nameEnglish: "Dutch",      nameNative: "Nederlands", flag: "🇳🇱", active: true },
  { code: "de", nameEnglish: "German",     nameNative: "Deutsch",    flag: "🇩🇪", active: true },
  { code: "fr", nameEnglish: "French",     nameNative: "Français",   flag: "🇫🇷", active: true },
  { code: "es", nameEnglish: "Spanish",    nameNative: "Español",    flag: "🇪🇸", active: true },
  { code: "it", nameEnglish: "Italian",    nameNative: "Italiano",   flag: "🇮🇹", active: true },
  { code: "pt", nameEnglish: "Portuguese", nameNative: "Português",  flag: "🇵🇹", active: true },
  { code: "sv", nameEnglish: "Swedish",    nameNative: "Svenska",    flag: "🇸🇪", active: true },
  { code: "no", nameEnglish: "Norwegian",  nameNative: "Norsk",      flag: "🇳🇴", active: true },
  { code: "da", nameEnglish: "Danish",     nameNative: "Dansk",      flag: "🇩🇰", active: true },
  { code: "pl", nameEnglish: "Polish",     nameNative: "Polski",     flag: "🇵🇱", active: true },
  // Inactive placeholder — chooseable, shows the "coming soon" helper, and
  // proves the inactive path keeps working now that the first ten are live.
  { code: "fi", nameEnglish: "Finnish",    nameNative: "Suomi",      flag: "🇫🇮", active: false },
];

export const LANGUAGE_CODES = new Set(LANGUAGES.map((l) => l.code));

export function isValidLanguage(code: string): boolean {
  return LANGUAGE_CODES.has(code);
}

export function languageByCode(code: string): LanguageOption | undefined {
  return LANGUAGES.find((l) => l.code === code);
}
