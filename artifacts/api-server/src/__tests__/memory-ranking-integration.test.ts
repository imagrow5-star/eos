/**
 * Sprint 2A — memory ranking, backfill, and reference matcher (real DB).
 * Facts are encrypted at rest by the ORM; these tests write via the ORM so the
 * `fact` column round-trips, and assert on the ranking/backfill columns.
 */

import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import pg from "pg";
import { db, memoryFactsTable, messagesTable, moodScoresTable } from "@workspace/db";
import { rankFactsByImportance } from "../services/memory/importance.js";
import { recordMemoryReferences } from "../services/memory/references.js";
import { backfillUserFactImportance } from "../services/memory/backfill.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const createdUserIds: number[] = [];

afterAll(async () => {
  for (const uid of createdUserIds) {
    await pool.query("DELETE FROM memory_facts WHERE user_id=$1", [uid]);
    await pool.query("DELETE FROM messages WHERE user_id=$1", [uid]);
    await pool.query("DELETE FROM mood_scores WHERE user_id=$1", [uid]);
    await pool.query("DELETE FROM users WHERE id=$1", [uid]);
  }
  await pool.end();
});

async function makeUser(tag: string): Promise<number> {
  const email = `mem-rank-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.invalid`;
  const r = await pool.query<{ id: number }>(
    "INSERT INTO users (email, hashed_password, email_verified_at) VALUES ($1,'x',NOW()) RETURNING id",
    [email],
  );
  const uid = r.rows[0]!.id;
  createdUserIds.push(uid);
  return uid;
}

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

// ─── Retrieval: top-40 by score, not newest-40 ───────────────────────────────

describe("retrieval selects top-40 by importance", () => {
  it("100 facts: an old high-importance fact survives; new trivial ones past rank 40 don't", async () => {
    const userId = await makeUser("100");

    // 60 NEW but trivial facts (created in the last 60 days, never referenced).
    for (let i = 0; i < 60; i++) {
      await db.insert(memoryFactsTable).values({
        userId, fact: `trivial detail number ${i} about nothing much`, category: "life",
        createdAt: daysAgo(i), timesReferenced: 1, lastReferencedAt: null, emotionalWeight: 0.1,
      });
    }
    // 40 OLD facts (created 100–300 days ago). 5 of them are important (grief-like).
    for (let i = 0; i < 40; i++) {
      const important = i < 5;
      await db.insert(memoryFactsTable).values({
        userId,
        fact: important ? `deep grief about their mother, carried for months ${i}` : `old forgotten trivia ${i}`,
        category: important ? "person" : "life",
        createdAt: daysAgo(100 + i * 5),
        timesReferenced: important ? 10 : 0,
        lastReferencedAt: important ? daysAgo(2) : null,
        emotionalWeight: important ? 0.9 : 0.1,
      });
    }

    const all = await db.select().from(memoryFactsTable).where(eq(memoryFactsTable.userId, userId));
    expect(all).toHaveLength(100);

    const top40 = rankFactsByImportance(all, Date.now(), 40);
    expect(top40).toHaveLength(40);

    // All 5 old-important facts survive despite being 100+ days old.
    const importantSurvivors = top40.filter((f) => f.fact.startsWith("deep grief"));
    expect(importantSurvivors).toHaveLength(5);

    // The pure newest-40-by-date set would have EXCLUDED all 5 (they're older
    // than 40 newer facts) — prove the ranking differs from date order.
    const newest40 = [...all].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 40);
    expect(newest40.some((f) => f.fact.startsWith("deep grief"))).toBe(false);
  });
});

// ─── Ongoing reference matcher ───────────────────────────────────────────────

describe("recordMemoryReferences", () => {
  it("bumps times_referenced and last_referenced_at for matched facts only", async () => {
    const userId = await makeUser("ref");
    await db.insert(memoryFactsTable).values([
      { userId, fact: "has a sister named Priya", category: "person", timesReferenced: 1, lastReferencedAt: daysAgo(30) },
      { userId, fact: "loves hiking on weekends", category: "interest", timesReferenced: 1, lastReferencedAt: daysAgo(30) },
    ]);

    const at = new Date();
    const matched = await recordMemoryReferences(userId, ["I called my sister Priya today"], at);
    expect(matched).toBe(1);

    const rows = await db.select().from(memoryFactsTable).where(eq(memoryFactsTable.userId, userId));
    const sister = rows.find((r) => r.fact.includes("Priya"))!;
    const hiking = rows.find((r) => r.fact.includes("hiking"))!;
    expect(sister.timesReferenced).toBe(2);
    expect(sister.lastReferencedAt!.getTime()).toBeGreaterThan(daysAgo(1).getTime());
    // Unmatched fact untouched.
    expect(hiking.timesReferenced).toBe(1);
  });

  it("caps times_referenced at 100", async () => {
    const userId = await makeUser("cap");
    await db.insert(memoryFactsTable).values({ userId, fact: "works as an architect", category: "work", timesReferenced: 100 });
    await recordMemoryReferences(userId, ["my architect job is stressful"], new Date());
    const [row] = await db.select().from(memoryFactsTable).where(eq(memoryFactsTable.userId, userId));
    expect(row!.timesReferenced).toBe(100);
  });
});

// ─── Backfill ────────────────────────────────────────────────────────────────

describe("backfillUserFactImportance", () => {
  it("seeds times_referenced (capped 20), last_referenced_at, and emotional weight", async () => {
    const userId = await makeUser("bf");

    // A fact + several messages that mention it, plus a low-mood day near it.
    const factCreated = daysAgo(40);
    await db.insert(memoryFactsTable).values({
      userId, fact: "grief about their mother", category: "person",
      createdAt: factCreated,
      // left at seed defaults (times=1, lastRef=null, weight=0) so backfill runs
      timesReferenced: 1, lastReferencedAt: null, emotionalWeight: 0,
    });
    // 3 messages mention "mother"; newest is 5 days ago.
    for (const d of [39, 20, 5]) {
      await db.insert(messagesTable).values({
        userId, role: "user", content: `I keep thinking about my mother`, createdAt: daysAgo(d), isMorningNote: false,
      });
    }
    // one unrelated message — must not count
    await db.insert(messagesTable).values({
      userId, role: "user", content: "the weather is fine", createdAt: daysAgo(3), isMorningNote: false,
    });
    // low mood (score 3) within ±1 day of the fact's creation → +0.2 weight
    await db.insert(moodScoresTable).values({ userId, score: 3, date: "2026-06-21", createdAt: factCreated });

    const updated = await backfillUserFactImportance(userId);
    expect(updated).toBe(1);

    const [row] = await db.select().from(memoryFactsTable).where(eq(memoryFactsTable.userId, userId));
    expect(row!.timesReferenced).toBe(3); // three "mother" messages
    expect(row!.lastReferencedAt).not.toBeNull();
    // newest match is ~5 days ago
    expect(Math.round((Date.now() - row!.lastReferencedAt!.getTime()) / 86_400_000)).toBe(5);
    // person(0.6) + low-mood proximity(0.2) = 0.8
    expect(row!.emotionalWeight).toBeCloseTo(0.8, 5);
  });

  it("is idempotent — a second run changes nothing", async () => {
    const userId = await makeUser("idem");
    await db.insert(memoryFactsTable).values({
      userId, fact: "enjoys painting landscapes", category: "interest",
      createdAt: daysAgo(10), timesReferenced: 1, lastReferencedAt: null, emotionalWeight: 0,
    });
    await db.insert(messagesTable).values({
      userId, role: "user", content: "I spent the afternoon painting", createdAt: daysAgo(2), isMorningNote: false,
    });

    const first = await backfillUserFactImportance(userId);
    expect(first).toBe(1);
    const [after1] = await db.select().from(memoryFactsTable).where(eq(memoryFactsTable.userId, userId));

    const second = await backfillUserFactImportance(userId);
    expect(second).toBe(0); // already seeded → skipped
    const [after2] = await db.select().from(memoryFactsTable).where(eq(memoryFactsTable.userId, userId));
    expect(after2!.timesReferenced).toBe(after1!.timesReferenced);
    expect(after2!.emotionalWeight).toBe(after1!.emotionalWeight);
    expect(after2!.lastReferencedAt!.getTime()).toBe(after1!.lastReferencedAt!.getTime());
  });
});

// ─── Golden fixture: 60 facts, 5 marked critical must all survive ────────────

describe("golden — 60-fact fixture, all 5 critical facts retained regardless of age", () => {
  it("top-40 includes every user_marked_important fact even when they are the oldest", async () => {
    const userId = await makeUser("golden");

    // 55 ordinary facts spanning fresh → old, varied but none marked.
    for (let i = 0; i < 55; i++) {
      await db.insert(memoryFactsTable).values({
        userId, fact: `ordinary fact ${i} about daily life and small preferences`,
        category: i % 2 === 0 ? "life" : "preference",
        createdAt: daysAgo(i * 4), // 0 .. 216 days
        timesReferenced: 1 + (i % 4), lastReferencedAt: i % 3 === 0 ? daysAgo(2) : null,
        emotionalWeight: 0.2,
      });
    }
    // 5 CRITICAL facts — the OLDEST in the set (250–290 days), user-marked.
    for (let i = 0; i < 5; i++) {
      await db.insert(memoryFactsTable).values({
        userId, fact: `critical anchor ${i}: a defining loss they carry`,
        category: "person",
        createdAt: daysAgo(250 + i * 10), // older than every ordinary fact
        timesReferenced: 3, lastReferencedAt: null, emotionalWeight: 0.5,
        userMarkedImportant: true,
      });
    }

    const all = await db.select().from(memoryFactsTable).where(eq(memoryFactsTable.userId, userId));
    expect(all).toHaveLength(60);

    const top40 = rankFactsByImportance(all, Date.now(), 40);
    const criticals = top40.filter((f) => f.userMarkedImportant);
    expect(criticals).toHaveLength(5); // all 5 survive despite being the oldest
    // And a naive newest-40 would have dropped every one of them.
    const newest40 = [...all].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 40);
    expect(newest40.some((f) => f.userMarkedImportant)).toBe(false);
  });
});
