// ─── Crisis helpline block — client-side split ───────────────────────────────
// The crisis floor appends a helpline block to the assistant message content
// (so history and exports carry it). The block always starts with this exact
// marker — kept in sync BY HAND with HELPLINE_BLOCK_MARKER in
// artifacts/api-server/src/services/crisis/helplines.ts. Splitting on it lets
// the UI render Eos's words as a normal bubble and the resources as a
// distinct, dismissible card (and keeps helplines out of TTS).

export const HELPLINE_BLOCK_MARKER =
  "—\nSomeone who can be with you right now, if you want to reach:";

export interface SplitMessage {
  /** Eos's own words (what the bubble shows and TTS may speak). */
  body: string;
  /** The helpline block text, or null when the message has none. */
  block: string | null;
}

export function splitCrisisBlock(content: string): SplitMessage {
  const i = content.indexOf(HELPLINE_BLOCK_MARKER);
  if (i === -1) return { body: content, block: null };
  return { body: content.slice(0, i).trimEnd(), block: content.slice(i) };
}
