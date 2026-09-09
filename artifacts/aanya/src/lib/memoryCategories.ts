/**
 * Memory categories — how facts group into the rows on the Memory page.
 *
 * Extraction files facts under ten categories. Five have always had a row
 * (preference, person, event, goal, life). The other five (interest,
 * routine, work, value, soother) were stored and counted but never shown —
 * a fact that is counted but invisible is worse than not storing it. They
 * now FOLD into the nearest row (interest → Preferences; routine, work,
 * value, soother → Life), unless a person has enough of one for it to
 * deserve its own row (PROMOTE_AT), in which case it stands alone with its
 * own label. Pure, so it is unit-tested.
 */

export interface MemoryFactLike {
  id: number;
  fact: string;
  category: string;
  userMarkedImportant?: boolean;
}

export interface MemoryCategoryRow<F extends MemoryFactLike = MemoryFactLike> {
  /** Route segment: /memory/:id */
  id: string;
  label: string;
  facts: F[];
  count: number;
  /** The most recent entry — facts arrive newest first from the API. */
  preview: string | null;
}

export const BASE_CATEGORIES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "preference", label: "Preferences" },
  { id: "person", label: "People" },
  { id: "event", label: "Moments" },
  { id: "goal", label: "Hopes" },
  { id: "life", label: "Life" },
];

/** The hidden five: their own label if promoted, and where they fold otherwise. */
export const HIDDEN_CATEGORIES: ReadonlyArray<{ id: string; label: string; foldInto: string }> = [
  { id: "interest", label: "Interests", foldInto: "preference" },
  { id: "routine", label: "Routines", foldInto: "life" },
  { id: "work", label: "Work", foldInto: "life" },
  { id: "value", label: "What matters", foldInto: "life" },
  { id: "soother", label: "What helps", foldInto: "life" },
];

/** A hidden category with this many facts or more gets its own row. */
export const PROMOTE_AT = 5;

export const FEELINGS_ROW = { id: "feelings", label: "How things have felt" } as const;

export function categoryLabel(id: string): string | null {
  if (id === FEELINGS_ROW.id) return FEELINGS_ROW.label;
  return BASE_CATEGORIES.find((c) => c.id === id)?.label ?? HIDDEN_CATEGORIES.find((c) => c.id === id)?.label ?? null;
}

/**
 * Groups facts into rows, in display order: the five base rows, then any
 * promoted hidden category, each only when it has at least one fact. A fact
 * with an unknown category folds into Life so nothing is ever invisible.
 */
export function groupFacts<F extends MemoryFactLike>(facts: F[], promoteAt: number = PROMOTE_AT): MemoryCategoryRow<F>[] {
  const byCategory = new Map<string, F[]>();
  for (const f of facts) {
    const list = byCategory.get(f.category) ?? [];
    list.push(f);
    byCategory.set(f.category, list);
  }

  const buckets = new Map<string, F[]>();
  const push = (id: string, list: F[]) => buckets.set(id, [...(buckets.get(id) ?? []), ...list]);
  for (const c of BASE_CATEGORIES) push(c.id, byCategory.get(c.id) ?? []);

  const promoted: string[] = [];
  for (const h of HIDDEN_CATEGORIES) {
    const list = byCategory.get(h.id) ?? [];
    if (list.length >= promoteAt) {
      buckets.set(h.id, list);
      promoted.push(h.id);
    } else {
      push(h.foldInto, list);
    }
  }
  // Anything extraction files under a category this file doesn't know.
  const known = new Set([...BASE_CATEGORIES.map((c) => c.id), ...HIDDEN_CATEGORIES.map((c) => c.id)]);
  for (const [id, list] of byCategory) if (!known.has(id)) push("life", list);

  const order = [...BASE_CATEGORIES.map((c) => c.id), ...promoted];
  return order
    .map((id) => {
      const list = buckets.get(id) ?? [];
      return { id, label: categoryLabel(id) ?? id, facts: list, count: list.length, preview: list[0]?.fact ?? null };
    })
    .filter((row) => row.count > 0);
}

/** The facts that belong on one category screen (same folding rules). */
export function factsForCategory<F extends MemoryFactLike>(facts: F[], id: string, promoteAt: number = PROMOTE_AT): MemoryCategoryRow<F> | null {
  return groupFacts(facts, promoteAt).find((row) => row.id === id) ?? null;
}
