/**
 * Weekly review — store + routes (services/weeklyReview.ts, routes/weeklyReviews.ts).
 *
 *  - the store refuses a story with fewer than three cards or more than six,
 *    or a card that carries anything outside its declared shape (the
 *    minimum-content rule and "no interpretation field" are schema
 *    constraints, not conventions);
 *  - GET lists the newest six, newest first, decrypting cards and fragment,
 *    with the persisted viewed flag;
 *  - POST …/viewed is permanent, idempotent, and refuses other people's
 *    stories;
 *  - the prototype seed produces the prototype's four markers, only the
 *    newest unviewed.
 */

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { eq } from "drizzle-orm";
import { db, weeklyReviewsTable } from "@workspace/db";
import app from "../app.js";
import {
  insertWeeklyReview,
  PROTOTYPE_CARDS,
  seedPrototypeReviews,
  weekBounds,
  WeekCardsSchema,
} from "../services/weeklyReview.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const createdEmails: string[] = [];

async function makeUser(tag: string) {
  const email = `weekly-review-${tag}-${Date.now()}@example.com`;
  createdEmails.push(email);
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/signup").send({ email, password: "Sup3r-secret!pw" });
  expect(res.status).toBeLessThan(300);
  await pool.query(`UPDATE users SET email_verified_at = NOW() WHERE email = $1`, [email]);
  const { rows } = await pool.query<{ id: number }>(`SELECT id FROM users WHERE email = $1`, [email]);
  return { agent, userId: rows[0]!.id };
}

afterAll(async () => {
  for (const email of createdEmails) {
    const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
    for (const row of rows) {
      await pool.query(`DELETE FROM weekly_reviews WHERE user_id = $1`, [row.id]);
      await pool.query(`DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = $1`, [String(row.id)]);
      await pool.query(`DELETE FROM email_verification_tokens WHERE user_id = $1`, [row.id]);
      await pool.query(`DELETE FROM messages WHERE user_id = $1`, [row.id]);
      await pool.query(`DELETE FROM profile WHERE user_id = $1`, [row.id]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [row.id]);
    }
  }
  await pool.end();
});

const NOW = new Date(Date.UTC(2026, 8, 8, 12)); // Tuesday 8 Sept 2026

describe("card rules are schema constraints", () => {
  it("accepts the prototype's six cards", () => {
    expect(WeekCardsSchema.parse(PROTOTYPE_CARDS)).toHaveLength(6);
  });

  it("refuses fewer than three cards and more than six", () => {
    expect(() => WeekCardsSchema.parse(PROTOTYPE_CARDS.slice(0, 2))).toThrow();
    expect(() => WeekCardsSchema.parse([...PROTOTYPE_CARDS, PROTOTYPE_CARDS[0]!])).toThrow();
    expect(WeekCardsSchema.parse(PROTOTYPE_CARDS.slice(0, 3))).toHaveLength(3);
  });

  it("refuses a thenNow card that smuggles an interpretation", () => {
    const thenNow = { ...PROTOTYPE_CARDS[2]!, meaning: "you're doing better" };
    expect(() => WeekCardsSchema.parse([PROTOTYPE_CARDS[0], PROTOTYPE_CARDS[1], thenNow])).toThrow();
  });

  it("refuses an unknown card kind (no mood, score or streak cards exist)", () => {
    const mood = { kind: "mood", eyebrow: "This week", text: "You seemed anxious" } as unknown;
    expect(() => WeekCardsSchema.parse([PROTOTYPE_CARDS[0], PROTOTYPE_CARDS[1], mood])).toThrow();
  });
});

describe("weekBounds", () => {
  it("is Monday → Sunday of the week containing now, stepping back by whole weeks", () => {
    expect(weekBounds(NOW, 0)).toEqual({ weekStart: "2026-09-07", weekEnd: "2026-09-13" });
    expect(weekBounds(NOW, 1)).toEqual({ weekStart: "2026-08-31", weekEnd: "2026-09-06" });
    expect(weekBounds(new Date(Date.UTC(2026, 8, 13, 23)), 0)).toEqual({ weekStart: "2026-09-07", weekEnd: "2026-09-13" }); // Sunday night
    expect(weekBounds(new Date(Date.UTC(2026, 8, 14, 0)), 0)).toEqual({ weekStart: "2026-09-14", weekEnd: "2026-09-20" }); // Monday
  });
});

describe("store + routes", () => {
  it("lists nothing for a fresh account (no markers, no placeholder)", async () => {
    const { agent } = await makeUser("empty");
    const res = await agent.get("/api/weekly-reviews");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reviews: [] });
  });

  it("refuses to store a story that breaks the rules", async () => {
    const { userId } = await makeUser("rules");
    const base = { userId, ...weekBounds(NOW, 0), fragment: "“steady”" };
    await expect(insertWeeklyReview({ ...base, cards: PROTOTYPE_CARDS.slice(0, 2) })).rejects.toThrow();
    await expect(insertWeeklyReview({ ...base, fragment: "x".repeat(41), cards: PROTOTYPE_CARDS })).rejects.toThrow(/fragment/);
    await expect(insertWeeklyReview({ ...base, weekStart: "7 Sept", cards: PROTOTYPE_CARDS })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("the prototype seed yields the four markers, newest first, only the newest unviewed, cards intact", async () => {
    const { agent, userId } = await makeUser("seed");
    await seedPrototypeReviews(userId, NOW);
    const res = await agent.get("/api/weekly-reviews");
    expect(res.status).toBe(200);
    const reviews = res.body.reviews as Array<{ weekStart: string; fragment: string; viewed: boolean; cards: unknown[] }>;
    expect(reviews.map((r) => r.weekStart)).toEqual(["2026-09-07", "2026-08-31", "2026-08-17", "2026-08-10"]);
    expect(reviews.map((r) => r.viewed)).toEqual([false, true, true, true]);
    expect(reviews[0]!.fragment).toBe("“she just said finally”");
    expect(reviews[0]!.cards).toEqual(PROTOTYPE_CARDS);
    // Encrypted at rest: the raw column is not the plaintext.
    const [raw] = await db
      .select({ fragment: weeklyReviewsTable.fragment })
      .from(weeklyReviewsTable)
      .where(eq(weeklyReviewsTable.userId, userId))
      .limit(1);
    expect(raw!.fragment).toBeDefined();
    const { rows } = await pool.query<{ fragment: string }>(`SELECT fragment FROM weekly_reviews WHERE user_id = $1 LIMIT 1`, [userId]);
    expect(rows[0]!.fragment).not.toContain("finally");
  });

  it("re-seeding upserts the same weeks rather than duplicating them", async () => {
    const { agent, userId } = await makeUser("upsert");
    await seedPrototypeReviews(userId, NOW);
    await seedPrototypeReviews(userId, NOW);
    const res = await agent.get("/api/weekly-reviews");
    expect(res.body.reviews).toHaveLength(4);
  });

  it("lists at most six, newest first", async () => {
    const { agent, userId } = await makeUser("six");
    for (let w = 0; w < 8; w++) {
      await insertWeeklyReview({ userId, ...weekBounds(NOW, w), fragment: `week ${w}`, cards: PROTOTYPE_CARDS });
    }
    const res = await agent.get("/api/weekly-reviews");
    const starts = (res.body.reviews as Array<{ weekStart: string }>).map((r) => r.weekStart);
    expect(starts).toHaveLength(6);
    expect(starts[0]).toBe("2026-09-07");
    expect([...starts].sort().reverse()).toEqual(starts);
  });

  it("viewed is persisted, permanent, idempotent, and only for your own stories", async () => {
    const { agent, userId } = await makeUser("viewed");
    const other = await makeUser("viewed-other");
    await seedPrototypeReviews(userId, NOW);
    const list = await agent.get("/api/weekly-reviews");
    const newest = list.body.reviews[0] as { id: number; viewed: boolean };
    expect(newest.viewed).toBe(false);

    // Someone else cannot mark it.
    const foreign = await other.agent.post(`/api/weekly-reviews/${newest.id}/viewed`);
    expect(foreign.status).toBe(404);
    const still = await agent.get("/api/weekly-reviews");
    expect(still.body.reviews[0].viewed).toBe(false);

    const first = await agent.post(`/api/weekly-reviews/${newest.id}/viewed`);
    expect(first.status).toBe(200);
    const after = await agent.get("/api/weekly-reviews");
    expect(after.body.reviews[0].viewed).toBe(true);

    // Idempotent, and the ring never comes back.
    const again = await agent.post(`/api/weekly-reviews/${newest.id}/viewed`);
    expect(again.status).toBe(200);
    const final = await agent.get("/api/weekly-reviews");
    expect(final.body.reviews[0].viewed).toBe(true);

    const bad = await agent.post(`/api/weekly-reviews/not-a-number/viewed`);
    expect(bad.status).toBe(400);
    const missing = await agent.post(`/api/weekly-reviews/999999999/viewed`);
    expect(missing.status).toBe(404);
  });
});
