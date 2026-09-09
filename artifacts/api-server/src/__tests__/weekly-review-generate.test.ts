/**
 * Weekly review — stage 3 generator, end to end against the database (no
 * model: ANTHROPIC_API_KEY is unset in tests, so the story is composed from
 * the deterministic sources only).
 *
 *  1. A real week of messages, a win and an open commitment → one story row,
 *     with the marker fragment verbatim from a message.
 *  2. One row per (user, week): the second run is "exists"; force replaces.
 *  3. Bereavement path and a crisis line this week trip the guardrail; the
 *     crisis line never reaches the fragment.
 *  4. The sweep respects the Sunday-evening window; the internal route is
 *     HMAC-gated.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { eq } from "drizzle-orm";
import { db, messagesTable, winsTable, commitmentsTable, profileTable, weeklyChaptersTable } from "@workspace/db";
import app from "../app.js";
import { generateWeeklyReviewForUser, runWeeklyReviewSweep, targetWeek, inGenerationWindow } from "../services/weeklyReviewGenerate.js";
import { listStoriesOfKind } from "../services/stories.js";
import { storiesRunToken } from "../routes/stories.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const DB = Boolean(process.env.DATABASE_URL);

// Sunday 2026-09-06, 20:00 UTC → the week Mon 2026-08-31 … Sun 2026-09-06.
const SUNDAY_EVENING = new Date("2026-09-06T20:00:00Z");
const WEDNESDAY = new Date("2026-09-09T12:00:00Z");

let userId = 0;
const email = `weekly-review-gen-${Date.now()}@example.com`;

async function addMessage(content: string, at: string, role = "user"): Promise<number> {
  const [row] = await db.insert(messagesTable).values({ userId, role, content, createdAt: new Date(at) }).returning({ id: messagesTable.id });
  return row!.id;
}

beforeAll(async () => {
  if (!DB) return;
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/signup").send({ email, password: "Sup3r-secret!pw" });
  expect(res.status).toBeLessThan(300);
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
  userId = rows[0].id;
  await pool.query(`UPDATE users SET email_verified_at = NOW() WHERE id = $1`, [userId]);
  await agent.get("/api/profile"); // creates the profile row
  await db
    .update(profileTable)
    .set({ isOnboardingComplete: true, timezone: "UTC", userName: "Sam", userPath: "breakup" })
    .where(eq(profileTable.userId, userId));

  // An older first message (July) so the forward card has a month to point at.
  await addMessage("first night in the flat on my own", "2026-07-15T21:00:00Z");
  await addMessage("Quiet start. Work was fine, the flat is too quiet though.", "2026-08-31T19:00:00Z");
  await addMessage("Talked to my dad about the garden again, he wants me to come and see the roses.", "2026-09-01T19:00:00Z");
  await addMessage("Feeling steady today. Steady is the word I keep coming back to.", "2026-09-02T19:00:00Z");
  await addMessage("Walked again, two days running now. Steady.", "2026-09-03T19:00:00Z");
  await addMessage("I texted my sister back. She just said finally.", "2026-09-04T19:00:00Z");
  await addMessage("Still steady. Not great, not bad, just steady.", "2026-09-05T19:00:00Z");
  await addMessage("that counts, two days running", "2026-09-03T19:01:00Z", "assistant");

  await db.insert(winsTable).values({ userId, content: "I walked two days running, even though it felt heavy.", createdAt: new Date("2026-09-03T19:02:00Z") });
  await db.insert(commitmentsTable).values({
    userId,
    content: "I'll call my brother on Sunday",
    cue: "",
    state: "open",
    scheduledDate: "2026-09-06",
    createdAt: new Date("2026-09-02T19:05:00Z"),
  });
});

afterAll(async () => {
  if (DB && userId) {
    await pool.query(`DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = $1`, [String(userId)]);
    for (const t of ["stories", "story_drops", "weekly_chapters", "commitments", "wins", "messages", "email_verification_tokens", "profile"]) {
      await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]);
    }
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  }
  await pool.end();
});

describe("targetWeek / inGenerationWindow", () => {
  it("Sunday writes the week that is ending; Monday writes the week just ended; midweek too", () => {
    expect(targetWeek("UTC", SUNDAY_EVENING)).toEqual({ weekStart: "2026-08-31", weekEnd: "2026-09-06" });
    expect(targetWeek("UTC", new Date("2026-09-07T08:00:00Z"))).toEqual({ weekStart: "2026-08-31", weekEnd: "2026-09-06" });
    expect(targetWeek("UTC", WEDNESDAY)).toEqual({ weekStart: "2026-08-31", weekEnd: "2026-09-06" });
    // Timezone-aware: 20:00 UTC on Sunday is already Monday 05:00 in Sydney,
    // which still targets the week that just ended.
    expect(targetWeek("Australia/Sydney", SUNDAY_EVENING)).toEqual({ weekStart: "2026-08-31", weekEnd: "2026-09-06" });
  });

  it("the window is Sunday from 18:00 and Monday until 09:00, user-local", () => {
    expect(inGenerationWindow("UTC", SUNDAY_EVENING)).toBe(true);
    expect(inGenerationWindow("UTC", new Date("2026-09-06T10:00:00Z"))).toBe(false);
    expect(inGenerationWindow("UTC", new Date("2026-09-07T08:00:00Z"))).toBe(true);
    expect(inGenerationWindow("UTC", WEDNESDAY)).toBe(false);
    expect(inGenerationWindow("America/Los_Angeles", SUNDAY_EVENING)).toBe(false); // 13:00 local
  });
});

describe.skipIf(!DB)("generateWeeklyReviewForUser", () => {
  it("writes one story from a real week: did, then/now absent (no chapter), open, pattern, forward", async () => {
    const r = await generateWeeklyReviewForUser(userId, { now: SUNDAY_EVENING });
    expect(r.skipped).toBeUndefined();
    expect(r.reviewId).toBeTypeOf("number");
    expect(r.weekStart).toBe("2026-08-31");

    const [view] = await listStoriesOfKind(userId, "week", 6);
    expect(view!.periodStart).toBe("2026-08-31");
    expect(view!.viewed).toBe(false);
    expect(view!.cards.map((c) => c.kind)).toEqual(["did", "open", "pattern", "forward"]);
    expect(view!.cards[0]).toEqual({ kind: "did", eyebrow: "On Thursday", text: "You walked two days running, even though it felt heavy." });
    expect(view!.cards[1]).toEqual({ kind: "open", eyebrow: "Still sitting there", text: "You said you’d call your brother on Sunday. You haven’t yet." });
    expect(view!.cards[2]).toEqual({ kind: "pattern", eyebrow: "Something you keep saying", phrase: "“steady”", said: "Five times this month." });
    expect(view!.cards[3]).toEqual({ kind: "forward", text: "You’re not who you were in July.", sub: null });

    // The marker fragment is their own words, verbatim from a message this week.
    const inner = view!.fragment.replace(/^“|”$/g, "");
    const { rows } = await pool.query(`SELECT id FROM messages WHERE user_id = $1 AND role = 'user'`, [userId]);
    const contents = await db.select({ content: messagesTable.content }).from(messagesTable).where(eq(messagesTable.userId, userId));
    expect(rows.length).toBeGreaterThan(0);
    expect(contents.some((m) => m.content.includes(inner))).toBe(true);
  });

  it("is one row per week: a second run is 'exists', force replaces in place", async () => {
    const again = await generateWeeklyReviewForUser(userId, { now: SUNDAY_EVENING });
    expect(again.skipped).toBe("exists");
    const forced = await generateWeeklyReviewForUser(userId, { now: SUNDAY_EVENING, force: true });
    expect(forced.reviewId).toBeTypeOf("number");
    const all = await listStoriesOfKind(userId, "week", 6);
    expect(all.length).toBe(1);
  });

  it("with this week's chapter present, the then/now pair joins the story", async () => {
    const { rows } = await pool.query(
      `SELECT id FROM messages WHERE user_id = $1 AND role = 'user' ORDER BY created_at ASC`,
      [userId],
    );
    const firstId = rows[0].id as number;
    const fridayId = rows[5].id as number;
    await db.insert(weeklyChaptersTable).values({
      userId,
      weekStart: "2026-08-31",
      weekEnd: "2026-09-06",
      thresholdQuestion: "How was it?",
      themes: [
        {
          key: "family",
          title: "Family",
          kind: "standard",
          stillTrue: false,
          quotes: [
            { messageId: firstId, text: "first night in the flat on my own", date: "2026-07-15", kind: "then" },
            { messageId: fridayId, text: "She just said finally.", date: "2026-09-04", kind: "now" },
          ],
          reflection: "",
        },
      ],
    });
    const r = await generateWeeklyReviewForUser(userId, { now: SUNDAY_EVENING, force: true });
    expect(r.reviewId).toBeTypeOf("number");
    const [view] = await listStoriesOfKind(userId, "week", 6);
    expect(view!.cards.map((c) => c.kind)).toEqual(["did", "thenNow", "open", "pattern", "forward"]);
    expect(view!.cards[0]).toMatchObject({ kind: "did", eyebrow: "On Thursday" });
    expect(view!.cards[1]).toEqual({
      kind: "thenNow",
      eyebrow: "Your words",
      then: { stamp: "Seven weeks ago", quote: "“first night in the flat on my own”" },
      now: { stamp: "Friday", quote: "“She just said finally.”" },
    });
  });

  it("the bereavement path suppresses 'did' and 'forward'", async () => {
    await db.update(profileTable).set({ userPath: "bereavement" }).where(eq(profileTable.userId, userId));
    const r = await generateWeeklyReviewForUser(userId, { now: SUNDAY_EVENING, force: true });
    expect(r.reviewId).toBeTypeOf("number");
    const [view] = await listStoriesOfKind(userId, "week", 6);
    expect(view!.cards.map((c) => c.kind)).toEqual(["thenNow", "open", "pattern"]);
    await db.update(profileTable).set({ userPath: "breakup" }).where(eq(profileTable.userId, userId));
  });

  it("a crisis line this week trips the guardrail and is never quoted", async () => {
    const crisisId = await addMessage("I want to kill myself, I can't do this anymore", "2026-09-05T23:00:00Z");
    const r = await generateWeeklyReviewForUser(userId, { now: SUNDAY_EVENING, force: true });
    expect(r.reviewId).toBeTypeOf("number");
    const [view] = await listStoriesOfKind(userId, "week", 6);
    expect(view!.cards.map((c) => c.kind)).toEqual(["thenNow", "open", "pattern"]);
    expect(view!.fragment).not.toMatch(/kill myself/);
    expect(JSON.stringify(view!.cards)).not.toMatch(/kill myself/);
    await pool.query(`DELETE FROM messages WHERE id = $1`, [crisisId]);
  });

  it("a quiet week is no story", async () => {
    const r = await generateWeeklyReviewForUser(userId, { now: new Date("2026-08-23T20:00:00Z"), force: true });
    expect(r.skipped).toBe("quiet_week");
  });
});

describe.skipIf(!DB)("sweep + internal route", () => {
  it("the sweep skips users outside their window unless told otherwise", async () => {
    const outside = await runWeeklyReviewSweep({ now: WEDNESDAY, onlyUserId: userId });
    expect(outside.considered).toBe(0);
    const inside = await runWeeklyReviewSweep({ now: SUNDAY_EVENING, onlyUserId: userId });
    expect(inside.considered).toBe(1);
    expect((inside.skipped.exists ?? 0) + inside.generated).toBe(1);
    const ignored = await runWeeklyReviewSweep({ now: WEDNESDAY, onlyUserId: userId, ignoreWindow: true, force: true });
    expect(ignored.generated).toBe(1);
  });

  it("POST /api/internal/stories/run is HMAC-gated", async () => {
    const no = await request(app).post("/api/internal/stories/run").send({ userId });
    expect(no.status).toBe(401);
    const bad = await request(app).post("/api/internal/stories/run").set("x-internal-token", "nope").send({ userId });
    expect(bad.status).toBe(401);
    const token = storiesRunToken(process.env.SESSION_SECRET!, new Date());
    const ok = await request(app)
      .post("/api/internal/stories/run")
      .set("x-internal-token", token)
      .send({ userId, ignoreWindow: true });
    expect(ok.status).toBe(200);
    expect(ok.body.week.considered).toBe(1);
    expect(ok.body.subjects.considered).toBe(1);
  });
});
