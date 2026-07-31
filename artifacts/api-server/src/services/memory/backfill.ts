// ─── memory_facts importance backfill (Sprint 2A) ────────────────────────────
// One-time seed of the new ranking columns for facts that predate them. Runs
// at first boot (idempotent — only touches rows still at their default seed
// state), per-user in a single transaction. Facts and messages are encrypted
// at rest, so all matching happens in app code on decrypted rows.
//
// Per fact:
//  • timesReferenced  = # of this user's messages containing any 4+ char token
//                       from the fact (cap 20). Rough proxy — good enough to seed.
//  • lastReferencedAt = newest such message, else the fact's createdAt.
//  • emotionalWeight  = category base (person/value/event/goal 0.6; life/work/
//                       routine 0.4; else 0.2), +0.2 if a low-mood day (≤4) sits
//                       within ±1 day of the fact's createdAt (max 1.0).
//  • userMarkedImportant stays false (Sprint 2B owns it).

import { and, eq, sql } from "drizzle-orm";
import { db, memoryFactsTable, messagesTable, moodScoresTable } from "@workspace/db";
import { logger } from "../../lib/logger.js";
import { hashUserIdForLog } from "../../lib/logging/hashUserIdForLog.js";
import { contentTokens, categoryEmotionalWeight } from "./importance.js";

const MS_PER_DAY = 86_400_000;
const BACKFILL_REFERENCE_CAP = 20;

/** A fact is "unseeded" when it's still at the schema defaults AND has no
 *  lastReferencedAt — i.e. the backfill (or ongoing matcher) hasn't touched it.
 *  This makes the whole pass idempotent and cheap to re-run. */
function needsBackfill(f: {
  timesReferenced: number;
  lastReferencedAt: Date | null;
  emotionalWeight: number;
}): boolean {
  return f.lastReferencedAt == null && f.timesReferenced === 1 && f.emotionalWeight === 0;
}

/** Backfill one user's facts. Returns how many rows were updated. */
export async function backfillUserFactImportance(userId: number): Promise<number> {
  return db.transaction(async (tx) => {
    const facts = await tx
      .select()
      .from(memoryFactsTable)
      .where(eq(memoryFactsTable.userId, userId));
    const pending = facts.filter(needsBackfill);
    if (pending.length === 0) return 0;

    // Load once, match in memory (encrypted content → decrypted on read).
    const messages = await tx
      .select({ content: messagesTable.content, createdAt: messagesTable.createdAt })
      .from(messagesTable)
      .where(eq(messagesTable.userId, userId));
    const moods = await tx
      .select({ score: moodScoresTable.score, createdAt: moodScoresTable.createdAt })
      .from(moodScoresTable)
      .where(eq(moodScoresTable.userId, userId));

    const msgTokenized = messages.map((m) => ({
      tokens: contentTokens(m.content),
      at: m.createdAt,
    }));

    let updated = 0;
    for (const f of pending) {
      const factTokens = contentTokens(f.fact);

      // times_referenced + last_referenced_at from matching messages.
      let count = 0;
      let newestMatch: Date | null = null;
      if (factTokens.size > 0) {
        for (const m of msgTokenized) {
          let hit = false;
          for (const t of m.tokens) {
            if (factTokens.has(t)) { hit = true; break; }
          }
          if (hit) {
            count += 1;
            if (!newestMatch || m.at > newestMatch) newestMatch = m.at;
          }
        }
      }
      const timesReferenced = Math.max(1, Math.min(count, BACKFILL_REFERENCE_CAP));
      const lastReferencedAt = newestMatch ?? f.createdAt;

      // emotional_weight: category base + low-mood proximity bump.
      let weight = categoryEmotionalWeight(f.category);
      const createdMs = f.createdAt.getTime();
      const lowMoodNearby = moods.some(
        (mo) =>
          mo.score <= 4 &&
          Math.abs(mo.createdAt.getTime() - createdMs) <= MS_PER_DAY,
      );
      if (lowMoodNearby) weight = Math.min(1.0, weight + 0.2);

      await tx
        .update(memoryFactsTable)
        .set({ timesReferenced, lastReferencedAt, emotionalWeight: weight })
        .where(and(eq(memoryFactsTable.id, f.id), eq(memoryFactsTable.userId, userId)));
      updated += 1;
    }

    try {
      const uh = hashUserIdForLog(userId);
      if (uh) logger.info({ uh, facts: pending.length, updated }, "memory importance backfilled for user");
    } catch { /* logging must never crash the caller */ }
    return updated;
  });
}

/** Backfill every user with at least one unseeded fact. Safe to run at every
 *  boot — a no-op once complete. */
export async function backfillMemoryImportance(): Promise<{ users: number; facts: number }> {
  // Distinct users with a fact still at the seed defaults.
  const rows = await db
    .selectDistinct({ userId: memoryFactsTable.userId })
    .from(memoryFactsTable)
    .where(
      and(
        sql`${memoryFactsTable.lastReferencedAt} IS NULL`,
        eq(memoryFactsTable.timesReferenced, 1),
        eq(memoryFactsTable.emotionalWeight, 0),
      ),
    );

  let users = 0;
  let facts = 0;
  for (const { userId } of rows) {
    if (userId == null) continue;
    const n = await backfillUserFactImportance(userId).catch((err) => {
      try {
        const uh = hashUserIdForLog(userId);
        if (uh) logger.error({ err, uh }, "memory importance backfill failed for user");
      } catch { /* logging must never crash the caller */ }
      return 0;
    });
    if (n > 0) { users += 1; facts += n; }
  }
  if (facts > 0) logger.info({ users, facts }, "memory importance backfill complete");
  return { users, facts };
}
