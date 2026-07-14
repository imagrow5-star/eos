/**
 * Integration tests: GET /api/account/export date-range filtering (?from & ?to).
 *
 * Covers:
 *  1. `from` excludes records before the start date.
 *  2. `to` is inclusive of the whole final day (end-of-day for timestamps).
 *  3. `from` + `to` combined returns only the in-range slice, across timestamp
 *     columns (messages) and date columns (mood_scores).
 *  4. No range → full history (unchanged behaviour).
 *  5. Invalid / impossible / reversed dates are rejected with 400.
 *  6. The HTML report respects the same filter.
 */

import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>(
    "SELECT id FROM users WHERE email = $1",
    [email],
  );
  if (!r.rowCount) return;
  const uid = r.rows[0]!.id;
  await pool.query(`
    BEGIN;
    DELETE FROM user_sessions              WHERE sess::jsonb->>'userId' = '${uid}';
    DELETE FROM password_reset_tokens       WHERE user_id = ${uid};
    DELETE FROM email_verification_tokens   WHERE user_id = ${uid};
    DELETE FROM messages                    WHERE user_id = ${uid};
    DELETE FROM memory_facts                WHERE user_id = ${uid};
    DELETE FROM personality_signals         WHERE user_id = ${uid};
    DELETE FROM wins                        WHERE user_id = ${uid};
    DELETE FROM mood_scores                 WHERE user_id = ${uid};
    DELETE FROM reminders                   WHERE user_id = ${uid};
    DELETE FROM commitments                 WHERE user_id = ${uid};
    DELETE FROM habit_completions           WHERE habit_id IN (SELECT id FROM habits WHERE user_id = ${uid});
    DELETE FROM habits                      WHERE user_id = ${uid};
    DELETE FROM goals                       WHERE user_id = ${uid};
    DELETE FROM profile                     WHERE user_id = ${uid};
    DELETE FROM users                       WHERE id      = ${uid};
    COMMIT;
  `);
}

/**
 * Sign up + verify a user, then insert three messages and three mood logs on
 * distinct calendar days (Jan, Mar, Jun 2026) so range boundaries can be tested.
 */
async function signupWithDatedData(
  agent: ReturnType<typeof request.agent>,
  email: string,
): Promise<number> {
  const signupRes = await agent
    .post("/api/auth/signup")
    .send({ email, password: "Test1234!" });
  expect(signupRes.status).toBe(201);
  const userId: number = signupRes.body.user.id;

  await pool.query(`UPDATE users SET email_verified_at = NOW() WHERE id = $1`, [userId]);

  await pool.query(
    `INSERT INTO profile (user_id, user_name, companion_name, user_path)
     VALUES ($1, 'Range User', 'Asha', 'breakup')
     ON CONFLICT DO NOTHING`,
    [userId],
  );

  // Messages: timestamp column. Note the June one at 22:00 to prove the `to`
  // boundary includes the whole final day, not just its midnight.
  await pool.query(
    `INSERT INTO messages (user_id, role, content, created_at) VALUES
       ($1, 'user', 'msg-jan', '2026-01-15T09:00:00Z'),
       ($1, 'user', 'msg-mar', '2026-03-15T09:00:00Z'),
       ($1, 'user', 'msg-jun', '2026-06-30T22:00:00Z')`,
    [userId],
  );

  // Mood scores: date column.
  await pool.query(
    `INSERT INTO mood_scores (user_id, score, date) VALUES
       ($1, 3, '2026-01-15'),
       ($1, 5, '2026-03-15'),
       ($1, 8, '2026-06-30')`,
    [userId],
  );

  return userId;
}

const TS = Date.now();
const EMAIL = `export-range-${TS}@example.invalid`;

interface RangeExportBody {
  range: { from: string | null; to: string | null } | null;
  messages: { content: string }[];
  moodScores: { score: number }[];
}

describe("GET /api/account/export — date range filter", () => {
  afterEach(async () => {
    await cleanupUser(EMAIL);
  });

  it("with no range, returns the full history and range=null", async () => {
    const agent = request.agent(app);
    await signupWithDatedData(agent, EMAIL);

    const res = await agent.get("/api/account/export");
    expect(res.status).toBe(200);
    const body = res.body as RangeExportBody;

    expect(body.range).toBeNull();
    const contents = body.messages.map((m) => m.content);
    expect(contents).toEqual(expect.arrayContaining(["msg-jan", "msg-mar", "msg-jun"]));
    expect(body.moodScores.length).toBe(3);
  });

  it("`from` excludes records before the start date", async () => {
    const agent = request.agent(app);
    await signupWithDatedData(agent, EMAIL);

    const res = await agent.get("/api/account/export?from=2026-03-01");
    expect(res.status).toBe(200);
    const body = res.body as RangeExportBody;

    const contents = body.messages.map((m) => m.content);
    expect(contents).toContain("msg-mar");
    expect(contents).toContain("msg-jun");
    expect(contents).not.toContain("msg-jan");

    // mood_scores (date column) filtered too
    expect(body.moodScores.map((m) => m.score).sort()).toEqual([5, 8]);
    expect(body.range).toEqual({ from: "2026-03-01", to: null });
  });

  it("`to` is inclusive of the whole final day for timestamp columns", async () => {
    const agent = request.agent(app);
    await signupWithDatedData(agent, EMAIL);

    // msg-jun is at 22:00 on 2026-06-30 — a naive `<= '2026-06-30'` (midnight)
    // would wrongly drop it. The end-of-day handling must keep it.
    const res = await agent.get("/api/account/export?to=2026-06-30");
    expect(res.status).toBe(200);
    const body = res.body as RangeExportBody;

    const contents = body.messages.map((m) => m.content);
    expect(contents).toContain("msg-jan");
    expect(contents).toContain("msg-mar");
    expect(contents).toContain("msg-jun");
  });

  it("`from` + `to` combined returns only the in-range slice", async () => {
    const agent = request.agent(app);
    await signupWithDatedData(agent, EMAIL);

    const res = await agent.get("/api/account/export?from=2026-02-01&to=2026-05-31");
    expect(res.status).toBe(200);
    const body = res.body as RangeExportBody;

    const contents = body.messages.map((m) => m.content);
    expect(contents).toEqual(["msg-mar"]);
    expect(body.moodScores.map((m) => m.score)).toEqual([5]);
    expect(body.range).toEqual({ from: "2026-02-01", to: "2026-05-31" });
  });

  it("the HTML report respects the same filter", async () => {
    const agent = request.agent(app);
    await signupWithDatedData(agent, EMAIL);

    const res = await agent.get("/api/account/export?format=html&from=2026-02-01&to=2026-05-31");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("msg-mar");
    expect(res.text).not.toContain("msg-jan");
    expect(res.text).not.toContain("msg-jun");
  });

  it("rejects a malformed date with 400", async () => {
    const agent = request.agent(app);
    await signupWithDatedData(agent, EMAIL);

    const res = await agent.get("/api/account/export?from=2026-13-01");
    expect(res.status).toBe(400);
  });

  it("rejects an impossible calendar date with 400", async () => {
    const agent = request.agent(app);
    await signupWithDatedData(agent, EMAIL);

    // 2026 is not a leap year — Feb 30 never exists.
    const res = await agent.get("/api/account/export?to=2026-02-30");
    expect(res.status).toBe(400);
  });

  it("rejects a reversed range (from after to) with 400", async () => {
    const agent = request.agent(app);
    await signupWithDatedData(agent, EMAIL);

    const res = await agent.get("/api/account/export?from=2026-06-01&to=2026-01-01");
    expect(res.status).toBe(400);
  });
});
