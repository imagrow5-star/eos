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
    DELETE FROM crisis_events     WHERE user_id = ${uid};
    DELETE FROM messages          WHERE user_id = ${uid};
    DELETE FROM memory_facts      WHERE user_id = ${uid};
    DELETE FROM memory_feelings   WHERE user_id = ${uid};
    DELETE FROM personality_signals WHERE user_id = ${uid};
    DELETE FROM wins              WHERE user_id = ${uid};
    DELETE FROM mood_scores       WHERE user_id = ${uid};
    DELETE FROM reminders         WHERE user_id = ${uid};
    DELETE FROM habit_completions WHERE habit_id IN (SELECT id FROM habits WHERE user_id = ${uid});
    DELETE FROM habits            WHERE user_id = ${uid};
    DELETE FROM goals             WHERE user_id = ${uid};
    DELETE FROM commitments       WHERE user_id = ${uid};
    DELETE FROM voice_usage       WHERE user_id = ${uid};
    DELETE FROM subscriptions     WHERE user_id = ${uid};
    DELETE FROM profile           WHERE user_id = ${uid};
    DELETE FROM users             WHERE id = ${uid};
    COMMIT;
  `);
}

// ─── Test ────────────────────────────────────────────────────────────────────

const TEST_EMAIL = `deletion-test-${Date.now()}@example.invalid`;
const TEST_EMAIL_B = `deletion-test-b-${Date.now()}@example.invalid`;
const TEST_PASSWORD = "Test1234!";

describe("DELETE /api/auth/account", () => {
  afterEach(async () => {
    // Safety net: remove test users even if the deletion endpoint failed
    await Promise.all([cleanupUser(TEST_EMAIL), cleanupUser(TEST_EMAIL_B)]);
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
    const msgRes = await pool.query<{ id: number }>(
      `INSERT INTO messages (user_id, role, content) VALUES ($1, 'user', 'hello') RETURNING id`,
      [userId],
    );

    // crisis_events (crisis floor log — FK to users and messages)
    await pool.query(
      `INSERT INTO crisis_events (user_id, message_id, pattern_matched, country_served)
       VALUES ($1, $2, 'explicit_suicidal_ideation', 'US')`,
      [userId, msgRes.rows[0]!.id],
    );

    // memory_facts
    await pool.query(
      `INSERT INTO memory_facts (user_id, fact, category) VALUES ($1, 'test fact', 'life')`,
      [userId],
    );

    // memory_feelings (Sprint 2C)
    await pool.query(
      `INSERT INTO memory_feelings (user_id, feeling, category) VALUES ($1, 'the dinner made them feel small', 'shame')`,
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

    // billing foundation: subscriptions + voice_usage (phase 1 tables)
    await pool.query(
      `INSERT INTO subscriptions (user_id, tier, status) VALUES ($1, 'companion', 'active')`,
      [userId],
    );
    await pool.query(
      `INSERT INTO voice_usage (user_id, call_started_at, call_ended_at, duration_seconds)
       VALUES ($1, NOW() - INTERVAL '10 minutes', NOW(), 600)`,
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

    // billing foundation tables
    expect(await rowCount("subscriptions", "user_id = $1", [userId])).toBe(0);
    expect(await rowCount("voice_usage", "user_id = $1", [userId])).toBe(0);

    // profile
    expect(await rowCount("profile", "user_id = $1", [userId])).toBe(0);

    // messages
    expect(await rowCount("messages", "user_id = $1", [userId])).toBe(0);

    // crisis_events
    expect(await rowCount("crisis_events", "user_id = $1", [userId])).toBe(0);

    // memory_facts
    expect(await rowCount("memory_facts", "user_id = $1", [userId])).toBe(0);

    // memory_feelings (Sprint 2C)
    expect(await rowCount("memory_feelings", "user_id = $1", [userId])).toBe(0);

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

    // goal_tasks (cascaded from goals). Assert directly against the captured
    // goalId — NOT via a sub-select through `goals`. Once the goals row is
    // deleted, `goal_id IN (SELECT id FROM goals WHERE user_id = $1)` returns
    // nothing and would pass even if the goal_tasks rows were orphaned. Using
    // the literal goalId means this fails if ON DELETE CASCADE is ever removed.
    expect(
      await rowCount("goal_tasks", "goal_id = $1", [goalId]),
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

  it("deleting user A leaves user B's data completely untouched", async () => {
    // ── 1. Sign up user A ─────────────────────────────────────────────────
    const agentA = request.agent(app);

    const signupA = await agentA
      .post("/api/auth/signup")
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    expect(signupA.status).toBe(201);
    const userAId: number = signupA.body.user.id;
    expect(userAId).toBeTypeOf("number");

    // ── 2. Sign up user B ─────────────────────────────────────────────────
    const agentB = request.agent(app);

    const signupB = await agentB
      .post("/api/auth/signup")
      .send({ email: TEST_EMAIL_B, password: TEST_PASSWORD });

    expect(signupB.status).toBe(201);
    const userBId: number = signupB.body.user.id;
    expect(userBId).toBeTypeOf("number");

    // ── 3. Populate every user-owned table for BOTH users ─────────────────

    async function populateUser(uid: number, tag: string): Promise<{ habitId: number; goalId: number }> {
      // profile
      const profileExists = await pool.query(
        "SELECT id FROM profile WHERE user_id = $1 LIMIT 1",
        [uid],
      );
      if (profileExists.rowCount === 0) {
        await pool.query(
          `INSERT INTO profile (user_id, user_name, companion_name) VALUES ($1, $2, 'Asha')`,
          [uid, `User ${tag}`],
        );
      }

      const msgRow = await pool.query<{ id: number }>(
        `INSERT INTO messages (user_id, role, content) VALUES ($1, 'user', $2) RETURNING id`,
        [uid, `hello from ${tag}`],
      );

      await pool.query(
        `INSERT INTO crisis_events (user_id, message_id, pattern_matched, country_served)
         VALUES ($1, $2, 'explicit_suicidal_ideation', 'US')`,
        [uid, msgRow.rows[0]!.id],
      );

      await pool.query(
        `INSERT INTO memory_facts (user_id, fact, category) VALUES ($1, $2, 'life')`,
        [uid, `fact from ${tag}`],
      );

      await pool.query(
        `INSERT INTO personality_signals (user_id, signal) VALUES ($1, $2)`,
        [uid, `signal-${tag}`],
      );

      await pool.query(
        `INSERT INTO wins (user_id, content) VALUES ($1, $2)`,
        [uid, `win from ${tag}`],
      );

      await pool.query(
        `INSERT INTO mood_scores (user_id, score, date) VALUES ($1, 8, '2026-07-14')`,
        [uid],
      );

      await pool.query(
        `INSERT INTO reminders (user_id, content) VALUES ($1, $2)`,
        [uid, `reminder from ${tag}`],
      );

      const habitRow = await pool.query<{ id: number }>(
        `INSERT INTO habits (user_id, name, when_then, reason) VALUES ($1, $2, 'Every morning', 'Health') RETURNING id`,
        [uid, `Habit-${tag}`],
      );
      const habitId = habitRow.rows[0]!.id;

      await pool.query(
        `INSERT INTO habit_completions (user_id, habit_id, completed_date) VALUES ($1, $2, '2026-07-14')`,
        [uid, habitId],
      );

      const goalRow = await pool.query<{ id: number }>(
        `INSERT INTO goals (user_id, title, description) VALUES ($1, $2, '') RETURNING id`,
        [uid, `Goal-${tag}`],
      );
      const goalId = goalRow.rows[0]!.id;

      await pool.query(
        `INSERT INTO goal_tasks (goal_id, content) VALUES ($1, $2)`,
        [goalId, `task from ${tag}`],
      );

      await pool.query(
        `INSERT INTO commitments (user_id, content, cue) VALUES ($1, $2, 'morning')`,
        [uid, `commitment from ${tag}`],
      );

      await pool.query(
        `INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
        [`testtoken-${tag}-${uid}`, uid],
      );

      return { habitId, goalId };
    }

    const [, { habitId: bHabitId, goalId: bGoalId }] = await Promise.all([
      populateUser(userAId, "A"),
      populateUser(userBId, "B"),
    ]);

    // ── 4. Delete user A's account ────────────────────────────────────────
    const deleteRes = await agentA.delete("/api/auth/account");
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.ok).toBe(true);

    // ── 5. Assert user B's data is completely intact ───────────────────────

    expect(await rowCount("users", "id = $1", [userBId])).toBe(1);
    expect(await rowCount("profile", "user_id = $1", [userBId])).toBeGreaterThan(0);
    expect(await rowCount("messages", "user_id = $1", [userBId])).toBeGreaterThan(0);
    expect(await rowCount("memory_facts", "user_id = $1", [userBId])).toBeGreaterThan(0);
    expect(await rowCount("personality_signals", "user_id = $1", [userBId])).toBeGreaterThan(0);
    expect(await rowCount("wins", "user_id = $1", [userBId])).toBeGreaterThan(0);
    expect(await rowCount("mood_scores", "user_id = $1", [userBId])).toBeGreaterThan(0);
    expect(await rowCount("reminders", "user_id = $1", [userBId])).toBeGreaterThan(0);

    expect(await rowCount("habits", "user_id = $1", [userBId])).toBeGreaterThan(0);
    expect(
      await rowCount("habit_completions", "habit_id = $1", [bHabitId]),
    ).toBeGreaterThan(0);

    expect(await rowCount("goals", "user_id = $1", [userBId])).toBeGreaterThan(0);
    expect(
      await rowCount("goal_tasks", "goal_id = $1", [bGoalId]),
    ).toBeGreaterThan(0);

    expect(await rowCount("commitments", "user_id = $1", [userBId])).toBeGreaterThan(0);
    expect(
      await rowCount("password_reset_tokens", "user_id = $1", [userBId]),
    ).toBeGreaterThan(0);
    expect(
      await rowCount("email_verification_tokens", "user_id = $1", [userBId]),
    ).toBeGreaterThan(0);

    // ── 6. User B can still log in ────────────────────────────────────────
    const meResB = await agentB.get("/api/auth/me");
    expect(meResB.status).toBe(200);
    expect(meResB.body.user.id).toBe(userBId);
  });

  it("deletion handler covers every table that links to a user — directly or indirectly", async () => {
    /**
     * Schema-coverage guard.
     *
     * A user's data can be attached to the `users` row in three ways, and this
     * test enforces ALL THREE so a newly added table cannot silently escape
     * DELETE /auth/account:
     *
     *   1. DIRECT   — the table has its own `user_id` column. Must be listed in
     *                 HANDLER_COVERED_TABLES.
     *   2. FK-CHAIN — no `user_id` column, but a foreign key that transitively
     *                 references `users` (e.g. goal_tasks → goals → users).
     *                 Discovered automatically by walking the FK graph below;
     *                 must be listed in the INDIRECT_TABLES registry.
     *   3. JSONB    — the id is embedded in a json/jsonb column, invisible to
     *                 both checks above (e.g. user_sessions.sess->>'userId').
     *                 Can't be auto-discovered, so it is registered by hand in
     *                 INDIRECT_TABLES and asserted to be wiped by the handler.
     *
     * When you add a table, update the matching list AND the handler in
     * artifacts/api-server/src/routes/auth.ts (see its "INDIRECT tables"
     * comment). The two current indirect cases are goal_tasks (FK-CHAIN,
     * cascade) and user_sessions (JSONB).
     */

    // ── (1) DIRECT tables: have a `user_id` column and get an explicit DELETE.
    // Add a new table here whenever you add a DELETE statement to the handler
    // for a table with a user_id column.
    //
    // Note: the `users` table itself is deleted via `WHERE id = $1` (its own
    // PK), so it has no `user_id` column and is intentionally absent here.
    const HANDLER_COVERED_TABLES = new Set([
      "profile",
      "messages",
      "memory_facts",
      "memory_feelings",
      "reflection_reports",
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
      "personalization_state",
      "weekly_chapters",
      "chapter_quote_dismissals",
      "chapter_offer_events",
      "sealed_notes",
      "story_threads",
      "push_subscriptions",
      "push_events",
      "subscriptions", // billing foundation (phase 1) — Paddle cancel API call TODO lives in the handler
      "voice_usage",   // billing foundation (phase 1) — per-call voice metering records
      "crisis_events", // crisis floor — detection log (pattern names + country, never content)
    ]);

    // ── INDIRECT tables: store the user's id WITHOUT a `user_id` column, so the
    // DIRECT guard can't see them. Each entry documents HOW the handler removes
    // the rows and is verified against the live schema below:
    //   "cascade" — rows ON DELETE CASCADE from `via` (which the handler deletes
    //               explicitly); the handler issues no DELETE for this table.
    //               The FK edge's delete_rule is asserted to be CASCADE.
    //   "jsonb"   — the user id lives in a jsonb column; the handler deletes via
    //               a jsonb query. Not FK-discoverable, so listed by hand.
    const INDIRECT_TABLES: Record<
      string,
      { strategy: "cascade" | "jsonb"; via: string; note: string }
    > = {
      goal_tasks: {
        strategy: "cascade",
        via: "goals",
        note: "goal_tasks.goal_id → goals; ON DELETE CASCADE when the parent goals row is deleted",
      },
      user_sessions: {
        strategy: "jsonb",
        via: "users",
        note: "user id embedded in sess->>'userId'; deleted by a jsonb query in the handler",
      },
    };

    // ── Load the schema: user_id columns, all tables, and FK edges. ──────────
    const userIdResult = await pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'user_id'
      ORDER BY table_name
    `);
    const tablesWithUserId = userIdResult.rows.map((r) => r.table_name);
    const userIdSet = new Set(tablesWithUserId);

    const allTablesResult = await pool.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `);
    const allTables = new Set(allTablesResult.rows.map((r) => r.table_name));

    // child references parent; delete_rule is CASCADE / NO ACTION / etc.
    const fkResult = await pool.query<{
      child: string;
      parent: string;
      delete_rule: string;
    }>(`
      SELECT tc.table_name       AS child,
             ccu.table_name      AS parent,
             rc.delete_rule      AS delete_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
       AND rc.constraint_schema = tc.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
    `);
    const edges = fkResult.rows;

    // A table is "user-linked" if it can reach `users` by following FK edges.
    const reachesUsers = (table: string, seen = new Set<string>()): boolean => {
      if (table === "users") return true;
      if (seen.has(table)) return false;
      seen.add(table);
      return edges.some(
        (e) => e.child === table && e.parent !== table && reachesUsers(e.parent, seen),
      );
    };

    // ── (1) DIRECT coverage: every table with a user_id column is handled. ───
    const uncoveredDirect = tablesWithUserId.filter(
      (t) => !HANDLER_COVERED_TABLES.has(t) && !(t in INDIRECT_TABLES),
    );
    expect(
      uncoveredDirect,
      `The following tables have a user_id column but are NOT in the ` +
        `DELETE /auth/account handler:\n  ${uncoveredDirect.join("\n  ")}\n\n` +
        `Add DELETE statements for them in auth.ts and add their names to ` +
        `HANDLER_COVERED_TABLES in this test file.`,
    ).toEqual([]);

    // Stale check: HANDLER_COVERED_TABLES entries must still have a user_id column.
    const staleDirect = [...HANDLER_COVERED_TABLES].filter((t) => !userIdSet.has(t));
    expect(
      staleDirect,
      `HANDLER_COVERED_TABLES references tables that no longer have a ` +
        `user_id column in the schema:\n  ${staleDirect.join("\n  ")}\n\n` +
        `Remove or update these entries in this test file.`,
    ).toEqual([]);

    // ── (2) FK-CHAIN coverage: every table that reaches `users` through a FK
    // but has NO user_id column must be registered in INDIRECT_TABLES. This is
    // the mechanism that catches an indirectly-linked table added in the future
    // (e.g. a child of `goals` or `habits`) before it can escape deletion.
    const fkChildTables = [...new Set(edges.map((e) => e.child))];
    const fkChainTables = fkChildTables.filter(
      (t) => t !== "users" && !userIdSet.has(t) && reachesUsers(t),
    );
    const missingIndirect = fkChainTables.filter((t) => !(t in INDIRECT_TABLES));
    expect(
      missingIndirect,
      `The following tables reference a user INDIRECTLY through a foreign-key ` +
        `chain but are NOT covered:\n  ${missingIndirect.join("\n  ")}\n\n` +
        `Their rows can silently survive account deletion. Either ensure they ` +
        `ON DELETE CASCADE from a covered parent (and add them to ` +
        `INDIRECT_TABLES with strategy "cascade"), or delete them explicitly ` +
        `in the DELETE /auth/account handler.`,
    ).toEqual([]);

    // ── (3) Verify each INDIRECT_TABLES entry actually holds up. ─────────────
    for (const [table, meta] of Object.entries(INDIRECT_TABLES)) {
      // The registered table must still exist.
      expect(
        allTables.has(table),
        `INDIRECT_TABLES lists "${table}" but no such table exists — remove it.`,
      ).toBe(true);

      if (meta.strategy === "cascade") {
        // There must be a real FK from this table to its declared `via` parent,
        // and it must be ON DELETE CASCADE — otherwise the "we don't delete it
        // explicitly" assumption is false and rows would be orphaned.
        const edge = edges.find((e) => e.child === table && e.parent === meta.via);
        expect(
          edge,
          `INDIRECT_TABLES["${table}"] claims cascade from "${meta.via}" but no ` +
            `such foreign key exists.`,
        ).toBeDefined();
        expect(
          edge?.delete_rule,
          `${table} → ${meta.via} must be ON DELETE CASCADE for the cascade ` +
            `strategy to hold, but it is "${edge?.delete_rule}". Either restore ` +
            `the cascade or delete ${table} explicitly in the handler.`,
        ).toBe("CASCADE");
      }
    }
  });
});
