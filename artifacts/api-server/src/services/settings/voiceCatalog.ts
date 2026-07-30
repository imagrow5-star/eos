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
  // ── Non-English languages (Sprint 1.6) ─────────────────────────────────────
  // ElevenLabs Multilingual v2 lets ANY voice speak any of these languages, so
  // each language reuses proven premade ids under the single pseudo-accent
  // "std" (accents are an English-only concept in the UI). Display names and
  // preview sentences are in the target language — drafted by hand, logged
  // here for review (native-speaker pass is a founder follow-up):
  //   nl: "Hallo. Ik ben er, wanneer je me nodig hebt."
  //   de: "Hallo. Ich bin hier, wann immer du mich brauchst."
  //   fr: "Bonjour. Je suis là, quand tu as besoin de moi."
  //   es: "Hola. Estoy aquí siempre que me necesites."
  //   it: "Ciao. Sono qui, ogni volta che hai bisogno di me."
  //   pt: "Olá. Estou aqui sempre que precisares de mim."
  //   sv: "Hej. Jag finns här när du behöver mig."
  //   no: "Hei. Jeg er her når du trenger meg."
  //   da: "Hej. Jeg er her, når du har brug for mig."
  //   pl: "Cześć. Jestem tu, kiedy mnie potrzebujesz."
  ...buildNonEnglishCatalog(),
};

/** Accent key used for every non-English language (no accent concept). */
export const NON_ENGLISH_ACCENT = "std";

// Voice ids shared with the English catalog — Rachel/Sarah/Lily (female),
// Adam/Brian/George (male): warm, proven, Multilingual-v2-capable premades.
// NOTE: called during CATALOG initialization (hoisted declaration), so it
// uses the literal "std" — NON_ENGLISH_ACCENT above is not yet initialized
// at that moment.
function buildNonEnglishCatalog(): Record<string, Record<string, CatalogVoice[]>> {
  const F1 = "21m00Tcm4TlvDq8ikWAM"; // Rachel
  const F2 = "EXAVITQu4vr4xnSDxMaL"; // Sarah
  const F3 = "pFZP5JQG7iQjIQuC4Bku"; // Lily
  const M1 = "pNInz6obpgDQGcFmaJgB"; // Adam
  const M2 = "nPczCjzI2devNBz1zQrb"; // Brian
  const M3 = "JBFqnCBsd6RMkjVDRZzb"; // George

  const set = (
    preview: string,
    names: [string, string, string, string, string, string],
  ): Record<string, CatalogVoice[]> => ({
    std: [
      { voiceId: F1, displayName: names[0], gender: "female", previewSample: preview },
      { voiceId: F2, displayName: names[1], gender: "female", previewSample: preview },
      { voiceId: F3, displayName: names[2], gender: "female", previewSample: preview },
      { voiceId: M1, displayName: names[3], gender: "male", previewSample: preview },
      { voiceId: M2, displayName: names[4], gender: "male", previewSample: preview },
      { voiceId: M3, displayName: names[5], gender: "male", previewSample: preview },
    ],
  });

  return {
    nl: set("Hallo. Ik ben er, wanneer je me nodig hebt.", [
      "warm en rustig", "zacht en teder", "helder en licht",
      "diep en vast", "warm en relaxed", "kalm en verfijnd",
    ]),
    de: set("Hallo. Ich bin hier, wann immer du mich brauchst.", [
      "warm & ruhig", "sanft & zärtlich", "hell & klar",
      "tief & fest", "warm & gelassen", "ruhig & fein",
    ]),
    fr: set("Bonjour. Je suis là, quand tu as besoin de moi.", [
      "chaleureuse et calme", "douce et tendre", "claire et lumineuse",
      "grave et posé", "chaleureux et détendu", "calme et raffiné",
    ]),
    es: set("Hola. Estoy aquí siempre que me necesites.", [
      "cálida y serena", "suave y tierna", "clara y luminosa",
      "profunda y firme", "cálido y relajado", "sereno y refinado",
    ]),
    it: set("Ciao. Sono qui, ogni volta che hai bisogno di me.", [
      "calda e serena", "morbida e dolce", "chiara e luminosa",
      "profonda e salda", "caldo e rilassato", "calmo e raffinato",
    ]),
    pt: set("Olá. Estou aqui sempre que precisares de mim.", [
      "quente e serena", "suave e terna", "clara e luminosa",
      "grave e firme", "caloroso e tranquilo", "calmo e refinado",
    ]),
    sv: set("Hej. Jag finns här när du behöver mig.", [
      "varm och lugn", "mjuk och öm", "ljus och klar",
      "djup och stadig", "varm och avspänd", "lugn och förfinad",
    ]),
    no: set("Hei. Jeg er her når du trenger meg.", [
      "varm og rolig", "myk og øm", "lys og klar",
      "dyp og stødig", "varm og avslappet", "rolig og raffinert",
    ]),
    da: set("Hej. Jeg er her, når du har brug for mig.", [
      "varm og rolig", "blød og øm", "lys og klar",
      "dyb og stabil", "varm og afslappet", "rolig og raffineret",
    ]),
    pl: set("Cześć. Jestem tu, kiedy mnie potrzebujesz.", [
      "ciepły i spokojny", "miękki i czuły", "jasny i wyraźny",
      "głęboki i pewny", "ciepły i swobodny", "spokojny i elegancki",
    ]),
  };
}

// ─── Lookup helpers (logic — keep thin, the table above is the product) ──────

/**
 * Which voice genders a subject may see. Accepts BOTH vocabularies so old
 * callers (companion gender: man/woman/nonbinary) and new callers (explicit
 * voice gender: male/female) share one filter:
 *   man | male     → male voices
 *   woman | female → female voices
 *   anything else  → both lists
 */
function allowedVoiceGenders(subject: string): Set<"female" | "male"> {
  if (subject === "man" || subject === "male") return new Set(["male"]);
  if (subject === "woman" || subject === "female") return new Set(["female"]);
  return new Set(["female", "male"]);
}

export function voicesFor(
  language: string,
  accent: string,
  genderSubject: string,
): CatalogVoice[] {
  const genders = allowedVoiceGenders(genderSubject);
  return (CATALOG[language]?.[accent] ?? []).filter((v) => genders.has(v.gender));
}

/**
 * The voice gender to DISPLAY and FILTER by for a profile: the explicit
 * voice_gender when set, else derived from companion gender (man→male,
 * woman→female), else "female" as the picker default. `explicit` tells the
 * UI whether this was actually chosen/backfilled or is just the display
 * default (which is never silently saved).
 */
export function resolveVoiceGender(profile: {
  voiceGender?: string | null;
  companionGender?: string | null;
}): { gender: "female" | "male"; explicit: boolean } {
  const vg = profile.voiceGender;
  if (vg === "female" || vg === "male") return { gender: vg, explicit: true };
  const cg = profile.companionGender;
  if (cg === "man") return { gender: "male", explicit: false };
  if (cg === "woman") return { gender: "female", explicit: false };
  return { gender: "female", explicit: false };
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
