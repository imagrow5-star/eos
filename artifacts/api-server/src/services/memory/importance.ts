// ─── Memory-fact importance ranking (Sprint 2A) ──────────────────────────────
// Pure, dependency-free scoring + tokenization so retrieval can rank facts by
// how much they actually matter to the user rather than "newest wins". Old but
// important facts (grief mentioned repeatedly over months) must outrank new
// trivial ones (mentioned once yesterday).

const MS_PER_DAY = 86_400_000;

/** Minimal English stop-word set for the reference matcher — kept small on
 *  purpose (common function words that would match everything and inflate
 *  reference counts). Tokens must also be ≥4 chars, which already filters most
 *  noise; this list catches the frequent 4+ letter fillers. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  "about", "above", "after", "again", "against", "already", "also", "always",
  "another", "anyone", "anything", "around", "because", "been", "before",
  "being", "below", "between", "both", "cannot", "could", "does", "doing",
  "done", "down", "during", "each", "either", "else", "even", "ever", "every",
  "from", "gonna", "gotta", "have", "having", "here", "into", "just", "kind",
  "like", "made", "make", "many", "maybe", "might", "more", "most", "much",
  "must", "never", "next", "only", "other", "over", "really", "same", "should",
  "since", "some", "somehow", "someone", "something", "sometimes", "still",
  "such", "sure", "than", "that", "their", "them", "then", "there", "these",
  "they", "thing", "things", "think", "this", "those", "through", "very",
  "want", "wanna", "well", "were", "what", "when", "where", "which", "while",
  "will", "with", "would", "your", "yours", "yeah", "okay",
]);

/**
 * Content tokens for matching: lowercase, ≥4 chars, no stop words, de-duped.
 * Word-boundary split on non-alphanumerics (apostrophes stripped, so
 * "mother's" → "mother"). Used both to derive a fact's key tokens and to scan
 * a message for references to it.
 */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of (text ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 4 && !STOP_WORDS.has(raw)) out.add(raw);
  }
  return out;
}

/** True when `message` references `factText` — shares at least one 4+ char
 *  non-stopword token. Case-insensitive, word-boundary (contentTokens). */
export function messageReferencesFact(message: string, factText: string): boolean {
  const factTokens = contentTokens(factText);
  if (factTokens.size === 0) return false;
  for (const tok of contentTokens(message)) {
    if (factTokens.has(tok)) return true;
  }
  return false;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

export interface ScorableFact {
  createdAt: Date | string;
  timesReferenced?: number | null;
  lastReferencedAt?: Date | string | null;
  emotionalWeight?: number | null;
  userMarkedImportant?: boolean | null;
}

function daysBetween(a: number, b: number): number {
  return (a - b) / MS_PER_DAY;
}

function toMs(v: Date | string | null | undefined): number | null {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Importance score for ranking (higher = more important). Pure function of the
 * fact's fields and the current time. See Sprint 2A spec for the formula.
 */
export function scoreFactImportance(fact: ScorableFact, nowTimestamp: number): number {
  const createdMs = toMs(fact.createdAt) ?? nowTimestamp;
  const daysSinceCreated = Math.max(0, daysBetween(nowTimestamp, createdMs));

  // Gentle recency decay — half-life ~62 days (exp(-t/90)).
  const recencyScore = Math.exp(-daysSinceCreated / 90) * 1.0;

  // Logarithmic frequency — saturates, so 100 references isn't 100× one.
  const timesReferenced = Math.max(0, fact.timesReferenced ?? 0);
  const frequencyScore = Math.log10(1 + timesReferenced) * 2.0;

  // Recent-reference boost — stepped windows off the last reference.
  let recentReferenceBoost = 0;
  const lastRefMs = toMs(fact.lastReferencedAt);
  if (lastRefMs != null) {
    const daysSinceLastRef = Math.max(0, daysBetween(nowTimestamp, lastRefMs));
    if (daysSinceLastRef <= 3) recentReferenceBoost = 5.0;
    else if (daysSinceLastRef <= 7) recentReferenceBoost = 2.0;
    else if (daysSinceLastRef <= 30) recentReferenceBoost = 0.5;
  }

  const emotionalWeightScore = Math.max(0, Math.min(1, fact.emotionalWeight ?? 0)) * 3.0;
  const userMarkedScore = fact.userMarkedImportant ? 10.0 : 0;

  return (
    recencyScore +
    frequencyScore +
    recentReferenceBoost +
    emotionalWeightScore +
    userMarkedScore
  );
}

/**
 * Rank facts by importance (desc) and take the top `limit`. Ties break by
 * newest-created so behaviour stays deterministic. Returns a new array; the
 * caller keeps whatever row shape it passed in.
 */
export function rankFactsByImportance<T extends ScorableFact>(
  facts: T[],
  nowTimestamp: number,
  limit: number,
): T[] {
  return [...facts]
    .map((f) => ({ f, score: scoreFactImportance(f, nowTimestamp), created: toMs(f.createdAt) ?? 0 }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : b.created - a.created))
    .slice(0, limit)
    .map((x) => x.f);
}

// ─── Category → emotional weight (backfill seed) ──────────────────────────────

/** Base emotional weight from a fact's category (Sprint 2A backfill heuristic). */
export function categoryEmotionalWeight(category: string): number {
  if (["value", "event", "goal", "person"].includes(category)) return 0.6;
  if (["life", "work", "routine"].includes(category)) return 0.4;
  return 0.2;
}
