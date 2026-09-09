/**
 * Story language gates — the hard rules for every sentence Eos writes into
 * a story card (goals, routines, and any model-written prose in period
 * stories). Deterministic, always on, applied to Eos's prose only — never to
 * the user's quoted words.
 *
 * A card that fails is DROPPED, never rewritten or retried: a card that had
 * to be sanitised probably shouldn't exist. Every drop is recorded with its
 * reasons (services/storyDrops.ts) so the prompt and these gates can be
 * tuned against what the model actually tries to write.
 *
 * The rules, from the spec ("Hard rules — all stories"):
 *  - never reference the absence of action ("you haven't", "still nothing");
 *  - never "why didn't you";
 *  - no controlling language ("you should", "you need to", "don't forget");
 *  - no person praise ("you're so disciplined") — the action only;
 *  - no generic encouragement ("you've got this", "great week");
 *  - no streaks, consecutive-day counts, scores, percentiles;
 *  - no inferred emotional states — never tell someone what they felt.
 * Plus the chapter engine's kind-truth scrubs (clinical labels, verdicts,
 * digit-counts, timestamps, regression framing).
 */

import { deterministicViolations } from "./chapters/kindTruth.js";

interface Gate {
  reason: string;
  re: RegExp;
}

const GATES: Gate[] = [
  // Absence of action — an empty day must never become evidence about them.
  { reason: "references absence of action", re: /\byou (?:still )?haven['’]?t\b/i },
  { reason: "references absence of action", re: /\byou (?:still )?didn['’]?t\b/i },
  { reason: "references absence of action", re: /\bstill nothing\b/i },
  { reason: "references absence of action", re: /\bnothing(?:'s| has| yet)? (?:happened|changed|moved)\b/i },
  { reason: "references absence of action", re: /\bno (?:progress|movement|update|sign)\b/i },
  { reason: "references absence of action", re: /\bnot (?:yet )?(?:done|started|touched|happened)\b/i },
  { reason: "references absence of action", re: /\b(?:another|a) (?:day|week) (?:without|with no)\b/i },
  // "Why didn't you", in any form.
  { reason: "asks why not", re: /\bwhy (?:didn['’]?t|haven['’]?t|not|aren['’]?t|won['’]?t) you\b/i },
  { reason: "asks why not", re: /\bwhat (?:stopped|held) you\b/i },
  // Controlling language.
  { reason: "controlling language", re: /\byou (?:should|shouldn['’]?t|need to|must|have to|ought to|had better)\b/i },
  { reason: "controlling language", re: /\bdon['’]?t forget\b/i },
  { reason: "controlling language", re: /\bmake sure (?:you|to)\b/i },
  { reason: "controlling language", re: /\btry to\b/i },
  { reason: "controlling language", re: /\bremember to\b/i },
  // Person praise — the action may be acknowledged, the person is never rated.
  { reason: "praises the person", re: /\byou['’]?re (?:so |very |really |such a |a |an )?(?:disciplined|strong|brave|amazing|incredible|inspiring|resilient|dedicated|committed|consistent|a warrior|a star|a rockstar|a champion|awesome|wonderful|impressive|capable)\b/i },
  { reason: "praises the person", re: /\b(?:so |very |really )?proud of you\b/i },
  { reason: "praises the person", re: /\bgood (?:girl|boy|for you)\b/i },
  { reason: "praises the person", re: /\byou (?:are|were) (?:so |really |very )?(?:disciplined|strong|brave|amazing|incredible|resilient)\b/i },
  // Generic encouragement.
  { reason: "generic encouragement", re: /\byou['’]?ve got this\b/i },
  { reason: "generic encouragement", re: /\byou (?:can|will) do (?:it|this)\b/i },
  { reason: "generic encouragement", re: /\bgreat (?:week|job|work|effort|start|going)\b/i },
  { reason: "generic encouragement", re: /\b(?:well done|nice work|nice one|good job|way to go|keep it up|keep going|keep at it|stay positive|stay strong|hang in there|believe in yourself|onwards and upwards|you got this)\b/i },
  { reason: "generic encouragement", re: /\b(?:crushing|smashing|killing|nailing) it\b/i },
  // Streaks, chains, scores.
  { reason: "streak or chain count", re: /\bstreak\b/i },
  { reason: "streak or chain count", re: /\bin a row\b/i },
  { reason: "streak or chain count", re: /\bconsecutive\b/i },
  { reason: "streak or chain count", re: /\b(?:\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirty|sixty|ninety)[- ]days? (?:running|straight|and counting)\b/i },
  { reason: "streak or chain count", re: /\bday (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten) of\b/i },
  { reason: "streak or chain count", re: /\b(?:chain|unbroken|broke (?:the|your) (?:chain|run))\b/i },
  { reason: "score or percentile", re: /\b(?:score|percentile|rank|rating|points?)\b/i },
  { reason: "score or percentile", re: /\d+\s*%/ },
  // Inferred emotional states — never tell someone what they felt.
  { reason: "infers an emotional state", re: /\byou (?:must|probably|clearly|obviously|seem(?:ed)? to|seem|seemed|sound(?:ed)?|look(?:ed)?) (?:to )?(?:feel|felt|be|have felt|be feeling|have been)\b/i },
  { reason: "infers an emotional state", re: /\byou (?:felt|feel|were feeling|are feeling|must have felt)\b/i },
  { reason: "infers an emotional state", re: /\bthat must (?:have been|be|feel)\b/i },
  { reason: "infers an emotional state", re: /\byou (?:seem|seemed|sound|sounded|look|looked|must be|must have been|were|are) (?:a bit |a little |so |really |pretty |quite |clearly |probably )?(?:anxious|sad|lonely|scared|afraid|angry|frustrated|overwhelmed|exhausted|ashamed|guilty|hopeful|happy|excited|proud|low|down|stressed|tired|relieved|nervous|worried|upset|hurt|lighter|heavier|calmer|brighter)\b/i },
  { reason: "infers an emotional state", re: /\byou['’]?re (?:probably |clearly |obviously )?(?:anxious|sad|lonely|scared|afraid|angry|frustrated|overwhelmed|exhausted|ashamed|guilty|hopeful|happy|excited|proud)\b/i },
];

/** Reasons a piece of Eos prose fails the story gates. Empty means it passes. */
export function storyGateViolations(text: string): string[] {
  const t = (text ?? "").replace(/\s+/g, " ");
  const reasons = new Set<string>();
  for (const g of GATES) if (g.re.test(t)) reasons.add(g.reason);
  // The chapter scrubs, minus the clock rule: a card quoting their own words
  // may carry a time they said ("the gym after 6pm never happens").
  for (const r of deterministicViolations(t)) {
    if (r === "timestamp of user behavior") continue;
    reasons.add(`kind-truth: ${r}`);
  }
  return [...reasons];
}

/** A state-A card must reflect the actual thing back in their words: some
 *  run of three consecutive words from the verbatim excerpt has to appear in
 *  the card. Case-insensitive; punctuation ignored. */
export function reflectsExcerpt(cardText: string, excerpt: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[’]/g, "'")
      .replace(/[^a-z0-9'\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  const card = ` ${norm(cardText).join(" ")} `;
  const words = norm(excerpt);
  if (words.length < 3) return words.length > 0 && card.includes(` ${words.join(" ")} `);
  for (let i = 0; i + 3 <= words.length; i++) {
    if (card.includes(` ${words.slice(i, i + 3).join(" ")} `)) return true;
  }
  return false;
}
