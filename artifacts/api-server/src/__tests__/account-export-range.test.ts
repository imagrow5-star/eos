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
import bcrypt from "bcryptjs";
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

// ─── Boundary precision at the `to` edge ────────────────────────────────────────
// The plan calls out the exact off-by-one risk: the final day (`to`) must be
// included and the very next day must be excluded — separately for TIMESTAMP
// columns (end-of-day handling) and DATE columns (inclusive `<=`).

const BOUNDARY_EMAIL = `export-boundary-${TS}@example.invalid`;

/**
 * Seed data straddling a single boundary day (2026-06-15). For each of a
 * TIMESTAMP column (messages) and a DATE column (mood_scores) we place one row
 * on the boundary day itself and one row on the day after, so a range ending on
 * the boundary must keep the former and drop the latter.
 */
async function signupWithBoundaryData(
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
     VALUES ($1, 'Boundary User', 'Asha', 'breakup')
     ON CONFLICT DO NOTHING`,
    [userId],
  );

  // Messages (timestamp): one late on the boundary day, one just after midnight
  // the next day. A correct end-of-day rule keeps 'msg-on-to' and drops
  // 'msg-day-after'.
  await pool.query(
    `INSERT INTO messages (user_id, role, content, created_at) VALUES
       ($1, 'user', 'msg-day-before', '2026-06-14T23:30:00Z'),
       ($1, 'user', 'msg-on-to',      '2026-06-15T23:30:00Z'),
       ($1, 'user', 'msg-day-after',  '2026-06-16T00:30:00Z')`,
    [userId],
  );

  // Mood scores (date): one on each of the three calendar days.
  await pool.query(
    `INSERT INTO mood_scores (user_id, score, date) VALUES
       ($1, 4, '2026-06-14'),
       ($1, 6, '2026-06-15'),
       ($1, 9, '2026-06-16')`,
    [userId],
  );

  return userId;
}

interface BoundaryBody {
  messages: { content: string }[];
  moodScores: { score: number }[];
}

describe("GET /api/account/export — `to` boundary precision", () => {
  afterEach(async () => {
    await cleanupUser(BOUNDARY_EMAIL);
  });

  it("includes the whole final day and excludes the day after, for a TIMESTAMP column", async () => {
    const agent = request.agent(app);
    await signupWithBoundaryData(agent, BOUNDARY_EMAIL);

    const res = await agent.get("/api/account/export?to=2026-06-15");
    expect(res.status).toBe(200);
    const contents = (res.body as BoundaryBody).messages.map((m) => m.content);

    // A 23:30 message on the `to` date is kept (end-of-day, not midnight)...
    expect(contents).toContain("msg-on-to");
    expect(contents).toContain("msg-day-before");
    // ...but a message just after midnight the next day is dropped.
    expect(contents).not.toContain("msg-day-after");
  });

  it("includes the final day and excludes the day after, for a DATE column", async () => {
    const agent = request.agent(app);
    await signupWithBoundaryData(agent, BOUNDARY_EMAIL);

    const res = await agent.get("/api/account/export?to=2026-06-15");
    expect(res.status).toBe(200);
    const scores = (res.body as BoundaryBody).moodScores.map((m) => m.score).sort((a, b) => a - b);

    // Mood on 06-14 and 06-15 kept; mood on 06-16 (day after `to`) dropped.
    expect(scores).toEqual([4, 6]);
  });

  it("`from` includes the boundary day itself, across both column types", async () => {
    const agent = request.agent(app);
    await signupWithBoundaryData(agent, BOUNDARY_EMAIL);

    const res = await agent.get("/api/account/export?from=2026-06-15");
    expect(res.status).toBe(200);
    const body = res.body as BoundaryBody;

    const contents = body.messages.map((m) => m.content);
    expect(contents).toContain("msg-on-to");
    expect(contents).toContain("msg-day-after");
    expect(contents).not.toContain("msg-day-before");

    const scores = body.moodScores.map((m) => m.score).sort((a, b) => a - b);
    expect(scores).toEqual([6, 9]);
  });

  it("a single-day window (from === to) returns only that day", async () => {
    const agent = request.agent(app);
    await signupWithBoundaryData(agent, BOUNDARY_EMAIL);

    const res = await agent.get("/api/account/export?from=2026-06-15&to=2026-06-15");
    expect(res.status).toBe(200);
    const body = res.body as BoundaryBody;

    expect(body.messages.map((m) => m.content)).toEqual(["msg-on-to"]);
    expect(body.moodScores.map((m) => m.score)).toEqual([6]);
  });
});

// ─── Every remaining range-filtered category ────────────────────────────────────
// messages (TIMESTAMP) and mood_scores (DATE) are exercised above. `buildRangeClause`
// is also applied to eight other datasets — wins, memory_facts, habits, goals,
// commitments, reminders, personality_signals (all on the `created_at` TIMESTAMP)
// and habit_completions (on the `completed_date` DATE). A regression that leaked
// out-of-window rows, or dropped in-window rows, in any of these would otherwise
// ship untested. These tests seed each category around a single boundary day and
// assert the same inclusive-`to` / exclusive-day-after behaviour end-to-end.

const CATEGORY_EMAIL = `export-categories-${TS}@example.invalid`;

/**
 * Seed one dated row per category the day before the boundary (2026-06-14), on
 * the boundary day (2026-06-15), and the day after (2026-06-16). TIMESTAMP
 * categories get a late 23:30 time on their day so the end-of-day handling is
 * genuinely exercised; the DATE-based habit_completions get plain calendar days.
 */
async function seedCategoryData(
  agent: ReturnType<typeof request.agent>,
  email: string,
): Promise<number> {
  // Create the user directly and log in, rather than going through
  // POST /api/auth/signup. Signup sends a real verification email as a
  // background (fire-and-forget) fetch; piling more of those onto the suite can
  // tip timing-sensitive tests elsewhere. Login authenticates with no email.
  const hashed = await bcrypt.hash("Test1234!", 12);
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO users (email, hashed_password, email_verified_at)
     VALUES ($1, $2, NOW()) RETURNING id`,
    [email, hashed],
  );
  const userId: number = inserted.rows[0]!.id;

  const loginRes = await agent
    .post("/api/auth/login")
    .send({ email, password: "Test1234!" });
  expect(loginRes.status).toBe(200);

  await pool.query(
    `INSERT INTO profile (user_id, user_name, companion_name, user_path)
     VALUES ($1, 'Category User', 'Asha', 'breakup')
     ON CONFLICT DO NOTHING`,
    [userId],
  );

  const BEFORE = "2026-06-14T23:30:00Z";
  const ON = "2026-06-15T23:30:00Z";
  const AFTER = "2026-06-16T00:30:00Z";

  await pool.query(
    `INSERT INTO wins (user_id, content, created_at) VALUES
       ($1, 'win-before', $2), ($1, 'win-on', $3), ($1, 'win-after', $4)`,
    [userId, BEFORE, ON, AFTER],
  );
  await pool.query(
    `INSERT INTO memory_facts (user_id, fact, created_at) VALUES
       ($1, 'fact-before', $2), ($1, 'fact-on', $3), ($1, 'fact-after', $4)`,
    [userId, BEFORE, ON, AFTER],
  );
  await pool.query(
    `INSERT INTO habits (user_id, name, when_then, reason, created_at) VALUES
       ($1, 'habit-before', 'when-then', 'reason', $2),
       ($1, 'habit-on',     'when-then', 'reason', $3),
       ($1, 'habit-after',  'when-then', 'reason', $4)`,
    [userId, BEFORE, ON, AFTER],
  );
  await pool.query(
    `INSERT INTO goals (user_id, title, created_at) VALUES
       ($1, 'goal-before', $2), ($1, 'goal-on', $3), ($1, 'goal-after', $4)`,
    [userId, BEFORE, ON, AFTER],
  );
  await pool.query(
    `INSERT INTO commitments (user_id, content, created_at) VALUES
       ($1, 'commit-before', $2), ($1, 'commit-on', $3), ($1, 'commit-after', $4)`,
    [userId, BEFORE, ON, AFTER],
  );
  await pool.query(
    `INSERT INTO reminders (user_id, content, created_at) VALUES
       ($1, 'remind-before', $2), ($1, 'remind-on', $3), ($1, 'remind-after', $4)`,
    [userId, BEFORE, ON, AFTER],
  );
  await pool.query(
    `INSERT INTO personality_signals (user_id, signal, created_at) VALUES
       ($1, 'signal-before', $2), ($1, 'signal-on', $3), ($1, 'signal-after', $4)`,
    [userId, BEFORE, ON, AFTER],
  );

  // habit_completions filter on their own `completed_date` (DATE), independently
  // of the parent habit. The parent habit is created well outside every test
  // window so it never appears in the habits result and can't skew that
  // assertion, while its completions are still filtered on completed_date.
  const compHabit = await pool.query<{ id: number }>(
    `INSERT INTO habits (user_id, name, when_then, reason, created_at)
     VALUES ($1, 'comp-habit', 'when-then', 'reason', '2026-01-01T00:00:00Z') RETURNING id`,
    [userId],
  );
  const habitId = compHabit.rows[0]!.id;
  await pool.query(
    `INSERT INTO habit_completions (user_id, habit_id, completed_date) VALUES
       ($1, $2, '2026-06-14'), ($1, $2, '2026-06-15'), ($1, $2, '2026-06-16')`,
    [userId, habitId],
  );

  return userId;
}

interface CategoryBody {
  wins: { content: string }[];
  memoryFacts: { fact: string }[];
  habits: { name: string }[];
  goals: { title: string }[];
  commitments: { content: string }[];
  reminders: { content: string }[];
  personalitySignals: { signal: string }[];
  habitCompletions: { completed_date: string; habit_name: string }[];
}

describe("GET /api/account/export — every category honors the date filter", () => {
  afterEach(async () => {
    await cleanupUser(CATEGORY_EMAIL);
  });

  it("a single-day window returns only the on-boundary row for every category", async () => {
    const agent = request.agent(app);
    await seedCategoryData(agent, CATEGORY_EMAIL);

    const res = await agent.get("/api/account/export?from=2026-06-15&to=2026-06-15");
    expect(res.status).toBe(200);
    const body = res.body as CategoryBody;

    // Each category drops the day-before AND day-after rows, keeping only the
    // one on the boundary day — proving `from`/`to` inclusion and both-sided
    // exclusion simultaneously.
    expect(body.wins.map((w) => w.content)).toEqual(["win-on"]);
    expect(body.memoryFacts.map((f) => f.fact)).toEqual(["fact-on"]);
    expect(body.habits.map((h) => h.name)).toEqual(["habit-on"]);
    expect(body.goals.map((g) => g.title)).toEqual(["goal-on"]);
    expect(body.commitments.map((c) => c.content)).toEqual(["commit-on"]);
    expect(body.reminders.map((r) => r.content)).toEqual(["remind-on"]);
    expect(body.personalitySignals.map((s) => s.signal)).toEqual(["signal-on"]);
    expect(body.habitCompletions.map((hc) => hc.completed_date)).toEqual(["2026-06-15"]);
  });

  it("a window ending on the boundary includes the `to` day and excludes the day after, for every category", async () => {
    const agent = request.agent(app);
    await seedCategoryData(agent, CATEGORY_EMAIL);

    const res = await agent.get("/api/account/export?from=2026-06-01&to=2026-06-15");
    expect(res.status).toBe(200);
    const body = res.body as CategoryBody;

    // The `to` day (2026-06-15) is kept and the day after (2026-06-16) is
    // dropped across every range-filtered category (ordered by their date column).
    expect(body.wins.map((w) => w.content)).toEqual(["win-before", "win-on"]);
    expect(body.memoryFacts.map((f) => f.fact)).toEqual(["fact-before", "fact-on"]);
    expect(body.habits.map((h) => h.name)).toEqual(["habit-before", "habit-on"]);
    expect(body.goals.map((g) => g.title)).toEqual(["goal-before", "goal-on"]);
    expect(body.commitments.map((c) => c.content)).toEqual(["commit-before", "commit-on"]);
    expect(body.reminders.map((r) => r.content)).toEqual(["remind-before", "remind-on"]);
    expect(body.personalitySignals.map((s) => s.signal)).toEqual(["signal-before", "signal-on"]);
    expect(body.habitCompletions.map((hc) => hc.completed_date)).toEqual([
      "2026-06-14",
      "2026-06-15",
    ]);
  });
});
