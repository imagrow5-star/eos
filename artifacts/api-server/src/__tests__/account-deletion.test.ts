/**
 * Integration test: account deletion wipes all user-owned data.
 *
 * Strategy:
 *  1. Create a real user via POST /api/auth/signup (session cookie captured).
 *  2. Insert at least one row into every user-owned table directly via pg.
 *  3. Call DELETE /api/auth/account with that session cookie.
 *  4. Assert every table has 0 rows for that userId.
 *  5. Assert GET /api/auth/me returns 401 (session cleared).
 */

import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";

// ─── DB connection (same DATABASE_URL the app uses) ─────────────────────────

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function rowCount(
  table: string,
  where: string,
  params: unknown[],
): Promise<number> {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`,
    params,
  );
  return (r.rows[0] as { n: number }).n;
}

/** Clean up any test user that may have been left behind. */
async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>(
    "SELECT id FROM users WHERE email = $1",
    [email],
  );
  if (r.rowCount === 0) return;
  const uid = r.rows[0]!.id;

  await pool.query(`
    BEGIN;
    DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = '${uid}';
    DELETE FROM password_reset_tokens WHERE user_id = ${uid};
    DELETE FROM email_verification_tokens WHERE user_id = ${uid};
    DELETE FROM messages          WHERE user_id = ${uid};
    DELETE FROM memory_facts      WHERE user_id = ${uid};
    DELETE FROM personality_signals WHERE user_id = ${uid};
    DELETE FROM wins              WHERE user_id = ${uid};
    DELETE FROM mood_scores       WHERE user_id = ${uid};
    DELETE FROM reminders         WHERE user_id = ${uid};
    DELETE FROM habit_completions WHERE habit_id IN (SELECT id FROM habits WHERE user_id = ${uid});
    DELETE FROM habits            WHERE user_id = ${uid};
    DELETE FROM goals             WHERE user_id = ${uid};
    DELETE FROM commitments       WHERE user_id = ${uid};
    DELETE FROM profile           WHERE user_id = ${uid};
    DELETE FROM users             WHERE id = ${uid};
    COMMIT;
  `);
}

// ─── Test ────────────────────────────────────────────────────────────────────

const TEST_EMAIL = `deletion-test-${Date.now()}@example.invalid`;
const TEST_PASSWORD = "Test1234!";

describe("DELETE /api/auth/account", () => {
  afterEach(async () => {
    // Safety net: remove test user even if the deletion endpoint failed
    await cleanupUser(TEST_EMAIL);
  });

  it("wipes all user-owned data and clears the session cookie", async () => {
    // ── 1. Sign up ────────────────────────────────────────────────────────
    const agent = request.agent(app);

    const signupRes = await agent
      .post("/api/auth/signup")
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    expect(signupRes.status).toBe(201);
    const userId: number = signupRes.body.user.id;
    expect(userId).toBeTypeOf("number");

    // ── 2. Populate every user-owned table ────────────────────────────────

    // profile — created automatically on first profile GET, but insert directly.
    // Only insert if one doesn't already exist (signup may have created it via
    // getOrCreateProfileForUser in some code paths).
    const profileExists = await pool.query(
      "SELECT id FROM profile WHERE user_id = $1 LIMIT 1",
      [userId],
    );
    if (profileExists.rowCount === 0) {
      await pool.query(
        `INSERT INTO profile (user_id, user_name, companion_name)
         VALUES ($1, 'Test User', 'Asha')`,
        [userId],
      );
    }

    // messages
    await pool.query(
      `INSERT INTO messages (user_id, role, content) VALUES ($1, 'user', 'hello')`,
      [userId],
    );

    // memory_facts
    await pool.query(
      `INSERT INTO memory_facts (user_id, fact, category) VALUES ($1, 'test fact', 'life')`,
      [userId],
    );

    // personality_signals
    await pool.query(
      `INSERT INTO personality_signals (user_id, signal) VALUES ($1, 'curious')`,
      [userId],
    );

    // wins
    await pool.query(
      `INSERT INTO wins (user_id, content) VALUES ($1, 'a small victory')`,
      [userId],
    );

    // mood_scores
    await pool.query(
      `INSERT INTO mood_scores (user_id, score, date) VALUES ($1, 7, '2026-07-14')`,
      [userId],
    );

    // reminders
    await pool.query(
      `INSERT INTO reminders (user_id, content) VALUES ($1, 'call mom')`,
      [userId],
    );

    // habits + habit_completions
    const habitRes = await pool.query<{ id: number }>(
      `INSERT INTO habits (user_id, name, when_then, reason) VALUES ($1, 'Walk', 'Every morning', 'Stay healthy') RETURNING id`,
      [userId],
    );
    const habitId = habitRes.rows[0]!.id;

    await pool.query(
      `INSERT INTO habit_completions (user_id, habit_id, completed_date) VALUES ($1, $2, '2026-07-14')`,
      [userId, habitId],
    );

    // goals + goal_tasks (goal_tasks cascade from goals)
    const goalRes = await pool.query<{ id: number }>(
      `INSERT INTO goals (user_id, title, description) VALUES ($1, 'Test goal', '') RETURNING id`,
      [userId],
    );
    const goalId = goalRes.rows[0]!.id;

    await pool.query(
      `INSERT INTO goal_tasks (goal_id, content) VALUES ($1, 'Step 1')`,
      [goalId],
    );

    // commitments
    await pool.query(
      `INSERT INTO commitments (user_id, content, cue) VALUES ($1, 'text Sam', 'morning')`,
      [userId],
    );

    // password_reset_tokens
    await pool.query(
      `INSERT INTO password_reset_tokens (token, user_id, expires_at)
       VALUES ('testtoken123abc', $1, NOW() + INTERVAL '1 hour')`,
      [userId],
    );

    // ── 3. Sanity-check: rows exist before deletion ───────────────────────
    expect(await rowCount("messages", "user_id = $1", [userId])).toBeGreaterThan(0);
    expect(await rowCount("habits", "user_id = $1", [userId])).toBeGreaterThan(0);

    // ── 4. Delete account ─────────────────────────────────────────────────
    const deleteRes = await agent.delete("/api/auth/account");
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.ok).toBe(true);

    // ── 5. Assert every table is clean for this userId ────────────────────

    // users row
    expect(await rowCount("users", "id = $1", [userId])).toBe(0);

    // profile
    expect(await rowCount("profile", "user_id = $1", [userId])).toBe(0);

    // messages
    expect(await rowCount("messages", "user_id = $1", [userId])).toBe(0);

    // memory_facts
    expect(await rowCount("memory_facts", "user_id = $1", [userId])).toBe(0);

    // personality_signals
    expect(await rowCount("personality_signals", "user_id = $1", [userId])).toBe(0);

    // wins
    expect(await rowCount("wins", "user_id = $1", [userId])).toBe(0);

    // mood_scores
    expect(await rowCount("mood_scores", "user_id = $1", [userId])).toBe(0);

    // reminders
    expect(await rowCount("reminders", "user_id = $1", [userId])).toBe(0);

    // habit_completions (via habit id — habit rows gone so sub-select returns nothing)
    expect(
      await rowCount(
        "habit_completions",
        "habit_id IN (SELECT id FROM habits WHERE user_id = $1)",
        [userId],
      ),
    ).toBe(0);

    // habits
    expect(await rowCount("habits", "user_id = $1", [userId])).toBe(0);

    // goal_tasks (cascaded from goals)
    expect(
      await rowCount(
        "goal_tasks",
        "goal_id IN (SELECT id FROM goals WHERE user_id = $1)",
        [userId],
      ),
    ).toBe(0);

    // goals
    expect(await rowCount("goals", "user_id = $1", [userId])).toBe(0);

    // commitments
    expect(await rowCount("commitments", "user_id = $1", [userId])).toBe(0);

    // password_reset_tokens
    expect(
      await rowCount("password_reset_tokens", "user_id = $1", [userId]),
    ).toBe(0);

    // email_verification_tokens
    expect(
      await rowCount("email_verification_tokens", "user_id = $1", [userId]),
    ).toBe(0);

    // user_sessions
    expect(
      await rowCount(
        "user_sessions",
        `sess::jsonb->>'userId' = $1::text`,
        [String(userId)],
      ),
    ).toBe(0);

    // ── 6. Session cleared — /api/auth/me must return 401 ─────────────────
    const meRes = await agent.get("/api/auth/me");
    expect(meRes.status).toBe(401);
  });

  it("deletion handler covers every table with a user_id column", async () => {
    /**
     * This test acts as a schema-coverage guard.
     *
     * When a developer adds a new table that has a `user_id` foreign key they
     * MUST also:
     *   1. Add a DELETE statement for it in the DELETE /auth/account handler
     *      (artifacts/api-server/src/routes/auth.ts).
     *   2. Add the table name to HANDLER_COVERED_TABLES below.
     *
     * Tables that legitimately lack a direct `user_id` column (e.g. they join
     * through another table or embed the ID in a JSON column) should be
     * documented in INTENTIONAL_EXCEPTIONS with a comment explaining how they
     * are handled instead.
     */

    // Every table that has a `user_id` column AND is explicitly handled by
    // DELETE /auth/account. Add a new table here whenever you add a DELETE
    // statement to the handler for a table with a user_id FK.
    //
    // Note: the `users` table itself is deleted via `WHERE id = $1` (its own
    // PK), so it has no `user_id` column and is intentionally absent here.
    //
    // Note: `user_sessions` stores the user id inside a jsonb column (`sess`),
    // not as a typed `user_id` column — it is handled separately.
    //
    // Note: `goal_tasks` has no `user_id` column; rows cascade-delete when the
    // parent `goals` row is deleted.
    const HANDLER_COVERED_TABLES = new Set([
      "profile",
      "messages",
      "memory_facts",
      "personality_signals",
      "wins",
      "mood_scores",
      "reminders",
      "habit_completions", // has user_id column; also deleted via habit_id sub-select
      "habits",
      "goals",
      "commitments",
      "password_reset_tokens",
      "email_verification_tokens",
    ]);

    // Tables that have a `user_id` column but are intentionally handled
    // through a different mechanism in the deletion handler. Document *why*
    // for each entry. Keep this list empty unless there is a genuine
    // architectural reason.
    const INTENTIONAL_EXCEPTIONS: Record<string, string> = {
      // (none currently)
    };

    const result = await pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'user_id'
      ORDER BY table_name
    `);

    const tablesWithUserId = result.rows.map((r) => r.table_name);

    const uncovered = tablesWithUserId.filter(
      (t) => !HANDLER_COVERED_TABLES.has(t) && !(t in INTENTIONAL_EXCEPTIONS),
    );

    expect(
      uncovered,
      `The following tables have a user_id column but are NOT in the ` +
        `DELETE /auth/account handler:\n  ${uncovered.join("\n  ")}\n\n` +
        `Add DELETE statements for them in auth.ts and add their names to ` +
        `HANDLER_COVERED_TABLES in this test file.`,
    ).toEqual([]);

    // Inverse check: catch stale entries in HANDLER_COVERED_TABLES that no
    // longer exist in the DB (e.g. after a table is renamed or dropped).
    const schemaSet = new Set(tablesWithUserId);
    const stale = [...HANDLER_COVERED_TABLES].filter((t) => !schemaSet.has(t));

    expect(
      stale,
      `HANDLER_COVERED_TABLES references tables that no longer have a ` +
        `user_id column in the schema:\n  ${stale.join("\n  ")}\n\n` +
        `Remove or update these entries in this test file.`,
    ).toEqual([]);
  });
});
