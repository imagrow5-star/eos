// ─── Quote validation — the hard gate ─────────────────────────────────────────
// A displayed quote that is not the user's verbatim words is a catastrophic
// failure for this feature. So quotes are never trusted from the model:
// the model may only PROPOSE (messageId, excerpt) pairs, and this module
// verifies — character for character — that the excerpt is a substring of
// that exact stored message before anything is persisted or rendered.

export interface QuoteSource {
  id: number;
  content: string;
  /** message created_at */
  createdAt: Date;
  /** YYYY-MM-DD in the user's timezone, precomputed by the caller */
  localDate: string;
}

export interface ValidatedQuote {
  messageId: number;
  text: string;
  /** YYYY-MM-DD (user-local) — rendered as the diary date next to the quote */
  date: string;
}

export const QUOTE_MIN_CHARS = 12;
export const QUOTE_MAX_CHARS = 360;

/**
 * Verbatim-substring gate. Returns the validated quote or null — never a
 * "close enough" match. No normalization beyond trimming the excerpt's outer
 * whitespace: if the model paraphrased, dropped a comma, or "fixed" a typo,
 * the quote is rejected.
 */
export function validateExcerpt(
  messageId: unknown,
  excerpt: unknown,
  pool: Map<number, QuoteSource>,
): ValidatedQuote | null {
  if (typeof messageId !== "number" || !Number.isInteger(messageId)) return null;
  if (typeof excerpt !== "string") return null;
  const text = excerpt.trim();
  if (text.length < QUOTE_MIN_CHARS || text.length > QUOTE_MAX_CHARS) return null;

  const src = pool.get(messageId);
  if (!src) return null; // unknown id, wrong era pool, dismissed, or crisis-filtered
  if (!src.content.includes(text)) return null; // not their verbatim words

  return { messageId, text, date: src.localDate };
}

function normalizeForSimilarity(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * "Then" and "now" quotes that are near-identical read as documented failure
 * ("you said the same thing twice, nothing changed"). Detect them so the
 * theme can be collapsed into "still true" framing with a single quote.
 */
export function nearIdentical(a: string, b: string): boolean {
  const na = normalizeForSimilarity(a);
  const nb = normalizeForSimilarity(b);
  if (na.length === 0 || nb.length === 0) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;

  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  const jaccard = overlap / (ta.size + tb.size - overlap);
  return jaccard >= 0.8;
}
