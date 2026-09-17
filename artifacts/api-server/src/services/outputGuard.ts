/**
 * Rule 1 output guard — a runtime backstop for the one banned-comfort family
 * a black-box eval caught the model still emitting: "I'm here for you",
 * "I'm here for that", "I'm here for whatever …". The system prompt bans
 * these (RULE 1), and the prompt is the primary control; this is the second
 * wall for when the model slips.
 *
 * Deliberately narrow. It does NOT try to police the whole Rule 1 list by
 * regex — rewriting arbitrary comfort language would mangle good replies.
 * It targets only the "I'm here for <x>" construction, which has a clean,
 * in-register replacement ("I'm right here") and never overlaps the
 * crisis-scripted bare lines "I'm here." / "I'm not going anywhere.", which
 * this guard leaves untouched.
 *
 * `detectBannedComfort` reports which variants appear (for logging and for
 * the eval endpoint's flags). `stripBannedComfort` rewrites them. Pure
 * functions; never logs anything itself.
 */

interface BannedRule {
  /** Machine name recorded in logs/flags — never the message text. */
  name: string;
  re: RegExp;
  /** Replacement for the matched span. */
  replacement: string;
}

// "for whatever …" eats to the sentence boundary so the rewrite stays
// grammatical ("I'm here for whatever you're exploring." → "I'm right here.").
const RULES: BannedRule[] = [
  { name: "here_for_you", re: /\bi['’ ]?a?m\s+here\s+for\s+you\b/gi, replacement: "I'm right here" },
  { name: "here_for_that", re: /\bi['’ ]?a?m\s+here\s+for\s+that\b/gi, replacement: "I'm right here" },
  { name: "here_for_whatever", re: /\bi['’ ]?a?m\s+here\s+for\s+whatever\b[^.!?\n]*/gi, replacement: "I'm right here" },
];

/** The banned-comfort variants present in `text`, by machine name. Empty when clean. */
export function detectBannedComfort(text: string): string[] {
  const hits: string[] = [];
  for (const r of RULES) {
    r.re.lastIndex = 0;
    if (r.re.test(text)) hits.push(r.name);
  }
  return hits;
}

export interface StripResult {
  text: string;
  hits: string[];
}

/** Rewrite the banned-comfort family to "I'm right here", reporting what was hit. */
export function stripBannedComfort(text: string): StripResult {
  const hits = detectBannedComfort(text);
  if (hits.length === 0) return { text, hits };
  let out = text;
  for (const r of RULES) {
    r.re.lastIndex = 0;
    out = out.replace(r.re, r.replacement);
  }
  return { text: out, hits };
}
