import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, commitmentsTable, memoryFactsTable, goalsTable } from "@workspace/db";

// ─── Morning-note thread selection (shared) ───────────────────────────────────
// One place that decides WHAT a proactive morning note/greeting may bring up,
// so the contextual greeting, the in-app morning note, and the daily email all
// behave the same. Fixes the "asks about a 3-week-old one-time meeting every
// morning" bug by distinguishing the KIND of remembered thing and how fresh it
// is — reusing the memory that already exists (commitments, memory_facts.category,
// the goals table). No parallel classification system.
//
// The rules (from the product ask):
//  1. One-time / time-bound EVENTS expire — ask at most once, then stop. A
//     commitment follow-up is dropped once it's older than the staleness window,
//     and an "event" fact ages out of the reference set.
//  2. Ongoing GOALS should recur — a live goal is the thing to lean on when
//     there's no fresh material.
//  3. FEELINGS are never turned into a daily task-question here (feelings live
//     in their own table and are deliberately NOT surfaced as morning questions).
//  4. "Asked but not answered" — once something is surfaced, it's stamped and
//     not re-surfaced within a cooldown, so an unanswered question isn't repeated
//     the next day.

/** A follow-up whose scheduled date is older than this is stale — never ask. */
export const STALE_FOLLOWUP_DAYS = 10;
/** Don't re-surface the same item within this many days of last asking it. */
export const ASK_COOLDOWN_DAYS = 3;
/** A one-time "event" fact older than this stops being offered as a thread. */
export const EVENT_FRESH_DAYS = 10;

export interface FollowUpCommitment {
  id: number;
  content: string;
  cue: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
}

/**
 * Open commitments genuinely due for a follow-up: the scheduled follow-up date
 * has arrived AND it isn't stale (older than the window) AND we haven't already
 * asked within the cooldown. This is the fix for the every-morning re-ask — a
 * follow-up from three weeks ago no longer qualifies.
 */
export async function selectFollowUpCommitments(
  userId: number,
  today: string,
  limit = 2,
): Promise<FollowUpCommitment[]> {
  return db
    .select({
      id: commitmentsTable.id,
      content: commitmentsTable.content,
      cue: commitmentsTable.cue,
      scheduledDate: commitmentsTable.scheduledDate,
      scheduledTime: commitmentsTable.scheduledTime,
    })
    .from(commitmentsTable)
    .where(
      and(
        eq(commitmentsTable.userId, userId),
        sql`${commitmentsTable.state} = 'open'`,
        sql`${commitmentsTable.scheduledFollowupDate} IS NOT NULL`,
        sql`${commitmentsTable.scheduledFollowupDate} <= ${today}`,
        // Staleness window: drop follow-ups whose date is far in the past.
        // scheduled_followup_date is a TEXT 'YYYY-MM-DD' column — cast to date
        // for the arithmetic comparison.
        sql`${commitmentsTable.scheduledFollowupDate}::date >= (${today}::date - ${STALE_FOLLOWUP_DAYS}::int)`,
        // Asked-but-not-answered: not surfaced within the cooldown.
        sql`(${commitmentsTable.lastSurfacedAt} IS NULL OR ${commitmentsTable.lastSurfacedAt} < now() - (${ASK_COOLDOWN_DAYS} || ' days')::interval)`,
      ),
    )
    .orderBy(desc(commitmentsTable.scheduledFollowupDate))
    .limit(limit);
}

export interface ReferenceFact {
  id: number;
  fact: string;
  category: string;
}

/**
 * Facts a morning note may reference. Ongoing kinds (goal/person/preference/…)
 * pass through; one-time EVENTS are only offered while fresh and not recently
 * asked — so a stale "had a big meeting" stops resurfacing. Ordered newest-first.
 */
export async function selectReferenceFacts(userId: number, limit = 10): Promise<ReferenceFact[]> {
  const rows = await db
    .select({
      id: memoryFactsTable.id,
      fact: memoryFactsTable.fact,
      category: memoryFactsTable.category,
      createdAt: memoryFactsTable.createdAt,
      lastSurfacedAt: memoryFactsTable.lastSurfacedAt,
    })
    .from(memoryFactsTable)
    .where(eq(memoryFactsTable.userId, userId))
    .orderBy(desc(memoryFactsTable.createdAt))
    .limit(limit * 3); // over-fetch, then filter events out

  const now = Date.now();
  const ageDays = (d: Date | null | undefined): number =>
    d ? (now - new Date(d).getTime()) / 86_400_000 : Infinity;

  const kept = rows.filter((f) => {
    if (f.category !== "event") return true; // goals, people, preferences, life — always fine
    if (ageDays(f.createdAt) > EVENT_FRESH_DAYS) return false; // stale one-time event
    if (f.lastSurfacedAt && ageDays(f.lastSurfacedAt) < ASK_COOLDOWN_DAYS) return false; // already asked
    return true;
  });

  return kept.slice(0, limit).map((f) => ({ id: f.id, fact: f.fact, category: f.category }));
}

export interface ActiveGoal {
  id: number;
  title: string;
}

/**
 * Ongoing, incomplete goals — the recurring check-in material to lean on when
 * there's no fresh conversation to draw from (rule 2). These SHOULD recur.
 */
export async function selectActiveGoals(userId: number, limit = 3): Promise<ActiveGoal[]> {
  return db
    .select({ id: goalsTable.id, title: goalsTable.title })
    .from(goalsTable)
    .where(and(eq(goalsTable.userId, userId), eq(goalsTable.isComplete, false)))
    .orderBy(desc(goalsTable.createdAt))
    .limit(limit);
}

/** Stamp commitments as surfaced now, so tomorrow's note won't repeat them. */
export async function stampCommitmentsSurfaced(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(commitmentsTable)
    .set({ lastSurfacedAt: new Date() })
    .where(inArray(commitmentsTable.id, ids));
}

/** Stamp facts as surfaced now (used for one-time events we asked about). */
export async function stampFactsSurfaced(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(memoryFactsTable)
    .set({ lastSurfacedAt: new Date() })
    .where(inArray(memoryFactsTable.id, ids));
}
