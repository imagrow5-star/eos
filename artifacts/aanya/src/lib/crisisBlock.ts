// ─── Crisis helpline block — client-side split ───────────────────────────────
// The crisis floor appends a helpline block to the assistant message content
// (so history and exports carry it). The block always starts with "—\n" plus
// a language-specific intro line — kept in sync BY HAND with
// HELPLINE_BLOCK_COPY in api-server services/crisis/helplines.ts. Splitting
// on whichever marker occurs lets the UI render Eos's words as a normal
// bubble and the resources as a distinct, dismissible card (and keeps
// helplines out of TTS) in every language.

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

export const HELPLINE_BLOCK_MARKERS = BLOCK_INTROS.map((intro) => `—\n${intro}`);

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
