/**
 * The resume line after a mid-call reconnect (voice audit, PR 3).
 *
 * Hume's socket is a reconnecting one: a network blip redials into a NEW EVI
 * chat, whose first CLM request is an empty transcript, exactly like a fresh
 * call's. Until now that produced a second greeting, and every later turn
 * arrived without the conversation before the drop.
 *
 * When the person has already spoken in this call (a user row since the
 * call's issuedAt), the empty transcript is a reconnect, not a fresh call:
 * Eos says one short resume line instead of greeting again. The line is
 * spoken, not persisted. It is fixed per language so that, when it comes back
 * as the first assistant turn of the new chat's transcript, routes/voice-llm.ts
 * can recognise the reconnect and put the pre-drop turns back into context.
 *
 * Wording is speaker-gender-neutral in every language (Eos can have either
 * voice), which is why some say "it cut out" rather than "I lost you".
 */

export const RESUME_LINES: Record<string, string> = {
  en: "Sorry, I lost you for a second. Go on.",
  nl: "Sorry, ik was je even kwijt. Ga verder.",
  de: "Entschuldige, ich hatte dich kurz verloren. Erzähl weiter.",
  fr: "Pardon, ça a coupé une seconde. Continue.",
  es: "Perdona, te perdí un segundo. Sigue.",
  it: "Scusa, si è interrotto un attimo. Continua.",
  pt: "Desculpa, perdi-te por um segundo. Continua.",
  sv: "Förlåt, jag tappade dig en sekund. Fortsätt.",
  no: "Beklager, jeg mistet deg et øyeblikk. Fortsett.",
  da: "Undskyld, jeg mistede dig et øjeblik. Fortsæt.",
  pl: "Przepraszam, na chwilę się urwało. Mów dalej.",
};

/** The resume line for a language (English for any language without one). */
export function resumeLineFor(language: string | null | undefined): string {
  return RESUME_LINES[language ?? "en"] ?? RESUME_LINES.en!;
}

const ALL_RESUME_LINES = new Set(Object.values(RESUME_LINES).map((l) => l.trim()));

/** True when an assistant transcript turn is exactly a resume line. */
export function isResumeLine(text: string): boolean {
  return ALL_RESUME_LINES.has(text.trim());
}
