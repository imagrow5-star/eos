// ─── Ongoing memory-reference matcher (Sprint 2A) ────────────────────────────
// Best-effort proxy for "this fact came up again in conversation". After a
// message is stored, scan it against the user's existing facts; each fact it
// references gets timesReferenced += 1 (cap 100) and lastReferencedAt bumped.
// Runs fire-and-forget from runConversationExtractions so it never slows the
// user's reply. Facts are encrypted at rest, so matching happens in app code
// on decrypted rows (drizzle decrypts on read).

import { eq, sql } from "drizzle-orm";
import { db, memoryFactsTable } from "@workspace/db";
import { logger } from "../../lib/logger.js";
import { contentTokens } from "./importance.js";

const REFERENCE_CAP = 100;

/**
 * Increment reference counts for every fact any of `messages` references.
 * `at` is the message timestamp (last-referenced). Idempotency is not a goal
 * here — each new message legitimately counts as a fresh reference — but the
 * per-fact counter is capped so it can't run away.
 */
export async function recordMemoryReferences(
  userId: number,
  messages: string[],
  at: Date = new Date(),
): Promise<number> {
  try {
    // One token set across all provided messages (user turn + assistant reply).
    const msgTokens = new Set<string>();
    for (const m of messages) for (const t of contentTokens(m)) msgTokens.add(t);
    if (msgTokens.size === 0) return 0;

    const facts = await db
      .select({ id: memoryFactsTable.id, fact: memoryFactsTable.fact })
      .from(memoryFactsTable)
      .where(eq(memoryFactsTable.userId, userId));
    if (facts.length === 0) return 0;

    const matchedIds: number[] = [];
    for (const f of facts) {
      const factTokens = contentTokens(f.fact);
      let hit = false;
      for (const t of factTokens) {
        if (msgTokens.has(t)) { hit = true; break; }
      }
      if (hit) matchedIds.push(f.id);
    }
    if (matchedIds.length === 0) return 0;

    // One UPDATE for all matched facts — LEAST caps the counter at 100.
    await db
      .update(memoryFactsTable)
      .set({
        timesReferenced: sql`LEAST(${memoryFactsTable.timesReferenced} + 1, ${REFERENCE_CAP})`,
        lastReferencedAt: at,
      })
      .where(
        sql`${memoryFactsTable.id} IN (${sql.join(matchedIds.map((id) => sql`${id}`), sql`, `)})`,
      );

    return matchedIds.length;
  } catch (err) {
    logger.warn({ err, userId }, "recordMemoryReferences failed (non-fatal)");
    return 0;
  }
}
