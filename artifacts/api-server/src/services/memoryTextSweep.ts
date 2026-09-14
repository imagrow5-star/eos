/**
 * Boot sweep: bring every stored memory line under the cleaner's rules
 * (memory audit, item 2; lib/memoryText.ts).
 *
 * New rows are cleaned when written. Rows that predate that — facts,
 * their previous wording, feelings, personality signals, wins — may hold
 * line breaks, control characters, leading tags, over-long text, or a
 * category outside the ten. This pass rewrites each such row to what the
 * cleaner would have stored, and drops a row that cleans to nothing (a
 * line under the floor is not a memory).
 *
 * Same safety pattern as the other boot sweeps:
 *   • advisory-locked — concurrent instances skip;
 *   • idempotent — a clean row is left alone, so a second run changes
 *     nothing and the pass is cheap after the first;
 *   • per user, per table, small batches; content decrypts on read and is
 *     compared in app code (the columns are encrypted at rest);
 *   • logs counts only, never a line of content.
 *
 * Runs in the background after boot (index.ts); a failure is logged and
 * retried next boot — nothing depends on it having finished.
 */

import { and, eq, notInArray } from "drizzle-orm";
import { db, pool, memoryFactsTable, memoryFeelingsTable, personalitySignalsTable, winsTable } from "@workspace/db";
import { logger } from "../lib/logger.js";
import {
  cleanMemoryText,
  FACT_CATEGORIES,
  FACT_TEXT_MAX,
  FEELING_TEXT_MAX,
  SIGNAL_TEXT_MAX,
  WIN_TEXT_MAX,
} from "../lib/memoryText.js";

const LOCK_KEY = "memory-text-sweep";

export interface MemoryTextSweepCounts {
  facts: { rewritten: number; dropped: number; recategorized: number };
  feelings: { rewritten: number; dropped: number };
  signals: { rewritten: number; dropped: number };
  wins: { rewritten: number; dropped: number };
}

/** Sweep one user (exported for tests). */
export async function sweepMemoryTextForUser(userId: number): Promise<MemoryTextSweepCounts> {
  const counts: MemoryTextSweepCounts = {
    facts: { rewritten: 0, dropped: 0, recategorized: 0 },
    feelings: { rewritten: 0, dropped: 0 },
    signals: { rewritten: 0, dropped: 0 },
    wins: { rewritten: 0, dropped: 0 },
  };

  // Facts: text, previous wording, category. A retired fact is cleaned too —
  // it may be un-retired by hand one day.
  const facts = await db
    .select({ id: memoryFactsTable.id, fact: memoryFactsTable.fact, previousFact: memoryFactsTable.previousFact })
    .from(memoryFactsTable)
    .where(eq(memoryFactsTable.userId, userId));
  for (const f of facts) {
    const fact = cleanMemoryText(f.fact, FACT_TEXT_MAX);
    if (!fact) {
      await db.delete(memoryFactsTable).where(and(eq(memoryFactsTable.id, f.id), eq(memoryFactsTable.userId, userId)));
      counts.facts.dropped++;
      continue;
    }
    const previous = f.previousFact == null ? null : cleanMemoryText(f.previousFact, FACT_TEXT_MAX);
    if (fact !== f.fact || previous !== f.previousFact) {
      await db
        .update(memoryFactsTable)
        .set({ fact, previousFact: previous })
        .where(and(eq(memoryFactsTable.id, f.id), eq(memoryFactsTable.userId, userId)));
      counts.facts.rewritten++;
    }
  }
  const recategorized = await db
    .update(memoryFactsTable)
    .set({ category: "life" })
    .where(and(eq(memoryFactsTable.userId, userId), notInArray(memoryFactsTable.category, [...FACT_CATEGORIES])))
    .returning({ id: memoryFactsTable.id });
  counts.facts.recategorized = recategorized.length;

  const feelings = await db
    .select({ id: memoryFeelingsTable.id, feeling: memoryFeelingsTable.feeling })
    .from(memoryFeelingsTable)
    .where(eq(memoryFeelingsTable.userId, userId));
  for (const r of feelings) {
    const feeling = cleanMemoryText(r.feeling, FEELING_TEXT_MAX, 8);
    if (!feeling) {
      await db.delete(memoryFeelingsTable).where(and(eq(memoryFeelingsTable.id, r.id), eq(memoryFeelingsTable.userId, userId)));
      counts.feelings.dropped++;
    } else if (feeling !== r.feeling) {
      await db.update(memoryFeelingsTable).set({ feeling }).where(and(eq(memoryFeelingsTable.id, r.id), eq(memoryFeelingsTable.userId, userId)));
      counts.feelings.rewritten++;
    }
  }

  const signals = await db
    .select({ id: personalitySignalsTable.id, signal: personalitySignalsTable.signal })
    .from(personalitySignalsTable)
    .where(eq(personalitySignalsTable.userId, userId));
  for (const r of signals) {
    const signal = cleanMemoryText(r.signal, SIGNAL_TEXT_MAX);
    if (!signal) {
      await db.delete(personalitySignalsTable).where(and(eq(personalitySignalsTable.id, r.id), eq(personalitySignalsTable.userId, userId)));
      counts.signals.dropped++;
    } else if (signal !== r.signal) {
      await db.update(personalitySignalsTable).set({ signal }).where(and(eq(personalitySignalsTable.id, r.id), eq(personalitySignalsTable.userId, userId)));
      counts.signals.rewritten++;
    }
  }

  const wins = await db
    .select({ id: winsTable.id, content: winsTable.content })
    .from(winsTable)
    .where(eq(winsTable.userId, userId));
  for (const r of wins) {
    const content = cleanMemoryText(r.content, WIN_TEXT_MAX);
    if (!content) {
      await db.delete(winsTable).where(and(eq(winsTable.id, r.id), eq(winsTable.userId, userId)));
      counts.wins.dropped++;
    } else if (content !== r.content) {
      await db.update(winsTable).set({ content }).where(and(eq(winsTable.id, r.id), eq(winsTable.userId, userId)));
      counts.wins.rewritten++;
    }
  }

  return counts;
}

/** Every user with any memory row. Advisory-locked; null when another instance holds the lock. */
export async function runMemoryTextSweep(): Promise<MemoryTextSweepCounts | null> {
  const lockClient = await pool.connect();
  try {
    const { rows } = await lockClient.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [LOCK_KEY]);
    if (!rows[0]?.locked) {
      logger.info("memory text sweep: another instance holds the lock — skipping");
      return null;
    }
    try {
      const { rows: list } = await pool.query<{ user_id: number }>(`
        SELECT DISTINCT user_id FROM (
          SELECT user_id FROM memory_facts
          UNION SELECT user_id FROM memory_feelings
          UNION SELECT user_id FROM personality_signals
          UNION SELECT user_id FROM wins
        ) u WHERE user_id IS NOT NULL
      `);
      const total: MemoryTextSweepCounts = {
        facts: { rewritten: 0, dropped: 0, recategorized: 0 },
        feelings: { rewritten: 0, dropped: 0 },
        signals: { rewritten: 0, dropped: 0 },
        wins: { rewritten: 0, dropped: 0 },
      };
      for (const row of list) {
        const c = await sweepMemoryTextForUser(Number(row.user_id));
        total.facts.rewritten += c.facts.rewritten;
        total.facts.dropped += c.facts.dropped;
        total.facts.recategorized += c.facts.recategorized;
        total.feelings.rewritten += c.feelings.rewritten;
        total.feelings.dropped += c.feelings.dropped;
        total.signals.rewritten += c.signals.rewritten;
        total.signals.dropped += c.signals.dropped;
        total.wins.rewritten += c.wins.rewritten;
        total.wins.dropped += c.wins.dropped;
      }
      logger.info({ users: list.length, ...total }, "memory text sweep complete");
      return total;
    } finally {
      await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [LOCK_KEY]);
    }
  } finally {
    lockClient.release();
  }
}
