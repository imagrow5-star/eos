// ─── Sealed notes — helpers for the chapter's closing ritual ─────────────────
// The write path (routes/chapters.ts) runs crisis detection IMMEDIATELY and
// returns a caring response in the same reply — never a seven-day timer.
// The resolve path (generate.ts) quotes the note verbatim from the DB row (the
// model never invents the user's words) and passes every resolution sentence
// through the kind-truth gates. Crisis-flagged notes are NEVER quoted back:
// they get a fixed warm acknowledgment instead.

import { and, asc, eq } from "drizzle-orm";
import { db, sealedNotesTable, type SealedNote } from "@workspace/db";

export const NOTE_MAX_LENGTH = 280; // one sentence to next-week's you — not a diary page

export const FALLBACK_NOTE_PROMPT = "Take a guess — where do you think your head will be this time next week?";

// Shown as the resolution when the sealed note was crisis-flagged at write
// time. Deliberately does NOT quote or paraphrase the note.
export const CRISIS_NOTE_RESOLUTION =
  "You left yourself a note from a heavy night. I'm not going to read it back to you — those words already had their moment, and they don't get to define this week. What matters is what actually happened: you're here, another week in. I'm glad.";

// Safe fallback when a generated resolution keeps failing the kind-truth
// gates: warm, zero verdict, zero interpretation of how the week "scored".
export const FALLBACK_RESOLUTION =
  "However this week actually went next to those words, I'm keeping them gently — not as a test you had to pass, just as proof that you keep showing up for yourself. That's the part I'd underline.";

/** The single warm line Eos returns the moment a crisis-flagged note is written. */
export function crisisCareMessage(userName: string, crisisLine: string): string {
  const name = userName || "you";
  return `I'm not sealing that one away for a week, ${name} — it matters right now. I'm really glad you told me. Please reach out to someone who can truly be there tonight — ${crisisLine} And I'm here too, right now, if you want to keep talking.`;
}

/** Oldest unresolved note — the one the next chapter will open with. */
export async function fetchPendingSealedNote(userId: number): Promise<SealedNote | null> {
  const [note] = await db
    .select()
    .from(sealedNotesTable)
    .where(and(eq(sealedNotesTable.userId, userId), eq(sealedNotesTable.status, "sealed")))
    .orderBy(asc(sealedNotesTable.createdAt))
    .limit(1);
  return note ?? null;
}

/**
 * Prompt for the seal-resolution paragraph. The safety framing is structural:
 * the model is told what the note was and how the week looked, and is bound to
 * the forecasting-not-failure rule — a worse-than-predicted week is ALWAYS
 * framed as information about how they forecast, never as evidence against
 * them. Output still passes deterministic + AI kind-truth gates afterwards.
 */
export function resolutionPrompt(opts: {
  companionName: string;
  userName: string;
  noteKind: string;
  notePrompt: string | null;
  noteText: string;
  weekBrief: string; // neutral summary of how the week actually looked
}): string {
  return `You are ${opts.companionName}. A week ago, at the end of their last chapter, ${opts.userName} sealed one sentence for this-week's self${opts.noteKind === "prediction" ? ` (answering your question: "${opts.notePrompt ?? ""}")` : ""}:

THEIR SEALED NOTE (their exact words — the UI shows them before your paragraph):
"${opts.noteText}"

HOW THE WEEK ACTUALLY LOOKED (neutral notes for you only):
${opts.weekBrief}

Write 2–4 sentences that resolve the note warmly — the moment right after the seal breaks.

HARD RULES:
- The note is NEVER evidence against them. If the week went worse than the note hoped or predicted, the gap is information about FORECASTING, not failure — e.g. "your predictions run darker than your weeks actually go". Never "you said you'd X but you didn't".
- If they predicted something dark and it didn't happen, name what they did instead with quiet pride — e.g. "You predicted you'd spiral. You called me instead. That's new."
- If the week genuinely was heavy, honor the note's honesty and their being here anyway — no silver-lining reflex, no "at least".
- Zero digits, zero percentages, zero timestamps, no clinical words, no verdicts, no advice.
- Do not re-quote their whole note back (the UI already shows it) — you may echo at most a couple of their words.
- End looking forward lightly, never with homework.

Respond with ONLY the paragraph text, no JSON, no quotes around it.`;
}
