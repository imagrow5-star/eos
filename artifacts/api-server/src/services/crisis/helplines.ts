// ─── Helpline resolution + block formatting — LOGIC ──────────────────────────
// Data lives in helplineDirectory.ts. This module turns a profile country code
// into the deterministic helpline block that the crisis floor appends to a
// reply AFTER the LLM has finished — so the resources reach the user even if
// the model ignored every safety instruction.

import {
  HELPLINE_DIRECTORY,
  FALLBACK_HELPLINES,
  type HelplineEntry,
} from "./helplineDirectory.js";

export type { HelplineEntry } from "./helplineDirectory.js";

export interface ResolvedHelplines {
  /** ISO-2 country whose lines are being served, or "fallback". */
  countryServed: string;
  lines: HelplineEntry[];
}

// ─── Language → representative helpline country (country-skipped fallback) ────
// When a crisis user never set profile.country (it's optional at onboarding),
// their language is the next-best signal: a same-language national line is
// strictly closer than stranding them on the US/UK global set. Maps ONLY the
// activated non-English languages to the directory entry that speaks it.
//
// Deliberate, documented limitation: Spanish and Portuguese resolve to the
// EUROPEAN entry (ES → Línea 024, PT → SOS Voz Amiga), not a Latin-American
// line (MX/AR/BR exist in the directory but can't be distinguished from
// language alone). Still same-language and far closer than US/UK; refining to
// LatAm would need a region signal we deliberately don't collect (no IP geo).
// English and any unmapped language keep today's global fallback (already
// English), so nothing regresses.
const LANGUAGE_TO_COUNTRY: Readonly<Record<string, string>> = {
  de: "DE",
  nl: "NL",
  fr: "FR",
  es: "ES",
  it: "IT",
  pt: "PT",
  sv: "SE",
  no: "NO",
  da: "DK",
  pl: "PL",
};

/**
 * profile.country → helplines. Accepts the stored codes as-is ("US", "UK",
 * "IN", "", "other", null…). When the country doesn't resolve, an optional
 * `language` is used to infer a same-language national directory before the
 * global fallback. A real, resolvable country ALWAYS wins over language.
 */
export function resolveHelplines(
  country: string | null | undefined,
  language?: string | null | undefined,
): ResolvedHelplines {
  const code = (country ?? "").trim().toUpperCase();
  const entry = code ? HELPLINE_DIRECTORY.get(code) : undefined;
  if (entry) {
    // "UK" alias resolves to the GB entry — report the code we actually served.
    return { countryServed: entry.country, lines: entry.lines.slice(0, 3) };
  }

  // Country missing/skipped/unknown → try the user's language before global.
  const lang = (language ?? "").trim().toLowerCase();
  const inferredCode = LANGUAGE_TO_COUNTRY[lang];
  const inferred = inferredCode ? HELPLINE_DIRECTORY.get(inferredCode) : undefined;
  if (inferred) {
    return { countryServed: inferred.country, lines: inferred.lines.slice(0, 3) };
  }

  return { countryServed: "fallback", lines: FALLBACK_HELPLINES };
}

// ─── Card copy per language (Sprint 1.6) ─────────────────────────────────────
// Intro + outro of the helpline card, in the user's language. Helpline NAMES
// and NUMBERS never translate — only the two warm lines around them. English
// is the fallback for any unknown code. Drafted by hand (not machine
// translation); native-speaker review is a founder follow-up.
// KEPT IN SYNC BY HAND with the marker list in aanya/src/lib/crisisBlock.ts —
// the frontend splits messages on "—\n" + intro to render the card
// (encryption-registry-style lockstep is enforced by crisis-i18n.test.ts).
//
// Two intros, one card. `intro` is the line for a clear detection (a regex
// hit). `introAmbiguous` is the line when ONLY the semantic backstop fired:
// the message could be read either way ("what's the point of living" as
// philosophy or as despair), so the reinforcement block has Eos ask what they
// meant — and a card that opens "someone who can be with you right now" would
// contradict that question. The card still fires on the same turn, every
// time; only its first line acknowledges the open question. Nothing about
// detection changes here.

export interface HelplineBlockCopy {
  intro: string;
  introAmbiguous: string;
  outro: string;
}

/** Which intro the card opens with. "clear" = a regex hit (or unknown);
 *  "ambiguous" = the semantic backstop alone fired. */
export type HelplineBlockTier = "clear" | "ambiguous";

export const HELPLINE_BLOCK_COPY: Record<string, HelplineBlockCopy> = {
  en: {
    intro: "Someone who can be with you right now, if you want to reach:",
    introAmbiguous: "Whichever it is — these are here if you ever want them:",
    outro: "I'm not going anywhere. Take your time.",
  },
  nl: {
    intro: "Iemand die er nu voor je kan zijn, als je contact wilt:",
    introAmbiguous: "Wat het ook is — deze zijn er, mocht je ze ooit willen:",
    outro: "Ik ga nergens heen. Neem de tijd.",
  },
  de: {
    intro: "Jemand, der jetzt für dich da sein kann, wenn du dich melden möchtest:",
    introAmbiguous: "Was auch immer es ist — diese sind da, falls du sie jemals brauchst:",
    outro: "Ich gehe nirgendwohin. Lass dir Zeit.",
  },
  fr: {
    intro: "Quelqu'un qui peut être là pour toi maintenant, si tu veux appeler :",
    introAmbiguous: "Quoi qu'il en soit — ceux-ci sont là si jamais tu en as besoin :",
    outro: "Je ne vais nulle part. Prends ton temps.",
  },
  es: {
    intro: "Alguien que puede estar contigo ahora mismo, si quieres llamar:",
    introAmbiguous: "Sea lo que sea — esto está aquí por si alguna vez lo quieres:",
    outro: "No me voy a ninguna parte. Tómate tu tiempo.",
  },
  it: {
    intro: "Qualcuno che può starti accanto adesso, se vuoi contattarlo:",
    introAmbiguous: "Qualunque cosa sia — questi sono qui, se mai dovessi volerli:",
    outro: "Io non vado da nessuna parte. Prenditi il tuo tempo.",
  },
  pt: {
    intro: "Alguém que pode estar contigo agora mesmo, se quiseres ligar:",
    introAmbiguous: "Seja o que for — isto está aqui, se alguma vez quiseres:",
    outro: "Eu não vou a lado nenhum. Leva o tempo que precisares.",
  },
  sv: {
    intro: "Någon som kan finnas där för dig just nu, om du vill höra av dig:",
    introAmbiguous: "Vad det än är — de här finns här om du någonsin vill ha dem:",
    outro: "Jag går ingenstans. Ta den tid du behöver.",
  },
  no: {
    intro: "Noen som kan være der for deg akkurat nå, om du vil ta kontakt:",
    introAmbiguous: "Uansett hva det er — disse er her om du noen gang vil ha dem:",
    outro: "Jeg går ingen steder. Ta den tiden du trenger.",
  },
  da: {
    intro: "Nogen, der kan være der for dig lige nu, hvis du vil række ud:",
    introAmbiguous: "Uanset hvad det er — de her er her, hvis du nogensinde vil have dem:",
    outro: "Jeg går ingen steder. Tag dig god tid.",
  },
  pl: {
    intro: "Ktoś, kto może być z Tobą teraz — jeśli chcesz się skontaktować:",
    introAmbiguous: "Cokolwiek to jest — to jest tu, gdyby kiedyś się przydało:",
    outro: "Nigdzie się nie wybieram. Nie spiesz się.",
  },
};

export function helplineBlockCopy(language: string | null | undefined): HelplineBlockCopy {
  return HELPLINE_BLOCK_COPY[(language ?? "en").toLowerCase()] ?? HELPLINE_BLOCK_COPY.en!;
}

// The first line of every ENGLISH helpline block. The frontend splits an
// assistant message into "Eos's words" + "helpline card" on "—\n" + intro —
// for every language (see aanya/src/lib/crisisBlock.ts).
export const HELPLINE_BLOCK_MARKER = `—\n${HELPLINE_BLOCK_COPY.en!.intro}`;

export function markerForLanguage(
  language: string | null | undefined,
  tier: HelplineBlockTier = "clear",
): string {
  return `—\n${helplineBlockIntro(helplineBlockCopy(language), tier)}`;
}

export function helplineBlockIntro(copy: HelplineBlockCopy, tier: HelplineBlockTier): string {
  return tier === "ambiguous" ? copy.introAmbiguous : copy.intro;
}

/** Every "—\n" + intro line the frontend must recognise (both tiers, all
 *  languages) — the set aanya/src/lib/crisisBlock.ts mirrors by hand. */
export function allHelplineBlockMarkers(): string[] {
  return Object.values(HELPLINE_BLOCK_COPY).flatMap((c) => [`—\n${c.intro}`, `—\n${c.introAmbiguous}`]);
}

export function formatHelplineLine(l: HelplineEntry): string {
  const note = l.languageNote ? ` — ${l.languageNote}` : "";
  return `- ${l.name} — ${l.number} — ${l.hours} (${l.modality})${note}`;
}

/**
 * The exact text appended to the assistant reply (and persisted with it, so
 * the card is part of chat history and exports). Intro/outro localized to the
 * user's language; helpline lines unchanged.
 */
export function buildHelplineBlockText(
  lines: HelplineEntry[],
  language = "en",
  tier: HelplineBlockTier = "clear",
): string {
  const copy = helplineBlockCopy(language);
  return [
    `—\n${helplineBlockIntro(copy, tier)}`,
    ...lines.map(formatHelplineLine),
    copy.outro,
  ].join("\n");
}
