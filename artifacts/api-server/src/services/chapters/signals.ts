// ─── Language trend signals ───────────────────────────────────────────────────
// Computed INTERNALLY ONLY to guide quote selection for weekly chapters.
// These numbers must never be stored on a chapter row, returned by any API,
// or rendered anywhere. They exist so the selection prompt can be pointed at
// real linguistic movement ("absolutist words are softening") instead of
// guessing — the user only ever sees their own quoted words.

export interface LanguageSignals {
  wordCount: number;
  /** "we/us/our" per 1000 words — often falls as a past relationship loosens */
  weRate: number;
  /** always/never/completely/ruined/etc per 1000 words — black-and-white thinking */
  absolutistRate: number;
  /** because/realize/understand/etc per 1000 words — sense-making language */
  analyticRate: number;
  /** I/me/my per 1000 words — self-focus density */
  iRate: number;
}

const WE_WORDS = new Set(["we", "us", "our", "ours", "ourselves"]);
const I_WORDS = new Set(["i", "me", "my", "mine", "myself", "im", "i'm", "ive", "i've"]);
const ABSOLUTIST = new Set([
  "always", "never", "completely", "totally", "entirely", "ruined", "destroyed",
  "everything", "nothing", "everyone", "nobody", "forever", "impossible",
  "worthless", "hopeless", "unbearable", "every", "all",
]);
const ANALYTIC = new Set([
  "because", "realize", "realized", "realizing", "understand", "understood",
  "reason", "reasons", "why", "learned", "learning", "noticed", "noticing",
  "pattern", "makes", "sense", "perspective", "actually", "think", "thinking",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z'\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

export function computeSignals(texts: string[]): LanguageSignals {
  let words = 0;
  let we = 0;
  let abs = 0;
  let ana = 0;
  let i = 0;
  for (const text of texts) {
    for (const tok of tokenize(text)) {
      words++;
      if (WE_WORDS.has(tok)) we++;
      if (I_WORDS.has(tok)) i++;
      if (ABSOLUTIST.has(tok)) abs++;
      if (ANALYTIC.has(tok)) ana++;
    }
  }
  const per1k = (n: number) => (words === 0 ? 0 : (n / words) * 1000);
  return {
    wordCount: words,
    weRate: per1k(we),
    absolutistRate: per1k(abs),
    analyticRate: per1k(ana),
    iRate: per1k(i),
  };
}

/**
 * Turns a then-vs-now comparison into short internal guidance prose for the
 * selection prompt. Deliberately vague about magnitudes — the point is
 * direction, and none of this is ever shown to the user.
 */
export function describeSignalShift(before: LanguageSignals, now: LanguageSignals): string {
  if (before.wordCount < 120 || now.wordCount < 120) {
    return "Not enough text to read language trends this week — select on meaning alone.";
  }
  const notes: string[] = [];
  const moved = (a: number, b: number) => Math.abs(a - b) >= Math.max(1.5, a * 0.25);

  if (moved(before.weRate, now.weRate)) {
    notes.push(
      now.weRate < before.weRate
        ? `"we/us" language is receding — their story is becoming more their own`
        : `"we/us" language is rising — new closeness, or the past pulling back in; read the content to tell which`,
    );
  }
  if (moved(before.absolutistRate, now.absolutistRate)) {
    notes.push(
      now.absolutistRate < before.absolutistRate
        ? `absolute words (always/never/ruined) are softening — good place to find a then/now pair`
        : `absolute words are up this week — be extra gentle; prefer "still true" framing over contrast`,
    );
  }
  if (moved(before.analyticRate, now.analyticRate) && now.analyticRate > before.analyticRate) {
    notes.push(`sense-making language (because/realized/understand) is rising — they are processing, not just feeling`);
  }
  if (moved(before.iRate, now.iRate)) {
    notes.push(
      now.iRate > before.iRate
        ? `self-focus is denser this week — likely heavier inward weather`
        : `self-focus is loosening a little`,
    );
  }
  if (notes.length === 0) return "Language trends look steady week-over-week — select on meaning alone.";
  return `Internal linguistic drift (guide selection only, NEVER mention or imply measurement): ${notes.join("; ")}.`;
}
