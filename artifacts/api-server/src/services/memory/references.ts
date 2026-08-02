// ─── Ongoing memory-reference matcher (Sprint 2A) ────────────────────────────
// Best-effort proxy for "this fact came up again in conversation". After a
// message is stored, scan it against the user's existing facts; each fact it
// references gets timesReferenced += 1 (cap 100) and lastReferencedAt bumped.
// Runs fire-and-forget from runConversationExtractions so it never slows the
// user's reply. Facts are encrypted at rest, so matching happens in app code
// on decrypted rows (drizzle decrypts on read).

import { eq, sql } from "drizzle-orm";
import { db, memoryFactsTable, memoryFeelingsTable } from "@workspace/db";
import { logger } from "../../lib/logger.js";
import { hashUserIdForLog } from "../../lib/logging/hashUserIdForLog.js";
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

    // Which of `rows` does the message reference (shares a content token)?
    const matchIds = (rows: Array<{ id: number; content: string }>): number[] => {
      const hits: number[] = [];
      for (const r of rows) {
        for (const t of contentTokens(r.content)) {
          if (msgTokens.has(t)) { hits.push(r.id); break; }
        }
      }
      return hits;
    };

    // Facts + feelings share the exact same importance columns and matcher, so
    // a message that mentions either bumps its reference counters. Fetch both
    // (encrypted content decrypts on read), match in app code.
    const [facts, feelings] = await Promise.all([
      db
        .select({ id: memoryFactsTable.id, content: memoryFactsTable.fact })
        .from(memoryFactsTable)
        .where(eq(memoryFactsTable.userId, userId)),
      db
        .select({ id: memoryFeelingsTable.id, content: memoryFeelingsTable.feeling })
        .from(memoryFeelingsTable)
        .where(eq(memoryFeelingsTable.userId, userId)),
    ]);

    const factIds = matchIds(facts);
    const feelingIds = matchIds(feelings);

    // One UPDATE per table — LEAST caps the counter at 100.
    if (factIds.length > 0) {
      await db
        .update(memoryFactsTable)
        .set({
          timesReferenced: sql`LEAST(${memoryFactsTable.timesReferenced} + 1, ${REFERENCE_CAP})`,
          lastReferencedAt: at,
        })
        .where(sql`${memoryFactsTable.id} IN (${sql.join(factIds.map((id) => sql`${id}`), sql`, `)})`);
    }
    if (feelingIds.length > 0) {
      await db
        .update(memoryFeelingsTable)
        .set({
          timesReferenced: sql`LEAST(${memoryFeelingsTable.timesReferenced} + 1, ${REFERENCE_CAP})`,
          lastReferencedAt: at,
        })
        .where(sql`${memoryFeelingsTable.id} IN (${sql.join(feelingIds.map((id) => sql`${id}`), sql`, `)})`);
    }

    return factIds.length + feelingIds.length;
  } catch (err) {
    try {
      const uh = hashUserIdForLog(userId);
      if (uh) logger.warn({ err, uh }, "recordMemoryReferences failed (non-fatal)");
    } catch { /* logging must never crash the caller */ }
    return 0;
  }
}
