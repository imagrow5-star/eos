// ─── Crisis detector — single source of truth ────────────────────────────────
// One regex list, shared by every surface that must recognise crisis language:
//   • weekly chapters (quote pools, story threads) — a crisis line must never
//     be replayed back to the user as a chapter quote;
//   • sealed notes — a crisis note is answered immediately, never sealed away;
//   • live chat + voice (the crisis floor) — a detected message guarantees the
//     reply carries localized helpline resources, independent of whether the
//     LLM follows the prompt-level safety instruction.
//
// Deliberately conservative: a false positive only narrows a quote pool or
// shows a dismissible helpline card once. Patterns are NAMED so crisis_events
// can record WHICH pattern fired without ever storing message content.
//
// Behavior contract: detection semantics match the original chapters/crisis.ts
// list — same regex sources, same order, OR semantics — with ONE deliberate
// exception (overdose_slang, see the inline note on that pattern).

export interface CrisisPattern {
  /** Short machine name recorded in crisis_events.pattern_matched. */
  name: string;
  re: RegExp;
}

export const CRISIS_PATTERNS: CrisisPattern[] = [
  { name: "explicit_suicidal_ideation", re: /\bkill(ing)? myself\b/i },
  { name: "suicide_reference",          re: /\bsuicid\w*/i },
  { name: "self_harm",                  re: /\bself[- ]?harm\w*/i },
  { name: "self_harm_intent",           re: /\bhurt(ing)? myself\b/i },
  { name: "self_injury",                re: /\bcut(ting)? myself\b/i },
  { name: "want_to_die",                re: /\bwant(ed)? to die\b/i },
  { name: "wish_dead",                  re: /\bwish(ed)? i (was|were) dead\b/i },
  { name: "wish_not_alive",             re: /\bwish(ed)? i (wasn'?t|weren'?t) (here|alive)\b/i },
  { name: "passive_ideation",           re: /\bdon'?t want to (be here|exist|live|wake up)\b/i },
  { name: "no_reason_to_live",          re: /\bno (reason|point) (to|in) (liv|go)\w*/i },
  { name: "end_it_all",                 re: /\bend (it all|my life|everything)\b/i },
  { name: "burden_belief",              re: /\bbetter off without me\b/i },
  { name: "cant_go_on",                 re: /\bcan'?t (go on|do this anymore|keep going)\b/i },
  { name: "overdose",                   re: /\boverdos\w*/i },
  // Deliberate delta from the original chapter list: /\bod'?d\b/ also matched
  // the everyday word "odd" — tolerable when it only narrowed a quote pool,
  // not acceptable now that a match shows the user a crisis card. "od'd" and
  // "oded" still fire; "odd" no longer does.
  { name: "overdose_slang",             re: /\bod(?:'d|ed)\b/i },
  { name: "life_not_worth_living",      re: /\bnot worth living\b/i },
  { name: "stop_existing",              re: /\bstop existing\b/i },
  { name: "disappear_forever",          re: /\bdisappear forever\b/i },
  { name: "no_way_out",                 re: /\bno way out\b/i },
];

export interface CrisisDetection {
  matched: boolean;
  /** Name of the first pattern that matched — only set when matched. */
  pattern?: string;
}

// ─── Non-English pattern sets (Sprint 1.6) ───────────────────────────────────
// Sources + covered-phrase lists live with the data: ./i18nPatterns.ts.
// JS \b is ASCII-only and misbehaves next to ä/ø/ż etc., so i18n sources are
// compiled here with unicode-aware boundaries instead.

import { I18N_CRISIS_PATTERNS } from "./i18nPatterns.js";

function compileI18n(source: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`, "iu");
}

const COMPILED_I18N: ReadonlyMap<string, CrisisPattern[]> = (() => {
  const map = new Map<string, CrisisPattern[]>();
  for (const [lang, patterns] of Object.entries(I18N_CRISIS_PATTERNS)) {
    map.set(lang, patterns.map((p) => ({ name: p.name, re: compileI18n(p.source) })));
  }
  return map;
})();

/**
 * Detect crisis language in `text`. `language` selects the additional pattern
 * set to run; the ENGLISH set ALWAYS runs too (union) — a user chatting in
 * German can still type an English crisis phrase, and both must fire.
 * Unknown/inactive language codes simply fall back to English-only, exactly
 * the pre-1.6 behavior.
 */
export function detectCrisis(text: string, language = "en"): CrisisDetection {
  const t = text ?? "";
  const i18n = language !== "en" ? COMPILED_I18N.get(language) : undefined;
  if (i18n) {
    for (const p of i18n) {
      if (p.re.test(t)) return { matched: true, pattern: p.name };
    }
  }
  for (const p of CRISIS_PATTERNS) {
    if (p.re.test(t)) return { matched: true, pattern: p.name };
  }
  return { matched: false };
}

/**
 * Boolean form used by the chapter engine's quote/thread filters and sealed
 * notes. Checks EVERY language's patterns (union across all sets): those
 * surfaces protect stored text whose language is unknown at call time, and
 * over-excluding a quote is always safe — replaying a crisis line never is.
 */
export function isCrisisText(text: string): boolean {
  const t = text ?? "";
  for (const p of CRISIS_PATTERNS) {
    if (p.re.test(t)) return true;
  }
  for (const patterns of COMPILED_I18N.values()) {
    for (const p of patterns) {
      if (p.re.test(t)) return true;
    }
  }
  return false;
}
