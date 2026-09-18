/**
 * Output guard — a runtime backstop for two things a black-box eval caught
 * the model still emitting, both banned by the system prompt (the prompt is
 * the primary control; this is the second wall for when it slips):
 *
 *   1. the banned-comfort family — "I'm here for you / for that / for
 *      whatever …" (RULE 1);
 *   2. self-narration — naming its own machinery in the reply: a
 *      "*(stage direction)*", a "(Rule 8)" citation, or a Care-System mode
 *      name. This leaked on crisis turns, where the appended crisis block
 *      out-positions the disclosure rule.
 *
 * Deliberately narrow. It does NOT try to police the whole prompt by regex —
 * rewriting arbitrary language would mangle good replies. It targets only
 * unambiguous forms with clean removals, and never touches the crisis-scripted
 * bare lines "I'm here." / "I'm not going anywhere.".
 *
 * The `detect*` functions report which forms appear (for logging and the eval
 * endpoint's flags). The `strip*` functions remove/rewrite them. `guardReply`
 * applies both. Pure functions; never log anything themselves.
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

// ─── Self-narration: naming the machinery in the reply ───────────────────────

// Detection (broad, for logging/flags — reports what was found, not what can
// be safely removed).
const NARRATION_DETECT: Array<{ name: string; re: RegExp }> = [
  { name: "stage_direction", re: /\*\([^)]*\)\*/ },
  { name: "rule_citation", re: /\brule\s*\d+\b/i },
  { name: "care_system", re: /care system/i },
  { name: "mode_name", re: /\b(safe[- ]haven|secure base)\s+mode\b/i },
];

// Removal (narrow — only the unambiguous wrapped forms, whole).
const STAGE_DIRECTION = /\s*\*\([^)]*\)\*/g; // *(Now shifts to SAFE HAVEN mode …)*
// A parenthetical that OPENS with a machinery citation is removed whole, even
// when it carries trailing content: "(Rule 8)", "(Rule 8, Safe Haven)",
// "(Rule 8 dominates)", "(Care System Step 1)". A good reply never opens a
// parenthetical with one of these tokens, so the trailing `[^)]*` is safe.
const RULE_PAREN = /\s*\((?:rule\s*\d+|care system|step\s*[1-5]|(?:safe[- ]haven|secure base)\s+mode)[^)]*\)/gi;

/** The self-narration forms present in `text`, by machine name. Empty when clean. */
export function detectSelfNarration(text: string): string[] {
  return NARRATION_DETECT.filter((d) => d.re.test(text)).map((d) => d.name);
}

/**
 * Remove the wrapped self-narration forms (a "*(…)*" stage direction and a
 * "(Rule N)" / "(Care System Step N)" / "(… mode)" citation), then tidy the
 * spacing the removal leaves behind. Reports the forms that were present.
 */
export function stripSelfNarration(text: string): StripResult {
  const hits = detectSelfNarration(text);
  if (hits.length === 0) return { text, hits };
  const out = text
    .replace(STAGE_DIRECTION, "")
    .replace(RULE_PAREN, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,!?;:])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return { text: out, hits };
}

export interface GuardResult {
  text: string;
  bannedComfort: string[];
  selfNarration: string[];
}

/** Apply both guards to a reply. Returns the cleaned text and what each found. */
export function guardReply(text: string): GuardResult {
  const a = stripBannedComfort(text);
  const b = stripSelfNarration(a.text);
  return { text: b.text, bannedComfort: a.hits, selfNarration: b.hits };
}
