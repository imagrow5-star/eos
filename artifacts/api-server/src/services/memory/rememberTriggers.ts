// ─── "Remember this" intent detection (Sprint 2B) ────────────────────────────
// Detects when a user is explicitly asking Eos to hold onto something, so the
// fact(s) extracted from that message get the +10 importance boost Sprint 2A
// reserved (see memory/importance.ts). Pure and dependency-free.

/**
 * The English trigger phrases. Exported so the guardrail test can assert that
 * adding a new one is paired with an i18n TODO for the other languages.
 *
 * TODO(i18n): these are ENGLISH ONLY. The app supports 10 other active
 * languages — Dutch (nl), German (de), French (fr), Spanish (es), Italian (it),
 * Portuguese (pt), Swedish (sv), Norwegian (no), Danish (da), Polish (pl) — each
 * of which needs its own native "remember this" trigger set before the feature
 * works for those users. Do NOT machine-translate these: idiomatic "please hold
 * onto this" phrasing needs native speakers. Follow-up sprint; keyed on the
 * `language` param below.
 */
export const REMEMBER_TRIGGERS_EN = [
  "remember this",
  "please remember",
  "don't forget",
  "make a note",
  "important to me",
  "keep this in mind",
] as const;

// Unambiguous asks — fire regardless of surrounding context.
const STRONG_TRIGGERS: RegExp[] = [
  /\bplease remember\b/,
  /\bdon'?t forget\b/,
  /\bmake a note\b/,
  /\bimportant to me\b/,
  /\bkeep this in mind\b/,
];

// "remember this" is only a real ASK when it isn't a past reference, a
// question, or the user recalling something themselves.
const RECALL_GUARDS: RegExp[] = [
  /\bremember when\b/, //     past reference   — "remember when we..."
  /\bdo you remember\b/, //   question         — "do you remember this?"
  /\bi remember\b/, //        user recalling   — "I remember this place"
];

/**
 * True when `messageContent` is an explicit request for Eos to remember
 * something. Case-insensitive, whitespace- and apostrophe-tolerant, whole-phrase
 * (never sub-word).
 *
 * `language` is accepted for the future per-language trigger sets (see the
 * i18n TODO above); today the English set is applied for everyone, so a
 * bilingual user typing an English phrase is still heard.
 */
export function detectRememberIntent(messageContent: string, language: string): boolean {
  void language; // English-only for now — see TODO(i18n) on REMEMBER_TRIGGERS_EN.
  if (!messageContent) return false;

  // Normalize: lowercase, straighten curly apostrophes, collapse whitespace,
  // and pad with spaces so \b anchoring behaves at the edges.
  const t = ` ${messageContent.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim()} `;

  if (STRONG_TRIGGERS.some((re) => re.test(t))) return true;

  if (/\bremember this\b/.test(t)) {
    // A request UNLESS it's a recall/question ("do you remember this",
    // "I remember this", "remember when ... this").
    if (RECALL_GUARDS.some((re) => re.test(t))) return false;
    return true;
  }

  return false;
}
