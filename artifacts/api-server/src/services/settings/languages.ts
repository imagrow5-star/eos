// ─── Supported languages — single source of truth ────────────────────────────
// Drives the Settings/onboarding language chips, validation on
// POST /settings/language, and (Sprint 1.6) the conversation language itself.
//
// Sprint 1.5: only English is ACTIVE — every language can be *chosen and
// stored* (so 1.6 can flip it on cleanly), but Eos keeps speaking English
// until safety detection (the crisis floor's pattern list) has been extended
// to that language. That gate is deliberate: a helpline floor that can't read
// the user's language is not a floor.

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
  { code: "nl", nameEnglish: "Dutch",      nameNative: "Nederlands", flag: "🇳🇱", active: false },
  { code: "de", nameEnglish: "German",     nameNative: "Deutsch",    flag: "🇩🇪", active: false },
  { code: "fr", nameEnglish: "French",     nameNative: "Français",   flag: "🇫🇷", active: false },
  { code: "es", nameEnglish: "Spanish",    nameNative: "Español",    flag: "🇪🇸", active: false },
  { code: "it", nameEnglish: "Italian",    nameNative: "Italiano",   flag: "🇮🇹", active: false },
  { code: "pt", nameEnglish: "Portuguese", nameNative: "Português",  flag: "🇵🇹", active: false },
  { code: "sv", nameEnglish: "Swedish",    nameNative: "Svenska",    flag: "🇸🇪", active: false },
  { code: "no", nameEnglish: "Norwegian",  nameNative: "Norsk",      flag: "🇳🇴", active: false },
  { code: "da", nameEnglish: "Danish",     nameNative: "Dansk",      flag: "🇩🇰", active: false },
  { code: "pl", nameEnglish: "Polish",     nameNative: "Polski",     flag: "🇵🇱", active: false },
];

export const LANGUAGE_CODES = new Set(LANGUAGES.map((l) => l.code));

export function isValidLanguage(code: string): boolean {
  return LANGUAGE_CODES.has(code);
}

export function languageByCode(code: string): LanguageOption | undefined {
  return LANGUAGES.find((l) => l.code === code);
}
