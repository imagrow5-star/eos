// ─── Crisis screen for quote candidates ──────────────────────────────────────
// Messages that touch self-harm or acute despair must NEVER be replayed back
// to the user as chapter quotes — a chapter may reference that era softly
// ("the middle of June carried the heaviest nights") but never the sentence.
// This filter runs BEFORE candidates ever reach the selection model, so a
// crisis line cannot be selected even if the model misbehaves.
//
// Deliberately conservative: a false positive only narrows the quote pool.

const CRISIS_PATTERNS: RegExp[] = [
  /\bkill(ing)? myself\b/i,
  /\bsuicid\w*/i,
  /\bself[- ]?harm\w*/i,
  /\bhurt(ing)? myself\b/i,
  /\bcut(ting)? myself\b/i,
  /\bwant(ed)? to die\b/i,
  /\bwish(ed)? i (was|were) dead\b/i,
  /\bwish(ed)? i (wasn'?t|weren'?t) (here|alive)\b/i,
  /\bdon'?t want to (be here|exist|live|wake up)\b/i,
  /\bno (reason|point) (to|in) (liv|go)\w*/i,
  /\bend (it all|my life|everything)\b/i,
  /\bbetter off without me\b/i,
  /\bcan'?t (go on|do this anymore|keep going)\b/i,
  /\boverdos\w*/i,
  /\bod'?d\b/i,
  /\bnot worth living\b/i,
  /\bstop existing\b/i,
  /\bdisappear forever\b/i,
  /\bno way out\b/i,
];

export function isCrisisText(text: string): boolean {
  const t = text ?? "";
  return CRISIS_PATTERNS.some((re) => re.test(t));
}
