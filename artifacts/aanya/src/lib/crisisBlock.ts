// ─── Crisis helpline block — client-side split ───────────────────────────────
// The crisis floor appends a helpline block to the assistant message content
// (so history and exports carry it). The block always starts with "—\n" plus
// a language-specific intro line — kept in sync BY HAND with
// HELPLINE_BLOCK_COPY in api-server services/crisis/helplines.ts (the server's
// crisis-i18n test reads this file and fails when the two drift). Splitting
// on whichever marker occurs lets the UI render Eos's words as a normal
// bubble and the resources as a distinct, dismissible card (and keeps
// helplines out of TTS) in every language.
//
// Each language has two intro lines: the clear one, and the one used when
// only the semantic backstop fired and Eos is still asking what they meant.

const BLOCK_INTROS = [
  "Someone who can be with you right now, if you want to reach:", // en
  "Iemand die er nu voor je kan zijn, als je contact wilt:", // nl
  "Jemand, der jetzt für dich da sein kann, wenn du dich melden möchtest:", // de
  "Quelqu'un qui peut être là pour toi maintenant, si tu veux appeler :", // fr
  "Alguien que puede estar contigo ahora mismo, si quieres llamar:", // es
  "Qualcuno che può starti accanto adesso, se vuoi contattarlo:", // it
  "Alguém que pode estar contigo agora mesmo, se quiseres ligar:", // pt
  "Någon som kan finnas där för dig just nu, om du vill höra av dig:", // sv
  "Noen som kan være der for deg akkurat nå, om du vil ta kontakt:", // no
  "Nogen, der kan være der for dig lige nu, hvis du vil række ud:", // da
  "Ktoś, kto może być z Tobą teraz — jeśli chcesz się skontaktować:", // pl
];

const BLOCK_INTROS_AMBIGUOUS = [
  "Whichever it is — these are here if you ever want them:", // en
  "Wat het ook is — deze zijn er, mocht je ze ooit willen:", // nl
  "Was auch immer es ist — diese sind da, falls du sie jemals brauchst:", // de
  "Quoi qu'il en soit — ceux-ci sont là si jamais tu en as besoin :", // fr
  "Sea lo que sea — esto está aquí por si alguna vez lo quieres:", // es
  "Qualunque cosa sia — questi sono qui, se mai dovessi volerli:", // it
  "Seja o que for — isto está aqui, se alguma vez quiseres:", // pt
  "Vad det än är — de här finns här om du någonsin vill ha dem:", // sv
  "Uansett hva det er — disse er her om du noen gang vil ha dem:", // no
  "Uanset hvad det er — de her er her, hvis du nogensinde vil have dem:", // da
  "Cokolwiek to jest — to jest tu, gdyby kiedyś się przydało:", // pl
];

export const HELPLINE_BLOCK_MARKERS = [...BLOCK_INTROS, ...BLOCK_INTROS_AMBIGUOUS].map(
  (intro) => `—\n${intro}`,
);

/** English marker — kept for existing callers/tests. */
export const HELPLINE_BLOCK_MARKER = HELPLINE_BLOCK_MARKERS[0]!;

export interface SplitMessage {
  /** Eos's own words (what the bubble shows and TTS may speak). */
  body: string;
  /** The helpline block text, or null when the message has none. */
  block: string | null;
}

export function splitCrisisBlock(content: string): SplitMessage {
  for (const marker of HELPLINE_BLOCK_MARKERS) {
    const i = content.indexOf(marker);
    if (i !== -1) return { body: content.slice(0, i).trimEnd(), block: content.slice(i) };
  }
  return { body: content, block: null };
}
