/**
 * Kind streak — Eos's forgiving streak semantics.
 *
 * A streak here counts the days you showed up, and a missed day simply
 * pauses the count — it NEVER resets it. This matches the product's
 * philosophy copy ("Never goes down — rest days just pause the clock",
 * "missing one day won't break it") and replaces the old
 * consecutive-days-ending-today computation, which collapsed a 30-day
 * effort to 1 after a single hard day.
 *
 * Implementation: the count of distinct days present. Gaps between them
 * are pauses, not failures.
 */
export function kindStreak(dates: Iterable<string>): number {
  const distinct = new Set<string>();
  for (const d of dates) {
    if (d) distinct.add(d);
  }
  return distinct.size;
}
