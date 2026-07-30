// ─── Helpline directory — DATA ONLY ──────────────────────────────────────────
// One config table of real crisis helplines, keyed by ISO-3166 alpha-2 country
// code (plus the legacy "UK" alias the profile table stores for United
// Kingdom). Updating a number, adding a country, or fixing hours is an edit to
// THIS file only — no logic lives here (see helplines.ts for resolution and
// block formatting).
//
// Every entry: primary name, dialable number, hours, modality, and a language
// note when the line is not primarily English. Numbers are national-format —
// what a person in that country would actually dial.
//
// Sources: numbers supplied and reviewed at build time (July 2026). They
// change rarely but DO change — re-verify on a schedule, not never.

export interface HelplineEntry {
  name: string;
  number: string;
  /** "24/7" or the actual operating window. */
  hours: string;
  /** How you can reach them: "call", "call & text", "call & chat", … */
  modality: string;
  /** Only when the line is not primarily English, or reach is regional. */
  languageNote?: string;
}

export interface CountryHelplines {
  /** ISO-3166 alpha-2 (upper case). */
  country: string;
  lines: HelplineEntry[];
}

const ENTRIES: CountryHelplines[] = [
  {
    country: "US",
    lines: [
      { name: "988 Suicide & Crisis Lifeline", number: "988", hours: "24/7", modality: "call, text & chat" },
    ],
  },
  {
    country: "GB",
    lines: [
      { name: "Samaritans", number: "116 123", hours: "24/7", modality: "call" },
    ],
  },
  {
    country: "IE",
    lines: [
      { name: "Samaritans", number: "116 123", hours: "24/7", modality: "call" },
      { name: "Pieta House", number: "1800 247 247", hours: "24/7", modality: "call & text" },
    ],
  },
  {
    country: "CA",
    lines: [
      { name: "9-8-8 Suicide Crisis Helpline", number: "988", hours: "24/7", modality: "call & text", languageNote: "English & French" },
    ],
  },
  {
    country: "AU",
    lines: [
      { name: "Lifeline", number: "13 11 14", hours: "24/7", modality: "call, text & chat" },
    ],
  },
  {
    country: "NZ",
    lines: [
      { name: "1737 Need to Talk?", number: "1737", hours: "24/7", modality: "call & text" },
    ],
  },
  {
    country: "IN",
    lines: [
      { name: "AASRA", number: "91-9820466726", hours: "24/7", modality: "call", languageNote: "English & Hindi" },
      { name: "iCall", number: "9152987821", hours: "Mon–Sat, 10am–8pm", modality: "call", languageNote: "multiple Indian languages" },
      { name: "Vandrevala Foundation", number: "1860-2662-345", hours: "24/7", modality: "call", languageNote: "multiple Indian languages" },
    ],
  },
  {
    country: "DE",
    lines: [
      { name: "TelefonSeelsorge", number: "0800 111 0 111", hours: "24/7", modality: "call & chat", languageNote: "German" },
    ],
  },
  {
    country: "FR",
    lines: [
      { name: "3114 — numéro national de prévention du suicide", number: "3114", hours: "24/7", modality: "call", languageNote: "French" },
    ],
  },
  {
    country: "IT",
    lines: [
      { name: "Telefono Amico Italia", number: "02 2327 2327", hours: "daily, 10am–midnight", modality: "call", languageNote: "Italian" },
    ],
  },
  {
    country: "ES",
    lines: [
      { name: "Línea 024 de atención a la conducta suicida", number: "024", hours: "24/7", modality: "call", languageNote: "Spanish" },
    ],
  },
  {
    country: "NL",
    lines: [
      { name: "113 Zelfmoordpreventie", number: "113 (or 0800-0113)", hours: "24/7", modality: "call & chat", languageNote: "Dutch" },
    ],
  },
  {
    country: "BE",
    lines: [
      { name: "Zelfmoordlijn 1813", number: "1813", hours: "24/7", modality: "call & chat", languageNote: "Dutch; French speakers: Centre de Prévention du Suicide 0800 32 123" },
    ],
  },
  {
    country: "SE",
    lines: [
      { name: "Mind Självmordslinjen", number: "90101", hours: "daily", modality: "call & chat", languageNote: "Swedish" },
    ],
  },
  {
    country: "NO",
    lines: [
      { name: "Mental Helse Hjelpetelefonen", number: "116 123", hours: "24/7", modality: "call & chat", languageNote: "Norwegian" },
    ],
  },
  {
    country: "DK",
    lines: [
      { name: "Livslinien", number: "70 201 201", hours: "daily, 11am–5am", modality: "call", languageNote: "Danish" },
    ],
  },
  {
    country: "FI",
    lines: [
      { name: "MIELI Crisis Helpline", number: "09 2525 0111", hours: "24/7", modality: "call", languageNote: "Finnish; English line 09 2525 0116" },
    ],
  },
  {
    country: "PL",
    lines: [
      { name: "Centrum Wsparcia (Kryzysowy Telefon Zaufania)", number: "116 123", hours: "24/7", modality: "call", languageNote: "Polish" },
    ],
  },
  {
    country: "PT",
    lines: [
      { name: "SOS Voz Amiga", number: "213 544 545", hours: "daily, 3:30pm–12:30am", modality: "call", languageNote: "Portuguese" },
    ],
  },
  {
    country: "BR",
    lines: [
      { name: "CVV — Centro de Valorização da Vida", number: "188", hours: "24/7", modality: "call & chat", languageNote: "Portuguese" },
    ],
  },
  {
    country: "MX",
    lines: [
      { name: "SAPTEL", number: "55 5259 8121", hours: "24/7", modality: "call", languageNote: "Spanish" },
    ],
  },
  {
    country: "AR",
    lines: [
      { name: "Centro de Asistencia al Suicida", number: "135", hours: "daily", modality: "call", languageNote: "Spanish; from outside Buenos Aires: (011) 5275-1135" },
    ],
  },
  {
    country: "ZA",
    lines: [
      { name: "SADAG Suicide Crisis Helpline", number: "0800 567 567", hours: "24/7", modality: "call" },
    ],
  },
  {
    country: "KE",
    lines: [
      { name: "Befrienders Kenya", number: "+254 722 178 177", hours: "daily", modality: "call", languageNote: "English & Swahili" },
    ],
  },
  {
    country: "JP",
    lines: [
      { name: "TELL Lifeline", number: "03-5774-0992", hours: "daily, 9am–11pm", modality: "call & chat", languageNote: "English; Japanese speakers: Inochi no Denwa 0570-783-556" },
    ],
  },
  {
    country: "KR",
    lines: [
      { name: "Suicide Prevention Hotline 1393", number: "1393", hours: "24/7", modality: "call", languageNote: "Korean" },
    ],
  },
  {
    country: "SG",
    lines: [
      { name: "Samaritans of Singapore (SOS)", number: "1767", hours: "24/7", modality: "call; WhatsApp 9151 1767" },
    ],
  },
  {
    country: "MY",
    lines: [
      { name: "Befrienders KL", number: "03-7627-2929", hours: "24/7", modality: "call", languageNote: "English, Malay & Chinese" },
    ],
  },
  {
    country: "PH",
    lines: [
      { name: "Hopeline PH", number: "0917-558-4673", hours: "24/7", modality: "call & text", languageNote: "English & Filipino" },
    ],
  },
  {
    country: "IL",
    lines: [
      { name: "ERAN Emotional First Aid", number: "1201", hours: "24/7", modality: "call & chat", languageNote: "Hebrew; English, Russian & Arabic available" },
    ],
  },
];

/** Shown for any country not in the table (or no country on file). */
export const FALLBACK_HELPLINES: HelplineEntry[] = [
  { name: "988 Suicide & Crisis Lifeline (US)", number: "988", hours: "24/7", modality: "call, text & chat" },
  { name: "Samaritans (UK)", number: "116 123", hours: "24/7", modality: "call" },
  { name: "Befrienders Worldwide — helplines by country", number: "befrienders.org", hours: "directory", modality: "web" },
];

/** Lookup map, ISO-2 upper-case. "UK" is aliased to the GB entry because the
 *  profile table stores the legacy "UK" code for United Kingdom. */
export const HELPLINE_DIRECTORY: ReadonlyMap<string, CountryHelplines> = (() => {
  const map = new Map<string, CountryHelplines>();
  for (const e of ENTRIES) map.set(e.country, e);
  const gb = map.get("GB")!;
  map.set("UK", gb);
  return map;
})();
