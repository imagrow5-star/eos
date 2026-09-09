/**
 * Stories — store + routes (services/stories.ts, routes/stories.ts).
 *
 *  - the store refuses a period story with fewer than three cards or more
 *    than six, a goals/routines story with none or more than three, or a card
 *    that carries anything outside its declared shape (the minimum-content
 *    rule and "no interpretation field" are schema constraints);
 *  - GET /stories lists the newest Goals story, the newest Routines story,
 *    then up to six weekly stories, newest first, decrypting cards and
 *    fragment, with the persisted viewed flag;
 *  - POST …/viewed is permanent, idempotent, and refuses other people's
 *    stories;
 *  - the prototype seed produces the prototype's four weekly markers, only
 *    the newest unviewed.
 */

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import {
  insertStory,
  PROTOTYPE_CARDS,
  seedPrototypeReviews,
  weekBounds,
  PeriodCardsSchema,
  SubjectCardsSchema,
} from "../services/stories.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const createdEmails: string[] = [];

async function makeUser(tag: string) {
  const email = `stories-${tag}-${Date.now()}@example.com`;
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
      await pool.query(`DELETE FROM stories WHERE user_id = $1`, [row.id]);
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
    expect(PeriodCardsSchema.parse(PROTOTYPE_CARDS)).toHaveLength(6);
  });

  it("a period story refuses fewer than three cards and more than six", () => {
    expect(() => PeriodCardsSchema.parse(PROTOTYPE_CARDS.slice(0, 2))).toThrow();
    expect(() => PeriodCardsSchema.parse([...PROTOTYPE_CARDS, PROTOTYPE_CARDS[0]!])).toThrow();
    expect(PeriodCardsSchema.parse(PROTOTYPE_CARDS.slice(0, 3))).toHaveLength(3);
  });

  it("a goals/routines story carries one to three cards", () => {
    const goal = { kind: "goal", eyebrow: "Learn Spanish", text: "The Spanish is still here whenever you want to pick it back up." };
    expect(SubjectCardsSchema.parse([goal])).toHaveLength(1);
    expect(() => SubjectCardsSchema.parse([])).toThrow();
    expect(() => SubjectCardsSchema.parse([goal, goal, goal, goal])).toThrow();
    const routine = { kind: "routine", eyebrow: "Morning walk", text: "You logged the walk again.", pattern: "Most days this week" };
    expect(SubjectCardsSchema.parse([routine])).toHaveLength(1);
    // A routine card carries a pattern, never a chain field.
    expect(() => SubjectCardsSchema.parse([{ ...routine, streak: 4 }])).toThrow();
  });

  it("refuses a thenNow card that smuggles an interpretation", () => {
    const thenNow = { ...PROTOTYPE_CARDS[2]!, meaning: "you're doing better" };
    expect(() => PeriodCardsSchema.parse([PROTOTYPE_CARDS[0], PROTOTYPE_CARDS[1], thenNow])).toThrow();
  });

  it("refuses an unknown card kind (no mood, score or streak cards exist)", () => {
    const mood = { kind: "mood", eyebrow: "This week", text: "You seemed anxious" } as unknown;
    expect(() => PeriodCardsSchema.parse([PROTOTYPE_CARDS[0], PROTOTYPE_CARDS[1], mood])).toThrow();
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

function weekStory(userId: number, weeksAgo: number, fragment: string) {
  const { weekStart, weekEnd } = weekBounds(NOW, weeksAgo);
  return { userId, kind: "week" as const, periodStart: weekStart, periodEnd: weekEnd, fragment, cards: PROTOTYPE_CARDS };
}

describe("store + routes", () => {
  it("lists nothing for a fresh account (no markers, no placeholder)", async () => {
    const { agent } = await makeUser("empty");
    const res = await agent.get("/api/stories");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stories: [] });
  });

  it("refuses to store a story that breaks the rules", async () => {
    const { userId } = await makeUser("rules");
    const base = weekStory(userId, 0, "“steady”");
    await expect(insertStory({ ...base, cards: PROTOTYPE_CARDS.slice(0, 2) })).rejects.toThrow();
    await expect(insertStory({ ...base, fragment: "x".repeat(41) })).rejects.toThrow(/fragment/);
    await expect(insertStory({ ...base, periodStart: "7 Sept" })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(insertStory({ ...base, kind: "mood" as never })).rejects.toThrow();
  });

  it("the prototype seed yields the four weekly markers, newest first, only the newest unviewed, cards intact", async () => {
    const { agent, userId } = await makeUser("seed");
    await seedPrototypeReviews(userId, NOW);
    const res = await agent.get("/api/stories");
    expect(res.status).toBe(200);
    const stories = res.body.stories as Array<{ kind: string; periodStart: string; fragment: string; viewed: boolean; cards: unknown[] }>;
    expect(stories.map((r) => r.kind)).toEqual(["week", "week", "week", "week"]);
    expect(stories.map((r) => r.periodStart)).toEqual(["2026-09-07", "2026-08-31", "2026-08-17", "2026-08-10"]);
    expect(stories.map((r) => r.viewed)).toEqual([false, true, true, true]);
    expect(stories[0]!.fragment).toBe("“she just said finally”");
    expect(stories[0]!.cards).toEqual(PROTOTYPE_CARDS);
    // Encrypted at rest: the raw column is not the plaintext.
    const { rows } = await pool.query<{ fragment: string }>(`SELECT fragment FROM stories WHERE user_id = $1 LIMIT 1`, [userId]);
    expect(rows[0]!.fragment).not.toContain("finally");
  });

  it("re-seeding upserts the same weeks rather than duplicating them", async () => {
    const { agent, userId } = await makeUser("upsert");
    await seedPrototypeReviews(userId, NOW);
    await seedPrototypeReviews(userId, NOW);
    const res = await agent.get("/api/stories");
    expect(res.body.stories).toHaveLength(4);
  });

  it("row order: newest Goals, newest Routines, then at most six weeks newest first", async () => {
    const { agent, userId } = await makeUser("order");
    for (let w = 0; w < 8; w++) await insertStory(weekStory(userId, w, `week ${w}`));
    await insertStory({ userId, kind: "goals", periodStart: "2026-09-07", periodEnd: "2026-09-07", subjectId: 1, fragment: "Learn Spanish", cards: [{ kind: "goal", eyebrow: "Learn Spanish", text: "The Spanish is still here whenever you want to pick it back up." }] });
    await insertStory({ userId, kind: "goals", periodStart: "2026-09-08", periodEnd: "2026-09-08", subjectId: 2, fragment: "Run again", cards: [{ kind: "goal", eyebrow: "Run again", text: "You said you got the first run done and your legs hated you for it. That's the one that counts." }] });
    await insertStory({ userId, kind: "routines", periodStart: "2026-09-08", periodEnd: "2026-09-08", subjectId: 3, fragment: "Morning walk", cards: [{ kind: "routine", eyebrow: "Morning walk", text: "You logged the walk again this morning.", pattern: "Most days this week" }] });
    const res = await agent.get("/api/stories");
    const stories = res.body.stories as Array<{ kind: string; periodStart: string; fragment: string }>;
    expect(stories.map((s) => s.kind)).toEqual(["goals", "routines", "week", "week", "week", "week", "week", "week"]);
    expect(stories[0]!.fragment).toBe("Run again"); // the newest goals story, not the older one
    expect(stories[2]!.periodStart).toBe("2026-09-07");
  });

  it("viewed is persisted, permanent, idempotent, and only for your own stories", async () => {
    const { agent, userId } = await makeUser("viewed");
    const other = await makeUser("viewed-other");
    await seedPrototypeReviews(userId, NOW);
    const list = await agent.get("/api/stories");
    const newest = list.body.stories[0] as { id: number; viewed: boolean };
    expect(newest.viewed).toBe(false);

    const foreign = await other.agent.post(`/api/stories/${newest.id}/viewed`);
    expect(foreign.status).toBe(404);
    const still = await agent.get("/api/stories");
    expect(still.body.stories[0].viewed).toBe(false);

    const first = await agent.post(`/api/stories/${newest.id}/viewed`);
    expect(first.status).toBe(200);
    const after = await agent.get("/api/stories");
    expect(after.body.stories[0].viewed).toBe(true);

    const again = await agent.post(`/api/stories/${newest.id}/viewed`);
    expect(again.status).toBe(200);
    const final = await agent.get("/api/stories");
    expect(final.body.stories[0].viewed).toBe(true);

    const bad = await agent.post(`/api/stories/not-a-number/viewed`);
    expect(bad.status).toBe(400);
    const missing = await agent.post(`/api/stories/999999999/viewed`);
    expect(missing.status).toBe(404);
  });
});
