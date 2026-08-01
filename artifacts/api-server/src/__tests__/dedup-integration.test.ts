/**
 * DB-gated integration tests for semantic dedup (Sprint: dedup & reset).
 *
 * The model's semantic judgement can't run in CI (no ANTHROPIC_API_KEY), so we
 * inject deterministic stand-ins:
 *   • extraction path — a DedupFinder that decides duplicates by real lexical
 *     overlap over the actual existing rows (with real ids);
 *   • backfill path   — a ClusterGrouper that groups a batch's ids as told.
 * This proves the INSERT/UPDATE/DELETE mechanics (the part that can silently
 * corrupt data), while the deterministic unit suite pins the parsing/orchestration.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// extractMemory bails out unless an API key is present; give it a dummy (the
// extraction create() call is stubbed, and dedup uses the injected finder).
vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY ||= "test-key-unused-create-is-stubbed";
});

import pg from "pg";
import { createRequire } from "node:module";
import { db, memoryFactsTable, habitsTable, habitCompletionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { extractMemory } from "../services/ai.js";
import { backfillUserDedup } from "../services/memory/dedupBackfill.js";
import { lexicalOverlap, type DedupFinder, type SemanticCluster, type DedupEntry } from "../services/memory/dedup.js";

const DB = !!process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const TS = Date.now();
const emails: string[] = [];

function nextEmail(tag: string): string {
  const e = `dedup-${tag}-${TS}-${emails.length}@example.invalid`;
  emails.push(e);
  return e;
}

async function signupUser(tag: string): Promise<number> {
  const email = nextEmail(tag);
  const r = await pool.query<{ id: number }>(
    `INSERT INTO users (email, hashed_password, email_verified_at) VALUES ($1, 'x', NOW()) RETURNING id`,
    [email],
  );
  return r.rows[0]!.id;
}

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (!r.rowCount) return;
  const uid = r.rows[0]!.id;
  await pool.query(`
    BEGIN;
    DELETE FROM habit_completions WHERE user_id = ${uid};
    DELETE FROM habits            WHERE user_id = ${uid};
    DELETE FROM goals             WHERE user_id = ${uid};
    DELETE FROM commitments       WHERE user_id = ${uid};
    DELETE FROM memory_facts      WHERE user_id = ${uid};
    DELETE FROM profile           WHERE user_id = ${uid};
    DELETE FROM users             WHERE id      = ${uid};
    COMMIT;
  `);
}

// getAnthropic() loads the SDK via require() (CJS). Stub create() on the shared
// Messages prototype so extractMemory's extraction call returns canned facts.
let createSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  const require = createRequire(import.meta.url);
  const mod = require("@anthropic-ai/sdk");
  const Anthropic = mod.default || mod.Anthropic;
  const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: "x" }).messages);
  createSpy = vi.spyOn(messagesProto, "create");
});

afterAll(async () => {
  createSpy?.mockRestore();
  await Promise.all(emails.splice(0).map(cleanupUser));
  await pool.end();
});

function stubExtractedFactOnce(fact: string) {
  createSpy.mockResolvedValueOnce({
    content: [{ type: "text", text: JSON.stringify({ facts: [{ fact, category: "goal" }], signals: [], wins: [] }) }],
    usage: { input_tokens: 1, output_tokens: 1 },
  } as never);
}

function profileFor(userId: number) {
  return { userId, userName: "Test", companionName: "Eos", timezone: "UTC" } as never;
}

// Deterministic finder: decides duplicate by real lexical overlap over the real
// existing rows — a stand-in for Haiku's semantic judgement.
const lexFinder: DedupFinder = async (candidate, existing) => {
  let best: DedupEntry | null = null;
  let bestScore = 0;
  for (const e of existing) {
    const s = lexicalOverlap(candidate, e.content);
    if (s > bestScore) {
      bestScore = s;
      best = e;
    }
  }
  if (best && bestScore >= 0.3) return { isDuplicate: true, matchingId: best.id, reasoning: "lexical stand-in" };
  return { isDuplicate: false, matchingId: null, reasoning: "no match" };
};

describe.skipIf(!DB)("extraction-time dedup", () => {
  it("collapses 3 semantically-duplicate hopes into 1 row with times_referenced=3", async () => {
    const userId = await signupUser("extract");

    const phrasings = [
      "I want to hit 100 crores this year",
      "My target is 100 crores this year",
      "Aiming for 100 crores in revenue this year",
    ];
    for (const p of phrasings) {
      stubExtractedFactOnce(p);
      await extractMemory(profileFor(userId), [{ role: "user", content: p }], { dedupFinder: lexFinder });
    }

    const rows = await db.select().from(memoryFactsTable).where(eq(memoryFactsTable.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.timesReferenced).toBe(3);
    // The kept row is the FIRST phrasing (the others merged into it).
    expect(rows[0]!.fact).toBe(phrasings[0]);
  });

  it("keeps genuinely distinct facts as separate rows", async () => {
    const userId = await signupUser("distinct");

    for (const p of ["I love hiking on weekends", "My sister lives in Berlin"]) {
      stubExtractedFactOnce(p);
      await extractMemory(profileFor(userId), [{ role: "user", content: p }], { dedupFinder: lexFinder });
    }

    const rows = await db.select().from(memoryFactsTable).where(eq(memoryFactsTable.userId, userId));
    expect(rows).toHaveLength(2);
  });
});

describe.skipIf(!DB)("backfill dedup", () => {
  it("merges 5 pre-existing duplicate habits down to 1, summing times_referenced", async () => {
    const userId = await signupUser("backfill");

    const names = [
      "walk every morning",
      "morning walk",
      "go for a walk in the morning",
      "take a morning walk",
      "walk each morning",
    ];
    const habitIds: number[] = [];
    for (const name of names) {
      const [row] = await db
        .insert(habitsTable)
        .values({ userId, name, whenThen: "after coffee", reason: "health" })
        .returning({ id: habitsTable.id });
      habitIds.push(row!.id);
    }
    // A completion on the 3rd habit — must survive (repointed onto the keeper).
    await db.insert(habitCompletionsTable).values({ userId, habitId: habitIds[2]!, completedDate: "2026-07-01" });

    // Grouper: cluster ALL the batch's ids together (canonical = first id).
    const grouper = async (entries: DedupEntry[]): Promise<SemanticCluster[]> => {
      const ids = entries.map((e) => e.id);
      if (ids.length < 2) return [];
      return [{ canonicalId: ids[0]!, duplicateIds: ids.slice(1) }];
    };

    const summaries = await backfillUserDedup(userId, grouper);
    const habitSummary = summaries.find((s) => s.table === "habits")!;
    expect(habitSummary.beforeCount).toBe(5);
    expect(habitSummary.afterCount).toBe(1);
    expect(habitSummary.mergedCount).toBe(4);

    const remaining = await db.select().from(habitsTable).where(eq(habitsTable.userId, userId));
    expect(remaining).toHaveLength(1);
    // Oldest row is the keeper (first inserted).
    expect(remaining[0]!.id).toBe(habitIds[0]);
    expect(remaining[0]!.timesReferenced).toBe(5); // 5 × default 1, summed

    // The completion was repointed onto the keeper, not orphaned/lost.
    const comps = await db
      .select()
      .from(habitCompletionsTable)
      .where(eq(habitCompletionsTable.userId, userId));
    expect(comps).toHaveLength(1);
    expect(comps[0]!.habitId).toBe(habitIds[0]);
  });

  it("is idempotent — a second run finds nothing to merge", async () => {
    const userId = await signupUser("idem");
    for (const name of ["read before bed", "read a book before bed"]) {
      await db.insert(habitsTable).values({ userId, name, whenThen: "at night", reason: "calm" });
    }
    const grouper = async (entries: DedupEntry[]): Promise<SemanticCluster[]> => {
      const ids = entries.map((e) => e.id);
      return ids.length < 2 ? [] : [{ canonicalId: ids[0]!, duplicateIds: ids.slice(1) }];
    };

    const first = await backfillUserDedup(userId, grouper);
    expect(first.find((s) => s.table === "habits")!.mergedCount).toBe(1);

    const second = await backfillUserDedup(userId, grouper);
    expect(second.find((s) => s.table === "habits")!.mergedCount).toBe(0);

    const remaining = await db.select().from(habitsTable).where(eq(habitsTable.userId, userId));
    expect(remaining).toHaveLength(1);
  });
});
