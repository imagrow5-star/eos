/**
 * Stories — the self-serve refresh and the internal route's email scope.
 *
 *  - POST /stories/refresh runs today's sweeps for the signed-in user only,
 *    ignoring the morning window, and is throttled per user so a reload can't
 *    spend model calls; it reports what was written and why not.
 *  - the internal route accepts an email as the scope, and an address with
 *    no account answers exactly like an account with nothing due (no 404
 *    oracle — security review).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { eq } from "drizzle-orm";
import { db, profileTable, habitsTable, habitCompletionsTable } from "@workspace/db";
import app from "../app.js";
import { internalToken } from "./helpers/internalToken.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const DB = Boolean(process.env.DATABASE_URL);
const email = `stories-refresh-${Date.now()}@example.com`;
let userId = 0;
const agent = request.agent(app);

beforeAll(async () => {
  if (!DB) return;
  const res = await agent.post("/api/auth/signup").send({ email, password: "Sup3r-secret!pw" });
  expect(res.status).toBeLessThan(300);
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
  userId = rows[0].id;
  await pool.query(`UPDATE users SET email_verified_at = NOW() WHERE id = $1`, [userId]);
  await agent.get("/api/profile");
  await db.update(profileTable).set({ isOnboardingComplete: true, timezone: "UTC", userPath: "breakup" }).where(eq(profileTable.userId, userId));
  // An established routine missed yesterday → the deflation card needs no model.
  const [walk] = await db.insert(habitsTable).values({ userId, name: "Morning walk", whenThen: "After coffee, I will walk", reason: "air" }).returning({ id: habitsTable.id });
  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  await db.insert(habitCompletionsTable).values([2, 4, 6].map((n) => ({ userId, habitId: walk!.id, completedDate: day(n) })));
});

afterAll(async () => {
  if (DB && userId) {
    await pool.query(`DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = $1`, [String(userId)]);
    for (const t of ["stories", "story_drops", "habit_completions", "habits", "email_verification_tokens", "profile"]) {
      await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]);
    }
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  }
  await pool.end();
});

describe.skipIf(!DB)("POST /stories/refresh", () => {
  it("requires a session", async () => {
    const res = await request(app).post("/api/stories/refresh");
    expect(res.status).toBe(401);
  });

  it("writes today's stories for this user, then throttles", async () => {
    const first = await agent.post("/api/stories/refresh");
    expect(first.status).toBe(200);
    expect(first.body.throttled).toBe(false);
    expect(first.body.subjects.considered).toBe(1);
    expect(first.body.subjects.routinesGenerated).toBe(1);
    expect(first.body.subjects.skipped["goals:no_goals"]).toBe(1);

    const list = await agent.get("/api/stories");
    const routines = (list.body.stories as Array<{ kind: string; viewed: boolean }>).find((s) => s.kind === "routines");
    expect(routines?.viewed).toBe(false); // the ring

    const second = await agent.post("/api/stories/refresh");
    expect(second.status).toBe(200);
    expect(second.body.throttled).toBe(true);
    expect(second.body.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe.skipIf(!DB)("internal sweep scoped by email", () => {
  it("scopes the run to the account behind the address", async () => {
    const body = { email, ignoreWindow: true };
    const res = await request(app)
      .post("/api/internal/stories/run")
      .set("x-internal-token", internalToken("stories-run", body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.subjects.considered).toBe(1);
    expect(res.body.subjects.skipped["routines:exists"]).toBe(1);
  });

  it("an address with no account answers like an account with nothing due (no oracle)", async () => {
    const body = { email: "nobody@example.com", ignoreWindow: true };
    const unknown = await request(app)
      .post("/api/internal/stories/run")
      .set("x-internal-token", internalToken("stories-run", body))
      .send(body);
    expect(unknown.status).toBe(200);
    expect(unknown.body.subjects.considered).toBe(0);
    expect(unknown.body.week.considered).toBe(0);
    expect(Object.keys(unknown.body)).toEqual(["week", "subjects"]);
  });
});
