// ─── Curated voice catalog — single source of truth ──────────────────────────
// Maps (language + accent + companion gender) → curated ElevenLabs voices.
// Drives GET /settings/voice-options, validation on POST /settings/voice and
// the preview endpoint, and extends the TTS allowlist (routes/tts.ts).
//
// DATA RULES:
//  • Every voiceId here is a real ElevenLabs PREMADE voice (works on any
//    account with no setup) that supports the Multilingual v2 model. IDs are
//    the classic public premade set — the same family the app already uses.
//  • Accent labels follow ElevenLabs' own official accent labels — a voice is
//    never listed under an accent ElevenLabs doesn't label it with.
//  • EMPTY SLOTS ARE HONEST GAPS: ElevenLabs ships no classic premade voices
//    for some accent×gender combos (Australian female, Irish female, Canadian,
//    Indian). Filling those requires adding community Voice-Library voices to
//    the account (the same boot-time flow voiceLibrary.ts already runs for the
//    romantic voices) and dropping their IDs here.
//    TODO(founder): pick Indian/Canadian/Australian-female/Irish-female voices
//    in the ElevenLabs Voice Library and we wire them in — the UI already
//    handles these slots gracefully ("voices for this accent are being added").
//  • Non-English languages exist in the shape but carry no voices yet —
//    Sprint 1.6 fills them alongside conversation-language support.

export type CompanionGender = "woman" | "man" | "nonbinary";

export interface CatalogVoice {
  /** ElevenLabs premade voice id. */
  voiceId: string;
  /** Warm human descriptor shown on the chip — the vibe, not a tech name. */
  displayName: string;
  /** Voice gender — "nonbinary" companions see both lists. */
  gender: "female" | "male";
  /** Short line spoken by the preview endpoint (~4 seconds). */
  previewSample: string;
}

export interface AccentOption {
  /** Stored in profile.voice_accent. */
  code: string;
  label: string;
  flag: string;
  /** Primary accents render as top-level chips; others sit in "more accents". */
  primary: boolean;
}

/** The six English accents (Sprint 1.5 — English only). */
export const ENGLISH_ACCENTS: AccentOption[] = [
  { code: "us", label: "American",   flag: "🇺🇸", primary: true },
  { code: "gb", label: "British",    flag: "🇬🇧", primary: true },
  { code: "au", label: "Australian", flag: "🇦🇺", primary: true },
  { code: "in", label: "Indian",     flag: "🇮🇳", primary: true },
  { code: "ca", label: "Canadian",   flag: "🇨🇦", primary: false },
  { code: "ie", label: "Irish",      flag: "🇮🇪", primary: false },
];

export const ENGLISH_ACCENT_CODES = new Set(ENGLISH_ACCENTS.map((a) => a.code));

const PREVIEW_DEFAULT = "Hi. I'm here whenever you need me.";
const PREVIEW_SOFT = "Hey. Take your time — I'm not going anywhere.";
const PREVIEW_BRIGHT = "Hi there. I'm really glad you're here.";
const PREVIEW_STEADY = "Hello. Whenever you're ready, I'm listening.";

// (language → accent → voices). English fully populated from the classic
// premade set; other languages present but empty until Sprint 1.6.
const CATALOG: Record<string, Record<string, CatalogVoice[]>> = {
  en: {
    us: [
      { voiceId: "21m00Tcm4TlvDq8ikWAM", displayName: "warm & calm",        gender: "female", previewSample: PREVIEW_DEFAULT }, // Rachel
      { voiceId: "EXAVITQu4vr4xnSDxMaL", displayName: "soft & friendly",    gender: "female", previewSample: PREVIEW_SOFT },    // Sarah/Bella
      { voiceId: "MF3mGyEYCl7XYWbV9V6O", displayName: "bright & expressive", gender: "female", previewSample: PREVIEW_BRIGHT }, // Elli
      { voiceId: "XrExE9yKIg1WjnnlVkGX", displayName: "warm & friendly",    gender: "female", previewSample: PREVIEW_DEFAULT }, // Matilda
      { voiceId: "piTKgcLEGmPE4e6mEKli", displayName: "soft & intimate",    gender: "female", previewSample: PREVIEW_SOFT },    // Nicole
      { voiceId: "LcfcDJNUP1GQjkzn1xUU", displayName: "gentle & light",     gender: "female", previewSample: PREVIEW_SOFT },    // Emily
      { voiceId: "pMsXgVXv3BLzUgSXRplE", displayName: "smooth & steady",    gender: "female", previewSample: PREVIEW_STEADY },  // Serena
      { voiceId: "FGY2WhTYpPnrIDTdsKH5", displayName: "bright & clear",     gender: "female", previewSample: PREVIEW_BRIGHT },  // Laura
      { voiceId: "cgSgspJ2msm6clMCkdW9", displayName: "playful & light",    gender: "female", previewSample: PREVIEW_BRIGHT },  // Jessica
      { voiceId: "pNInz6obpgDQGcFmaJgB", displayName: "deep & steady",      gender: "male",   previewSample: PREVIEW_STEADY },  // Adam
      { voiceId: "ErXwobaYiN019PkySvjV", displayName: "warm & easy",        gender: "male",   previewSample: PREVIEW_DEFAULT }, // Antoni
      { voiceId: "nPczCjzI2devNBz1zQrb", displayName: "deep & comforting",  gender: "male",   previewSample: PREVIEW_SOFT },    // Brian
      { voiceId: "TX3LPaxmHKxFdv7VOQHJ", displayName: "natural & relaxed",  gender: "male",   previewSample: PREVIEW_DEFAULT }, // Liam
      { voiceId: "TxGEqnHWrfWFTfGW9XjX", displayName: "young & warm",       gender: "male",   previewSample: PREVIEW_BRIGHT },  // Josh
      { voiceId: "yoZ06aMxZJJ28mfd3POQ", displayName: "dry & grounded",     gender: "male",   previewSample: PREVIEW_STEADY },  // Sam
      { voiceId: "flq6f7yk4E4fJM5XTYuZ", displayName: "mature & gentle",    gender: "male",   previewSample: PREVIEW_STEADY },  // Michael
      { voiceId: "GBv7mTt0atIp3Br8iCZE", displayName: "calm & meditative",  gender: "male",   previewSample: PREVIEW_SOFT },    // Thomas
      { voiceId: "iP95p4xoKVk53GoZ742B", displayName: "casual & friendly",  gender: "male",   previewSample: PREVIEW_BRIGHT },  // Chris
      { voiceId: "cjVigY5qzO86Huf0OWal", displayName: "friendly & clear",   gender: "male",   previewSample: PREVIEW_DEFAULT }, // Eric
    ],
    gb: [
      { voiceId: "pFZP5JQG7iQjIQuC4Bku", displayName: "gentle & soothing",  gender: "female", previewSample: PREVIEW_SOFT },    // Lily
      { voiceId: "Xb7hH8MSUJpSbSDYk0k2", displayName: "bright & clear",     gender: "female", previewSample: PREVIEW_BRIGHT },  // Alice
      { voiceId: "ThT5KcBeYPX3keUQqHPh", displayName: "warm & storybook",   gender: "female", previewSample: PREVIEW_DEFAULT }, // Dorothy
      { voiceId: "JBFqnCBsd6RMkjVDRZzb", displayName: "warm & refined",     gender: "male",   previewSample: PREVIEW_STEADY },  // George
      { voiceId: "onwK4e9ZLuTAKqWW03F9", displayName: "deep & steady",      gender: "male",   previewSample: PREVIEW_STEADY },  // Daniel
      { voiceId: "Zlb1dXrM653N07WRdFW3", displayName: "clear & confident",  gender: "male",   previewSample: PREVIEW_DEFAULT }, // Joseph
      { voiceId: "CYw3kZ02Hs0563khs1Fj", displayName: "casual & real",      gender: "male",   previewSample: PREVIEW_BRIGHT },  // Dave
    ],
    au: [
      // TODO(founder): no classic premade Australian FEMALE voice exists —
      // pick one in the Voice Library to fill this slot.
      { voiceId: "IKne3meq5aSn9XLyUdCD", displayName: "easygoing & real",   gender: "male",   previewSample: PREVIEW_BRIGHT },  // Charlie
      { voiceId: "ZQe5CZNOzWyzPSCn5a3c", displayName: "calm & warm",        gender: "male",   previewSample: PREVIEW_STEADY },  // James
    ],
    in: [
      // TODO(founder): ElevenLabs ships no classic premade Indian-accent
      // voices. Pick female + male Indian-accent voices in the Voice Library
      // (they must be added to the account — voiceLibrary.ts shows the flow)
      // and list them here. The UI shows a warm "being added" note meanwhile.
    ],
    ca: [
      // TODO(founder): no classic premade Canadian-accent voices — fill from
      // the Voice Library, or fold this accent into American if preferred.
    ],
    ie: [
      // TODO(founder): no classic premade Irish FEMALE voice — fill from the
      // Voice Library.
      { voiceId: "D38z5RcWu1voky8WS1ja", displayName: "seasoned & lilting", gender: "male",   previewSample: PREVIEW_STEADY },  // Fin
    ],
  },
  // Sprint 1.6 fills these alongside conversation-language support.
  nl: {}, de: {}, fr: {}, es: {}, it: {}, pt: {}, sv: {}, no: {}, da: {}, pl: {},
};

// ─── Lookup helpers (logic — keep thin, the table above is the product) ──────

/** Voice genders a companion gender may choose from. */
function allowedVoiceGenders(companionGender: string): Set<"female" | "male"> {
  if (companionGender === "man") return new Set(["male"]);
  if (companionGender === "woman") return new Set(["female"]);
  return new Set(["female", "male"]); // nonbinary / unknown → full list
}

export function voicesFor(
  language: string,
  accent: string,
  companionGender: string,
): CatalogVoice[] {
  const genders = allowedVoiceGenders(companionGender);
  return (CATALOG[language]?.[accent] ?? []).filter((v) => genders.has(v.gender));
}

/** Find a voice anywhere in the catalog (any language/accent) by id. */
export function findCatalogVoice(voiceId: string): CatalogVoice | undefined {
  for (const accents of Object.values(CATALOG)) {
    for (const voices of Object.values(accents)) {
      const hit = voices.find((v) => v.voiceId === voiceId);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Is this voice valid for the given language+accent+companion gender? */
export function isVoiceAllowed(
  voiceId: string,
  language: string,
  accent: string,
  companionGender: string,
): boolean {
  return voicesFor(language, accent, companionGender).some((v) => v.voiceId === voiceId);
}

/** Every voice id in the catalog — merged into the TTS allowlist. */
export function allCatalogVoiceIds(): Set<string> {
  const ids = new Set<string>();
  for (const accents of Object.values(CATALOG)) {
    for (const voices of Object.values(accents)) {
      for (const v of voices) ids.add(v.voiceId);
    }
  }
  return ids;
}
