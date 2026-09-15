/**
 * Settle hold (voice). End of turn fires on pauses mid-thought — "…and uh.",
 * "…so." — and Hume re-sends the whole turn when the person carries on,
 * cancelling the request it just made. Rather than answer a turn that looks
 * unfinished straight away, the route HOLDS for a moment: if the person
 * resumes, Hume cancels and nothing is generated at all; if they don't, the
 * hold expires and the reply goes ahead, a little later than it would have.
 *
 * It's a hold with a ceiling, never a refusal: Hume only re-sends when the
 * person speaks, so a server that stayed silent on a filler-ending turn would
 * leave dead air whenever they really were done.
 *
 * The filler list is the one place that decides what "looks unfinished"
 * means. Keep it wide across accents and languages of English rather than
 * clever: the cost of a false positive is the hold, once.
 */

export const SETTLE_HOLD_MS = 1200;

/** A turn whose last word is one of these is probably not over. */
export const TRAILING_FILLERS: ReadonlySet<string> = new Set([
  // hesitation sounds, as the ASR spells them
  "uh", "uhh", "um", "umm", "uhm", "er", "erm", "err", "ah", "ahh", "eh", "hmm", "hm", "hmmm", "mm", "mmm", "huh",
  // words people hang on while they find the next one
  "like", "so", "and", "but", "or", "because", "cause", "cos", "then", "also", "plus",
  "that", "which", "if", "when", "where", "while", "although", "though", "whereas",
  // dangling prepositions, articles and pronouns
  "to", "of", "in", "on", "at", "for", "with", "from", "about", "into", "the", "a", "an",
  "i", "i'm", "i've", "i'd", "it's", "you", "we", "they", "he", "she", "my", "your",
  // transcript artefacts for a trailing sound
  "yeah-", "so-", "and-",
]);

/** Punctuation that marks a pause rather than an end: comma, ellipsis, dash. */
const TRAILING_PAUSE = /(?:,|…|\.\.\.|—|–|-)\s*$/;

/** Last word, lowercased, with terminal punctuation stripped. */
function lastWord(text: string): string {
  const words = text.toLowerCase().replace(/[.!?…]+\s*$/, "").trim().split(/\s+/);
  const w = words[words.length - 1] ?? "";
  return w.replace(/^[^a-z0-9']+|[^a-z0-9'-]+$/g, "");
}

/** True when the person's turn ends in a way that says "there's more coming". */
export function looksUnfinished(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (TRAILING_PAUSE.test(t)) return true;
  return TRAILING_FILLERS.has(lastWord(t));
}

/** Wait up to `ms`, ending early when `signal` fires. Never throws. */
export function settleHold(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
