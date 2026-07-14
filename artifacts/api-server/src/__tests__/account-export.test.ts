/**
 * Integration tests: GET /api/account/export data completeness and isolation.
 *
 * Covers:
 *  1. All user-owned tables are included in the export JSON.
 *  2. User A's export contains only User A's rows — no bleed from User B.
 *  3. Removing a row between exports causes the export to reflect live state.
 *  4. Schema-coverage guard: every table with a user_id column is represented
 *     in the export payload or explicitly documented as an exception.
 */

import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";

// ─── DB connection ────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

interface PopulatedUser {
  userId: number;
  habitId: number;
  goalId: number;
  messageContent: string;
  winContent: string;
  memoryFact: string;
  habitName: string;
  goalTitle: string;
  commitmentContent: string;
  reminderContent: string;
  personalitySignal: string;
}

/** Sign up a test user, verify their email, and populate all export-relevant tables. */
async function signupAndPopulate(
  agent: ReturnType<typeof request.agent>,
  email: string,
  tag: string,
): Promise<PopulatedUser> {
  const signupRes = await agent
    .post("/api/auth/signup")
    .send({ email, password: "Test1234!" });
  expect(signupRes.status).toBe(201);
  const userId: number = signupRes.body.user.id;

  // Mark the email as verified so the user passes requireVerified middleware
  await pool.query(
    `UPDATE users SET email_verified_at = NOW() WHERE id = $1`,
    [userId],
  );

  // profile — ensure it exists
  const profileExists = await pool.query(
    "SELECT id FROM profile WHERE user_id = $1 LIMIT 1",
    [userId],
  );
  if (!profileExists.rowCount) {
    await pool.query(
      `INSERT INTO profile (user_id, user_name, companion_name, user_path)
       VALUES ($1, $2, 'Asha', 'breakup')`,
      [userId, `User ${tag}`],
    );
  }

  // messages
  const messageContent = `hello from ${tag}`;
  await pool.query(
    `INSERT INTO messages (user_id, role, content) VALUES ($1, 'user', $2)`,
    [userId, messageContent],
  );

  // memory_facts
  const memoryFact = `fact from ${tag}`;
  await pool.query(
    `INSERT INTO memory_facts (user_id, fact, category) VALUES ($1, $2, 'life')`,
    [userId, memoryFact],
  );

  // wins
  const winContent = `win from ${tag}`;
  await pool.query(
    `INSERT INTO wins (user_id, content) VALUES ($1, $2)`,
    [userId, winContent],
  );

  // habits + habit_completions
  const habitName = `Habit-${tag}`;
  const habitRow = await pool.query<{ id: number }>(
    `INSERT INTO habits (user_id, name, when_then, reason)
     VALUES ($1, $2, 'Every morning', 'Health') RETURNING id`,
    [userId, habitName],
  );
  const habitId = habitRow.rows[0]!.id;

  await pool.query(
    `INSERT INTO habit_completions (user_id, habit_id, completed_date)
     VALUES ($1, $2, '2026-07-14')`,
    [userId, habitId],
  );

  // goals
  const goalTitle = `Goal-${tag}`;
  const goalRow = await pool.query<{ id: number }>(
    `INSERT INTO goals (user_id, title, description)
     VALUES ($1, $2, 'Test goal desc') RETURNING id`,
    [userId, goalTitle],
  );
  const goalId = goalRow.rows[0]!.id;

  // mood_scores
  await pool.query(
    `INSERT INTO mood_scores (user_id, score, date) VALUES ($1, 7, '2026-07-14')`,
    [userId],
  );

  // commitments
  const commitmentContent = `commitment from ${tag}`;
  await pool.query(
    `INSERT INTO commitments (user_id, content, cue) VALUES ($1, $2, 'morning')`,
    [userId, commitmentContent],
  );

  // reminders
  const reminderContent = `reminder from ${tag}`;
  await pool.query(
    `INSERT INTO reminders (user_id, content) VALUES ($1, $2)`,
    [userId, reminderContent],
  );

  // personality_signals
  const personalitySignal = `signal-${tag}`;
  await pool.query(
    `INSERT INTO personality_signals (user_id, signal) VALUES ($1, $2)`,
    [userId, personalitySignal],
  );

  return {
    userId, habitId, goalId,
    messageContent, winContent, memoryFact,
    habitName, goalTitle,
    commitmentContent, reminderContent, personalitySignal,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const TS = Date.now();
const EMAIL_A = `export-a-${TS}@example.invalid`;
const EMAIL_B = `export-b-${TS}@example.invalid`;

describe("GET /api/account/export", () => {
  afterEach(async () => {
    await Promise.all([cleanupUser(EMAIL_A), cleanupUser(EMAIL_B)]);
  });

  it("includes all user-owned data in the JSON export", async () => {
    const agentA = request.agent(app);
    const a = await signupAndPopulate(agentA, EMAIL_A, "A");

    const res = await agentA.get("/api/account/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);

    const body = res.body as {
      exportedAt: string;
      profile: Record<string, unknown> | null;
      messages: Record<string, unknown>[];
      memoryFacts: Record<string, unknown>[];
      wins: Record<string, unknown>[];
      habits: Record<string, unknown>[];
      habitCompletions: Record<string, unknown>[];
      goals: Record<string, unknown>[];
      moodScores: Record<string, unknown>[];
      commitments: Record<string, unknown>[];
      reminders: Record<string, unknown>[];
      personalitySignals: Record<string, unknown>[];
    };

    // Top-level shape
    expect(body.exportedAt).toBeDefined();
    expect(typeof body.exportedAt).toBe("string");

    // profile present
    expect(body.profile).not.toBeNull();

    // messages
    expect(body.messages.length).toBeGreaterThanOrEqual(1);
    expect(body.messages.some((m) => m.content === a.messageContent)).toBe(true);

    // memory_facts
    expect(body.memoryFacts.length).toBeGreaterThanOrEqual(1);
    expect(body.memoryFacts.some((f) => f.fact === a.memoryFact)).toBe(true);

    // wins
    expect(body.wins.length).toBeGreaterThanOrEqual(1);
    expect(body.wins.some((w) => w.content === a.winContent)).toBe(true);

    // habits
    expect(body.habits.length).toBeGreaterThanOrEqual(1);
    expect(body.habits.some((h) => h.name === a.habitName)).toBe(true);

    // habit_completions
    expect(body.habitCompletions.length).toBeGreaterThanOrEqual(1);
    expect(body.habitCompletions.some((hc) => hc.habit_name === a.habitName)).toBe(true);

    // goals
    expect(body.goals.length).toBeGreaterThanOrEqual(1);
    expect(body.goals.some((g) => g.title === a.goalTitle)).toBe(true);

    // mood_scores
    expect(body.moodScores.length).toBeGreaterThanOrEqual(1);
    expect(body.moodScores.some((m) => m.score === 7)).toBe(true);

    // commitments
    expect(body.commitments.length).toBeGreaterThanOrEqual(1);
    expect(body.commitments.some((c) => c.content === a.commitmentContent)).toBe(true);

    // reminders
    expect(body.reminders.length).toBeGreaterThanOrEqual(1);
    expect(body.reminders.some((r) => r.content === a.reminderContent)).toBe(true);

    // personality_signals
    expect(body.personalitySignals.length).toBeGreaterThanOrEqual(1);
    expect(body.personalitySignals.some((s) => s.signal === a.personalitySignal)).toBe(true);
  });

  it("user A's export contains no data belonging to user B", async () => {
    const agentA = request.agent(app);
    const agentB = request.agent(app);

    const [a, b] = await Promise.all([
      signupAndPopulate(agentA, EMAIL_A, "A"),
      signupAndPopulate(agentB, EMAIL_B, "B"),
    ]);

    // Export as user A
    const res = await agentA.get("/api/account/export");
    expect(res.status).toBe(200);

    const body = res.body as {
      messages: { content: string }[];
      memoryFacts: { fact: string }[];
      wins: { content: string }[];
      habits: { name: string }[];
      habitCompletions: { habit_name: string }[];
      goals: { title: string }[];
      commitments: { content: string }[];
      reminders: { content: string }[];
      personalitySignals: { signal: string }[];
    };

    // A's own data is present
    expect(body.messages.some((m) => m.content === a.messageContent)).toBe(true);
    expect(body.wins.some((w) => w.content === a.winContent)).toBe(true);
    expect(body.memoryFacts.some((f) => f.fact === a.memoryFact)).toBe(true);
    expect(body.habits.some((h) => h.name === a.habitName)).toBe(true);
    expect(body.habitCompletions.some((hc) => hc.habit_name === a.habitName)).toBe(true);
    expect(body.goals.some((g) => g.title === a.goalTitle)).toBe(true);
    expect(body.commitments.some((c) => c.content === a.commitmentContent)).toBe(true);
    expect(body.reminders.some((r) => r.content === a.reminderContent)).toBe(true);
    expect(body.personalitySignals.some((s) => s.signal === a.personalitySignal)).toBe(true);

    // B's data must not appear in any section
    expect(body.messages.some((m) => m.content === b.messageContent)).toBe(false);
    expect(body.wins.some((w) => w.content === b.winContent)).toBe(false);
    expect(body.memoryFacts.some((f) => f.fact === b.memoryFact)).toBe(false);
    expect(body.habits.some((h) => h.name === b.habitName)).toBe(false);
    expect(body.habitCompletions.some((hc) => hc.habit_name === b.habitName)).toBe(false);
    expect(body.goals.some((g) => g.title === b.goalTitle)).toBe(false);
    expect(body.commitments.some((c) => c.content === b.commitmentContent)).toBe(false);
    expect(body.reminders.some((r) => r.content === b.reminderContent)).toBe(false);
    expect(body.personalitySignals.some((s) => s.signal === b.personalitySignal)).toBe(false);
  });

  it("export reflects live state — deleted rows disappear on the next call", async () => {
    const agentA = request.agent(app);
    const a = await signupAndPopulate(agentA, EMAIL_A, "A");

    // First export — win is present
    const before = await agentA.get("/api/account/export");
    expect(before.status).toBe(200);
    expect(
      (before.body.wins as { content: string }[]).some((w) => w.content === a.winContent),
    ).toBe(true);

    // Delete the win directly from the DB
    await pool.query(
      `DELETE FROM wins WHERE user_id = $1 AND content = $2`,
      [a.userId, a.winContent],
    );

    // Second export — win must be gone
    const after = await agentA.get("/api/account/export");
    expect(after.status).toBe(200);
    expect(
      (after.body.wins as { content: string }[]).some((w) => w.content === a.winContent),
    ).toBe(false);
  });

  it("returns 401 when the caller is not authenticated", async () => {
    const res = await request(app).get("/api/account/export");
    expect(res.status).toBe(401);
  });

  it("export payload covers every table that has a user_id column", async () => {
    /**
     * Schema-coverage guard.
     *
     * When a developer adds a new table with a user_id FK they MUST either:
     *   1. Add a query for it in the Promise.all inside GET /account/export and
     *      add its payload key to EXPORT_COVERED_TABLES below, OR
     *   2. Add it to INTENTIONAL_EXCEPTIONS with a comment explaining why it
     *      should not appear in the user-facing export.
     *
     * Tables whose user_id is stored in a non-standard way (jsonb column) are
     * listed in INTENTIONAL_EXCEPTIONS below.
     *
     * "Covered" here means the table is queried and its rows appear in the
     * JSON export payload.  Add a new key whenever you add a table to the
     * export's Promise.all.
     */

    // Keys present in the JSON export payload for each user-owned table.
    // habit_completions is included via a JOIN but is a user-owned table.
    const EXPORT_COVERED_TABLES = new Set([
      "profile",
      "messages",
      "memory_facts",
      "wins",
      "habits",
      "habit_completions",
      "goals",
      "mood_scores",
      "commitments",
      "reminders",
      "personality_signals",
    ]);

    // Tables with a user_id column that are intentionally excluded from the
    // export because they are internal/operational data rather than user
    // product data, or because they are handled differently.
    const INTENTIONAL_EXCEPTIONS: Record<string, string> = {
      password_reset_tokens: "Internal security tokens — not user product data; excluded from export for security.",
      email_verification_tokens: "Internal security tokens — not user product data; excluded from export for security.",
      // user_sessions stores userId inside a jsonb column, not a typed user_id column,
      // so it does not appear in the information_schema query below.
    };

    const result = await pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name   = 'user_id'
      ORDER BY table_name
    `);

    const tablesWithUserId = result.rows.map((r) => r.table_name);

    const uncovered = tablesWithUserId.filter(
      (t) => !EXPORT_COVERED_TABLES.has(t) && !(t in INTENTIONAL_EXCEPTIONS),
    );

    expect(
      uncovered,
      `The following tables have a user_id column but are NOT represented in ` +
        `GET /account/export:\n  ${uncovered.join("\n  ")}\n\n` +
        `Add a query for them in the export route (account.ts) and add their ` +
        `names to EXPORT_COVERED_TABLES in this test file.`,
    ).toEqual([]);

    // Inverse check: catch stale entries after a table is renamed or dropped.
    const schemaSet = new Set(tablesWithUserId);
    const stale = [...EXPORT_COVERED_TABLES].filter((t) => !schemaSet.has(t));

    expect(
      stale,
      `EXPORT_COVERED_TABLES references tables that no longer have a user_id ` +
        `column in the schema:\n  ${stale.join("\n  ")}\n\n` +
        `Remove or update these entries in this test file.`,
    ).toEqual([]);
  });
});

// ─── HTML export (?format=html) ─────────────────────────────────────────────────

/** Sign up + verify a user WITHOUT populating any product data. */
async function signupEmptyUser(
  agent: ReturnType<typeof request.agent>,
  email: string,
): Promise<number> {
  const signupRes = await agent
    .post("/api/auth/signup")
    .send({ email, password: "Test1234!" });
  expect(signupRes.status).toBe(201);
  const userId: number = signupRes.body.user.id;
  await pool.query(
    `UPDATE users SET email_verified_at = NOW() WHERE id = $1`,
    [userId],
  );
  return userId;
}

const HTML_EMAIL_A = `export-html-a-${TS}@example.invalid`;
const HTML_EMAIL_EMPTY = `export-html-empty-${TS}@example.invalid`;

describe("GET /api/account/export?format=html", () => {
  afterEach(async () => {
    await Promise.all([cleanupUser(HTML_EMAIL_A), cleanupUser(HTML_EMAIL_EMPTY)]);
  });

  it("serves an HTML attachment with the right headers", async () => {
    const agentA = request.agent(app);
    await signupAndPopulate(agentA, HTML_EMAIL_A, "H");

    const res = await agentA.get("/api/account/export?format=html");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["content-disposition"]).toMatch(/attachment/);
    expect(res.headers["content-disposition"]).toMatch(/\.html/);
    expect(res.text.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("renders every section heading and real data for a populated user", async () => {
    const agentA = request.agent(app);
    const a = await signupAndPopulate(agentA, HTML_EMAIL_A, "H");

    const res = await agentA.get("/api/account/export?format=html");
    expect(res.status).toBe(200);
    const html = res.text;

    // Every section heading is present
    expect(html).toContain("Conversation history");
    expect(html).toContain("Wins &amp; victories");
    expect(html).toContain("Habits");
    expect(html).toContain("Goals");
    expect(html).toContain("Mood journal");
    expect(html).toContain("knows about you"); // memory section
    expect(html).toContain("Commitments");
    expect(html).toContain("Reminders");
    expect(html).toContain("Personality insights");

    // Actual data values from each populated table appear in the report
    expect(html).toContain(a.messageContent);
    expect(html).toContain(a.winContent);
    expect(html).toContain(a.habitName);
    expect(html).toContain(a.goalTitle);
    expect(html).toContain(a.memoryFact);
    expect(html).toContain(a.commitmentContent);
    expect(html).toContain(a.reminderContent);
    expect(html).toContain(a.personalitySignal);

    // No empty-state fallbacks should appear when the user has data
    expect(html).not.toContain("No messages yet.");
    expect(html).not.toContain("No wins recorded yet.");
    expect(html).not.toContain("No habits tracked yet.");
    expect(html).not.toContain("No goals set yet.");
  });

  it("shows empty-state fallbacks for a user with no data", async () => {
    const agentEmpty = request.agent(app);
    await signupEmptyUser(agentEmpty, HTML_EMAIL_EMPTY);

    const res = await agentEmpty.get("/api/account/export?format=html");
    expect(res.status).toBe(200);
    const html = res.text;

    // Section headings still render...
    expect(html).toContain("Conversation history");
    expect(html).toContain("Mood journal");
    expect(html).toContain("Personality insights");

    // ...but each section shows its "empty" fallback string
    expect(html).toContain("No messages yet.");
    expect(html).toContain("No wins recorded yet.");
    expect(html).toContain("No habits tracked yet.");
    expect(html).toContain("No goals set yet.");
    expect(html).toContain("No mood logs yet.");
    expect(html).toContain("No memories recorded yet.");
    expect(html).toContain("No commitments yet.");
    expect(html).toContain("No reminders set.");
    expect(html).toContain("No personality signals observed yet.");
  });

  it("escapes HTML in user content to prevent broken markup / injection", async () => {
    const agentA = request.agent(app);
    const userId = await signupEmptyUser(agentA, HTML_EMAIL_A);
    const xss = `<script>alert('x')</script> & "quotes"`;
    await pool.query(
      `INSERT INTO wins (user_id, content) VALUES ($1, $2)`,
      [userId, xss],
    );

    const res = await agentA.get("/api/account/export?format=html");
    expect(res.status).toBe(200);
    const html = res.text;

    // The raw script tag must never appear unescaped in the output
    expect(html).not.toContain("<script>alert('x')</script>");
    // The escaped form should be present instead
    expect(html).toContain("&lt;script&gt;");
  });
});
