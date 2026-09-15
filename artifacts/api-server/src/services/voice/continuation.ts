/**
 * Accumulating transcripts (voice). When end of turn fires on a pause
 * mid-thought, Hume sends the whole utterance again with the new words on the
 * end, and the ASR may have revised a word or two earlier in it:
 *   "Uh. Nothing much uh. Everyday routine I go to gym and I came back and uh."
 *   "Uh. Nothing much uh. Everyday routine I go to gym and came back and uh. Eating well…"
 * Stored as two rows, history carries the same sentence five times over a
 * long turn. The rule here says when a new user turn is the previous one
 * continued, so the caller can replace the row instead of adding one.
 *
 * Tolerant on purpose: compared on lowercased word tokens, the new turn must
 * be longer, and the previous turn's words must nearly all appear in the
 * new turn's opening stretch (ASR revisions drop or change a word).
 */

export function transcriptTokens(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9À-ɏЀ-ӿऀ-ॿ']+/)
    .filter((t) => t.length > 0);
}

/** How many of `prev`'s words appear (as a multiset) in `next`'s opening stretch. */
function coveredWords(prev: string[], head: string[]): number {
  const pool = new Map<string, number>();
  for (const t of head) pool.set(t, (pool.get(t) ?? 0) + 1);
  let covered = 0;
  for (const t of prev) {
    const n = pool.get(t) ?? 0;
    if (n > 0) {
      covered += 1;
      pool.set(t, n - 1);
    }
  }
  return covered;
}

/** Minimum share of the previous turn's words that must survive in the new one. */
export const CONTINUATION_MIN_COVERAGE = 0.8;

/**
 * True when `next` is `prev` re-sent: with more said after it, or the same
 * stretch with a word or two revised by the ASR (same length, different
 * words). Never when `next` is shorter, or the identical text. Short
 * previous turns need every word to survive.
 */
export function isContinuationOf(prev: string, next: string): boolean {
  if (prev === next) return false;
  const p = transcriptTokens(prev);
  const n = transcriptTokens(next);
  if (p.length === 0 || n.length < p.length) return false;
  if (n.length === p.length && n.every((t, i) => t === p[i])) return false; // punctuation-only change
  // The shared part sits at the start of `next`; allow two words of slack for
  // a revision that added a word.
  const head = n.slice(0, p.length + 2);
  const covered = coveredWords(p, head);
  const needed = p.length < 5 ? p.length : Math.ceil(p.length * CONTINUATION_MIN_COVERAGE);
  return covered >= needed;
}
